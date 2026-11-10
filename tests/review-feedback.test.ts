import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, write } from "./helpers.js";

function send(w: Workspace, args: string[], ok = true) {
  return JSON.parse(
    w.rl(["feedback", "feature/a", ...args, "--json"], { cwd: w.repo, ok })
      .stdout,
  );
}
function session(w: Workspace, agent = "codex", root = w.a) {
  const id = randomUUID();
  w.rl(["agent", "save", agent, id], { cwd: root });
  return id;
}
function recorder(w: Workspace, agent = "codex") {
  w.stub(
    agent,
    `const fs=require('node:fs');if(process.argv[2]==='app-server')process.exit(0);const input=process.argv.includes('--print')||process.argv[2]==='exec'?fs.readFileSync(0,'utf8'):'';fs.appendFileSync(process.env.AGENT_LOG,JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input})+'\\n');process.exit(Number(process.env.AGENT_EXIT||0));`,
  );
}
test("saved feedback survives without an agent and is restored to the correct workspace through normal hook context", (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "feature.ts"), "implementation\n");
  const item = send(w, [
    "--message",
    "Reuse the existing helper and add a regression test.",
  ]);
  assert.equal(item.status, "saved");
  assert.ok(!fs.existsSync(w.log));
  const entries = send(w, ["--list"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, item.text);
  const restored = w.hook("claude", randomUUID(), { cwd: w.a }).stdout;
  assert.match(restored, /Pending human review feedback/);
  assert.ok(restored.includes(item.id));
  const other = w.hook("claude", randomUUID(), { cwd: w.b }).stdout;
  assert.ok(!other.includes(item.id));
});
test("feedback is sent only to the selected worktree session and its body is passed over stdin", (t) => {
  const w = new Workspace(t),
    correct = session(w),
    wrong = session(w, "codex", w.b);
  recorder(w);
  const body =
    "Fix duplicated logic. Literal text: $(touch injected) `echo unsafe`";
  const item = send(w, [
    "--message",
    body,
    "--send",
    "--agent",
    "codex",
    "--session",
    correct,
  ]);
  assert.equal(item.status, "delivered");
  assert.equal(item.sessionId, correct);
  const calls = w.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, w.a);
  assert.ok(calls[0].argv.includes(correct));
  assert.ok(!calls[0].argv.includes(wrong));
  assert.ok(calls[0].input.includes(body));
  assert.ok(calls[0].input.includes(item.snapshot));
  assert.ok(!fs.existsSync(path.join(w.a, "injected")));
});
test("cross-worktree or ambiguous session selections never launch an agent and retain the feedback", (t) => {
  const w = new Workspace(t),
    sid = session(w, "codex", w.b);
  session(w, "claude");
  session(w, "codex");
  recorder(w);
  recorder(w, "claude");
  let item = send(
    w,
    ["--message", "Fix the guard", "--send", "--session", sid],
    false,
  );
  assert.equal(item.status, "failed");
  assert.match(item.error, /No matching coding session/);
  assert.ok(!fs.existsSync(w.log));
  item = send(w, ["--message", "Add meaningful validation", "--send"], false);
  assert.match(item.error, /Multiple coding sessions/);
  assert.equal(send(w, ["--list"]).length, 2);
  assert.ok(!fs.existsSync(w.log));
});
test("failed turns retain actionable feedback and can be retried or opened without claiming acknowledged delivery", (t) => {
  const w = new Workspace(t),
    sid = session(w);
  recorder(w);
  w.env.AGENT_EXIT = "7";
  const failed = send(
    w,
    ["--message", "Correct the persistence bug", "--send", "--session", sid],
    false,
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /failed \(7\)/);
  delete w.env.AGENT_EXIT;
  const retry = send(w, ["--retry", failed.id, "--resume", "--session", sid]);
  assert.equal(retry.id, failed.id);
  assert.equal(retry.status, "opened");
  assert.equal(send(w, ["--list"]).length, 1);
  const delivered = send(w, ["--retry", failed.id, "--send", "--session", sid]);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.error, undefined);
});
test("recently working sessions are not sent a competing turn, and missing executables never produce false delivery", (t) => {
  const w = new Workspace(t),
    sid = session(w);
  w.hook("codex", sid, { event: "UserPromptSubmit" });
  recorder(w);
  const blocked = send(
    w,
    [
      "--message",
      "Review this when the current turn finishes",
      "--send",
      "--session",
      sid,
    ],
    false,
  );
  assert.match(blocked.error, /recently observed working/);
  assert.ok(!fs.existsSync(w.log));
  w.hook("codex", sid, { event: "Stop" });
  fs.unlinkSync(path.join(w.bin, "codex"));
  // A failing executable stub keeps this test independent of any installed paid CLI.
  w.stub("codex", "console.error('codex unavailable');process.exit(127)");
  const missing = send(
    w,
    ["--retry", blocked.id, "--send", "--session", sid],
    false,
  );
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /127/);
});
test("Claude correction turns use the saved UUID and file input is preserved verbatim", (t) => {
  const w = new Workspace(t),
    sid = session(w, "claude");
  recorder(w, "claude");
  const item = JSON.parse(
    w.rl(
      [
        "feedback",
        "feature/a",
        "--file",
        "-",
        "--send",
        "--agent",
        "claude",
        "--session",
        sid,
        "--json",
      ],
      {
        cwd: w.repo,
        input: "Fix the validation\n\nAdd the missing regression.",
      },
    ).stdout,
  );
  assert.equal(item.status, "delivered");
  const call = w.calls()[0];
  assert.ok(call.argv.includes("--resume"));
  assert.ok(call.argv.includes(sid));
  assert.equal(call.cwd, w.a);
  assert.match(call.input, /Fix the validation\n\nAdd the missing regression/);
});
