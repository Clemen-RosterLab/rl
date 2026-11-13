import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { Agent } from "../agents.js";
import { canonical, inside, object } from "../common.js";
import { parseJsonObject } from "../json.js";

const BEGIN = "# BEGIN RL MCP - managed by rl setup mcp";
const END = "# END RL MCP";
const MARKER = "RL_MCP_MANAGED";

export interface McpClientUpdate {
  client: Agent;
  file: string;
  before?: string;
  after: string;
  action: "created" | "updated" | "unchanged";
}

export const MCP_CLIENT_CONFIG_PATHS: Readonly<Record<Agent, string>> = {
  codex: ".codex/config.toml",
  claude: ".mcp.json",
  agy: ".agents/mcp_config.json",
};

export function readWorkspaceMcpConfig(
  workspace: string,
  relative: string,
): { file: string; text?: string } {
  const file = path.join(workspace, relative);
  if (
    fs
      .lstatSync(path.dirname(file), { throwIfNoEntry: false })
      ?.isSymbolicLink() ||
    !inside(canonical(file), workspace)
  ) {
    throw new Error(
      `MCP configuration must stay in this workspace: ${relative}`,
    );
  }

  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    stat &&
    (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
  ) {
    throw new Error(
      `Expected a regular MCP configuration file up to 1 MiB: ${relative}`,
    );
  }

  return {
    file,
    ...(stat ? { text: fs.readFileSync(file, "utf8") } : {}),
  };
}

function buildManagedServerEntry(
  previous: unknown,
  command: string,
  argv: string[],
  file: string,
): Record<string, unknown> {
  if (
    previous !== undefined &&
    (!object(previous) || !object(previous.env) || previous.env[MARKER] !== "1")
  ) {
    throw new Error(
      `An existing server named rl in ${file} is not managed by RL. Keep it, or remove only that entry before running rl setup mcp.`,
    );
  }
  if (
    object(previous) &&
    (previous.url !== undefined ||
      (previous.type !== undefined && previous.type !== "stdio"))
  ) {
    throw new Error(
      `The existing rl server in ${file} is not a local stdio server`,
    );
  }
  const entry = object(previous) ? previous : {};
  return {
    ...entry,
    command,
    args: argv,
    env: { ...(object(entry.env) ? entry.env : {}), [MARKER]: "1" },
  };
}

function renderJsonMcpConfig(options: {
  before?: string;
  command: string;
  argv: string[];
  file: string;
  client: Agent;
  serverName: string;
}): string {
  const config =
    options.before === undefined ? {} : parseJsonObject(options.before);
  if (config.mcpServers !== undefined && !object(config.mcpServers)) {
    throw new Error(`Expected an mcpServers object in ${options.file}`);
  }
  const servers = object(config.mcpServers) ? config.mcpServers : {};
  const entry = {
    ...buildManagedServerEntry(
      servers[options.serverName],
      options.command,
      options.argv,
      options.file,
    ),
    ...(options.client === "claude" ? { type: "stdio" } : {}),
  };

  // Antigravity shares running servers by name across windows; prune obsolete RL-managed names.
  const kept = Object.fromEntries(
    Object.entries(servers).filter(
      ([key, value]) =>
        options.client !== "agy" ||
        key === options.serverName ||
        !(key === "rl" || key.startsWith("rl-")) ||
        !object(value) ||
        !object(value.env) ||
        value.env[MARKER] !== "1",
    ),
  );

  return (
    JSON.stringify(
      { ...config, mcpServers: { ...kept, [options.serverName]: entry } },
      null,
      2,
    ) + "\n"
  );
}

function renderCodexTomlMcpConfig(options: {
  before?: string;
  command: string;
  argv: string[];
  workspace: string;
  file: string;
}): string {
  const text = options.before ?? "";
  const config = parseToml(text, { integersAsBigInt: "asNeeded" });
  if (config.mcp_servers !== undefined && !object(config.mcp_servers)) {
    throw new Error(`Expected an mcp_servers table in ${options.file}`);
  }

  const servers = object(config.mcp_servers) ? config.mcp_servers : {};
  const entry = {
    ...buildManagedServerEntry(
      servers.rl,
      options.command,
      options.argv,
      options.file,
    ),
    cwd: options.workspace,
  };

  const starts = [
    ...text.matchAll(/^# BEGIN RL MCP - managed by rl setup mcp\r?$/gm),
  ];
  const ends = [...text.matchAll(/^# END RL MCP\r?$/gm)];
  const marked = starts.length > 0 || ends.length > 0;

  if (
    marked &&
    (starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].index >= ends[0].index ||
      servers.rl === undefined)
  ) {
    throw new Error(`Invalid managed RL MCP block in ${options.file}`);
  }
  if (servers.rl !== undefined && !marked) {
    throw new Error(
      `The rl server in ${options.file} has no managed block; preserve or remove that entry before setup`,
    );
  }

  const block = `${BEGIN}\n${stringifyToml({ mcp_servers: { rl: entry } })}${END}`;
  let updated: string;
  if (marked) {
    updated =
      text.slice(0, starts[0].index) +
      block +
      text.slice(ends[0].index + ends[0][0].length);
  } else {
    const prefix = text ? (text.endsWith("\n") ? "\n" : "\n\n") : "";
    updated = `${text}${prefix}${block}\n`;
  }

  const merged = parseToml(updated, { integersAsBigInt: "asNeeded" });
  const [originalSettings, mergedSettings] = [config, merged].map((value) => {
    const copy: Record<string, unknown> = { ...value };
    if (object(copy.mcp_servers)) {
      const nextServers = { ...copy.mcp_servers };
      delete nextServers.rl;
      if (Object.keys(nextServers).length > 0) {
        copy.mcp_servers = nextServers;
      } else {
        delete copy.mcp_servers;
      }
    }
    return copy;
  });

  if (!isDeepStrictEqual(originalSettings, mergedSettings)) {
    throw new Error(
      `The managed RL MCP block in ${options.file} contains unrelated settings. Move them outside the block before setup.`,
    );
  }

  return updated;
}

export function planClientMcpUpdate(options: {
  client: Agent;
  workspace: string;
  instanceKey: string;
  command: string;
  serverArgs: string[];
}): McpClientUpdate {
  const relative = MCP_CLIENT_CONFIG_PATHS[options.client];
  const { file, text } = readWorkspaceMcpConfig(options.workspace, relative);

  const after =
    options.client === "codex"
      ? renderCodexTomlMcpConfig({
          before: text,
          command: options.command,
          argv: options.serverArgs,
          workspace: options.workspace,
          file,
        })
      : renderJsonMcpConfig({
          before: text,
          command: options.command,
          argv: options.serverArgs,
          file,
          client: options.client,
          serverName:
            options.client === "agy" ? `rl-${options.instanceKey}` : "rl",
        });

  let action: McpClientUpdate["action"];
  if (text === after) {
    action = "unchanged";
  } else if (text === undefined) {
    action = "created";
  } else {
    action = "updated";
  }

  return {
    client: options.client,
    file,
    before: text,
    after,
    action,
  };
}
