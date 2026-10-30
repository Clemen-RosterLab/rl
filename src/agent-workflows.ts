import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { args, arity, json } from "./common.js";
import { commandContext, contextOptions } from "./command-context.js";
import {
  CONFIG_FILES,
  initAutomation,
  readAutomation,
} from "./automation-config.js";
import {
  controlRun,
  createRun,
  executeRun,
  planRun,
  readRun,
  rescoreRun,
  runMetrics,
  type WorkflowRun,
} from "./agent-runner.js";

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
    [...contextOptions, "base", "prompt", "provider", "policy"],
    ["json", "dry-run"],
  );
  const context = commandContext(values);
  const [namespace, action, ...rest] = positionals;
  arity(rest, 0, 1);
  const [, data] = context.store.current();
  const asJson = !!values.json;
  if (values.provider && !(namespace === "workflow" && action === "init"))
    throw new Error("--provider is only supported by workflow init");
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
    const provider = values.provider ?? "codex";
    if (provider !== "codex" && provider !== "claude")
      throw new Error("Provider must be codex or claude");
    await context.store.locked(() => initAutomation(data.worktree, provider));
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
            `  ${step.id}: ${step.agent ? `${step.agent} (${config.agents[step.agent].provider})` : JSON.stringify(step.command)} · after ${step.after.join(", ") || "start"}`,
          );
      }
      return 0;
    }
    const created = await createRun(
      context.store,
      config,
      workflow,
      base,
      String(values.prompt ?? ""),
    );
    if (!asJson) console.error(`Starting ${workflow} · ${created.run.id}`);
    const run = await executeRun(context.store, created.run.id, (text) =>
      console.error(text),
    );
    report(run, asJson);
    return run.scope.files.length && run.evaluation?.verdict !== "ready"
      ? 1
      : 0;
  }
  if (action === "resume") {
    const { run: saved } = readRun(context.store, name);
    const run = await executeRun(context.store, saved.id, (text) =>
      console.error(text),
    );
    report(run, asJson);
    return run.evaluation?.verdict === "ready" ? 0 : 1;
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
