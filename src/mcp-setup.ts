import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  args,
  arity,
  atomicWrite,
  canonical,
  inside,
  json,
  locked,
  object,
} from "./common.js";
import { commandContext, contextOptions } from "./command-context.js";
import { parseJsonObject } from "./json.js";

const BEGIN = "# BEGIN RL MCP - managed by rl setup mcp";
const END = "# END RL MCP";
const MARKER = "RL_MCP_MANAGED";
type Client = "codex" | "claude" | "agy";
interface Update {
  client: Client;
  file: string;
  before?: string;
  after: string;
  action: "created" | "updated" | "unchanged";
}

function readConfig(
  workspace: string,
  relative: string,
): { file: string; text?: string } {
  const file = path.join(workspace, relative);
  if (
    fs
      .lstatSync(path.dirname(file), { throwIfNoEntry: false })
      ?.isSymbolicLink() ||
    !inside(canonical(file), workspace)
  )
    throw new Error(
      `MCP configuration must stay in this workspace: ${relative}`,
    );
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    stat &&
    (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
  )
    throw new Error(
      `Expected a regular MCP configuration file up to 1 MiB: ${relative}`,
    );
  return { file, ...(stat ? { text: fs.readFileSync(file, "utf8") } : {}) };
}

function serverEntry(
  previous: unknown,
  command: string,
  argv: string[],
  file: string,
) {
  if (
    previous !== undefined &&
    (!object(previous) || !object(previous.env) || previous.env[MARKER] !== "1")
  )
    throw new Error(
      `An existing server named rl in ${file} is not managed by RL. Keep it, or remove only that entry before running rl setup mcp.`,
    );
  if (
    object(previous) &&
    (previous.url !== undefined ||
      (previous.type !== undefined && previous.type !== "stdio"))
  )
    throw new Error(
      `The existing rl server in ${file} is not a local stdio server`,
    );
  const entry = object(previous) ? previous : {};
  return {
    ...entry,
    command,
    args: argv,
    env: { ...(object(entry.env) ? entry.env : {}), [MARKER]: "1" },
  };
}

function jsonConfig(
  before: string | undefined,
  command: string,
  argv: string[],
  file: string,
  client: Client = "claude",
  name = "rl",
): string {
  const config = before === undefined ? {} : parseJsonObject(before);
  if (config.mcpServers !== undefined && !object(config.mcpServers))
    throw new Error(`Expected an mcpServers object in ${file}`);
  const servers = object(config.mcpServers) ? config.mcpServers : {};
  const entry = {
    ...serverEntry(servers[name], command, argv, file),
    ...(client === "claude" ? { type: "stdio" } : {}),
  };
  // Antigravity shares running servers by name. A workspace-specific name
  // prevents another workspace's already-running RL server from winning.
  const kept = Object.fromEntries(
    Object.entries(servers).filter(
      ([key, value]) =>
        client !== "agy" ||
        key === name ||
        !(key === "rl" || key.startsWith("rl-")) ||
        !object(value) ||
        !object(value.env) ||
        value.env[MARKER] !== "1",
    ),
  );
  return (
    JSON.stringify(
      { ...config, mcpServers: { ...kept, [name]: entry } },
      null,
      2,
    ) + "\n"
  );
}

