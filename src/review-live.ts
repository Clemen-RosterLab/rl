import path from "node:path";
import readline from "node:readline";
import { Worker } from "node:worker_threads";
import { execute, message } from "./common.js";
import { visible } from "./review-terminal.js";
import {
  checkpointKey,
  loadCheckpoint,
  type LiveState,
  type Mode,
  type Comparison,
  type ReviewFile,
  type Checkpoint,
  type Commit,
} from "./review-live-engine.js";
import { ReviewWatcher } from "./review-live-watch.js";
import { GhReviewService, type PullRequest } from "./review-github.js";

class GitWorker {
  private worker: Worker;
  private serial = 0;
  private failure?: Error;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(root: string, repository?: string) {
    this.worker = new Worker(
      new URL("./review-live-worker.js", import.meta.url),
      { workerData: { root, repository } },
    );
    this.worker.on("message", ({ id, result, error }) => {
      const task = this.pending.get(id);
      this.pending.delete(id);
      if (error) task?.reject(new Error(error));
      else task?.resolve(result);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) =>
      fail(new Error(`Review worker stopped (${code})`)),
    );
  }
  request<T>(op: string, data: Record<string, unknown> = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, ...data });
    });
  }
  async close(): Promise<void> {
    try {
      await this.request("release");
    } catch {
      /* A deleted worktree cannot release its temporary ref. */
    }
    await this.worker.terminate();
  }
}
export interface LiveOptions {
  root: string;
  repository?: string;
  directory: string;
  defaultBase: string;
  since?: string;
  pr?: number;
  remoteInterval?: number;
}
const esc = "\x1b[";
const color = {
  normal: "\x1b[38;5;252m",
  dim: "\x1b[38;5;244m",
  cyan: "\x1b[38;5;81m",
  green: "\x1b[38;5;114m",
  red: "\x1b[38;5;210m",
  yellow: "\x1b[38;5;221m",
  selected: "\x1b[48;5;238m\x1b[38;5;231m",
};
const reset = "\x1b[0m\x1b[48;5;234m";
function charWidth(c: string): number {
  const n = c.codePointAt(0)!;
  return /\p{Mark}/u.test(c)
    ? 0
    : n >= 0x1100 &&
        (n <= 0x115f ||
          (n >= 0x2e80 && n <= 0xa4cf) ||
          (n >= 0xac00 && n <= 0xd7a3) ||
          (n >= 0xf900 && n <= 0xfaff) ||
          (n >= 0xfe10 && n <= 0xfe6f) ||
          (n >= 0xff00 && n <= 0xff60) ||
          n >= 0x1f300)
      ? 2
      : 1;
}
export function terminalText(value: string, width: number, offset = 0): string {
  let text = "",
    used = 0,
    skipped = 0;
  for (const c of visible(value)) {
    const w = charWidth(c);
    if (skipped < offset) {
      skipped += w;
      continue;
    }
    if (used + w > width) break;
    text += c;
    used += w;
  }
  return text + " ".repeat(Math.max(0, width - used));
}
export function sourceLine(lines: string[], position: number): number {
  let line = 1;
  for (let i = 0; i <= Math.min(position, lines.length - 1); i++) {
    const text = lines[i];
    const h = /^@@ .*\+(\d+)/.exec(text);
    if (h) line = Number(h[1]);
    else if (
      i < position &&
      ((text.startsWith("+") && !text.startsWith("+++")) ||
        text.startsWith(" "))
    )
      line++;
  }
  return Math.max(1, line);
}
const help = [
  "KEYBOARD",
  "1 / 2 / 3    Focus commits / files / diff",
  "Tab / Shift-Tab    Cycle panels",
  "j k / Up Down    Move selection or scroll",
  "Left Right    Panel focus; in diff: horizontal scroll",
  "PgUp PgDn / Ctrl-u Ctrl-d    Page",
  "Enter    Files, then diff",
  "Esc    Back / close help or input",
  "w    Live working tree (staged + unstaged + untracked)",
  "p    Branch / PR merge-base comparison (committed)",
  "r    Enter FROM TO revision range",
  "s    Compare checkpoint to current source and index",
  "m    Mark exact inspected target reviewed",
  "f    Freeze / unfreeze snapshot",
  "/    Search file paths and selected diff",
  "n / N    Next / previous match",
  "o    Open selected file and line in VS Code",
  "Ctrl-r    Refresh local state and PR metadata",
  "?    Toggle help",
  "q / Ctrl-c    Quit",
  "",
  "Merges compare with their first parent. Initial commits use an empty tree.",
  "Live refresh preserves selection and scroll. Freeze retains immutable trees.",
  "Review is read-only; m writes only private checkpoint metadata and refs.",
];

