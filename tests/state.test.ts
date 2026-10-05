import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CLI, Workspace, read, write, readJson } from "./helpers.js";

test("explicit resumes select last used UUID independently for each agent and instance", (t) => {
  const w = new Workspace(t),
    [a1, a2, b1, claude] = Array.from({ length: 4 }, () => randomUUID());
  w.hook("codex", a1);
  w.hook("codex", a2);
  w.hook("codex", b1, { cwd: w.b });
  w.hook("claude", claude);
  w.hook("codex", a1, { event: "UserPromptSubmit" });
  const sub = path.join(w.a, "nested");
  fs.mkdirSync(sub);
  w.rl(["resume", "codex"], { cwd: sub });
  w.rl(["resume", "claude"], { cwd: w.a });
  w.rl(["resume", "codex"], { cwd: w.b });
  assert.deepEqual(
    w.calls().map((c) => c.argv.slice(1)),
    [
      ["resume", a1],
      ["--resume", claude],
      ["resume", b1],
    ],
  );
  assert.deepEqual(
    w.calls().map((c) => c.cwd),
    [w.a, w.a, w.b],
  );
  assert.equal(w.status().sessions.codex.length, 2);
  assert.equal(w.status().sessions.claude.length, 1);
});
test("missing sessions, outside directories and latest flags never launch agents", (t) => {
  const w = new Workspace(t);
  w.rl(["resume", "codex"], { cwd: w.a, ok: false });
  w.rl(["resume", "claude"], { ok: false });
  w.rl(["resume", "codex", "--last"], { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(w.log));
});
test("hooks reject mismatches, fuzzy session IDs and association with another instance", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  w.hook("codex", sid, { cwd: w.b, hookRoot: w.a, ok: false });
  w.hook("claude", "--continue", { ok: false });
  w.hook("codex", "session-name", { ok: false });
  w.hook("codex", sid, { extra: { agent_id: "child" } });
  assert.deepEqual(w.status().sessions, { codex: [], claude: [] });
  w.hook("codex", sid);
  w.hook("codex", sid, { cwd: w.b, ok: false });
  assert.deepEqual(w.status(w.b).sessions.codex, []);
});
test("manual registration and failed agent preserve usage timestamp and exit status", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  w.rl(["session", "add", "claude", sid], { cwd: w.a });
  const before = w.status().sessions.claude;
  w.env.AGENT_EXIT = "17";
  assert.equal(w.rl(["resume", "claude"], { cwd: w.a, ok: false }).status, 17);
  assert.deepEqual(w.status().sessions.claude, before);
});
test("shared context reaches both agents and remains isolated from other instances", (t) => {
  const w = new Workspace(t);
  w.rl(["context", "set", "-"], {
    cwd: w.a,
    input: "Fixed shifts domain rules\n",
  });
  w.rl(["progress", "set", "-"], {
    cwd: w.a,
    input: "Done: parser. Next: UI.\n",
  });
  for (const agent of ["codex", "claude"]) {
    const text = JSON.parse(w.hook(agent, randomUUID()).stdout)
      .hookSpecificOutput.additionalContext;
    assert.match(text, /Fixed shifts domain rules/);
    assert.match(text, /Next: UI/);
  }
  assert.doesNotMatch(
    w.rl(["context", "show"], { cwd: w.b }).stdout,
    /Fixed shifts/,
  );
  assert.equal(
    read(path.join(w.status().stateDirectory, "progress.md")),
    "Done: parser. Next: UI.\n",
  );
});
test("concurrent hook processes preserve every session", async (t) => {
  const w = new Workspace(t),
    ids = Array.from({ length: 12 }, () => randomUUID()),
    command = w.hookCommand("codex");
  await Promise.all(
    ids.map((sid) =>
      w.commandAsync(["/bin/sh", "-c", command], {
        cwd: w.a,
        input: JSON.stringify({
          session_id: sid,
          cwd: w.a,
          hook_event_name: "SessionStart",
        }),
      }),
    ),
  );
  assert.deepEqual(
    new Set(w.status().sessions.codex.map((s: { id: string }) => s.id)),
    new Set(ids),
  );
});
test("subagents and new agents receive latest documentation without registering child sessions", (t) => {
  const w = new Workspace(t);
  const sub = path.join(w.a, "nested");
  fs.mkdirSync(sub);
  for (const agent of ["codex", "claude"]) {
    const sid = randomUUID();
    w.hook(agent, sid);
    w.rl(["progress", "append", "-"], {
      cwd: w.a,
      input: `Completed ${agent} adapter. Remaining: review.`,
    });
    const before = w.status().sessions;
    const output = JSON.parse(
      w.hook(agent, sid, {
        event: "SubagentStart",
        cwd: sub,
        hookRoot: w.a,
        extra: { agent_id: "worker-1" },
      }).stdout,
    ).hookSpecificOutput;
    assert.equal(output.hookEventName, "SubagentStart");
    assert.ok(output.additionalContext.includes(`Completed ${agent} adapter`));
    assert.match(output.additionalContext, /before finishing your task/);
    assert.deepEqual(w.status().sessions, before);
    assert.match(w.hook(agent, randomUUID()).stdout, /Remaining: review/);
    w.hook(agent, sid, {
      event: "SubagentStart",
      cwd: w.b,
      hookRoot: w.a,
      ok: false,
    });
  }
});
test("concurrent documentation append processes retain each update exactly once", async (t) => {
  const w = new Workspace(t),
    updates = Array.from(
      { length: 10 },
      (_, i) => `Completed step ${i}; remaining step ${i + 1}.`,
    );
  await Promise.all(
    updates.map((input) =>
      w.commandAsync([CLI, "progress", "append", "-"], { cwd: w.a, input }),
    ),
  );
  const text = w.rl(["progress", "show"], { cwd: w.a }).stdout;
  for (const update of updates) assert.equal(text.split(update).length - 1, 1);
  assert.equal(text.split("### Update ").length - 1, 10);
});
test("adoption is idempotent and preserves unrelated hooks and settings", (t) => {
  const w = new Workspace(t),
    target = path.join(w.a, ".claude/settings.local.json"),
    config = readJson(target);
  config.permissions = { allow: ["Read"] };
  const custom = { hooks: [{ type: "command", command: "echo unrelated" }] };
  config.hooks.SessionStart.unshift(custom);
  write(target, JSON.stringify(config));
  w.rl(["adopt"], { cwd: w.a });
  const once = read(target);
  w.rl(["adopt"], { cwd: w.a });
  assert.equal(read(target), once);
  assert.deepEqual(readJson(target).permissions, { allow: ["Read"] });
  assert.deepEqual(readJson(target).hooks.SessionStart[0], custom);
  write(target, "{broken");
  w.rl(["adopt"], { cwd: w.a, ok: false });
  assert.equal(read(target), "{broken");
});
test("adoption preserves preexisting work, saved notes and session ownership", (t) => {
  const w = new Workspace(t),
    old = path.join(w.root, "existing task");
  w.git(w.repo, "worktree", "add", "-q", "-b", "old-task", old);
  write(path.join(old, "draft.txt"), "unfinished");
  const head = w.git(old, "rev-parse", "HEAD");
  w.rl(["adopt"], { cwd: old });
  w.rl(["context", "set", "-"], {
    cwd: old,
    input: "Existing domain knowledge",
  });
  const sid = randomUUID();
  w.hook("codex", sid, { cwd: old });
  w.rl(["adopt"], { cwd: old });
  assert.equal(read(path.join(old, "draft.txt")), "unfinished");
  assert.equal(w.git(old, "rev-parse", "HEAD"), head);
  assert.equal(w.status(old).sessions.codex[0].id, sid);
  assert.equal(
    w.rl(["context", "show"], { cwd: old }).stdout,
    "Existing domain knowledge",
  );
});
test("branch changes cannot silently retarget an instance", (t) => {
  const w = new Workspace(t);
  w.git(w.a, "checkout", "-q", "-b", "different");
  for (const command of [["status"], ["resume", "codex"], ["adopt"]])
    w.rl(command, { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(w.log));
});
test("copied hooks rebind and generated files remain ignored", (t) => {
  const w = new Workspace(t),
    target = path.join(w.b, ".codex/hooks.json");
  write(target, read(path.join(w.a, ".codex/hooks.json")));
  w.rl(["adopt"], { cwd: w.b });
  assert.equal(readJson(target).hooks.SessionStart.length, 1);
  w.hook("codex", randomUUID(), { cwd: w.b });
  assert.deepEqual(w.status().sessions.codex, []);
  assert.equal(w.status(w.b).sessions.codex.length, 1);
  assert.equal(w.git(w.b, "status", "--porcelain"), "");
});
test("hook installation refuses symlinked configuration", (t) => {
  const w = new Workspace(t),
    target = path.join(w.a, ".claude/settings.local.json"),
    destination = path.join(w.root, "other-settings.json");
  write(destination, "{}");
  fs.unlinkSync(target);
  fs.symlinkSync(destination, target);
  w.rl(["adopt"], { cwd: w.a, ok: false });
  assert.equal(read(destination), "{}");
});
test("corrupt metadata fails closed", (t) => {
  const w = new Workspace(t),
    file = path.join(w.status().stateDirectory, "instance.json");
  write(file, "{invalid");
  w.rl(["resume", "codex"], { cwd: w.a, ok: false });
  w.rl(["adopt"], { cwd: w.a, ok: false });
  assert.equal(read(file), "{invalid");
  assert.ok(!fs.existsSync(w.log));
});
test("deletion retains history and recreation starts with a distinct identity", (t) => {
  const w = new Workspace(t),
    root = w.managed("task");
  w.hook("codex", randomUUID(), { cwd: root });
  w.rl(["context", "set", "-"], {
    cwd: root,
    input: "Keep these domain notes",
  });
  const before = w.status(root);
  w.rl(["delete", "task"]);
  const archived = readJson(path.join(before.stateDirectory, "instance.json"));
  assert.equal(archived.status, "deleted");
  assert.deepEqual(archived.sessions, before.sessions);
  assert.equal(
    read(path.join(before.stateDirectory, "context.md")),
    "Keep these domain notes",
  );
  w.managed("task");
  assert.notEqual(w.status(root).key, before.key);
  assert.deepEqual(w.status(root).sessions.codex, []);
});
test("PR sync validates repository and branch and retains cached data on errors", (t) => {
  const w = new Workspace(t);
  w.stub(
    "gh",
    `console.log(process.argv[2] === 'repo' ? JSON.stringify({ nameWithOwner: 'example/repo', url: 'https://github.com/example/repo' }) : process.env.PR_JSON);`,
  );
  w.env.PR_JSON = JSON.stringify({
    number: 42,
    url: "https://github.com/example/repo/pull/42",
    state: "OPEN",
    title: "Feature A",
    headRefName: "feature/a",
    baseRefName: "develop",
    isDraft: true,
    updatedAt: "2026-10-01T00:00:00Z",
  });
  w.rl(["pr", "sync"], { cwd: w.a });
  const saved = w.status().pr;
  assert.equal(saved.number, 42);
  assert.ok(saved.syncedAt);
  w.rl(["pr", "sync", "42"], { cwd: w.b, ok: false });
  assert.equal(w.status(w.b).pr, null);
  w.rl(["pr", "sync", "https://github.com/unrelated/repo/pull/42"], {
    cwd: w.a,
    ok: false,
  });
  w.env.PR_JSON = "not json";
  w.rl(["pr", "sync"], { cwd: w.a, ok: false });
  assert.deepEqual(w.status().pr, saved);
});
test("legacy Python timestamps retain microsecond ordering and unknown fields survive writes", (t) => {
  const w = new Workspace(t),
    status = w.status(),
    file = path.join(status.stateDirectory, "instance.json"),
    data = readJson(file),
    [older, newer] = [randomUUID(), randomUUID()];
  data.sessions.codex = [
    {
      id: newer,
      createdAt: "2026-10-01T00:00:00.000002+00:00",
      lastUsedAt: "2026-10-01T00:00:00.000002+00:00",
    },
    {
      id: older,
      createdAt: "2026-10-01T00:00:00.000001+00:00",
      lastUsedAt: "2026-10-01T00:00:00.000001+00:00",
    },
  ];
  data.futureField = { retained: true };
  write(file, JSON.stringify(data));
  w.rl(["resume", "codex"], { cwd: w.a });
  assert.deepEqual(w.calls()[0].argv.slice(1), ["resume", newer]);
  assert.deepEqual(readJson(file).futureField, { retained: true });
});
