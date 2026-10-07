import fs from "node:fs";
import { agentAdapter } from "./agent-registry.js";
import { args, arity, execute } from "./common.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
} from "./command-context.js";
import { readWorkflowConfig, workflowEnvironment } from "./workflow-config.js";
import { contextText, Store } from "./store.js";

export interface LaunchOptions {
  mode?: "start" | "run";
  prompt?: string;
  cwd?: string;
}

export async function launchAgent(
  store: Store,
  name: string,
  argv: string[] = [],
  options: LaunchOptions = {},
): Promise<number> {
  const adapter = agentAdapter(name);
  const [, data] = await store.locked(() => store.current(options.cwd));
  const headless = options.mode === "run";
  const prompt = options.prompt ?? "";
  if (headless && !prompt.trim())
    throw new Error("Agent run requires a non-empty --prompt");
  if (!headless && options.prompt !== undefined)
    throw new Error("Use agent run for --prompt");
  const command = headless
    ? adapter.runArgs(prompt, argv)
    : adapter.startArgs(argv);
  const result = await execute(command, data.worktree, {
    interactive: !headless,
    terminalError: headless,
    env: {
      ...workflowEnvironment(
        store.repo,
        data.worktree,
        readWorkflowConfig(store.repo),
      ),
      RL_STATE_DIR: store.stateDir,
    },
  });
  if (headless) process.stdout.write(result.stdout);
  return result.code;
}

export async function handoff(
  store: Store,
  target?: string,
  cwd?: string,
): Promise<string> {
  const adapter = target ? agentAdapter(target) : undefined;
  return store.locked(() => {
    const [file, data] = store.current(cwd);
    return (
      [
        adapter
          ? `Handoff to ${adapter.name}. Start with: rl agent start ${adapter.name}`
          : "RL agent handoff",
        "Shared task notes follow. Agent conversations remain in their original sessions.",
        contextText(file, data),
      ].join("\n\n") + "\n"
    );
  });
}

export async function main(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const extra = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = args(
    separator < 0 ? argv : argv.slice(0, separator),
    [...contextOptions, "prompt", "workspace", "output"],
    ["stdout"],
  );
  const context = commandContext(values);
  const target = resolveWorkspace(
    context,
    typeof values.workspace === "string" ? values.workspace : undefined,
  );
  const [command, name, ...rest] = positionals;
  arity(rest, 0);
  if (command === "handoff") {
    if (
      extra.length ||
      values.prompt !== undefined ||
      (values.stdout && values.output !== undefined)
    )
      throw new Error("Usage: rl handoff [agent] [--stdout | --output path]");
    const text = await handoff(context.store, name, target.path);
    if (typeof values.output === "string")
      fs.writeFileSync(values.output, text, { flag: "wx", mode: 0o600 });
    else process.stdout.write(text);
    return 0;
  }
  if (
    (command !== "start" && command !== "run") ||
    !name ||
    values.output !== undefined ||
    values.stdout
  )
    throw new Error(
      "Usage: rl agent start <codex|claude> [-- args] | run <agent> --prompt text [-- args]",
    );
  return launchAgent(context.store, name, extra, {
    mode: command,
    prompt: typeof values.prompt === "string" ? values.prompt : undefined,
    cwd: target.path,
  });
}
