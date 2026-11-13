import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentAdapter } from "./agent-registry.js";
import {
  type AutomationConfig,
  type ReviewPolicy,
  type WorkflowStep,
} from "./automation-config.js";
import { git, gitRaw, now, object, sessionId, writeJson } from "./common.js";
import { isExcludedUntrackedPath } from "./core/protected-paths.js";
import { readJsonObject } from "./json.js";
import {
  pruneTerminalWorkflowRuns,
  readWorkflowRunsIndex,
  updateWorkflowRunsIndex,
} from "./orchestration/run-index.js";
import {
  evaluate,
  type Evaluation,
  type ReviewResult,
} from "./review-policy.js";
import { WorkflowRunDiskSchema } from "./schemas/orchestration.js";
import type { Instance, Store } from "./store.js";
import {
  collaborationAssessment,
  initializeCollaboration,
  type CollaborationState,
} from "./workflow-collaboration.js";

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface Scope {
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
  owner?: { agent: "codex" | "claude" | "agy"; sessionId: string };
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
  collaboration?: CollaborationState;
}

const MAX_SCOPE_BYTES = 4 * 1024 * 1024;

export function captureScope(
  cwd: string,
  base: string,
): { scope: Scope; context: string } {
  if (!base || base.startsWith("-") || /[\x00-\x20\x7f]/.test(base)) {
    throw new Error("Expected a literal base ref");
  }
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
    .filter((file) => Boolean(file) && !isExcludedUntrackedPath(file));
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

  const visibleUntracked: string[] = [];
  const additional = untracked.flatMap((file) => {
    const absolute = path.join(cwd, file);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) {
      return [];
    }
    size += stat.size;
    if (size > MAX_SCOPE_BYTES) {
      throw new Error(
        "Review scope exceeds 4 MiB; narrow the changes before running this workflow",
      );
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`Unsupported untracked path: ${file}`);
    }
    visibleUntracked.push(file);
    return [
      {
        file,
        mode: stat.mode & 0o777,
        kind: stat.isSymbolicLink() ? "symlink" : "file",
        content: stat.isSymbolicLink()
          ? fs.readlinkSync(absolute)
          : fs.readFileSync(absolute).toString("base64"),
      },
    ];
  });

  if (size > MAX_SCOPE_BYTES) {
    throw new Error("Review scope exceeds 4 MiB");
  }

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
          ...visibleUntracked,
        ]),
      ],
    },
    context,
  };
}

function runsParentDirectory(instanceFile: string): string {
  const parent = path.join(path.dirname(instanceFile), "workflow-runs");
  if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Workflow state must not be a symlink");
  }
  return parent;
}

function runDirectory(instanceFile: string, id: string): string {
  sessionId(id);
  const parent = runsParentDirectory(instanceFile);
  const directory = path.join(parent, id);
  for (const file of [directory, path.join(directory, "run.json")]) {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("Workflow state must not be a symlink");
    }
  }
  return directory;
}

function load(directory: string): WorkflowRun {
  const raw = readJsonObject(path.join(directory, "run.json"));
  const parsed = WorkflowRunDiskSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message || "Invalid workflow run metadata");
  }

  const data = parsed.data;
  if (data.execution === "native") {
    if (!data.owner) {
      throw new Error("Invalid workflow parent");
    }
    agentAdapter(data.owner.agent).observedId(data.owner.sessionId);
  }

  if (!Object.hasOwn(data.config.workflows, data.workflow)) {
    throw new Error("Invalid saved workflow");
  }
  const definition = data.config.workflows[data.workflow];
  if (definition.collaboration && !data.collaboration) {
    throw new Error("Invalid collaborative workflow state");
  }

  const seen = new Set<string>();
  for (const stage of data.stages) {
    if (seen.has(stage.id)) {
      throw new Error("Duplicate saved workflow stage");
    }
    seen.add(stage.id);

    const original = definition.steps.find(
      (step) => step.id === stage.id || `followup-${step.id}` === stage.id,
    );
    const expectedAfter = stage.id.startsWith("followup-")
      ? [original?.id]
      : original?.after;
    if (
      !original ||
      !isDeepStrictEqual(stage.command, original.command) ||
      stage.agent !== original.agent ||
      !isDeepStrictEqual(stage.after, expectedAfter)
    ) {
      throw new Error("Saved workflow stage does not match its configuration");
    }
    if (
      data.execution === "native" &&
      stage.status === "running" &&
      (stage.claim === undefined || stage.startedAt === undefined)
    ) {
      throw new Error("Running native stage is missing its claim");
    }
  }

  if (
    data.scope.files.length > 0 &&
    definition.steps.some((step) => !seen.has(step.id))
  ) {
    throw new Error("Saved workflow is missing configured steps");
  }

  return data as unknown as WorkflowRun;
}

