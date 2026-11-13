import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./agents.js";
import {
  planClientMcpUpdate,
  readWorkspaceMcpConfig,
} from "./agents/mcp-installer.js";
import { commandContext, contextOptions } from "./command-context.js";
import { args, arity, atomicWrite, json, locked } from "./common.js";
import { UsageError } from "./errors.js";

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, contextOptions, [
    "dry-run",
    "json",
  ]);
  arity(positionals, 0, 1);

  const selected = positionals[0];
  if (
    selected !== undefined &&
    selected !== "codex" &&
    selected !== "claude" &&
    selected !== "agy"
  ) {
    throw new UsageError(
      "Expected codex, claude or agy; omit the client to configure Codex and Claude",
    );
  }

  const context = commandContext(values);
  const [, active] = context.store.current();
  const dryRun = Boolean(values["dry-run"]);

  const updates = await locked(active.worktree, ".rl-mcp-setup.lock", () => {
    const [, instance] = context.store.current();
    if (instance.key !== active.key) {
      throw new Error("RL workspace changed during MCP setup; retry");
    }

    const workspace = instance.worktree;
    const command = process.execPath;
    const serverArgs = [
      fileURLToPath(new URL("./cli.js", import.meta.url)),
      "mcp",
      "--repo",
      context.repo,
      "--state-dir",
      context.stateDir,
      "--workspace",
      workspace,
    ];

    const clients: Agent[] = selected ? [selected] : ["codex", "claude"];
    const plans = clients.map((client) =>
      planClientMcpUpdate({
        client,
        workspace,
        instanceKey: active.key,
        command,
        serverArgs,
      }),
    );

    if (!dryRun) {
      // Validate every selected file before writing any, and refuse concurrent
      // external edits rather than silently replacing another process's work.
      for (const plan of plans) {
        const current = readWorkspaceMcpConfig(
          workspace,
          path.relative(workspace, plan.file),
        );
        if (current.text !== plan.before) {
          throw new Error("MCP configuration changed during setup; retry");
        }
      }
      for (const plan of plans) {
        if (plan.action !== "unchanged") {
          atomicWrite(plan.file, plan.after);
        }
      }
    }

    return plans.map(({ client, file, action }) => ({ client, file, action }));
  });

  if (values.json) {
    json({
      dryRun,
      files: updates,
      next: "Reload your client and review its normal project trust/MCP approval. Native subagents are created by the current session.",
    });
  } else {
    for (const update of updates) {
      const verb = dryRun
        ? "Would configure"
        : update.action === "unchanged"
          ? "Already configured"
          : "Configured";
      console.log(`${verb} ${update.client}: ${update.file}`);
    }
    console.log(
      "Reload your client, then review its normal project trust/MCP approval. RL tools will be available to your existing session.",
    );
  }
  return 0;
}
