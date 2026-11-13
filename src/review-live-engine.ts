import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  canonical,
  writeJson,
  readJson,
  object,
  gitEnv,
  inside,
} from "./common.js";
import {
  captureSnapshot,
  changedFiles,
  diffArgs,
  reviewGit,
  revision,
  OID,
  type Snapshot,
  type ChangedFile,
} from "./review-git.js";

export const REVIEW_HISTORY_LIMIT = 10;

export interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  files: number;
  additions: number;
  deletions: number;
}
export interface LiveState {
  snapshot: Snapshot;
  commits: Commit[];
  workingFiles?: ReviewFile[];
  gitDir: string;
  commonDir: string;
  directories: string[];
  signature: string;
}
export interface Comparison {
  label: string;
  scopes: { name: string; from: string; to: string; commit?: string }[];
  target: string;
}
export interface ReviewFile extends ChangedFile {
  layer: string;
  from: string;
  to: string;
  key: string;
}
export type Mode =
  | { kind: "working" }
  | { kind: "commit"; sha: string }
  | { kind: "commits"; commits: Commit[] }
  | { kind: "range"; from: string; to: string }
  | { kind: "branch"; base: string; head?: string }
  | { kind: "since"; checkpoint: Checkpoint };
export interface Checkpoint {
  branch: string;
  head: string;
  tree: string;
  index: string;
  label: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
]);
export function reviewRoot(cwd: string, repo: string): string {
  const root = canonical(
    reviewGit(cwd, ["rev-parse", "--show-toplevel"]).trim(),
  );
  const common = (p: string) =>
    canonical(
      reviewGit(p, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).trim(),
    );
  if (common(root) !== common(repo))
    throw new Error(
      "Current directory does not belong to the selected RL repository; select a worktree explicitly",
    );
  return root;
}
export class LiveRepository {
  private last?: LiveState;
  private commits = new Map<string, Commit>();
  private historyCache = new Map<string, Commit[]>();
  private readonly identity: string;
  private readonly freezeRef: string;
  private pinned = new Set<string>();
  constructor(
    readonly root: string,
    repository = root,
    private readonly options: {
      temporaryRoot?: string;
      freezeId?: string;
    } = {},
  ) {
    this.freezeRef = `refs/rl/live-freeze/${options.freezeId ?? randomUUID()}`;
    reviewRoot(root, repository);
    this.identity = canonical(
      reviewGit(root, ["rev-parse", "--absolute-git-dir"]).trim(),
    );
  }
  assertIdentity(): void {
    if (
      canonical(
        reviewGit(this.root, ["rev-parse", "--absolute-git-dir"]).trim(),
      ) !== this.identity ||
      canonical(
        reviewGit(this.root, ["rev-parse", "--show-toplevel"]).trim(),
      ) !== canonical(this.root)
    )
      throw new Error(
        "Worktree identity changed or was removed; reopen review explicitly",
      );
  }
  freeze(snapshot: Snapshot, target: string, revisions: string[] = []): void {
    const trees = new Set([
      snapshot.headTree,
      snapshot.indexTree,
      snapshot.worktreeTree,
    ]);
    const pin = (name: string, oid: string) => {
      const ref = `${this.freezeRef}/${name}`;
      reviewGit(this.root, ["update-ref", ref, oid]);
      this.pinned.add(ref);
    };
    for (const oid of new Set(
      [snapshot.head, target, ...revisions].filter(Boolean),
    )) {
      if (!OID.test(oid)) throw new Error("Invalid frozen revision identity");
      trees.add(reviewGit(this.root, ["rev-parse", `${oid}^{tree}`]).trim());
      // Keep commits as well as trees: rewritten history can otherwise remove
      // the parent identities used by a frozen commit or arbitrary range.
      if (reviewGit(this.root, ["cat-file", "-t", oid]).trim() === "commit")
        pin(`commit-${oid}`, oid);
    }
    const tree = reviewGit(
      this.root,
      ["mktree"],
      [...trees].map((oid, i) => `040000 tree ${oid}\ttree${i}\n`).join(""),
    ).trim();
    pin("trees", tree);
  }
  releaseFreeze(): void {
    for (const ref of this.pinned)
      reviewGit(this.root, ["update-ref", "-d", ref]);
    this.pinned.clear();
  }
  refresh(force = false): LiveState {
    const gitDir = reviewGit(this.root, [
      "rev-parse",
      "--absolute-git-dir",
    ]).trim();
    const commonDir = reviewGit(this.root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim();
    if (
      canonical(gitDir) !== this.identity ||
      canonical(
        reviewGit(this.root, ["rev-parse", "--show-toplevel"]).trim(),
      ) !== canonical(this.root)
    )
      throw new Error(
        "Worktree identity changed or was removed; reopen review explicitly",
      );
    const status = reviewGit(this.root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    // Stat only dirty/untracked paths; status detects clean-to-dirty transitions.
    const stamps: string[] = [];
    const records = status.split("\0");
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r) continue;
      const file = r.slice(3);
      try {
        const s = fs.lstatSync(path.join(this.root, file));
        stamps.push(`${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
      } catch {
        stamps.push(file);
      }
      if (/[RC]/.test(r.slice(0, 2))) i++;
    }
    const metadata = ["HEAD", "index", "packed-refs"].flatMap((name) =>
      [gitDir, commonDir].map((dir) => {
        try {
          const s = fs.statSync(path.join(dir, name));
          return `${dir}/${name}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
        } catch {
          return "";
        }
      }),
    );
    const head = (() => {
      try {
        return revision(this.root, "HEAD");
      } catch {
        return "";
      }
    })();
    let branch = "(detached)";
    try {
      branch = reviewGit(this.root, ["symbolic-ref", "--quiet", "HEAD"]).trim();
    } catch {
      /* Detached HEAD. */
    }
    const signature = hash(
      JSON.stringify([
        head,
        status,
        stamps,
        metadata,
        branch,
        reviewGit(this.root, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/heads",
          "refs/remotes",
        ]),
      ]),
    );
    if (!force && this.last?.signature === signature) return this.last;
    const snapshot = captureSnapshot(this.root, this.options.temporaryRoot);
    const commits = snapshot.head ? this.history(snapshot.head) : [];
    const directories = new Set([this.root]);
    const paths = reviewGit(this.root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]).split("\0");
    for (const file of paths) {
      const parts = file.split("/");
      parts.pop();
      let dir = this.root;
      for (const part of parts) {
        if (ignored.has(part)) break;
        dir = path.join(dir, part);
        directories.add(dir);
      }
    }
    const state: LiveState = {
      snapshot,
      commits,
      gitDir,
      commonDir,
      directories: [...directories],
      signature,
    };
    state.workingFiles = this.files(
      this.comparison({ kind: "working" }, state),
      state,
    );
    return (this.last = state);
  }
  history(head: string, base?: string): Commit[] {
    const headOid = revision(this.root, head),
      baseOid = base ? revision(this.root, base) : undefined;
    const key = `${headOid}:${baseOid ?? ""}`;
    const cached = this.historyCache.get(key);
    if (cached) return cached;
    // Read the recent timeline and all of its statistics in a single process.
    // NUL-delimited records preserve filenames containing tabs or newlines.
    const fields = reviewGit(this.root, [
      "log",
      `-${REVIEW_HISTORY_LIMIT}`,
      "--numstat",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      "--find-renames",
      "--diff-merges=first-parent",
      "--root",
      "--format=%x00%H%x00%P%x00%s%x00%an%x00%aI%x00",
      headOid,
      ...(baseOid
        ? ["^" + reviewGit(this.root, ["merge-base", baseOid, headOid]).trim()]
        : []),
      "--",
    ]).split("\0");
    const commits: Commit[] = [];
    let current: Commit | undefined;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i].replace(/^\n/, "");
      if (!field) continue;
      if (OID.test(field)) {
        const parents = fields[++i],
          subject = fields[++i],
          author = fields[++i],
          date = fields[++i];
        if (date === undefined)
          throw new Error("Cannot parse Git commit history");
        current = {
          sha: field,
          parents: parents.split(" ").filter(Boolean),
          subject,
          author,
          date,
          files: 0,
          additions: 0,
          deletions: 0,
        };
        commits.push(current);
        continue;
      }
      const stat = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
      if (!stat || !current)
        throw new Error("Cannot parse Git commit statistics");
      if (!stat[3]) i += 2; // A rename has separate old/new NUL path records.
      current.files++;
      current.additions += stat[1] === "-" ? 0 : Number(stat[1]);
      current.deletions += stat[2] === "-" ? 0 : Number(stat[2]);
    }
    const timeline = commits.map((commit) => {
      const existing = this.commits.get(commit.sha);
      if (existing) return existing;
      this.commits.set(commit.sha, commit);
      return commit;
    });
    this.historyCache.set(key, timeline);
    if (this.historyCache.size > 8)
      this.historyCache.delete(this.historyCache.keys().next().value!);
    return timeline;
  }
  emptyTree(): string {
    return reviewGit(this.root, ["mktree"], "").trim();
  }
  private commitComparison(ref: string): Comparison {
    const sha = revision(this.root, ref);
    const parents =
      this.commits.get(sha)?.parents ??
      reviewGit(this.root, ["rev-list", "--parents", "-n", "1", sha])
        .trim()
        .split(" ")
        .slice(1);
    const from = parents[0] ?? this.emptyTree();
    return {
      label: `${parents.length > 1 ? "Merge: first parent " : parents.length ? "" : "Initial commit: empty tree "}${from.slice(0, 8)} → ${sha.slice(0, 8)}`,
      target: sha,
      scopes: [{ name: "commit", from, to: sha }],
    };
  }
  comparison(mode: Mode, state: LiveState): Comparison {
    const s = state.snapshot;
    switch (mode.kind) {
      case "working":
        return {
          label: `HEAD ${s.head.slice(0, 8) || "(unborn)"} → working tree · separate index / source layers`,
          target: s.worktreeTree,
          scopes: [
            { name: "staged", from: s.headTree, to: s.indexTree },
            { name: "unstaged", from: s.indexTree, to: s.worktreeTree },
          ],
        };
      case "commit":
        return this.commitComparison(mode.sha);
      case "commits": {
        const scopes = mode.commits.flatMap(({ sha }) =>
          this.commitComparison(sha).scopes.map((scope) => ({
            ...scope,
            commit: scope.to,
          })),
        );
        if (!scopes.length) throw new Error("Select at least one commit");
        return {
          label: `${scopes.length} selected ${scopes.length === 1 ? "commit" : "commits"} · files grouped by commit`,
          target: scopes[0].to,
          scopes,
        };
      }
      case "range": {
        const from = revision(this.root, mode.from),
          to = revision(this.root, mode.to);
        return {
          label: `Range ${mode.from} (${from.slice(0, 8)}) → ${mode.to} (${to.slice(0, 8)})`,
          target: to,
          scopes: [{ name: "range", from, to }],
        };
      }
      case "branch": {
        if (!s.head) throw new Error("Branch comparison requires a commit");
        const target = revision(this.root, mode.head ?? s.head),
          base = revision(this.root, mode.base);
        const from = reviewGit(this.root, ["merge-base", base, target]).trim();
        return {
          label: `Merge-base with ${mode.base} (${from.slice(0, 8)}) → ${target.slice(0, 8)} · committed branch`,
          target,
          scopes: [{ name: "branch", from, to: target }],
        };
      }
      case "since": {
        const p = mode.checkpoint;
        if (p.branch !== s.branch)
          throw new Error("Checkpoint belongs to a different branch");
        for (const oid of [p.tree, p.index])
          if (!OID.test(oid)) throw new Error("Invalid checkpoint revision");
        try {
          reviewGit(this.root, ["cat-file", "-e", p.tree]);
          reviewGit(this.root, ["cat-file", "-e", p.index]);
        } catch {
          throw new Error(
            "Checkpoint objects are missing; mark a new checkpoint explicitly",
          );
        }
        let rewritten = false;
        if (p.head && s.head)
          try {
            reviewGit(this.root, [
              "merge-base",
              "--is-ancestor",
              p.head,
              s.head,
            ]);
          } catch {
            rewritten = true;
          }
        return {
          label: `Reviewed ${p.label} → current source${rewritten ? " · history rewritten; exact saved trees retained" : ""}`,
          target: s.worktreeTree,
          scopes: [
            { name: "source since review", from: p.tree, to: s.worktreeTree },
            { name: "index since review", from: p.index, to: s.indexTree },
          ],
        };
      }
    }
  }
  files(comparison: Comparison, state: LiveState): ReviewFile[] {
    const [staged, unstaged] = comparison.scopes;
    if (
      state.workingFiles &&
      comparison.scopes.length === 2 &&
      staged.name === "staged" &&
      unstaged.name === "unstaged" &&
      staged.from === state.snapshot.headTree &&
      staged.to === state.snapshot.indexTree &&
      unstaged.from === state.snapshot.indexTree &&
      unstaged.to === state.snapshot.worktreeTree
    )
      return state.workingFiles;
    return comparison.scopes.flatMap((scope) =>
      changedFiles(this.root, scope.from, scope.to).map((file) => ({
        ...file,
        layer: scope.commit
          ? `commit ${scope.commit.slice(0, 8)}`
          : scope.name === "unstaged" &&
              state.snapshot.untracked.includes(file.path)
            ? "untracked"
            : scope.name,
        from: scope.from,
        to: scope.to,
        key: `${scope.commit ?? scope.name}\0${file.path}`,
      })),
    );
  }
  patch(file: ReviewFile, context = 3): string {
    const result = spawnSync(
      "git",
      [
        "--no-optional-locks",
        "--no-pager",
        "-c",
        "color.ui=false",
        ...diffArgs(
          file.from,
          file.to,
          [
            ...new Set(
              [file.oldPath, file.path].filter((p): p is string => !!p),
            ),
          ],
          context,
        ),
      ],
      {
        cwd: this.root,
        env: gitEnv(),
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30000,
        killSignal: "SIGKILL",
      },
    );
    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code === "ENOBUFS"
    )
      return (
        result.stdout +
        "\n[Diff truncated at 8 MiB; open the file with o for further inspection.]"
      );
    if (result.error || result.status !== 0)
      throw new Error(
        result.error?.message ||
          result.stderr ||
          `Git diff failed (${result.signal ?? result.status})`,
      );
    return result.stdout;
  }
  private blob(file: ReviewFile, side: "before" | "after"): string {
    const supplied = side === "before" ? file.beforeBlob : file.afterBlob;
    if (supplied) {
      if (!OID.test(supplied))
        throw new Error("Invalid reviewed file identity");
      return supplied;
    }
    const tree = side === "before" ? file.from : file.to;
    const name = side === "before" ? (file.oldPath ?? file.path) : file.path;
    try {
      return reviewGit(this.root, [
        "rev-parse",
        "--verify",
        `${tree}:${name}`,
      ]).trim();
    } catch {
      return "0".repeat(40);
    }
  }
  content(
    file: ReviewFile,
    side: "before" | "after" = "after",
    limit = 8 * 1024 * 1024,
  ): { text: string; oid: string; binary: boolean; truncated: boolean } {
    const oid = this.blob(file, side);
    if (/^0+$/.test(oid))
      return { text: "", oid, binary: false, truncated: false };
    if (!OID.test(oid)) throw new Error("Invalid reviewed file identity");
    const size = Number(reviewGit(this.root, ["cat-file", "-s", oid]).trim());
    if (size > limit)
      return {
        text: `[File exceeds ${limit} bytes; use a smaller review scope.]`,
        oid,
        binary: false,
        truncated: true,
      };
    const text = reviewGit(this.root, ["cat-file", "blob", oid]);
    const binary = text.includes("\0");
    return {
      text: binary ? `[Binary file: ${size} bytes]` : text,
      oid,
      binary,
      truncated: false,
    };
  }
  editorFile(
    file: ReviewFile,
    directory: string,
    side: "before" | "after" = "after",
  ): string {
    let oid = this.blob(file, side);
    if (/^0+$/.test(oid)) oid = this.blob(file, "before");
    if (/^0+$/.test(oid))
      throw new Error(
        "The reviewed file does not exist on this side of the comparison",
      );
    if (file.binary)
      throw new Error(
        "This reviewed file cannot be opened as text; use O to open the current worktree file",
      );
    const cache = path.resolve(directory, "live-review", "editor", oid);
    const target = path.join(cache, path.basename(file.path));
    if (
      !inside(target, path.resolve(directory)) ||
      canonical(target) !== target
    )
      throw new Error("Reviewed file cache must not traverse symlinks");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(target)) {
      const temporary = path.join(cache, `.tmp-${randomUUID()}`);
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        // Stream exact bytes into the cache: huge files do not consume terminal
        // memory, and non-UTF-8 source is not rewritten through string decoding.
        const result = spawnSync(
          "git",
          ["--no-optional-locks", "cat-file", "blob", oid],
          {
            cwd: this.root,
            env: gitEnv(),
            stdio: ["ignore", descriptor, "pipe"],
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            timeout: 30000,
            killSignal: "SIGKILL",
          },
        );
        if (result.error || result.status !== 0)
          throw new Error(
            result.error?.message ||
              result.stderr ||
              "Cannot materialize the reviewed file",
          );
        fs.chmodSync(temporary, 0o444);
        fs.renameSync(temporary, target);
      } finally {
        fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
      }
    }
    return target;
  }
  references(): { label: string; ref: string; sha: string }[] {
    return reviewGit(this.root, [
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname)",
      "refs/heads",
      "refs/remotes",
    ])
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(0, 300)
      .map((line) => {
        const [ref, sha] = line.split("\0");
        return { label: ref, ref, sha };
      });
  }
}
export function checkpointKey(
  root: string,
  branch: string,
  pr?: number,
): string {
  return hash(`${canonical(root)}\0${branch}\0${pr ?? "local"}`);
}
export function checkpointFile(directory: string, key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid checkpoint key");
  const file = path.join(directory, "live-review", `${key}.json`);
  if (canonical(file) !== path.resolve(file))
    throw new Error("Checkpoint metadata must not traverse symlinks");
  return file;
}
export function loadCheckpoint(directory: string, key: string): Checkpoint {
  const file = checkpointFile(directory, key);
  if (!fs.existsSync(file))
    throw new Error(
      "No checkpoint for this worktree and branch/PR. Press m to mark the inspected revision reviewed.",
    );
  const data = readJson(file);
  if (
    !object(data) ||
    ![data.tree, data.index].every(
      (v) => typeof v === "string" && OID.test(v),
    ) ||
    typeof data.branch !== "string" ||
    typeof data.head !== "string" ||
    typeof data.label !== "string"
  )
    throw new Error(
      "Invalid review checkpoint; mark a new checkpoint explicitly",
    );
  return data as unknown as Checkpoint;
}
export function saveCheckpoint(
  root: string,
  directory: string,
  key: string,
  point: Checkpoint,
): void {
  const file = checkpointFile(directory, key);
  if (![point.tree, point.index].every((v) => OID.test(v)))
    throw new Error("Invalid checkpoint trees");
  point = {
    ...point,
    tree: reviewGit(root, ["rev-parse", `${point.tree}^{tree}`]).trim(),
    index: reviewGit(root, ["rev-parse", `${point.index}^{tree}`]).trim(),
  };
  // Retain both layers across Git GC, without writing the user's index or branch.
  const tree = reviewGit(
    root,
    ["mktree"],
    `040000 tree ${point.index}\tindex\n040000 tree ${point.tree}\tsource\n`,
  ).trim();
  reviewGit(root, ["update-ref", `refs/rl/live-review/${key}/trees`, tree]);
  if (point.head)
    reviewGit(root, [
      "update-ref",
      `refs/rl/live-review/${key}/head`,
      point.head,
    ]);
  writeJson(file, point);
}
