import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT, CLI, Workspace, write, readJson } from "./helpers.js";
const moduleUrl = (name: string) =>
  pathToFileURL(path.join(ROOT, `dist/${name}.js`)).href;
const { callWorkflowTool, resumeNativeRun } = await import(
  moduleUrl("session-workflows")
);
const { Store } = await import(moduleUrl("store"));
const { captureScope, readRun, workflowReviewState } = await import(
  moduleUrl("agent-runner")
);
const { evaluate } = await import(moduleUrl("review-policy"));
const { PRESET } = await import(moduleUrl("agent-presets"));
const { selectWorkflowLevel, criterionResults, stageLease } = await import(
  moduleUrl("orchestration/quality")
);
const { ResearchBriefSchema } = await import(
  moduleUrl("orchestration/research")
);
const { WORKFLOW_EVAL_SUITE, evaluateWorkflowRuns } = await import(
  moduleUrl("orchestration/evaluation")
);
const { agentState } = await import(moduleUrl("orchestration/status"));
function seedBrief(fingerprint: string) {
  return {
    question: "Choose an implementation strategy",
    fingerprint,
    facts: [
      {
        statement: "The task has an existing workspace and constraints",
        confidence: "observed",
        sources: [{ kind: "repository", path: "code.ts" }],
      },
    ],
    approaches: [
      {
        id: "incremental",
        title: "Extend the current path",
        mechanism: "Add validation in the existing synchronous call path",
        distinction:
          "Keeps execution synchronous and extends current ownership",
      },
      {
        id: "adapter",
        title: "Introduce a boundary adapter",
        mechanism:
          "Normalize inputs through an adapter before invoking existing behavior",
        distinction: "Moves normalization into a reusable boundary component",
      },
      {
        id: "queue",
        title: "Process changes asynchronously",
        mechanism:
          "Persist requests in a queue and process them using a worker",
        distinction:
          "Changes execution timing, persistence and failure recovery",
      },
    ].map((a) => ({
      ...a,
      files: ["code.ts"],
      advantages: ["Addresses the task using this mechanism"],
      tradeoffs: ["Changes implementation structure"],
      risks: ["Requires focused validation"],
      validation: ["Exercise success and error cases"],
      assumptions: [],
      sources: [{ kind: "repository", path: "code.ts" }],
      viability: "viable",
    })),
    comparison:
      "All seeds are compared against the same behavior and validation criterion; the incremental path has the smallest scope",
    recommendation: "incremental",
    uncertainties: [],
  };
}
const clean = {
  summary: "Reviewed",
  complete: true,
  findings: [],
  limitations: [],
  checkRequests: [],
  routingLeads: [],
};
const finding = {
  title: "Authorization bypass",
  severity: "critical",
  required: false,
  rootCause: "Missing guard",
  file: "code.ts",
  line: 1,
  evidence: "Reproduced",
  recommendation: "Validate access",
  confidence: "observed",
};
function setup(t: TestContext) {
  t.after(() => process.chdir(ROOT));
  const w = new Workspace(t);
  process.chdir(w.a);
  const store = new Store(w.repo, w.state),
    identity = { agent: "codex", sessionId: randomUUID() };
  const rpc = (action: string, input: Record<string, unknown> = {}) =>
    callWorkflowTool(store, `rl_workflow_${action}`, { ...identity, ...input });
  const start = (level = "standard", validation = "any") =>
    rpc("start", {
      workflow: "writer-reviewer-dry",
      base: "develop",
      level,
      prompt: "Improve code",
      criteria: [
        {
          id: "behavior",
          text: "Requested behavior works",
          required: true,
          validation,
          checks: [
            {
              id: "behavior-check",
              expected:
                "Requested behavior succeeds and error cases are handled",
            },
          ],
        },
      ],
    });
  const preflight = async (
    run: string,
    extra: Record<string, unknown> = {},
  ) => {
    const saved = readRun(store, run).run;
    if (!saved.quality.governance.assessment)
      await rpc("assess", {
        run,
        assessment: {
          level: saved.quality.level,
          rationale: "Bounded implementation scope with independent review",
          uncertainty: [],
          systems: ["Current workspace"],
          consequences: ["Behavioral regression if incorrect"],
        },
      });
    return rpc("preflight", {
      run,
      capabilities: {
        delegation: true,
        messaging: true,
        readOnly: true,
        models: ["gpt-6-astra"],
        ...extra,
      },
    });
  };
  const claim = async (run: string, step: string) => {
    const saved = readRun(store, run).run;
    const research = saved.stages.find(
      (stage: { agent?: string }) => stage.agent === "researcher",
    );
    if (step !== "research" && research && research.status !== "completed") {
      const claimed = await rpc("claim", { run, step: "research" });
      await rpc("bind", {
        run,
        step: "research",
        claim: claimed.claim,
        childId: randomUUID(),
      });
      await rpc("research", {
        run,
        step: "research",
        claim: claimed.claim,
        brief: seedBrief(saved.scope.fingerprint),
      });
      await rpc("report", {
        run,
        step: "research",
        claim: claimed.claim,
        result: clean,
      });
      await rpc("decide", {
        run,
        approach: "incremental",
        rationale: "Fits the existing task with the smallest change surface",
      });
    }
    const result = await rpc("claim", { run, step });
    if (readRun(store, run).run.collaboration)
      await rpc("bind", {
        run,
        step,
        claim: result.claim,
        childId: randomUUID(),
      });
    if (step === "reviewer")
      await rpc("orient", {
        run,
        step,
        claim: result.claim,
        fingerprint: captureScope(w.a, "develop").scope.fingerprint,
        risks: ["Check behavior independently"],
        checksToChallenge: ["Exercise failure cases"],
        assumptions: [],
      });
    return result;
  };
  const report = (
    claimed: { run: string; step: string; claim: string },
    result: Record<string, unknown> = clean,
  ) =>
    rpc("report", {
      run: claimed.run,
      step: claimed.step,
      claim: claimed.claim,
      result,
    });
  const receipt = (run: string, mode = "static", exitCode = 0) =>
    rpc("validation", {
      run,
      receipt: {
        criteria: ["behavior"],
        check: "behavior-check",
        command: [process.execPath, "-e", "console.log('check passed')"],
        cwd: w.a,
        exitCode,
        mode,
        fingerprint: captureScope(w.a, "develop").scope.fingerprint,
        files: ["code.ts"],
        artifacts: [],
        stdout: exitCode ? "" : "check passed\n",
        stderr: exitCode ? "failed" : "",
        durationMs: 15,
      },
    });
  return { w, store, rpc, start, preflight, claim, report, receipt, identity };
}
test("critical and required findings block acceptance even when scores and legacy policy allow them", () => {
  const policy = {
    ...PRESET.policies.review,
    minimumScore: 0,
    blockRequired: false,
  };
  assert.equal(
    evaluate(policy, [
      { owner: "reviewer", result: { ...clean, findings: [finding] } },
    ]).verdict,
    "fix-required",
  );
  assert.equal(
    evaluate(policy, [
      {
        owner: "reviewer",
        result: {
          ...clean,
          findings: [{ ...finding, severity: "low", required: true }],
        },
      },
    ]).verdict,
    "fix-required",
  );
  const rejected = {
    ...finding,
    disposition: {
      status: "rejected",
      reason: "Guard is already applied",
      evidence: "Caller rejects anonymous requests",
    },
  };
  assert.equal(
    evaluate(policy, [
      { owner: "reviewer", result: { ...clean, findings: [rejected] } },
    ]).verdict,
    "ready",
  );
  assert.equal(
    evaluate(policy, [
      { owner: "a", result: { ...clean, findings: [rejected] } },
      { owner: "b", result: { ...clean, findings: [finding] } },
    ]).verdict,
    "fix-required",
  );
});
test("automatic levels account for sensitive behavior and explicit user overrides", () => {
  assert.equal(
    selectWorkflowLevel("auto", ["README.md"], "Update docs").level,
    "light",
  );
  assert.equal(
    selectWorkflowLevel("auto", ["auth.ts"], "Small change").level,
    "deep",
  );
  assert.equal(
    selectWorkflowLevel("auto", [], "Fix payment retries").level,
    "deep",
  );
  assert.equal(
    selectWorkflowLevel("auto", [], "Add an interface").level,
    "standard",
  );
  assert.equal(
    selectWorkflowLevel("auto", ["README.md"], "Implement a new service").level,
    "standard",
  );
  assert.equal(
    selectWorkflowLevel("light", ["auth.ts"], "Fix auth").level,
    "light",
  );
});
test("preflight gates actual delegation, messaging, models and read-only restrictions before claims", async (t) => {
  const { rpc, start, preflight, claim } = setup(t),
    run = await start();
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /capabilities unverified/,
  );
  for (const capabilities of [
    { delegation: false },
    { messaging: false },
    { readOnly: false },
    { models: [] },
  ]) {
    await preflight(run.id, capabilities);
    await assert.rejects(rpc("claim", { run: run.id, step: "writer" }));
  }
  await preflight(run.id, {
    readOnly: false,
    models: ["alternative", "gpt-6-astra"],
    modelOverrides: { writer: "alternative", reviewer: "alternative" },
    degradedReason:
      "Host lacks tool isolation; user-approved inherited model; restrictions remain behavioral",
  });
  const claimed = await claim(run.id, "writer");
  assert.equal(claimed.step, "writer");
  assert.equal(claimed.profile.model, "alternative");
  await assert.rejects(preflight(run.id), /cannot be changed/);
});
test("Light is sequential and completion waits for current acceptance evidence rather than reported success", async (t) => {
  const { w, store, rpc, start, preflight, claim, report, receipt } = setup(t);
  write(path.join(w.a, "code.ts"), "export const value = 1;\n");
  const run = await start("light");
  assert.equal(run.stages.length, 2);
  await preflight(run.id, { messaging: false });
  await assert.rejects(
    rpc("claim", { run: run.id, step: "reviewer" }),
    /No ready/,
  );
  const writer = await claim(run.id, "writer");
  write(path.join(w.a, "code.ts"), "export const value = 2;\n");
  await report(writer);
  const reviewer = await claim(run.id, "reviewer");
  const finished = await report(reviewer);
  assert.equal(finished.status, "paused");
  assert.notEqual(finished.evaluation.verdict, "ready");
  await receipt(run.id);
  const saved = readRun(store, run.id).run;
  assert.equal(saved.status, "completed");
  assert.equal(saved.evaluation.verdict, "ready");
  assert.equal(saved.assessments.length, 1);
  assert.equal(criterionResults(saved)[0].status, "passed");
  assert.equal(saved.quality.receipts[0].source, "parent-reported");
  assert.equal(fs.existsSync(w.log), false);
});

