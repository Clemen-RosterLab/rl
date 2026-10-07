import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

const notes = {
  summary: "Login form task",
  changes: "Added src/login.ts validation",
  validation: "npm test passed; browser checks not run",
  next: "Add the error states and run browser checks",
  blockers: "Need the final copy",
};
function pause(w: Workspace, cwd = w.a, extra: Record<string, unknown> = {}) {
  return JSON.parse(
    w.rl(["pause", "--file", "-", "--json"], {
      cwd,
      input: JSON.stringify({ ...notes, sessionId: randomUUID(), ...extra }),
    }).stdout,
  );
}

test("pause saves the current Codex session and durable handoff together without touching Git or notes", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  w.env.CODEX_THREAD_ID = id;
  const head = w.git(w.a, "rev-parse", "HEAD");
  const progress = w.rl(["progress", "show"], { cwd: w.a }).stdout;
  const nested = path.join(w.a, "nested");
  fs.mkdirSync(nested);
  const result = w.rl(
    [
      "pause",
      "--summary",
      notes.summary,
      "--changes",
      notes.changes,
      "--validation",
      notes.validation,
      "--next",
      notes.next,
      "--blockers",
      notes.blockers,
      "--json",
    ],
    { cwd: nested },
  );
  const handoff = JSON.parse(result.stdout),
    status = w.status();
  assert.equal(handoff.sessionId, id);
  assert.equal(status.task.state, "paused");
  assert.deepEqual(status.task.handoffs, [handoff]);
  assert.equal(status.sessions.codex[0].id, id);
  assert.equal(status.sessions.codex[0].lastUsedAt, handoff.savedAt);
  assert.equal(w.git(w.a, "rev-parse", "HEAD"), head);
  assert.equal(w.git(w.a, "status", "--porcelain"), "");
  assert.equal(w.rl(["progress", "show"], { cwd: w.a }).stdout, progress);
  const injected = w.hook("codex", id).stdout;
  assert.match(injected, /Login form task/);
  assert.match(injected, /rl_task_pause/);
  assert.match(w.rl(["handoff"], { cwd: w.a }).stdout, /Add the error states/);
  assert.match(w.rl(["list"], { cwd: w.a }).stdout, /paused/);
});

test("continue picks the latest paused task and resumes its pinned conversation with handoff context", (t) => {
  const w = new Workspace(t);
  const a = pause(w),
    b = pause(w, w.b, { summary: "Billing task" });
  w.rl(["session", "add", "codex", randomUUID()], { cwd: w.b });
  w.rl(["continue"], { cwd: w.repo });
  const call = w.calls()[0];
  assert.equal(call.cwd, w.b);
  assert.deepEqual(call.argv.slice(1, 3), ["resume", b.sessionId]);
  assert.match(call.argv[3], /Billing task/);
  assert.match(call.argv[3], /Reported validation/);
  assert.match(call.argv[3], /progress\.md/);
  assert.equal(w.status(w.b).task.state, "active");
  // Paused tasks outrank a more recently continued active task.
  w.rl(["continue"], { cwd: w.repo });
  assert.equal(w.calls()[1].argv[2], a.sessionId);
  assert.equal(w.status().task.state, "active");
  w.rl(["continue", "feature/b"], { cwd: w.repo });
  assert.equal(w.calls()[2].argv[2], b.sessionId);
});

test("handoff history survives repeated pause, continuation, and deletion", (t) => {
  const w = new Workspace(t),
    root = w.managed("saved-task");
  const first = pause(w, root);
  w.rl(["continue", "saved-task", "--no-agent"], { cwd: w.repo });
  const second = pause(w, root, {
    summary: "Second milestone",
    sessionId: first.sessionId,
  });
  const status = w.status(root);
  assert.deepEqual(
    status.task.handoffs.map((item: { id: string }) => item.id),
    [first.id, second.id],
  );
  assert.equal(status.task.state, "paused");
  assert.equal(status.task.continuedAt, undefined);
  assert.equal(status.sessions.codex.length, 1);
  w.rl(["delete", "saved-task"], { cwd: w.repo });
  const archived = readJson(path.join(status.stateDirectory, "instance.json"));
  assert.deepEqual(archived.task, status.task);
  assert.equal(archived.status, "deleted");
  w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.ok(!fs.existsSync(w.log));
});

