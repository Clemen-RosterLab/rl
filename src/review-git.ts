import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv, now } from "./common.js";
import { isExcludedUntrackedPath } from "./core/protected-paths.js";
import { GIT_OID_REGEX } from "./schemas/common.js";

export const OID = GIT_OID_REGEX;
const MAX_UNTRACKED_BYTES = 16 * 1024 * 1024;

const hash = (value: string): string =>
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
  beforeBlob?: string;
  afterBlob?: string;
  beforeMode?: string;
  afterMode?: string;
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
  const command =
    args[0] === "update-ref"
      ? ["-c", "core.hooksPath=/dev/null", ...args]
      : args;
  const result = spawnSync("git", ["--no-optional-locks", ...command], {
    cwd: root,
    env: { ...gitEnv(), ...(index ? { GIT_INDEX_FILE: index } : {}) },
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30000,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    throw new Error(`Review Git operation failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `Git ${args[0]} failed (${result.signal ?? result.status})`,
    );
  }
  return result.stdout;
}

export const revision = (root: string, ref: string): string =>
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
  ) {
    throw new Error("Invalid review source path");
  }
}

function captureSnapshotPass(
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

  const emptyTree = reviewGit(root, ["mktree"], "").trim();
  const headTree = head
    ? reviewGit(root, ["rev-parse", `${head}^{tree}`]).trim()
    : emptyTree;

  let branch = "(detached)";
  try {
    branch = reviewGit(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).trim();
  } catch {
    // Detached HEAD.
  }

  const rawIndex = reviewGit(root, ["ls-files", "--stage", "-z"]);
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
      if (!match) {
        throw new Error("Cannot parse the worktree index");
      }
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
      const fields = status[i].split(" ");
      if (fields[0] !== "1" && fields[0] !== "2") continue;
      const submodule = fields[2];
      if (
        submodule?.startsWith("S") &&
        (submodule[2] === "M" || submodule[3] === "U")
      ) {
        const subPath = fields.slice(fields[0] === "2" ? 9 : 8).join(" ");
        throw new Error(
          `Uncommitted submodule contents cannot be captured reproducibly: ${subPath}. Review and commit those nested changes before creating a parent review snapshot.`,
        );
      }
      if (fields[0] === "2") {
        i++; // The next NUL record is the original rename path.
      }
    }
  }

  const stageTrees: string[] = [];
  for (let stage = 0; stage <= 3; stage++) {
    const entries = records.filter(
      (record) =>
        record.stage === stage &&
        (stage !== 0 ||
          headPaths.has(record.path) ||
          stagedPaths.has(record.path)),
    );
    if (entries.length === 0) {
      stageTrees.push(emptyTree);
      continue;
    }
    const stageIndex = path.join(temporary, `index-${stage}`);
    reviewGit(root, ["read-tree", "--empty"], undefined, stageIndex);
    reviewGit(
      root,
      ["update-index", "-z", "--index-info"],
      entries
        .map((record) => `${record.mode} ${record.oid}\t${record.path}\0`)
        .join(""),
      stageIndex,
    );
    stageTrees.push(
      reviewGit(root, ["write-tree"], undefined, stageIndex).trim(),
    );
  }

  const excluded: string[] = [];
  const untracked: string[] = [];
  const rawUntracked = reviewGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);

  for (const file of rawUntracked) {
    sourcePath(file);
    const stat = fs.lstatSync(path.join(root, file), {
      throwIfNoEntry: false,
    });
    if (!stat) {
      // Transient file vanished during capture; stability pass will re-verify.
      continue;
    }
    if (
      isExcludedUntrackedPath(file) ||
      stat.size > MAX_UNTRACKED_BYTES ||
      (!stat.isFile() && !stat.isSymbolicLink())
    ) {
      excluded.push(file);
    } else {
      untracked.push(file);
    }
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
    (file) =>
      !omitted.has(file) &&
      (headPaths.has(file) ||
        fs.lstatSync(path.join(root, file), { throwIfNoEntry: false }) !==
          undefined),
  );

  const workingIndex = path.join(temporary, "working-index");
  reviewGit(root, ["read-tree", headTree], undefined, workingIndex);
  for (let start = 0; start < paths.length; start += 100) {
    const chunk = paths.slice(start, start + 100);
    chunk.forEach(sourcePath);
    reviewGit(
      root,
      ["--literal-pathspecs", "add", "-A", "-f", "--", ...chunk],
      undefined,
      workingIndex,
    );
  }

  const worktreeTree = reviewGit(
    root,
    ["write-tree"],
    undefined,
    workingIndex,
  ).trim();
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
    complete: excluded.length === 0,
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
    let previous = captureSnapshotPass(root, temporary);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = captureSnapshotPass(root, temporary);
      const stable =
        current.fingerprint === previous.fingerprint &&
        current.head === previous.head &&
        current.branch === previous.branch;
      if (stable) {
        return { ...current, id: randomUUID(), at: now(), stable };
      }
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
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, oid]) => `040000 tree ${oid}\t${name}\n`)
      .join(""),
  ).trim();

  // Private refs retain the trees without adding commits to the user's branch.
  const updates = [`update refs/rl/reviews/${key}/${snapshot.id} ${tree}`];
  if (snapshot.head) {
    updates.push(
      `update refs/rl/review-heads/${key}/${snapshot.id} ${snapshot.head}`,
    );
  }
  if (snapshot.baseline) {
    updates.push(
      `update refs/rl/review-snapshot-bases/${key}/${snapshot.id} ${snapshot.baseline}`,
    );
  }
  reviewGit(root, ["update-ref", "--stdin"], `${updates.join("\n")}\n`);
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
    if (!match) {
      throw new Error("Cannot parse Git diff statistics");
    }
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
    "--raw",
    "--no-abbrev",
    "-z",
    from,
    to,
    "--",
  ]).split("\0");

  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const raw = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z][0-9]*)$/.exec(
      fields[i++],
    );
    if (!raw) {
      throw new Error("Cannot parse Git change identities");
    }
    const status = raw[5];
    const first = fields[i++];
    const renamed = /^[RC]/.test(status);
    const file = renamed ? fields[i++] : first;
    const stat = stats.get(file) ?? { additions: null, deletions: null };
    files.push({
      id: `f-${hash(`${file}\0${renamed ? first : ""}`).slice(0, 16)}`,
      path: file,
      ...(renamed ? { oldPath: first } : {}),
      status,
      beforeBlob: raw[3],
      afterBlob: raw[4],
      beforeMode: raw[1],
      afterMode: raw[2],
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
  context = 3,
): string[] {
  return [
    "--literal-pathspecs",
    "diff",
    `--unified=${Math.max(0, Math.min(1000, context))}`,
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
        [file.oldPath, file.path].filter((value): value is string =>
          Boolean(value),
        ),
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