test("a Light review with known blockers cannot become completed through resume or new receipts", async (t) => {
  const { w, store, start, preflight, claim, report, receipt, identity } =
    setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start("light");
  await preflight(run.id);
  const writer = await claim(run.id, "writer");
  await report(writer);
  await receipt(run.id);
  const reviewer = await claim(run.id, "reviewer");
  const blocked = await report(reviewer, { ...clean, findings: [finding] });
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.evaluation.findings[0].severity, "critical");
  const resumed = await resumeNativeRun(store, run.id, identity);
  assert.equal(resumed.status, "paused");
  await receipt(run.id);
  assert.equal(readRun(store, run.id).run.status, "paused");
});

test("CLI previews the real selected level, accepts JSON plans and rejects malformed plans before creating state", async (t) => {
  const { w, store, rpc, identity } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const preview = JSON.parse(
    w.rl(
      [
        "workflow",
        "run",
        "--base",
        "develop",
        "--level",
        "light",
        "--dry-run",
        "--json",
      ],
      { cwd: w.a },
    ).stdout,
  );
  assert.equal(preview.level, "light");
  assert.deepEqual(preview.definition.steps[1].after, ["writer"]);
  const [instance] = store.current(),
    runs = path.join(path.dirname(instance), "workflow-runs");
  await assert.rejects(
    rpc("start", {
      base: "develop",
      level: "light",
      criteria: [
        { id: "x", text: "A" },
        { id: "x", text: "B" },
      ],
    }),
    /unique/,
  );
  assert.equal(fs.existsSync(runs), false);
  const result = JSON.parse(
    w.rl(
      [
        "workflow",
        "run",
        "--base",
        "develop",
        "--file",
        "-",
        "--agent",
        identity.agent,
        "--session",
        identity.sessionId,
        "--json",
      ],
      {
        cwd: w.a,
        input: JSON.stringify({
          level: "standard",
          criteria: [
            {
              id: "behavior",
              text: "Behavior works",
              checks: [{ id: "behavior-check", expected: "Behavior succeeds" }],
            },
          ],
        }),
      },
    ).stdout,
  );
  assert.equal(result.quality.level, "standard");
  assert.equal(result.qualityStatus.criteria[0].status, "unverified");
  await rpc("assess", {
    run: result.id,
    assessment: {
      level: "standard",
      rationale: "Normal feature scope",
      uncertainty: [],
      systems: ["Local behavior"],
      consequences: ["Regression"],
    },
  });
  const preflight = JSON.parse(
    w.rl(
      [
        "workflow",
        "preflight",
        result.id,
        "--file",
        "-",
        "--agent",
        identity.agent,
        "--session",
        identity.sessionId,
        "--json",
      ],
      {
        cwd: w.a,
        input: JSON.stringify({
          capabilities: {
            delegation: true,
            messaging: true,
            readOnly: true,
            models: ["gpt-6-astra"],
          },
        }),
      },
    ).stdout,
  );
  assert.deepEqual(preflight.blockers, []);
});
test("Standard concurrent checkpoints cannot accept a critical defect regardless of the numeric rating", async (t) => {
  const { w, rpc, start, preflight, claim } = setup(t);
  write(path.join(w.a, "code.ts"), "value one\n");
  const run = await start();
  assert.equal(run.stages.length, 3);
  assert.equal(run.config.workflows[run.workflow].concurrency, 2);
  await preflight(run.id);
  const writer = await claim(run.id, "writer"),
    reviewer = await claim(run.id, "reviewer");
  const submit = await rpc("submit", {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    files: ["code.ts"],
    newFunctions: [],
    summary: "Stable changes",
  });
  const review = await rpc("review", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    submissionId: submit.id,
    rating: 10,
    rationale: "Evidence",
    duplicateSuspicions: [],
    result: { ...clean, findings: [finding] },
  });
  assert.equal(review.review.accepted, false);
});
test("mocked checks cannot satisfy live criteria and later failures or source edits invalidate evidence", async (t) => {
  const { w, store, start, receipt, rpc } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start("light", "live");
  await assert.rejects(receipt(run.id, "mocked"), /mode does not match/);
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].status,
    "unverified",
  );
  await receipt(run.id, "live");
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].status,
    "passed",
  );
  await receipt(run.id, "live", 1);
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].status,
    "failed",
  );
  const previous = captureScope(w.a, "develop").scope.fingerprint;
  write(path.join(w.a, "code.ts"), "two\n");
  const current = captureScope(w.a, "develop").scope.fingerprint;
  assert.equal(
    criterionResults(readRun(store, run.id).run, current)[0].stale,
    true,
  );
  await assert.rejects(
    rpc("validation", {
      run: run.id,
      receipt: {
        criteria: ["behavior"],
        check: "behavior-check",
        command: ["test"],
        cwd: w.a,
        exitCode: 0,
        mode: "live",
        fingerprint: previous,
        files: [],
        artifacts: [],
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    }),
    /source changed/,
  );
});
test("expired claim recovery requires host-confirmed stop and invalidates old reports and bindings", async (t) => {
  const { w, store, rpc, start, preflight, claim, report } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start();
  await preflight(run.id);
  const writer = await claim(run.id, "writer");
  await assert.rejects(
    rpc("recover", {
      run: run.id,
      step: "writer",
      claim: writer.claim,
      stopped: true,
      reason: "Stopped child",
    }),
    /still active/,
  );
  const { directory } = readRun(store, run.id),
    file = path.join(directory, "run.json"),
    disk = readJson(file);
  const activeWriter = disk.stages.find(
    (stage: { id: string }) => stage.id === "writer",
  );
  activeWriter.heartbeatAt = new Date(Date.now() - 360000).toISOString();
  write(file, JSON.stringify(disk));
  assert.equal(
    stageLease(readRun(store, run.id).run, activeWriter).stale,
    true,
  );
  await assert.rejects(
    rpc("recover", {
      run: run.id,
      step: "writer",
      claim: writer.claim,
      stopped: false,
      reason: "Not stopped",
    }),
  );
  await rpc("recover", {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    stopped: true,
    reason: "Native child was stopped",
  });
  await assert.rejects(report(writer), /claim/);
  const next = await claim(run.id, "writer");
  assert.notEqual(next.claim, writer.claim);
});
test("workflow review state is scoped to the exact worktree and carries evidence and reported metrics", async (t) => {
  const { w, start, store, preflight, rpc } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start();
  await preflight(run.id);
  const [file] = store.current();
  const view = workflowReviewState(path.dirname(file), w.a, "feature/a");
  assert.equal(view.run, run.id);
  assert.equal(view.level, "standard");
  assert.equal(view.criteria[0].status, "unverified");
  assert.equal(
    view.metrics.quality.validationSource.includes("parent-reported"),
    true,
  );
  assert.equal(workflowReviewState(path.dirname(file), w.b, "feature/b"), null);
  await assert.rejects(
    rpc("criteria", {
      run: run.id,
      criteria: [
        { id: "a", text: "A" },
        { id: "a", text: "B" },
      ],
    }),
    /unique/,
  );
});

