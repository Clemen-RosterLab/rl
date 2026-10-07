import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, Workspace, write, read, Options } from "./helpers.js";

function workflow(
  w: Workspace,
  argv: string[],
  options: Options = {},
  module = "git-workflow",
) {
  const script = `import {main} from ${JSON.stringify(path.join(ROOT, "dist", module + ".js"))}; try { process.exitCode = await main(process.argv.slice(1)); } catch(e) { console.error(e.message); process.exitCode=1; }`;
  return w.command(
    [
      "node",
      "--input-type=module",
      "-e",
      script,
      "--",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "--base-dir",
      path.join(w.root, "worktrees/example"),
      "--default-base",
      "develop",
      ...argv,
    ],
    { cwd: w.a, ...options },
  );
}
function commit(w: Workspace, root: string, name: string) {
  write(path.join(root, name), name);
  w.git(root, "add", name);
  w.git(root, "commit", "-qm", name);
}

test("step commit stages only explicitly tracked --all changes and preserves untracked files", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "staged"), "staged");
  write(path.join(w.a, "untracked"), "untracked");
  w.git(w.a, "add", "staged");
  workflow(w, ["step", "commit", "-m", "first"]);
  assert.equal(
    w.git(w.a, "show", "--format=", "--name-only", "HEAD"),
    "staged",
  );
  write(path.join(w.a, "staged"), "changed");
  workflow(w, ["step", "commit", "--all", "-m", "tracked"]);
  assert.equal(w.git(w.a, "status", "--porcelain"), "?? untracked");
  workflow(w, ["step", "commit"], { ok: false });
});

test("squash retains tree, merge-base parent and backup of original head", (t) => {
  const w = new Workspace(t);
  commit(w, w.a, "one");
  commit(w, w.a, "two");
  const before = w.git(w.a, "rev-parse", "HEAD"),
    tree = w.git(w.a, "rev-parse", "HEAD^{tree}");
  const out = workflow(w, ["step", "squash", "-m", "combined"]).stdout;
  const backup = out.match(/refs\/rl\/backups\/[^\s]+/)![0];
  assert.equal(w.git(w.a, "rev-parse", backup), before);
  assert.equal(w.git(w.a, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(w.git(w.a, "rev-list", "--count", "develop..HEAD"), "1");
  assert.equal(w.git(w.a, "status", "--porcelain"), "");
});

test("rebase refuses dirty or ongoing operations and preserves recoverable conflicts", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "dirty"), "keep");
  workflow(w, ["step", "rebase"], { ok: false });
  assert.equal(read(path.join(w.a, "dirty")), "keep");
  fs.unlinkSync(path.join(w.a, "dirty"));
  commit(w, w.repo, "conflict");
  write(path.join(w.a, "conflict"), "different");
  w.git(w.a, "add", "conflict");
  w.git(w.a, "commit", "-qm", "conflicting");
  const failed = workflow(w, ["step", "rebase"], { ok: false });
  assert.match(failed.stderr, /rebase --abort/);
  workflow(w, ["step", "squash", "-m", "bad"], { ok: false });
  w.git(w.a, "rebase", "--abort");
  assert.equal(read(path.join(w.a, "conflict")), "different");
});

test("merge dry run and diverged/dirty guards preserve both branches", (t) => {
  const w = new Workspace(t),
    source = w.managed("topic");
  commit(w, source, "feature");
  const before = w.git(w.repo, "rev-parse", "HEAD");
  workflow(w, ["merge", "--dry-run", "--cleanup"], { cwd: source });
  assert.equal(w.git(w.repo, "rev-parse", "HEAD"), before);
  write(path.join(w.repo, "dirty"), "keep");
  workflow(w, ["merge"], { cwd: source, ok: false });
  fs.unlinkSync(path.join(w.repo, "dirty"));
  commit(w, w.repo, "divergence");
  workflow(w, ["merge", "--cleanup"], { cwd: source, ok: false });
  assert.ok(fs.existsSync(source));
});

test("successful fast-forward cleans only clean unlocked worktree and retains docs", (t) => {
  const w = new Workspace(t),
    source = w.managed("topic"),
    record = w.status(source);
  commit(w, source, "feature");
  workflow(w, ["merge", "--cleanup"], { cwd: source });
  assert.ok(!fs.existsSync(source));
  assert.equal(read(path.join(w.repo, "feature")), "feature");
  assert.ok(fs.existsSync(path.join(record.stateDirectory, "context.md")));
  assert.equal(
    JSON.parse(read(path.join(record.stateDirectory, "instance.json"))).status,
    "deleted",
  );
});