export async function liveReview(options: LiveOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Live review requires a terminal; use --json for noninteractive output",
    );
  const git = new GitWorker(options.root, options.repository);
  const remoteAbort = new AbortController();
  let stopped = false,
    state: LiveState | undefined,
    latest: LiveState | undefined,
    frozen = false,
    newer = false,
    updates = 0;
  let mode: Mode = options.since
    ? { kind: "range", from: options.since, to: "HEAD" }
    : { kind: "working" };
  let comparison: Comparison | undefined,
    files: ReviewFile[] = [],
    fileIndex = 0,
    commitIndex = 0,
    focus = 0,
    scroll = 0,
    horizontal = 0,
    lines: string[] = [];
  let status = "Loading Git state…",
    helpOpen = false,
    prompt: "range" | "search" | undefined,
    input = "",
    search = "",
    pr: PullRequest | undefined,
    remoteCommits: Commit[] | undefined,
    latestRemoteCommits: Commit[] | undefined,
    remote = "Checking PR…";
  let refreshBusy = false,
    refreshAgain = false,
    compareBusy = false,
    compareAgain = false,
    compareVersion = 0,
    patchBusy = false,
    patchAgain = false,
    patchVersion = 0;
  let previousRows: string[] = [],
    previousWidth = 0,
    renderTimer: ReturnType<typeof setTimeout> | undefined;
  const patchCache = new Map<string, string[]>();
  const patchSizes = new Map<string, number>();
  let patchChars = 0;
  const height = () => Math.max(1, (process.stdout.rows || 24) - 7);
  const selected = () => files[fileIndex];
  const timeline = () => remoteCommits ?? state?.commits ?? [];
  const key = () =>
    checkpointKey(options.root, state!.snapshot.branch, options.pr);
  const setStatus = (text: string) => {
    status = text;
    render();
  };
  const watcher = new ReviewWatcher(() => void refresh());
  const error = (cause: unknown) => {
    if (!stopped) setStatus(message(cause));
  };
  function render(): void {
    if (stopped || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      draw();
    }, 16);
  }
  function draw(): void {
    const width = process.stdout.columns || 100,
      rows = process.stdout.rows || 24,
      body = height();
    const frame: string[] = [];
    const row = (text: string, tone = color.normal) =>
      tone + terminalText(text, width) + reset;
    const branch = state?.snapshot.branch ?? "…";
    frame.push(
      row(
        ` RL REVIEW  /  ${path.basename(options.root)} · ${branch}   ${frozen ? "❄ FROZEN" + (newer ? " · NEW CHANGES" : "") : "● LIVE"}   ${state?.snapshot.head.slice(0, 8) || "unborn"}`,
        color.cyan,
      ),
    );
    frame.push(
      row(` ${comparison?.label ?? "Loading comparison…"}`, color.dim),
    );
    frame.push(
      row(
        ` ${pr ? `PR #${pr.number} ${pr.title} · ${pr.headRefName} → ${pr.baseRefName} · ${pr.commits.length} commits / ${pr.files.length} files · ` : ""}Remote: ${remote}`,
        color.dim,
      ),
    );
    const narrow = width < 90;
    const a = narrow
        ? width
        : Math.max(22, Math.min(34, Math.floor(width * 0.24))),
      b = narrow ? 0 : Math.max(24, Math.min(40, Math.floor(width * 0.27))),
      c = narrow ? 0 : width - a - b - 2;
    const headings = ["1 COMMITS", "2 FILES", "3 DIFF"];
    if (narrow)
      frame.push(row(` ${headings[focus]}  ·  Tab cycles panels`, color.cyan));
    else
      frame.push(
        [a, b, c]
          .map(
            (w, i) =>
              (i === focus ? color.cyan : color.dim) +
              terminalText(` ${i === focus ? "▸ " : ""}${headings[i]}`, w) +
              reset,
          )
          .join(color.dim + "│" + reset),
      );
    const commitStart = Math.max(
      0,
      commitIndex - Math.max(0, Math.floor(body / 3) - 1),
    );
    const fileStart = Math.max(0, fileIndex - Math.floor(body / 4));
    const workingCount =
      state && mode.kind === "working" ? files.length : undefined;
    function panel(panel: number, i: number, w: number): string {
      let text = "",
        tone = color.normal,
        active = false;
      if (panel === 0) {
        const index = commitStart + Math.floor(i / 3),
          part = i % 3;
        const commit = index === 0 ? undefined : timeline()[index - 1];
        if (index === 0)
          text =
            part === 0
              ? "● WORKING TREE"
              : part === 1
                ? `${workingCount ?? "live"} changes · w`
                : "";
        else if (commit)
          text =
            part === 0
              ? `● ${commit.sha.slice(0, 8)}${commit.parents.length > 1 ? " merge" : ""}`
              : part === 1
                ? commit.subject
                : `${commit.files} files  +${commit.additions} -${commit.deletions}`;
        active =
          index === commitIndex &&
          !!state &&
          (index === 0
            ? mode.kind === "working"
            : mode.kind === "commit" && commit?.sha === mode.sha);
        if (part === 2) tone = color.dim;
      } else if (panel === 1) {
        const index = fileStart + Math.floor(i / 2),
          file = files[index];
        if (file) {
          text =
            i % 2 === 0
              ? `${file.status} ${file.oldPath ? path.basename(file.oldPath) + " → " : ""}${path.basename(file.path)}`
              : `${file.layer} ${file.binary ? "binary" : `+${file.additions} -${file.deletions}`} · ${path.dirname(file.path)}`;
          active = index === fileIndex;
          if (i % 2 === 1) tone = color.dim;
        } else if (i === 0) text = "No changed files";
      } else {
        const list = helpOpen ? help : lines,
          line = list[scroll + i] ?? "";
        text = line;
        if (line.startsWith("+")) tone = color.green;
        else if (line.startsWith("-")) tone = color.red;
        else if (line.startsWith("@@")) tone = color.cyan;
        else if (line.startsWith("diff ") || line.startsWith("index "))
          tone = color.dim;
        if (search && line.toLowerCase().includes(search.toLowerCase()))
          tone = color.yellow;
        text = terminalText(text, w - 2, horizontal);
      }
      return (
        (active ? (focus === panel ? color.selected : color.cyan) : tone) +
        terminalText(" " + text, w) +
        reset
      );
    }
    for (let i = 0; i < body; i++)
      frame.push(
        narrow
          ? panel(focus, i, width)
          : panel(0, i, a) +
              color.dim +
              "│" +
              reset +
              panel(1, i, b) +
              color.dim +
              "│" +
              reset +
              panel(2, i, c),
      );
    frame.push(
      row(
        ` ${prompt ? `${prompt === "range" ? "Range FROM TO" : "Search files / diff"}: ${input}▏` : status}`,
        color.yellow,
      ),
    );
    frame.push(
      row(
        ` 1 Commits  2 Files  3 Diff  Tab Switch  w Working  p Branch  r Range  s Since  m Mark  f Freeze  / Search  ? Help  q Quit`,
        color.dim,
      ),
    );
    frame.push(
      row(
        ` ${selected()?.path ?? ""}  ${lines.length ? `· diff ${Math.min(scroll + 1, lines.length)}/${lines.length}` : ""}  · local updates ${updates}${state && (!state.snapshot.complete || !state.snapshot.stable || state.snapshot.conflicts.length) ? ` · ${state.snapshot.excluded.length} omitted, ${state.snapshot.conflicts.length} conflicts${!state.snapshot.stable ? ", source moving" : ""}` : ""}`,
        color.dim,
      ),
    );
    if (previousWidth !== width || previousRows.length !== rows) {
      process.stdout.write(esc + "2J");
      previousRows = [];
      previousWidth = width;
    }
    let output = "";
    for (let i = 0; i < Math.min(rows, frame.length); i++)
      if (frame[i] !== previousRows[i])
        output += `${esc}${i + 1};1H${frame[i]}`;
    process.stdout.write(output);
    previousRows = frame;
  }
  async function refresh(force = false): Promise<void> {
    if (stopped) return;
    if (refreshBusy) {
      refreshAgain = true;
      return;
    }
    refreshBusy = true;
    try {
      const result = await git.request<LiveState>("refresh", { force });
      if (stopped) return;
      if (latest?.signature !== result.signature || force)
        watcher.update(result);
      latest = result;
      if (state?.signature !== result.signature || force) {
        if (frozen) {
          newer = state?.signature !== result.signature;
          render();
        } else {
          const sha =
            commitIndex > 0 ? timeline()[commitIndex - 1]?.sha : undefined;
          const branchChanged =
            state && state.snapshot.branch !== result.snapshot.branch;
          state = result;
          updates++;
          if (branchChanged) {
            mode = { kind: "working" };
            commitIndex = 0;
            status =
              "Branch changed in this worktree; showing its working tree";
          } else if (sha)
            commitIndex = Math.max(
              0,
              timeline().findIndex((c) => c.sha === sha) + 1,
            );
          await compare();
        }
      }
    } catch (cause) {
      error(cause);
    } finally {
      refreshBusy = false;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh();
      }
    }
  }
  async function compare(): Promise<void> {
    compareVersion++;
    patchVersion++;
    if (compareBusy) {
      compareAgain = true;
      return;
    }
    if (!state || stopped) return;
    compareBusy = true;
    const version = compareVersion;
    try {
      const result = await git.request<{
        comparison: Comparison;
        files: ReviewFile[];
      }>("compare", { mode, state });
      if (stopped || version !== compareVersion) return;
      const old = selected(),
        oldKey = old?.key;
      comparison = result.comparison;
      files = result.files;
      if (frozen)
        void git
          .request("freeze", {
            state,
            target: comparison.target,
            revisions: comparison.scopes.flatMap((s) => [s.from, s.to]),
          })
          .catch(error);
      const index = files.findIndex((f) => f.key === oldKey);
      fileIndex =
        index < 0 ? Math.min(fileIndex, Math.max(0, files.length - 1)) : index;
      if (oldKey !== selected()?.key) {
        scroll = 0;
        horizontal = 0;
      }
      await patch();
      status = frozen
        ? "Frozen snapshot · background detection continues"
        : `Updated · ${files.length} file layers · f freezes the inspected snapshot`;
    } catch (cause) {
      if (version === compareVersion) {
        comparison = undefined;
        files = [];
        lines = [message(cause)];
        error(cause);
      }
    } finally {
      compareBusy = false;
      render();
      if (compareAgain) {
        compareAgain = false;
        void compare();
      }
    }
  }
  async function patch(): Promise<void> {
    patchVersion++;
    if (patchBusy) {
      patchAgain = true;
      return;
    }
    const file = selected();
    if (!file) {
      lines = ["No changes in this comparison."];
      render();
      return;
    }
    const version = patchVersion,
      cacheKey = `${file.from}:${file.to}:${file.key}`;
    if (patchCache.has(cacheKey)) {
      lines = patchCache.get(cacheKey)!;
      render();
      return;
    }
    patchBusy = true;
    // Never leave another file's patch underneath a new selection.
    lines = [`Loading ${file.path}…`];
    render();
    try {
      const result = await git.request<string>("patch", { file });
      if (stopped || version !== patchVersion) return;
      lines = result.split("\n");
      patchCache.set(cacheKey, lines);
      patchSizes.set(cacheKey, result.length);
      patchChars += result.length;
      while (patchCache.size > 20 || patchChars > 16 * 1024 * 1024) {
        const oldest = patchCache.keys().next().value!;
        patchChars -= patchSizes.get(oldest) ?? 0;
        patchSizes.delete(oldest);
        patchCache.delete(oldest);
      }
      scroll = Math.min(scroll, Math.max(0, lines.length - 1));
    } catch (cause) {
      if (version === patchVersion) {
        lines = [message(cause)];
        error(cause);
      }
    } finally {
      patchBusy = false;
      render();
      if (patchAgain) {
        patchAgain = false;
        void patch();
      }
    }
  }
  let remoteBusy = false;
  async function discover(): Promise<void> {
    if (remoteBusy || stopped) return;
    remoteBusy = true;
    try {
      await git.request("identity");
      const github = new GhReviewService();
      const result = await github.discover(
        options.root,
        options.pr,
        remoteAbort.signal,
      );
      if (options.pr) {
        remote = `PR #${result.number} · resolving revision objects…`;
        render();
        await github.ensureObjects(options.root, result, remoteAbort.signal);
      }
      if (stopped) return;
      const changed =
        pr?.headRefOid !== result.headRefOid ||
        pr?.baseRefOid !== result.baseRefOid;
      const followBranch = !pr || mode.kind === "branch";
      const selectedSha =
        commitIndex > 0 ? timeline()[commitIndex - 1]?.sha : undefined;
      pr = result;
      if (options.pr && changed)
        latestRemoteCommits = await git.request<Commit[]>("history", {
          head: pr.headRefOid,
          base: pr.baseRefOid,
        });
      remote = `#${pr.number} head ${pr.headRefOid.slice(0, 8)} (polled separately)`;
      if (options.pr && changed && !frozen) {
        remoteCommits = latestRemoteCommits;
        if (selectedSha)
          commitIndex = Math.max(
            0,
            timeline().findIndex((c) => c.sha === selectedSha) + 1,
          );
        if (followBranch) {
          mode = { kind: "branch", base: pr.baseRefOid, head: pr.headRefOid };
          void compare();
        }
      } else if (changed && frozen) {
        remote += " · newer PR metadata";
        render();
      }
    } catch (cause) {
      if (!stopped) remote = message(cause);
    } finally {
      remoteBusy = false;
      render();
    }
  }
  function nextMatch(direction = 1): void {
    if (!search) return;
    if (focus === 1) {
      for (let n = 1; n <= files.length; n++) {
        const i = (fileIndex + direction * n + files.length) % files.length;
        if (files[i].path.toLowerCase().includes(search.toLowerCase())) {
          fileIndex = i;
          scroll = 0;
          void patch();
          break;
        }
      }
    } else {
      for (let n = 1; n <= lines.length; n++) {
        const i = (scroll + direction * n + lines.length) % lines.length;
        if (lines[i].toLowerCase().includes(search.toLowerCase())) {
          scroll = i;
          break;
        }
      }
    }
    render();
  }
  async function mark(): Promise<void> {
    if (!state || !comparison || compareBusy || compareAgain)
      throw new Error(
        "Wait for the comparison to finish before marking reviewed",
      );
    if (!state.snapshot.stable)
      throw new Error(
        "Source moved during capture; refresh before marking reviewed",
      );
    if (
      (mode.kind === "working" || mode.kind === "since") &&
      (!state.snapshot.complete || state.snapshot.conflicts.length)
    )
      throw new Error(
        "Snapshot is incomplete or conflicted; inspect omitted paths before marking reviewed",
      );
    const point: Checkpoint = {
      branch: state.snapshot.branch,
      head:
        mode.kind === "working" || mode.kind === "since"
          ? state.snapshot.head
          : comparison.target,
      tree: comparison.target,
      index:
        mode.kind === "working" || mode.kind === "since"
          ? state.snapshot.indexTree
          : comparison.target,
      label: comparison.target.slice(0, 8),
    };
    const capturedKey = key();
    await git.request("mark", {
      directory: options.directory,
      key: capturedKey,
      point,
    });
    setStatus(
      `Marked inspected snapshot ${point.label} reviewed · s compares later changes`,
    );
  }
  function onKey(text: string, keypress: readline.Key): void {
    if (stopped) return;
    const name = keypress.name;
    if (keypress.ctrl && name === "c") {
      finish();
      return;
    }
    if (prompt) {
      if (name === "escape") {
        prompt = undefined;
        input = "";
        render();
        return;
      }
      if (name === "return") {
        const value = input;
        const kind = prompt;
        prompt = undefined;
        input = "";
        if (kind === "range") {
          const refs = value.trim().split(/\s+/);
          if (refs.length !== 2)
            setStatus(
              "Enter exactly two revisions: FROM TO (e.g. HEAD~3 HEAD)",
            );
          else {
            mode = { kind: "range", from: refs[0], to: refs[1] };
            scroll = 0;
            void compare();
          }
        } else {
          search = value;
          nextMatch();
        }
      } else if (name === "backspace")
        input = Array.from(input).slice(0, -1).join("");
      else if (text && !keypress.ctrl && !keypress.meta) input += visible(text);
      render();
      return;
    }
    if (text === "q") {
      finish();
      return;
    }
    if (name === "escape") {
      if (helpOpen) {
        helpOpen = false;
        scroll = 0;
      } else if (search) {
        search = "";
      } else focus = Math.max(0, focus - 1);
      render();
      return;
    }
    if (text === "?") {
      helpOpen = !helpOpen;
      focus = 2;
      scroll = 0;
      render();
      return;
    }
    if (text === "/") {
      prompt = "search";
      input = search;
      render();
      return;
    }
    if (text === "r" && !keypress.ctrl) {
      prompt = "range";
      input = "";
      render();
      return;
    }
    if (text === "f") {
      if (!state || !comparison) return;
      if (compareBusy || patchBusy) {
        setStatus(
          "Wait for the displayed comparison to finish loading, then freeze",
        );
        return;
      }
      frozen = !frozen;
      if (frozen && comparison)
        void git
          .request("freeze", {
            state,
            target: comparison.target,
            revisions: comparison.scopes.flatMap((s) => [s.from, s.to]),
          })
          .catch(error);
      else if (!frozen) void git.request("release").catch(error);
      if (!frozen && latest) {
        state = latest;
        remoteCommits = latestRemoteCommits;
        newer = false;
        if (mode.kind === "branch" && options.pr && pr)
          mode = { kind: "branch", base: pr.baseRefOid, head: pr.headRefOid };
        void compare();
      }
      setStatus(
        frozen
          ? "Frozen immutable source/index trees · changes continue to be detected"
          : "Live updates resumed",
      );
      return;
    }
    if (text === "w") {
      mode = { kind: "working" };
      commitIndex = 0;
      scroll = 0;
      void compare();
      return;
    }
    if (text === "p") {
      mode = {
        kind: "branch",
        base: pr?.baseRefOid ?? options.defaultBase,
        ...(options.pr && pr ? { head: pr.headRefOid } : {}),
      };
      scroll = 0;
      void compare();
      return;
    }
    if (text === "s") {
      try {
        if (state) {
          mode = {
            kind: "since",
            checkpoint: loadCheckpoint(options.directory, key()),
          };
          scroll = 0;
          void compare();
        }
      } catch (cause) {
        error(cause);
      }
      return;
    }
    if (text === "m") {
      void mark().catch(error);
      return;
    }
    if (text === "o") {
      const file = selected();
      if (file)
        void execute(
          [
            "code",
            "--goto",
            `${path.join(options.root, file.path)}:${sourceLine(lines, scroll)}`,
          ],
          options.root,
          { timeoutMs: 10000 },
        )
          .then((result) => {
            if (result.code) throw new Error(result.stderr || "VS Code failed");
            setStatus(`Opened ${file.path}`);
          })
          .catch(error);
      return;
    }
    if (keypress.ctrl && name === "r") {
      void refresh(true);
      void discover();
      return;
    }
    if (["1", "2", "3"].includes(text)) {
      focus = Number(text) - 1;
      render();
      return;
    }
    if (name === "tab") {
      focus = (focus + (keypress.shift ? 2 : 1)) % 3;
      render();
      return;
    }
    if (text === "n" || text === "N") {
      nextMatch(text === "N" ? -1 : 1);
      return;
    }
    if (name === "return") {
      focus = Math.min(2, focus + 1);
      render();
      return;
    }
    if (name === "left" || name === "right") {
      if (focus === 2)
        horizontal = Math.max(0, horizontal + (name === "left" ? -8 : 8));
      else focus = Math.max(0, Math.min(2, focus + (name === "left" ? -1 : 1)));
      render();
      return;
    }
    const direction =
      name === "down" ||
      text === "j" ||
      name === "pagedown" ||
      (keypress.ctrl && name === "d")
        ? 1
        : name === "up" ||
            text === "k" ||
            name === "pageup" ||
            (keypress.ctrl && name === "u")
          ? -1
          : 0;
    const amount =
      name?.startsWith("page") || keypress.ctrl ? Math.max(1, height() - 2) : 1;
    if (direction) {
      if (focus === 0 && state) {
        commitIndex = Math.max(
          0,
          Math.min(timeline().length, commitIndex + direction * amount),
        );
        mode = commitIndex
          ? { kind: "commit", sha: timeline()[commitIndex - 1].sha }
          : { kind: "working" };
        scroll = 0;
        void compare();
      } else if (focus === 1) {
        const previous = fileIndex;
        fileIndex = Math.max(
          0,
          Math.min(files.length - 1, fileIndex + direction * amount),
        );
        if (previous !== fileIndex) {
          scroll = 0;
          horizontal = 0;
          void patch();
        }
      } else
        scroll = Math.max(
          0,
          Math.min(
            Math.max(0, (helpOpen ? help : lines).length - 1),
            scroll + direction * amount,
          ),
        );
      render();
    }
  }
  let resolveExit: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const wasRaw = process.stdin.isRaw;
  const resize = () => {
    previousRows = [];
    render();
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    remoteAbort.abort();
    resolveExit();
  };
  const terminate = () => finish();
  const remoteTimer = setInterval(
    () => void discover(),
    options.remoteInterval ?? 60000,
  );
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(esc + "?1049h" + esc + "?25l" + reset + esc + "2J");
    process.stdin.on("keypress", onKey);
    process.stdout.on("resize", resize);
    process.on("SIGINT", terminate);
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", terminate);
    render();
    void refresh();
    void discover();
    await done;
  } finally {
    stopped = true;
    remoteAbort.abort();
    clearTimeout(renderTimer);
    clearInterval(remoteTimer);
    watcher.close();
    process.stdin.off("keypress", onKey);
    process.stdout.off("resize", resize);
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", terminate);
    process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
    process.stdout.write("\x1b[0m" + esc + "?25h" + esc + "?1049l");
    await git.close();
  }
}
