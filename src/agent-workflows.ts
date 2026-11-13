import fs from "node:fs";
import path from "node:path";
import {
  controlRun,
  planRun,
  readRun,
  rescoreRun,
  runMetrics,
  type WorkflowRun,
} from "./agent-runner.js";
import {
  CONFIG_FILES,
  defaultWorkflow,
  initAutomation,
  readAutomation,
  setAutomation,
} from "./automation-config.js";
import { commandContext, contextOptions } from "./command-context.js";
import { args, arity, json } from "./common.js";
import { UsageError } from "./errors.js";
import { parseJsonObject } from "./json.js";
import { callWorkflowTool, resumeNativeRun } from "./session-workflows.js";
import { sanitizeTerminalText } from "./tui/ansi.js";

const visible = (value: unknown): string =>
  sanitizeTerminalText(String(value ?? ""));

function renderRunReport(run: WorkflowRun, asJson: boolean): void {
  const metrics = runMetrics(run);
  if (asJson) {
    json({ ...run, metrics });
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
    ],
    ["json", "dry-run", "default"],
  );

  const context = commandContext(values);
  const [namespace, action, ...rest] = positionals;
  arity(rest, 0, 1);
  const [, data] = context.store.current();
  const asJson = Boolean(values.json);

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
    (values.base || values.prompt || values["dry-run"]) &&
    !(namespace === "workflow" && action === "run")
  ) {
    throw new UsageError(
      "--base, --prompt and --dry-run are only supported by workflow run",
    );
  }
  if (values.policy && !(namespace === "workflow" && action === "score")) {
    throw new UsageError("--policy is only supported by workflow score");
  }

  if (namespace === "workflow" && action === "init") {
    arity(rest, 0);
    const provider = values.provider ?? "inherit";
    if (
      provider !== "inherit" &&
      provider !== "codex" &&
      provider !== "claude" &&
      provider !== "agy"
    ) {
      throw new UsageError("Provider must be inherit, codex, claude or agy");
    }
    await context.store.locked(() => initAutomation(data.worktree, provider));
    await context.store.adopt(data.worktree);
    const paths = Object.values(CONFIG_FILES).map((file) =>
      path.join(data.worktree, file),
    );
    if (asJson) {
      json({ files: paths });
    } else {
      console.log(
        `Created separate agent, policy and workflow configurations:\n${paths.map((file) => `  ${visible(file)}`).join("\n")}`,
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
      arity(rest, 1);
      if (!Object.hasOwn(entries, rest[0])) {
        throw new Error(`Unknown ${namespace}: ${rest[0]}`);
      }
      const item = entries[rest[0]];
      if (asJson) {
        json(item);
      } else {
        console.log(`${rest[0]}\n`);
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

    if (values["dry-run"]) {
      const plan = planRun(context.store, config, workflow, base);
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
    })) as WorkflowRun;

    renderRunReport(run, asJson);
    if (!asJson) {
      console.log(
        "Prepared for this session's native subagents. Claim ready steps with rl_workflow_claim or rl workflow claim; RL has not started any agent processes.",
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
    renderRunReport(readRun(context.store, name).run, asJson);
    return 0;
  }

  if (action === "metrics") {
    const { run } = readRun(context.store, name);
    const metrics = runMetrics(run);
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