test("research rejects cosmetic variants, missing alternatives and unsupported recommendations", () => {
  const brief = seedBrief("a".repeat(64));
  assert.equal(ResearchBriefSchema.safeParse(brief).success, true);
  assert.equal(
    ResearchBriefSchema.safeParse({
      ...brief,
      approaches: brief.approaches.slice(0, 1),
    }).success,
    false,
  );
  const cosmetic = structuredClone(brief);
  cosmetic.approaches[1].mechanism =
    "  " + brief.approaches[0].mechanism.toUpperCase() + "!!!";
  assert.equal(ResearchBriefSchema.safeParse(cosmetic).success, false);
  assert.equal(
    ResearchBriefSchema.safeParse({ ...brief, recommendation: "missing" })
      .success,
    false,
  );
  const excluded = structuredClone(brief);
  excluded.approaches[0].viability = "ruled-out";
  assert.equal(ResearchBriefSchema.safeParse(excluded).success, false);
});

test("research seeds precede recommendation and an explicit coordinator choice gates implementation", async (t) => {
  const { w, store, rpc, start, preflight, report } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start();
  await preflight(run.id);
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /No ready/,
  );
  const researcher = await rpc("claim", { run: run.id, step: "research" });
  assert.equal(researcher.profile.access, "read-only");
  await rpc("bind", {
    run: run.id,
    step: "research",
    claim: researcher.claim,
    childId: randomUUID(),
  });
  await assert.rejects(report(researcher), /Save the multi-approach/);
  await assert.rejects(
    rpc("research", {
      run: run.id,
      step: "research",
      claim: randomUUID(),
      brief: seedBrief(run.scope.fingerprint),
    }),
    /researcher claim/,
  );
  await rpc("research", {
    run: run.id,
    step: "research",
    claim: researcher.claim,
    brief: seedBrief(run.scope.fingerprint),
  });
  await assert.rejects(
    rpc("decide", {
      run: run.id,
      approach: "incremental",
      rationale: "Prefer this",
    }),
    /Complete the multi-approach/,
  );
  await report(researcher);
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /Coordinator must choose/,
  );
  await assert.rejects(
    rpc("decide", {
      run: run.id,
      approach: "missing",
      rationale: "Prefer this",
    }),
    /Choose a viable/,
  );
  await rpc("decide", {
    run: run.id,
    approach: "adapter",
    rationale: "The boundary needs independent reuse despite added structure",
  });
  const writer = await rpc("claim", { run: run.id, step: "writer" });
  assert.match(writer.prompt, /Normalize inputs through an adapter/);
  assert.match(writer.prompt, /independent reuse/);
  assert.equal(
    readRun(store, run.id).run.quality.research.brief.approaches.length,
    3,
  );
  assert.equal(
    readRun(store, run.id).run.quality.research.decision.approach,
    "adapter",
  );
  assert.equal(fs.existsSync(w.log), false);
});

