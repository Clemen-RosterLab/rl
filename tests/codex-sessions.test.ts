import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, readJson } from "./helpers.js";

function server(w: Workspace) {
  w.env.CODEX_RPC_LOG = path.join(w.root, "codex-rpc.jsonl");
  w.stub(
    "codex",
    `
const fs = require('node:fs');
if (process.argv[2] !== 'app-server') {
  fs.appendFileSync(process.env.AGENT_LOG, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }) + '\\n');
  process.exit(0);
}
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.CODEX_RPC_LOG, line + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'thread/list') {
    if (process.env.CODEX_SWITCH_BRANCH === '1') {
      require('node:child_process').execFileSync('git', ['checkout', '-q', '-b', 'changed'], { cwd: process.cwd() });
      delete process.env.CODEX_SWITCH_BRANCH;
    }
    const threads = JSON.parse(process.env.CODEX_THREADS || '[]');
    const page = Number(request.params.cursor || 0);
    const pages = process.env.CODEX_PAGES === '1';
    result = { data: pages ? threads.slice(page, page + 1) : threads,
      nextCursor: pages && page + 1 < threads.length ? String(page + 1) : null };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`,
  );
}
function thread(w: Workspace, overrides: Record<string, unknown> = {}) {
  const time = Math.floor(Date.now() / 1000);
  return {
    id: randomUUID(),
    cwd: w.a,
    createdAt: time,
    updatedAt: time,
    source: "cli",
    gitInfo: { branch: "feature/a" },
    ...overrides,
  };
}

test("ordinary Codex sessions are discovered, persisted, shown in overview and resumed without hooks", (t) => {
  const w = new Workspace(t);
  server(w);
  const older = thread(w, { updatedAt: Math.floor(Date.now() / 1000) - 60 });
  const newer = thread(w, { source: "appServer" });
  w.env.CODEX_THREADS = JSON.stringify([newer, older]);
  w.env.CODEX_PAGES = "1";
  const status = w.status();
  assert.deepEqual(
    new Set(status.sessions.codex.map((s: { id: string }) => s.id)),
    new Set([older.id, newer.id]),
  );
  assert.equal(status.hookHealth, undefined);
  assert.deepEqual(status.activity.codex, []);
  assert.deepEqual(
    readJson(path.join(status.stateDirectory, "instance.json")).sessions.codex,
    status.sessions.codex,
  );
  const before = fs.readFileSync(
    path.join(status.stateDirectory, "instance.json"),
    "utf8",
  );
  w.status();
  assert.equal(
    fs.readFileSync(path.join(status.stateDirectory, "instance.json"), "utf8"),
    before,
  );
  assert.equal(
    JSON.parse(w.rl(["session", "list", "codex"], { cwd: w.a }).stdout).length,
    2,
  );
  const table = w.rl(["status", "--list"], { cwd: w.a }).stdout;
  assert.match(table, /CODEX\s+CLAUDE/);
  assert.match(
    table.split("\n").find((line) => line.includes("feature/a")) ?? "",
    /2\s+0\s+-$/,
  );
  w.rl(["resume", "codex"], { cwd: w.a });
  assert.deepEqual(w.calls()[0].argv.slice(1), ["resume", newer.id]);
  const requests = fs
    .readFileSync(w.env.CODEX_RPC_LOG!, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    requests.every((request) =>
      ["initialize", "initialized", "thread/list"].includes(request.method),
    ),
  );
  for (const request of requests.filter(
    (request) => request.method === "thread/list",
  )) {
    assert.ok([w.a, w.b].includes(request.params.cwd));
    assert.equal(request.params.useStateDbOnly, true);
    assert.ok(!request.params.sourceKinds.includes("subAgent"));
  }
});

test("resume discovers a session before status has ever imported it", (t) => {
  const w = new Workspace(t);
  server(w);
  const item = thread(w);
  w.env.CODEX_THREADS = JSON.stringify([item]);
  w.rl(["resume", "codex"], { cwd: w.a });
  assert.deepEqual(w.calls()[0].argv.slice(1), ["resume", item.id]);
});

