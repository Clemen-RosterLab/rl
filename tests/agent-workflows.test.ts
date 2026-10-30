import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CLI, Workspace, read, readJson, write } from "./helpers.js";

const clean = {
  summary: "No material findings",
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
  rootCause: "The same root cause",
  file: "app.ts",
  line: 1,
  evidence: "PRIVATE-FINDING: a traced failure",
  recommendation: "Reuse the existing guard",
  confidence: "inferred",
};
function fixture(w: Workspace, entries: Record<string, object> = {}) {
  w.rl(["workflow", "init"], { cwd: w.a });
  write(path.join(w.a, "app.ts"), "export const value = 1;\n");
  const fixtures = path.join(w.root, "workflow-fixtures.json"),
    log = path.join(w.root, "workflow-calls.jsonl");
  write(fixtures, JSON.stringify(entries));
  w.env.WORKFLOW_FIXTURES = fixtures;
  w.env.WORKFLOW_LOG = log;
  const script = `
const fs=require('node:fs');
if(process.argv[2]==='app-server')process.exit(0);
const args=process.argv.slice(2), step=process.env.RL_WORKFLOW_STEP;
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 const entries=JSON.parse(fs.readFileSync(process.env.WORKFLOW_FIXTURES,'utf8'));
 const entry=entries[step]||{};
 const events=fs.existsSync(process.env.WORKFLOW_LOG)?fs.readFileSync(process.env.WORKFLOW_LOG,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line)):[];
 const attempt=events.filter(event=>event.type==='start'&&event.step===step).length+1;
 const log=type=>fs.appendFileSync(process.env.WORKFLOW_LOG,JSON.stringify({type,step,attempt,args,input,cwd:process.cwd(),time:Date.now()})+'\\n');
 log('start');
 setTimeout(()=>{
  if(entry.mutate)fs.appendFileSync('app.ts','// changed during review\\n');
  if(attempt<=(entry.failures||0)){log('end');console.error('Temporary provider failure');process.exit(7);}
  const report=entry.result||${JSON.stringify(clean)};
  log('end');
  if(entry.malformed){console.log(JSON.stringify({score:100}));process.exit(0);}
  if(args.includes('--output-format'))console.log(JSON.stringify({type:'result',is_error:false,structured_output:report,usage:{input_tokens:10,output_tokens:5},total_cost_usd:0.02}));
  else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report)}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));}
 },entry.delay||0);
});`;
  w.stub("codex", script);
  w.stub("claude", script);
  return {
    fixtures,
    log,
    events: () =>
      fs.existsSync(log)
        ? read(log)
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}
function configure(
  w: Workspace,
  kind: "agents" | "policies" | "workflows",
  change: (value: any) => void,
) {
  const file = path.join(
    w.a,
    ".rl",
    kind === "workflows" ? "agent-workflows.json" : `${kind}.json`,
  );
  const data = readJson(file);
  change(data[kind]);
  write(file, JSON.stringify(data));
}
function run(w: Workspace, ok = true) {
  const result = w.rl(["workflow", "run", "--base", "develop", "--json"], {
    cwd: w.a,
    ok,
  });
  assert.ok(result.stdout.trim(), result.stderr);
  return JSON.parse(result.stdout);
}

test("agent profiles, workflow configuration and review policies are independent and workspace scoped", (t) => {
  const w = new Workspace(t);
  w.rl(["workflow", "init", "--provider", "claude"], { cwd: w.a });
  const agents = JSON.parse(
    w.rl(["agent", "list", "--json"], { cwd: w.a }).stdout,
  );
  assert.deepEqual(Object.keys(agents), ["behavior", "reuse", "quality"]);
  assert.ok(
    Object.values(agents).every((agent: any) => agent.provider === "claude"),
  );
  assert.equal(agents.behavior.weights, undefined);
  const policy = JSON.parse(
    w.rl(["policy", "show", "review", "--json"], { cwd: w.a }).stdout,
  );
  assert.deepEqual(policy.weights, {
    critical: 50,
    high: 20,
    medium: 10,
    low: 2,
  });
  assert.match(
    w.rl(["workflow", "show", "triple-review"], { cwd: w.a }).stdout,
    /concurrency: 3/,
  );
  assert.ok(!fs.existsSync(path.join(w.b, ".rl")));
  w.rl(["workflow", "init"], { cwd: w.a, ok: false });
  w.rl(["workflow", "list", "--workspace", w.b], { cwd: w.a, ok: false });
  assert.ok(!fs.existsSync(w.log));
});

test("workflow dry runs include committed, staged and untracked changes without creating runs", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w);
  write(path.join(w.a, "committed.ts"), "export const committed = 1;");
  w.git(w.a, "add", "committed.ts");
  w.git(w.a, "commit", "-qm", "Feature");
  write(path.join(w.a, "staged.ts"), "export const staged = 1;");
  w.git(w.a, "add", "staged.ts");
  const state = w.status().stateDirectory;
  const plan = JSON.parse(
    w.rl(["workflow", "run", "--base", "develop", "--dry-run", "--json"], {
      cwd: w.a,
    }).stdout,
  );
  assert.ok(
    ["committed.ts", "staged.ts", "app.ts"].every((file) =>
      plan.scope.files.includes(file),
    ),
  );
  assert.equal(plan.definition.concurrency, 3);
  assert.ok(!fs.existsSync(path.join(state, "workflow-runs")));
  assert.equal(mock.events().length, 0);
});

