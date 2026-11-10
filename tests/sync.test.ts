import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, read, readJson, write } from "./helpers.js";

function fixture(t: TestContext) {
  const w = new Workspace(t);
  const remote = path.join(w.root, "origin.git");
  w.command(["git", "init", "--bare", "-q", remote]);
  w.git(w.repo, "remote", "add", "origin", remote);
  w.git(w.repo, "push", "-qu", "origin", "develop");
  const writer = path.join(w.root, "remote writer");
  w.command(["git", "clone", "-q", "-b", "develop", remote, writer]);
  const commit = (root: string, file: string, content = file) => {
    write(path.join(root, file), content);
    w.git(root, "add", file);
    w.git(root, "commit", "-qm", file);
    return w.git(root, "rev-parse", "HEAD");
  };
  const base = (root: string, value: string) => {
    const file = path.join(w.status(root).stateDirectory, "instance.json");
    const data = readJson(file);
    data.baseBranch = value;
    write(file, JSON.stringify(data));
  };
  const sync = (args: string[] = [], ok = true) =>
    JSON.parse(w.rl(["sync", ...args, "--json"], { cwd: w.repo, ok }).stdout);
  return { w, remote, writer, commit, base, sync };
}

test("sync fetches once and merges each saved base locally, preferring refreshed origin over stale local bases", (t) => {
  const { w, remote, writer, commit, base, sync } = fixture(t);
  base(w.a, "develop");
  const aHead = commit(w.a, "feature-a.txt");
  w.git(writer, "checkout", "-qb", "release");
  const release = commit(writer, "release.txt");
  w.git(writer, "push", "-qu", "origin", "release");
  base(w.b, "origin/release");
  w.git(writer, "checkout", "-q", "develop");
  const develop = commit(writer, "latest.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  const mainBefore = w.git(w.repo, "rev-parse", "HEAD");
  const report = sync();
  assert.deepEqual(
    report.fetches.map((row: { status: string }) => row.status),
    ["fetched"],
  );
  assert.deepEqual(
    report.results.map((row: { status: string }) => row.status),
    ["updated", "updated"],
  );
  assert.equal(report.results[0].base, "origin/develop");
  assert.equal(report.results[1].base, "origin/release");
  assert.equal(w.git(w.a, "merge-base", "HEAD", develop), develop);
  assert.equal(w.git(w.a, "merge-base", "HEAD", aHead), aHead);
  assert.equal(w.git(w.b, "rev-parse", "HEAD"), release);
  assert.equal(w.git(w.repo, "rev-parse", "HEAD"), mainBefore);
  assert.equal(w.git(remote, "rev-parse", "refs/heads/develop"), develop);
  assert.equal(
    w.git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/feature"),
    "",
  );
  const unchanged = sync();
  assert.equal(unchanged.summary["up-to-date"], 2);
});

test("dry run fetches new refs and reports pending merges without changing either worktree", (t) => {
  const { w, writer, commit, sync } = fixture(t);
  const before = [
    w.git(w.a, "rev-parse", "HEAD"),
    w.git(w.b, "rev-parse", "HEAD"),
  ];
  const latest = commit(writer, "new-base.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  assert.notEqual(w.git(w.repo, "rev-parse", "origin/develop"), latest);
  const report = sync(["--dry-run"]);
  assert.equal(report.dryRun, true);
  assert.equal(report.summary["would-update"], 2);
  assert.equal(w.git(w.repo, "rev-parse", "origin/develop"), latest);
  assert.deepEqual(
    [w.git(w.a, "rev-parse", "HEAD"), w.git(w.b, "rev-parse", "HEAD")],
    before,
  );
  assert.ok(!fs.existsSync(path.join(w.a, "new-base.txt")));
  assert.ok(!fs.existsSync(path.join(w.b, "new-base.txt")));
});

test("conflicts are reported and aborted while independent workspaces continue syncing", (t) => {
  const { w, writer, commit, sync } = fixture(t);
  commit(w.a, "same.txt", "feature version\n");
  const before = w.git(w.a, "rev-parse", "HEAD");
  const latest = commit(writer, "same.txt", "base version\n");
  w.git(writer, "push", "-q", "origin", "develop");
  const report = sync([], false);
  assert.equal(report.summary.conflict, 1);
  assert.equal(report.summary.updated, 1);
  assert.deepEqual(report.results[0].conflicts, ["same.txt"]);
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), before);
  assert.equal(read(path.join(w.a, "same.txt")), "feature version\n");
  assert.equal(w.git(w.a, "status", "--porcelain"), "");
  assert.ok(
    !fs.existsSync(w.git(w.a, "rev-parse", "--git-path", "MERGE_HEAD")),
  );
  assert.equal(w.git(w.b, "rev-parse", "HEAD"), latest);
});

