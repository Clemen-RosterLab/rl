import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentAdapter } from "./agent-registry.js";
import {
  captureScope,
  createRunLocked,
  evaluation,
  readRun,
  runMetrics,
  type Stage,
  type Usage,
  type WorkflowRun,
} from "./agent-runner.js";
import type { Agent } from "./agents.js";
import {
  defaultWorkflow,
  hasAutomation,
  readAutomation,
  type AutomationConfig,
  type WorkflowTrigger,
} from "./automation-config.js";
import {
  atomicWrite,
  canonical,
  git,
  inside,
  now,
  object,
  readJson,
  sessionId,
  writeJson,
} from "./common.js";
import type { JsonObject } from "./json.js";
import {
  buildClaimedRolePrompt,
  buildCoordinatorInstructions,
} from "./orchestration/prompts.js";
import { updateWorkflowRunsIndex } from "./orchestration/run-index.js";
import { RESULT_SCHEMA, validateResult } from "./review-policy.js";
import {
  StageCheckOutputSchema,
  StageUsageSchema,
  WorkflowEventsFileSchema,
} from "./schemas/orchestration.js";
import { currentSessionId } from "./session.js";
import type { Instance, Store } from "./store.js";
import {
  assertCollaborationCompletion,
  COLLABORATION_TOOLS,
  collaborationPrompt,
  collaborationTool,
} from "./workflow-collaboration.js";

interface Owner {
  agent: Agent;
  sessionId: string;
}

interface Request extends Owner {
  id: string;
  workflow: string;
  event: string;
  fingerprint: string;
  createdAt: string;
  runId?: string;
  dismissed?: string;
  tool?: string;
  paths?: string[];
}

function eventFile(file: string): string {
  const target = path.join(path.dirname(file), "workflow-events.json");
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Workflow events must not be a symlink");
  }
  return target;
}

function requests(file: string): Request[] {
  const target = eventFile(file);
  if (!fs.existsSync(target)) {
    return [];
  }
  const value = readJson(target);
  const parsed = WorkflowEventsFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid workflow events");
  }
  for (const item of parsed.data.requests) {
    agentAdapter(item.agent).observedId(item.sessionId);
  }
  return parsed.data.requests;
}

function saveRequests(file: string, values: Request[]): void {
  writeJson(eventFile(file), { version: 1, requests: values });
}

