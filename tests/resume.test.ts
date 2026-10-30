import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write, sessionPicker } from "./helpers.js";

for (const agent of ["codex", "claude"]) {
  test(`bare resume automatically launches the only ${agent} session in the current workspace`, (t) => {
    const w = new Workspace(t),
      id = randomUUID();
    w.rl(["session", "add", agent, id], { cwd: w.a });
    w.rl(
      ["session", "add", agent === "codex" ? "claude" : "codex", randomUUID()],
      { cwd: w.b },
    );
    const capture = sessionPicker(w);
    w.env.RESUME_PICKER_EXIT = "99";
    const nested = path.join(w.a, "nested");
    fs.mkdirSync(nested);
    w.rl(["resume"], { cwd: nested });
    assert.deepEqual(
      w.calls()[0].argv.slice(1),
      agent === "codex" ? ["resume", id] : ["--resume", id],
    );
    assert.equal(w.calls()[0].cwd, w.a);
    assert.ok(!fs.existsSync(capture));
  });
}

test("bare resume offers both agents and can select an older session with the same UUID", (t) => {
  const w = new Workspace(t),
    id = randomUUID();
  w.rl(["session", "add", "claude", id], { cwd: w.a });
  w.rl(["session", "add", "codex", id], { cwd: w.a });
  const neighbor = randomUUID();
  w.rl(["session", "add", "claude", neighbor], { cwd: w.b });
  const capture = sessionPicker(w);
  w.env.RESUME_PICKER_AGENT = "claude";
  w.env.RESUME_PICKER_ID = id;
  w.rl(["resume"], { cwd: w.a });
  const shown = readJson(capture);
  assert.match(shown.input, new RegExp(`codex:${id}`));
  assert.match(shown.input, new RegExp(`claude:${id}`));
  assert.match(shown.input, /Last used:.*Started:/);
  assert.doesNotMatch(shown.input, new RegExp(neighbor));
  assert.ok(!shown.args.includes("--multi"));
  assert.ok(shown.args.includes("--no-multi"));
  assert.equal(shown.cwd, w.a);
  assert.deepEqual(w.calls()[0].argv.slice(1), ["--resume", id]);
});

test("an explicit agent filters the picker and supports selecting an older session", (t) => {
  const w = new Workspace(t),
    older = randomUUID(),
    newer = randomUUID(),
    claude = randomUUID();
  for (const id of [older, newer])
    w.rl(["session", "add", "codex", id], { cwd: w.a });
  w.rl(["session", "add", "claude", claude], { cwd: w.a });
  const capture = sessionPicker(w);
  w.env.RESUME_PICKER_ID = older;
  w.rl(["resume", "codex"], { cwd: w.a });
  assert.doesNotMatch(readJson(capture).input, /claude/);
  assert.deepEqual(w.calls()[0].argv.slice(1), ["resume", older]);
  fs.unlinkSync(capture);
  w.env.RESUME_PICKER_EXIT = "99";
  w.rl(["resume", "claude"], { cwd: w.a });
  assert.ok(!fs.existsSync(capture));
  assert.deepEqual(w.calls()[1].argv.slice(1), ["--resume", claude]);
});

