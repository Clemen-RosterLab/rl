import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { git, gitRaw, now, object, sessionId, writeJson } from "./common.js";
import { readJsonObject } from "./json.js";
import {
  validateAutomation,
  type AutomationConfig,
  type ReviewPolicy,
  type WorkflowStep,
} from "./automation-config.js";
import {
  evaluate,
  validateResult,
  type Evaluation,
  type ReviewResult,
} from "./review-policy.js";
import type { Store } from "./store.js";
import { agentAdapter } from "./agent-registry.js";

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
interface Scope {
  base: string;
  baseCommit: string;
  head: string;
  fingerprint: string;
  files: string[];
}
export interface Stage extends WorkflowStep {
  claim?: string;
  startedAt?: string;
  childId?: string;
  scopeFingerprint?: string;
  status: "pending" | "running" | "completed" | "failed" | "blocked";
  attempts: number;
  durationMs: number;
  error?: string;
  result?: ReviewResult;
  usage?: Usage;
  check?: { stdout: string; stderr: string; exitCode: number };
  leads?: ReviewResult["routingLeads"];
}
export interface WorkflowRun {
  version: 1;
  execution?: "native";
  owner?: { agent: "codex" | "claude"; sessionId: string };
  requestId?: string;
  id: string;
  key: string;
  workspace: string;
  branch: string;
  workflow: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "paused" | "cancelled" | "completed";
  controlRequested: "pause" | "cancel" | null;
  config: AutomationConfig;
  scope: Scope;
  prompt: string;
  stages: Stage[];
  routed: boolean;
  evaluation?: Evaluation;
  assessments: {
    at: string;
    policyName: string;
    policy: ReviewPolicy;
    evaluation: Evaluation;
  }[];
}
export function captureScope(
  cwd: string,
  base: string,
): { scope: Scope; context: string } {
  if (!base || base.startsWith("-") || /[\x00-\x20\x7f]/.test(base))
    throw new Error("Expected a literal base ref");
  const baseCommit = git(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${base}^{commit}`,
  );
  const head = git(cwd, "rev-parse", "HEAD");
  const ancestor = git(cwd, "merge-base", head, baseCommit);
  const patch = gitRaw(
    cwd,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    ancestor,
    "--",
  );
  const stagedPatch = gitRaw(
    cwd,
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    ancestor,
    "--",
  );
  const unstagedPatch = gitRaw(
    cwd,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--",
  );
  const changed = gitRaw(
    cwd,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    ancestor,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  const untracked = gitRaw(
    cwd,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  const stagedFiles = gitRaw(
    cwd,
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    ancestor,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  const unstagedFiles = gitRaw(
    cwd,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    "--",
  )
    .split("\0")
    .filter(Boolean);
  let size =
    Buffer.byteLength(patch) +
    Buffer.byteLength(stagedPatch) +
    Buffer.byteLength(unstagedPatch);
  const additional = untracked.map((file) => {
    const absolute = path.join(cwd, file),
      stat = fs.lstatSync(absolute);
    size += stat.size;
    if (size > 4 * 1024 * 1024)
      throw new Error(
        "Review scope exceeds 4 MiB; narrow the changes before running this workflow",
      );
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Unsupported untracked path: ${file}`);
    return {
      file,
      mode: stat.mode & 0o777,
      kind: stat.isSymbolicLink() ? "symlink" : "file",
      content: stat.isSymbolicLink()
        ? fs.readlinkSync(absolute)
        : fs.readFileSync(absolute).toString("base64"),
    };
  });
  if (size > 4 * 1024 * 1024) throw new Error("Review scope exceeds 4 MiB");
  const context = JSON.stringify({
    head,
    base,
    baseCommit,
    mergeBase: ancestor,
    patch,
    stagedPatch,
    unstagedPatch,
    untracked: additional,
  });
  return {
    scope: {
      base,
      baseCommit,
      head,
      fingerprint: createHash("sha256").update(context).digest("hex"),
      files: [
        ...new Set([
          ...changed,
          ...stagedFiles,
          ...unstagedFiles,
          ...untracked,
        ]),
      ],
    },
    context,
  };
}
function runDirectory(instanceFile: string, id: string): string {
  sessionId(id);
  const parent = path.join(path.dirname(instanceFile), "workflow-runs");
  const directory = path.join(parent, id);
  for (const file of [parent, directory, path.join(directory, "run.json")])
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Workflow state must not be a symlink");
  return directory;
}
function load(directory: string): WorkflowRun {
  const raw = readJsonObject(path.join(directory, "run.json"));
  if (
    raw.version !== 1 ||
    typeof raw.id !== "string" ||
    typeof raw.key !== "string" ||
    typeof raw.workspace !== "string" ||
    typeof raw.branch !== "string" ||
    typeof raw.workflow !== "string" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !["running", "paused", "cancelled", "completed"].includes(
      String(raw.status),
    ) ||
    (raw.controlRequested !== null &&
      raw.controlRequested !== "pause" &&
      raw.controlRequested !== "cancel") ||
    typeof raw.routed !== "boolean" ||
    typeof raw.prompt !== "string" ||
    !object(raw.scope) ||
    typeof raw.scope.fingerprint !== "string" ||
    typeof raw.scope.base !== "string" ||
    typeof raw.scope.head !== "string" ||
    typeof raw.scope.baseCommit !== "string" ||
    !Array.isArray(raw.scope.files) ||
    raw.scope.files.some((file) => typeof file !== "string") ||
    !Array.isArray(raw.stages) ||
    !Array.isArray(raw.assessments)
  )
    throw new Error("Invalid workflow run metadata");
  sessionId(raw.id);
  if (raw.execution !== undefined && raw.execution !== "native")
    throw new Error("Invalid workflow execution mode");
  if (raw.execution === "native") {
    if (
      !object(raw.owner) ||
      !["codex", "claude"].includes(String(raw.owner.agent))
    )
      throw new Error("Invalid workflow parent");
    agentAdapter(raw.owner.agent as "codex" | "claude").observedId(
      raw.owner.sessionId,
    );
    if (raw.requestId !== undefined) sessionId(raw.requestId);
  }
  validateAutomation(raw.config);
  if (!Object.hasOwn(raw.config.workflows, raw.workflow))
    throw new Error("Invalid saved workflow");
  const definition = raw.config.workflows[raw.workflow];
  const seen = new Set<string>();
  for (const stage of raw.stages) {
    if (
      !object(stage) ||
      typeof stage.id !== "string" ||
      !/^(?:followup-)?[a-z][a-z0-9_-]{0,63}$/.test(stage.id) ||
      !["pending", "running", "completed", "failed", "blocked"].includes(
        String(stage.status),
      ) ||
      !Number.isSafeInteger(stage.attempts) ||
      Number(stage.attempts) < 0 ||
      typeof stage.durationMs !== "number" ||
      stage.durationMs < 0 ||
      !Array.isArray(stage.after)
    )
      throw new Error("Invalid workflow stage metadata");
    if (seen.has(stage.id)) throw new Error("Duplicate saved workflow stage");
    seen.add(stage.id);
    const original = definition.steps.find(
      (step) => step.id === stage.id || `followup-${step.id}` === stage.id,
    );
    if (
      !original ||
      JSON.stringify(stage.command) !== JSON.stringify(original.command) ||
      stage.agent !== original.agent ||
      JSON.stringify(stage.after) !==
        JSON.stringify(
          stage.id.startsWith("followup-") ? [original.id] : original.after,
        )
    )
      throw new Error("Saved workflow stage does not match its configuration");
    if (stage.claim !== undefined) sessionId(stage.claim);
    if (
      stage.scopeFingerprint !== undefined &&
      typeof stage.scopeFingerprint !== "string"
    )
      throw new Error("Invalid stage scope fingerprint");
    if (
      stage.startedAt !== undefined &&
      (typeof stage.startedAt !== "string" ||
        !Number.isFinite(Date.parse(stage.startedAt)))
    )
      throw new Error("Invalid stage start time");
    if (
      raw.execution === "native" &&
      stage.status === "running" &&
      (stage.claim === undefined || stage.startedAt === undefined)
    )
      throw new Error("Running native stage is missing its claim");
    if (stage.result !== undefined) validateResult(stage.result);
  }
  if (
    raw.scope.files.length &&
    definition.steps.some((step) => !seen.has(step.id))
  )
    throw new Error("Saved workflow is missing configured steps");
  return raw as unknown as WorkflowRun;
}
export function readRun(
  store: Store,
  requested?: string,
): { run: WorkflowRun; directory: string } {
  const [file, data] = store.current();
  let id = requested;
  if (!id || id === "latest") {
    const parent = path.dirname(
      runDirectory(file, "00000000-0000-0000-0000-000000000000"),
    );
    const entries = fs.existsSync(parent)
      ? fs
          .readdirSync(parent)
          .filter((id) => /^[a-f0-9-]{36}$/.test(id))
          .map((id) => load(runDirectory(file, id)))
      : [];
    id = entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
    if (!id) throw new Error("No workflow runs in this RL workspace");
  }
  const directory = runDirectory(file, id),
    run = load(directory);
  if (
    run.id !== id ||
    run.key !== data.key ||
    run.workspace !== data.worktree ||
    run.branch !== data.branch
  )
    throw new Error("Workflow run belongs to a different RL workspace");
  return { run, directory };
}
export async function controlRun(
  store: Store,
  id: string | undefined,
  action: "pause" | "cancel",
): Promise<WorkflowRun> {
  return store.locked(() => {
    const { run, directory } = readRun(store, id);
    if (run.status === "completed")
      throw new Error("Workflow has already completed");
    run.controlRequested = action;
    if (run.execution === "native" || run.status !== "running")
      run.status = action === "pause" ? "paused" : "cancelled";
    run.updatedAt = now();
    writeJson(path.join(directory, "run.json"), run);
    return run;
  });
}
export function evaluation(
  run: WorkflowRun,
  policy = run.config.policies[run.config.workflows[run.workflow].policy],
): Evaluation {
  const currentScope = (stage: Stage) =>
    stage.scopeFingerprint === undefined ||
    stage.scopeFingerprint === run.scope.fingerprint;
  const reports = run.stages
    .filter(
      (stage): stage is Stage & { result: ReviewResult } =>
        stage.status === "completed" &&
        stage.result !== undefined &&
        currentScope(stage),
    )
    .map((stage) => ({ owner: stage.id, result: stage.result }));
  const limitations = run.stages
    .filter((stage) => stage.status !== "completed")
    .map((stage) => `${stage.id}: ${stage.error ?? stage.status}`);
  if (run.status !== "completed") limitations.push(`Run ${run.status}`);
  for (const stage of run.stages.filter(
    (stage) => stage.status === "completed" && !currentScope(stage),
  )) {
    if (
      stage.agent &&
      run.config.agents[stage.agent].access === "workspace-write"
    )
      continue;
    const refreshed = run.stages.some(
      (other) =>
        other.status === "completed" &&
        currentScope(other) &&
        (stage.agent
          ? other.agent === stage.agent
          : JSON.stringify(other.command) === JSON.stringify(stage.command)),
    );
    if (!refreshed)
      limitations.push(
        `${stage.id}: result predates workspace changes; rerun this role/check after writing`,
      );
  }
  for (const stage of run.stages)
    if (stage.id.startsWith("followup-") && stage.result?.routingLeads.length)
      limitations.push(`${stage.id}: further routing leads require review`);
  for (const { owner, result } of reports)
    for (const requested of result.checkRequests) {
      const check = run.stages.find(
        (step) => step.id === requested && step.command,
      );
      if (!check || check.status !== "completed" || !currentScope(check))
        limitations.push(
          `${owner}: requested check ${requested} was not completed`,
        );
    }
  const result = evaluate(policy, reports, limitations);
  if (!run.scope.files.length) {
    result.score = null;
    result.verdict = "incomplete";
    result.limitations.push("No changes to review");
  }
  return result;
}
export function runMetrics(run: WorkflowRun) {
  const agents = run.stages.filter((stage) => stage.agent && stage.attempts);
  const reported = agents.flatMap((stage) =>
    stage.status === "completed" && stage.usage ? [stage.usage] : [],
  );
  const total = (key: keyof Usage) =>
    reported.length === agents.length &&
    agents.every((stage) => stage.attempts === 1) &&
    reported.length &&
    reported.every((item) => item[key] !== null)
      ? reported.reduce((sum, item) => sum + item[key]!, 0)
      : null;
  return {
    execution: run.execution ?? "legacy",
    usageSource:
      run.execution === "native"
        ? "parent-reported; unreported usage remains unknown"
        : "legacy provider-reported",
    attempts: run.stages.reduce((sum, step) => sum + step.attempts, 0),
    totalStageDurationMs: run.stages.reduce(
      (sum, step) => sum + step.durationMs,
      0,
    ),
    completed: run.stages.filter((step) => step.status === "completed").length,
    failed: run.stages.filter((step) => step.status === "failed").length,
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    costUsd: total("costUsd"),
    usageCoverage: `${reported.length}/${run.stages.filter((step) => step.agent && step.attempts).length} agent stages`,
    stages: run.stages.map(({ id, status, attempts, durationMs, usage }) => ({
      id,
      status,
      attempts,
      durationMs,
      usage: usage ?? null,
    })),
  };
}
export async function rescoreRun(
  store: Store,
  id: string | undefined,
  policy: string,
  config: AutomationConfig,
): Promise<WorkflowRun> {
  if (!Object.hasOwn(config.policies, policy))
    throw new Error(`Unknown policy: ${policy}`);
  return store.locked(() => {
    const { run, directory } = readRun(store, id);
    if (run.status === "running")
      throw new Error("Wait for the run to stop before rescoring");
    run.evaluation = evaluation(run, config.policies[policy]);
    run.assessments.push({
      at: now(),
      policyName: policy,
      policy: structuredClone(config.policies[policy]),
      evaluation: structuredClone(run.evaluation),
    });
    run.updatedAt = now();
    writeJson(path.join(directory, "run.json"), run);
    return run;
  });
}
export function createRunLocked(
  store: Store,
  config: AutomationConfig,
  workflow: string,
  base: string,
  prompt: string,
): { run: WorkflowRun; directory: string } {
  if (!Object.hasOwn(config.workflows, workflow))
    throw new Error(`Unknown workflow: ${workflow}`);
  const [file, data] = store.current();
  const { scope, context } = captureScope(data.worktree, base),
    id = randomUUID();
  const directory = runDirectory(file, id);
  const run: WorkflowRun = {
    version: 1,
    id,
    key: data.key,
    workspace: data.worktree,
    branch: data.branch,
    workflow,
    createdAt: now(),
    updatedAt: now(),
    status: "paused",
    controlRequested: null,
    config: structuredClone(config),
    scope,
    prompt,
    routed: false,
    assessments: [],
    stages: config.workflows[workflow].steps.map((step) => ({
      ...step,
      status: "pending",
      attempts: 0,
      durationMs: 0,
    })),
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "scope.json"), context, {
    mode: 0o600,
  });
  writeJson(path.join(directory, "run.json"), run);
  return { run, directory };
}
export function planRun(
  store: Store,
  config: AutomationConfig,
  workflow: string,
  base: string,
) {
  if (!Object.hasOwn(config.workflows, workflow))
    throw new Error(`Unknown workflow: ${workflow}`);
  const [, data] = store.current();
  return {
    workspace: data.worktree,
    workflow,
    scope: captureScope(data.worktree, base).scope,
    definition: config.workflows[workflow],
    policy: config.workflows[workflow].policy,
  };
}
export interface RunSummary {
  id: string;
  workflow: string;
  status: WorkflowRun["status"];
  completed: number;
  total: number;
  score: number | null;
  verdict: Evaluation["verdict"] | null;
  execution?: "native";
  owner?: WorkflowRun["owner"];
}
export function workflowSummary(store: Store): RunSummary | null {
  const [file] = store.current();
  const parent = path.dirname(
    runDirectory(file, "00000000-0000-0000-0000-000000000000"),
  );
  if (
    !fs.existsSync(parent) ||
    !fs.readdirSync(parent).some((id) => /^[a-f0-9-]{36}$/.test(id))
  )
    return null;
  const { run } = readRun(store);
  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    completed: run.stages.filter((step) => step.status === "completed").length,
    total: run.stages.length,
    score: run.evaluation?.score ?? null,
    verdict: run.evaluation?.verdict ?? null,
    execution: run.execution,
    owner: run.owner,
  };
}