test("source edits invalidate research decisions before implementation, while Light keeps focused inline research", async (t) => {
  const { w, store, rpc, start, preflight, report } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start("deep");
  assert.equal(run.stages.length, 4);
  await preflight(run.id);
  const researcher = await rpc("claim", { run: run.id, step: "research" });
  await rpc("bind", {
    run: run.id,
    step: "research",
    claim: researcher.claim,
    childId: randomUUID(),
  });
  await rpc("research", {
    run: run.id,
    step: "research",
    claim: researcher.claim,
    brief: seedBrief(run.scope.fingerprint),
  });
  await report(researcher);
  await rpc("decide", {
    run: run.id,
    approach: "incremental",
    rationale: "Fits constraints",
  });
  write(path.join(w.a, "code.ts"), "two\n");
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /Research source changed/,
  );
  assert.equal(
    readRun(store, run.id).run.stages.find(
      (s: { id: string }) => s.id === "writer",
    ).attempts,
    0,
  );
  const light = await start("light");
  assert.equal(
    light.stages.some((s: { agent: string }) => s.agent === "researcher"),
    false,
  );
});

test("real review terminal shows live workflow progress, check output and clickable source findings", async (t) => {
  const { w, store, rpc, start, preflight, claim, receipt } = setup(t);
  write(path.join(w.a, "code.ts"), "value one\n");
  const run = await start();
  await preflight(run.id);
  const writer = await claim(run.id, "writer"),
    reviewer = await claim(run.id, "reviewer");
  const submission = await rpc("submit", {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    files: ["code.ts"],
    newFunctions: [],
    summary: "Stable implementation",
  });
  await rpc("review", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    submissionId: submission.id,
    rating: 8,
    rationale: "Reviewed captured scope",
    duplicateSuspicions: [],
    result: {
      ...clean,
      findings: [
        {
          ...finding,
          title: "Missing edge case",
          severity: "low",
          required: false,
        },
      ],
    },
  });
  await rpc("heartbeat", {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    message: "Implementing validation",
  });
  await receipt(run.id);
  w.env.REVIEW_WORKFLOW_RUN = path.join(
    readRun(store, run.id).directory,
    "run.json",
  );
  const output = await w.commandAsync(
    [
      "python3",
      path.join(ROOT, "tests/review-live-pty.py"),
      w.a,
      process.execPath,
      CLI,
      w.repo,
      w.state,
      path.join(w.root, "worktrees"),
      "workflow",
    ],
    { timeoutMs: 90000 },
  );
  assert.match(output, /PTY: workflow.*passed/);
});

const effort = (level = "standard") => ({
  level,
  rationale: "Assess actual uncertainty, impact and failure consequences",
  uncertainty: ["External callers may need verification"],
  systems: ["Local module and callers"],
  consequences: ["Incorrect results can affect downstream behavior"],
});
const planned = (
  id: string,
  command?: string[],
  scope?: Record<string, unknown>,
) => ({
  id,
  expected: "The specified contract holds and the check exits successfully",
  ...(command ? { command, source: "captured" } : {}),
  ...(scope ? { scope } : {}),
});
function reported(w: Workspace, check: string, exitCode = 0) {
  return {
    check,
    criteria: ["behavior"],
    command: ["manual", check],
    cwd: w.a,
    exitCode,
    mode: "static",
    fingerprint: captureScope(w.a, "develop").scope.fingerprint,
    files: [],
    artifacts: [],
    stdout: "Observed output",
    stderr: "",
    durationMs: 1,
  };
}

test("semantic effort assessment can replace auto topology, pins user choices and freezes at execution", async (t) => {
  const { rpc, start, store, preflight } = setup(t);
  const run = await start("auto");
  await assert.rejects(rpc("claim", { run: run.id, step: "research" }));
  await rpc("assess", { run: run.id, assessment: effort("deep") });
  let saved = readRun(store, run.id).run;
  assert.equal(saved.quality.governance.baseline, "standard");
  assert.equal(saved.quality.level, "deep");
  assert.equal(saved.stages.length, 4);
  await preflight(run.id);
  await rpc("claim", { run: run.id, step: "research" });
  await assert.rejects(
    rpc("assess", { run: run.id, assessment: effort("light") }),
    /frozen/,
  );
  const pinned = await start("light");
  await assert.rejects(
    rpc("assess", { run: pinned.id, assessment: effort("deep") }),
    /pinned/,
  );
  saved = readRun(store, pinned.id).run;
  assert.equal(saved.quality.level, "light");
  assert.equal(saved.stages.length, 2);
});