test("latest flags skip the picker and resume the most recently used matching session", (t) => {
  const w = new Workspace(t),
    older = randomUUID(),
    newest = randomUUID(),
    codex = randomUUID();
  w.rl(["session", "add", "claude", older], { cwd: w.a });
  w.rl(["session", "add", "claude", newest], { cwd: w.a });
  w.rl(["session", "add", "codex", codex], { cwd: w.a });
  const file = path.join(w.status().stateDirectory, "instance.json");
  const data = readJson(file);
  // Recency follows use, even when the conversation itself was created earlier.
  Object.assign(data.sessions.claude[0], {
    createdAt: "2026-01-01T00:00:00Z",
    lastUsedAt: "2026-01-02T00:00:00Z",
  });
  Object.assign(data.sessions.claude[1], {
    createdAt: "2025-12-01T00:00:00Z",
    lastUsedAt: "2026-01-04T00:00:00Z",
  });
  Object.assign(data.sessions.codex[0], {
    createdAt: "2026-01-03T00:00:00Z",
    lastUsedAt: "2026-01-03T00:00:00Z",
  });
  data.sessions.codex.push({
    id: randomUUID(),
    createdAt: "2025-11-01T00:00:00Z",
    lastUsedAt: "2026-01-01T00:00:00Z",
  });
  const capture = sessionPicker(w);
  w.env.RESUME_PICKER_EXIT = "99";
  for (const flag of ["--latest", "-l", "--l"]) {
    write(file, JSON.stringify(data));
    w.rl(["resume", flag], { cwd: w.a });
    assert.deepEqual(w.calls().at(-1).argv.slice(1), ["--resume", newest]);
    write(file, JSON.stringify(data));
    w.rl(["resume", "codex", flag], { cwd: w.a });
    assert.deepEqual(w.calls().at(-1).argv.slice(1), ["resume", codex]);
  }
  assert.ok(!fs.existsSync(capture));
  assert.match(
    w.rl(["status", "--workspace", "--latest"], { cwd: w.a, ok: false }).stderr,
    /only supported by rl resume/,
  );
});

test("canceling or receiving an invalid session selection never launches or updates usage", (t) => {
  const w = new Workspace(t);
  for (const agent of ["codex", "claude"])
    w.rl(["session", "add", agent, randomUUID()], { cwd: w.a });
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  sessionPicker(w);
  for (const code of ["1", "130"]) {
    w.env.RESUME_PICKER_EXIT = code;
    w.rl(["resume"], { cwd: w.a });
  }
  w.env.RESUME_PICKER_EXIT = "2";
  assert.match(
    w.rl(["resume"], { cwd: w.a, ok: false }).stderr,
    /Session selector failed/,
  );
  delete w.env.RESUME_PICKER_EXIT;
  w.env.RESUME_PICKER_OUTPUT = `claude:${randomUUID()}`;
  assert.match(
    w.rl(["resume"], { cwd: w.a, ok: false }).stderr,
    /unknown selection/,
  );
  assert.equal(read(file), before);
  assert.ok(!fs.existsSync(w.log));
});

test("a session removed or workspace branch changed during selection cannot launch", (t) => {
  const w = new Workspace(t),
    codex = randomUUID(),
    claude = randomUUID();
  w.rl(["session", "add", "codex", codex], { cwd: w.a });
  w.rl(["session", "add", "claude", claude], { cwd: w.a });
  const file = path.join(w.status().stateDirectory, "instance.json"),
    before = read(file);
  w.env.RESUME_INSTANCE_FILE = file;
  w.stub(
    "fzf",
    "const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');const data=JSON.parse(fs.readFileSync(process.env.RESUME_INSTANCE_FILE,'utf8'));data.sessions.claude=[];fs.writeFileSync(process.env.RESUME_INSTANCE_FILE,JSON.stringify(data));console.log(input.trimEnd().split('\\n').find(line=>line.startsWith('claude:')));",
  );
  assert.match(
    w.rl(["resume"], { cwd: w.a, ok: false }).stderr,
    /No claude session recorded/,
  );
  write(file, before);
  w.stub(
    "fzf",
    "const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');require('node:child_process').execFileSync('git',['checkout','-qb','switched-during-selection']);console.log(input.trimEnd().split('\\n')[0]);",
  );
  assert.match(
    w.rl(["resume"], { cwd: w.a, ok: false }).stderr,
    /Instance owns branch/,
  );
  assert.ok(!fs.existsSync(w.log));
});

test("bare resume with no sessions reports how to save one", (t) => {
  const w = new Workspace(t);
  assert.match(
    w.rl(["resume"], { cwd: w.a, ok: false }).stderr,
    /No session recorded.*rl session save/,
  );
  w.rl(["resume", "invalid-agent"], { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(w.log));
});