test("invalid handoffs and cross-workspace session ownership leave task state unchanged", (t) => {
  const w = new Workspace(t),
    handoff = pause(w);
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  const invalid = [
    { ...notes, next: "" },
    { ...notes, validation: null },
    { ...notes, blockers: null },
    { ...notes, summary: "x".repeat(16001) },
    { ...notes, sessionId: "--last" },
    { ...notes, agent: "other" },
    { ...notes, cwd: w.b },
    { ...notes, changes: "bad\0text" },
  ];
  for (const input of invalid)
    w.rl(["pause", "--file", "-"], {
      cwd: w.a,
      input: JSON.stringify({ sessionId: handoff.sessionId, ...input }),
      ok: false,
    });
  assert.equal(read(file), before);
  w.rl(["pause", "--file", "-"], {
    cwd: w.b,
    input: JSON.stringify({ ...notes, sessionId: handoff.sessionId }),
    ok: false,
  });
  assert.equal(w.status(w.b).task, undefined);
  assert.deepEqual(w.status(w.b).sessions.codex, []);
});

test("continue preserves paused state and session usage on agent failure or missing executable", (t) => {
  const w = new Workspace(t),
    handoff = pause(w);
  const before = w.status().sessions.codex;
  w.env.AGENT_EXIT = "7";
  const result = w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.equal(result.status, 7, result.stderr + result.stdout);
  assert.equal(w.status().task.state, "paused");
  assert.equal(w.status().task.continuedAt, undefined);
  assert.deepEqual(w.status().sessions.codex, before);
  w.stub("codex", "process.exit(1)");
  w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.equal(w.status().task.handoffs[0].id, handoff.id);
  fs.unlinkSync(path.join(w.bin, "codex"));
  fs.symlinkSync(process.execPath, path.join(w.bin, "node"));
  w.env.PATH = `${w.bin}:/usr/bin:/bin`;
  w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.equal(w.status().task.state, "paused");
});

test("a new pause written by the resumed agent survives its nonzero exit", (t) => {
  const w = new Workspace(t),
    original = pause(w);
  w.env.CHILD_HANDOFF = JSON.stringify({
    ...notes,
    summary: "Saved while running",
    sessionId: original.sessionId,
  });
  w.stub(
    "codex",
    `
if (process.argv[2] === 'app-server') process.exit(0);
const result = require('node:child_process').spawnSync(${JSON.stringify(CLI)}, ['pause', '--file', '-'], {
  input: process.env.CHILD_HANDOFF, env: process.env, encoding: 'utf8'
});
if (result.status !== 0) { console.error(result.stderr); process.exit(99); }
process.exit(7);
`,
  );
  const result = w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.equal(result.status, 7, result.stderr + result.stdout);
  const task = w.status().task;
  assert.equal(task.state, "paused");
  assert.equal(task.handoffs.length, 2);
  assert.equal(task.handoffs[1].summary, "Saved while running");
});

test("missing and switched workspaces cannot silently retarget a paused task", (t) => {
  const w = new Workspace(t);
  pause(w);
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  w.git(w.a, "checkout", "-q", "-b", "different");
  w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.equal(read(file), before);
  assert.ok(!fs.existsSync(w.log));
  w.git(w.a, "checkout", "-q", "feature/a");
  w.git(w.repo, "worktree", "remove", "--force", w.a);
  w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.equal(read(file), before);
});

test("concurrent pauses retain every checkpoint and keep one session association", async (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      w.commandAsync([CLI, "pause", "--file", "-"], {
        cwd: w.a,
        input: JSON.stringify({
          ...notes,
          summary: `Checkpoint ${i}`,
          sessionId: id,
        }),
      }),
    ),
  );
  const status = w.status();
  assert.equal(status.task.handoffs.length, 5);
  assert.equal(
    new Set(
      status.task.handoffs.map((item: { summary: string }) => item.summary),
    ).size,
    5,
  );
  assert.equal(status.sessions.codex.length, 1);
});