test("each required planned check must pass independently and check IDs cannot collide", async (t) => {
  const { w, rpc, start, store, preflight, claim } = setup(t),
    run = await start("light");
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Behavior",
        checks: [planned("unit"), planned("integration")],
      },
    ],
  });
  await rpc("validation", { run: run.id, receipt: reported(w, "unit") });
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].status,
    "unverified",
  );
  await rpc("validation", {
    run: run.id,
    receipt: reported(w, "integration", 1),
  });
  await rpc("validation", { run: run.id, receipt: reported(w, "unit") });
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].status,
    "failed",
  );
  await rpc("validation", { run: run.id, receipt: reported(w, "integration") });
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].status,
    "passed",
  );
  await assert.rejects(
    rpc("criteria", {
      run: run.id,
      criteria: [
        {
          id: "behavior",
          text: "Behavior",
          checks: [planned("same"), planned("same")],
        },
      ],
    }),
    /unique/,
  );
  await preflight(run.id);
  await claim(run.id, "writer");
  await assert.rejects(
    rpc("criteria", {
      run: run.id,
      criteria: [{ id: "behavior", text: "Changed", checks: [planned("new")] }],
    }),
    /frozen/,
  );
});

test("unplanned criteria prevent work and provenance cannot be fabricated through validation input", async (t) => {
  const { w, rpc, start, preflight } = setup(t),
    run = await start("light");
  await rpc("criteria", {
    run: run.id,
    criteria: [{ id: "behavior", text: "Behavior" }],
  });
  await preflight(run.id);
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /plan individual checks/,
  );
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Behavior",
        checks: [
          planned("capture", [process.execPath, "-e", "process.exit(0)"]),
        ],
      },
    ],
  });
  await assert.rejects(
    rpc("validation", { run: run.id, receipt: reported(w, "capture") }),
    /command does not match/,
  );
  await assert.rejects(
    rpc("validation", {
      run: run.id,
      receipt: {
        ...reported(w, "capture"),
        command: [process.execPath, "-e", "process.exit(0)"],
        source: "command-captured",
      },
    }),
  );
  await assert.rejects(
    rpc("validation", {
      run: run.id,
      receipt: {
        ...reported(w, "capture"),
        command: [process.execPath, "-e", "process.exit(0)"],
      },
    }),
    /requires captured/,
  );
});

test("capture executes literal argv in the exact worktree and records real success, failure and bounded output", async (t) => {
  const { w, rpc, start, store } = setup(t),
    run = await start("light");
  const argv = [
    process.execPath,
    "-e",
    "console.log(process.cwd());console.log(process.argv[1])",
    "literal $(no-command); $HOME",
  ];
  const fail = [
    process.execPath,
    "-e",
    "console.error('actual error');process.exit(7)",
  ];
  const overflow = [process.execPath, "-e", "console.log('x'.repeat(200000))"];
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Capture",
        checks: [
          planned("success", argv),
          planned("failure", fail),
          planned("overflow", overflow),
        ],
      },
    ],
  });
  const result = await rpc("check", {
    run: run.id,
    check: "success",
    command: argv,
    cwd: w.a,
    mode: "static",
  });
  assert.equal(result.receipt.source, "command-captured");
  assert.equal(result.receipt.exitCode, 0);
  assert.ok(result.receipt.stdout.includes(w.a));
  assert.ok(result.receipt.stdout.includes(argv[3]));
  assert.equal(result.modeSource, "host-reported");
  await assert.rejects(
    rpc("check", {
      run: run.id,
      check: "success",
      command: argv,
      cwd: w.b,
      mode: "static",
    }),
    /exact workspace/,
  );
  await assert.rejects(
    rpc("check", {
      run: run.id,
      check: "success",
      command: ["false"],
      cwd: w.a,
      mode: "static",
    }),
    /exact command/,
  );
  assert.equal(
    (
      await rpc("check", {
        run: run.id,
        check: "failure",
        command: fail,
        cwd: w.a,
        mode: "static",
      })
    ).receipt.exitCode,
    7,
  );
  const tooLarge = await rpc("check", {
    run: run.id,
    check: "overflow",
    command: overflow,
    cwd: w.a,
    mode: "static",
  });
  assert.equal(tooLarge.receipt.exitCode, 125);
  assert.match(tooLarge.receipt.stderr, /size limit/);
  assert.equal(readRun(store, run.id).run.quality.capture, undefined);
  assert.equal(fs.existsSync(w.log), false);
});

test("a captured check leaves the workflow lock available, enforces one command and blocks plan changes", async (t) => {
  const { w, rpc, start, store } = setup(t),
    run = await start("light");
  const argv = [
    process.execPath,
    "-e",
    "setTimeout(()=>console.log('finished'),1200)",
  ];
  await rpc("criteria", {
    run: run.id,
    criteria: [
      { id: "behavior", text: "Capture", checks: [planned("slow", argv)] },
    ],
  });
  const pending = rpc("check", {
    run: run.id,
    check: "slow",
    command: argv,
    cwd: w.a,
    mode: "static",
  });
  const deadline = Date.now() + 5000;
  while (!readRun(store, run.id).run.quality.capture) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let done = false;
  void pending.then(() => {
    done = true;
  });
  await rpc("pending");
  assert.equal(done, false, "metadata operations waited for the check process");
  await assert.rejects(
    rpc("check", {
      run: run.id,
      check: "slow",
      command: argv,
      cwd: w.a,
      mode: "static",
    }),
    /already running/,
  );
  await assert.rejects(
    rpc("criteria", {
      run: run.id,
      criteria: [{ id: "behavior", text: "Replace" }],
    }),
    /while a command/,
  );
  assert.equal((await pending).receipt.exitCode, 0);
});

test("timed-out commands fail and source mutation during a check never produces passing evidence", async (t) => {
  const { w, rpc, start, store } = setup(t),
    run = await start("light");
  write(path.join(w.a, "code.ts"), "one\n");
  const timeout = [process.execPath, "-e", "setInterval(()=>{},1000)"];
  const mutates = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('code.ts','two\\n')",
  ];
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Stable inputs",
        checks: [planned("timeout", timeout), planned("mutates", mutates)],
      },
    ],
  });
  const timed = await rpc("check", {
    run: run.id,
    check: "timeout",
    command: timeout,
    cwd: w.a,
    mode: "static",
    timeoutMs: 60,
  });
  assert.equal(timed.receipt.exitCode, 124);
  assert.match(timed.receipt.stderr, /timed out/);
  const changed = await rpc("check", {
    run: run.id,
    check: "mutates",
    command: mutates,
    cwd: w.a,
    mode: "static",
  });
  assert.equal(changed.receipt.exitCode, 0);
  assert.equal(changed.invalidated, true);
  const checks = criterionResults(
    readRun(store, run.id).run,
    captureScope(w.a, "develop").scope.fingerprint,
  )[0].checks;
  assert.equal(
    checks.find((c: { id: string }) => c.id === "mutates").status,
    "unverified",
  );
  write(path.join(w.a, "code.ts"), "one\n");
  assert.equal(
    criterionResults(readRun(store, run.id).run)[0].checks.find(
      (c: { id: string }) => c.id === "mutates",
    ).status,
    "unverified",
  );
});

