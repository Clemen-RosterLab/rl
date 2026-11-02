import path from "node:path";
import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { args, arity, json } from "./common.js";
import { commandContext, contextOptions } from "./command-context.js";
import {
  CONFIG_FILES,
  initAutomation,
  readAutomation,
  setAutomation,
} from "./automation-config.js";
import {
  controlRun,
  planRun,
  readRun,
  rescoreRun,
  runMetrics,
  type WorkflowRun,
} from "./agent-runner.js";
import { callWorkflowTool, resumeNativeRun } from "./session-workflows.js";
import { parseJsonObject } from "./json.js";

const visible = (value: unknown) =>
  stripVTControlCharacters(String(value ?? "")).replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    " ",
  );
function report(run: WorkflowRun, asJson: boolean) {
  const metrics = runMetrics(run);
  if (asJson) {
    json({ ...run, metrics });
    return;
  }
  console.log(
    `\n${visible(run.workflow)} · ${run.status}\nRun: ${run.id}\nWorkspace: ${visible(run.workspace)}\nScope: ${visible(run.scope.base)} → ${run.scope.head.slice(0, 12)} · ${run.scope.files.length} changed files\n`,
  );
  for (const stage of run.stages)
    console.log(
      `  ${stage.id.padEnd(22)} ${stage.status.padEnd(10)} ${stage.attempts} attempt(s) · ${(stage.durationMs / 1000).toFixed(1)}s${stage.error ? ` · ${visible(stage.error)}` : ""}`,
    );
  if (run.evaluation) {
    const result = run.evaluation;
    console.log(
      `\n${result.score === null ? "Not scored" : `Score: ${result.score}/100`} · ${result.verdict}${result.verdict === "incomplete" && result.score !== null ? " (provisional)" : ""}`,
    );
    for (const finding of result.findings) {
      console.log(
        `\n  ${finding.severity.toUpperCase()} · ${finding.required ? "required fix" : "quick win"} · ${visible(finding.title)}\n  ${visible(finding.file)}:${finding.line} · ${finding.owners.join(", ")}\n  ${visible(finding.evidence)}\n  Fix: ${visible(finding.recommendation)}`,
      );
    }
    for (const limitation of result.limitations)
      console.log(`  Limitation: ${visible(limitation)}`);
  }
  console.log(
    `\nMetrics: ${metrics.attempts} attempts · ${(metrics.totalStageDurationMs / 1000).toFixed(1)}s total stage time · usage ${metrics.usageCoverage}`,
  );
}
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
    ],
    ["json", "dry-run"],
  );
  const context = commandContext(values);
  const [namespace, action, ...rest] = positionals;
  arity(rest, 0, 1);
  const [, data] = context.store.current();
  const asJson = !!values.json;
  if (values.file && values.instructions)
    throw new Error("Choose --file or --instructions, not both");
  if (
    (values.description || values.model || values.reasoning) &&
    !(
      namespace === "agent" &&
      ["add", "set"].includes(action) &&
      values.instructions
    )
  )
    throw new Error(
      "--description, --model and --reasoning require agent add/set --instructions",
    );
  if (values.provider && !(namespace === "workflow" && action === "init"))
    throw new Error("--provider is only supported by workflow init");
  if (
    values.request &&
    !(namespace === "workflow" && action === "run" && !values["dry-run"])
  )
    throw new Error(
      "--request is only supported by workflow run without --dry-run",
    );
  if (
    (values.base || values.prompt || values["dry-run"]) &&
    !(namespace === "workflow" && action === "run")
  )
    throw new Error(
      "--base, --prompt and --dry-run are only supported by workflow run",
    );
  if (values.policy && !(namespace === "workflow" && action === "score"))
    throw new Error("--policy is only supported by workflow score");
  if (namespace === "workflow" && action === "init") {
    arity(rest, 0);
    const provider = values.provider ?? "inherit";
    if (provider !== "inherit" && provider !== "codex" && provider !== "claude")
      throw new Error("Provider must be inherit, codex or claude");
    await context.store.locked(() => initAutomation(data.worktree, provider));
    await context.store.adopt(data.worktree);
    const paths = Object.values(CONFIG_FILES).map((file) =>
      path.join(data.worktree, file),
    );
    if (asJson) json({ files: paths });
    else
      console.log(
        `Created separate agent, policy and workflow configurations:\n${paths.map((file) => "  " + visible(file)).join("\n")}`,
      );
    return 0;
  }
  const loadInput = () => {
    if (typeof values.file !== "string")
      throw new Error("Missing --file <json|->");
    return parseJsonObject(
      fs.readFileSync(values.file === "-" ? 0 : values.file, "utf8"),
    );
  };
  if (
    (namespace === "agent" || namespace === "workflow") &&
    ["add", "set"].includes(action)
  ) {
    arity(rest, 1);
    const value =
      namespace === "agent" && values.instructions !== undefined
        ? {
            provider: "inherit",
            description: String(values.description ?? rest[0]),
            instructions: fs.readFileSync(
              values.instructions === "-" ? 0 : String(values.instructions),
              "utf8",
            ),
            ...(values.model ? { model: values.model } : {}),
            ...(values.reasoning ? { reasoning: values.reasoning } : {}),
          }
        : loadInput();
    await context.store.locked(() =>
      setAutomation(
        data.worktree,
        namespace === "agent" ? "agents" : "workflows",
        rest[0],
        value,
        action === "add",
      ),
    );
    await context.store.adopt(data.worktree);
    if (asJson) json(value);
    else console.log(`${namespace} ${action}: ${visible(rest[0])}`);
    return 0;
  }
  const parent = {
    ...(values.agent ? { agent: values.agent } : {}),
    ...(values.session ? { sessionId: values.session } : {}),
  };
  if (
    namespace === "workflow" &&
    ["context", "pending", "event", "claim", "report", "dismiss"].includes(
      action,
    )
  ) {
    const input =
      action === "report" || action === "dismiss" || action === "event"
        ? loadInput()
        : {};
    const result = await callWorkflowTool(
      context.store,
      `rl_workflow_${action}`,
      {
        ...input,
        ...parent,
        ...(rest[0] ? { run: rest[0] } : {}),
        ...(values.step ? { step: values.step } : {}),
      },
    );
    if (asJson || action !== "context") json(result);
    else console.log((result as { instructions: string }).instructions);
    return 0;
  }
  const configuration = () => readAutomation(data.worktree);
  if (
    (namespace === "agent" ||
      namespace === "policy" ||
      namespace === "workflow") &&
    ["list", "show"].includes(action)
  ) {
    const config = configuration();
    const entries =
      namespace === "agent"
        ? config.agents
        : namespace === "policy"
          ? config.policies
          : config.workflows;
    if (action === "list") {
      arity(rest, 0);
      if (asJson) json(entries);
      else
        for (const [name, value] of Object.entries(entries))
          console.log(
            `${name.padEnd(22)} ${"description" in value ? visible(value.description) : "Review scoring and readiness policy"}`,
          );
    } else {
      arity(rest, 1);
      if (!Object.hasOwn(entries, rest[0]))
        throw new Error(`Unknown ${namespace}: ${rest[0]}`);
      const item = entries[rest[0]];
      if (asJson) json(item);
      else {
        console.log(`${rest[0]}\n`);
        for (const [key, value] of Object.entries(item))
          console.log(
            `${key}: ${visible(typeof value === "object" ? JSON.stringify(value) : value)}`,
          );
      }
    }
    return 0;
  }
  if (namespace !== "workflow")
    throw new Error("Usage: rl agent|policy list|show <name>");
  const name = rest[0];
  if (action === "run") {
    const config = configuration();
    const workflow = name ?? "triple-review",
      base = String(values.base ?? context.defaultBase);
    if (values["dry-run"]) {
      const plan = planRun(context.store, config, workflow, base);
      if (asJson) json(plan);
      else {
        console.log(
          `Preview: ${workflow}\nWorkspace: ${visible(plan.workspace)}\nScope: ${visible(base)} · ${plan.scope.files.length} changed files\nPolicy: ${plan.policy}`,
        );
        for (const step of plan.definition.steps)
          console.log(
            `  ${step.id}: ${step.agent ? `${step.agent} (${config.agents[step.agent].provider ?? "inherit"})` : JSON.stringify(step.command)} · after ${step.after.join(", ") || "start"}`,
          );
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
    report(run, asJson);
    if (!asJson)
      console.log(
        "Prepared for this session's native subagents. Claim ready steps with rl_workflow_claim or rl workflow claim; RL has not started any agent processes.",
      );
    return 0;
  }
  if (action === "resume") {
    const run = await resumeNativeRun(context.store, name, parent);
    report(run, asJson);
    return 0;
  }
  if (action === "pause" || action === "cancel") {
    const run = await controlRun(context.store, name, action);
    if (asJson) json({ id: run.id, status: run.status, requested: action });
    else console.log(`${action} requested for ${run.id}`);
    return 0;
  }
  if (action === "status") {
    report(readRun(context.store, name).run, asJson);
    return 0;
  }
  if (action === "metrics") {
    const { run } = readRun(context.store, name);
    const metrics = runMetrics(run);
    if (asJson) json(metrics);
    else {
      console.log(`Metrics: ${run.id}`);
      for (const [key, value] of Object.entries(metrics))
        if (key !== "stages") console.log(`${key}: ${value ?? "not reported"}`);
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
      configuration(),
    );
    report(run, asJson);
    return run.evaluation?.verdict === "ready" ? 0 : 1;
  }
  throw new Error(
    "Usage: rl workflow init|list|show|run|status|metrics|pause|cancel|resume|score",
  );
}
