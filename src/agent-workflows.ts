import fs from "node:fs";
import path from "node:path";
import {
  controlRun,
  captureScope,
  planRun,
  readRun,
  rescoreRun,
  runMetrics,
  type WorkflowRun,
} from "./agent-runner.js";
import {
  CONFIG_FILES,
  defaultWorkflow,
  hasAutomation,
  initAutomation,
  readAutomation,
  setAutomation,
} from "./automation-config.js";
import { commandContext, contextOptions } from "./command-context.js";
import { args, arity, execute, json } from "./common.js";
import { commandWords } from "./review-terminal.js";
import { UsageError } from "./errors.js";
import { parseJsonObject } from "./json.js";
import { callWorkflowTool, resumeNativeRun } from "./session-workflows.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import {
  qualitySnapshot,
  WorkflowLevelSchema,
  selectWorkflowLevel,
  leveledConfig,
  initializeQuality,
} from "./orchestration/quality.js";

import {
  EvalSelectionSchema,
  WORKFLOW_EVAL_SUITE,
  evaluateWorkflowRuns,
} from "./orchestration/evaluation.js";
import { watchWorkflowStatus } from "./orchestration/status.js";
import { followWorkflowProgress } from "./orchestration/progress.js";

const visible = (value: unknown): string =>
  sanitizeTerminalText(String(value ?? ""));

function renderRunReport(run: WorkflowRun, asJson: boolean): void {
  const fingerprint = captureScope(run.workspace, run.scope.base).scope
    .fingerprint;
  const metrics = runMetrics(run, fingerprint);
  const quality = qualitySnapshot(run, fingerprint);
  if (asJson) {
    json({ ...run, metrics, qualityStatus: quality });
    return;
  }

  console.log(
    `\n${visible(run.workflow)} · ${run.status}\nRun: ${run.id}\nWorkspace: ${visible(run.workspace)}\nScope: ${visible(run.scope.base)} → ${run.scope.head.slice(0, 12)} · ${run.scope.files.length} changed files\n`,
  );
  for (const stage of run.stages) {
    console.log(
      `  ${stage.id.padEnd(22)} ${stage.status.padEnd(10)} ${stage.attempts} attempt(s) · ${(stage.durationMs / 1000).toFixed(1)}s${stage.error ? ` · ${visible(stage.error)}` : ""}`,
    );
  }
  if (run.quality) {
    console.log(`\nLevel: ${run.quality.level} · ${run.quality.reason}`);
    if (run.quality.research)
      console.log(
        `Research: ${run.quality.research.brief.approaches.length} seeds · recommended ${run.quality.research.brief.recommendation} · selected ${run.quality.research.decision?.approach ?? "awaiting coordinator"}`,
      );
    if (run.quality.capabilities?.degradedReason)
      console.log(
        `Execution: DEGRADED · ${visible(run.quality.capabilities.degradedReason)}`,
      );
    for (const role of quality.roles)
      console.log(
        `  ${role.id}: ${role.stale ? "STALLED" : role.status} · ${role.progress ?? role.error ?? "no progress reported"} · ${(role.elapsedMs / 1000).toFixed(0)}s`,
      );
    for (const criterion of quality.criteria)
      console.log(
        `  [${criterion.status.toUpperCase()}] ${criterion.id}: ${criterion.text}${criterion.stale ? " · source changed" : ""}`,
      );
    for (const blocker of quality.blockers)
      console.log(`  Blocker: ${blocker}`);
    console.log(
      "Evidence provenance distinguishes reported and captured checks; execution mode and host capabilities are host-reported. Mocked checks do not verify live integrations.",
    );
  }
  if (run.collaboration) {
    const rating =
      run.config.policies[run.config.workflows[run.workflow].policy].rating!;
    for (const submission of run.collaboration.submissions.filter(
      (item) => !item.supersededBy,
    )) {
      const reviewLabel = submission.review
        ? `${submission.review.rating}/${rating.max} · ${submission.review.accepted ? "accepted" : "changes required"}`
        : "awaiting reviewer";
      console.log(
        `  Review ${submission.id.slice(0, 8)} · round ${submission.round} · ${reviewLabel}`,
      );
    }
    const unanswered = run.collaboration.consultations.filter(
      (item) => !item.answer,
    ).length;
    console.log(`  DRY: ${unanswered} unanswered consultation(s)`);
  }
  if (run.evaluation) {
    const result = run.evaluation;
    const scoreLabel =
      result.score === null ? "Not scored" : `Score: ${result.score}/100`;
    const provisional =
      result.verdict === "incomplete" && result.score !== null
        ? " (provisional)"
        : "";
    console.log(`\n${scoreLabel} · ${result.verdict}${provisional}`);
    for (const finding of result.findings) {
      console.log(
        `\n  ${finding.severity.toUpperCase()} · ${finding.required ? "required fix" : "quick win"} · ${visible(finding.title)}\n  ${visible(finding.file)}:${finding.line} · ${finding.owners.join(", ")}\n  ${visible(finding.evidence)}\n  Fix: ${visible(finding.recommendation)}`,
      );
    }
    for (const limitation of result.limitations) {
      console.log(`  Limitation: ${visible(limitation)}`);
    }
  }
  console.log(
    `\nMetrics: ${metrics.attempts} attempts · ${(metrics.totalStageDurationMs / 1000).toFixed(1)}s total stage time · usage ${metrics.usageCoverage}`,
  );
}

