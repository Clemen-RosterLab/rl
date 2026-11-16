import { z } from "zod";
import { now } from "../common.js";
import { proseSchema, StrictLowerUuidSchema } from "../schemas/common.js";
import { receiptCurrent } from "./evidence.js";
import type { WorkflowRun } from "../agent-runner.js";

const grader = (body: string) => [
  "node",
  "-e",
  `const assert=require('node:assert/strict');const subject=require('./subject.cjs');${body}`,
];
/** Portable, versioned tasks. The host runs native agents; RL never starts a model for an eval. */
export const WORKFLOW_EVAL_SUITE = {
  version: 1,
  instructions:
    "Use an isolated, user-authorized Git workspace for each case/level/trial. Write the fixture, commit the baseline, freeze these exact acceptance/regression commands in the validation plan, and give the native agent the task. Capture both graders through workflow check after implementation. Record workflow outcome with kind=native only for an actual native-agent trial. Synthetic fixture tests measure the harness, not agent quality. Repeat trials; keep model/environment settings comparable. No fixture or command is executed by listing this suite.",
  cases: [
    {
      id: "small-fix",
      task: "Fix count normalization: truncate fractional counts and clamp negatives to zero; zero must remain zero. Preserve the CommonJS function API.",
      fixture: {
        "subject.cjs": "module.exports=count=>Math.max(1,Math.trunc(count));\n",
      },
      acceptance: grader(
        "assert.equal(subject(0),0);assert.equal(subject(3.8),3);",
      ),
      regression: grader(
        "assert.equal(subject(-2),0);assert.equal(subject(7),7);",
      ),
    },
    {
      id: "ambiguous-feature",
      task: "Return tasks by descending priority, preserving ascending sequence for equal priorities without mutating the caller's array. Compare suitable approaches before choosing an implementation when the selected level uses research.",
      fixture: {
        "subject.cjs":
          "module.exports=items=>[...items].sort((a,b)=>b.priority-a.priority||b.sequence-a.sequence);\n",
      },
      acceptance: grader(
        "assert.deepEqual(subject([{id:'a',priority:2,sequence:0},{id:'b',priority:1,sequence:1},{id:'c',priority:2,sequence:2}]).map(x=>x.id),['a','c','b']);",
      ),
      regression: grader(
        "const input=[{priority:1,sequence:0},{priority:3,sequence:1}];const before=JSON.stringify(input);assert.equal(subject(input)[0].priority,3);assert.equal(JSON.stringify(input),before);assert.deepEqual(subject([]),[]);",
      ),
    },
    {
      id: "concurrency-bug",
      task: "make(load) returns an async loader that coalesces overlapping requests for the same key. Different keys remain independent. Successful values are not cached after completion, and rejected requests must allow a retry. Preserve the CommonJS factory API.",
      fixture: { "subject.cjs": "module.exports=load=>key=>load(key);\n" },
      acceptance: grader(
        "(async()=>{let calls=0;const get=subject(async key=>{calls++;await new Promise(r=>setTimeout(r,10));return key});assert.deepEqual(await Promise.all([get('a'),get('a')]),['a','a']);assert.equal(calls,1)})().catch(e=>{console.error(e);process.exitCode=1});",
      ),
      regression: grader(
        "(async()=>{let calls=0;const get=subject(async key=>{calls++;if(calls===1)throw Error('retry');return key});await assert.rejects(get('a'));assert.equal(await get('a'),'a');assert.deepEqual(await Promise.all([get('a'),get('b')]),['a','b']);assert.equal(calls,4)})().catch(e=>{console.error(e);process.exitCode=1});",
      ),
    },
    {
      id: "misleading-tests",
      task: "Parse a complete signed decimal integer string, returning its numeric value, or null for invalid input. Reject trailing characters, fractions, empty strings and whitespace. Preserve the CommonJS function API; existing happy-path tests do not establish the full contract.",
      fixture: { "subject.cjs": "module.exports=value=>parseInt(value,10);\n" },
      acceptance: grader(
        "assert.equal(subject('12'),12);assert.equal(subject('-2'),-2);assert.equal(subject('+3'),3);",
      ),
      regression: grader(
        "for(const value of ['12x','','1.5',' 2','2 '])assert.equal(subject(value),null,value);",
      ),
    },
  ],
};
export const OutcomeSchema = z.strictObject({
  suiteVersion: z.literal(1),
  case: z.enum([
    "small-fix",
    "ambiguous-feature",
    "concurrency-bug",
    "misleading-tests",
  ]),
  trial: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  kind: z.enum(["native", "synthetic"]),
  acceptance: StrictLowerUuidSchema,
  regression: StrictLowerUuidSchema,
  observedDefects: z.number().int().min(0).max(10000),
  notes: proseSchema(8000, "trial limitations and outcome notes"),
  at: z.string(),
  fingerprint: z.string(),
});
export const OutcomeInputSchema = z.strictObject({
  run: z.string(),
  ...OutcomeSchema.omit({ at: true, fingerprint: true }).shape,
});
export const EvalSelectionSchema = z.strictObject({
  runs: z.array(StrictLowerUuidSchema).min(1).max(64),
});

