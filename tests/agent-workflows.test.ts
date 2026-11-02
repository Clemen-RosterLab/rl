import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace, read, readJson, write } from "./helpers.js";

const clean = {
  summary: "Checked the recorded changes",
  complete: true,
  findings: [],
  limitations: [],
  checkRequests: [],
  routingLeads: [],
};
const finding = {
  title: "A concrete defect",
  severity: "high",
  required: true,
  rootCause: "Shared root cause",
  file: "app.ts",
  line: 1,
  evidence: "A traced failure",
  recommendation: "Reuse the guard",
  confidence: "inferred",
};
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "native-test", version: "1" },
  },
};
function setup(t: TestContext) {
  const w = new Workspace(t);
  w.rl(["workflow", "init"], { cwd: w.a });
  write(path.join(w.a, "app.ts"), "export const value = 1;\n");
  const parent = { agent: "claude", sessionId: randomUUID() };
  const rpc = (
    name: string,
    args: Record<string, unknown> = {},
    cwd = w.a,
    ok = true,
  ) => {
    const result = w.rl(["agent", "mcp"], {
      cwd,
      input:
        [
          initialize,
          { jsonrpc: "2.0", method: "notifications/initialized" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: { ...parent, ...args } },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n",
    });
    const reply = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(!!reply.result?.isError, !ok, JSON.stringify(reply));
    if (!ok) return reply.result.content[0].text as string;
    return JSON.parse(reply.result.content[0].text);
  };
  const run = () => rpc("rl_workflow_start", { base: "develop" });
  const claim = (id: string, step?: string) =>
    rpc("rl_workflow_claim", { run: id, ...(step ? { step } : {}) });
  const report = (
    claimed: { run: string; step: string; claim: string },
    result: Record<string, unknown> = clean,
    extra: Record<string, unknown> = {},
  ) =>
    rpc("rl_workflow_report", {
      run: claimed.run,
      step: claimed.step,
      claim: claimed.claim,
      result,
      ...extra,
    });
  const configure = (change: (workflows: Record<string, any>) => void) => {
    const file = path.join(w.a, ".rl/agent-workflows.json");
    const data = readJson(file);
    change(data.workflows);
    write(file, JSON.stringify(data));
  };
  return { w, parent, rpc, run, claim, report, configure };
}

test("native configuration is discovered at startup, refreshes after edits and never launches providers", (t) => {
  const { w, parent, rpc } = setup(t);
  const context = rpc("rl_workflow_context");
  assert.equal(context.execution, "native");
  assert.equal(context.agents.behavior.provider, "inherit");
  for (const agent of ["codex", "claude"]) {
    const first = JSON.parse(w.hook(agent, parent.sessionId).stdout);
    assert.ok(
      first.hookSpecificOutput.additionalContext.includes(
        `agent=${agent}, sessionId=${parent.sessionId}`,
      ),
    );
    assert.match(
      first.hookSpecificOutput.additionalContext,
      /RL native agent configuration detected/,
    );
    assert.match(
      first.hookSpecificOutput.additionalContext,
      /YOUR native subagent tool/,
    );
    assert.equal(
      w.hook(agent, parent.sessionId, { event: "UserPromptSubmit" }).stdout,
      "",
    );
    const file = path.join(w.a, ".rl/agents.json"),
      data = readJson(file);
    data.agents.behavior.instructions +=
      "\nInspect a newly configured contract.";
    write(file, JSON.stringify(data));
    assert.match(
      w.hook(agent, parent.sessionId, { event: "UserPromptSubmit" }).stdout,
      /RL native agent configuration detected/,
    );
    for (const event of ["PreToolUse", "PostToolUse"])
      assert.ok(
        readJson(
          path.join(
            w.a,
            agent === "claude"
              ? ".claude/settings.local.json"
              : ".codex/hooks.json",
          ),
        ).hooks[event],
      );
  }
  assert.ok(!fs.existsSync(w.log));
});

test("users add roles and workflows with trigger rules without mixing policy into agent profiles", (t) => {
  const { w, rpc } = setup(t),
    instructions = path.join(w.root, "role.md");
  write(instructions, "Trace changes to authentication and return evidence.");
  w.rl(
    [
      "agent",
      "add",
      "auth",
      "--instructions",
      instructions,
      "--description",
      "Authentication reviewer",
    ],
    { cwd: w.a },
  );
  const profile = JSON.parse(
    w.rl(["agent", "show", "auth", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(profile.provider, "inherit");
  assert.match(profile.instructions, /authentication/);
  const file = path.join(w.root, "workflow.json");
  write(
    file,
    JSON.stringify({
      description: "Check authentication edits",
      policy: "review",
      concurrency: 1,
      retries: 0,
      timeoutSeconds: 60,
      triggers: [
        { event: "before_edit", tools: ["Edit"], paths: ["src/auth/**"] },
      ],
      steps: [{ id: "auth", agent: "auth", after: [] }],
    }),
  );
  w.rl(["workflow", "add", "auth", "--file", file], { cwd: w.a });
  assert.equal(
    rpc("rl_workflow_context").workflows.auth.steps[0].agent,
    "auth",
  );
  w.rl(["agent", "add", "auth", "--instructions", instructions], {
    cwd: w.a,
    ok: false,
  });
  write(
    file,
    JSON.stringify({
      description: "Wrong responsibility",
      instructions: "Review",
      weights: { high: 10 },
    }),
  );
  w.rl(["agent", "set", "auth", "--file", file], { cwd: w.a, ok: false });
  assert.equal(
    rpc("rl_workflow_context").agents.auth.instructions,
    profile.instructions,
  );
  assert.ok(!fs.existsSync(w.log));
});

test("observed Codex thread identities coordinate native workflows without becoming resumable UUIDs", (t) => {
  const { w, rpc } = setup(t);
  const identity = { agent: "codex", sessionId: "thr_native_parent" };
  w.hook("codex", identity.sessionId);
  assert.equal(
    JSON.parse(w.hook("codex", identity.sessionId, { event: "Stop" }).stdout)
      .decision,
    "block",
  );
  const pending = rpc("rl_workflow_pending", identity);
  assert.equal(pending.length, 1);
  const run = rpc("rl_workflow_start", {
    ...identity,
    requestId: pending[0].id,
    base: "develop",
  });
  assert.equal(run.owner.sessionId, identity.sessionId);
  const stage = rpc("rl_workflow_claim", { ...identity, run: run.id });
  assert.equal(stage.execution, "native");
  assert.deepEqual(w.status().sessions.codex, []);
});

test("tool/path and semantic triggers queue only matching parent events and coalesce pending work", (t) => {
  const { w, parent, rpc, configure } = setup(t);
  configure((workflows) => {
    workflows["triple-review"].triggers = [
      { event: "before_edit", tools: ["Edit"], paths: ["src/auth/**"] },
      { event: "task_planned" },
    ];
  });
  const event = (file: string, extra = {}) =>
    w.hook("claude", parent.sessionId, {
      event: "PreToolUse",
      extra: {
        tool_name: "Edit",
        tool_input: { file_path: path.join(w.a, file) },
        ...extra,
      },
    });
  assert.equal(event("src/other.ts").stdout, "");
  assert.equal(rpc("rl_workflow_pending").length, 0);
  assert.match(event("src/auth/login.ts").stdout, /RL workflow requests/);
  fs.mkdirSync(path.join(w.a, "src/auth"), { recursive: true });
  assert.equal(
    JSON.parse(
      w.hook("claude", parent.sessionId, {
        cwd: path.join(w.a, "src/auth"),
        hookRoot: w.a,
        event: "PreToolUse",
        extra: { tool_name: "Edit", tool_input: { file_path: "login.ts" } },
      }).stdout,
    ).hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.equal(rpc("rl_workflow_pending").length, 1);
  assert.equal(
    JSON.parse(event("src/auth/login.ts").stdout).hookSpecificOutput
      .permissionDecision,
    "deny",
  );
  write(path.join(w.a, "app.ts"), "changed");
  event("src/auth/login.ts");
  assert.equal(rpc("rl_workflow_pending").length, 1);
  rpc("rl_workflow_event", { event: "task_planned" });
  assert.equal(rpc("rl_workflow_pending").length, 1);
  assert.equal(
    rpc("rl_workflow_pending", { sessionId: randomUUID() }).length,
    0,
  );
  rpc("rl_workflow_dismiss", {
    requestId: rpc("rl_workflow_pending")[0].id,
    reason: "Native delegation is unavailable in this client",
  });
  assert.equal(rpc("rl_workflow_pending").length, 0);
  assert.ok(!fs.existsSync(w.log));
});

test("before-finish requests are loop guarded, deduplicated, and never recursively queued by children", (t) => {
  const { w, parent, rpc } = setup(t);
  const stop = () => w.hook("claude", parent.sessionId, { event: "Stop" });
  const first = JSON.parse(stop().stdout);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /native subagents/);
  assert.deepEqual(JSON.parse(stop().stdout), {});
  assert.deepEqual(
    JSON.parse(
      w.hook("claude", parent.sessionId, {
        event: "Stop",
        extra: { stop_hook_active: true },
      }).stdout,
    ),
    {},
  );
  const queued = rpc("rl_workflow_pending");
  assert.equal(queued.length, 1);
  const child = w.hook("claude", parent.sessionId, {
    event: "SubagentStart",
    extra: { agent_id: "native-child" },
  });
  assert.match(child.stdout, /do not create workflows/);
  w.hook("claude", parent.sessionId, {
    event: "SubagentStop",
    extra: { agent_id: "native-child" },
  });
  assert.equal(rpc("rl_workflow_pending").length, 1);
  const started = rpc("rl_workflow_start", {
    requestId: queued[0].id,
    base: "develop",
  });
  assert.equal(
    rpc("rl_workflow_start", { requestId: queued[0].id }).id,
    started.id,
  );
  assert.equal(rpc("rl_workflow_pending").length, 0);
  assert.equal(started.owner.sessionId, parent.sessionId);
  assert.ok(!fs.existsSync(w.log));
});

test("claims enforce ordering and concurrency, reports are exact-once, checks remain parent-owned", (t) => {
  const { w, parent, rpc, run, claim, report, configure } = setup(t);
  configure((workflows) => {
    workflows["triple-review"].concurrency = 1;
    workflows["triple-review"].steps = [
      { id: "check", command: ["npm", "test"], after: [] },
      { id: "behavior", agent: "behavior", after: ["check"] },
    ];
  });
  const started = run();
  assert.equal(started.execution, "native");
  assert.equal(started.owner.agent, "claude");
  assert.match(
    rpc("rl_workflow_claim", { run: started.id, step: "behavior" }, w.a, false),
    /No ready/,
  );
  const check = claim(started.id, "check");
  assert.deepEqual(check.command, ["npm", "test"]);
  assert.match(
    rpc("rl_workflow_claim", { run: started.id }, w.a, false),
    /concurrency/,
  );
  rpc(
    "rl_workflow_report",
    {
      ...check,
      execution: undefined,
      scope: undefined,
      command: undefined,
      scopeFile: undefined,
      dependencies: undefined,
      run: started.id,
      step: "check",
      claim: check.claim,
    },
    w.a,
    false,
  );
  rpc("rl_workflow_report", {
    run: started.id,
    step: "check",
    claim: check.claim,
    check: { stdout: "Passed", stderr: "", exitCode: 0 },
  });
  const agent = claim(started.id);
  assert.match(agent.prompt, /Stay read-only/);
  assert.equal(agent.dependencies[0].check.stdout, "Passed");
  const finished = report(
    agent,
    { ...clean, checkRequests: ["check"] },
    { childId: "claude-native-7" },
  );
  assert.equal(finished.status, "completed");
  assert.equal(finished.evaluation.verdict, "ready");
  assert.equal(finished.stages[1].childId, "claude-native-7");
  assert.equal(finished.metrics.inputTokens, null);
  assert.match(finished.metrics.usageSource, /parent-reported/);
  assert.match(
    rpc(
      "rl_workflow_report",
      { run: started.id, step: agent.step, claim: agent.claim, result: clean },
      w.a,
      false,
    ),
    /completed/,
  );
  const view = JSON.parse(
    w.rl(["workflow", "status", started.id, "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(view.owner.sessionId, parent.sessionId);
  assert.ok(!fs.existsSync(w.log));
});

test("reports cannot cross parent sessions, workspaces, or a changed review scope", (t) => {
  const { w, rpc, run, claim } = setup(t),
    started = run(),
    step = claim(started.id);
  assert.match(
    rpc(
      "rl_workflow_claim",
      { run: started.id, sessionId: randomUUID() },
      w.a,
      false,
    ),
    /different parent/,
  );
  rpc("rl_workflow_claim", { run: started.id }, w.b, false);
  rpc(
    "rl_workflow_report",
    { run: started.id, step: step.step, claim: randomUUID(), result: clean },
    w.a,
    false,
  );
  rpc(
    "rl_workflow_report",
    {
      run: started.id,
      step: step.step,
      claim: step.claim,
      result: { ...clean, score: 100 },
    },
    w.a,
    false,
  );
  write(path.join(w.a, "app.ts"), "scope changed");
  assert.match(
    rpc(
      "rl_workflow_report",
      { run: started.id, step: step.step, claim: step.claim, result: clean },
      w.a,
      false,
    ),
    /scope changed/,
  );
});

test("concurrent claims for the same native stage have exactly one winner", async (t) => {
  const { w, parent, run } = setup(t),
    started = run();
  const input =
    [
      initialize,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "rl_workflow_claim",
          arguments: { ...parent, run: started.id, step: "behavior" },
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  const results = await Promise.all([
    w.commandAsync([path.join(process.cwd(), "bin/rl"), "agent", "mcp"], {
      cwd: w.a,
      input,
    }),
    w.commandAsync([path.join(process.cwd(), "bin/rl"), "agent", "mcp"], {
      cwd: w.a,
      input,
    }),
  ]);
  const replies = results.map((result) =>
    JSON.parse(result.trim().split("\n").at(-1)!),
  );
  assert.equal(replies.filter((reply) => !reply.result.isError).length, 1);
  assert.equal(replies.filter((reply) => reply.result.isError).length, 1);
  assert.ok(!fs.existsSync(w.log));
});

test("native writers run exclusively, advance review scope and release the original edit gate through CLI request binding", (t) => {
  const { w, parent, rpc, claim, report, configure } = setup(t);
  const file = path.join(w.root, "writer.json");
  write(
    file,
    JSON.stringify({
      description: "Scoped implementer",
      instructions: "Implement only the assigned app.ts changes",
      access: "workspace-write",
    }),
  );
  w.rl(["agent", "add", "writer", "--file", file], { cwd: w.a });
  configure((workflows) => {
    workflows["triple-review"].triggers = [
      { event: "before_edit", paths: ["app.ts"] },
    ];
    workflows["triple-review"].steps = [
      { id: "writer", agent: "writer", after: [] },
      { id: "quality", agent: "quality", after: [] },
      { id: "behavior", agent: "behavior", after: ["writer"] },
    ];
  });
  w.hook("claude", parent.sessionId);
  const edit = () =>
    w.hook("claude", parent.sessionId, {
      event: "PreToolUse",
      extra: {
        tool_name: "Edit",
        tool_input: { file_path: path.join(w.a, "app.ts") },
      },
    });
  assert.equal(
    JSON.parse(edit().stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );
  const request = rpc("rl_workflow_pending")[0];
  const run = JSON.parse(
    w.rl(
      [
        "workflow",
        "run",
        "--request",
        request.id,
        "--agent",
        "claude",
        "--session",
        parent.sessionId,
        "--json",
      ],
      { cwd: w.a },
    ).stdout,
  );
  assert.equal(run.requestId, request.id);
  const writer = claim(run.id, "writer");
  assert.match(writer.prompt, /implement the assigned changes/);
  assert.match(
    rpc("rl_workflow_claim", { run: run.id, step: "quality" }, w.a, false),
    /exclusively/,
  );
  assert.equal(
    w.hook("claude", parent.sessionId, {
      event: "PreToolUse",
      extra: {
        agent_id: "native-writer",
        tool_name: "Edit",
        tool_input: { file_path: path.join(w.a, "app.ts") },
      },
    }).stdout,
    "",
  );
  write(path.join(w.a, "app.ts"), "export const value = 2;\n");
  const changed = report(writer);
  assert.notEqual(changed.scope.fingerprint, writer.scope.fingerprint);
  const reviewer = claim(run.id, "behavior");
  assert.equal(reviewer.scope.fingerprint, changed.scope.fingerprint);
  assert.match(
    Buffer.from(
      readJson(reviewer.scopeFile).untracked.find(
        (entry: { file: string }) => entry.file === "app.ts",
      ).content,
      "base64",
    ).toString("utf8"),
    /value = 2/,
  );
  report(reviewer);
  const finished = report(claim(run.id, "quality"));
  assert.equal(finished.evaluation.verdict, "ready");
  assert.equal(edit().stdout, "");
  assert.equal(rpc("rl_workflow_pending").length, 0);
  assert.ok(!fs.existsSync(w.log));
});

test("a fresh review supersedes pre-write evidence without treating stale findings as current", (t) => {
  const { w, run, claim, report, configure } = setup(t);
  const file = path.join(w.root, "writer.json");
  write(
    file,
    JSON.stringify({
      description: "Implementer",
      instructions: "Fix the assigned defect",
      access: "workspace-write",
    }),
  );
  w.rl(["agent", "add", "writer", "--file", file], { cwd: w.a });
  configure((workflows) => {
    workflows["triple-review"].steps = [
      { id: "initial", agent: "quality", after: [] },
      { id: "writer", agent: "writer", after: ["initial"] },
      { id: "final", agent: "quality", after: ["writer"] },
    ];
  });
  const started = run();
  report(claim(started.id, "initial"), { ...clean, findings: [finding] });
  const writer = claim(started.id, "writer");
  write(path.join(w.a, "app.ts"), "fixed\n");
  const pending = report(writer);
  assert.ok(
    pending.evaluation.limitations.some((value: string) =>
      value.includes("predates workspace changes"),
    ),
  );
  const finished = report(claim(started.id, "final"));
  assert.equal(finished.evaluation.score, 100);
  assert.deepEqual(finished.evaluation.findings, []);
  assert.equal(finished.evaluation.verdict, "ready");
});

test("routed leads produce one native owner follow-up and unresolved leads keep the verdict incomplete", (t) => {
  const { run, claim, report } = setup(t),
    started = run();
  const stages = [
    claim(started.id, "behavior"),
    claim(started.id, "reuse"),
    claim(started.id, "quality"),
  ];
  const leads = [
    {
      owner: "reuse",
      file: "app.ts",
      reason: "Check the existing implementation",
    },
  ];
  report(stages[0], { ...clean, routingLeads: leads });
  report(stages[1]);
  const initial = report(stages[2]);
  assert.equal(initial.status, "running");
  const followup = claim(started.id);
  assert.equal(followup.step, "followup-reuse");
  assert.match(followup.prompt, /Check the existing implementation/);
  const finished = report(followup, { ...clean, routingLeads: leads });
  assert.equal(finished.status, "completed");
  assert.equal(finished.stages.length, 4);
  assert.equal(finished.evaluation.verdict, "incomplete");
});

test("native deadlines reject late evidence and exhausted failures block transitive dependencies in any order", (t) => {
  const { w, rpc, run, claim, configure } = setup(t);
  configure((workflows) => {
    workflows["triple-review"].retries = 0;
    workflows["triple-review"].timeoutSeconds = 1;
    workflows["triple-review"].steps = [
      { id: "quality", agent: "quality", after: ["reuse"] },
      { id: "reuse", agent: "reuse", after: ["behavior"] },
      { id: "behavior", agent: "behavior", after: [] },
    ];
  });
  const started = run(),
    stage = claim(started.id);
  const file = path.join(
      w.status().stateDirectory,
      "workflow-runs",
      started.id,
      "run.json",
    ),
    data = readJson(file);
  data.stages.find((step: { id: string }) => step.id === "behavior").startedAt =
    "2000-01-01T00:00:00.000Z";
  write(file, JSON.stringify(data));
  const result = rpc("rl_workflow_report", {
    run: started.id,
    step: stage.step,
    claim: stage.claim,
    result: clean,
  });
  assert.equal(result.status, "completed");
  assert.equal(
    result.stages.find((step: { id: string }) => step.id === "behavior").status,
    "failed",
  );
  assert.deepEqual(
    result.stages.slice(0, 2).map((step: { status: string }) => step.status),
    ["blocked", "blocked"],
  );
  assert.equal(result.evaluation.verdict, "incomplete");
});

test("RL scores deduplicated findings and rescores separately from native role instructions", (t) => {
  const { w, run, claim, report } = setup(t),
    started = run();
  const stages = [claim(started.id), claim(started.id), claim(started.id)];
  report(stages[0], { ...clean, findings: [finding] });
  report(stages[1], { ...clean, findings: [finding] });
  const result = report(stages[2]);
  assert.equal(result.evaluation.score, 80);
  assert.equal(result.evaluation.findings.length, 1);
  assert.equal(result.evaluation.findings[0].owners.length, 2);
  assert.equal(result.evaluation.verdict, "fix-required");
  const file = path.join(w.a, ".rl/policies.json"),
    policy = readJson(file);
  policy.policies.review.weights.high = 10;
  write(file, JSON.stringify(policy));
  const scored = JSON.parse(
    w.rl(["workflow", "score", started.id, "--json"], { cwd: w.a, ok: false })
      .stdout,
  );
  assert.equal(scored.evaluation.score, 90);
  assert.equal(scored.assessments.length, 2);
  assert.equal(scored.config.policies.review.weights.high, 20);
  assert.ok(!fs.existsSync(w.log));
});

test("failed native stages retry within the configured budget and block dependent stages", (t) => {
  const { w, rpc, run, claim, configure } = setup(t);
  configure((workflows) => {
    workflows["triple-review"].steps = [
      { id: "behavior", agent: "behavior", after: [] },
      { id: "quality", agent: "quality", after: ["behavior"] },
    ];
  });
  const started = run();
  for (let attempt = 0; attempt < 2; attempt++) {
    const stage = claim(started.id);
    rpc("rl_workflow_report", {
      run: started.id,
      step: stage.step,
      claim: stage.claim,
      error: "Native agent unavailable",
    });
  }
  const saved = JSON.parse(
    w.rl(["workflow", "status", started.id, "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(saved.stages[0].attempts, 2);
  assert.equal(saved.stages[0].status, "failed");
  assert.equal(saved.stages[1].status, "blocked");
  assert.equal(saved.evaluation.verdict, "incomplete");
});

test("pause prevents new claims while allowing existing children to report; resume and cancel never launch providers", (t) => {
  const { w, parent, rpc, run, claim, report } = setup(t),
    started = run(),
    stage = claim(started.id);
  w.rl(["workflow", "pause", started.id], { cwd: w.a });
  rpc("rl_workflow_claim", { run: started.id }, w.a, false);
  report(stage);
  w.rl(
    [
      "workflow",
      "resume",
      started.id,
      "--agent",
      "claude",
      "--session",
      parent.sessionId,
    ],
    { cwd: w.a },
  );
  const next = claim(started.id);
  w.rl(["workflow", "cancel", started.id], { cwd: w.a });
  rpc(
    "rl_workflow_report",
    { run: started.id, step: next.step, claim: next.claim, result: clean },
    w.a,
    false,
  );
  w.rl(
    [
      "workflow",
      "resume",
      started.id,
      "--agent",
      "claude",
      "--session",
      parent.sessionId,
    ],
    { cwd: w.a, ok: false },
  );
  assert.ok(!fs.existsSync(w.log));
});

test("staged and unstaged versions remain in native scope, dry-run creates no runs, and unsafe config is rejected", (t) => {
  const { w, run, claim, configure } = setup(t);
  write(path.join(w.a, "tracked.ts"), "base\n");
  w.git(w.a, "add", "tracked.ts");
  w.git(w.a, "commit", "-qm", "Base");
  write(path.join(w.a, "tracked.ts"), "staged\n");
  w.git(w.a, "add", "tracked.ts");
  write(path.join(w.a, "tracked.ts"), "base\n");
  const state = w.status().stateDirectory;
  const plan = JSON.parse(
    w.rl(["workflow", "run", "--base", "develop", "--dry-run", "--json"], {
      cwd: w.a,
    }).stdout,
  );
  assert.ok(plan.scope.files.includes("tracked.ts"));
  assert.ok(!fs.existsSync(path.join(state, "workflow-runs")));
  const started = run(),
    stage = claim(started.id),
    scope = readJson(stage.scopeFile);
  assert.match(scope.stagedPatch, /staged/);
  assert.match(scope.unstagedPatch, /staged/);
  assert.equal(w.git(w.a, "show", ":tracked.ts"), "staged");
  configure((workflows) => {
    workflows["triple-review"].steps[0].after = ["behavior"];
  });
  w.rl(["workflow", "context", "--json"], { cwd: w.a, ok: false });
  const target = path.join(w.a, ".rl/agents.json"),
    original = read(target);
  fs.renameSync(target, target + ".saved");
  fs.symlinkSync(target + ".saved", target);
  w.rl(["agent", "list"], { cwd: w.a, ok: false });
  assert.equal(read(target + ".saved"), original);
});
