import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, write } from "./helpers.js";

interface DiscoveredTool {
  name: string;
  inputSchema: Record<string, unknown>;
  cli: {
    command: string[];
    stdin: string;
    positionals: string[];
    flags: Record<string, string>;
  };
}
const result = {
  summary: "Verified the submitted implementation",
  complete: true,
  findings: [],
  limitations: [],
  checkRequests: [],
  routingLeads: [],
};

test("an existing session discovers and completes the default team using only the advertised CLI protocol", (t) => {
  const w = new Workspace(t);
  const context = JSON.parse(
    w.rl(["workflow", "context", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(context.protocol.coordinator, "current-session");
  assert.equal(context.protocol.requiresMcp, false);
  assert.equal(context.protocol.requiresRlLauncher, false);
  assert.equal(context.protocol.requiresNativeSubagents, true);
  assert.equal(context.protocol.tools.length, 13);
  assert.ok(!fs.existsSync(path.join(w.a, ".rl")));
  const parent = { agent: "claude", sessionId: randomUUID() };
  const call = (action: string, input: Record<string, unknown> = {}) => {
    const tool = context.protocol.tools.find(
      (tool: DiscoveredTool) => tool.name === `rl_workflow_${action}`,
    ) as DiscoveredTool;
    assert.ok(tool, `Discoverable operation: ${action}`);
    const payload = { ...parent, ...input };
    const argv = tool.cli.command.slice(1);
    for (const key of tool.cli.positionals)
      if (payload[key as keyof typeof payload] !== undefined)
        argv.push(String(payload[key as keyof typeof payload]));
    for (const [key, flag] of Object.entries(tool.cli.flags))
      if (payload[key as keyof typeof payload] !== undefined)
        argv.push(flag, String(payload[key as keyof typeof payload]));
    return JSON.parse(
      w.rl(argv, {
        cwd: w.a,
        ...(tool.cli.stdin === "json"
          ? { input: JSON.stringify(payload) }
          : {}),
      }).stdout,
    );
  };
  call("event", { event: "task_planned" });
  const pending = call("pending");
  assert.equal(pending.length, 1);
  const run = call("start", {
    workflow: context.defaultWorkflow,
    requestId: pending[0].id,
    base: "HEAD",
    prompt: "Implement this task in my existing session",
  });
  const peers = Object.fromEntries(
    ["writer", "reviewer", "dry"].map((step) => [
      step,
      call("claim", { run: run.id, step }),
    ]),
  );
  const peer = (
    step: string,
    action: string,
    input: Record<string, unknown> = {},
  ) => call(action, { run: run.id, step, claim: peers[step].claim, ...input });
  for (const step of Object.keys(peers))
    peer(step, "bind", { childId: `existing-session-${step}` });
  assert.equal(peer("writer", "inbox").ready, true);
  const subject = "app.ts#feature";
  const writerQuestion = peer("writer", "consult", {
    to: "dry",
    event: "new_function",
    subject,
    question: "Find an existing implementation before adding this function",
  });
  peer("dry", "answer", {
    requestId: writerQuestion.id,
    text: "Searched current source; no existing implementation matches this task",
  });
  write(
    path.join(w.a, "app.ts"),
    "export function feature() { return true; }\n",
  );
  const submission = peer("writer", "submit", {
    files: ["app.ts"],
    newFunctions: [subject],
    summary: "Stable implementation for review",
  });
  const reviewerQuestion = peer("reviewer", "consult", {
    to: "dry",
    event: "suspected_duplicate",
    subject,
    question: "Check whether the implementation duplicates existing behavior",
  });
  peer("dry", "answer", {
    requestId: reviewerQuestion.id,
    text: "Compared the relevant functions; no duplicate with matching semantics was found",
  });
  const rated = peer("reviewer", "review", {
    submissionId: submission.id,
    rating: 95,
    rationale: "Validated intended behavior and reuse evidence",
    result,
    duplicateSuspicions: [subject],
  });
  assert.equal(rated.review.accepted, true);
  for (const step of ["writer", "reviewer"]) peer(step, "report", { result });
  assert.equal(peer("dry", "report", { result }).evaluation.verdict, "ready");
  assert.deepEqual(call("pending"), []);
  const another = call("event", { event: "task_planned" });
  if (another.length)
    call("dismiss", {
      requestId: another[0].id,
      reason: "No further task requested",
    });
  assert.deepEqual(call("pending"), []);
  assert.ok(
    !fs.existsSync(w.log),
    "RL must not launch a separate provider process",
  );
});

test("MCP and CLI discovery advertise identical workflow input schemas", (t) => {
  const w = new Workspace(t);
  const context = JSON.parse(
    w.rl(["workflow", "context", "--json"], { cwd: w.a }).stdout,
  );
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "discovery-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  const replies = w
    .rl(["agent", "mcp"], {
      cwd: w.a,
      input:
        messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    })
    .stdout.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const tools = replies.find((reply) => reply.id === 2).result.tools;
  for (const tool of context.protocol.tools)
    assert.deepEqual(
      tool.inputSchema,
      tools.find((candidate: DiscoveredTool) => candidate.name === tool.name)
        .inputSchema,
    );
});

test("normal session hooks and command help advertise discovery without a special launch or MCP setup", (t) => {
  const w = new Workspace(t);
  for (const agent of ["claude", "codex"])
    assert.match(
      w.hook(agent, randomUUID()).stdout,
      /rl workflow context --json/,
    );
  assert.match(
    w.rl(["agent", "--help"]).stdout,
    /special launcher or MCP connection is not required/,
  );
  assert.match(
    w.rl(["workflow", "context", "--help"]).stdout,
    /protocol.tools/,
  );
  const context = w.rl(["workflow", "context"], { cwd: w.a }).stdout;
  assert.match(
    context,
    /no special agent launcher or user-pasted workflow prompt/,
  );
  assert.match(context, /MCP connection is optional/);
});