test("explicit captured dependency scopes retain unrelated evidence and invalidate index or dependency changes", async (t) => {
  const { w, rpc, start, store } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  write(path.join(w.a, "config.json"), "{}\n");
  const run = await start("light"),
    argv = [process.execPath, "-e", "process.exit(0)"];
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Scoped",
        checks: [
          planned("scoped", argv, {
            kind: "files",
            files: ["code.ts"],
            dependencies: ["config.json"],
            rationale:
              "Module behavior only depends on these files for this check",
          }),
          planned("repository", argv),
        ],
      },
    ],
  });
  for (const check of ["scoped", "repository"])
    await rpc("check", {
      run: run.id,
      check,
      command: argv,
      cwd: w.a,
      mode: "static",
    });
  write(path.join(w.a, "unrelated.txt"), "unrelated\n");
  let result = criterionResults(
    readRun(store, run.id).run,
    captureScope(w.a, "develop").scope.fingerprint,
  )[0];
  assert.equal(result.checks[0].status, "passed");
  assert.equal(result.checks[1].status, "unverified");
  write(path.join(w.a, "config.json"), '{"changed":true}\n');
  w.git(w.a, "add", "--", "config.json");
  write(path.join(w.a, "config.json"), "{}\n");
  result = criterionResults(
    readRun(store, run.id).run,
    captureScope(w.a, "develop").scope.fingerprint,
  )[0];
  assert.equal(result.checks[0].status, "unverified");
  fs.symlinkSync(path.join(w.b, "outside.json"), path.join(w.a, "escape.json"));
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Scope escape",
        checks: [
          planned("escape", argv, {
            kind: "files",
            files: ["escape.json"],
            dependencies: [],
            rationale: "Should be rejected",
          }),
        ],
      },
    ],
  });
  await assert.rejects(
    rpc("check", {
      run: run.id,
      check: "escape",
      command: argv,
      cwd: w.a,
      mode: "static",
    }),
    /remain in this workspace/,
  );
  write(path.join(w.a, ".gitignore"), "ignored.json\n");
  write(path.join(w.a, "ignored.json"), "{}\n");
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Ignored dependency",
        checks: [
          planned("ignored", argv, {
            kind: "files",
            files: ["code.ts"],
            dependencies: ["ignored.json"],
            rationale: "Ignored runtime configuration affects this check",
          }),
        ],
      },
    ],
  });
  await rpc("check", {
    run: run.id,
    check: "ignored",
    command: argv,
    cwd: w.a,
    mode: "static",
  });
  const unchangedGit = captureScope(w.a, "develop").scope.fingerprint;
  write(path.join(w.a, "ignored.json"), '{"changed":true}\n');
  assert.equal(captureScope(w.a, "develop").scope.fingerprint, unchangedGit);
  assert.equal(
    criterionResults(readRun(store, run.id).run, unchangedGit)[0].checks[0]
      .status,
    "unverified",
  );
});

test("reviewer records a first pass before research or writer rationale is exposed and before ratings", async (t) => {
  const { w, rpc, start, preflight, claim } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start();
  await preflight(run.id);
  const writer = await claim(run.id, "writer"),
    reviewer = await rpc("claim", { run: run.id, step: "reviewer" });
  assert.match(reviewer.prompt, /INDEPENDENT FIRST PASS/);
  assert.doesNotMatch(reviewer.prompt, /Introduce a boundary adapter/);
  assert.deepEqual(reviewer.dependencies, []);
  await rpc("bind", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    childId: randomUUID(),
  });
  const submission = await rpc("submit", {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    files: ["code.ts"],
    newFunctions: [],
    summary: "PRIVATE_WRITER_RATIONALE",
  });
  const inbox = await rpc("inbox", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
  });
  assert.doesNotMatch(JSON.stringify(inbox), /PRIVATE_WRITER_RATIONALE/);
  const review = {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    submissionId: submission.id,
    rating: 10,
    rationale: "Reviewed",
    duplicateSuspicions: [],
    result: clean,
  };
  await assert.rejects(rpc("review", review), /independent first pass/);
  const orientation = {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    fingerprint: captureScope(w.a, "develop").scope.fingerprint,
    risks: ["Check invalid inputs"],
    checksToChallenge: ["Does happy path conceal failure?"],
    assumptions: [],
  };
  await assert.rejects(
    rpc("orient", { ...orientation, fingerprint: "a".repeat(64) }),
    /source changed/,
  );
  const revealed = await rpc("orient", orientation);
  assert.equal(revealed.research.decision.approach, "incremental");
  assert.match(
    JSON.stringify(
      await rpc("inbox", {
        run: run.id,
        step: "reviewer",
        claim: reviewer.claim,
      }),
    ),
    /PRIVATE_WRITER_RATIONALE/,
  );
  assert.equal((await rpc("review", review)).review.accepted, true);
});

test("Light reviewer first pass omits writer dependencies and gates final reports", async (t) => {
  const { w, rpc, start, preflight, claim, report } = setup(t),
    run = await start("light");
  await preflight(run.id);
  const writer = await claim(run.id, "writer");
  await report(writer, { ...clean, summary: "PRIVATE_WRITER_RESULT" });
  const reviewer = await rpc("claim", { run: run.id, step: "reviewer" });
  assert.doesNotMatch(reviewer.prompt, /PRIVATE_WRITER_RESULT/);
  assert.deepEqual(reviewer.dependencies, []);
  await assert.rejects(report(reviewer), /independent first pass/);
  const revealed = await rpc("orient", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    fingerprint: captureScope(w.a, "develop").scope.fingerprint,
    risks: ["Independent risks"],
    checksToChallenge: ["Contract test"],
    assumptions: [],
  });
  assert.equal(
    revealed.dependencies[0].result.summary,
    "PRIVATE_WRITER_RESULT",
  );
  assert.equal((await report(reviewer)).status, "paused");
});

