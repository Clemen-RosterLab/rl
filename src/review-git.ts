import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gitEnv, now } from "./common.js";

export const OID = /^[a-f0-9]{40,64}$/;
const MAX_UNTRACKED = 16 * 1024 * 1024;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface Snapshot {
  baseline?: string;
  id: string;
  at: string;
  branch: string;
  head: string;
  headTree: string;
  indexTree: string;
  worktreeTree: string;
  stages: string[];
  indexHash: string;
  fingerprint: string;
  stable: boolean;
  complete: boolean;
  untracked: string[];
  excluded: string[];
  conflicts: string[];
}
export interface ChangedFile {
  id: string;
  path: string;
  oldPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}
export interface Hunk {
  id: string;
  fileId: string;
  header: string;
  patch: string;
}

/** A private index is the only index this module ever writes. */
export function reviewGit(
  root: string,
  args: string[],
  input?: string,
  index?: string,
): string {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    env: { ...gitEnv(), ...(index ? { GIT_INDEX_FILE: index } : {}) },
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
  });
  if (result.error)
    throw new Error(`Review Git operation failed: ${result.error.message}`);
  if (result.status)
    throw new Error(
      result.stderr.trim() || `Git ${args[0]} failed (${result.status})`,
    );
  return result.stdout;
}
export const revision = (root: string, ref: string) =>
  reviewGit(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]).trim();
