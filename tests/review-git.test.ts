import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, Workspace, write, read } from "./helpers.js";

function capture(w: Workspace, root = w.a) {
  return JSON.parse(
    w.command([
      process.execPath,
      "--input-type=module",
      "-e",
      `import {captureSnapshot} from ${JSON.stringify(path.join(ROOT, "dist/review-git.js"))};console.log(JSON.stringify(captureSnapshot(process.argv[1])));`,
      root,
    ]).stdout,
  );
}
function files(w: Workspace, from: string, to: string) {
  return JSON.parse(
    w.command([
      process.execPath,
      "--input-type=module",
      "-e",
      `import {changedFiles} from ${JSON.stringify(path.join(ROOT, "dist/review-git.js"))};console.log(JSON.stringify(changedFiles(process.argv[1],process.argv[2],process.argv[3])));`,
      w.a,
      from,
      to,
    ]).stdout,
  );
}
test("private review indexes capture every source layer without changing the real index, branch or worktree", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "tracked.txt"), "initial\n");
  w.git(w.a, "add", "tracked.txt");
  w.git(w.a, "commit", "-qm", "Initial source");
  const base = w.git(w.a, "rev-parse", "HEAD^{tree}");
  write(path.join(w.a, "committed.txt"), "committed\n");
  w.git(w.a, "add", "committed.txt");
  w.git(w.a, "commit", "-qm", "Feature");
  write(path.join(w.a, "tracked.txt"), "staged\n");
  w.git(w.a, "add", "tracked.txt");
  write(path.join(w.a, "tracked.txt"), "unstaged\n");
  write(path.join(w.a, "new source.ts"), "export const added = true;\n");
  const index = w.git(w.a, "rev-parse", "--git-path", "index"),
    before = fs.readFileSync(index);
  const head = w.git(w.a, "rev-parse", "HEAD");
  const snapshot = capture(w);
  assert.equal(snapshot.stable, true);
  assert.equal(snapshot.complete, true);
  assert.equal(
    w.git(w.a, "show", `${snapshot.indexTree}:tracked.txt`),
    "staged",
  );
  assert.equal(
    w.git(w.a, "show", `${snapshot.worktreeTree}:tracked.txt`),
    "unstaged",
  );
  assert.equal(
    w.git(w.a, "show", `${snapshot.worktreeTree}:new source.ts`),
    "export const added = true;",
  );
  assert.deepEqual(
    new Set(
      files(w, base, snapshot.worktreeTree).map(
        (file: { path: string }) => file.path,
      ),
    ),
    new Set(["committed.txt", "tracked.txt", "new source.ts"]),
  );
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), head);
  assert.equal(read(path.join(w.a, "tracked.txt")), "unstaged\n");
});
test("dirty submodule contents are refused instead of approving an incomplete parent tree", (t) => {
  const w = new Workspace(t);
  const nested = path.join(w.root, "nested-source");
  w.git(w.root, "init", "-q", "-b", "nested", nested);
  write(path.join(nested, "source.ts"), "original nested source\n");
  w.git(nested, "add", "source.ts");
  w.git(nested, "commit", "-qm", "Nested source");
  w.git(
    w.a,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    nested,
    "nested module",
  );
  w.git(w.a, "commit", "-qm", "Submodule");
  assert.equal(capture(w).complete, true);
  const index = w.git(w.a, "rev-parse", "--git-path", "index"),
    before = fs.readFileSync(index);
  write(path.join(w.a, "nested module/source.ts"), "uncommitted correction\n");
  assert.throws(
    () => capture(w),
    /Uncommitted submodule contents.*nested module/,
  );
  assert.deepEqual(fs.readFileSync(index), before);
  w.git(path.join(w.a, "nested module"), "checkout", "--", "source.ts");
  write(path.join(w.a, "nested module/untracked.ts"), "untracked correction\n");
  assert.throws(() => capture(w), /Uncommitted submodule contents/);
});
test("snapshots distinguish staged-only revisions even when working content is reverted, and capture later corrections", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "file"), "base\n");
  w.git(w.a, "add", "file");
  w.git(w.a, "commit", "-qm", "Base");
  write(path.join(w.a, "file"), "staged correction\n");
  w.git(w.a, "add", "file");
  write(path.join(w.a, "file"), "base\n");
  const first = capture(w);
  assert.notEqual(first.indexTree, first.worktreeTree);
  write(path.join(w.a, "file"), "working correction\n");
  const second = capture(w);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(files(w, first.worktreeTree, second.worktreeTree).length, 1);
  assert.equal(w.git(w.a, "show", `${first.worktreeTree}:file`), "base");
});
test("Git-derived review metadata handles renames, deletions, binary files and unusual paths", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "old name.txt"), "rename this file\n");
  write(path.join(w.a, "delete.txt"), "delete\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-qm", "Files");
  const base = w.git(w.a, "rev-parse", "HEAD^{tree}");
  w.git(w.a, "mv", "old name.txt", "new name.txt");
  fs.unlinkSync(path.join(w.a, "delete.txt"));
  fs.writeFileSync(
    path.join(w.a, "binary asset.bin"),
    Buffer.from([0, 1, 2, 3]),
  );
  write(path.join(w.a, "tab\tfile.txt"), "safe path\n");
  const snapshot = capture(w),
    changed = files(w, base, snapshot.worktreeTree);
  assert.equal(
    changed.find((file: { path: string }) => file.path === "new name.txt")
      .oldPath,
    "old name.txt",
  );
  assert.equal(
    changed.find((file: { path: string }) => file.path === "delete.txt").status,
    "D",
  );
  assert.equal(
    changed.find((file: { path: string }) => file.path === "binary asset.bin")
      .binary,
    true,
  );
  assert.ok(
    changed.some((file: { path: string }) => file.path === "tab\tfile.txt"),
  );
});
test("ignored content and untracked credentials are not captured, and incomplete snapshots cannot masquerade as complete", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, ".gitignore"), "ignored/\n");
  fs.mkdirSync(path.join(w.a, "ignored"));
  write(path.join(w.a, "ignored/secret"), "do not persist");
  write(path.join(w.a, ".env.local"), "secret\n");
  const snapshot = capture(w);
  assert.equal(snapshot.complete, false);
  assert.ok(snapshot.excluded.includes(".env.local"));
  const paths = w.git(
    w.a,
    "ls-tree",
    "-r",
    "--name-only",
    snapshot.worktreeTree,
  );
  assert.ok(!paths.includes(".env.local") && !paths.includes("ignored/secret"));
});
test("intent-to-add files remain unstaged in the snapshot until explicitly added", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "intent.txt"), "intent-only source\n");
  w.git(w.a, "add", "-N", "intent.txt");
  const first = capture(w);
  assert.ok(
    !w
      .git(w.a, "ls-tree", "-r", "--name-only", first.indexTree)
      .includes("intent.txt"),
  );
  assert.equal(
    w.git(w.a, "show", `${first.worktreeTree}:intent.txt`),
    "intent-only source",
  );
  w.git(w.a, "add", "intent.txt");
  const second = capture(w);
  assert.ok(
    w
      .git(w.a, "ls-tree", "-r", "--name-only", second.indexTree)
      .includes("intent.txt"),
  );
  assert.notEqual(first.fingerprint, second.fingerprint);
});
test("conflicted indexes are captured reproducibly without resolving or disturbing the user's conflict", (t) => {
  const w = new Workspace(t);
  write(path.join(w.repo, "same"), "base\n");
  w.git(w.repo, "add", "same");
  w.git(w.repo, "commit", "-qm", "Base");
  for (const root of [w.a, w.b]) w.git(root, "merge", "-q", "develop");
  write(path.join(w.a, "same"), "ours\n");
  w.git(w.a, "add", "same");
  w.git(w.a, "commit", "-qm", "Ours");
  write(path.join(w.b, "same"), "theirs\n");
  w.git(w.b, "add", "same");
  w.git(w.b, "commit", "-qm", "Theirs");
  w.command(["git", "merge", "feature/b"], { cwd: w.a, ok: false });
  const before = w.git(w.a, "ls-files", "--stage"),
    content = read(path.join(w.a, "same"));
  const snapshot = capture(w);
  assert.deepEqual(snapshot.conflicts, ["same"]);
  assert.equal(snapshot.stable, true);
  assert.equal(snapshot.stages.length, 3);
  assert.equal(w.git(w.a, "ls-files", "--stage"), before);
  assert.equal(read(path.join(w.a, "same")), content);
});
test("new feature worktrees persist a fixed creation baseline while older adopted worktrees stay explicitly unknown", (t) => {
  const w = new Workspace(t);
  const created = w
    .rl(["switch", "reviewable", "-c", "--base", "develop", "--no-fetch"])
    .stdout.trim();
  const data = w.status(created);
  assert.equal(data.startingCommit, w.git(created, "rev-parse", "HEAD"));
  assert.equal(data.reviewBaseCommit, data.startingCommit);
  w.git(w.repo, "commit", "-q", "--allow-empty", "-m", "Base advances");
  assert.equal(w.status(created).reviewBaseCommit, data.startingCommit);
  assert.equal(w.status(w.a).reviewBaseCommit, undefined);
});