test("budgets freeze at execution and expired run or research budgets block further work", async (t) => {
  const { rpc, start, store, preflight } = setup(t),
    run = await start();
  await rpc("budget", {
    run: run.id,
    budgets: { runMs: 10000, researchMs: 1000 },
  });
  await preflight(run.id);
  const researcher = await rpc("claim", { run: run.id, step: "research" });
  await assert.rejects(
    rpc("budget", { run: run.id, budgets: { runMs: 5000 } }),
    /frozen/,
  );
  const { directory } = readRun(store, run.id),
    file = path.join(directory, "run.json"),
    disk = readJson(file);
  disk.createdAt = new Date(Date.now() - 20000).toISOString();
  write(file, JSON.stringify(disk));
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /Run time budget exhausted/,
  );
  disk.createdAt = new Date().toISOString();
  disk.stages[0].durationMs = 2000;
  write(file, JSON.stringify(disk));
  await assert.rejects(
    rpc("claim", { run: run.id, step: "writer" }),
    /Research time budget exhausted/,
  );
  assert.equal(researcher.step, "research");
});

test("validation time and handoff budgets enforce concrete stopping conditions", async (t) => {
  const { w, rpc, start, preflight, claim } = setup(t);
  const run = await start("light"),
    command = [process.execPath, "-e", "setInterval(()=>{},1000)"];
  await rpc("budget", { run: run.id, budgets: { checkMs: 100 } });
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Bounded check",
        checks: [planned("timeout", command)],
      },
    ],
  });
  const result = await rpc("check", {
    run: run.id,
    check: "timeout",
    command,
    cwd: w.a,
    mode: "static",
  });
  assert.equal(result.receipt.exitCode, 124);
  await assert.rejects(
    rpc("check", {
      run: run.id,
      check: "timeout",
      command,
      cwd: w.a,
      mode: "static",
    }),
    /budget exhausted/,
  );
  write(path.join(w.a, "code.ts"), "one\n");
  write(path.join(w.a, "other.ts"), "two\n");
  const team = await start();
  await rpc("budget", { run: team.id, budgets: { submissions: 1 } });
  await preflight(team.id);
  const writer = await claim(team.id, "writer"),
    reviewer = await claim(team.id, "reviewer");
  const first = await rpc("submit", {
    run: team.id,
    step: "writer",
    claim: writer.claim,
    files: ["code.ts"],
    newFunctions: [],
    summary: "First group",
  });
  await rpc("review", {
    run: team.id,
    step: "reviewer",
    claim: reviewer.claim,
    submissionId: first.id,
    rating: 10,
    rationale: "Contract verified",
    duplicateSuspicions: [],
    result: clean,
  });
  await assert.rejects(
    rpc("submit", {
      run: team.id,
      step: "writer",
      claim: writer.claim,
      files: ["other.ts"],
      newFunctions: [],
      summary: "Additional group",
    }),
    /Submission limit/,
  );
});

test("captured evidence can finish a reviewed run without accepting self-reported success", async (t) => {
  const { w, rpc, start, preflight, claim, report, store } = setup(t);
  write(path.join(w.a, "code.ts"), "export const value=1;\n");
  const run = await start("light"),
    command = [process.execPath, "-e", "console.log('verified')"];
  await rpc("criteria", {
    run: run.id,
    criteria: [
      {
        id: "behavior",
        text: "Evidence required",
        checks: [planned("finish", command)],
      },
    ],
  });
  await preflight(run.id);
  const writer = await claim(run.id, "writer");
  await report(writer);
  const reviewer = await claim(run.id, "reviewer");
  assert.equal((await report(reviewer)).status, "paused");
  await rpc("check", {
    run: run.id,
    check: "finish",
    command,
    cwd: w.a,
    mode: "static",
  });
  const saved = readRun(store, run.id).run;
  assert.equal(saved.status, "completed");
  assert.equal(saved.evaluation.verdict, "ready");
  assert.equal(saved.assessments.length, 1);
});

test("repeating rejected content needs evidence-backed coordinator resolution and still requires re-review", async (t) => {
  const { w, rpc, start, preflight, claim, report } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start();
  await preflight(run.id);
  const writer = await claim(run.id, "writer"),
    reviewer = await claim(run.id, "reviewer");
  const submit = {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    files: ["code.ts"],
    newFunctions: [],
    summary: "Checkpoint",
  };
  const first = await rpc("submit", submit);
  await rpc("review", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    submissionId: first.id,
    rating: 5,
    rationale: "Needs correction",
    duplicateSuspicions: [],
    result: { ...clean, findings: [finding] },
  });
  await assert.rejects(rpc("submit", submit), /coordinator resolution/);
  await rpc("resolve", {
    run: run.id,
    submission: first.id,
    decision: "fix",
    rationale: "Address the missing guard",
    evidence: "The contract requires rejecting invalid input",
  });
  await assert.rejects(report(writer), /accepted reviewer rating/);
  const next = await rpc("submit", submit);
  assert.equal(next.round, 2);
  assert.equal(next.review, undefined);
});

test("escalation requires a higher auto level and host-confirmed stop, retaining provenance in a successor", async (t) => {
  const { w, rpc, start, store, preflight, claim, receipt, report } = setup(t);
  write(path.join(w.a, "README.md"), "docs\n");
  const run = await rpc("start", {
    workflow: "writer-reviewer-dry",
    base: "develop",
    level: "auto",
    prompt: "Update docs",
    criteria: [
      {
        id: "behavior",
        text: "Docs correct",
        checks: [planned("behavior-check")],
      },
    ],
  });
  assert.equal(run.quality.level, "light");
  await preflight(run.id);
  const writer = await claim(run.id, "writer");
  await receipt(run.id);
  await assert.rejects(
    rpc("escalate", {
      run: run.id,
      level: "deep",
      rationale: "Discovered broader impact",
      stopped: false,
    }),
  );
  const next = await rpc("escalate", {
    run: run.id,
    level: "deep",
    rationale: "Discovered broader impact",
    stopped: true,
  });
  assert.equal(next.quality.level, "deep");
  assert.equal(next.status, "running");
  assert.equal(next.stages.length, 4);
  assert.equal(next.quality.receipts[0].inheritedFrom, run.id);
  assert.equal(next.quality.receipts[0].source, "parent-reported");
  assert.equal(criterionResults(next)[0].status, "passed");
  assert.equal(
    readRun(store, run.id).run.quality.governance.successor,
    next.id,
  );
  assert.equal(readRun(store, run.id).run.status, "cancelled");
  await assert.rejects(report(writer));
  await assert.rejects(
    rpc("assess", { run: next.id, assessment: effort("light") }),
    /cannot lower/,
  );
  const pinned = await start("standard");
  await assert.rejects(
    rpc("escalate", {
      run: pinned.id,
      level: "deep",
      rationale: "Try changing pinned level",
      stopped: true,
    }),
    /pinned/,
  );
});