test("staged changes remain reviewable when the working tree restores the base version", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w);
  write(path.join(w.a, "tracked.ts"), "export const value = 1;\n");
  w.git(w.a, "add", "tracked.ts");
  w.git(w.a, "commit", "-qm", "Track file");
  write(path.join(w.a, "tracked.ts"), "export const value = 2;\n");
  w.git(w.a, "add", "tracked.ts");
  write(path.join(w.a, "tracked.ts"), "export const value = 1;\n");
  const result = run(w);
  assert.ok(result.scope.files.includes("tracked.ts"));
  const prompt = mock.events().find((e) => e.type === "start").input;
  assert.ok(prompt.includes("stagedPatch") && prompt.includes("unstagedPatch"));
  assert.equal(w.git(w.a, "show", ":tracked.ts"), "export const value = 2;");
});

test("a clean workspace is not scored and launches no reviewers", (t) => {
  const w = new Workspace(t);
  const result = run(w);
  assert.equal(result.evaluation.score, null);
  assert.deepEqual(result.scope.files, []);
  assert.ok(!fs.existsSync(w.log));
});

test("parallel Codex and Claude reviewers return evidence and RL scores deduplicated findings using a separate policy", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    behavior: { delay: 300, result: { ...clean, findings: [finding] } },
    reuse: {
      delay: 300,
      result: { ...clean, findings: [{ ...finding, severity: "medium" }] },
    },
    quality: { delay: 300 },
  });
  configure(w, "agents", (agents) => {
    agents.quality.provider = "claude";
    agents.quality.model = "test-model";
  });
  configure(w, "policies", (policies) => {
    policies.review.instructions += " SHARED-POLICY-CRITERIA";
  });
  const result = run(w, false);
  assert.equal(result.status, "completed");
  assert.equal(result.evaluation.score, 80);
  assert.equal(result.evaluation.verdict, "fix-required");
  assert.equal(result.evaluation.findings.length, 1);
  assert.equal(w.status().workflow.id, result.id);
  assert.match(
    w.rl(["status", "--workspace"], { cwd: w.a }).stdout,
    /Workflow · triple-review · completed/,
  );
  assert.deepEqual(result.evaluation.findings[0].owners.sort(), [
    "behavior",
    "reuse",
  ]);
  const events = mock.events(),
    starts = events.filter((e) => e.type === "start"),
    ends = events.filter((e) => e.type === "end");
  assert.equal(starts.length, 3);
  assert.ok(
    Math.max(...starts.map((e) => e.time)) <
      Math.min(...ends.map((e) => e.time)),
  );
  assert.ok(
    starts.every(
      (e) =>
        e.cwd === w.a &&
        e.input.includes("SHARED-POLICY-CRITERIA") &&
        !e.input.includes("PRIVATE-FINDING"),
    ),
  );
  assert.ok(
    starts.find((e) => e.step === "behavior").args.includes("read-only"),
  );
  assert.ok(
    starts.find((e) => e.step === "behavior").args.includes("--ephemeral"),
  );
  assert.ok(
    starts
      .find((e) => e.step === "quality")
      .args.includes("--no-session-persistence"),
  );
  assert.ok(
    starts.find((e) => e.step === "quality").args.includes("Read,Glob,Grep"),
  );
  assert.equal(result.metrics.inputTokens, 30);
  assert.equal(result.metrics.costUsd, null);
  const agentFile = read(path.join(w.a, ".rl/agents.json"));
  configure(w, "policies", (policies) => {
    policies.review.weights.high = 7;
    policies.review.blockRequired = false;
  });
  const rescored = JSON.parse(
    w.rl(["workflow", "score", result.id, "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(rescored.evaluation.score, 93);
  assert.equal(rescored.evaluation.verdict, "ready");
  assert.equal(rescored.config.policies.review.weights.high, 20);
  assert.equal(rescored.assessments.length, 2);
  assert.equal(rescored.assessments[1].policy.weights.high, 7);
  assert.equal(mock.events().filter((e) => e.type === "start").length, 3);
  assert.equal(read(path.join(w.a, ".rl/agents.json")), agentFile);
  assert.match(
    w.rl(["workflow", "metrics", result.id], { cwd: w.a }).stdout,
    /inputTokens: 30/,
  );
  w.rl(["workflow", "status", result.id], { cwd: w.b, ok: false });
});

test("workflow dependencies order agents and run shared checks once without a shell", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    behavior: { result: { ...clean, checkRequests: ["checks"] } },
    reuse: { result: { ...clean, checkRequests: ["checks"] } },
  });
  const checkLog = path.join(w.root, "check-log.jsonl");
  w.env.WORKFLOW_CHECK_LOG = checkLog;
  w.stub(
    "workflow-check",
    "require('node:fs').appendFileSync(process.env.WORKFLOW_CHECK_LOG,JSON.stringify({args:process.argv.slice(2),time:Date.now()})+'\\n');console.log('SHARED-CHECK-PASSED');",
  );
  configure(w, "workflows", (workflows) => {
    workflows["triple-review"].steps = [
      {
        id: "checks",
        command: ["workflow-check", "literal $(touch nope)"],
        after: [],
      },
      { id: "behavior", agent: "behavior", after: ["checks"] },
      { id: "reuse", agent: "reuse", after: ["checks"] },
      { id: "quality", agent: "quality", after: ["behavior"] },
    ];
  });
  const result = run(w);
  assert.equal(result.evaluation.verdict, "ready");
  const checks = read(checkLog)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].args, ["literal $(touch nope)"]);
  const events = mock.events();
  assert.ok(
    events
      .find((event) => event.type === "start" && event.step === "behavior")
      .input.includes("SHARED-CHECK-PASSED"),
  );
  assert.ok(
    events.find((e) => e.step === "quality" && e.type === "start").time >=
      events.find((e) => e.step === "behavior" && e.type === "end").time,
  );
  assert.ok(!fs.existsSync(path.join(w.a, "nope")));
});