test("dirty, locked, busy and branch-switched worktrees are skipped without stashing or changing them", (t) => {
  const { w, writer, commit, sync } = fixture(t);
  const locked = w.managed("locked");
  w.git(w.repo, "worktree", "lock", locked);
  const busy = w.managed("busy");
  const missing = w.managed("missing");
  const missingHead = w.git(missing, "rev-parse", "HEAD");
  fs.rmSync(missing, { recursive: true });
  const switched = w.managed("switched");
  w.git(switched, "checkout", "-qb", "replacement");
  const marker = w.git(busy, "rev-parse", "--git-path", "CHERRY_PICK_HEAD");
  write(marker, w.git(busy, "rev-parse", "HEAD"));
  write(path.join(w.a, "keep.txt"), "uncommitted changes");
  const heads = [w.a, locked, busy, switched].map((root) =>
    w.git(root, "rev-parse", "HEAD"),
  );
  commit(writer, "new-base.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  const report = sync([], false);
  assert.equal(report.summary.skipped, 5);
  assert.equal(report.summary.updated, 1);
  assert.match(
    report.results.find((row: { branch: string }) => row.branch === "feature/a")
      .detail,
    /dirty/,
  );
  assert.match(
    report.results.find((row: { branch: string }) => row.branch === "locked")
      .detail,
    /locked/,
  );
  assert.match(
    report.results.find((row: { branch: string }) => row.branch === "busy")
      .detail,
    /operation.*progress/,
  );
  assert.match(
    report.results.find((row: { branch: string }) => row.branch === "switched")
      .detail,
    /branch/,
  );
  assert.deepEqual(
    [w.a, locked, busy, switched].map((root) =>
      w.git(root, "rev-parse", "HEAD"),
    ),
    heads,
  );
  assert.equal(read(path.join(w.a, "keep.txt")), "uncommitted changes");
  assert.equal(w.git(w.repo, "stash", "list"), "");
  assert.ok(fs.existsSync(marker));
  assert.equal(w.git(w.repo, "rev-parse", "refs/heads/missing"), missingHead);
});

test("a failed fetch stops all merges and a deleted remote base never falls back to a stale local branch", (t) => {
  const { w, writer, remote, commit, sync, base } = fixture(t);
  const latest = commit(writer, "new-base.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  w.git(w.repo, "fetch", "-q", "origin");
  const before = w.git(w.a, "rev-parse", "HEAD");
  w.git(
    w.repo,
    "remote",
    "set-url",
    "origin",
    path.join(w.root, "missing.git"),
  );
  const failed = sync([], false);
  assert.equal(failed.fetches[0].status, "failed");
  assert.equal(failed.summary.failed, 2);
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), before);
  w.git(w.repo, "remote", "set-url", "origin", remote);
  w.git(w.repo, "branch", "retired", latest);
  w.git(w.repo, "update-ref", "refs/remotes/origin/retired", latest);
  base(w.a, "origin/retired");
  const missing = sync([], false);
  assert.equal(missing.summary.failed, 1);
  assert.equal(missing.summary.updated, 1);
  assert.match(
    missing.results[0].detail,
    /Base does not exist: origin\/retired/,
  );
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), before);
});

