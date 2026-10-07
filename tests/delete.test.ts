import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, Workspace, read, write, readJson } from "./helpers.js";
test("batch deletion deduplicates names and retains archived records", (t) => {
  const w = new Workspace(t),
    roots = ["one", "feature/two", "three"].map((name) => w.managed(name)),
    records = roots.map((root) => w.status(root));
  for (const root of roots)
    write(path.join(root, "uncommitted.txt"), "unfinished");
  assert.match(
    w.rl(["delete", "--force", "one", "feature/two", "three", "one"]).stdout,
    /Removed 3 worktree\(s\); failed 0/,
  );
  for (const [index, root] of roots.entries()) {
    assert.ok(!fs.existsSync(root));
    const data = records[index];
    w.command(["git", "show-ref", "--verify", "refs/heads/" + data.branch], {
      cwd: w.repo,
      ok: false,
    });
    assert.equal(
      readJson(path.join(data.stateDirectory, "instance.json")).status,
      "deleted",
    );
    assert.ok(fs.existsSync(path.join(data.stateDirectory, "context.md")));
  }
});
test("multi picker cancellation is harmless and selected rows remove only selected instances", (t) => {
  const w = new Workspace(t),
    one = w.managed("one"),
    two = w.managed("two");
  w.stub(
    "fzf",
    `const fs=require('node:fs'); if (!process.argv.includes('--multi')) process.exit(8); const rows=fs.readFileSync(0,'utf8').trim().split('\\n'); if(process.env.PICK_EXIT) process.exit(Number(process.env.PICK_EXIT)); console.log(rows.join('\\n'));`,
  );
  w.env.PICK_EXIT = "130";
  w.rl(["delete"]);
  assert.ok(fs.existsSync(one) && fs.existsSync(two));
  delete w.env.PICK_EXIT;
  w.rl(["delete"]);
  assert.ok(!fs.existsSync(one) && !fs.existsSync(two));
});
test("preflight and dry-run preserve worktrees", (t) => {
  const w = new Workspace(t),
    one = w.managed("one");
  for (const args of [
    ["one", "missing"],
    ["one", "../repo"],
    ["--jobs", "0", "one"],
  ])
    w.rl(["delete", ...args], { ok: false });
  w.rl(["delete", "--dry-run", "one"]);
  assert.ok(fs.existsSync(one));
  assert.equal(w.status(one).status, "active");
});
test("default deletion preserves dirty workspaces and unmerged commits", (t) => {
  const w = new Workspace(t),
    dirty = w.managed("dirty"),
    unmerged = w.managed("unmerged");
  write(path.join(dirty, "unfinished.txt"), "keep this");
  write(path.join(unmerged, "feature.txt"), "keep this commit");
  w.git(unmerged, "add", "feature.txt");
  w.git(unmerged, "commit", "-m", "Unmerged feature");
  const before = w.git(unmerged, "rev-parse", "HEAD");
  w.rl(["delete", "dirty", "unmerged"], { ok: false });
  assert.equal(read(path.join(dirty, "unfinished.txt")), "keep this");
  assert.equal(w.git(unmerged, "rev-parse", "HEAD"), before);
  for (const root of [dirty, unmerged])
    assert.equal(w.status(root).status, "active");
  w.rl(["delete", "--force", "dirty", "unmerged"]);
  assert.ok(!fs.existsSync(dirty) && !fs.existsSync(unmerged));
});
test("default deletion preserves detached commits and interrupted operations", (t) => {
  const w = new Workspace(t),
    detached = w.managed("detached"),
    interrupted = w.managed("interrupted");
  w.git(detached, "checkout", "--detach");
  w.git(detached, "commit", "--allow-empty", "-m", "Detached work");
  const head = w.git(detached, "rev-parse", "HEAD");
  const rebase = w.git(
    interrupted,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "rebase-merge",
  );
  fs.mkdirSync(rebase);
  w.rl(["delete", "detached", "interrupted"], { ok: false });
  assert.ok(fs.existsSync(detached) && fs.existsSync(interrupted));
  assert.equal(w.git(detached, "rev-parse", "HEAD"), head);
  fs.rmdirSync(rebase);
  w.rl(["delete", "--force", "detached", "interrupted"]);
  assert.ok(!fs.existsSync(detached) && !fs.existsSync(interrupted));
});
test("locked worktree failure retains state and other targets still complete", (t) => {
  const w = new Workspace(t),
    one = w.managed("one"),
    two = w.managed("two");
  w.git(w.repo, "worktree", "lock", one);
  assert.match(
    w.rl(["delete", "one", "two"], { ok: false }).stdout,
    /Removed 1 worktree\(s\); failed 1/,
  );
  assert.ok(fs.existsSync(one) && !fs.existsSync(two));
  assert.equal(w.status(one).status, "active");
  w.git(w.repo, "show-ref", "--verify", "refs/heads/one");
});
test("parallel removal overlaps but branch cleanup and prune each run once", (t) => {
  const w = new Workspace(t);
  w.managed("one");
  w.managed("two");
  const realGit = w.command(["which", "git"]).stdout.trim();
  w.env.REAL_GIT = realGit;
  w.env.BARRIER = path.join(w.root, "barrier");
  w.env.GIT_CALLS = path.join(w.root, "git-calls.jsonl");
  fs.mkdirSync(w.env.BARRIER);
  w.stub(
    "git",
    `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'); const args=process.argv.slice(2); fs.appendFileSync(process.env.GIT_CALLS,JSON.stringify(args)+'\\n'); if(args.includes('remove') && args.includes('--force')) { fs.writeFileSync(path.join(process.env.BARRIER,String(process.pid)),''); const end=Date.now()+10000; while(fs.readdirSync(process.env.BARRIER).length<2) { if(Date.now()>end) process.exit(88); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); } } const r=cp.spawnSync(process.env.REAL_GIT,args,{stdio:'inherit'}); process.exit(r.status??1);`,
  );
  w.rl(["delete", "--force", "--jobs", "2", "one", "two"]);
  const calls: string[][] = read(w.env.GIT_CALLS)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.filter((c) => c.includes("-D")).length, 1);
  assert.equal(calls.filter((c) => c.at(-1) === "prune").length, 1);
});
test("deleting current workspace returns integrated shell to main checkout", (t) => {
  const w = new Workspace(t),
    one = w.managed("one");
  w.env.RL_SHELL_FILE = path.join(ROOT, "shell/rl.zsh");
  w.command(
    [
      "zsh",
      "-f",
      "-c",
      'source "$RL_SHELL_FILE"; rl delete one; result=$?; [[ "$PWD" == "$RL_REPO_ROOT" ]] || exit 90; exit $result',
    ],
    { cwd: one },
  );
  assert.ok(!fs.existsSync(one));
});
