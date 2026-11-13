import path from "node:path";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { execute, message } from "./common.js";
import { visible } from "./review-terminal.js";
import {
  ReviewInput,
  drainReviewInput,
  reviewTerminalSettings,
  ReviewWheel,
  type ReviewMouse,
} from "./review-live-input.js";
import {
  reviewFrame,
  reviewLayout,
  reviewReset,
  reviewScrollbar,
  reviewSelectedText,
  reviewTextColumn,
  scrollLimit,
  type ReviewFrame,
  type ReviewTextSelection,
  type ReviewTextPoint,
  type ReviewMenu,
  reviewLineNumbers,
} from "./review-live-view.js";
export { terminalText } from "./review-live-view.js";
import {
  checkpointKey,
  type LiveState,
  type Mode,
  type Comparison,
  type ReviewFile,
  type Checkpoint,
  type Commit,
} from "./review-live-engine.js";
import { ReviewWatcher } from "./review-live-watch.js";
import {
  visibleReviewFiles,
  defaultReviewFilters,
  loadReviewFilters,
  saveReviewFilters,
  reviewFilterCategories,
  type ReviewFileFilters,
  loadReviewSettings,
  saveReviewSettings,
  advancedReviewFilters,
  type ReviewSettings,
} from "./review-live-files.js";
import { GhReviewService, type PullRequest } from "./review-github.js";
import {
  reviewFileFingerprint,
  isFileReviewed,
  type ReviewProgress,
} from "./review-progress.js";
import { sortReviewFiles, type ReviewRanks } from "./review-ranking.js";
import {
  rankWithReviewAgent,
  type ReviewRankEvidence,
} from "./review-rank-agent.js";
import type {
  ReviewSearchScope,
  ReviewSearchResult,
  ReviewSearchHit,
} from "./review-search.js";
import { installTerminalCrashGuard } from "./review/terminal-guard.js";

interface ActionMenu extends ReviewMenu {
  kind: "base" | "target" | "search" | "agent";
  values?: string[];
  base?: string;
  identities?: Record<string, string>;
  hits?: ReviewSearchHit[];
}