export function readRun(
  store: Store,
  requested?: string,
): { run: WorkflowRun; directory: string } {
  const [file, data] = store.current();
  let id = requested;

  if (!id || id === "latest") {
    const parent = runsParentDirectory(file);
    const indexed = readWorkflowRunsIndex(parent)?.latestRunId;
    if (
      indexed &&
      /^[a-f0-9-]{36}$/.test(indexed) &&
      fs.existsSync(path.join(parent, indexed, "run.json"))
    ) {
      id = indexed;
    } else {
      const entries = fs.existsSync(parent)
        ? fs
            .readdirSync(parent)
            .filter((entryId) => /^[a-f0-9-]{36}$/.test(entryId))
            .map((entryId) => load(runDirectory(file, entryId)))
        : [];
      id = entries.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        ?.id;
    }
    if (!id) {
      throw new Error("No workflow runs in this RL workspace");
    }
  }

  const directory = runDirectory(file, id);
  const run = load(directory);
  if (
    run.id !== id ||
    run.key !== data.key ||
    run.workspace !== data.worktree ||
    run.branch !== data.branch
  ) {
    throw new Error("Workflow run belongs to a different RL workspace");
  }
  return { run, directory };
}

/** Resolve only explicit native bindings in this instance, never inferred peers. */
export function boundAntigravityPeer(
  instanceFile: string,
  data: Instance,
  conversation: string,
): { run: WorkflowRun; stage: Stage } | undefined {
  const parent = runsParentDirectory(instanceFile);
  if (!fs.existsSync(parent)) {
    return undefined;
  }

  const verifyRunPeer = (
    directory: string,
  ): { run: WorkflowRun; stage: Stage } | undefined => {
    const candidate = readJsonObject(path.join(directory, "run.json"));
    if (
      !object(candidate.owner) ||
      candidate.owner.agent !== "agy" ||
      candidate.owner.sessionId === conversation ||
      !Array.isArray(candidate.stages) ||
      !candidate.stages.some(
        (stage) => object(stage) && stage.childId === conversation,
      )
    ) {
      return undefined;
    }
    const run = load(directory);
    if (
      run.key !== data.key ||
      run.workspace !== data.worktree ||
      run.branch !== data.branch ||
      run.execution !== "native"
    ) {
      throw new Error(
        "Native peer binding belongs to a different RL workspace",
      );
    }
    const stage = run.stages.find((s) => s.childId === conversation)!;
    return { run, stage };
  };

  const indexed = readWorkflowRunsIndex(parent)?.peerBindings[conversation];
  if (
    indexed &&
    /^[a-f0-9-]{36}$/.test(indexed.runId) &&
    fs.existsSync(path.join(parent, indexed.runId, "run.json"))
  ) {
    const matched = verifyRunPeer(runDirectory(instanceFile, indexed.runId));
    if (matched) {
      return matched;
    }
  }

  for (const id of fs
    .readdirSync(parent)
    .filter((entryId) => /^[a-f0-9-]{36}$/.test(entryId))) {
    const matched = verifyRunPeer(runDirectory(instanceFile, id));
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

export async function controlRun(
  store: Store,
  id: string | undefined,
  action: "pause" | "cancel",
): Promise<WorkflowRun> {
  return store.locked(() => {
    const { run, directory } = readRun(store, id);
    if (run.status === "completed") {
      throw new Error("Workflow has already completed");
    }
    run.controlRequested = action;
    if (run.execution === "native" || run.status !== "running") {
      run.status = action === "pause" ? "paused" : "cancelled";
    }
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

  const collaboration = collaborationAssessment(run);
  reports.push(...collaboration.reports);

  const limitations = run.stages
    .filter((stage) => stage.status !== "completed")
    .map((stage) => `${stage.id}: ${stage.error ?? stage.status}`);
  if (run.status !== "completed") {
    limitations.push(`Run ${run.status}`);
  }
  limitations.push(...collaboration.limitations);

  for (const stage of run.stages.filter(
    (s) => s.status === "completed" && !currentScope(s),
  )) {
    if (
      stage.agent &&
      run.config.agents[stage.agent].access === "workspace-write"
    ) {
      continue;
    }
    const refreshed = run.stages.some(
      (other) =>
        other.status === "completed" &&
        currentScope(other) &&
        (stage.agent
          ? other.agent === stage.agent
          : isDeepStrictEqual(other.command, stage.command)),
    );
    if (!refreshed) {
      limitations.push(
        `${stage.id}: result predates workspace changes; rerun this role/check after writing`,
      );
    }
  }

  for (const stage of run.stages) {
    if (stage.id.startsWith("followup-") && stage.result?.routingLeads.length) {
      limitations.push(`${stage.id}: further routing leads require review`);
    }
  }

  for (const { owner, result } of reports) {
    for (const requested of result.checkRequests) {
      const check = run.stages.find(
        (step) => step.id === requested && step.command,
      );
      if (!check || check.status !== "completed" || !currentScope(check)) {
        limitations.push(
          `${owner}: requested check ${requested} was not completed`,
        );
      }
    }
  }

  const result = evaluate(policy, reports, limitations);
  if (run.scope.files.length === 0) {
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
    reported.length > 0 &&
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
    usageCoverage: `${reported.length}/${agents.length} agent stages`,
    ...(run.collaboration
      ? {
          collaboration: {
            consultations: run.collaboration.consultations.length,
            awaitingAnswers: run.collaboration.consultations.filter(
              (item) => !item.answer,
            ).length,
            submissions: run.collaboration.submissions.length,
            accepted: run.collaboration.submissions.filter(
              (item) => !item.supersededBy && item.review?.accepted,
            ).length,
            latestRating:
              run.collaboration.submissions.findLast((item) => item.review)
                ?.review?.rating ?? null,
          },
        }
      : {}),
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
  if (!Object.hasOwn(config.policies, policy)) {
    throw new Error(`Unknown policy: ${policy}`);
  }
  return store.locked(() => {
    const { run, directory } = readRun(store, id);
    if (run.status === "running") {
      throw new Error("Wait for the run to stop before rescoring");
    }
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
  if (!Object.hasOwn(config.workflows, workflow)) {
    throw new Error(`Unknown workflow: ${workflow}`);
  }
  const [file, data] = store.current();
  const { scope, context } = captureScope(data.worktree, base);
  const id = randomUUID();
  const directory = runDirectory(file, id);
  const created = now();

  const run: WorkflowRun = {
    version: 1,
    id,
    key: data.key,
    workspace: data.worktree,
    branch: data.branch,
    workflow,
    createdAt: created,
    updatedAt: created,
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

  initializeCollaboration(run);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "scope.json"), context, {
    mode: 0o600,
  });
  writeJson(path.join(directory, "run.json"), run);

  const parent = path.dirname(directory);
  updateWorkflowRunsIndex(parent, { latestRunId: id });
  pruneTerminalWorkflowRuns(parent);

  return { run, directory };
}

export function planRun(
  store: Store,
  config: AutomationConfig,
  workflow: string,
  base: string,
) {
  if (!Object.hasOwn(config.workflows, workflow)) {
    throw new Error(`Unknown workflow: ${workflow}`);
  }
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
  const parent = runsParentDirectory(file);
  if (!fs.existsSync(parent)) {
    return null;
  }
  const indexed = readWorkflowRunsIndex(parent)?.latestRunId;
  const hasAnyRun =
    (indexed && fs.existsSync(path.join(parent, indexed, "run.json"))) ||
    fs.readdirSync(parent).some((id) => /^[a-f0-9-]{36}$/.test(id));
  if (!hasAnyRun) {
    return null;
  }

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