function codexConfig(
  before: string | undefined,
  command: string,
  argv: string[],
  workspace: string,
  file: string,
): string {
  const text = before ?? "";
  const config = parseToml(text, { integersAsBigInt: "asNeeded" });
  if (config.mcp_servers !== undefined && !object(config.mcp_servers))
    throw new Error(`Expected an mcp_servers table in ${file}`);
  const servers = object(config.mcp_servers) ? config.mcp_servers : {};
  const entry = {
    ...serverEntry(servers.rl, command, argv, file),
    cwd: workspace,
  };
  const starts = [
    ...text.matchAll(/^# BEGIN RL MCP - managed by rl setup mcp\r?$/gm),
  ];
  const ends = [...text.matchAll(/^# END RL MCP\r?$/gm)];
  const marked = starts.length || ends.length;
  if (
    marked &&
    (starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].index >= ends[0].index ||
      servers.rl === undefined)
  )
    throw new Error(`Invalid managed RL MCP block in ${file}`);
  if (servers.rl !== undefined && !marked)
    throw new Error(
      `The rl server in ${file} has no managed block; preserve or remove that entry before setup`,
    );
  const block = `${BEGIN}\n${stringifyToml({ mcp_servers: { rl: entry } })}${END}`;
  const updated = marked
    ? text.slice(0, starts[0].index) +
      block +
      text.slice(ends[0].index + ends[0][0].length)
    : text + (text ? (text.endsWith("\n") ? "\n" : "\n\n") : "") + block + "\n";
  // Validate the merged document as well: inline tables and dotted keys may
  // prevent appending a new child table even when the existing TOML is valid.
  const merged = parseToml(updated, { integersAsBigInt: "asNeeded" });
  const [originalSettings, mergedSettings] = [config, merged].map((value) => {
    const copy: Record<string, unknown> = { ...value };
    if (object(copy.mcp_servers)) {
      const servers = { ...copy.mcp_servers };
      delete servers.rl;
      if (Object.keys(servers).length) copy.mcp_servers = servers;
      else delete copy.mcp_servers;
    }
    return copy;
  });
  if (!isDeepStrictEqual(originalSettings, mergedSettings))
    throw new Error(
      `The managed RL MCP block in ${file} contains unrelated settings. Move them outside the block before setup.`,
    );
  return updated;
}

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
  )
    throw new Error(
      "Expected codex, claude or agy; omit the client to configure Codex and Claude",
    );
  const context = commandContext(values);
  const [, active] = context.store.current();
  const updates = await locked(active.worktree, ".rl-mcp-setup.lock", () => {
    const [, instance] = context.store.current();
    if (instance.key !== active.key)
      throw new Error("RL workspace changed during MCP setup; retry");
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
    const clients: Client[] = selected ? [selected] : ["codex", "claude"];
    const plans: Update[] = clients.map((client) => {
      const { file, text } = readConfig(
        workspace,
        client === "codex"
          ? ".codex/config.toml"
          : client === "agy"
            ? ".agents/mcp_config.json"
            : ".mcp.json",
      );
      const after =
        client === "codex"
          ? codexConfig(text, command, serverArgs, workspace, file)
          : jsonConfig(
              text,
              command,
              serverArgs,
              file,
              client,
              client === "agy" ? `rl-${active.key}` : "rl",
            );
      return {
        client,
        file,
        before: text,
        after,
        action:
          text === after
            ? "unchanged"
            : text === undefined
              ? "created"
              : "updated",
      };
    });
    if (!values["dry-run"]) {
      // Validate every selected file before writing any, and refuse concurrent
      // external edits rather than silently replacing another process's work.
      for (const plan of plans) {
        const current = readConfig(
          workspace,
          path.relative(workspace, plan.file),
        );
        if (current.text !== plan.before)
          throw new Error("MCP configuration changed during setup; retry");
      }
      for (const plan of plans)
        if (plan.action !== "unchanged") atomicWrite(plan.file, plan.after);
    }
    return plans.map(({ client, file, action }) => ({ client, file, action }));
  });
  if (values.json)
    json({
      dryRun: !!values["dry-run"],
      files: updates,
      next: "Reload your client and review its normal project trust/MCP approval. Native subagents are created by the current session.",
    });
  else {
    for (const update of updates)
      console.log(
        `${values["dry-run"] ? "Would configure" : update.action === "unchanged" ? "Already configured" : "Configured"} ${update.client}: ${update.file}`,
      );
    console.log(
      "Reload your client, then review its normal project trust/MCP approval. RL tools will be available to your existing session.",
    );
  }
  return 0;
}
