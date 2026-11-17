import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { WorkflowRun } from "../dist/agent-runner.js";
import { PRESET } from "../dist/agent-presets.js";
import { initializeQuality } from "../dist/orchestration/quality.js";
import {
  WorkflowProgress,
  followWorkflowProgress,
} from "../dist/orchestration/progress.js";
import { buildClaimedRolePrompt } from "../dist/orchestration/prompts.js";
import { COORDINATOR_INSTRUCTIONS } from "../dist/orchestration/lean-protocol.js";
import { CLI, Workspace, write, readJson } from "./helpers.js";

function fixture(): WorkflowRun {
  return {
    version: 1,
    id: randomUUID(),
    key: randomUUID(),
    workspace: "/fixture",
    branch: "feature",
    workflow: "writer-reviewer-dry",
    config: structuredClone(PRESET),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status: "running",
    controlRequested: null,
    prompt: "Improve behavior",
    scope: {
      base: "HEAD",
      baseCommit: "a".repeat(40),
      head: "a".repeat(40),
      fingerprint: "b".repeat(64),
      files: [],
    },
    stages: [
      {
        id: "research",
        agent: "researcher",
        after: [],
        status: "pending",
        attempts: 0,
        durationMs: 0,
      },
    ],
    routed: false,
    assessments: [],
    quality: initializeQuality("standard", "Investigate alternatives"),
  };
}

test("progress reports milestones once, shows waiting honestly and sanitizes agent messages", () => {
  const run = fixture(),
    reporter = new WorkflowProgress();
  assert.match(reporter.update(run, 0).join("\n"), /Workflow.*RUNNING/);
  assert.deepEqual(reporter.update(run, 1000), []);
  assert.match(reporter.update(run, 30000).join("\n"), /no active claims/);
  Object.assign(run.stages[0], {
    status: "running",
    claim: randomUUID(),
    childId: "child",
    startedAt: new Date(31000).toISOString(),
    heartbeatAt: new Date(31000).toISOString(),
    progress: "Tracing callers\n\x1b[2Jnext",
  });
  const lines = reporter.update(run, 31000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /research · RESEARCHING.*Tracing callers next/);
  assert.doesNotMatch(lines[0], /\x1b|\n/);
  assert.match(
    reporter.update(run, 61000)[0],
    /last heartbeat 30s ago.*liveness unverified/,
  );
  run.stages[0].status = "failed";
  run.stages[0].error = "Source unavailable";
  assert.match(reporter.update(run, 62000)[0], /FAILED.*Source unavailable/);
  run.status = "cancelled";
  assert.match(reporter.update(run, 63000)[0], /CANCELLED/);
});

test("progress exposes research candidates, decisions and captured validation without dumping transcripts", () => {
  const run = fixture(),
    reporter = new WorkflowProgress();
  reporter.update(run, 0);
  run.quality!.research = {
    at: new Date(1).toISOString(),
    step: "research",
    claim: randomUUID(),
    brief: {
      question: "Compare implementation choices",
      fingerprint: run.scope.fingerprint,
      facts: [
        {
          statement: "Existing helper is available",
          confidence: "observed",
          sources: [{ kind: "repository", path: "helper.ts" }],
        },
      ],
      approaches: ["reuse", "replace"].map((id) => ({
        id,
        title: `Approach ${id}`,
        mechanism: id,
        distinction: id,
        files: ["helper.ts"],
        advantages: ["Scoped"],
        tradeoffs: ["Migration"],
        risks: ["Regression"],
        validation: ["Contract tests"],
        assumptions: [],
        sources: [{ kind: "repository" as const, path: "helper.ts" }],
        viability: "viable" as const,
      })),
      recommendation: "reuse",
      comparison: "Compare scope and regression risk",
      uncertainties: ["Compatibility"],
    },
  };
  const research = reporter.update(run, 1).join("\n");
  assert.match(research, /candidate reuse/);
  assert.match(research, /candidate replace/);
  assert.match(research, /recommends reuse; 1 unresolved/);
  assert.match(research, /awaits.*decision/);
  run.quality!.research.decision = {
    at: new Date(2).toISOString(),
    approach: "reuse",
    rationale: "Preserves callers",
  };
  assert.match(
    reporter.update(run, 2).join("\n"),
    /Approach selected: reuse.*Preserves callers/,
  );
  const id = randomUUID();
  run.quality!.capture = {
    id,
    check: "contract",
    command: ["npm", "test"],
    cwd: "/fixture",
    mode: "mocked",
    timeoutMs: 1000,
    startedAt: new Date(3).toISOString(),
    fingerprint: run.scope.fingerprint,
  };
  assert.match(
    reporter.update(run, 3).join("\n"),
    /Validation contract · RUNNING · mocked/,
  );
  delete run.quality!.capture;
  run.quality!.receipts.push({
    id,
    at: new Date(4).toISOString(),
    check: "contract",
    criteria: [],
    command: ["npm", "test"],
    cwd: "/fixture",
    exitCode: 1,
    mode: "mocked",
    fingerprint: run.scope.fingerprint,
    files: [],
    artifacts: [],
    stdout: "RAW TRANSCRIPT",
    stderr: "RAW FAILURE",
    durationMs: 1,
    source: "command-captured",
  });
  const validation = reporter.update(run, 4).join("\n");
  assert.match(validation, /exit 1 · command-captured · mocked/);
  assert.doesNotMatch(validation, /RAW/);
  run.quality!.receipts[0].invalidated = true;
  assert.match(reporter.update(run, 5).join("\n"), /INVALIDATED/);
});