test("a branch change during discovery cannot save to the previous instance", (t) => {
  const w = new Workspace(t);
  const file = path.join(w.status().stateDirectory, "instance.json");
  server(w);
  w.env.CODEX_THREADS = JSON.stringify([thread(w)]);
  w.env.CODEX_SWITCH_BRANCH = "1";
  w.rl(["status"], { cwd: w.a, ok: false });
  assert.deepEqual(readJson(file).sessions.codex, []);
});

test("discovery rejects other workspaces, branches, unsupported IDs, ephemeral sessions and invalid times", (t) => {
  const w = new Workspace(t);
  server(w);
  const good = thread(w);
  w.env.CODEX_THREADS = JSON.stringify([
    good,
    thread(w, { cwd: w.b }),
    thread(w, { gitInfo: { branch: "different" } }),
    thread(w, { id: "thr_diagnostic" }),
    thread(w, { ephemeral: true }),
    thread(w, { source: { subAgent: { thread_spawn: {} } } }),
    thread(w, { updatedAt: "today" }),
    thread(w, { createdAt: 0, gitInfo: null }),
  ]);
  assert.deepEqual(
    w.status().sessions.codex.map((s: { id: string }) => s.id),
    [good.id],
  );
});

test("discovery preserves established ownership and newer hook timestamps", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  w.hook("codex", id);
  const saved = w.status().sessions.codex;
  server(w);
  w.env.CODEX_THREADS = JSON.stringify([thread(w, { id, updatedAt: 1 })]);
  assert.deepEqual(w.status().sessions.codex, saved);
  w.env.CODEX_THREADS = JSON.stringify([
    thread(w, { id, cwd: w.b, gitInfo: { branch: "feature/b" } }),
  ]);
  assert.deepEqual(w.status(w.b).sessions.codex, []);
});

test("missing, failing and malformed Codex discovery preserves saved status", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  w.rl(["session", "add", "codex", id], { cwd: w.a });
  for (const code of [
    "process.exit(1)",
    "console.log('{bad')",
    "console.log(JSON.stringify({id:1,error:{code:-1}}))",
    "setInterval(() => {}, 1000)",
  ]) {
    w.stub("codex", code);
    assert.equal(w.status().sessions.codex[0].id, id);
  }
  fs.unlinkSync(path.join(w.bin, "codex"));
  // Keep the real installed Codex out of the fixture's PATH.
  fs.symlinkSync(process.execPath, path.join(w.bin, "node"));
  w.env.PATH = `${w.bin}:/usr/bin:/bin`;
  assert.equal(w.status().sessions.codex[0].id, id);
});

test("save uses the current Codex thread UUID and remains idempotent without hooks", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  w.env.CODEX_THREAD_ID = id.toUpperCase();
  w.env.CODEX_SESSION_ID = randomUUID();
  const nested = path.join(w.a, "nested");
  fs.mkdirSync(nested);
  const saved = JSON.parse(
    w.rl(["session", "save", "--json"], { cwd: nested }).stdout,
  );
  assert.deepEqual(saved, {
    agent: "codex",
    sessionId: id,
    instance: "feature/a",
  });
  w.rl(["session", "save", "codex"], { cwd: w.a });
  assert.equal(w.status().sessions.codex.length, 1);
  w.rl(["resume", "codex"], { cwd: w.a });
  assert.deepEqual(w.calls()[0].argv.slice(1), ["resume", id]);
  w.rl(["session", "save", "codex"], { cwd: w.b, ok: false });
  assert.deepEqual(w.status(w.b).sessions.codex, []);
  delete w.env.CODEX_THREAD_ID;
  delete w.env.CODEX_SESSION_ID;
  w.rl(["session", "save"], { cwd: w.a, ok: false });
  w.rl(["session", "save", "claude"], { cwd: w.a, ok: false });
  w.env.CODEX_THREAD_ID = "--last";
  w.rl(["session", "save"], { cwd: w.a, ok: false });
  w.rl(["session", "save", "codex", randomUUID()], { cwd: w.a });
  w.git(w.a, "checkout", "-q", "-b", "changed");
  w.rl(["session", "save", "codex", randomUUID()], { cwd: w.a, ok: false });
});
