import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Workspace, read, write, readJson } from "./helpers.js";
test("summary includes scoped Git evidence and notes without dirtying checkout", (t) => {
  const w = new Workspace(t);
  w.rl(["context", "set", "-"], {
    cwd: w.a,
    input: "# Domain\nFixed shifts cannot overlap.\n",
  });
  w.rl(["progress", "set", "-"], {
    cwd: w.a,
    input:
      "# Progress\n## Completed\nAdded parser.\n## Remaining\nFinish UI.\n## Validation\nParser tests pass.\n",
  });
  const file = path.join(w.a, "parser.txt");
  write(file, "implemented parser\n");
  w.git(w.a, "add", ".");
  w.git(w.a, "commit", "-q", "-m", "Implement fixed shift parser");
  write(file, "staged update\n");
  w.git(w.a, "add", ".");
  write(file, "unstaged update\n");
  const unusual = " leading space\nand newline.txt";
  write(path.join(w.a, unusual), "unfinished");
  const before = w.git(w.a, "status", "--porcelain"),
    sub = path.join(w.a, "nested");
  fs.mkdirSync(sub);
  const output = w.rl(["summary"], { cwd: sub }).stdout.trim();
  assert.equal(path.dirname(output), w.status().stateDirectory);
  const text = read(output);
  for (const expected of [
    "Added parser",
    "Finish UI",
    "Parser tests pass",
    "Fixed shifts cannot overlap",
    "Implement fixed shift parser",
    "parser.txt",
    "1 staged, 1 unstaged",
    "No agent was called",
    JSON.stringify(unusual),
  ])
    assert.ok(text.includes(expected), expected);
  assert.equal(w.git(w.a, "status", "--porcelain"), before);
  assert.ok(!fs.existsSync(w.log));
});
test("summary stdout, custom destinations, overwrite and source-document protection", (t) => {
  const w = new Workspace(t),
    state = w.status().stateDirectory;
  assert.match(
    w.rl(["summary", "--stdout"], { cwd: w.a }).stdout,
    /No notes recorded/,
  );
  assert.ok(!fs.existsSync(path.join(state, "summary.md")));
  w.rl(["summary", "-o", "report.md"], { cwd: w.a });
  const target = path.join(w.a, "report.md");
  write(target, "Keep this existing document");
  w.rl(["summary", "-o", "report.md"], { cwd: w.a, ok: false });
  assert.equal(read(target), "Keep this existing document");
  w.rl(["summary", "-o", "report.md", "--force"], { cwd: w.a });
  assert.match(read(target), /^# RL worktree summary/);
  const source = path.join(state, "context.md"),
    before = read(source);
  w.rl(["summary", "-o", source, "--force"], { cwd: w.a, ok: false });
  assert.equal(read(source), before);
  const link = path.join(w.a, "link.md");
  fs.symlinkSync(target, link);
  w.rl(["summary", "-o", link, "--force"], { cwd: w.a, ok: false });
});
test("summary comparison base scopes commits and failures preserve previous export", (t) => {
  const w = new Workspace(t);
  w.git(w.a, "commit", "-q", "--allow-empty", "-m", "Earlier implementation");
  w.git(w.a, "branch", "milestone");
  w.git(w.a, "commit", "-q", "--allow-empty", "-m", "After milestone");
  const text = w.rl(["summary", "--stdout", "--base", "milestone"], {
    cwd: w.a,
  }).stdout;
  assert.match(text, /After milestone/);
  assert.doesNotMatch(text, /Earlier implementation/);
  const target = w.rl(["summary"], { cwd: w.a }).stdout.trim(),
    before = read(target);
  w.rl(["summary", "--base", "does-not-exist"], { cwd: w.a, ok: false });
  assert.equal(read(target), before);
  w.env.RL_DEFAULT_BASE = "unavailable-default";
  assert.match(
    w.rl(["summary", "--stdout"], { cwd: w.a }).stdout,
    /Committed work was omitted/,
  );
});
test("summary retains cached PR and survives deleting its worktree", (t) => {
  const w = new Workspace(t),
    root = w.managed("task"),
    file = path.join(w.status(root).stateDirectory, "instance.json"),
    data = readJson(file);
  data.pr = {
    url: "https://github.com/example/repo/pull/7",
    number: 7,
    state: "OPEN",
    syncedAt: "2026-10-01T00:00:00Z",
  };
  write(file, JSON.stringify(data));
  const target = w.rl(["summary"], { cwd: root }).stdout.trim();
  assert.match(read(target), /https:\/\/github.com\/example\/repo\/pull\/7/);
  w.rl(["delete", "task"]);
  assert.ok(fs.existsSync(target));
});
test("summary routes registered repositories and refuses changed branches", (t) => {
  const w = new Workspace(t);
  w.rl(["repo", "add", "example", w.repo, "--base", "develop"]);
  const text = w.rl(["summary", "--stdout"], { cwd: w.a }).stdout;
  assert.match(text, /feature\/a/);
  assert.doesNotMatch(text, /feature\/b/);
  w.git(w.a, "checkout", "-q", "-b", "different");
  w.rl(["summary"], { cwd: w.a, ok: false });
  w.rl(["summary"], { ok: false });
});

test("summary uses the PR target over saved base and updates after PR retargeting", (t) => {
  const w = new Workspace(t);
  w.git(w.a, "commit", "-q", "--allow-empty", "-m", "Already on PR target");
  w.git(w.a, "update-ref", "refs/remotes/origin/release/next", "HEAD");
  // A stale local target must not override the remote target snapshot.
  w.git(w.a, "branch", "release/next", "develop");
  w.git(w.a, "commit", "-q", "--allow-empty", "-m", "Feature after target");
  const file = path.join(w.status().stateDirectory, "instance.json"),
    data = readJson(file);
  data.baseBranch = "develop";
  data.pr = {
    url: "https://github.com/example/repo/pull/1",
    baseRefName: "release/next",
    state: "OPEN",
  };
  write(file, JSON.stringify(data));
  const report = w.rl(["summary", "--stdout"], { cwd: w.a }).stdout;
  assert.match(report, /Comparison reference: .*origin\/release\/next/);
  assert.match(report, /Feature after target/);
  assert.doesNotMatch(report, /Already on PR target/);
  data.pr.baseRefName = "develop";
  write(file, JSON.stringify(data));
  assert.match(
    w.rl(["summary", "--stdout"], { cwd: w.a }).stdout,
    /Already on PR target/,
  );
  data.pr.baseRefName = "missing-target";
  write(file, JSON.stringify(data));
  assert.match(
    w.rl(["summary", "--stdout"], { cwd: w.a, ok: false }).stderr,
    /PR target branch is unavailable locally: missing-target/,
  );
  // --base is still an explicit one-off report override.
  assert.match(
    w.rl(["summary", "--stdout", "--base", "develop"], { cwd: w.a }).stdout,
    /Already on PR target/,
  );
});