export function recordOutcome(run: WorkflowRun, raw: unknown, current: string) {
  if (!run.quality?.governance)
    throw new Error("Evaluation outcomes require a governed run");
  if (run.quality.outcome)
    throw new Error(
      "This run already has an immutable outcome; use a new run for another trial",
    );
  const { run: _run, ...input } = OutcomeInputSchema.parse(raw);
  if (
    input.kind === "native" &&
    !run.stages.some(
      (stage) =>
        stage.agent &&
        run.config.agents[stage.agent].access === "workspace-write" &&
        stage.status === "completed" &&
        stage.childId,
    )
  )
    throw new Error(
      "Native trials require a completed writer and its host-reported native child identity; use synthetic for harness-only fixtures",
    );
  const task = WORKFLOW_EVAL_SUITE.cases.find((c) => c.id === input.case)!;
  for (const kind of ["acceptance", "regression"] as const) {
    const receipt = run.quality.receipts.find((r) => r.id === input[kind]);
    if (
      !receipt ||
      receipt.source !== "command-captured" ||
      receipt.cwd !== run.workspace ||
      receipt.inheritedFrom ||
      !receiptCurrent(run, receipt, current) ||
      JSON.stringify(receipt.command) !== JSON.stringify(task[kind])
    )
      throw new Error(
        `Trial ${kind} needs current captured evidence from the suite's exact grader command`,
      );
  }
  const saved = { ...input, at: now(), fingerprint: current };
  run.quality.outcome = saved;
  return saved;
}

export function evaluateWorkflowRuns(runs: WorkflowRun[]) {
  const seen = new Set<string>();
  const trials = runs.map((run) => {
    const outcome = run.quality?.outcome;
    if (!outcome)
      return {
        run: run.id,
        level: run.quality?.level ?? "legacy",
        status: "unverified" as const,
        reason:
          "No recorded outcome; a workflow rating is not an outcome evaluation",
      };
    const key = `${outcome.case}:${outcome.trial}:${run.quality!.level}:${outcome.kind}`;
    if (seen.has(key))
      throw new Error(
        "Duplicate case/level/kind/trial identity; do not count a trial twice",
      );
    seen.add(key);
    const acceptance = run.quality!.receipts.find(
        (r) => r.id === outcome.acceptance,
      )!,
      regression = run.quality!.receipts.find(
        (r) => r.id === outcome.regression,
      )!;
    const task = WORKFLOW_EVAL_SUITE.cases.find((c) => c.id === outcome.case)!;
    const verified =
      acceptance &&
      regression &&
      [acceptance, regression].every(
        (r) =>
          r.source === "command-captured" &&
          !r.invalidated &&
          r.cwd === run.workspace &&
          !r.inheritedFrom,
      ) &&
      JSON.stringify(acceptance.command) === JSON.stringify(task.acceptance) &&
      JSON.stringify(regression.command) === JSON.stringify(task.regression);
    const status: "unverified" | "passed" | "failed" = !verified
      ? "unverified"
      : acceptance.exitCode === 0 &&
          regression.exitCode === 0 &&
          outcome.observedDefects === 0
        ? "passed"
        : "failed";
    return {
      run: run.id,
      level: run.quality!.level,
      case: outcome.case,
      trial: outcome.trial,
      kind: outcome.kind,
      status,
      workflowReady: run.evaluation?.verdict === "ready",
      acceptancePassed: verified && acceptance.exitCode === 0,
      regressionPassed: verified && regression.exitCode === 0,
      observedDefects: outcome.observedDefects,
      elapsedMs: Math.max(
        0,
        Date.parse(outcome.at) - Date.parse(run.createdAt),
      ),
      checkMs: run.quality!.receipts.reduce((sum, r) => sum + r.durationMs, 0),
      reviewChurn:
        run.collaboration?.submissions.filter(
          (s) => s.review && !s.review.accepted,
        ).length ?? 0,
      evidenceFingerprint: outcome.fingerprint,
      notes: outcome.notes,
    };
  });
  const groups = new Map<
    string,
    {
      case: string;
      level: string;
      kind: string;
      trials: number;
      passed: number;
      failed: number;
      unverified: number;
      elapsedMs: number;
      reviewChurn: number;
    }
  >();
  for (const trial of trials) {
    if (!("case" in trial) || !trial.case || !trial.kind) continue;
    const key = `${trial.case}:${trial.level}:${trial.kind}`;
    const group = groups.get(key) ?? {
      case: trial.case,
      level: trial.level,
      kind: trial.kind,
      trials: 0,
      passed: 0,
      failed: 0,
      unverified: 0,
      elapsedMs: 0,
      reviewChurn: 0,
    };
    group.trials++;
    group[trial.status]++;
    group.elapsedMs += trial.elapsedMs;
    group.reviewChurn += trial.reviewChurn;
    groups.set(key, group);
  }
  return {
    suiteVersion: 1,
    trials,
    comparison: [...groups.values()].map((group) => ({
      ...group,
      passRate: group.passed / group.trials,
      meanElapsedMs: group.elapsedMs / group.trials,
    })),
    limitations: [
      "Synthetic and native trials are reported separately. No unrun trials are inferred.",
      "Captured commands establish execution, not the completeness of the graders. Trial kind, observed defects and environment comparability are host-reported.",
      "Historical outcomes remain historical; changed source requires new captured graders and a new trial. Token/cost comparisons require actual host usage and are not inferred here.",
    ],
  };
}