test("sync includes only active owned workspaces in the selected repository, and explicit names restrict the batch", (t) => {
  const { w, writer, commit, sync } = fixture(t);
  const unowned = path.join(w.root, "unowned");
  w.git(w.repo, "worktree", "add", "-qb", "unowned", unowned);
  const mainRecord = w.rl(["setup", "adopt"], { cwd: w.repo });
  assert.equal(mainRecord.status, 0);
  const deleted = w.managed("archived");
  const recordFile = path.join(
    w.status(deleted).stateDirectory,
    "instance.json",
  );
  const data = readJson(recordFile);
  data.status = "deleted";
  write(recordFile, JSON.stringify(data));
  const other = path.join(w.root, "other-repository");
  w.command(["git", "init", "-q", "-b", "test", other]);
  w.git(other, "commit", "-qm", "Other", "--allow-empty");
  w.rl(["--repo", "missing", "sync"], { cwd: w.a, ok: false });
  const untouched = [w.b, unowned, deleted, w.repo, other].map((root) =>
    w.git(root, "rev-parse", "HEAD"),
  );
  commit(writer, "new-base.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  const report = sync(["feature/a"]);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].branch, "feature/a");
  assert.deepEqual(
    [w.b, unowned, deleted, w.repo, other].map((root) =>
      w.git(root, "rev-parse", "HEAD"),
    ),
    untouched,
  );
  assert.match(
    w.rl(["sync", "unowned"], { cwd: w.repo, ok: false }).stderr,
    /Active RL workspace not found/,
  );
  assert.match(
    w.rl(["sync", "--unknown"], { cwd: w.repo, ok: false }).stderr,
    /Usage: rl sync/,
  );
});

test("local stacked bases sync before their children and cycles produce skips without changing branches", (t) => {
  const { w, writer, commit, base, sync } = fixture(t);
  const child = w.managed("a-child");
  const parent = w.managed("z-parent");
  base(child, "refs/heads/z-parent");
  const latest = commit(writer, "stack-base.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  const preview = sync(["a-child", "z-parent", "--dry-run"]);
  assert.deepEqual(
    preview.results.map((row: { branch: string }) => row.branch),
    ["z-parent", "a-child"],
  );
  assert.equal(preview.summary["would-update"], 2);
  const report = sync(["a-child", "z-parent"]);
  assert.equal(report.summary.updated, 2);
  assert.equal(w.git(child, "rev-parse", "HEAD"), latest);
  assert.equal(w.git(parent, "rev-parse", "HEAD"), latest);
  base(parent, "refs/heads/a-child");
  const cycle = sync(["a-child", "z-parent"], false);
  assert.equal(cycle.summary.skipped, 2);
  assert.ok(
    cycle.results.every((row: { detail: string }) => /Cyclic/.test(row.detail)),
  );
});

test("an interrupted merge is aborted and remaining workspaces are left untouched", (t) => {
  const { w, writer, commit, sync } = fixture(t);
  const before = [w.a, w.b].map((root) => w.git(root, "rev-parse", "HEAD"));
  commit(writer, "new-base.txt");
  w.git(writer, "push", "-q", "origin", "develop");
  w.env.SYNC_REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.stub(
    "git",
    `
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'merge' && args.includes('--ff')) {
  const result = cp.spawnSync(process.env.SYNC_REAL_GIT, ['merge', '--no-ff', '--no-commit', args.at(-1)], {stdio:'inherit'});
  process.exit(result.status === 0 ? 130 : 1);
}
const result = cp.spawnSync(process.env.SYNC_REAL_GIT, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`,
  );
  const report = sync([], false);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.skipped, 1);
  assert.match(report.results[0].detail, /interrupted.*aborted/);
  assert.match(report.results[1].detail, /interrupted/);
  assert.deepEqual(
    [w.a, w.b].map((root) => w.git(root, "rev-parse", "HEAD")),
    before,
  );
  assert.equal(w.git(w.a, "status", "--porcelain"), "");
  assert.ok(
    !fs.existsSync(w.git(w.a, "rev-parse", "--git-path", "MERGE_HEAD")),
  );
});

test("a deleted remote cannot supply a stale cached base and an empty batch needs no fetch", (t) => {
  const { w, base, sync } = fixture(t);
  const oid = w.git(w.repo, "rev-parse", "HEAD");
  w.git(w.repo, "update-ref", "refs/remotes/removed/develop", oid);
  base(w.a, "refs/remotes/removed/develop");
  const missing = sync(["feature/a"], false);
  assert.equal(missing.summary.failed, 1);
  assert.match(missing.results[0].detail, /Base does not exist/);
  for (const root of [w.a, w.b]) {
    const file = path.join(w.status(root).stateDirectory, "instance.json");
    const data = readJson(file);
    data.status = "deleted";
    write(file, JSON.stringify(data));
  }
  w.git(
    w.repo,
    "remote",
    "set-url",
    "origin",
    path.join(w.root, "missing.git"),
  );
  const empty = sync();
  assert.deepEqual(empty.fetches, []);
  assert.deepEqual(empty.results, []);
});

test("sync human output stays readable and help is available without repository configuration", (t) => {
  const { w, sync } = fixture(t);
  assert.equal(sync().summary["up-to-date"], 2);
  const output = w.rl(["sync"], { cwd: w.a }).stdout;
  assert.match(output, /Sync results/);
  assert.match(output, /feature\/a ← origin\/develop/);
  assert.match(output, /2 up-to-date/);
  w.env.RL_CONFIG = path.join(w.root, "missing-config");
  for (const argv of [
    ["sync", "--help"],
    ["help", "sync"],
    ["--repo", "unknown", "sync", "-h"],
  ])
    assert.match(w.rl(argv).stdout, /Usage: rl sync/);
});