const DIRECT_WORKFLOW_ACTIONS = new Set([
  "context",
  "pending",
  "event",
  "claim",
  "report",
  "dismiss",
  "bind",
  "inbox",
  "consult",
  "answer",
  "submit",
  "review",
  "preflight",
  "criteria",
  "validation",
  "heartbeat",
  "recover",
  "research",
  "decide",
  "assess",
  "budget",
  "orient",
  "resolve",
  "escalate",
  "check",
  "outcome",
]);

const STDIN_REQUIRED_ACTIONS = new Set([
  "report",
  "dismiss",
  "event",
  "bind",
  "consult",
  "answer",
  "submit",
  "review",
  "preflight",
  "criteria",
  "validation",
  "heartbeat",
  "recover",
  "research",
  "decide",
  "assess",
  "budget",
  "orient",
  "resolve",
  "escalate",
  "check",
  "outcome",
]);

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [
      ...contextOptions,
      "base",
      "prompt",
      "provider",
      "policy",
      "file",
      "instructions",
      "description",
      "model",
      "reasoning",
      "agent",
      "session",
      "step",
      "request",
      "claim",
      "level",
    ],
    ["json", "dry-run", "default", "watch", "follow", "paths"],
  );

  const context = commandContext(values);
  const [namespace, action, ...rest] = positionals;
  arity(rest, 0, 1);
  const [, data] = context.store.current();
  const asJson = Boolean(values.json);
  if (values.paths && !(namespace === "workflow" && action === "configure"))
    throw new UsageError("--paths requires rl workflow configure");
  if (
    values.follow &&
    (namespace !== "workflow" || action !== "status" || asJson || values.watch)
  )
    throw new UsageError(
      "--follow requires rl workflow status without --json or --watch",
    );
  if (
    values.watch &&
    (namespace !== "workflow" || action !== "status" || asJson)
  )
    throw new UsageError("--watch requires rl workflow status without --json");

  if (values.file && values.instructions) {
    throw new UsageError("Choose --file or --instructions, not both");
  }
  if (
    values.default &&
    !(namespace === "workflow" && ["add", "set"].includes(action))
  ) {
    throw new UsageError("--default requires workflow add/set");
  }
  if (
    (values.description || values.model || values.reasoning) &&
    !(
      namespace === "agent" &&
      ["add", "set"].includes(action) &&
      values.instructions
    )
  ) {
    throw new UsageError(
      "--description, --model and --reasoning require agent add/set --instructions",
    );
  }
  if (values.provider && !(namespace === "workflow" && action === "init")) {
    throw new UsageError("--provider is only supported by workflow init");
  }
  if (
    values.request &&
    !(namespace === "workflow" && action === "run" && !values["dry-run"])
  ) {
    throw new UsageError(
      "--request is only supported by workflow run without --dry-run",
    );
  }
  if (
    (values.base || values.prompt || values["dry-run"] || values.level) &&
    !(namespace === "workflow" && action === "run")
  ) {
    throw new UsageError(
      "--base, --prompt, --level and --dry-run are only supported by workflow run",
    );
  }
  if (values.policy && !(namespace === "workflow" && action === "score")) {
    throw new UsageError("--policy is only supported by workflow score");
  }

  if (namespace === "workflow" && ["init", "configure"].includes(action)) {
    arity(rest, 0);
    const provider = values.provider ?? "inherit";
    if (
      provider !== "inherit" &&
      provider !== "codex" &&
      provider !== "claude" &&
      provider !== "agy" &&
      provider !== "opencode"
    ) {
      throw new UsageError(
        "Provider must be inherit, codex, claude, agy or opencode",
      );
    }
    await context.store.locked(() => {
      if (action === "init" || !hasAutomation(data.worktree))
        initAutomation(data.worktree, provider);
    });
    if (action === "init") await context.store.adopt(data.worktree);
    const paths = Object.values(CONFIG_FILES)
      .map((file) => path.join(data.worktree, file))
      .filter((file) => fs.existsSync(file));
    if (asJson) {
      json({ files: paths });
    } else {
      console.log(
        `Workspace configuration:\n${paths.map((file) => `  ${visible(file)}`).join("\n")}`,
      );
      if (paths.length < Object.keys(CONFIG_FILES).length)
        console.log(
          "Only existing files are opened; missing files keep their inherited defaults.",
        );
    }
    if (
      action === "configure" &&
      !asJson &&
      !values.paths &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const editor = commandWords(
        process.env.VISUAL ?? process.env.EDITOR ?? "vi",
      );
      const result = await execute([...editor, ...paths], data.worktree, {
        interactive: true,
      });
      if (result.code !== 0)
        throw new Error(
          `Editor exited with code ${result.code}; your configuration files are retained.`,
        );
      readAutomation(data.worktree);
      console.log(
        "Workflow settings validated. Future runs will use these settings.",
      );
    }
    return 0;
  }

  const loadInput = () => {
    if (typeof values.file !== "string") {
      throw new UsageError("Missing --file <json|->");
    }
    return parseJsonObject(
      fs.readFileSync(values.file === "-" ? 0 : values.file, "utf8"),
    );
  };

  if (
    (namespace === "agent" || namespace === "workflow") &&
    ["add", "set"].includes(action)
  ) {
    arity(rest, 1);
    const instructions =
      namespace === "agent" && values.instructions !== undefined
        ? fs.readFileSync(
            values.instructions === "-" ? 0 : String(values.instructions),
            "utf8",
          )
        : undefined;
    const input = instructions === undefined ? loadInput() : undefined;

    const savedProfile = await context.store.locked(() => {
      const previous =
        namespace === "agent" && action === "set"
          ? readAutomation(data.worktree).agents[rest[0]]
          : undefined;
      const profile =
        instructions === undefined
          ? input
          : {
              provider: "inherit",
              ...previous,
              description: String(
                values.description ?? previous?.description ?? rest[0],
              ),
              instructions,
              ...(values.model ? { model: values.model } : {}),
              ...(values.reasoning ? { reasoning: values.reasoning } : {}),
            };
      setAutomation(
        data.worktree,
        namespace === "agent" ? "agents" : "workflows",
        rest[0],
        profile,
        action === "add",
        Boolean(values.default),
      );
      return profile;
    });

    await context.store.adopt(data.worktree);
    if (asJson) {
      json(savedProfile);
    } else {
      console.log(`${namespace} ${action}: ${visible(rest[0])}`);
    }
    return 0;
  }

  if (namespace === "workflow" && action === "eval") {
    arity(rest, 0);
    const report = values.file
      ? evaluateWorkflowRuns(
          EvalSelectionSchema.parse(loadInput()).runs.map(
            (id) => readRun(context.store, id).run,
          ),
        )
      : { suite: WORKFLOW_EVAL_SUITE };
    json(report);
    return 0;
  }

  const parent = {
    ...(values.agent ? { agent: values.agent } : {}),
    ...(values.session ? { sessionId: values.session } : {}),
  };

  if (namespace === "workflow" && DIRECT_WORKFLOW_ACTIONS.has(action)) {
    const input =
      STDIN_REQUIRED_ACTIONS.has(action) || values.file ? loadInput() : {};
    const result = await callWorkflowTool(
      context.store,
      `rl_workflow_${action}`,
      {
        ...input,
        ...parent,
        ...(rest[0] ? { run: rest[0] } : {}),
        ...(values.step ? { step: values.step } : {}),
        ...(values.claim ? { claim: values.claim } : {}),
      },
    );
    if (asJson || action !== "context") {
      json(result);
    } else {
      console.log((result as { instructions: string }).instructions);
    }
    return 0;
  }

  if (
    (namespace === "agent" ||
      namespace === "policy" ||
      namespace === "workflow") &&
    ["list", "show"].includes(action)
  ) {
    const config = readAutomation(data.worktree);
    const entries =
      namespace === "agent"
        ? config.agents
        : namespace === "policy"
          ? config.policies
          : config.workflows;

    if (action === "list") {
      arity(rest, 0);
      if (asJson) {
        json(entries);
      } else {
        for (const [entryName, entryValue] of Object.entries(entries)) {
          const summary =
            "description" in entryValue
              ? visible(entryValue.description)
              : "Review scoring and readiness policy";
          console.log(`${entryName.padEnd(22)} ${summary}`);
        }
      }
    } else {
      arity(rest, namespace === "workflow" ? 0 : 1, 1);
      const name = rest[0] ?? defaultWorkflow(config);
      if (!Object.hasOwn(entries, name)) {
        throw new Error(`Unknown ${namespace}: ${name}`);
      }
      const item = entries[name];
      if (asJson) {
        json(item);
      } else if (namespace === "workflow") {
        const workflow = config.workflows[name];
        console.log(
          `${visible(name)}${name === defaultWorkflow(config) ? " (default)" : ""}\n${visible(workflow.description)}\n`,
        );
        for (const step of workflow.steps) {
          console.log(
            `  ${visible(step.id)} · ${visible(step.agent ?? step.command?.join(" "))} · ${step.after.length ? `after ${step.after.map(visible).join(", ")}` : "ready at start"}`,
          );
        }
        console.log(
          `\nPolicy: ${visible(workflow.policy)} · Parallel steps: ${workflow.concurrency} · Retries: ${workflow.retries} · Timeout: ${workflow.timeoutSeconds}s`,
        );
        if (workflow.triggers?.length)
          console.log(
            `Triggers: ${workflow.triggers.map((trigger) => visible(trigger.event)).join(", ")}`,
          );
        console.log(
          "\nConfigured steps shown; execution depth can add research and review roles.\nEdit: rl workflow configure · Live progress: rl workflow status --follow",
        );
      } else {
        console.log(`${visible(name)}\n`);
        for (const [key, fieldValue] of Object.entries(item)) {
          const rendered =
            typeof fieldValue === "object"
              ? JSON.stringify(fieldValue)
              : fieldValue;
          console.log(`${key}: ${visible(rendered)}`);
        }
      }
    }
    return 0;
  }

  if (namespace !== "workflow") {
    throw new UsageError("Usage: rl agent|policy list|show <name>");
  }

  const name = rest[0];
  if (action === "run") {
    const config = readAutomation(data.worktree);
    const workflow = name ?? defaultWorkflow(config);
    const base = String(values.base ?? context.defaultBase);
    const plan = values.file ? loadInput() : {};
    const acceptanceCriteria = plan.criteria;
    if (Object.keys(plan).some((key) => key !== "level" && key !== "criteria"))
      throw new UsageError("Workflow plan accepts only level and criteria");
    const requestedLevel =
      values.level ??
      plan.level ??
      (plan.criteria !== undefined
        ? "auto"
        : name || values.request || workflow !== "writer-reviewer-dry"
          ? undefined
          : "auto");
    if (requestedLevel !== undefined) WorkflowLevelSchema.parse(requestedLevel);

    if (values["dry-run"]) {
      const initial = planRun(context.store, config, workflow, base);
      const selection =
        requestedLevel === undefined
          ? undefined
          : selectWorkflowLevel(
              WorkflowLevelSchema.parse(requestedLevel),
              initial.scope.files,
              String(values.prompt ?? ""),
            );
      const plan = selection
        ? {
            ...initial,
            definition: leveledConfig(config, workflow, selection.level)
              .workflows[workflow],
            level: selection.level,
            reason: selection.reason,
          }
        : initial;
      if (selection)
        initializeQuality(
          selection.level,
          selection.reason,
          acceptanceCriteria,
        );
      if (asJson) {
        json(plan);
      } else {
        console.log(
          `Preview: ${workflow}\nWorkspace: ${visible(plan.workspace)}\nScope: ${visible(base)} · ${plan.scope.files.length} changed files\nPolicy: ${plan.policy}`,
        );
        for (const step of plan.definition.steps) {
          const executor = step.agent
            ? `${step.agent} (${config.agents[step.agent].provider ?? "inherit"})`
            : JSON.stringify(step.command);
          console.log(
            `  ${step.id}: ${executor} · after ${step.after.join(", ") || "start"}`,
          );
        }
      }
      return 0;
    }

    const run = (await callWorkflowTool(context.store, "rl_workflow_start", {
      ...parent,
      ...(name || !values.request ? { workflow } : {}),
      ...(values.base || !values.request ? { base } : {}),
      ...(values.request ? { requestId: values.request } : {}),
      ...(values.prompt ? { prompt: values.prompt } : {}),
      ...(requestedLevel !== undefined ? { level: requestedLevel } : {}),
      ...(plan.criteria !== undefined ? { criteria: plan.criteria } : {}),
    })) as WorkflowRun;

    renderRunReport(run, asJson);
    if (!asJson) {
      console.log(
        "Prepared for this session's native subagents. Claim ready steps with rl_workflow_claim or rl workflow claim; RL has not started any agent processes.",
      );
      console.log(
        `Follow progress in another terminal: rl workflow status ${run.id} --follow`,
      );
    }
    return 0;
  }

  if (action === "resume") {
    const run = await resumeNativeRun(context.store, name, parent);
    renderRunReport(run, asJson);
    return 0;
  }

  if (action === "pause" || action === "cancel") {
    const run = await controlRun(context.store, name, action);
    if (asJson) {
      json({ id: run.id, status: run.status, requested: action });
    } else {
      console.log(`${action} requested for ${run.id}`);
    }
    return 0;
  }

  if (action === "status") {
    if (values.follow) {
      const selected = readRun(context.store, name).run.id;
      await followWorkflowProgress(() => readRun(context.store, selected).run);
      return 0;
    }
    if (values.watch) {
      const selected = readRun(context.store, name).run.id;
      await watchWorkflowStatus(() => readRun(context.store, selected).run);
      return 0;
    }
    renderRunReport(readRun(context.store, name).run, asJson);
    return 0;
  }

  if (action === "metrics") {
    const { run } = readRun(context.store, name);
    const metrics = runMetrics(
      run,
      captureScope(run.workspace, run.scope.base).scope.fingerprint,
    );
    if (asJson) {
      json(metrics);
    } else {
      console.log(`Metrics: ${run.id}`);
      for (const [key, fieldValue] of Object.entries(metrics)) {
        if (key === "collaboration" && metrics.collaboration) {
          const team = metrics.collaboration;
          console.log(
            `Reviews: ${team.accepted} accepted · ${team.submissions} submissions · latest rating ${team.latestRating ?? "not reported"}`,
          );
          console.log(
            `Consultations: ${team.consultations} total · ${team.awaitingAnswers} awaiting answers`,
          );
        } else if (key !== "stages") {
          console.log(`${key}: ${fieldValue ?? "not reported"}`);
        }
      }
    }
    return 0;
  }

  if (action === "score") {
    const { run: saved } = readRun(context.store, name);
    const policy = String(
      values.policy ?? saved.config.workflows[saved.workflow].policy,
    );
    const run = await rescoreRun(
      context.store,
      saved.id,
      policy,
      readAutomation(data.worktree),
    );
    renderRunReport(run, asJson);
    return run.evaluation?.verdict === "ready" ? 0 : 1;
  }

  throw new UsageError(
    "Usage: rl workflow init|list|show|run|status|metrics|pause|cancel|resume|score",
  );
}