test("versioned outcome graders catch misleading success and compare repeated synthetic trials without inventing native results", async (t) => {
  const { w, rpc, start, store } = setup(t),
    task = WORKFLOW_EVAL_SUITE.cases.find(
      (c: { id: string }) => c.id === "misleading-tests",
    );
  write(path.join(w.a, "subject.cjs"), task.fixture["subject.cjs"]);
  const trials: string[] = [];
  for (const trial of ["baseline", "fixed"]) {
    if (trial === "fixed")
      write(
        path.join(w.a, "subject.cjs"),
        "module.exports=value=>/^[+-]?\\d+$/.test(value)?Number(value):null;\n",
      );
    const run = await start("light");
    trials.push(run.id);
    await rpc("criteria", {
      run: run.id,
      criteria: [
        {
          id: "behavior",
          text: "Full integer parsing contract",
          checks: [
            planned("acceptance", task.acceptance),
            planned("regression", task.regression),
          ],
        },
      ],
    });
    const evidence: Record<string, string> = {};
    for (const check of ["acceptance", "regression"] as const) {
      const result = await rpc("check", {
        run: run.id,
        check,
        command: task[check],
        cwd: w.a,
        mode: "static",
      });
      evidence[check] = result.receipt.id;
      assert.equal(
        result.receipt.exitCode,
        check === "regression" && trial === "baseline" ? 1 : 0,
      );
    }
    await rpc("outcome", {
      run: run.id,
      suiteVersion: 1,
      case: task.id,
      trial,
      kind: "synthetic",
      ...evidence,
      observedDefects: 0,
      notes:
        "Synthetic fixture execution tests graders; no native model was run",
    });
    await assert.rejects(
      rpc("outcome", {
        run: run.id,
        suiteVersion: 1,
        case: task.id,
        trial,
        kind: "synthetic",
        ...evidence,
        observedDefects: 0,
        notes: "Duplicate",
      }),
      /immutable outcome/,
    );
  }
  const runs = trials.map((id) => readRun(store, id).run),
    result = evaluateWorkflowRuns(runs);
  assert.equal(result.comparison.length, 1);
  assert.equal(result.comparison[0].kind, "synthetic");
  assert.equal(result.comparison[0].passRate, 0.5);
  assert.deepEqual(
    result.trials.map((r: { status: string }) => r.status),
    ["failed", "passed"],
  );
  assert.throws(
    () => evaluateWorkflowRuns([runs[0], runs[0]]),
    /count a trial twice/,
  );
  const cli = JSON.parse(
    w.rl(["workflow", "eval", "--file", "-", "--json"], {
      cwd: w.a,
      input: JSON.stringify({ runs: trials }),
    }).stdout,
  );
  assert.equal(cli.comparison[0].trials, 2);
  const suite = JSON.parse(
    w.rl(["workflow", "eval", "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(suite.suite.cases.length, 4);
  assert.equal(fs.existsSync(w.log), false);
});

test("every representative task has runnable graders that reject its bug and accept a contract-preserving implementation", (t) => {
  const w = new Workspace(t),
    fixes: Record<string, string> = {
      "small-fix": "module.exports=count=>Math.max(0,Math.trunc(count));",
      "ambiguous-feature":
        "module.exports=items=>[...items].sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);",
      "concurrency-bug":
        "module.exports=load=>{const active=new Map();return key=>{if(!active.has(key)){const pending=Promise.resolve().then(()=>load(key));active.set(key,pending);pending.then(()=>active.delete(key),()=>active.delete(key));}return active.get(key)}};",
      "misleading-tests":
        "module.exports=value=>/^[+-]?\\d+$/.test(value)?Number(value):null;",
    };
  for (const task of WORKFLOW_EVAL_SUITE.cases) {
    write(path.join(w.a, "subject.cjs"), task.fixture["subject.cjs"]);
    const bugCheck =
      task.id === "misleading-tests" ? task.regression : task.acceptance;
    w.command(bugCheck, { cwd: w.a, ok: false });
    write(path.join(w.a, "subject.cjs"), fixes[task.id]);
    w.command(task.acceptance, { cwd: w.a });
    w.command(task.regression, { cwd: w.a });
  }
});

test("per-agent status exposes dependency waits, independent review and current host progress", async (t) => {
  const { w, rpc, start, preflight, claim, store } = setup(t);
  write(path.join(w.a, "code.ts"), "one\n");
  const run = await start();
  assert.deepEqual(
    agentState(
      run,
      run.stages.find((s: { id: string }) => s.id === "writer"),
    ).waitingOn,
    ["research"],
  );
  await preflight(run.id);
  const writer = await claim(run.id, "writer"),
    reviewer = await rpc("claim", { run: run.id, step: "reviewer" });
  await rpc("bind", {
    run: run.id,
    step: "reviewer",
    claim: reviewer.claim,
    childId: randomUUID(),
  });
  let saved = readRun(store, run.id).run;
  assert.equal(
    agentState(
      saved,
      saved.stages.find((s: { id: string }) => s.id === "reviewer"),
    ).state,
    "first pass",
  );
  await rpc("heartbeat", {
    run: run.id,
    step: "writer",
    claim: writer.claim,
    message: "Implementing the boundary contract",
  });
  saved = readRun(store, run.id).run;
  assert.equal(
    agentState(
      saved,
      saved.stages.find((s: { id: string }) => s.id === "writer"),
    ).detail,
    "Implementing the boundary contract",
  );
  const snapshot = JSON.parse(
    w.rl(["workflow", "status", run.id, "--json"], { cwd: w.a }).stdout,
  );
  assert.equal(
    snapshot.qualityStatus.roles.find(
      (r: { id: string }) => r.id === "reviewer",
    ).state,
    "first pass",
  );
  assert.match(
    snapshot.qualityStatus.roles[0].stateSource,
    /liveness is unverified/,
  );
  w.rl(["workflow", "status", "--watch", "--json"], { cwd: w.a, ok: false });
  const output = await w.commandAsync(
    [
      "python3",
      path.join(ROOT, "tests/workflow-status-pty.py"),
      w.a,
      process.execPath,
      CLI,
      run.id,
      path.join(readRun(store, run.id).directory, "run.json"),
    ],
    { timeoutMs: 20000 },
  );
  assert.match(output, /PTY: live agent status.*passed/);
});