export function sourcePath(value: string): void {
  if (
    !value ||
    path.isAbsolute(value) ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid review source path");
}
function excludedUntracked(file: string): boolean {
  return file
    .split("/")
    .some(
      (part) =>
        /^(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets(?:\.|$))/i.test(part) ||
        [
          ".git",
          ".codex",
          ".claude",
          ".agents",
          ".ssh",
          ".aws",
          ".azure",
          ".npmrc",
          ".netrc",
          "node_modules",
          ".venv",
          "venv",
        ].includes(part),
    );
}
function indexEntries(root: string): string {
  return reviewGit(root, ["ls-files", "--stage", "-z"]);
}
function pass(
  root: string,
  temporary: string,
): Omit<Snapshot, "id" | "at" | "stable"> {
  let head = "";
  try {
    head = revision(root, "HEAD");
  } catch {
    // Only an unborn branch may substitute the empty tree.
    reviewGit(root, ["symbolic-ref", "--quiet", "HEAD"]);
  }
  const headTree = head
    ? reviewGit(root, ["rev-parse", `${head}^{tree}`]).trim()
    : reviewGit(root, ["mktree"], "").trim();
  let branch = "(detached)";
  try {
    branch = reviewGit(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).trim();
  } catch {
    /* Detached HEAD. */
  }
  const rawIndex = indexEntries(root);
  const headPaths = new Set(
    reviewGit(root, ["ls-tree", "-r", "--name-only", "-z", headTree])
      .split("\0")
      .filter(Boolean),
  );
  const stagedPaths = new Set(
    reviewGit(root, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      headTree,
      "--",
    ])
      .split("\0")
      .filter(Boolean),
  );
  const records = rawIndex
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Cannot parse the worktree index");
      sourcePath(match[4]);
      return {
        mode: match[1],
        oid: match[2],
        stage: Number(match[3]),
        path: match[4],
      };
    });
  if (records.some((record) => record.mode === "160000")) {
    const status = reviewGit(root, [
      "status",
      "--porcelain=v2",
      "--ignore-submodules=none",
      "--untracked-files=normal",
      "-z",
    ]).split("\0");
    for (let i = 0; i < status.length; i++) {
      const entry = status[i],
        fields = entry.split(" ");
      if (!["1", "2"].includes(fields[0])) continue;
      const submodule = fields[2];
      if (
        submodule?.startsWith("S") &&
        (submodule[2] === "M" || submodule[3] === "U")
      )
        throw new Error(
          `Uncommitted submodule contents cannot be captured reproducibly: ${fields.slice(fields[0] === "2" ? 9 : 8).join(" ")}. Review and commit those nested changes before creating a parent review snapshot.`,
        );
      if (fields[0] === "2") i++; // The next NUL record is the original rename path.
    }
  }
  const stageTrees: string[] = [];
  for (let stage = 0; stage <= 3; stage++) {
    const index = path.join(temporary, `index-${stage}`);
    reviewGit(root, ["read-tree", "--empty"], undefined, index);
    const entries = records.filter(
      (record) =>
        record.stage === stage &&
        (stage !== 0 ||
          headPaths.has(record.path) ||
          stagedPaths.has(record.path)),
    );
    if (entries.length)
      reviewGit(
        root,
        ["update-index", "-z", "--index-info"],
        entries
          .map((record) => `${record.mode} ${record.oid}\t${record.path}\0`)
          .join(""),
        index,
      );
    stageTrees.push(reviewGit(root, ["write-tree"], undefined, index).trim());
  }
  const excluded: string[] = [],
    untracked: string[] = [];
  for (const file of reviewGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean)) {
    sourcePath(file);
    const stat = fs.lstatSync(path.join(root, file));
    if (
      excludedUntracked(file) ||
      stat.size > MAX_UNTRACKED ||
      (!stat.isFile() && !stat.isSymbolicLink())
    )
      excluded.push(file);
    else untracked.push(file);
  }
  const changed = reviewGit(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-only",
    "-z",
    headTree,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  const omitted = new Set(excluded);
  const paths = [...new Set([...changed, ...untracked])].filter(
    (file) => !omitted.has(file),
  );
  const index = path.join(temporary, "working-index");
  reviewGit(root, ["read-tree", headTree], undefined, index);
  for (let start = 0; start < paths.length; start += 100) {
    const chunk = paths.slice(start, start + 100);
    chunk.forEach(sourcePath);
    reviewGit(
      root,
      ["--literal-pathspecs", "add", "-A", "-f", "--", ...chunk],
      undefined,
      index,
    );
  }
  const worktreeTree = reviewGit(root, ["write-tree"], undefined, index).trim();
  const conflicts = [
    ...new Set(
      records.filter((record) => record.stage > 0).map((record) => record.path),
    ),
  ];
  const indexHash = hash(rawIndex);
  return {
    branch,
    head,
    headTree,
    indexTree: stageTrees[0],
    stages: stageTrees.slice(1),
    indexHash,
    worktreeTree,
    fingerprint: hash(
      JSON.stringify({
        indexHash,
        indexTree: stageTrees[0],
        worktreeTree,
        excluded,
      }),
    ),
    complete: !excluded.length,
    excluded,
    untracked,
    conflicts,
  };
}
export function captureSnapshot(
  root: string,
  temporaryRoot = os.tmpdir(),
): Snapshot {
  const temporary = fs.mkdtempSync(
    path.join(temporaryRoot, "rl-review-index-"),
  );
  try {
    let previous = pass(root, temporary);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = pass(root, temporary);
      const stable =
        current.fingerprint === previous.fingerprint &&
        current.head === previous.head &&
        current.branch === previous.branch;
      if (stable) return { ...current, id: randomUUID(), at: now(), stable };
      previous = current;
    }
    return { ...previous, id: randomUUID(), at: now(), stable: false };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
export function pinSnapshot(
  root: string,
  key: string,
  snapshot: Snapshot,
): string {
  const trees = {
    head: snapshot.headTree,
    index: snapshot.indexTree,
    worktree: snapshot.worktreeTree,
    stage1: snapshot.stages[0],
    stage2: snapshot.stages[1],
    stage3: snapshot.stages[2],
  };
  const tree = reviewGit(
    root,
    ["mktree"],
    Object.entries(trees)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, oid]) => `040000 tree ${oid}\t${name}\n`)
      .join(""),
  ).trim();
  // A private ref retains the trees without adding commits to the user's branch.
  reviewGit(root, [
    "update-ref",
    `refs/rl/reviews/${key}/${snapshot.id}`,
    tree,
  ]);
  reviewGit(root, [
    "update-ref",
    `refs/rl/review-heads/${key}/${snapshot.id}`,
    snapshot.head,
  ]);
  if (snapshot.baseline)
    reviewGit(root, [
      "update-ref",
      `refs/rl/review-snapshot-bases/${key}/${snapshot.id}`,
      snapshot.baseline,
    ]);
  return tree;
}
export function changedFiles(
  root: string,
  from: string,
  to: string,
): ChangedFile[] {
  const stats = new Map<
    string,
    { additions: number | null; deletions: number | null }
  >();
  const records = reviewGit(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--numstat",
    "-z",
    from,
    to,
    "--",
  ]).split("\0");
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(records[i]);
    if (!match) throw new Error("Cannot parse Git diff statistics");
    let file = match[3];
    if (!file) {
      i++;
      file = records[++i];
    }
    stats.set(file, {
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    });
  }
  const fields = reviewGit(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--name-status",
    "-z",
    from,
    to,
    "--",
  ]).split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++],
      first = fields[i++];
    const renamed = /^[RC]/.test(status),
      file = renamed ? fields[i++] : first;
    const stat = stats.get(file) ?? { additions: null, deletions: null };
    files.push({
      id: `f-${hash(file + "\0" + (renamed ? first : "")).slice(0, 16)}`,
      path: file,
      ...(renamed ? { oldPath: first } : {}),
      status,
      ...stat,
      binary: stat.additions === null,
    });
  }
  return files;
}
export function diffArgs(
  from: string,
  to: string,
  paths: string[] = [],
): string[] {
  return [
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    from,
    to,
    "--",
    ...paths,
  ];
}
export function filePatch(
  root: string,
  from: string,
  to: string,
  file: ChangedFile,
): { patch: string; hunks: Hunk[] } {
  const patch = reviewGit(
    root,
    diffArgs(from, to, [
      ...new Set(
        [file.oldPath, file.path].filter((value): value is string => !!value),
      ),
    ]),
  );
  const sections = patch.split(/(?=^@@ )/m);
  const prefix = sections.shift() ?? "";
  const hunks = sections
    .filter((section) => section.startsWith("@@ "))
    .map((section) => ({
      id: `h-${hash(file.id + section).slice(0, 16)}`,
      fileId: file.id,
      header: section.split("\n")[0],
      patch: prefix + section,
    }));
  return { patch, hunks };
}
