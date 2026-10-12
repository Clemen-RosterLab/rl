import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

const PR = {
  number: 42,
  url: "https://github.com/example/repo/pull/42",
  state: "OPEN",
  title: "Feature A",
  headRefName: "feature/a",
  baseRefName: "test",
  isDraft: true,
  updatedAt: "2026-10-01T00:00:00Z",
  syncedAt: "2026-10-01T00:00:01Z",
};
function cachePr(w: Workspace, pr = PR): string {
  const file = path.join(w.status().stateDirectory, "instance.json");
  const data = readJson(file);
  data.pr = pr;
  write(file, JSON.stringify(data));
  return file;
}

test("status prints Git changes, saved sessions, PR link and paused task while JSON stays available", (t) => {
  const w = new Workspace(t);
  const sid = randomUUID();
  w.hook("codex", sid);
  w.hook("codex", sid, { event: "UserPromptSubmit" });
  w.rl(
    [
      "pause",
      "--session",
      sid,
      "--summary",
      "Finish login states",
      "--changes",
      "Added validation",
      "--validation",
      "Not run",
      "--next",
      "Check browser behavior",
      "--blockers",
      "Waiting for copy",
    ],
    { cwd: w.a },
  );
  const file = cachePr(w);
  write(path.join(w.a, "staged.txt"), "ready");
  w.git(w.a, "add", "staged.txt");
  write(path.join(w.a, "untracked.txt"), "unfinished");
  const before = read(file);
  const output = w.rl(["status"], { cwd: w.a }).stdout;
  assert.match(output, /Workspace: /);
  assert.match(output, /Branch: feature\/a/);
  assert.ok(output.includes(`Path: ${w.a}`));
  assert.match(output, /Git: 1 staged, 1 untracked/);
  assert.match(output, /PR #42: Feature A \[draft · open\]/);
  assert.ok(output.includes(PR.url));
  assert.match(output, /Codex: 1 saved sessions · 1 working/);
  assert.match(output, /Claude: 0 saved sessions/);
  assert.match(output, /Task: paused · Finish login states/);
  assert.match(output, /Next: Check browser behavior/);
  assert.match(output, /Blockers: Waiting for copy/);
  assert.throws(() => JSON.parse(output));
  const data = w.status();
  assert.equal(data.gitStatus.staged, 1);
  assert.equal(data.sessions.codex[0].id, sid);
  assert.deepEqual(data.pr, PR);
  assert.equal(data.task.state, "paused");
  assert.equal(read(file), before);
});

test("pr show works offline and prints a readable cached summary or a clear empty state", (t) => {
  const w = new Workspace(t);
  w.stub("gh", "process.exit(99);");
  assert.match(w.rl(["pr", "show"], { cwd: w.a }).stdout, /PR: none saved/);
  assert.equal(
    JSON.parse(w.rl(["pr", "show", "--json"], { cwd: w.a }).stdout),
    null,
  );
  const pr = { ...PR, title: "Feature\nA\x1b[31m" };
  const file = cachePr(w, pr);
  const before = read(file);
  const output = w.rl(["pr", "show"], { cwd: w.a }).stdout;
  assert.match(output, /PR #42: Feature A/);
  assert.match(output, /feature\/a → test/);
  assert.ok(output.includes(PR.url));
  assert.ok(!output.includes("\x1b"));
  assert.match(output, /Cached 2026-10-01T00:00:01Z/);
  assert.deepEqual(
    JSON.parse(w.rl(["pr", "show", "--json"], { cwd: w.a }).stdout),
    pr,
  );
  assert.equal(read(file), before);
});

test("pr sync prints a readable summary and only emits JSON when requested", (t) => {
  const w = new Workspace(t);
  w.env.PR_JSON = JSON.stringify(PR);
  w.stub(
    "gh",
    "console.log(process.argv[2] === 'repo' ? JSON.stringify({nameWithOwner:'example/repo',url:'https://github.com/example/repo'}) : process.env.PR_JSON);",
  );
  const human = w.rl(["pr", "sync"], { cwd: w.a }).stdout;
  assert.match(human, /PR #42: Feature A/);
  assert.ok(human.includes(PR.url));
  assert.throws(() => JSON.parse(human));
  const data = JSON.parse(w.rl(["pr", "sync", "--json"], { cwd: w.a }).stdout);
  assert.equal(data.number, 42);
  assert.equal(data.url, PR.url);
  assert.ok(data.syncedAt);
  assert.deepEqual(w.status().pr, data);
});

test("pr opens the current branch or saved URL, keeps a link on browser failure, and never opens for JSON", (t) => {
  const w = new Workspace(t);
  delete w.env.RL_PR_OFFLINE;
  w.env.GH_REPO = "unrelated/wrong";
  const log = path.join(w.root, "browser-calls.jsonl");
  w.env.BROWSER_LOG = log;
  w.stub(
    "gh",
    "require('node:fs').appendFileSync(process.env.BROWSER_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),repo:process.env.GH_REPO??null})+'\\n'); if(process.env.BROWSER_FAIL){console.error('Browser unavailable');process.exit(7);}",
  );
  const calls = () =>
    read(log)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  fs.mkdirSync(path.join(w.a, "nested"));
  w.rl(["pr"], { cwd: path.join(w.a, "nested") });
  assert.deepEqual(calls()[0], {
    args: ["pr", "view", "feature/a", "--web"],
    cwd: w.a,
    repo: null,
  });
  const file = cachePr(w);
  const before = read(file);
  const opened = w.rl(["pr", "open"], { cwd: w.a }).stdout;
  assert.ok(opened.includes(PR.url));
  assert.deepEqual(calls()[1].args, ["pr", "view", PR.url, "--web"]);
  assert.deepEqual(JSON.parse(w.rl(["pr", "--json"], { cwd: w.a }).stdout), PR);
  assert.deepEqual(
    JSON.parse(w.rl(["pr", "open", "--json"], { cwd: w.a }).stdout),
    PR,
  );
  assert.equal(calls().length, 2);
  w.env.BROWSER_FAIL = "1";
  const fallback = w.rl(["pr"], { cwd: w.a });
  assert.ok(fallback.stdout.includes(PR.url));
  assert.match(fallback.stderr, /Use the PR link above/);
  const failed = w.rl(["pr"], { cwd: w.b, ok: false });
  assert.match(failed.stderr, /Browser unavailable/);
  assert.equal(read(file), before);
  cachePr(w, { ...PR, url: "javascript:alert(1)" });
  const count = calls().length;
  assert.match(
    w.rl(["pr"], { cwd: w.a, ok: false }).stderr,
    /Invalid saved PR URL/,
  );
  assert.equal(calls().length, count);
});