function defaultBase(data: Instance): string {
  if (typeof data.baseBranch === "string") {
    try {
      git(
        data.worktree,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${data.baseBranch}^{commit}`,
      );
      return data.baseBranch;
    } catch {
      // No local base ref: observe worktree changes against HEAD.
    }
  }
  return "HEAD";
}

const sameOwner = (a: Owner, b: Owner): boolean =>
  a.agent === b.agent && a.sessionId === b.sessionId;

function owner(input: Record<string, unknown>): Owner {
  const agent = input.agent === undefined ? "codex" : input.agent;
  if (agent !== "codex" && agent !== "claude" && agent !== "agy") {
    throw new Error("agent must be codex, claude or agy");
  }
  const id =
    input.sessionId !== undefined
      ? input.sessionId
      : agent === "codex"
        ? (process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID)
        : undefined;
  return {
    agent,
    sessionId:
      id === undefined
        ? currentSessionId(agent)
        : agentAdapter(agent).observedId(id),
  };
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 64000 ||
    value.includes("\0")
  ) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function associate(store: Store, parent: Owner): void {
  try {
    sessionId(parent.sessionId);
  } catch {
    // Observed Codex thread IDs coordinate workflows but are not verified resume UUIDs.
    return;
  }
  const [file, data] = store.current();
  store.associateSession(file, data, parent.agent, parent.sessionId, now());
  store.save(file, data);
}

function ownedRun(store: Store, id: unknown, parent: Owner) {
  const saved = readRun(store, text(id, "run UUID"));
  if (
    saved.run.execution !== "native" ||
    !saved.run.owner ||
    !sameOwner(saved.run.owner, parent)
  ) {
    throw new Error(
      "Workflow belongs to a different parent session or uses the retired standalone runner",
    );
  }
  return saved;
}

function persist(run: WorkflowRun, directory: string): void {
  run.updatedAt = now();
  writeJson(path.join(directory, "run.json"), run);
}

function assertScope(run: WorkflowRun): void {
  if (
    captureScope(run.workspace, run.scope.base).scope.fingerprint !==
    run.scope.fingerprint
  ) {
    throw new Error(
      "Reviewed scope changed; start a new workflow instead of accepting stale results",
    );
  }
}

export function matchGlob(pattern: string, filePath: string): boolean {
  let regexSource = "^";
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith("/**/", i)) {
      regexSource += "/(?:.+/)?";
      i += 4;
    } else if (pattern.startsWith("**/", i)) {
      regexSource += "(?:.+/)?";
      i += 3;
    } else if (pattern.startsWith("/**", i)) {
      regexSource += "/.*";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      regexSource += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      regexSource += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      regexSource += "[^/]";
      i += 1;
    } else {
      regexSource += pattern[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regexSource += "$";
  return new RegExp(regexSource).test(filePath);
}

function triggerMatchesEvent(
  trigger: WorkflowTrigger,
  event: string,
  tool: string | undefined,
  paths: readonly string[],
): boolean {
  return (
    trigger.event === event &&
    (!trigger.tools || (Boolean(tool) && trigger.tools.includes(tool!))) &&
    (!trigger.paths ||
      paths.some((file) =>
        trigger.paths!.some((pattern) => matchGlob(pattern, file)),
      ))
  );
}

function eventSnapshot(
  data: Instance,
  config: AutomationConfig,
  event: string,
  tool?: string,
  paths: string[] = [],
) {
  const scope = captureScope(data.worktree, defaultBase(data)).scope;
  return {
    scope,
    fingerprint: createHash("sha256")
      .update(scope.fingerprint)
      .update(JSON.stringify(config))
      .update(JSON.stringify({ event, tool, paths }))
      .digest("hex"),
  };
}

function settleRequest(file: string, data: Instance, run: WorkflowRun): void {
  if (!run.requestId || run.status !== "completed") {
    return;
  }
  const config = readAutomation(data.worktree);
  if (!isDeepStrictEqual(config, run.config)) {
    return;
  }
  const values = requests(file);
  const request = values.find(
    (value) => value.id === run.requestId && value.runId === run.id,
  );
  if (!request) {
    return;
  }
  // A writing stage may have advanced the scope. A retry of the original gated
  // action must observe its completed workflow instead of immediately queuing it again.
  request.fingerprint = eventSnapshot(
    data,
    config,
    request.event,
    request.tool,
    request.paths,
  ).fingerprint;
  saveRequests(file, values);
}

/** Called under the instance lock. Events queue instructions; they never launch a process. */
export function observeWorkflowEvent(
  store: Store,
  file: string,
  data: Instance,
  parent: Owner,
  event: string,
  tool?: string,
  paths: string[] = [],
): Request[] {
  const config = readAutomation(data.worktree);
  const matches = Object.entries(config.workflows).filter(([, workflow]) =>
    workflow.triggers?.some((trigger) =>
      triggerMatchesEvent(trigger, event, tool, paths),
    ),
  );
  if (matches.length === 0) {
    return [];
  }

  const { scope, fingerprint } = eventSnapshot(
    data,
    config,
    event,
    tool,
    paths,
  );
  const values = requests(file);
  const result: Request[] = [];

  for (const [workflow, definition] of matches) {
    const triggers = definition.triggers!.filter((trigger) =>
      triggerMatchesEvent(trigger, event, tool, paths),
    );
    if (
      triggers.every((trigger) => trigger.changes && scope.files.length === 0)
    ) {
      continue;
    }

    const prior = values.find(
      (request) =>
        sameOwner(request, parent) &&
        request.workflow === workflow &&
        request.event === event &&
        request.fingerprint === fingerprint,
    );
    if (prior) {
      if (
        ["before_edit", "before_tool"].includes(event) &&
        !prior.dismissed &&
        (!prior.runId ||
          !["completed", "cancelled"].includes(
            readRun(store, prior.runId).run.status,
          ))
      ) {
        result.push(prior);
      }
      continue;
    }

    const pending = values.find(
      (request) =>
        sameOwner(request, parent) &&
        request.workflow === workflow &&
        !request.runId &&
        !request.dismissed,
    );
    if (pending) {
      pending.fingerprint = fingerprint;
      pending.event = event;
      pending.tool = tool;
      pending.paths = paths;
      result.push(pending);
    } else {
      const request: Request = {
        id: randomUUID(),
        ...parent,
        workflow,
        event,
        fingerprint,
        createdAt: now(),
        tool,
        paths,
      };
      values.push(request);
      result.push(request);
    }
  }

  // Retain pending work and recent completed/dismissed requests for deduplication.
  while (values.length > 128) {
    const index = values.findIndex((value) => value.runId || value.dismissed);
    if (index < 0) {
      throw new Error(
        "Too many pending workflows; dismiss or complete requests first",
      );
    }
    values.splice(index, 1);
  }
  if (result.length > 0) {
    saveRequests(file, values);
  }
  return result;
}

export function automationContext(root: string): string {
  const config = readAutomation(root);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");

  return buildCoordinatorInstructions({
    fingerprint,
    configured: hasAutomation(root),
    defaultWorkflow: defaultWorkflow(config),
    agentSummaries: Object.entries(config.agents)
      .map(([name, profile]) => `${name}: ${profile.description}`)
      .join("; "),
    triggersJson: JSON.stringify(
      Object.fromEntries(
        Object.entries(config.workflows).map(([name, workflow]) => [
          name,
          workflow.triggers ?? [],
        ]),
      ),
    ),
  });
}

export const WORKFLOW_TOOLS: {
  name: string;
  description: string;
  properties: JsonObject;
  required: string[];
  readOnly: boolean;
}[] = [
  {
    name: "rl_workflow_context",
    description:
      "Discover RL agent profiles, workflows, triggers and review policies. Use your own native subagents; RL does not spawn processes.",
    properties: {},
    required: [],
    readOnly: true,
  },
  {
    name: "rl_workflow_pending",
    description:
      "Read queued workflow requests for this parent conversation after hooks or milestones.",
    properties: {},
    required: [],
    readOnly: true,
  },
  {
    name: "rl_workflow_event",
    description:
      "Report a semantic milestone, such as task_planned, and queue matching configured workflows. No agents are launched.",
    properties: {
      event: { type: "string" },
      tool: { type: "string" },
      paths: { type: "array", items: { type: "string" } },
    },
    required: ["event"],
    readOnly: false,
  },
  {
    name: "rl_workflow_start",
    description:
      "Prepare a workflow for YOUR native subagents. Returns run state; claim steps next. Never launches provider CLIs.",
    properties: {
      workflow: { type: "string" },
      requestId: { type: "string" },
      base: { type: "string" },
      prompt: { type: "string" },
    },
    required: [],
    readOnly: false,
  },
  {
    name: "rl_workflow_claim",
    description:
      "Atomically claim one ready step. Spawn its role with your native subagent tool using the returned prompt, or run its check yourself. Observe concurrency and dependencies.",
    properties: { run: { type: "string" }, step: { type: "string" } },
    required: ["run"],
    readOnly: false,
  },
  {
    name: "rl_workflow_report",
    description:
      "Report evidence from the native child or a check you ran. Requires the exact claim token. Scores are computed by RL.",
    properties: {
      run: { type: "string" },
      step: { type: "string" },
      claim: { type: "string" },
      childId: { type: "string" },
      result: RESULT_SCHEMA,
      error: { type: "string" },
      check: {
        type: "object",
        properties: {
          stdout: { type: "string" },
          stderr: { type: "string" },
          exitCode: { type: "integer" },
        },
        required: ["stdout", "stderr", "exitCode"],
        additionalProperties: false,
      },
      usage: {
        type: "object",
        properties: {
          inputTokens: { type: ["number", "null"] },
          outputTokens: { type: ["number", "null"] },
          costUsd: { type: ["number", "null"] },
        },
        additionalProperties: false,
      },
    },
    required: ["run", "step", "claim"],
    readOnly: false,
  },
  {
    name: "rl_workflow_dismiss",
    description:
      "Dismiss a queued request with a concrete reason, for example native delegation is unavailable. Does not count as a completed review.",
    properties: { requestId: { type: "string" }, reason: { type: "string" } },
    required: ["requestId", "reason"],
    readOnly: false,
  },
  ...COLLABORATION_TOOLS,
];

export function workflowToolSchema(tool: (typeof WORKFLOW_TOOLS)[number]) {
  return {
    type: "object",
    properties: {
      agent: { type: "string", enum: ["codex", "claude", "agy"] },
      sessionId: {
        type: "string",
        description:
          "Current parent conversation ID. Claude and Antigravity require a UUID; Codex also accepts observed thr_ IDs and may inherit it.",
      },
      ...tool.properties,
    },
    required: tool.required,
    additionalProperties: false,
  };
}

function workflowProtocol() {
  const identity = { agent: "--agent", sessionId: "--session" };
  return {
    version: 1,
    coordinator: "current-session",
    requiresMcp: false,
    requiresRlLauncher: false,
    requiresNativeSubagents: true,
    discovery: "rl workflow context --json",
    instruction:
      "Use your current session's native subagent and messaging tools. RL supplies roles and coordination state. CLI operations below use the same inputSchema as MCP; tools with stdin: json accept the entire input object via --file -. These are coordination commands, never instructions to start a second provider process.",
    tools: WORKFLOW_TOOLS.map((tool) => {
      const action = tool.name.slice("rl_workflow_".length);
      const usesStdin = ![
        "context",
        "pending",
        "start",
        "claim",
        "inbox",
      ].includes(action);
      const flags =
        action === "start"
          ? {
              ...identity,
              base: "--base",
              prompt: "--prompt",
              requestId: "--request",
            }
          : {
              ...identity,
              ...(action === "claim" || action === "inbox"
                ? { step: "--step" }
                : {}),
              ...(action === "inbox" ? { claim: "--claim" } : {}),
            };
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: workflowToolSchema(tool),
        cli: {
          command: [
            "rl",
            "workflow",
            action === "start" ? "run" : action,
            ...(usesStdin ? ["--file", "-"] : []),
            "--json",
          ],
          stdin: usesStdin ? "json" : "none",
          positionals: usesStdin
            ? []
            : action === "start"
              ? ["workflow"]
              : action === "claim" || action === "inbox"
                ? ["run"]
                : [],
          flags: usesStdin ? {} : flags,
          output: "json",
        },
      };
    }),
  };
}

export async function callWorkflowTool(
  store: Store,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const definition = WORKFLOW_TOOLS.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error("Unknown workflow tool");
  }
  const allowed = ["agent", "sessionId", ...Object.keys(definition.properties)];
  if (
    !object(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    definition.required.some((key) => input[key] === undefined)
  ) {
    throw new Error("Invalid workflow tool arguments");
  }

  if (name === "rl_workflow_context") {
    const [, data] = store.current();
    return {
      execution: "native",
      active: true,
      configured: hasAutomation(data.worktree),
      source: hasAutomation(data.worktree) ? "workspace" : "built-in",
      ...readAutomation(data.worktree),
      instructions: automationContext(data.worktree),
      protocol: workflowProtocol(),
    };
  }

  const parent = owner(input);
  return store.locked(() => {
    const [file, data] = store.current();
    store.assertSessionOwner(file, parent.agent, parent.sessionId);

    if (name === "rl_workflow_pending") {
      return requests(file).filter(
        (request) =>
          sameOwner(request, parent) && !request.runId && !request.dismissed,
      );
    }

    if (name === "rl_workflow_event") {
      const event = text(input.event, "event");
      if (input.tool !== undefined) {
        text(input.tool, "tool");
      }
      if (
        input.paths !== undefined &&
        (!Array.isArray(input.paths) ||
          input.paths.some((value) => typeof value !== "string"))
      ) {
        throw new Error("paths must be strings");
      }
      return observeWorkflowEvent(
        store,
        file,
        data,
        parent,
        event,
        input.tool as string | undefined,
        input.paths as string[] | undefined,
      );
    }

    if (name === "rl_workflow_dismiss") {
      const values = requests(file);
      const request = values.find(
        (value) => value.id === input.requestId && sameOwner(value, parent),
      );
      if (!request || request.runId) {
        throw new Error("Pending request not found in this parent session");
      }
      request.dismissed = text(input.reason, "dismissal reason");
      saveRequests(file, values);
      return request;
    }

    if (name === "rl_workflow_start") {
      const values = requests(file);
      const request =
        input.requestId === undefined
          ? undefined
          : values.find(
              (value) =>
                value.id === input.requestId && sameOwner(value, parent),
            );
      if (input.requestId !== undefined && (!request || request.dismissed)) {
        throw new Error("Pending request not found in this parent session");
      }
      if (request?.runId) {
        return ownedRun(store, request.runId, parent).run;
      }

      const config = readAutomation(data.worktree);
      const workflow =
        input.workflow === undefined
          ? (request?.workflow ?? defaultWorkflow(config))
          : text(input.workflow, "workflow");
      if (request && request.workflow !== workflow) {
        throw new Error("Request is for a different workflow");
      }

      const created = createRunLocked(
        store,
        config,
        workflow,
        input.base === undefined ? defaultBase(data) : text(input.base, "base"),
        input.prompt === undefined
          ? request
            ? `Triggered by ${request.event}${request.tool ? ` using ${request.tool}` : ""}. Paths: ${(request.paths ?? []).join(", ") || "not provided"}.`
            : ""
          : text(input.prompt, "prompt"),
      );
      created.run.execution = "native";
      created.run.owner = parent;
      created.run.status = "running";
      if (request) {
        created.run.requestId = request.id;
        request.runId = created.run.id;
        saveRequests(file, values);
      }
      associate(store, parent);
      persist(created.run, created.directory);
      return created.run;
    }

    const { run, directory } = ownedRun(store, input.run, parent);

    if (COLLABORATION_TOOLS.some((tool) => tool.name === name)) {
      const result = collaborationTool(run, directory, name, input);
      if (name !== "rl_workflow_inbox") {
        persist(run, directory);
        if (
          name === "rl_workflow_bind" &&
          typeof input.childId === "string" &&
          typeof input.step === "string"
        ) {
          updateWorkflowRunsIndex(path.dirname(directory), {
            bindPeers: [
              {
                childId: input.childId,
                runId: run.id,
                stageId: input.step,
              },
            ],
          });
        }
      }
      return result;
    }

    if (
      run.status !== "running" &&
      !(run.status === "paused" && name === "rl_workflow_report")
    ) {
      throw new Error(
        `Workflow is ${run.status}; it is not accepting stage updates`,
      );
    }

    const workflow = run.config.workflows[run.workflow];
    const collaboration = workflow.collaboration;

    if (name === "rl_workflow_claim") {
      if (input.step !== undefined) {
        text(input.step, "step");
      }
      if (!collaboration) {
        assertScope(run);
      }
      if (
        run.stages.filter((s) => s.status === "running").length >=
        workflow.concurrency
      ) {
        throw new Error("Workflow concurrency limit reached");
      }

      const stage = run.stages.find(
        (s) =>
          (!input.step || s.id === input.step) &&
          s.status === "pending" &&
          s.after.every(
            (depId) =>
              run.stages.find((step) => step.id === depId)?.status ===
              "completed",
          ),
      );
      if (!stage) {
        throw new Error(
          "No ready stage; dependencies may be unfinished or failed",
        );
      }

      const writes = (step: Stage) =>
        Boolean(step.agent) &&
        run.config.agents[step.agent!].access === "workspace-write";
      const cooperative = (step: Stage) =>
        Boolean(collaboration) &&
        [
          collaboration!.writer,
          collaboration!.reviewer,
          collaboration!.dry,
        ].includes(step.id);

      if (
        run.stages.some(
          (other) =>
            other.status === "running" &&
            (writes(stage) || writes(other)) &&
            !(cooperative(stage) && cooperative(other)),
        )
      ) {
        throw new Error(
          "Writing stages run exclusively; wait for existing native stages to report",
        );
      }

      stage.claim = randomUUID();
      stage.scopeFingerprint = run.scope.fingerprint;
      delete stage.error;
      delete stage.childId;
      stage.startedAt = now();
      stage.attempts++;
      stage.status = "running";
      persist(run, directory);

      const profile = stage.agent ? run.config.agents[stage.agent] : undefined;
      const dependencies = run.stages
        .filter((step) => stage.after.includes(step.id))
        .map((step) => ({
          id: step.id,
          result: step.result,
          check: step.check,
        }));

      return {
        run: run.id,
        step: stage.id,
        claim: stage.claim,
        execution: "native",
        profile,
        command: stage.command,
        scope: run.scope,
        scopeFile: path.join(directory, "scope.json"),
        dependencies,
        resultSchema: profile ? RESULT_SCHEMA : undefined,
        prompt: profile
          ? buildClaimedRolePrompt({
              roleInstructions: profile.instructions,
              policyInstructions:
                run.config.policies[workflow.policy].instructions,
              writable: profile.access === "workspace-write",
              collaborative: Boolean(collaboration),
              collaborationSection: collaborationPrompt(run, stage),
              workspace: run.workspace,
              userPrompt: run.prompt,
              dependenciesJson: JSON.stringify(dependencies),
              routedLeadsJson: stage.leads
                ? JSON.stringify(stage.leads)
                : undefined,
            })
          : undefined,
      };
    }

    const stage = run.stages.find((s) => s.id === input.step);
    if (!stage || stage.status !== "running" || stage.claim !== input.claim) {
      throw new Error(
        "Stage claim does not match; duplicate or stale reports are rejected",
      );
    }

    const writable =
      Boolean(stage.agent) &&
      run.config.agents[stage.agent!].access === "workspace-write";
    if (
      !writable &&
      (!collaboration ||
        run.stages.find((s) => s.id === collaboration.writer)?.status ===
          "completed")
    ) {
      assertScope(run);
    }

    const elapsed = Date.now() - Date.parse(stage.startedAt!);
    if (
      input.error !== undefined &&
      (input.result !== undefined || input.check !== undefined)
    ) {
      throw new Error("Report either a failure or a result, not both");
    }
    if (
      (stage.agent && input.check !== undefined) ||
      (stage.command && input.result !== undefined)
    ) {
      throw new Error("Report the result type for the claimed stage");
    }

    let failure =
      input.error === undefined ? undefined : text(input.error, "error");
    if (elapsed > workflow.timeoutSeconds * 1000) {
      failure =
        "Stage deadline exceeded; the parent must stop its native child";
    }

    const writtenScope = writable
      ? captureScope(run.workspace, run.scope.base)
      : undefined;
    if (!failure && collaboration) {
      assertCollaborationCompletion(run, stage, writtenScope?.scope.files);
    }
    if (input.childId !== undefined) {
      if (collaboration && stage.childId !== input.childId) {
        throw new Error("The report must use the bound native child identity");
      }
      stage.childId = text(input.childId, "native child identifier");
    }

    if (!failure && stage.agent) {
      validateResult(input.result);
      for (const finding of input.result.findings) {
        const absolute = path.join(run.workspace, finding.file);
        if (
          !inside(canonical(absolute), run.workspace) ||
          (!fs.existsSync(absolute) && !run.scope.files.includes(finding.file))
        ) {
          throw new Error("Evidence path is outside the reviewed workspace");
        }
      }
      if (
        input.result.routingLeads.some(
          (lead) =>
            !workflow.steps.some(
              (step) => step.id === lead.owner && step.agent,
            ),
        )
      ) {
        throw new Error("Unknown routing owner");
      }
      stage.result = input.result;

      if (input.usage !== undefined) {
        const normalizedUsage = object(input.usage)
          ? {
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
              ...input.usage,
            }
          : input.usage;
        const parsedUsage = StageUsageSchema.safeParse(normalizedUsage);
        if (!parsedUsage.success) {
          throw new Error("Invalid reported usage");
        }
        stage.usage = parsedUsage.data as Usage;
      }
    } else if (!failure) {
      const parsedCheck = StageCheckOutputSchema.safeParse(input.check);
      if (!parsedCheck.success) {
        throw new Error("Expected actual check stdout, stderr and exitCode");
      }
      stage.check = parsedCheck.data;
      if (parsedCheck.data.exitCode !== 0) {
        failure = `Check exited ${parsedCheck.data.exitCode}`;
      }
    }

    stage.durationMs += Math.max(0, elapsed);
    if (writable) {
      const snapshot = writtenScope!;
      const scopePath = path.join(directory, "scope.json");
      if (
        fs.lstatSync(scopePath, { throwIfNoEntry: false })?.isSymbolicLink()
      ) {
        throw new Error("Workflow scope must not be a symlink");
      }
      atomicWrite(scopePath, snapshot.context);
      run.scope = snapshot.scope;
      stage.scopeFingerprint = run.scope.fingerprint;
    }
    if (collaboration) {
      stage.scopeFingerprint = run.scope.fingerprint;
    }

    delete stage.claim;
    stage.status = failure
      ? stage.agent && stage.attempts <= workflow.retries
        ? "pending"
        : "failed"
      : "completed";
    if (failure) {
      stage.error = failure;
    } else {
      delete stage.error;
    }

    let blocked = true;
    while (blocked) {
      blocked = false;
      for (const step of run.stages) {
        if (
          step.status === "pending" &&
          step.after.some((depId) =>
            ["failed", "blocked"].includes(
              run.stages.find((other) => other.id === depId)?.status ?? "",
            ),
          )
        ) {
          step.status = "blocked";
          step.error = "Dependency failed";
          blocked = true;
        }
      }
    }

    const allTerminal = () =>
      run.stages.every((step) =>
        ["completed", "failed", "blocked"].includes(step.status),
      );

    if (allTerminal() && !run.routed && !collaboration) {
      run.routed = true;
      const leads = run.stages.flatMap(
        (step) => step.result?.routingLeads ?? [],
      );
      for (const id of new Set(leads.map((lead) => lead.owner))) {
        const original = run.stages.find((step) => step.id === id)!;
        if (original.status === "completed") {
          run.stages.push({
            id: `followup-${id}`,
            agent: original.agent,
            after: [id],
            status: "pending",
            attempts: 0,
            durationMs: 0,
            leads: leads.filter((lead) => lead.owner === id),
          });
        }
      }
    }

    if (run.status === "running" && allTerminal()) {
      run.status = "completed";
    }
    run.evaluation = evaluation(run);
    if (run.status === "completed") {
      run.assessments.push({
        at: now(),
        policyName: workflow.policy,
        policy: structuredClone(run.config.policies[workflow.policy]),
        evaluation: structuredClone(run.evaluation),
      });
    }

    persist(run, directory);
    settleRequest(file, data, run);
    return {
      ...run,
      metrics: {
        ...runMetrics(run),
        usageSource: "parent-reported; unreported usage remains unknown",
      },
    };
  });
}

export async function resumeNativeRun(
  store: Store,
  id: string | undefined,
  input: Record<string, unknown>,
): Promise<WorkflowRun> {
  const parent = owner(input);
  return store.locked(() => {
    const { run, directory } = ownedRun(store, id ?? "latest", parent);
    if (run.status === "completed" || run.status === "cancelled") {
      throw new Error(`Workflow is ${run.status}; create a new run`);
    }
    if (!run.config.workflows[run.workflow].collaboration) {
      if (run.stages.some((stage) => stage.status === "running")) {
        throw new Error(
          "Resolve running native children before resuming; RL cannot stop host-owned agents",
        );
      }
      assertScope(run);
    }

    run.status = run.stages.every((stage) =>
      ["completed", "failed", "blocked"].includes(stage.status),
    )
      ? "completed"
      : "running";
    run.controlRequested = null;
    run.evaluation = evaluation(run);
    if (run.status === "completed") {
      const policyName = run.config.workflows[run.workflow].policy;
      run.assessments.push({
        at: now(),
        policyName,
        policy: structuredClone(run.config.policies[policyName]),
        evaluation: structuredClone(run.evaluation),
      });
    }
    persist(run, directory);
    const [file, data] = store.current();
    settleRequest(file, data, run);
    return run;
  });
}