test("MCP pause saves the handoff visible in status and exports a bounded mutation schema", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  const request = (input: Record<string, unknown>, cwd = w.a) => {
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rl_task_pause", arguments: input },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "rl_status" },
      },
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
    ];
    return w
      .rl(["mcp"], {
        cwd,
        input: messages.map((item) => JSON.stringify(item)).join("\n") + "\n",
      })
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const replies = request({ ...notes, sessionId: id });
  assert.equal(replies[1].result.isError, undefined);
  const status = JSON.parse(replies[2].result.content[0].text);
  assert.equal(status.task.handoffs[0].sessionId, id);
  assert.equal(status.task.state, "paused");
  const schema = replies[3].result.tools.find(
    (tool: { name: string }) => tool.name === "rl_task_pause",
  );
  assert.equal(schema.annotations.readOnlyHint, false);
  assert.equal(schema.inputSchema.additionalProperties, false);
  assert.deepEqual(schema.inputSchema.required, [
    "summary",
    "changes",
    "validation",
    "next",
  ]);
  assert.equal(
    request({ ...notes, sessionId: id }, w.b)[1].result.isError,
    true,
  );
  assert.equal(
    request({ ...notes, sessionId: id, path: "other" })[1].result.isError,
    true,
  );
  assert.equal(
    request({ ...notes, sessionId: id, next: "" })[1].result.isError,
    true,
  );
  w.rl(["continue"], { cwd: w.repo });
  assert.equal(w.calls()[0].argv[2], id);
});

test("continue switches both zsh and bash to the saved workspace without launching in no-agent mode", (t) => {
  const w = new Workspace(t);
  pause(w);
  for (const shell of ["zsh", "bash"]) {
    const script = `eval "$(${JSON.stringify(CLI)} init ${shell})"\nrl continue --no-agent\n[[ "$PWD" == "$EXPECTED_WORKSPACE" ]]\n`;
    w.env.EXPECTED_WORKSPACE = w.a;
    w.command(
      [
        shell,
        ...(shell === "zsh" ? ["-f"] : ["--noprofile", "--norc"]),
        "-c",
        script,
      ],
      { cwd: w.repo },
    );
  }
  assert.ok(!fs.existsSync(w.log));
});

test("task metadata validation rejects corrupt resume identifiers before any agent launch", (t) => {
  const w = new Workspace(t);
  pause(w);
  const file = path.join(w.status().stateDirectory, "instance.json"),
    data = readJson(file);
  data.task.handoffs[0].sessionId = "--last";
  write(file, JSON.stringify(data));
  w.rl(["continue"], { cwd: w.repo, ok: false });
  assert.ok(!fs.existsSync(w.log));
});

test("Claude handoffs require an explicit session and continue with Claude's resume command", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  pause(w, w.a, { agent: "claude", sessionId: id });
  w.rl(["continue"], { cwd: w.repo });
  assert.deepEqual(w.calls()[0].argv.slice(1, 3), ["--resume", id]);
  assert.match(w.calls()[0].argv[3], /Login form task/);
  w.rl(["pause", "--file", "-"], {
    cwd: w.a,
    input: JSON.stringify({ ...notes, agent: "claude" }),
    ok: false,
  });
});

test("continue follows repository routing and never chooses another repository's paused task", (t) => {
  const w = new Workspace(t);
  w.rl(["repo", "add", "alpha", w.repo]);
  const first = pause(w);
  const other = path.join(w.root, "other test repository");
  w.command(["git", "init", "-q", "-b", "main", other]);
  w.git(other, "commit", "-q", "--allow-empty", "-m", "Initial");
  w.rl(["repo", "add", "beta", other]);
  w.rl(["--repo", "beta", "new", "other-task", "--no-fetch"]);
  const root = path.join(w.root, "worktrees", "beta", "other-task");
  const second = pause(w, root);
  w.rl(["--repo", "alpha", "continue"], { cwd: other });
  assert.equal(w.calls()[0].argv[2], first.sessionId);
  assert.equal(w.calls()[0].cwd, w.a);
  assert.equal(w.status(root).task.state, "paused");
  w.rl(["continue"], { cwd: root });
  assert.equal(w.calls()[1].argv[2], second.sessionId);
  assert.equal(w.calls()[1].cwd, root);
});