class GitWorker {
  private readonly worker: ChildProcess;
  private readonly exit: Promise<void>;
  private readonly temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "rl-review-live-"),
  );
  private readonly freezeId = randomUUID();
  private queue = Promise.resolve();
  private signalReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.signalReady = resolve;
  });
  private serial = 0;
  private failure?: Error;
  private closed = false;
  private frozenRefs = false;
  private active?: {
    id: number;
    op: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };

  constructor(root: string, repository = root) {
    // A separate process group lets Quit interrupt synchronous Git commands
    // and their descendants while leaving the terminal process running.
    this.worker = fork(
      new URL("./review-live-worker.js", import.meta.url),
      [root, repository, this.temporaryRoot, this.freezeId],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      },
    );
    this.worker.on(
      "message",
      ({
        id,
        result,
        error,
        ready,
      }: {
        id: number;
        result: unknown;
        error?: string;
        ready?: boolean;
      }) => {
        if (ready) {
          this.signalReady();
          return;
        }
        const task = this.active;
        if (task?.id !== id) return;
        this.active = undefined;
        if (error) task.reject(new Error(error));
        else {
          if (task.op === "release") this.frozenRefs = false;
          task.resolve(result);
        }
      },
    );
    const fail = (error: Error) => {
      this.failure = error;
      this.signalReady();
      this.active?.reject(error);
      this.active = undefined;
    };
    this.worker.on("error", fail);
    this.exit = new Promise((resolve) => {
      this.worker.once("close", (code, signal) => {
        fail(new Error(`Review worker stopped (${signal ?? code})`));
        resolve();
      });
    });
  }

  get pid(): number | undefined {
    return this.worker.pid;
  }

  request<T>(op: string, data: Record<string, unknown> = {}): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready;
      if (this.closed) throw new Error("Review closed");
      if (this.failure) throw this.failure;
      if (op === "freeze") this.frozenRefs = true;
      const id = ++this.serial;
      return new Promise<T>((resolve, reject) => {
        this.active = {
          id,
          op,
          resolve: (value) => resolve(value as T),
          reject,
        };
        this.worker.send({ id, op, ...data }, (error) => {
          if (error && this.active?.id === id) {
            this.active = undefined;
            reject(error);
          }
        });
      });
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async close(gitDir?: string): Promise<void> {
    this.closed = true;
    // Finish a quick save here; a slow save retains its isolated worker and
    // completes atomically after disconnect without owning terminal input.
    if (
      this.active &&
      ["mark", "viewed", "review-file"].includes(this.active.op)
    ) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        this.queue.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 350);
        }),
      ]);
      clearTimeout(timer);
      if (!finished) {
        if (this.worker.connected) this.worker.disconnect();
        this.worker.unref();
        this.worker.channel?.unref();
        return;
      }
    }
    if (
      this.worker.pid &&
      this.worker.exitCode === null &&
      this.worker.signalCode === null
    ) {
      try {
        process.kill(-this.worker.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await this.exit;
    try {
      if (this.frozenRefs && gitDir) await this.releaseFrozenRefs(gitDir);
    } finally {
      await fs.promises.rm(this.temporaryRoot, {
        recursive: true,
        force: true,
      });
    }
  }

  private async releaseFrozenRefs(gitDir: string): Promise<void> {
    const prefix = `refs/rl/live-freeze/${this.freezeId}/`;
    const command = [
      "git",
      `--git-dir=${gitDir}`,
      "-c",
      "core.hooksPath=/dev/null",
    ];
    const options = {
      signal: AbortSignal.timeout(100),
      processGroup: true,
      abortGraceMs: 0,
    };
    try {
      const refs = await execute(
        [...command, "for-each-ref", "--format=%(refname)", prefix],
        this.temporaryRoot,
        options,
      );
      if (refs.code) throw new Error("Private ref cleanup deferred");
      const names = refs.stdout
        .split("\n")
        .filter((ref) => ref.startsWith(prefix));
      if (names.length) {
        const deleted = await execute(
          [...command, "update-ref", "--stdin"],
          this.temporaryRoot,
          {
            ...options,
            input: names.map((ref) => `delete ${ref}\n`).join(""),
          },
        );
        if (deleted.code) throw new Error("Private ref cleanup deferred");
      }
    } catch {
      const cleanup = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./review-live-cleanup.js", import.meta.url)),
          gitDir,
          this.freezeId,
        ],
        { detached: true, stdio: "ignore" },
      );
      cleanup.once("error", () => {});
      cleanup.unref();
    }
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
export function sourceLine(
  lines: string[],
  position: number,
  side: "before" | "after" = "after",
): number {
  let line = 1;
  let inHunk = false;
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  for (let i = 0; i <= Math.min(position, lines.length - 1); i++) {
    const text = lines[i];
    if (text.startsWith("diff --git ")) inHunk = false;
    const h = hunk.exec(text);
    if (h) {
      line = Number(h[side === "before" ? 1 : 2]);
      inHunk = true;
    } else if (
      inHunk &&
      i < position &&
      (text.startsWith(side === "before" ? "-" : "+") || text.startsWith(" "))
    )
      line++;
  }
  if (!inHunk) {
    const next = lines.slice(position).find((text) => hunk.test(text));
    if (next)
      return Math.max(1, Number(hunk.exec(next)![side === "before" ? 1 : 2]));
  }
  return Math.max(1, line);
}
const help = [
  "KEYBOARD",
  "1 / 2 / 3    Focus commits / files / diff",
  "Tab / Shift-Tab    Cycle panels",
  "Expanded: Tab / Shift-Tab or ] / [    Next / previous file",
  "Drag preview text    Select text; y / Ctrl-c copies; Esc clears",
  "Drag divider / - +    Resize sidebar; = restores default width",
  "j k / Up Down    Move selection or scroll",
  "Left Right    Panel focus; in diff: horizontal scroll",
  "PgUp PgDn / Ctrl-u Ctrl-d    Page",
  "Enter    Files, then diff; in diff: expand / restore",
  "Click    Select a commit, file, panel or footer action",
  "Space / checkbox / Shift-click    Toggle commits in the selection",
  "Selected commits show their own patches, grouped by commit.",
  "Wheel    Diff: three lines; commits: browse without changing selection",
  "Scrollbar    Click to jump; hold and drag the thumb to scroll",
  "Shift-Wheel    Scroll the diff horizontally",
  "Home End    Start / end of selected diff",
  "Esc    Back / close help or input",
  "w    Live working tree (staged + unstaged + untracked)",
  "p    Branch / PR merge-base comparison (committed)",
  "r    Enter FROM TO revision range",
  "s    Compare checkpoint to current source and index",
  "m    Mark exact inspected target reviewed",
  "f    Freeze / unfreeze snapshot",
  "t    Toggle tests, styles and boilerplate (hidden by default)",
  "T    Configure hidden categories; choices are saved for this worktree",
  "v    Toggle file reviewed · u / U next / previous unreviewed",
  "{ / }    Previous / next hunk · C expands diff context",
  "c    Toggle full-file context · e switches before / after",
  "b    Pick comparison base and target revisions",
  "d    Toggle changes since this file was last viewed",
  "L    Logic-first ordering · A explicit agent ranking",
  "Ctrl-f    Cross-file search · Tab changes search scope",
  "o    Open reviewed version · O open current worktree file",
  "/    Search file paths and selected diff",
  "n / N    Next / previous match",
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
  let fileFilters = loadReviewFilters(options.directory, options.root);
  let settings = loadReviewSettings(options.directory, options.root);
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
    allFiles: ReviewFile[] = [],
    files: ReviewFile[] = [],
    hideNoise = true,
    fileIndex = 0,
    commitIndex = 0,
    commitScroll = 0,
    focus = 0,
    scroll = 0,
    horizontal = 0,
    helpScroll = 0,
    expandedDiff = false,
    sidebarWidth: number | undefined = settings.sidebarWidth,
    lines: string[] = [];
  let fullFile = false,
    beforeFile = false,
    patchContext = 3,
    sinceViewed = false;
  const lineNumbers = true;
  let menu: ActionMenu | undefined,
    menuPreviousFocus = 0;
  let progress: ReviewProgress = { version: 1, reviewed: {}, viewed: {} },
    progressScope = "";
  let loadedFile: ReviewFile | undefined,
    selectionSource: ReviewFile | undefined;
  let pendingPosition:
    { key: string; line?: number; source?: number } | undefined;
  let scores: ReviewRanks = {},
    order: string[] | undefined;
  let rankBusy = false,
    searchScope: ReviewSearchScope = "diff",
    searchVersion = 0;
  let agentAbort = new AbortController(),
    rankVersion = 0,
    rankStale = false;
  const rankedFingerprints = new Map<string, string>();
  let status = "Loading Git state…",
    helpOpen = false,
    filterMenuOpen = false,
    filterMenuIndex = 0,
    filterPreviousFocus = 0,
    prompt:
      "range" | "search" | "hidePaths" | "showPaths" | "wheel" | undefined,
    input = "",
    search = "",
    pr: PullRequest | undefined,
    latestPr: PullRequest | undefined,
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
  let navigationVersion = 0;
  let previousRows: string[] = [],
    previousWidth = 0,
    renderTimer: ReturnType<typeof setTimeout> | undefined;
  const patchCache = new Map<string, string[]>();
  const patchSizes = new Map<string, number>();
  let patchChars = 0;
  const geometry = () =>
    reviewLayout(
      process.stdout.columns || 100,
      process.stdout.rows || 24,
      focus,
      expandedDiff,
      sidebarWidth,
      lineNumbers && !helpOpen && !filterMenuOpen && !menu ? 12 : 0,
    );
  const height = () => geometry().viewport.height;
  let frame: ReviewFrame | undefined;
  let activeViewport = "";
  let scrollbarDrag:
    { offset: number; viewport: string; help: boolean } | undefined;
  let dividerDrag = false;
  let selectingText = false;
  let textSelection: ReviewTextSelection | undefined;
  let selectionNotice = "";
  const displayedLines = () => textSelection?.lines ?? lines;
  let pendingWorkingFile: string | undefined;
  const filePositions = new Map<
    string,
    { scroll: number; horizontal: number }
  >();
  const inputEvents = new ReviewInput(onMouse);
  const wheelPace = new ReviewWheel();
  const selected = () => files[fileIndex];
  const workingFiles = () =>
    visibleReviewFiles(
      state?.workingFiles ?? [],
      hideNoise,
      fileFilters,
      settings,
    );
  const timeline = () => {
    const recent = remoteCommits ?? state?.commits ?? [];
    if (mode.kind !== "commits") return recent;
    const visibleShas = new Set(recent.map((commit) => commit.sha));
    return [
      ...recent,
      ...mode.commits.filter((commit) => !visibleShas.has(commit.sha)),
    ];
  };
  const key = () =>
    checkpointKey(options.root, state!.snapshot.branch, options.pr);
  const setStatus = (text: string) => {
    status = text;
    render();
  };
  const watcher = new ReviewWatcher(() => void refresh());
  const error = (cause: unknown) => {
    if (!stopped) {
      if (textSelection) selectionNotice = message(cause);
      setStatus(message(cause));
    }
  };
  function render(): void {
    if (stopped || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      try {
        draw();
      } catch (cause) {
        if (!stopped) status = message(cause);
      }
    }, 16);
  }
  function draw(): void {
    const width = process.stdout.columns || 100,
      rows = process.stdout.rows || 24;
    const visibleWorkingFiles = workingFiles();
    frame = reviewFrame({
      width,
      rows,
      focus,
      expanded: expandedDiff,
      sidebarWidth,
      textSelection,
      filterMenu: filterMenuOpen
        ? { filters: fileFilters, index: filterMenuIndex, settings }
        : undefined,
      menu,
      reviewed: new Set(
        files
          .filter((file) => isFileReviewed(progress, file))
          .map((file) => file.key),
      ),
      changedSinceViewed: new Set(
        files
          .filter(
            (file) =>
              progress.viewed[file.key] &&
              progress.viewed[file.key].fingerprint !==
                reviewFileFingerprint(file),
          )
          .map((file) => file.key),
      ),
      ranks: scores,
      fullFile,
      beforeFile,
      lineNumbers: lineNumbers && !helpOpen && !filterMenuOpen && !menu,
      previewLabel: sinceViewed
        ? "Changes since you last viewed this file · d returns to comparison"
        : fullFile
          ? `${beforeFile ? "Base" : "Target"} file content · c returns to diff`
          : undefined,
      branch: state?.snapshot.branch ?? path.basename(options.root),
      head: state?.snapshot.head ?? "",
      frozen,
      newer,
      mode,
      comparison: comparison?.label,
      commits: timeline(),
      commitIndex,
      commitScroll,
      files,
      fileIndex,
      hideNoise,
      hiddenFiles: allFiles.length - files.length,
      workingFiles: visibleWorkingFiles,
      hiddenWorkingFiles:
        (state?.workingFiles?.length ?? 0) - visibleWorkingFiles.length,
      lines: displayedLines(),
      scroll: helpOpen ? helpScroll : scroll,
      horizontal: helpOpen ? 0 : horizontal,
      help: helpOpen ? help : undefined,
      search,
      status: textSelection
        ? `${selectionNotice || "Text selected · y / Ctrl-c Copy · Esc Clear"}${textSelection.lines !== lines ? " · newer diff available" : ""}`
        : `${state && (!state.snapshot.complete || state.snapshot.conflicts.length || !state.snapshot.stable) ? `${state.snapshot.excluded.length} omitted / ${state.snapshot.conflicts.length} conflicts${!state.snapshot.stable ? " / source moving" : ""} · ` : ""}${options.pr && !pr && remote !== "Checking PR…" ? `PR #${options.pr}: ${remote}` : status}`,
      input: prompt
        ? `${prompt === "range" ? "Range FROM TO" : prompt === "search" ? `Search files / diff [${searchScope}; Tab changes scope]` : prompt === "wheel" ? "Wheel lines (1–20)" : prompt === "hidePaths" ? "Hide paths (comma-separated globs)" : "Always show paths (comma-separated globs)"}: ${input}▏`
        : undefined,
      remote,
      pr: pr
        ? `PR #${pr.number} ${pr.title} · ${pr.headRefName} → ${pr.baseRefName}`
        : undefined,
      updates,
    });
    if (previousWidth !== width || previousRows.length !== rows) {
      process.stdout.write(esc + "2J");
      previousRows = [];
      previousWidth = width;
    }
    let output = "";
    for (let i = 0; i < frame.rows.length; i++)
      if (frame.rows[i] !== previousRows[i])
        output += `${esc}${i + 1};1H${frame.rows[i]}`;
    process.stdout.write(output);
    previousRows = frame.rows;
  }
  function rememberPosition(): void {
    if (activeViewport)
      filePositions.set(activeViewport, { scroll, horizontal });
    if (filePositions.size > 200)
      filePositions.delete(filePositions.keys().next().value!);
  }
  function modeKey(): string {
    if (mode.kind === "commit") return `commit:${mode.sha}`;
    if (mode.kind === "commits") return "commits";
    if (mode.kind === "range") return `range:${mode.from}:${mode.to}`;
    if (mode.kind === "branch")
      return `branch:${mode.base}:${mode.head ?? "local"}`;
    if (mode.kind === "since") return `since:${mode.checkpoint.tree}`;
    return "working";
  }
  function scrollDiff(delta: number): void {
    if (helpOpen)
      helpScroll = Math.max(
        0,
        Math.min(scrollLimit(help.length, height()), helpScroll + delta),
      );
    else {
      scroll = Math.max(
        0,
        Math.min(
          scrollLimit(displayedLines().length, height()),
          scroll + delta,
        ),
      );
      rememberPosition();
    }
    render();
  }
  function selectCommit(index: number): void {
    rememberViewed();
    navigationVersion++;
    clearTextSelection();
    helpOpen = false;
    rememberPosition();
    commitIndex = Math.max(0, Math.min(timeline().length, index));
    mode = commitIndex
      ? { kind: "commit", sha: timeline()[commitIndex - 1].sha }
      : { kind: "working" };
    revealCommit();
    void compare();
  }
  function toggleCommit(index: number): void {
    navigationVersion++;
    rememberViewed();
    clearTextSelection();
    const commits = timeline();
    const commit = commits[index - 1];
    if (!commit) return;
    helpOpen = false;
    rememberPosition();
    commitIndex = index;
    const selection = new Set<string>();
    if (mode.kind === "commits") {
      for (const selected of mode.commits) selection.add(selected.sha);
    } else if (mode.kind === "commit" && mode.sha !== commit.sha) {
      selection.add(mode.sha);
    }
    if (selection.has(commit.sha)) selection.delete(commit.sha);
    else selection.add(commit.sha);
    mode = selection.size
      ? {
          kind: "commits",
          commits: commits.filter((entry) => selection.has(entry.sha)),
        }
      : { kind: "working" };
    commitIndex = Math.max(
      0,
      timeline().findIndex((entry) => entry.sha === commit.sha) + 1,
    );
    revealCommit();
    void compare();
    render();
  }
  function moveCommit(delta: number): void {
    if (mode.kind === "commits") {
      commitIndex = Math.max(
        1,
        Math.min(timeline().length, commitIndex + delta),
      );
      revealCommit();
      render();
    } else selectCommit(commitIndex + delta);
  }
  function scrollCommits(delta: number): void {
    const layout = geometry();
    const capacity = Math.max(1, Math.floor((layout.commits.height - 2) / 3));
    const count = timeline().length + (layout.narrow ? 1 : 0);
    commitScroll = Math.max(
      0,
      Math.min(Math.max(0, count - capacity), commitScroll + delta),
    );
    render();
  }
  function revealCommit(): void {
    const layout = geometry();
    const capacity = Math.max(1, Math.floor((layout.commits.height - 2) / 3));
    const row = Math.max(0, commitIndex - (layout.narrow ? 0 : 1));
    if (row < commitScroll) commitScroll = row;
    else if (row >= commitScroll + capacity) commitScroll = row - capacity + 1;
    scrollCommits(0);
  }
  function selectFile(index: number): void {
    helpOpen = false;
    const next = Math.max(0, Math.min(Math.max(0, files.length - 1), index));
    if (next !== fileIndex) {
      rememberViewed();
      clearTextSelection();
      rememberPosition();
      fileIndex = next;
      void patch();
    }
    render();
  }
  function filterFiles(oldKey = selected()?.key, oldFile = selected()): void {
    rememberPosition();
    files = visibleReviewFiles(allFiles, hideNoise, fileFilters, settings);
    if (order) {
      const positions = new Map(order.map((key, index) => [key, index]));
      files = files
        .map((file, index) => ({ file, index }))
        .sort(
          (a, b) =>
            (positions.get(a.file.key) ?? order!.length + a.index) -
            (positions.get(b.file.key) ?? order!.length + b.index),
        )
        .map(({ file }) => file);
    }
    let index = files.findIndex((file) => file.key === oldKey);
    if (index < 0 && mode.kind === "commits" && oldFile)
      index = files.findIndex(
        (file) => file.path === oldFile.path && file.to === oldFile.to,
      );
    fileIndex =
      index < 0 ? Math.min(fileIndex, Math.max(0, files.length - 1)) : index;
  }
  function rememberViewed(
    file = textSelection ? selectionSource : loadedFile,
  ): void {
    if (
      !file ||
      !state ||
      !progressScope ||
      progressScope !== key() ||
      progress.viewed[file.key]?.fingerprint === reviewFileFingerprint(file)
    )
      return;
    const scope = progressScope;
    void git
      .request<ReviewProgress>("viewed", {
        directory: options.directory,
        key: scope,
        file,
      })
      .then((result) => {
        if (!stopped && progressScope === scope) {
          progress = result;
          render();
        }
      })
      .catch(error);
  }
  function openMenu(next: ActionMenu): void {
    if (!menu) menuPreviousFocus = focus;
    clearTextSelection();
    helpOpen = filterMenuOpen = false;
    menu = next;
    focus = 2;
    render();
  }
  function closeMenu(): void {
    menu = undefined;
    focus = menuPreviousFocus;
    render();
  }
  async function comparisonPicker(): Promise<void> {
    if (!state) return;
    const version = ++navigationVersion;
    const references =
      await git.request<{ label: string; ref: string; sha: string }[]>(
        "references",
      );
    if (stopped || version !== navigationVersion) return;
    const choices = [
      { label: "Current HEAD", ref: state.snapshot.head },
      ...(options.pr && pr
        ? [{ label: `PR #${pr.number} HEAD`, ref: pr.headRefOid }]
        : []),
      ...references.map((entry) => ({ label: entry.label, ref: entry.sha })),
      ...timeline().map((commit) => ({
        label: `${commit.sha.slice(0, 8)} ${commit.subject}`,
        ref: commit.sha,
      })),
    ].filter((entry) => entry.ref);
    openMenu({
      kind: "base",
      title: "COMPARE · CHOOSE BASE",
      subtitle: "Base → target · immutable revisions; r accepts typed refs",
      index: 0,
      items: [
        {
          label: "Last reviewed → current working tree",
          detail: "Use your exact saved source and index checkpoint",
        },
        ...choices.map((choice) => ({
          label: choice.label,
          detail: choice.ref,
        })),
      ],
      values: ["__checkpoint__", ...choices.map((choice) => choice.ref)],
    });
  }
  async function chooseMenu(index: number): Promise<void> {
    const current = menu;
    if (!current) return;
    if (current.kind === "base") {
      const base = current.values?.[index];
      if (!base) return;
      if (base === "__checkpoint__") {
        closeMenu();
        onKey("s", { name: "s" });
        return;
      }
      openMenu({
        ...current,
        kind: "target",
        title: "COMPARE · CHOOSE TARGET",
        subtitle: `${base.slice(0, 12)} → target`,
        base,
        index: 0,
        items: current.items.slice(1),
        values: current.values!.slice(1),
      });
    } else if (current.kind === "target") {
      const to = current.values?.[index];
      if (!to || !current.base) return;
      navigationVersion++;
      rememberViewed();
      mode = { kind: "range", from: current.base, to };
      closeMenu();
      focus = 2;
      void compare();
    } else if (current.kind === "search") {
      const hit = current.hits?.[index];
      if (!hit) return;
      const target = files.findIndex((file) => file.key === hit.fileKey);
      if (target < 0)
        throw new Error(
          "Search result changed; search the current comparison again",
        );
      if (
        current.identities?.[hit.fileKey] !==
        reviewFileFingerprint(files[target])
      )
        throw new Error(
          "Search result changed; search the current comparison again",
        );
      closeMenu();
      fullFile = hit.fullFile;
      beforeFile = hit.fullFile && files[target].status.startsWith("D");
      sinceViewed = false;
      pendingPosition = { key: hit.fileKey, line: hit.line };
      focus = 2;
      selectFile(target);
      void patch();
    } else {
      const provider = current.values?.[index];
      closeMenu();
      if (provider) await rankFiles(provider);
    }
  }
  async function searchAcrossFiles(query: string): Promise<void> {
    const version = ++searchVersion;
    const captured = files.map((file) => ({ ...file })),
      scope = searchScope;
    setStatus(`Searching ${files.length} visible file layers…`);
    const result = await git.request<ReviewSearchResult>("search", {
      files: captured,
      query,
      scope,
      context: patchContext,
    });
    if (stopped || version !== searchVersion) return;
    const identities = Object.fromEntries(
      captured.map((file) => [file.key, reviewFileFingerprint(file)]),
    );
    if (
      !captured.every((file) =>
        files.some(
          (next) =>
            next.key === file.key &&
            reviewFileFingerprint(next) === identities[file.key],
        ),
      )
    ) {
      setStatus(
        "Changes arrived during search; search the current comparison again",
      );
      return;
    }
    openMenu({
      kind: "search",
      title: `SEARCH RESULTS · ${result.hits.length}${result.limited ? "+" : ""}`,
      subtitle: `${searchScope}: ${query} · scanned ${result.scanned}/${result.total}${result.limited ? " · context limit reached" : ""}`,
      index: 0,
      items: result.hits.length
        ? result.hits.map((hit) => ({
            label: `${hit.path}:${hit.line + 1}`,
            detail: hit.preview,
          }))
        : [{ label: "No matches in this scope" }],
      hits: result.hits,
      identities,
    });
  }
  async function rankFiles(provider?: string): Promise<void> {
    if (rankBusy) {
      setStatus("Ranking already running · Ctrl-g cancels agent ranking");
      return;
    }
    if (!files.length) return;
    if (!provider && order && !rankStale) {
      order = undefined;
      filterFiles();
      setStatus("Original Git file order restored");
      return;
    }
    rankBusy = true;
    const version = ++rankVersion;
    const captured = [...files],
      fingerprints = new Map(
        captured.map((file) => [file.key, reviewFileFingerprint(file)]),
      );
    const valid = () =>
      !stopped &&
      version === rankVersion &&
      captured.every((file) =>
        allFiles.some(
          (current) =>
            current.key === file.key &&
            reviewFileFingerprint(current) === fingerprints.get(file.key),
        ),
      );
    try {
      setStatus(
        provider
          ? `Preparing read-only ${provider} ranking…`
          : "Ranking logical changes in the background…",
      );
      let result: ReviewRanks;
      if (provider) {
        const evidence = await git.request<ReviewRankEvidence[]>(
          "rank-evidence",
          { files: captured },
        );
        if (!valid()) return;
        agentAbort = new AbortController();
        setStatus(
          `Ranking with ${provider} · explicit read-only analysis · Ctrl-g cancels`,
        );
        result = await rankWithReviewAgent(
          options.root,
          provider,
          evidence,
          agentAbort.signal,
        );
      } else
        result = await git.request<ReviewRanks>("rank", { files: captured });
      if (!valid()) {
        if (!stopped)
          setStatus(
            "Changes arrived during ranking; press L or A to rank the latest comparison",
          );
        return;
      }
      scores = result;
      rankedFingerprints.clear();
      for (const file of captured)
        if (result[file.key])
          rankedFingerprints.set(file.key, reviewFileFingerprint(file));
      order = sortReviewFiles(captured, scores).map((file) => file.key);
      rankStale = false;
      filterFiles();
      setStatus(
        `${provider ? "Agent" : "Logic"} order applied · reasons shown above the diff · updates keep this order until L refreshes`,
      );
    } finally {
      if (version === rankVersion) rankBusy = false;
    }
  }
  function applyPendingPosition(file: ReviewFile): void {
    if (pendingPosition?.key !== file.key) return;
    if (pendingPosition.line !== undefined) scroll = pendingPosition.line;
    else if (pendingPosition.source !== undefined) {
      if (fullFile) scroll = pendingPosition.source - 1;
      else {
        const target = reviewLineNumbers(lines).findIndex(
          ([old, next]) =>
            (beforeFile ? old : next) !== undefined &&
            (beforeFile ? old! : next!) >= pendingPosition!.source!,
        );
        if (target >= 0) scroll = target;
      }
    }
    pendingPosition = undefined;
    scroll = Math.max(
      0,
      Math.min(scroll, scrollLimit(displayedLines().length, height())),
    );
    rememberPosition();
  }
  function onMouse(event: ReviewMouse): void {
    if (stopped) return;
    if (event.release) {
      if (dividerDrag) {
        persistSettings({ ...settings, sidebarWidth }, false);
        setStatus(
          `Sidebar ${geometry().commits.width} columns · drag divider or use −/+; = resets`,
        );
      }
      if (selectingText && textSelection) {
        textSelection.end = textPoint(event);
        if (!reviewSelectedText(textSelection)) clearTextSelection();
        render();
      }
      scrollbarDrag = undefined;
      dividerDrag = selectingText = false;
      return;
    }
    if (event.button & 32 && !(event.button & 64)) {
      if ((event.button & 3) === 0) {
        if (dividerDrag) resizeSidebar(event.x - 1);
        else if (selectingText && textSelection) {
          textSelection.end = textPoint(event);
          selectionNotice = "";
          render();
        } else if (scrollbarDrag) dragScrollbar(event.y);
      }
      return;
    }
    if (!(event.button & 64)) {
      scrollbarDrag = undefined;
      dividerDrag = selectingText = false;
    }
    if (!frame) draw();
    const hit = frame!.hits
      .filter(
        (h) =>
          event.x >= h.x &&
          event.x < h.x + h.width &&
          event.y >= h.y &&
          event.y < h.y + h.height,
      )
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (!hit) return;
    if (menu && !prompt) {
      if (event.button & 64) {
        menu.index = Math.max(
          0,
          Math.min(
            menu.items.length - 1,
            menu.index + (event.button & 1 ? 1 : -1),
          ),
        );
        render();
      } else if ((event.button & 3) === 0) {
        if (hit.action === "menu" && hit.index !== undefined)
          void chooseMenu(hit.index).catch(error);
        else if (hit.action === "shortcut")
          onKey(hit.shortcut!, { name: hit.shortcut });
      }
      return;
    }
    if (filterMenuOpen && !prompt) {
      if (event.button & 64) {
        filterMenuIndex = Math.max(
          0,
          Math.min(
            reviewFilterCategories.length + advancedReviewFilters.length - 1,
            filterMenuIndex + (event.button & 1 ? 1 : -1),
          ),
        );
        render();
      } else if ((event.button & 3) === 0) {
        if (hit.action === "filter-category" && hit.index !== undefined) {
          filterMenuIndex = hit.index;
          toggleFilterCategory(hit.index);
        } else if (hit.action === "shortcut")
          onKey(hit.shortcut!, { name: hit.shortcut });
      }
      return;
    }
    if (prompt) {
      if (
        hit.action === "shortcut" &&
        hit.shortcut === "q" &&
        (event.button & 3) === 0 &&
        !(event.button & 64)
      )
        finish();
      return;
    }
    const wheel = (event.button & 64) !== 0,
      delta = event.button & 1 ? 1 : -1;
    if (wheel) {
      const horizontalWheel = !!(event.button & 4 || event.button & 2);
      const target =
        hit.action === "diff" ||
        hit.action === "expand" ||
        hit.action === "scrollbar"
          ? `diff:${activeViewport}:${horizontalWheel}`
          : hit.action === "toggle-commit"
            ? "commits"
            : hit.action;
      if (!wheelPace.accept(target, delta)) return;
      if (
        hit.action === "diff" ||
        hit.action === "expand" ||
        hit.action === "scrollbar"
      ) {
        focus = 2;
        if (event.button & 4 || event.button & 2) {
          horizontal = Math.max(0, horizontal + delta * 2);
          rememberPosition();
          render();
        } else {
          scrollDiff(delta * settings.wheelStep);
          if (selectingText && textSelection)
            textSelection.end = textPoint(event);
        }
      } else if (hit.action === "files") {
        focus = 1;
        selectFile(fileIndex + delta);
      } else if (hit.action === "commits" || hit.action === "toggle-commit") {
        focus = 0;
        scrollCommits(delta);
      }
      return;
    }
    if ((event.button & 3) !== 0) return;
    if (hit.action === "shortcut") {
      onKey(hit.shortcut!, {
        name: hit.shortcut === "\t" ? "tab" : hit.shortcut,
      });
      return;
    }
    if (hit.action === "expand") {
      focus = 2;
      expandedDiff = !expandedDiff;
      render();
      return;
    }
    if (hit.action === "divider") {
      dividerDrag = true;
      clearTextSelection();
      return;
    }
    if (hit.action === "scrollbar") {
      focus = 2;
      const { viewport } = frame!.layout;
      const bar = reviewScrollbar(
        (helpOpen ? help : displayedLines()).length,
        viewport.height,
        helpOpen ? helpScroll : scroll,
      );
      const row = event.y - viewport.y;
      const onThumb =
        row >= bar.thumbStart && row < bar.thumbStart + bar.thumbSize;
      scrollbarDrag = {
        offset: onThumb
          ? row - bar.thumbStart
          : Math.floor((bar.thumbSize - 1) / 2),
        viewport: activeViewport,
        help: helpOpen,
      };
      if (!onThumb) dragScrollbar(event.y);
      render();
      return;
    }
    if (hit.action === "diff") {
      focus = 2;
      const viewport = frame!.layout.viewport;
      if (
        !helpOpen &&
        event.y >= viewport.y &&
        event.y < viewport.y + viewport.height &&
        event.x >= viewport.x &&
        event.x < viewport.x + viewport.width
      ) {
        clearTextSelection();
        if (!patchBusy && lines.length) {
          const point = textPoint(event);
          textSelection = { anchor: point, end: point, lines };
          selectionSource = loadedFile;
          selectingText = true;
        }
      }
      render();
      return;
    }
    if (hit.action === "commits" || hit.action === "toggle-commit") {
      focus = 0;
      if (hit.index !== undefined) {
        if (hit.action === "toggle-commit" || event.button & 4)
          toggleCommit(hit.index);
        else selectCommit(hit.index);
      }
      render();
      return;
    }
    if (hit.action === "files") {
      focus = 1;
      if (hit.index !== undefined) {
        selectFile(hit.index);
        focus = 2;
      }
      render();
      return;
    }
    if (hit.action === "working") {
      const chosen =
        hit.index === undefined ? undefined : workingFiles()[hit.index];
      pendingWorkingFile = chosen?.key;
      focus = chosen ? 2 : 0;
      selectCommit(0);
      render();
    }
  }
  function clearTextSelection(): void {
    textSelection = undefined;
    selectingText = false;
    selectionNotice = "";
    scroll = Math.min(scroll, scrollLimit(lines.length, height()));
  }
  function toggleFilterMenu(): void {
    if (filterMenuOpen) {
      filterMenuOpen = false;
      focus = filterPreviousFocus;
    } else {
      menu = undefined;
      clearTextSelection();
      helpOpen = false;
      filterPreviousFocus = focus;
      focus = 2;
      filterMenuOpen = true;
    }
    render();
  }
  function updateFileFilters(next: ReviewFileFilters): void {
    try {
      saveReviewFilters(options.directory, options.root, next);
      fileFilters = next;
      hideNoise = true;
      clearTextSelection();
      filterFiles();
      void patch();
      setStatus(
        `Filters saved for this worktree · ${allFiles.length - files.length} file layers hidden`,
      );
    } catch (cause) {
      error(cause);
    }
  }
  function toggleFilterCategory(index: number): void {
    const advanced =
      advancedReviewFilters[index - reviewFilterCategories.length];
    if (advanced) {
      const value = settings[advanced.key] ?? fileFilters.boilerplate;
      persistSettings({ ...settings, [advanced.key]: !value });
      return;
    }
    const key = reviewFilterCategories[index]?.key;
    if (key) updateFileFilters({ ...fileFilters, [key]: !fileFilters[key] });
  }
  function persistSettings(next: ReviewSettings, refilter = true): void {
    try {
      saveReviewSettings(options.directory, options.root, next);
      settings = next;
      if (refilter) {
        clearTextSelection();
        filterFiles();
        void patch();
      }
      setStatus("Review preferences saved for this worktree");
    } catch (cause) {
      error(cause);
    }
  }
  function textPoint(event: ReviewMouse): ReviewTextPoint {
    const { viewport } = geometry();
    const line = Math.max(
      0,
      Math.min(
        displayedLines().length - 1,
        scroll +
          Math.max(0, Math.min(viewport.height - 1, event.y - viewport.y)),
      ),
    );
    return {
      line,
      column: reviewTextColumn(
        displayedLines()[line] ?? "",
        horizontal +
          Math.max(0, Math.min(viewport.width, event.x - viewport.x)),
      ),
    };
  }
  function copySelection(): void {
    if (!textSelection) return;
    const text = reviewSelectedText(textSelection);
    if (!text) return;
    if (Buffer.byteLength(text) > 1024 * 1024) {
      selectionNotice =
        "Selection exceeds clipboard limit (1 MiB); select a smaller range";
    } else {
      process.stdout.write(
        `\x1b]52;c;${Buffer.from(text).toString("base64")}\x1b\\`,
      );
      selectionNotice = `Copied ${Array.from(text).length} characters · Esc Clear`;
    }
    render();
  }
  function resizeSidebar(width: number | undefined): void {
    const layout = reviewLayout(
      process.stdout.columns || 100,
      process.stdout.rows || 24,
      focus,
      false,
      width,
    );
    sidebarWidth = width === undefined ? undefined : layout.commits.width;
    if (!dividerDrag) persistSettings({ ...settings, sidebarWidth }, false);
    setStatus(
      `Sidebar ${layout.commits.width} columns · drag divider or - / + · = resets`,
    );
  }
  function dragScrollbar(y: number): void {
    if (!scrollbarDrag) return;
    if (
      scrollbarDrag.viewport !== activeViewport ||
      scrollbarDrag.help !== helpOpen
    ) {
      scrollbarDrag = undefined;
      return;
    }
    const { viewport } = geometry();
    const bar = reviewScrollbar(
      (helpOpen ? help : displayedLines()).length,
      viewport.height,
      helpOpen ? helpScroll : scroll,
    );
    const position = Math.max(
      0,
      Math.min(bar.travel, y - viewport.y - scrollbarDrag.offset),
    );
    const target = Math.round((position / Math.max(1, bar.travel)) * bar.limit);
    if (helpOpen) helpScroll = target;
    else {
      scroll = target;
      rememberPosition();
    }
    render();
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
      const oldFile = selected();
      const oldKey = pendingWorkingFile ?? oldFile?.key;
      pendingWorkingFile = undefined;
      comparison = result.comparison;
      allFiles = result.files;
      for (const file of allFiles) {
        const identity = rankedFingerprints.get(file.key);
        if (identity && identity !== reviewFileFingerprint(file)) {
          rankStale = true;
          delete scores[file.key];
        }
      }
      if (progressScope !== key()) {
        const scope = key();
        progress = await git.request<ReviewProgress>("progress", {
          directory: options.directory,
          key: scope,
        });
        if (stopped || version !== compareVersion) return;
        progressScope = scope;
      }
      filterFiles(oldKey, oldFile);
      if (frozen)
        void git
          .request("freeze", {
            state,
            target: comparison.target,
            revisions: comparison.scopes.flatMap((s) => [s.from, s.to]),
          })
          .catch(error);
      await patch();
      status = frozen
        ? "Frozen snapshot · background detection continues"
        : `Updated · ${files.length} file layers${rankStale ? " · ranking stale: L refreshes" : ""} · f freezes the inspected snapshot`;
    } catch (cause) {
      if (version === compareVersion) {
        loadedFile = undefined;
        comparison = undefined;
        allFiles = [];
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
      loadedFile = undefined;
      clearTextSelection();
      rememberPosition();
      activeViewport = "";
      scroll = horizontal = 0;
      lines = [
        hideNoise && allFiles.length
          ? "Only filtered files changed. Press t to show all."
          : "No changes in this comparison.",
      ];
      render();
      return;
    }
    const viewportKey = `${modeKey()}:${file.key}`;
    if (activeViewport !== viewportKey) {
      clearTextSelection();
      rememberPosition();
      activeViewport = viewportKey;
      const previous = filePositions.get(viewportKey);
      scroll = previous?.scroll ?? 0;
      horizontal = previous?.horizontal ?? 0;
    }
    const version = patchVersion,
      cacheKey = `${file.key}:${reviewFileFingerprint(file)}:${fullFile ? (beforeFile ? "before" : "after") : sinceViewed ? `viewed:${progress.viewed[file.key]?.tree}` : `diff:${patchContext}`}`;
    if (patchCache.has(cacheKey)) {
      lines = patchCache.get(cacheKey)!;
      loadedFile = file;
      applyPendingPosition(file);
      if (!progress.viewed[file.key]) rememberViewed(file);
      scroll = Math.min(scroll, scrollLimit(displayedLines().length, height()));
      render();
      return;
    }
    patchBusy = true;
    loadedFile = undefined;
    // Never leave another file's patch underneath a new selection.
    lines = [`Loading ${file.path}…`];
    render();
    try {
      let result: string;
      if (fullFile)
        result = (
          await git.request<{ text: string }>("content", {
            file,
            side: beforeFile ? "before" : "after",
          })
        ).text;
      else if (sinceViewed && progress.viewed[file.key])
        result = await git.request<string>("delta", {
          file,
          viewed: progress.viewed[file.key],
          context: patchContext,
        });
      else
        result = await git.request<string>("patch", {
          file,
          context: patchContext,
        });
      if (stopped || version !== patchVersion) return;
      lines = result.split("\n");
      loadedFile = file;
      patchCache.set(cacheKey, lines);
      patchSizes.set(cacheKey, result.length);
      patchChars += result.length;
      applyPendingPosition(file);
      if (!progress.viewed[file.key]) rememberViewed(file);
      while (patchCache.size > 20 || patchChars > 16 * 1024 * 1024) {
        const oldest = patchCache.keys().next().value!;
        patchChars -= patchSizes.get(oldest) ?? 0;
        patchSizes.delete(oldest);
        patchCache.delete(oldest);
      }
      scroll = Math.min(scroll, scrollLimit(displayedLines().length, height()));
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
    const navigation = navigationVersion;
    try {
      await git.request("identity");
      if (stopped) return;
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
        latestPr?.headRefOid !== result.headRefOid ||
        latestPr?.baseRefOid !== result.baseRefOid;
      const followBranch =
        navigation === navigationVersion &&
        ((!pr && mode.kind === "working") || mode.kind === "branch");
      const selectedSha =
        commitIndex > 0 ? timeline()[commitIndex - 1]?.sha : undefined;
      latestPr = result;
      if (!frozen) pr = result;
      if (options.pr && changed)
        latestRemoteCommits = await git.request<Commit[]>("history", {
          head: result.headRefOid,
          base: result.baseRefOid,
        });
      remote = `#${result.number} head ${result.headRefOid.slice(0, 8)} (polled separately)`;
      if (options.pr && changed && !frozen) {
        remoteCommits = latestRemoteCommits;
        if (selectedSha)
          commitIndex = Math.max(
            0,
            timeline().findIndex((c) => c.sha === selectedSha) + 1,
          );
        if (followBranch && navigation === navigationVersion && !frozen) {
          mode = {
            kind: "branch",
            base: result.baseRefOid,
            head: result.headRefOid,
          };
          void compare();
        }
      }
      if (
        frozen &&
        pr &&
        (pr.headRefOid !== result.headRefOid ||
          pr.baseRefOid !== result.baseRefOid)
      ) {
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
    helpOpen = false;
    if (focus !== 1) focus = 2;
    if (focus === 1) {
      for (let n = 1; n <= files.length; n++) {
        const i = (fileIndex + direction * n + files.length) % files.length;
        if (files[i].path.toLowerCase().includes(search.toLowerCase())) {
          selectFile(i);
          break;
        }
      }
    } else {
      const content = displayedLines();
      for (let n = 1; n <= content.length; n++) {
        const i = (scroll + direction * n + content.length) % content.length;
        if (content[i].toLowerCase().includes(search.toLowerCase())) {
          scroll = i;
          break;
        }
      }
    }
    render();
  }
  async function mark(): Promise<void> {
    if (textSelection && textSelection.lines !== lines)
      throw new Error(
        "Clear text selection with Escape to load the latest diff before marking reviewed",
      );
    if (!state || !comparison || compareBusy || compareAgain)
      throw new Error(
        "Wait for the comparison to finish before marking reviewed",
      );
    if (mode.kind === "commits" && mode.commits.length > 1)
      throw new Error("Select one commit or a range to mark a checkpoint");
    if (
      (mode.kind === "working" || mode.kind === "since") &&
      !state.snapshot.stable
    )
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
      state,
      pr: options.pr,
    });
    setStatus(
      `Marked inspected snapshot ${point.label} reviewed · s compares later changes`,
    );
  }
  function onKey(text: string, keypress: readline.Key): void {
    if (stopped) return;
    scrollbarDrag = undefined;
    dividerDrag = selectingText = false;
    const name = keypress.name;
    if (keypress.ctrl && name === "c") {
      if (textSelection && reviewSelectedText(textSelection)) copySelection();
      else finish();
      return;
    }
    if (prompt) {
      if (name === "tab" && prompt === "search") {
        const scopes: ReviewSearchScope[] = [
          "diff",
          "paths",
          "changes",
          "files",
        ];
        searchScope =
          scopes[
            (scopes.indexOf(searchScope) + (keypress.shift ? 3 : 1)) %
              scopes.length
          ];
        render();
        return;
      }
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
            navigationVersion++;
            rememberViewed();
            clearTextSelection();
            mode = { kind: "range", from: refs[0], to: refs[1] };
            rememberPosition();
            void compare();
          }
        } else if (kind === "search") {
          search = value;
          if (searchScope === "changes" || searchScope === "files")
            void searchAcrossFiles(value).catch(error);
          else {
            focus = searchScope === "paths" ? 1 : 2;
            nextMatch();
          }
        } else if (kind === "wheel") {
          const wheelStep = Number(value);
          if (!Number.isInteger(wheelStep) || wheelStep < 1 || wheelStep > 20)
            setStatus("Wheel speed must be an integer between 1 and 20");
          else persistSettings({ ...settings, wheelStep }, false);
        } else {
          const paths = value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
          if (paths.length > 100 || paths.some((entry) => entry.length > 500))
            setStatus("Use at most 100 path rules of 500 characters each");
          else persistSettings({ ...settings, [kind]: paths });
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
    if (menu) {
      if (name === "escape") {
        searchVersion++;
        closeMenu();
      } else if (name === "return") void chooseMenu(menu.index).catch(error);
      else if (
        name === "down" ||
        text === "j" ||
        name === "up" ||
        text === "k"
      ) {
        menu.index = Math.max(
          0,
          Math.min(
            menu.items.length - 1,
            menu.index + (name === "down" || text === "j" ? 1 : -1),
          ),
        );
        render();
      }
      return;
    }
    if (filterMenuOpen) {
      if (name === "escape" || text === "T") toggleFilterMenu();
      else if (["1", "2", "3", "4", "5"].includes(text)) {
        filterMenuIndex = Number(text) - 1;
        toggleFilterCategory(filterMenuIndex);
      } else if (name === "return" || text === " ")
        toggleFilterCategory(filterMenuIndex);
      else if (text === "a" || text === "d" || text === "n") {
        persistSettings({
          ...settings,
          lockfiles: undefined,
          generated: undefined,
        });
        updateFileFilters(
          text === "n"
            ? { test: false, style: false, boilerplate: false }
            : { ...defaultReviewFilters },
        );
      } else if (text === "h" || text === "i" || text === "w") {
        prompt =
          text === "h" ? "hidePaths" : text === "i" ? "showPaths" : "wheel";
        input =
          prompt === "wheel"
            ? String(settings.wheelStep)
            : settings[prompt].join(", ");
        render();
      } else if (text === "t") {
        toggleFilterMenu();
        onKey("t", { name: "t" });
      } else if (
        name === "down" ||
        text === "j" ||
        name === "up" ||
        text === "k"
      ) {
        filterMenuIndex = Math.max(
          0,
          Math.min(
            reviewFilterCategories.length + advancedReviewFilters.length - 1,
            filterMenuIndex + (name === "down" || text === "j" ? 1 : -1),
          ),
        );
        render();
      }
      return;
    }
    if (text === "T") {
      toggleFilterMenu();
      return;
    }
    if (name === "escape") {
      if (textSelection) clearTextSelection();
      else if (helpOpen) {
        helpOpen = false;
        helpScroll = 0;
      } else if (expandedDiff) {
        expandedDiff = false;
      } else if (search) {
        search = "";
      } else focus = Math.max(0, focus - 1);
      render();
      return;
    }
    if (text === "?") {
      clearTextSelection();
      helpOpen = !helpOpen;
      focus = 2;
      helpScroll = 0;
      render();
      return;
    }
    if (text === "/") {
      prompt = "search";
      input = search;
      searchScope = focus === 1 ? "paths" : "diff";
      render();
      return;
    }
    if (keypress.ctrl && name === "f") {
      prompt = "search";
      input = search;
      searchScope = "changes";
      render();
      return;
    }
    if (keypress.ctrl && name === "g") {
      rankVersion++;
      agentAbort.abort();
      rankBusy = false;
      searchVersion++;
      setStatus("Background analysis cancelled");
      return;
    }
    if (text === "b") {
      void comparisonPicker().catch(error);
      return;
    }
    if (text === "L") {
      void rankFiles().catch(error);
      return;
    }
    if (text === "A") {
      openMenu({
        kind: "agent",
        title: "AGENT RANKING · CHOOSE PROVIDER",
        subtitle:
          "Explicit read-only analysis of captured patches; may use your provider quota",
        index: 0,
        items: [
          { label: "Codex" },
          { label: "Claude" },
          { label: "Antigravity" },
        ],
        values: ["codex", "claude", "agy"],
      });
      return;
    }
    if (text === "v") {
      const file = textSelection ? selectionSource : loadedFile;
      if (!file || patchBusy || compareBusy || !progressScope) {
        setStatus(
          "Wait for the displayed file to finish loading before marking it reviewed",
        );
        return;
      }
      const scope = progressScope;
      void git
        .request<ReviewProgress>("review-file", {
          directory: options.directory,
          key: scope,
          file,
        })
        .then((result) => {
          if (stopped || scope !== progressScope) return;
          progress = result;
          setStatus(
            `${isFileReviewed(progress, file) ? "Reviewed" : "Unmarked"} ${file.path} · u jumps to the next unreviewed file`,
          );
        })
        .catch(error);
      return;
    }
    if (text === "u" || text === "U") {
      for (let n = 1; n <= files.length; n++) {
        const index =
          (fileIndex + (text === "U" ? -n : n) + files.length) % files.length;
        if (!isFileReviewed(progress, files[index])) {
          focus = 2;
          selectFile(index);
          return;
        }
      }
      setStatus("All visible files in this comparison are reviewed");
      return;
    }
    if (text === "{" || text === "}") {
      const hunks = displayedLines().flatMap((line, index) =>
        line.startsWith("@@ ") ? [index] : [],
      );
      const target =
        text === "}"
          ? hunks.find((index) => index > scroll)
          : hunks.reverse().find((index) => index < scroll);
      if (target !== undefined) scrollDiff(target - scroll);
      else setStatus("No further hunk in this direction");
      return;
    }
    if (text === "c" || text === "e" || text === "C") {
      const file = selected();
      if (!file) return;
      const source = fullFile
        ? scroll + 1
        : sourceLine(displayedLines(), scroll);
      clearTextSelection();
      if (text === "C") {
        patchContext = patchContext === 3 ? 12 : patchContext === 12 ? 40 : 3;
        fullFile = sinceViewed = false;
      } else if (text === "e") {
        fullFile = true;
        beforeFile = !beforeFile;
        sinceViewed = false;
      } else {
        fullFile = !fullFile;
        sinceViewed = false;
        if (fullFile) beforeFile = file.status.startsWith("D");
      }
      pendingPosition = { key: file.key, source };
      void patch();
      return;
    }
    if (text === "d") {
      const file = selected();
      if (!file) return;
      if (!progress.viewed[file.key]) {
        setStatus("This file has no earlier viewed revision yet");
        return;
      }
      clearTextSelection();
      sinceViewed = !sinceViewed;
      fullFile = false;
      scroll = 0;
      void patch();
      return;
    }
    if (text === "r" && !keypress.ctrl) {
      prompt = "range";
      input = "";
      render();
      return;
    }
    if (text === "t" && !keypress.ctrl && !keypress.meta) {
      clearTextSelection();
      hideNoise = !hideNoise;
      filterFiles();
      void patch();
      setStatus(
        hideNoise
          ? `Configured filters active · ${allFiles.length - files.length} file layers hidden · T configures`
          : "All files shown · t restores configured filters · T configures",
      );
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
          .catch((cause) => {
            frozen = false;
            error(cause);
          });
      else if (!frozen) void git.request("release").catch(error);
      if (!frozen && latest) {
        pr = latestPr ?? pr;
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
      navigationVersion++;
      rememberViewed();
      clearTextSelection();
      mode = { kind: "working" };
      commitIndex = 0;
      rememberPosition();
      void compare();
      return;
    }
    if (text === "p") {
      navigationVersion++;
      rememberViewed();
      clearTextSelection();
      mode = {
        kind: "branch",
        base: pr?.baseRefOid ?? options.defaultBase,
        ...(options.pr && pr ? { head: pr.headRefOid } : {}),
      };
      rememberPosition();
      void compare();
      return;
    }
    if (text === "s") {
      navigationVersion++;
      rememberViewed();
      clearTextSelection();
      try {
        if (state) {
          const navigation = navigationVersion;
          void git
            .request<Checkpoint>("checkpoint", {
              directory: options.directory,
              key: key(),
              branch: state.snapshot.branch,
              pr: options.pr,
            })
            .then((checkpoint) => {
              if (stopped || navigation !== navigationVersion) return;
              mode = { kind: "since", checkpoint };
              rememberPosition();
              void compare();
            })
            .catch(error);
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
    if (text === "o" || text === "O") {
      const file = textSelection ? selectionSource : loadedFile;
      if (!file) return;
      if (patchBusy || compareBusy) {
        setStatus("Wait for the reviewed file to finish loading");
        return;
      }
      const line = fullFile
        ? scroll + 1
        : sourceLine(
            displayedLines(),
            scroll,
            file.status.startsWith("D") ? "before" : "after",
          );
      const open = (target: string) => {
        if (stopped) return;
        const editor = spawn("code", ["--goto", `${target}:${line}`], {
          cwd: options.root,
          detached: true,
          stdio: "ignore",
        });
        editor.once("error", error);
        editor.once("exit", (code, signal) => {
          if (code === 0) setStatus(`Opened ${file.path}`);
          else
            error(new Error(`VS Code launcher exited with ${signal ?? code}`));
        });
        editor.unref();
      };
      if (text === "O")
        void git
          .request("identity")
          .then(() => open(path.join(options.root, file.path)))
          .catch(error);
      else
        void git
          .request<string>("editor", {
            file,
            directory: options.directory,
            side: fullFile && beforeFile ? "before" : "after",
          })
          .then(open)
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
      if (focus !== 2) expandedDiff = false;
      render();
      return;
    }
    if (name === "tab") {
      if (expandedDiff) {
        focus = 2;
        selectFile(fileIndex + (keypress.shift ? -1 : 1));
        return;
      }
      focus = (focus + (keypress.shift ? 2 : 1)) % 3;
      if (focus !== 2) expandedDiff = false;
      render();
      return;
    }
    if (text === "[" || text === "]") {
      focus = 2;
      selectFile(fileIndex + (text === "[" ? -1 : 1));
      return;
    }
    if (text === "y" && textSelection) {
      copySelection();
      return;
    }
    if (text === "-" || text === "+" || text === "=") {
      resizeSidebar(
        text === "="
          ? undefined
          : (sidebarWidth ??
              reviewLayout(
                process.stdout.columns || 100,
                process.stdout.rows || 24,
                focus,
              ).commits.width) + (text === "-" ? -4 : 4),
      );
      return;
    }
    if (text === "n" || text === "N") {
      nextMatch(text === "N" ? -1 : 1);
      return;
    }
    if (text === " " && focus === 0) {
      toggleCommit(commitIndex || 1);
      return;
    }
    if (name === "return") {
      if (focus === 2) expandedDiff = !expandedDiff;
      else focus = Math.min(2, focus + 1);
      render();
      return;
    }
    if (name === "left" || name === "right") {
      if (focus === 2)
        horizontal = Math.max(0, horizontal + (name === "left" ? -2 : 2));
      else focus = Math.max(0, Math.min(2, focus + (name === "left" ? -1 : 1)));
      rememberPosition();
      render();
      return;
    }
    if (focus === 2 && (name === "home" || name === "end")) {
      scrollDiff(name === "home" ? -Infinity : Infinity);
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
      if (focus === 0 && state) moveCommit(direction * amount);
      else if (focus === 1) selectFile(fileIndex + direction * amount);
      else scrollDiff(direction * amount);
      render();
    }
  }
  let resolveExit: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const wasRaw = process.stdin.isRaw;
  const restoreTerminalSettings = reviewTerminalSettings(process.stdin);
  const onData = (data: Buffer) => inputEvents.feed(data);
  const resize = () => {
    scrollbarDrag = undefined;
    dividerDrag = selectingText = false;
    scroll = Math.min(scroll, scrollLimit(displayedLines().length, height()));
    previousRows = [];
    render();
  };
  const finish = () => {
    if (stopped) return;
    rememberViewed();
    stopped = true;
    remoteAbort.abort();
    agentAbort.abort();
    resolveExit();
  };
  const terminate = () => finish();
  const remoteTimer = setInterval(
    () => void discover(),
    options.remoteInterval ?? 60000,
  );
  const disarmCrashGuard = installTerminalCrashGuard({
    restoreTerminalSettings,
    getWorkerPid: () => git.pid,
  });
  try {
    readline.emitKeypressEvents(inputEvents.keys);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(
      esc +
        "?1049h" +
        esc +
        "?25l" +
        esc +
        "?1000h" +
        esc +
        "?1002h" +
        esc +
        "?1006h" +
        reviewReset +
        esc +
        "2J",
    );
    inputEvents.keys.on("keypress", onKey);
    process.stdin.on("data", onData);
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
    // Mouse reports already in flight can arrive after mouse-off. Keep the
    // terminal raw and consume them until background cleanup and input settle.
    const releaseInput = drainReviewInput(process.stdin);
    process.stdin.off("data", onData);
    inputEvents.keys.off("keypress", onKey);
    inputEvents.close();
    process.stdout.off("resize", resize);
    const stopMouse = esc + "?1000l" + esc + "?1002l" + esc + "?1006l";
    const restored = new Promise<void>((resolve, reject) => {
      process.stdout.write(stopMouse, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    try {
      watcher.close();
      await Promise.all([git.close(state?.gitDir), restored]);
    } finally {
      await releaseInput();
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      restoreTerminalSettings();
      // Reveal the shell only after we have stopped reading and restored its
      // real terminal attributes. The old prompt must never be shown raw.
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(
          "\x1b[0m" + esc + "?25h" + esc + "?1049l",
          (error) => (error ? reject(error) : resolve()),
        );
      });
      process.off("SIGINT", terminate);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", terminate);
      disarmCrashGuard();
    }
  }
}
