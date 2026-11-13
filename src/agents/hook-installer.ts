import fs from "node:fs";
import path from "node:path";
import { adapters } from "../agent-registry.js";
import type { Agent, AgentAdapter } from "../agents.js";
import {
  atomicWrite,
  git,
  isSymlink,
  message,
  object,
  readJson,
  shellQuote,
  writeJson,
} from "../common.js";
import { isJsonObject, readJsonObject } from "../json.js";
import type { Instance, Store } from "../store.js";

const HOOK_TIMEOUT_SECONDS = 10;
const CODEX_END_TIMEOUT_SECONDS = 3;
const HOOK_MARKER = " # rl-session-hook";

export function buildHookCommand(
  store: Pick<Store, "repo" | "stateDir">,
  data: Pick<Instance, "key">,
  agent: Agent,
  event?: string,
): string {
  const tokens = [
    "rl",
    "__hook",
    "--repo",
    store.repo,
    "--state-dir",
    store.stateDir,
    "hook",
    data.key,
    agent,
    ...(agent === "agy" && event ? [event] : []),
  ];
  return tokens.map(shellQuote).join(" ") + HOOK_MARKER;
}

function hasManagedHookEntry(existing: Record<string, unknown>): boolean {
  return Object.values(existing).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          object(group) &&
          ((typeof group.command === "string" &&
            group.command.endsWith(HOOK_MARKER)) ||
            (Array.isArray(group.hooks) &&
              group.hooks.some(
                (handler) =>
                  object(handler) &&
                  typeof handler.command === "string" &&
                  handler.command.endsWith(HOOK_MARKER),
              ))),
      ),
  );
}

export function installWorkspaceHooks(
  store: Store,
  file: string,
  data: Instance,
): void {
  const updates: [string, Record<string, unknown>][] = [];
  const commands = {} as Record<Agent, string>;

  for (const adapter of Object.values(adapters)) {
    const agent = adapter.name;
    const target = path.join(data.worktree, adapter.configPath);
    if (isSymlink(target) || isSymlink(path.dirname(target))) {
      throw new Error(
        `Refusing to install workspace hooks through a symlink: ${target}`,
      );
    }

    const config = fs.existsSync(target) ? readJson(target) : {};
    const namespace = adapter.hookNamespace ?? "hooks";

    if (adapter.hookNamespace && config[namespace] !== undefined) {
      const existing = config[namespace];
      if (!object(existing) || !hasManagedHookEntry(existing)) {
        throw new Error(
          `The existing ${namespace} hook in ${target} is not managed by RL`,
        );
      }
    }

    const hooks = (config[namespace] ??= {});
    if (!object(hooks)) {
      throw new Error(`Invalid hooks object in ${target}`);
    }

    commands[agent] = buildHookCommand(store, data, agent);

    const events = Object.keys({
      ...adapter.events,
      ...(data.extendedHooks ? adapter.extraEvents : {}),
    });

    for (const event of events) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups)) {
        throw new Error(`Invalid ${event} hooks in ${target}`);
      }

      if (adapter.directHookEvents?.includes(event)) {
        const kept = groups.filter((handler) => {
          if (!object(handler) || typeof handler.command !== "string") {
            throw new Error(`Invalid ${event} handler in ${target}`);
          }
          return !handler.command.endsWith(HOOK_MARKER);
        });
        hooks[event] = [
          ...kept,
          {
            type: "command",
            command: buildHookCommand(store, data, agent, event),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ];
        continue;
      }

      const kept: Record<string, unknown>[] = [];
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks)) {
          throw new Error(`Invalid hook group in ${target}`);
        }
        const handlers = group.hooks.filter(
          (handler: unknown) =>
            !(
              object(handler) &&
              typeof handler.command === "string" &&
              (handler.command === data.hookCommands?.[agent] ||
                handler.command.endsWith(HOOK_MARKER))
            ),
        );
        if (handlers.length > 0) {
          kept.push({ ...group, hooks: handlers });
        }
      }

      const timeout =
        event === "Interrupt" || (agent === "codex" && event === "SessionEnd")
          ? CODEX_END_TIMEOUT_SECONDS
          : HOOK_TIMEOUT_SECONDS;

      kept.push({
        hooks: [
          {
            type: "command",
            command: buildHookCommand(store, data, agent, event),
            timeout,
          },
        ],
      });
      hooks[event] = kept;
    }

    updates.push([target, config]);
  }

  for (const [target, config] of updates) {
    if (
      !fs.existsSync(target) ||
      JSON.stringify(readJson(target)) !== JSON.stringify(config)
    ) {
      writeJson(target, config);
    }
  }

  const exclude = path.resolve(
    data.worktree,
    git(data.worktree, "rev-parse", "--git-path", "info/exclude"),
  );
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  const missing = [
    "/.codex/hooks.json",
    "/.claude/settings.local.json",
    "/.agents/hooks.json",
    "/.agents/mcp_config.json",
  ].filter((entry) => !text.split(/\r?\n/).includes(entry));

  if (missing.length > 0) {
    const separator = text && !text.endsWith("\n") ? "\n" : "";
    atomicWrite(exclude, `${text}${separator}${missing.join("\n")}\n`);
  }

  if (JSON.stringify(data.hookCommands) !== JSON.stringify(commands)) {
    data.hookCommands = commands;
    store.save(file, data);
  }
}

export function inspectInstalledHooks(
  store: Pick<Store, "repo" | "stateDir">,
  data: Pick<Instance, "key" | "worktree" | "extendedHooks">,
  adapter: AgentAdapter,
): {
  configPath: string;
  installedEvents: string[];
  missingEvents: string[];
  configError: string | null;
} {
  const configPath = path.join(data.worktree, adapter.configPath);
  const expectedEvents = Object.keys({
    ...adapter.events,
    ...(data.extendedHooks ? adapter.extraEvents : {}),
  });

  let configError: string | null = null;
  let installedEvents: string[] = [];

  try {
    if (isSymlink(configPath) || isSymlink(path.dirname(configPath))) {
      throw new Error("Hook configuration is a symlink");
    }
    const config = readJsonObject(configPath);
    const hooks = config[adapter.hookNamespace ?? "hooks"];
    if (!isJsonObject(hooks)) {
      throw new Error("Missing hooks object");
    }
    if (hooks.enabled === false) {
      throw new Error("RL hooks are explicitly disabled");
    }

    installedEvents = expectedEvents.filter((event) => {
      const expectedCommand = buildHookCommand(
        store,
        data,
        adapter.name,
        event,
      );
      const groups = hooks[event];
      if (!Array.isArray(groups)) {
        return false;
      }
      if (adapter.directHookEvents?.includes(event)) {
        return groups.some(
          (handler) =>
            isJsonObject(handler) &&
            handler.type === "command" &&
            handler.command === expectedCommand &&
            handler.async !== true,
        );
      }
      return groups.some(
        (group) =>
          isJsonObject(group) &&
          (group.matcher === undefined ||
            group.matcher === "" ||
            group.matcher === "*") &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (handler) =>
              isJsonObject(handler) &&
              handler.type === "command" &&
              handler.command === expectedCommand &&
              handler.async !== true,
          ),
      );
    });
  } catch (error) {
    configError = message(error);
  }

  const missingEvents = expectedEvents.filter(
    (event) => !installedEvents.includes(event),
  );

  return {
    configPath,
    installedEvents,
    missingEvents,
    configError,
  };
}