test("follow handles completion, cancellation and read failures without leaked listeners", async () => {
  const before = process.listenerCount("SIGINT"),
    lines: string[] = [];
  const run = fixture();
  let reads = 0;
  await followWorkflowProgress(
    () => {
      if (++reads === 2) run.status = "completed";
      return run;
    },
    { write: (line) => lines.push(line), intervalMs: 5 },
  );
  assert.match(lines.join("\n"), /COMPLETED/);
  assert.equal(reads, 2);
  const controller = new AbortController();
  run.status = "running";
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await followWorkflowProgress(() => run, {
      write: () => {},
      signal: controller.signal,
      intervalMs: 5,
    });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(run.status, "running");
  await assert.rejects(
    followWorkflowProgress(
      () => {
        throw new Error("run missing");
      },
      { write: () => {} },
    ),
    /run missing/,
  );
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("CLI follows a pinned run over pipes, emits changes and leaves persisted state untouched", async (t) => {
  const w = new Workspace(t);
  write(path.join(w.a, "change.ts"), "export const value = 1;\n");
  const run = JSON.parse(
    w.rl(
      [
        "workflow",
        "run",
        "--level",
        "light",
        "--base",
        "HEAD",
        "--agent",
        "claude",
        "--session",
        randomUUID(),
        "--json",
      ],
      { cwd: w.a },
    ).stdout,
  );
  const state = JSON.parse(
    w.rl(["status", "--workspace", "--json"], { cwd: w.a }).stdout,
  ).stateDirectory;
  const file = path.join(state, "workflow-runs", run.id, "run.json");
  const child = spawn(CLI, ["workflow", "status", "latest", "--follow"], {
    cwd: w.a,
    env: w.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "",
    errors = "",
    changed = false;
  child.stdout.on("data", (data) => {
    output += data;
    if (!changed && output.includes("Workflow")) {
      changed = true;
      const saved = readJson(file);
      saved.status = "paused";
      write(file + ".next", JSON.stringify(saved));
      fs.renameSync(file + ".next", file);
    }
  });
  child.stderr.on("data", (data) => {
    errors += data;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 0, output + errors);
  assert.match(output, /RUNNING/);
  assert.match(output, /PAUSED/);
  assert.doesNotMatch(output, /\x1b/);
  assert.equal(readJson(file).status, "paused");
  w.rl(["workflow", "status", "--follow", "--json"], { cwd: w.a, ok: false });
});

test("coordinator and custom claimed roles receive visible progress instructions", () => {
  assert.match(COORDINATOR_INSTRUCTIONS, /main conversation/);
  assert.match(COORDINATOR_INSTRUCTIONS, /30 seconds/);
  const prompt = buildClaimedRolePrompt({
    roleInstructions: "Custom researcher",
    policyInstructions: "Follow requirements",
    writable: false,
    collaborative: false,
    collaborationSection: "",
    workspace: "/fixture",
    userPrompt: "Task",
    dependenciesJson: "[]",
  });
  assert.match(prompt, /Record rl_workflow_heartbeat/);
  assert.match(prompt, /seeding candidate approaches/);
  assert.match(prompt, /Stay read-only/);
});