test("squash merge retains divergent branch and locked cleanup preserves record", (t) => {
  const w = new Workspace(t),
    source = w.managed("topic");
  commit(w, source, "feature");
  commit(w, w.repo, "other");
  const out = workflow(
    w,
    ["merge", "--squash", "-m", "combined", "--cleanup"],
    { cwd: source },
  ).stdout;
  assert.match(out, /branch topic retained/);
  assert.equal(w.git(w.repo, "log", "-1", "--format=%s"), "combined");
  w.git(w.repo, "show-ref", "--verify", "refs/heads/topic");
  const locked = w.managed("locked");
  commit(w, locked, "locked");
  w.git(w.repo, "worktree", "lock", locked);
  workflow(w, ["merge", "--cleanup"], { cwd: locked, ok: false });
  assert.ok(fs.existsSync(locked));
  assert.equal(w.status(locked).status, "active");
});

test("squash conflict retains source and reports incomplete merge", (t) => {
  const w = new Workspace(t),
    source = w.managed("topic");
  commit(w, w.repo, "same");
  write(path.join(source, "same"), "different");
  w.git(source, "add", "same");
  w.git(source, "commit", "-qm", "conflict");
  workflow(w, ["merge", "--squash", "-m", "combined", "--cleanup"], {
    cwd: source,
    ok: false,
  });
  assert.ok(fs.existsSync(source));
  assert.equal(read(path.join(source, "same")), "different");
  assert.ok(w.git(w.repo, "ls-files", "--unmerged"));
});

test("diff/log are offline and disallow output/execute options", (t) => {
  const w = new Workspace(t);
  commit(w, w.a, "one");
  assert.match(workflow(w, ["diff", "--", "--stat"]).stdout, /one/);
  assert.match(workflow(w, ["log", "--", "--oneline"]).stdout, /one/);
  for (const option of [
    "--output=/tmp/rl-unsafe",
    "--ext-diff",
    "--textconv",
    "--format=%x00",
    "--exec=touch /tmp/no",
  ])
    workflow(w, ["diff", "--", option], { ok: false });
  workflow(w, ["step", "rebase", "--base=--exec=bad"], { ok: false });
});

function github(w: Workspace, fork = false) {
  delete w.env.RL_PR_OFFLINE;
  w.git(
    w.repo,
    "remote",
    "add",
    "origin",
    "https://github.com/example/project.git",
  );
  w.env.GH_PR = JSON.stringify({
    number: 12,
    url: "https://github.com/example/project/pull/12",
    headRefName: "feature/a",
    headRefOid: w.git(w.a, "rev-parse", "HEAD"),
    baseRefName: "develop",
    isCrossRepository: fork,
    headRepository: { name: "project" },
    headRepositoryOwner: { login: fork ? "attacker" : "example" },
  });
  w.stub(
    "gh",
    `const args=process.argv.slice(2); if(args[0]==='repo') console.log(JSON.stringify({nameWithOwner:'example/project',url:'https://github.com/example/project'})); else if(args[1]==='checks') {console.log('[{"name":"test","bucket":"pending"}]');process.exit(8);} else console.log(process.env.GH_PR);`,
  );
}

test("PR checks propagate pending exit and fork checkout cannot collide with local head", (t) => {
  const w = new Workspace(t);
  github(w, true);
  const before = w.git(w.a, "rev-parse", "HEAD");
  assert.match(
    workflow(w, ["pr", "checks", "--json"], { ok: false }, "pr-workflow")
      .stdout,
    /pending/,
  );
  assert.match(
    workflow(
      w,
      ["pr", "checkout", "12", "--name", "feature/a"],
      { ok: false },
      "pr-workflow",
    ).stderr,
    /fork/,
  );
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), before);
  assert.equal(
    w.git(w.repo, "for-each-ref", "--format=%(refname)", "refs/rl/pr-fetch"),
    "",
  );
});

test("PR checkout validates origin, numeric selector and branch collisions before fetch", (t) => {
  const w = new Workspace(t);
  github(w);
  workflow(
    w,
    ["pr", "checkout", "12", "--name", "feature/a"],
    { ok: false },
    "pr-workflow",
  );
  workflow(w, ["pr", "checkout", "--evil"], { ok: false }, "pr-workflow");
  workflow(
    w,
    ["pr", "checkout", "12", "--name", "../escape"],
    { ok: false },
    "pr-workflow",
  );
  w.git(
    w.repo,
    "remote",
    "set-url",
    "origin",
    "https://github.com/attacker/project.git",
  );
  assert.match(
    workflow(w, ["pr", "checkout", "12"], { ok: false }, "pr-workflow").stderr,
    /does not match origin/,
  );
});