test("invalid agent output is retried once and missing checks keep a high score incomplete", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    behavior: { malformed: true },
    reuse: { result: { ...clean, checkRequests: ["unconfigured-check"] } },
  });
  const result = run(w, false);
  assert.equal(result.stages.find((s: any) => s.id === "behavior").attempts, 2);
  assert.equal(result.evaluation.verdict, "incomplete");
  assert.equal(result.evaluation.score, 100);
  assert.ok(
    result.evaluation.limitations.some((s: string) =>
      s.includes("unconfigured-check"),
    ),
  );
  assert.equal(mock.events().filter((e) => e.type === "start").length, 4);
  assert.equal(result.metrics.inputTokens, null);
});

test("a failed shared check runs once, blocks dependents and leaves the review incomplete", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w);
  w.env.WORKFLOW_CHECK_LOG = path.join(w.root, "failed-check-log.txt");
  w.stub(
    "failing-check",
    "require('node:fs').appendFileSync(process.env.WORKFLOW_CHECK_LOG,'check\\n');console.error('Check failed');process.exit(2);",
  );
  configure(w, "workflows", (workflows) => {
    workflows["triple-review"].steps = [
      { id: "checks", command: ["failing-check"], after: [] },
      { id: "behavior", agent: "behavior", after: ["checks"] },
      { id: "reuse", agent: "reuse", after: [] },
    ];
  });
  const result = run(w, false);
  assert.equal(result.evaluation.verdict, "incomplete");
  assert.equal(
    result.stages.find((stage: any) => stage.id === "behavior").status,
    "blocked",
  );
  assert.equal(read(w.env.WORKFLOW_CHECK_LOG!).trim(), "check");
  assert.equal(
    mock.events().filter((event) => event.type === "start").length,
    1,
  );
});

test("routing leads trigger a focused owner follow-up after independent passes", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    behavior: {
      result: {
        ...clean,
        findings: [{ ...finding, required: false, severity: "low" }],
        routingLeads: [
          {
            owner: "reuse",
            file: "app.ts",
            reason: "ROUTED-LEAD: inspect a counterpart",
          },
        ],
      },
    },
    "followup-reuse": { result: { ...clean, summary: "Follow-up verified" } },
  });
  const result = run(w);
  const events = mock.events();
  const follow = events.find(
    (e) => e.type === "start" && e.step === "followup-reuse",
  );
  assert.ok(follow.input.includes("ROUTED-LEAD"));
  assert.ok(!follow.input.includes("PRIVATE-FINDING"));
  assert.ok(
    follow.time >=
      Math.max(
        ...events
          .filter((e) => e.type === "end" && !e.step.startsWith("followup-"))
          .map((e) => e.time),
      ),
  );
  assert.equal(result.stages.length, 4);
  assert.equal(result.evaluation.score, 98);
});

