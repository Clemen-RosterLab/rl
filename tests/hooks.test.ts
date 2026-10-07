import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, readJson, read, write } from "./helpers.js";

for (const agent of ["codex", "claude"]) {
  test(`${agent} lifecycle separates activity, child sessions, and resumable history`, (t) => {
    const w = new Workspace(t),
      sid = randomUUID();
    const initial = JSON.parse(w.hook(agent, sid).stdout);
    assert.equal(initial.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(w.hook(agent, sid, { event: "UserPromptSubmit" }).stdout, "");
    assert.equal(w.status().activity[agent][0].state, "working");
    const sessions = w.status().sessions;
    w.hook(agent, sid, {
      event: "SubagentStart",
      extra: { agent_id: "child-1" },
    });
    assert.deepEqual(w.status().sessions, sessions);
    assert.equal(
      w.status().activity[agent].find((a: { childId?: string }) => a.childId)
        .state,
      "working",
    );
    assert.deepEqual(
      JSON.parse(
        w.hook(agent, sid, {
          event: "SubagentStop",
          extra: { agent_id: "child-1" },
        }).stdout,
      ),
      {},
    );
    assert.equal(
      w.status().activity[agent].find((a: { childId?: string }) => !a.childId)
        .state,
      "working",
    );
    assert.deepEqual(
      JSON.parse(
        w.hook(agent, sid, { event: "Stop", extra: { stop_hook_active: true } })
          .stdout,
      ),
      {},
    );
    assert.equal(
      w.status().activity[agent].find((a: { childId?: string }) => !a.childId)
        .state,
      "idle",
    );
    assert.equal(w.hook(agent, sid, { event: "SessionEnd" }).stdout, "");
    assert.equal(
      w.status().activity[agent].find((a: { childId?: string }) => !a.childId)
        .state,
      "ended",
    );
    assert.equal(w.status().status, "active");
    assert.deepEqual(w.status().sessions, sessions);
  });
  test(`${agent} context refreshes only when changed and startup restores it after compaction`, (t) => {
    const w = new Workspace(t),
      sid = randomUUID();
    w.hook(agent, sid);
    w.rl(["progress", "append", "-"], {
      cwd: w.a,
      input: "Next: finish the integration",
    });
    assert.match(
      w.hook(agent, sid, { event: "UserPromptSubmit" }).stdout,
      /finish the integration/,
    );
    assert.equal(w.hook(agent, sid, { event: "UserPromptSubmit" }).stdout, "");
    assert.match(
      w.hook(agent, sid, { extra: { source: "compact" } }).stdout,
      /finish the integration/,
    );
    assert.equal(w.status().activity[agent][0].state, "working");
    assert.equal(w.status().sessions[agent].length, 1);
    assert.equal(w.status().activity[agent].length, 1);
  });
}

test("doctor distinguishes installed hooks, observed events, stale activity, and historical errors without writing state", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  w.stub("codex", "console.log('codex-cli 1.2.3');");
  let report = JSON.parse(
    w.rl(["doctor", "codex", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(report.agents[0].installed, true);
  assert.equal(report.agents[0].lastSuccess, null);
  assert.equal(report.agents[0].compatibility, "unverified");
  assert.equal(report.agents[0].trust, "unknown");
  assert.equal(report.agents[0].version, "codex-cli 1.2.3");
  w.hook("codex", sid);
  const failed = w.hook("codex", "--last", { ok: false });
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /UUID/);
  const file = path.join(w.status().stateDirectory, "instance.json"),
    data = readJson(file);
  data.activity.codex[0].state = "working";
  data.activity.codex[0].observedAt = "2000-01-01T00:00:00.000Z";
  write(file, JSON.stringify(data));
  const before = read(file);
  report = JSON.parse(w.rl(["doctor", "codex", "--json"], { cwd: w.a }).stdout);
  assert.equal(report.agents[0].lastSuccess.event, "SessionStart");
  assert.match(report.agents[0].lastError.message, /UUID/);
  assert.equal(report.agents[0].activity[0].state, "stale");
  assert.equal(read(file), before);
  assert.equal(w.status().activity.codex[0].state, "stale");
  assert.equal(read(file), before);
  const config = path.join(w.a, ".codex/hooks.json"),
    hooks = readJson(config);
  delete hooks.hooks.Stop;
  write(config, JSON.stringify(hooks));
  report = JSON.parse(
    w.rl(["doctor", "codex", "--json"], { cwd: w.a, ok: false }).stdout,
  );
  assert.deepEqual(report.agents[0].missingEvents, ["Stop"]);
  w.rl(["adopt"], { cwd: w.a });
  assert.equal(
    JSON.parse(w.rl(["doctor", "codex", "--json"], { cwd: w.a }).stdout)
      .agents[0].installed,
    true,
  );
  write(config, "{bad");
  assert.match(
    JSON.parse(
      w.rl(["doctor", "codex", "--json"], { cwd: w.a, ok: false }).stdout,
    ).agents[0].configError,
    /Cannot read/,
  );
});

test("observed Codex thread IDs are separate from verified CLI resume identifiers", (t) => {
  const w = new Workspace(t);
  w.hook("codex", "thr_example");
  assert.equal(w.status().activity.codex[0].resumable, false);
  assert.deepEqual(w.status().sessions.codex, []);
  w.rl(["resume", "codex"], { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(w.log));
  w.hook("codex", "thr_example", { cwd: w.b, ok: false });
  assert.deepEqual(w.status(w.b).activity.codex, []);
});

test("copied hook events and changed branches cannot write diagnostics to another instance", (t) => {
  const w = new Workspace(t),
    a = path.join(w.status().stateDirectory, "instance.json"),
    b = path.join(w.status(w.b).stateDirectory, "instance.json");
  const before = [read(a), read(b)];
  w.hook("codex", randomUUID(), {
    cwd: w.b,
    hookRoot: w.a,
    event: "Stop",
    ok: false,
  });
  assert.deepEqual([read(a), read(b)], before);
  w.git(w.a, "checkout", "-q", "-b", "changed");
  w.hook("codex", randomUUID(), { event: "SessionEnd", ok: false });
  assert.equal(read(a), before[0]);
});

test("late Stop events do not change which session resumes, and missing CLIs are reported", (t) => {
  const w = new Workspace(t),
    first = randomUUID(),
    latest = randomUUID();
  w.hook("claude", first);
  w.hook("claude", latest);
  w.hook("claude", first, { event: "Stop" });
  w.rl(["resume", "claude"], { cwd: w.a });
  assert.deepEqual(w.calls().at(-1).argv.slice(1), ["--resume", latest]);
  w.stub("claude", "process.exit(42);");
  const report = JSON.parse(
    w.rl(["doctor", "claude", "--json"], { cwd: w.a, ok: false }).stdout,
  );
  assert.equal(report.agents[0].cliAvailable, false);
  assert.match(report.agents[0].cliError, /failed/);
});

test("edits beyond the context excerpt still refresh the next prompt", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  w.rl(["context", "set", "-"], { cwd: w.a, input: "x".repeat(13000) });
  w.hook("codex", sid);
  assert.equal(w.hook("codex", sid, { event: "UserPromptSubmit" }).stdout, "");
  w.rl(["context", "append", "-"], {
    cwd: w.a,
    input: "New decision beyond excerpt",
  });
  assert.match(
    w.hook("codex", sid, { event: "UserPromptSubmit" }).stdout,
    /Excerpt truncated/,
  );
});

test("manual session registration respects ownership established by stop-only observations", (t) => {
  const w = new Workspace(t),
    sid = randomUUID();
  w.hook("claude", sid, { event: "Stop" });
  assert.deepEqual(w.status().sessions.claude, []);
  w.rl(["session", "add", "claude", sid], { cwd: w.b, ok: false });
  assert.deepEqual(w.status(w.b).sessions.claude, []);
});

test("extended hooks are opt-in and preserve notification activity and session ownership", (t) => {
  const w = new Workspace(t);
  const sid = randomUUID();
  assert.equal(
    readJson(path.join(w.a, ".codex/hooks.json")).hooks.Interrupt,
    undefined,
  );
  w.rl(["adopt", "--extended-hooks"], { cwd: w.a });
  assert.equal(
    readJson(path.join(w.a, ".codex/hooks.json")).hooks.Interrupt[0].hooks[0]
      .timeout,
    3,
  );
  for (const agent of ["codex", "claude"]) {
    w.hook(agent, sid);
    w.hook(agent, sid, { event: "UserPromptSubmit" });
    if (agent === "claude") {
      assert.equal(w.hook(agent, sid, { event: "Notification" }).stdout, "");
      assert.equal(w.status().activity.claude[0].state, "working");
    }
    assert.equal(
      w.hook(agent, sid, {
        event: agent === "codex" ? "Interrupt" : "StopFailure",
      }).stdout,
      "",
    );
    assert.equal(w.status().activity[agent][0].state, "idle");
    assert.equal(w.status().sessions[agent].length, 1);
  }
  w.rl(["doctor", "--repair", "--json"], { cwd: w.a });
  assert.ok(
    readJson(path.join(w.a, ".claude/settings.local.json")).hooks.StopFailure,
  );
});