test("PR checkout fetches exact verified head into new adopted worktree without switching main", (t) => {
  const w = new Workspace(t);
  commit(w, w.a, "pull-request");
  github(w);
  const bare = path.join(w.root, "remote.git");
  w.command(["git", "clone", "--bare", w.repo, bare]);
  w.git(
    bare,
    "update-ref",
    "refs/pull/12/head",
    w.git(w.a, "rev-parse", "HEAD"),
  );
  w.env.FIXTURE_REMOTE = bare;
  w.env.REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.stub(
    "git",
    `const cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('fetch'))args[args.indexOf('origin')]=process.env.FIXTURE_REMOTE;const r=cp.spawnSync(process.env.REAL_GIT,args,{stdio:'inherit'});process.exit(r.status??1);`,
  );
  const before = w.git(w.repo, "rev-parse", "HEAD");
  const output = workflow(
    w,
    ["pr", "checkout", "12"],
    {},
    "pr-workflow",
  ).stdout.trim();
  assert.equal(read(path.join(output, "pull-request")), "pull-request");
  assert.equal(w.status(output).status, "active");
  assert.equal(w.git(w.repo, "branch", "--show-current"), "develop");
  assert.equal(w.git(w.repo, "rev-parse", "HEAD"), before);
  assert.equal(
    w.git(w.repo, "for-each-ref", "--format=%(refname)", "refs/rl/pr-fetch"),
    "",
  );
  // A PR moving between metadata and fetch must not produce a checkout.
  const data = JSON.parse(w.env.GH_PR!);
  data.headRefOid = before;
  w.env.GH_PR = JSON.stringify(data);
  assert.match(
    workflow(
      w,
      ["pr", "checkout", "12", "--name", "moved"],
      { ok: false },
      "pr-workflow",
    ).stderr,
    /changed during checkout/,
  );
  assert.ok(!fs.existsSync(path.join(w.root, "worktrees/example/moved")));
});

test("squash rejects a branch switch while waiting for the workflow lock", async (t) => {
  const w = new Workspace(t);
  commit(w, w.a, "one");
  const stateRoot = path.dirname(w.status(w.a).stateDirectory);
  const lock = path.join(stateRoot, ".git-workflow", ".lock");
  fs.mkdirSync(lock, { recursive: true });
  const marker = path.join(w.root, "branch-observed");
  w.env.BRANCH_MARKER = marker;
  w.env.REAL_GIT = w.command(["which", "git"]).stdout.trim();
  w.stub(
    "git",
    `const cp=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2);const r=cp.spawnSync(process.env.REAL_GIT,args,{encoding:'utf8'});if(args.includes('--show-current'))fs.writeFileSync(process.env.BRANCH_MARKER,'seen');process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);`,
  );
  const script = `import {main} from ${JSON.stringify(path.join(ROOT, "dist/git-workflow.js"))};try {process.exitCode=await main(process.argv.slice(1))}catch(e){console.error(e.message);process.exitCode=1}`;
  const pending = w.commandAsync(
    [
      "node",
      "--input-type=module",
      "-e",
      script,
      "--",
      "--repo",
      w.repo,
      "--state-dir",
      w.state,
      "--base-dir",
      path.join(w.root, "worktrees/example"),
      "--default-base",
      "develop",
      "step",
      "squash",
      "-m",
      "should not happen",
    ],
    { cwd: w.a },
  );
  const rejected = assert.rejects(pending, /branch changed/);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker)) {
    if (Date.now() > deadline) throw new Error("branch read not observed");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const before = w.git(w.a, "rev-parse", "HEAD");
  w.git(w.a, "switch", "-c", "other");
  fs.rmdirSync(lock);
  await rejected;
  assert.equal(w.git(w.a, "rev-parse", "refs/heads/feature/a"), before);
  assert.equal(w.git(w.a, "rev-parse", "refs/heads/other"), before);
});

test("step dry runs preserve HEAD, index and backup refs", (t) => {
  const w = new Workspace(t);
  commit(w, w.a, "one");
  const head = w.git(w.a, "rev-parse", "HEAD");
  workflow(w, ["step", "squash", "-m", "preview", "--dry-run"]);
  workflow(w, ["step", "rebase", "--dry-run"]);
  write(path.join(w.a, "one"), "pending");
  w.git(w.a, "add", "one");
  const tree = w.git(w.a, "write-tree");
  assert.match(
    workflow(w, ["step", "commit", "-m", "preview", "--dry-run"]).stdout,
    /Would commit staged/,
  );
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), head);
  assert.equal(w.git(w.a, "write-tree"), tree);
  assert.equal(
    w.git(w.a, "for-each-ref", "--format=%(refname)", "refs/rl/backups"),
    "",
  );
});