test("configuration cycles, misplaced metrics and symlinks are rejected before starting agents", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w);
  const file = path.join(w.a, ".rl/agent-workflows.json"),
    before = read(file);
  configure(w, "workflows", (workflows) => {
    workflows["triple-review"].steps[0].after = ["quality"];
    workflows["triple-review"].steps[2].after = ["behavior"];
  });
  assert.match(
    w.rl(["workflow", "run", "--base", "develop"], { cwd: w.a, ok: false })
      .stderr,
    /cycle/,
  );
  write(file, before);
  const agents = path.join(w.a, ".rl/agents.json"),
    agentsBefore = read(agents);
  configure(w, "agents", (profiles) => {
    profiles.behavior.score = 100;
  });
  w.rl(["workflow", "run", "--base", "develop"], { cwd: w.a, ok: false });
  write(agents, agentsBefore);
  fs.renameSync(agents, path.join(w.root, "agent-config.json"));
  fs.symlinkSync(path.join(w.root, "agent-config.json"), agents);
  assert.match(
    w.rl(["agent", "list"], { cwd: w.a, ok: false }).stderr,
    /symlink/,
  );
  assert.equal(mock.events().length, 0);
});

test("scope changes and stage timeouts cannot produce a ready verdict", (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, { behavior: { mutate: true } });
  const changed = run(w, false);
  assert.equal(changed.status, "paused");
  assert.equal(changed.evaluation.verdict, "incomplete");
  w.rl(["workflow", "resume", changed.id], { cwd: w.a, ok: false });
  write(
    mock.fixtures,
    JSON.stringify({
      behavior: { delay: 2000 },
      reuse: { delay: 2000 },
      quality: { delay: 2000 },
    }),
  );
  configure(w, "workflows", (workflows) => {
    workflows["triple-review"].timeoutSeconds = 1;
    workflows["triple-review"].retries = 0;
  });
  const timed = run(w, false);
  assert.equal(timed.evaluation.verdict, "incomplete");
  assert.ok(timed.stages.every((step: any) => step.status === "failed"));
});

test("pause and cancellation are workspace scoped and resume retains completed stages", async (t) => {
  const w = new Workspace(t);
  const mock = fixture(w, {
    behavior: { delay: 120000 },
    reuse: { delay: 120000 },
    quality: { delay: 0 },
  });
  const child = spawn(CLI, ["workflow", "run", "--base", "develop", "--json"], {
    cwd: w.a,
    env: w.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const completed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  t.after(() => child.kill("SIGTERM"));
  let ready = false;
  for (let attempt = 0; attempt < 450; attempt++) {
    if (mock.events().some((e) => e.step === "quality" && e.type === "end")) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, stderr);
  const status = JSON.parse(
    w.rl(["workflow", "status", "--json"], { cwd: w.a }).stdout,
  );
  assert.match(
    w.rl(["workflow", "resume", status.id], { cwd: w.a, ok: false }).stderr,
    /lock/i,
  );
  w.rl(["workflow", "pause", status.id], { cwd: w.b, ok: false });
  w.rl(["workflow", "pause", status.id], { cwd: w.a });
  assert.equal(await completed, 1, stderr);
  const paused = JSON.parse(stdout);
  assert.equal(paused.status, "paused");
  const profiles = path.join(w.a, ".rl/agents.json"),
    originalProfiles = read(profiles);
  write(profiles, "{broken configuration");
  assert.equal(
    JSON.parse(w.rl(["workflow", "status", "--json"], { cwd: w.a }).stdout).id,
    status.id,
  );
  write(profiles, originalProfiles);
  w.rl(["workflow", "cancel", status.id], { cwd: w.a });
  assert.equal(
    JSON.parse(w.rl(["workflow", "status", "--json"], { cwd: w.a }).stdout)
      .status,
    "cancelled",
  );
  write(mock.fixtures, "{}");
  const resumed = JSON.parse(
    w.rl(["workflow", "resume", status.id, "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(resumed.evaluation.verdict, "ready");
  assert.equal(
    mock.events().filter((e) => e.step === "quality" && e.type === "start")
      .length,
    1,
  );
  assert.equal(
    resumed.stages.find((step: any) => step.id === "behavior").attempts,
    2,
  );
});
