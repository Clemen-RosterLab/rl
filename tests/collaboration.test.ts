import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CLI, Workspace, readJson, write } from "./helpers.js";

const clean = {
  summary: "Checked the submitted checkpoint",
  complete: true,
  findings: [],
  limitations: [],
  checkRequests: [],
  routingLeads: [],
};
const finding = {
  title: "Broken behavior",
  severity: "high",
  required: true,
  rootCause: "Missing guard",
  file: "app.ts",
  line: 1,
  evidence: "Failure traced through the caller",
  recommendation: "Add the guard",
  confidence: "inferred",
};

async function setup(
  t: TestContext,
  initialChanges?: (workspace: Workspace) => void,
) {
  const w = new Workspace(t);
  write(path.join(w.a, "app.ts"), "export const initial = 1;\n");
  w.git(w.a, "add", "app.ts");
  w.git(w.a, "commit", "-qm", "Initial source");
  initialChanges?.(w);
  const parent = { agent: "claude", sessionId: randomUUID() };
  const child = spawn(CLI, ["agent", "mcp"], {
    cwd: w.a,
    env: w.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let next = 0,
    buffer = "",
    stderr = "";
  const pending = new Map<
    number,
    {
      resolve: (value: ReturnType<typeof JSON.parse>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const response = JSON.parse(line),
        item = pending.get(response.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(response.id);
        item.resolve(response);
      }
    }
  });
  const completed = new Promise<void>((resolve) =>
    child.on("close", () => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(stderr || "MCP server closed"));
      }
      pending.clear();
      resolve();
    }),
  );
  t.after(async () => {
    child.stdin.end();
    await completed;
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<ReturnType<typeof JSON.parse>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}; ${stderr}`));
        child.kill("SIGTERM");
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "team-tests", version: "1" },
  });
  assert.ok(initialized.result.instructions.includes("writer-reviewer-dry"));
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await request("tools/call", {
      name,
      arguments: { ...parent, ...args },
    });
    if (response.error) throw new Error(response.error.message);
    if (response.result.isError)
      throw new Error(response.result.content[0].text);
    return JSON.parse(response.result.content[0].text);
  };
  const started = await rpc("rl_workflow_start", {
    base: "HEAD",
    prompt: "Implement the assigned changes using the three peers",
  });
  const claims: Record<string, { run: string; step: string; claim: string }> =
    {};
  const claim = async (step: string) =>
    (claims[step] = await rpc("rl_workflow_claim", { run: started.id, step }));
  const peer = (
    step: string,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const value = claims[step];
    return rpc(`rl_workflow_${name}`, {
      run: started.id,
      step,
      claim: value.claim,
      ...args,
    });
  };
  const team = async () => {
    await Promise.all([claim("writer"), claim("reviewer"), claim("dry")]);
    await Promise.all(
      ["writer", "reviewer", "dry"].map((step) =>
        peer(step, "bind", { childId: `native-${step}` }),
      ),
    );
  };
  const submit = (extra: Record<string, unknown> = {}) =>
    peer("writer", "submit", {
      files: ["app.ts"],
      newFunctions: [],
      summary: "Implementation checkpoint",
      ...extra,
    });
  const review = (submissionId: string, extra: Record<string, unknown> = {}) =>
    peer("reviewer", "review", {
      submissionId,
      rating: 95,
      rationale: "Verified the required behavior",
      result: clean,
      duplicateSuspicions: [],
      ...extra,
    });
  const finish = (step: string) => peer(step, "report", { result: clean });
  return {
    w,
    parent,
    rpc,
    started,
    claims,
    claim,
    peer,
    team,
    submit,
    review,
    finish,
  };
}

test("the built-in team is active in adopted workspaces without initialization and all roles start together", async (t) => {
  const { w, parent, rpc, started, team, peer, claims } = await setup(t);
  assert.ok(!fs.existsSync(path.join(w.a, ".rl")));
  const context = await rpc("rl_workflow_context");
  assert.equal(context.active, true);
  assert.equal(context.source, "built-in");
  assert.equal(context.defaultWorkflow, "writer-reviewer-dry");
  assert.deepEqual(Object.keys(context.agents), ["writer", "reviewer", "dry"]);
  assert.equal(context.agents.writer.access, "workspace-write");
  assert.equal(context.agents.reviewer.access, "read-only");
  assert.equal(context.agents.dry.access, "read-only");
  assert.equal(started.workflow, "writer-reviewer-dry");
  const startup = w.hook("claude", parent.sessionId).stdout;
  assert.match(startup, /built-in defaults/);
  assert.match(
    startup,
    /spawn all three|all writer, reviewer and DRY|writer, reviewer and DRY/,
  );
  await team();
  const inbox = await peer("writer", "inbox");
  assert.equal(inbox.ready, true);
  assert.ok(
    inbox.peers.every((peer: { status: string }) => peer.status === "running"),
  );
  assert.match(
    (claims.reviewer as unknown as { prompt: string }).prompt,
    /rating policy/,
  );
  assert.ok(!fs.existsSync(w.log));
});

test("work cannot begin until all three peers have distinct native bindings", async (t) => {
  const { claim, peer, team } = await setup(t);
  await claim("writer");
  await peer("writer", "bind", { childId: "native-writer" });
  await assert.rejects(
    peer("writer", "consult", {
      to: "dry",
      event: "new_function",
      subject: "app.ts#helper",
      question: "What can be reused?",
    }),
    /Spawn and bind all/,
  );
  await claim("reviewer");
  await assert.rejects(
    peer("reviewer", "bind", { childId: "native-writer" }),
    /own native child/,
  );
});

test("partial legacy configuration inherits compatible defaults without rewriting explicit settings", async (t) => {
  const { w, rpc, started } = await setup(t);
  const directory = path.join(w.a, ".rl"),
    agents = path.join(directory, "agents.json"),
    policies = path.join(directory, "policies.json"),
    workflows = path.join(directory, "agent-workflows.json");
  fs.mkdirSync(directory);
  const oldProfile = {
    description: "Existing review",
    instructions: "Keep my existing role",
    access: "read-only",
  };
  const oldPolicy = { ...started.config.policies.review };
  delete oldPolicy.rating;
  const original = JSON.stringify({
    version: 1,
    agents: { behavior: oldProfile },
  });
  write(agents, original);
  write(
    policies,
    JSON.stringify({ version: 1, policies: { review: oldPolicy } }),
  );
  const context = await rpc("rl_workflow_context");
  assert.equal(context.defaultWorkflow, "writer-reviewer-dry");
  assert.deepEqual(context.agents.behavior, oldProfile);
  assert.equal(context.agents.writer.access, "workspace-write");
  assert.equal(context.policies.review.rating.minimum, 90);
  assert.equal(fs.readFileSync(agents, "utf8"), original);
  assert.ok(!readJson(policies).policies.review.rating);
  fs.unlinkSync(agents);
  const legacy = {
    description: "Existing independent reviews",
    policy: "review",
    concurrency: 3,
    retries: 1,
    timeoutSeconds: 600,
    steps: ["behavior", "reuse", "quality"].map((id) => ({
      id,
      agent: id,
      after: [],
    })),
  };
  write(workflows, JSON.stringify({ version: 1, workflows: { legacy } }));
  const explicit = await rpc("rl_workflow_context");
  assert.equal(explicit.defaultWorkflow, "legacy");
  assert.ok(
    explicit.agents.behavior &&
      explicit.agents.reuse &&
      explicit.agents.quality,
  );
  assert.doesNotMatch(
    explicit.agents.behavior.instructions,
    /writer|checkpoint|rl_workflow_consult/,
  );
  assert.ok(!explicit.policies.review.rating);
  write(
    workflows,
    JSON.stringify({ version: 1, workflows: { legacy }, default: null }),
  );
  await assert.rejects(rpc("rl_workflow_context"), /Unknown default/);
});

test("writer calls its existing DRY peer before submitting a new function and receives a targeted answer", async (t) => {
  const { w, team, peer, submit, review, finish } = await setup(t);
  await team();
  await assert.rejects(
    submit({ newFunctions: ["app.ts#helper"] }),
    /must consult dry/,
  );
  const request = await peer("writer", "consult", {
    to: "dry",
    event: "new_function",
    subject: "app.ts#helper",
    question: "Is there an existing helper?",
  });
  assert.equal(request.notify.childId, "native-dry");
  await assert.rejects(
    submit({ newFunctions: ["app.ts#helper"] }),
    /receive an answer/,
  );
  const inbox = await peer("dry", "inbox");
  assert.equal(inbox.consultations[0].id, request.id);
  const answer = await peer("dry", "answer", {
    requestId: request.id,
    text: "No suitable helper exists after checking app.ts and its callers.",
  });
  assert.equal(answer.notify.childId, "native-writer");
  write(path.join(w.a, "app.ts"), "export function helper() { return 2; }\n");
  const submission = await submit({ newFunctions: ["app.ts#helper"] });
  assert.equal(submission.notify.childId, "native-reviewer");
  const accepted = await review(submission.id);
  assert.equal(accepted.review.rating, 95);
  assert.equal(accepted.review.accepted, true);
  assert.equal(accepted.notify.childId, "native-writer");
  await finish("writer");
  await finish("reviewer");
  const result = await finish("dry");
  assert.equal(result.status, "completed");
  assert.equal(result.evaluation.verdict, "ready");
  assert.equal(result.metrics.collaboration.latestRating, 95);
  assert.ok(!fs.existsSync(w.log));
});

test("reviewer must call DRY on declared duplicate suspicions before returning its rating", async (t) => {
  const { w, team, peer, submit, review } = await setup(t);
  await team();
  write(path.join(w.a, "app.ts"), "export const updated = 2;\n");
  const submission = await submit();
  await assert.rejects(
    review(submission.id, { duplicateSuspicions: ["app.ts#updated"] }),
    /reviewer must consult dry/,
  );
  const query = await peer("reviewer", "consult", {
    to: "dry",
    event: "suspected_duplicate",
    subject: "app.ts#updated",
    question: "Does this duplicate the existing implementation?",
  });
  await assert.rejects(
    review(submission.id, { duplicateSuspicions: ["app.ts#updated"] }),
    /receive an answer/,
  );
  await peer("dry", "answer", {
    requestId: query.id,
    text: "The compared path has different semantics; this is not duplicated behavior.",
  });
  const accepted = await review(submission.id, {
    duplicateSuspicions: ["app.ts#updated"],
  });
  assert.equal(accepted.review.accepted, true);
  await assert.rejects(
    peer("writer", "answer", {
      requestId: query.id,
      text: "I can answer instead",
    }),
    /not addressed/,
  );
  await assert.rejects(
    peer("writer", "consult", {
      to: "reviewer",
      event: "new_function",
      subject: "x",
      question: "Skip DRY",
    }),
    /not configured/,
  );
});

test("ratings below the policy threshold or with required findings require a bounded fix and resubmission loop", async (t) => {
  const { w, team, submit, review, finish } = await setup(t);
  await team();
  write(path.join(w.a, "app.ts"), "export const updated = 2;\n");
  const first = await submit();
  const rejected = await review(first.id, {
    rating: 80,
    rationale: "Needs validation",
  });
  assert.equal(rejected.review.accepted, false);
  await assert.rejects(finish("writer"), /accepted reviewer rating/);
  const second = await submit();
  await assert.rejects(
    review(second.id, {
      result: { ...clean, findings: [{ ...finding, file: "nonexistent.ts" }] },
    }),
    /workspace file/,
  );
  const required = await review(second.id, {
    rating: 99,
    result: { ...clean, findings: [finding] },
  });
  assert.equal(required.review.accepted, false);
  write(path.join(w.a, "app.ts"), "export const fixed = 3;\n");
  const third = await submit();
  assert.equal(third.round, 3);
  const check = await review(third.id, {
    result: { ...clean, checkRequests: ["types"] },
  });
  assert.equal(check.review.accepted, false);
  const fourth = await submit();
  const lead = await review(fourth.id, {
    result: {
      ...clean,
      routingLeads: [
        {
          owner: "dry",
          file: "app.ts",
          reason: "An unresolved duplication concern",
        },
      ],
    },
  });
  assert.equal(lead.review.accepted, false);
  const fifth = await submit();
  await review(fifth.id);
  await finish("writer");
  await finish("reviewer");
  const result = await finish("dry");
  assert.equal(result.evaluation.score, 100);
  assert.deepEqual(result.evaluation.findings, []);
});

test("reviewer uses a stable file checkpoint while writer continues on unrelated files", async (t) => {
  const { w, team, submit, review, finish } = await setup(t);
  await team();
  write(path.join(w.a, "app.ts"), "changed app\n");
  const app = await submit();
  write(path.join(w.a, "other.ts"), "unrelated next block\n");
  assert.equal((await review(app.id)).review.accepted, true);
  await assert.rejects(finish("writer"), /not been submitted.*other.ts/);
  const other = await submit({ files: ["other.ts"] });
  await review(other.id);
  await finish("writer");
  await finish("reviewer");
  assert.equal((await finish("dry")).evaluation.verdict, "ready");
});

test("reverting pre-existing dirty files still requires review even when Git no longer lists them as changed", async (t) => {
  const { w, team, submit, review, finish } = await setup(t, (workspace) => {
    write(path.join(workspace.a, "app.ts"), "export const initial = 2;\n");
  });
  await team();
  write(path.join(w.a, "other.ts"), "export const task = true;\n");
  const task = await submit({ files: ["other.ts"] });
  await review(task.id);
  write(path.join(w.a, "app.ts"), "export const initial = 1;\n");
  await assert.rejects(finish("writer"), /not been submitted.*app.ts/);
  const reverted = await submit({
    files: ["app.ts"],
    summary: "Review the reverted pre-existing edit",
  });
  await review(reverted.id);
  await finish("writer");
  await finish("reviewer");
  assert.equal((await finish("dry")).evaluation.verdict, "ready");
});

test("changes to submitted files, index versions or superseded checkpoints cannot receive a stale rating", async (t) => {
  const { w, team, submit, review } = await setup(t);
  await team();
  write(path.join(w.a, "app.ts"), "first\n");
  const first = await submit();
  await assert.rejects(submit(), /frozen until reviewed/);
  write(path.join(w.a, "app.ts"), "second\n");
  await assert.rejects(review(first.id), /changed/);
  const second = await submit({ supersedes: [first.id] });
  await assert.rejects(review(first.id), /current unreviewed/);
  w.git(w.a, "add", "app.ts");
  await assert.rejects(review(second.id), /staged versions changed/);
  const third = await submit({ supersedes: [second.id] });
  assert.equal((await review(third.id)).review.accepted, true);
});

test("peers remain alive until the writer is reviewed and required consultation replies are settled", async (t) => {
  const { w, team, peer, submit, review, finish } = await setup(t);
  await team();
  await assert.rejects(finish("reviewer"), /remain available/);
  await assert.rejects(finish("dry"), /remain available/);
  await assert.rejects(finish("writer"), /Submit implementation work/);
  write(path.join(w.a, "app.ts"), "done\n");
  const query = await peer("writer", "consult", {
    to: "dry",
    event: "new_function",
    subject: "app.ts#maybe",
    question: "Can an existing helper be reused?",
  });
  const checkpoint = await submit();
  await review(checkpoint.id);
  await assert.rejects(finish("writer"), /Resolve this role/);
  await peer("dry", "answer", {
    requestId: query.id,
    text: "Yes, reuse the existing helper.",
  });
  await finish("writer");
  await finish("reviewer");
  assert.equal((await finish("dry")).status, "completed");
});

test("all profiles, peer routes, review thresholds and the default workflow remain editable", async (t) => {
  const { w, rpc } = await setup(t);
  w.rl(["workflow", "init"], { cwd: w.a });
  const profilePath = path.join(w.root, "writer.json"),
    profiles = readJson(path.join(w.a, ".rl/agents.json"));
  write(
    profilePath,
    JSON.stringify({
      ...profiles.agents.writer,
      model: "configured-model",
      instructions: "Follow my configured writer instructions",
    }),
  );
  w.rl(["agent", "set", "writer", "--file", profilePath], { cwd: w.a });
  const instructionsPath = path.join(w.root, "writer-instructions.md");
  write(
    instructionsPath,
    "Updated writer instructions without changing native settings",
  );
  w.rl(["agent", "set", "writer", "--instructions", instructionsPath], {
    cwd: w.a,
  });
  const workflowPath = path.join(w.root, "workflow.json"),
    config = readJson(path.join(w.a, ".rl/agent-workflows.json"));
  const custom = {
    ...config.workflows["writer-reviewer-dry"],
    collaboration: {
      ...config.workflows["writer-reviewer-dry"].collaboration,
      maxRounds: 2,
      rules: config.workflows["writer-reviewer-dry"].collaboration.rules.map(
        (rule: { required: boolean }) => ({ ...rule, required: false }),
      ),
    },
  };
  write(workflowPath, JSON.stringify(custom));
  w.rl(
    ["workflow", "add", "custom-team", "--file", workflowPath, "--default"],
    { cwd: w.a },
  );
  const policyPath = path.join(w.a, ".rl/policies.json"),
    policy = readJson(policyPath);
  policy.policies.review.rating = {
    min: 0,
    max: 10,
    minimum: 7,
    instructions: "Use my scale",
  };
  write(policyPath, JSON.stringify(policy));
  const context = await rpc("rl_workflow_context");
  assert.equal(context.defaultWorkflow, "custom-team");
  assert.equal(context.agents.writer.model, "configured-model");
  assert.equal(context.agents.writer.access, "workspace-write");
  assert.equal(
    context.agents.writer.reasoning,
    profiles.agents.writer.reasoning,
  );
  assert.equal(
    context.agents.writer.instructions,
    "Updated writer instructions without changing native settings",
  );
  const customRun = await rpc("rl_workflow_start", { base: "HEAD" });
  assert.equal(customRun.workflow, "custom-team");
  assert.equal(
    customRun.config.workflows[customRun.workflow].collaboration.maxRounds,
    2,
  );
  assert.equal(customRun.config.policies.review.rating.max, 10);
  const tokens = Object.fromEntries(
    await Promise.all(
      ["writer", "reviewer", "dry"].map(async (step) => [
        step,
        await rpc("rl_workflow_claim", { run: customRun.id, step }),
      ]),
    ),
  );
  const act = (
    step: string,
    operation: string,
    args: Record<string, unknown> = {},
  ) =>
    rpc(`rl_workflow_${operation}`, {
      run: customRun.id,
      step,
      claim: tokens[step].claim,
      ...args,
    });
  await Promise.all(
    ["writer", "reviewer", "dry"].map((step) =>
      act(step, "bind", { childId: `custom-${step}` }),
    ),
  );
  write(
    path.join(w.a, "app.ts"),
    "export function configuredHelper() { return 1; }\n",
  );
  const first = await act("writer", "submit", {
    files: ["app.ts"],
    newFunctions: ["app.ts#configuredHelper"],
    summary: "DRY consultation is optional in this configured workflow",
  });
  await assert.rejects(
    act("reviewer", "review", {
      submissionId: first.id,
      rating: 95,
      rationale: "Wrong scale",
      result: clean,
      duplicateSuspicions: [],
    }),
    /within 0–10/,
  );
  await act("reviewer", "review", {
    submissionId: first.id,
    rating: 6,
    rationale: "Needs more evidence",
    result: clean,
    duplicateSuspicions: [],
  });
  const second = await act("writer", "submit", {
    files: ["app.ts"],
    newFunctions: ["app.ts#configuredHelper"],
    summary: "Second review round",
  });
  const accepted = await act("reviewer", "review", {
    submissionId: second.id,
    rating: 7,
    rationale: "Meets the configured threshold",
    result: clean,
    duplicateSuspicions: [],
  });
  assert.equal(accepted.review.accepted, true);
  await assert.rejects(
    act("writer", "submit", {
      files: ["app.ts"],
      newFunctions: [],
      summary: "Third round",
    }),
    /Maximum review rounds/,
  );
  await act("writer", "report", { result: clean });
  await act("reviewer", "report", { result: clean });
  assert.equal(
    (await act("dry", "report", { result: clean })).evaluation.verdict,
    "ready",
  );
  assert.ok(!fs.existsSync(w.log));
});

test("collaboration validates role topology and checkpoint paths before exposing file contents", async (t) => {
  const { w, team, submit, rpc, started } = await setup(t);
  await team();
  await assert.rejects(submit({ files: ["../outside.txt"] }), /relative files/);
  const external = path.join(w.root, "outside.txt");
  write(external, "outside workspace");
  fs.symlinkSync(external, path.join(w.a, "external-link"));
  await assert.rejects(
    submit({ files: ["external-link"] }),
    /escapes the workspace/,
  );
  const file = path.join(w.root, "invalid.json"),
    config = structuredClone(started.config.workflows[started.workflow]);
  config.collaboration.dry = config.collaboration.reviewer;
  write(file, JSON.stringify(config));
  w.rl(["workflow", "add", "invalid", "--file", file], { cwd: w.a, ok: false });
  const before = await rpc("rl_workflow_context");
  assert.ok(!before.workflows.invalid);
  const invalidRule = structuredClone(
    started.config.workflows[started.workflow],
  );
  invalidRule.collaboration.rules[0].event = "unknown_required_event";
  write(file, JSON.stringify(invalidRule));
  w.rl(["workflow", "add", "invalid-rule", "--file", file], {
    cwd: w.a,
    ok: false,
  });
  assert.ok(!(await rpc("rl_workflow_context")).workflows["invalid-rule"]);
  const profiles = structuredClone(started.config.agents);
  profiles.writer.access = "read-only";
  write(file, JSON.stringify(profiles.writer));
  w.rl(["agent", "set", "writer", "--file", file], { cwd: w.a, ok: false });
  assert.equal(
    (await rpc("rl_workflow_context")).agents.writer.access,
    "workspace-write",
  );
});

test("paused teams can finish queued replies and ratings while new work and cancelled handoffs are rejected", async (t) => {
  const { w, parent, started, team, peer, submit, review } = await setup(t);
  await team();
  const request = await peer("writer", "consult", {
    to: "dry",
    event: "new_function",
    subject: "app.ts#planned",
    question: "Can existing code be reused?",
  });
  write(path.join(w.a, "app.ts"), "export const paused = true;\n");
  const pending = await submit();
  w.rl(["workflow", "pause", started.id], { cwd: w.a });
  assert.equal((await peer("writer", "inbox")).status, "paused");
  await assert.rejects(submit(), /paused/);
  await assert.rejects(
    peer("writer", "consult", {
      to: "dry",
      event: "new_function",
      subject: "app.ts#later",
      question: "New work?",
    }),
    /paused/,
  );
  await peer("dry", "answer", {
    requestId: request.id,
    text: "Reuse initial for this case",
  });
  assert.equal((await review(pending.id)).review.accepted, true);
  w.rl(
    [
      "workflow",
      "resume",
      started.id,
      "--agent",
      parent.agent,
      "--session",
      parent.sessionId,
    ],
    { cwd: w.a },
  );
  assert.equal((await peer("writer", "inbox")).status, "running");
  w.rl(["workflow", "cancel", started.id], { cwd: w.a });
  await assert.rejects(
    peer("dry", "answer", {
      requestId: request.id,
      text: "Reuse initial for this case",
    }),
    /cancelled/,
  );
});
