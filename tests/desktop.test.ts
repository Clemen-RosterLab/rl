import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT, Workspace, read, readJson, sessionPicker } from "./helpers.js";

const { desktopLaunch } = await import(
  pathToFileURL(path.join(ROOT, "dist/agent-desktop.js")).href
);

test("desktop commands use native argument arrays without invented Codex session flags", () => {
  const id = randomUUID(),
    worktree = "/repo/my ' workspace $(literal)";
  assert.deepEqual(desktopLaunch("codex", worktree, id), {
    command: ["codex", "app", worktree],
    resumesSession: false,
  });
  assert.deepEqual(desktopLaunch("claude", worktree, id), {
    command: ["claude", "--desktop", "--resume", id],
    resumesSession: true,
  });
  assert.deepEqual(desktopLaunch("claude", worktree).command, [
    "claude",
    "--desktop",
  ]);
  assert.throws(() => desktopLaunch("agy", worktree), /codex or claude/);
  assert.throws(() => desktopLaunch("codex", "relative"), /absolute/);
  assert.throws(() => desktopLaunch("claude", worktree, "--inject"), /UUID/);
});

for (const agent of ["codex", "claude"]) {
  test(`${agent} Desktop opens exactly the selected existing worktree with no new session metadata`, (t) => {
    const w = new Workspace(t),
      nested = path.join(w.a, "nested");
    fs.mkdirSync(nested);
    w.stub(
      agent,
      `if(process.argv[2]==='app-server')process.exit(0);require('node:fs').appendFileSync(process.env.AGENT_LOG,JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),workspace:process.env.RL_WORKSPACE})+'\\n');`,
    );
    w.rl(["agent", "start", agent, "--desktop", "--workspace", "feature/b"], {
      cwd: nested,
    });
    const call = w.calls()[0];
    assert.equal(call.cwd, w.b);
    assert.equal(call.workspace, w.b);
    assert.deepEqual(
      call.argv.slice(1),
      agent === "codex" ? ["app", w.b] : ["--desktop"],
    );
    assert.deepEqual(w.status(w.b).sessions[agent], []);
    assert.equal(w.git(w.a, "branch", "--show-current"), "feature/a");
    assert.equal(w.git(w.b, "branch", "--show-current"), "feature/b");
  });
}

test("Claude desktop resume uses the exact current-worktree session and only records successful launches", (t) => {
  const w = new Workspace(t),
    id = randomUUID(),
    other = randomUUID();
  w.rl(["agent", "save", "claude", id], { cwd: w.a });
  w.rl(["agent", "save", "claude", other], { cwd: w.b });
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  w.env.AGENT_EXIT = "7";
  assert.equal(
    w.rl(["resume", "claude", "--desktop", "--latest"], { cwd: w.a, ok: false })
      .status,
    7,
  );
  assert.equal(read(file), before);
  delete w.env.AGENT_EXIT;
  const nested = path.join(w.a, "nested");
  fs.mkdirSync(nested);
  const result = w.rl(["resume", "claude", "--desktop"], { cwd: nested });
  assert.match(result.stderr, /in Desktop/);
  for (const call of w.calls()) {
    assert.equal(call.cwd, w.a);
    assert.deepEqual(call.argv.slice(1), ["--desktop", "--resume", id]);
  }
  const saved = readJson(file).sessions.claude[0];
  assert.equal(saved.id, id);
  assert.ok(
    saved.lastUsedAt >= JSON.parse(before).sessions.claude[0].lastUsedAt,
  );
});

test("Codex desktop resume opens the saved session's workspace and does not falsely update last-used state", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  w.rl(["agent", "save", "codex", id], { cwd: w.a });
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  const result = w.rl(["resume", "codex", "--desktop", "--latest"], {
    cwd: w.a,
  });
  assert.match(result.stderr, new RegExp(`Select saved conversation ${id}`));
  assert.doesNotMatch(result.stderr, /Resuming codex/);
  assert.deepEqual(w.calls()[0].argv.slice(1), ["app", w.a]);
  assert.equal(w.calls()[0].cwd, w.a);
  assert.equal(read(file), before);
});

test("desktop session selection filters unsupported agents, keeps the workspace boundary and allows cancellation", (t) => {
  const w = new Workspace(t),
    codex = randomUUID(),
    claude = randomUUID(),
    other = randomUUID(),
    agy = randomUUID();
  w.rl(["agent", "save", "codex", codex], { cwd: w.a });
  w.rl(["agent", "save", "claude", claude], { cwd: w.a });
  w.rl(["agent", "save", "agy", agy], { cwd: w.a });
  w.rl(["agent", "save", "claude", other], { cwd: w.b });
  const capture = sessionPicker(w);
  w.env.RESUME_PICKER_AGENT = "claude";
  w.env.RESUME_PICKER_ID = claude;
  w.rl(["resume", "--desktop"], { cwd: w.a });
  const shown = readJson(capture);
  assert.match(shown.input, new RegExp(codex));
  assert.match(shown.input, new RegExp(claude));
  assert.doesNotMatch(shown.input, new RegExp(`${agy}|${other}`));
  assert.match(shown.args.join(" "), /open in desktop/);
  assert.deepEqual(w.calls()[0].argv.slice(1), [
    "--desktop",
    "--resume",
    claude,
  ]);
  w.env.RESUME_PICKER_EXIT = "130";
  w.rl(["resume", "--desktop"], { cwd: w.a });
  assert.equal(w.calls().length, 1);
});

test("desktop launch rejects unsupported combinations before starting an agent or changing configuration", (t) => {
  const w = new Workspace(t);
  const before = read(w.config);
  for (const argv of [
    ["agent", "start", "agy", "--desktop"],
    ["agent", "run", "codex", "--desktop", "--prompt", "hello"],
    ["agent", "start", "claude", "--desktop", "--", "--model", "test"],
    ["resume", "agy", "--desktop"],
    ["status", "--desktop"],
  ])
    w.rl(argv, { cwd: w.a, ok: false });
  assert.equal(fs.existsSync(w.log), false);
  assert.equal(read(w.config), before);
});
