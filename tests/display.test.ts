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
  w.env.NO_COLOR = "1";
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
  const output = w.rl(["status", "--workspace"], { cwd: w.a }).stdout;
  assert.match(output, /\n  feature\/a\n/);
  assert.doesNotMatch(output, /Branch\s+feature\/a/);
  assert.match(output, /Path\s+/);
  assert.ok(output.includes(w.a));
  assert.match(output, /Git\s+1 staged file · 1 untracked file/);
  assert.match(output, /PR #42 · draft · open · → test/);
  assert.match(output, /Feature A/);
  assert.ok(output.includes(PR.url));
  assert.match(output, /Codex\s+1 saved · 1 working/);
  assert.match(output, /Claude\s+0 saved/);
  assert.match(output, /Task · paused\n  Finish login states/);
  assert.match(output, /Next\s+Check browser behavior/);
  assert.match(output, /Blockers\s+Waiting for copy/);
  assert.match(output, /Resume with rl resume/);
  assert.ok(!output.includes("\x1b"));
  assert.throws(() => JSON.parse(output));
  const data = w.status();
  assert.equal(data.gitStatus.staged, 1);
  assert.equal(data.sessions.codex[0].id, sid);
  assert.deepEqual(data.pr, PR);
  assert.equal(data.task.state, "paused");
  assert.equal(read(file), before);
});

test("status distinguishes upstream commits from changed files and respects terminal color settings", (t) => {
  const w = new Workspace(t);
  delete w.env.FORCE_COLOR;
  delete w.env.NO_COLOR;
  w.env.TERM = "xterm-256color";
  w.git(w.a, "branch", "--set-upstream-to", "develop");
  cachePr(w, {
    ...PR,
    title: "Feature\nA\x1b[31m",
    syncedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  });
  const clean = w.rl(["status", "--workspace"], { cwd: w.a }).stdout;
  assert.match(clean, /Git\s+clean/);
  assert.match(clean, /Upstream\s+up to date · develop/);
  assert.doesNotMatch(clean, /0 ahead|0 behind|\x1b/);
  assert.match(clean, /Cached \d+d ago/);
  assert.doesNotMatch(clean, /Cached 2026-/);
  assert.match(clean, /Feature A/);
  w.git(w.repo, "commit", "-q", "--allow-empty", "-m", "Advance upstream");
  w.git(w.a, "commit", "-q", "--allow-empty", "-m", "Feature commit");
  write(path.join(w.a, "unfinished.txt"), "unfinished");
  const plain = w.rl(["status", "--workspace"], { cwd: w.a }).stdout;
  assert.match(plain, /Git\s+1 untracked file/);
  assert.match(plain, /Upstream\s+1 ahead · 1 behind \(commits\) · develop/);
  w.env.FORCE_COLOR = "1";
  const colored = w.rl(["status", "--workspace"], { cwd: w.a }).stdout;
  assert.match(colored, /\x1b\[/);
  w.env.NO_COLOR = "1";
  const disabled = w.rl(["status", "--workspace"], { cwd: w.a }).stdout;
  assert.doesNotMatch(disabled, /\x1b/);
  delete w.env.NO_COLOR;
  w.env.TERM = "dumb";
  assert.doesNotMatch(
    w.rl(["status", "--workspace"], { cwd: w.a }).stdout,
    /\x1b/,
  );
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
