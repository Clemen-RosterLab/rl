import fs from "node:fs";
import path from "node:path";
import { adapters, agentAdapter } from "./agent-registry.js";
import { activityView, STALE_AFTER_MS } from "./activity.js";
import { execute, isSymlink, json, message } from "./common.js";
import { hookCommand, Store } from "./store.js";
import { isJsonObject, readJsonObject } from "./json.js";

const PROBE_TIMEOUT_MS = 2000;
const MAX_VERSION_LENGTH = 200;

export async function doctor(
  store: Store,
  selected?: string,
  asJson = false,
): Promise<number> {
  const [file, data] = store.current();
  const selectedAdapters = selected
    ? [agentAdapter(selected)]
    : Object.values(adapters);
  const agents = await Promise.all(
    selectedAdapters.map(async (adapter) => {
      const configPath = path.join(data.worktree, adapter.configPath);
      const expectedEvents = Object.keys({
        ...adapter.events,
        ...(data.extendedHooks ? adapter.extraEvents : {}),
      });
      const executablePath =
        (process.env.PATH ?? "")
          .split(path.delimiter)
          .map((directory) =>
            path.resolve(data.worktree, directory, adapter.name),
          )
          .find((candidate) => {
            try {
              fs.accessSync(candidate, fs.constants.X_OK);
              return fs.statSync(candidate).isFile();
            } catch {
              return false;
            }
          }) ?? null;
      let configError: string | null = null;
      let installedEvents: string[] = [];
      try {
        if (isSymlink(configPath) || isSymlink(path.dirname(configPath)))
          throw new Error("Hook configuration is a symlink");
        const config = readJsonObject(configPath);
        if (!isJsonObject(config.hooks))
          throw new Error("Missing hooks object");
        const command = hookCommand(store, data, adapter.name);
        const hooks = config.hooks;
        installedEvents = expectedEvents.filter((event) => {
          const groups = hooks[event];
          if (!Array.isArray(groups)) return false;
          return groups.some(
            (group) =>
              isJsonObject(group) &&
              (group.matcher === undefined ||
                group.matcher === "" ||
                group.matcher === "*") &&
              Array.isArray(group.hooks) &&
              group.hooks.some(
                (h) =>
                  isJsonObject(h) &&
                  h.type === "command" &&
                  h.command === command &&
                  h.async !== true,
              ),
          );
        });
      } catch (error) {
        configError = message(error);
      }
      const missingEvents = expectedEvents.filter(
        (event) => !installedEvents.includes(event),
      );
      let cliAvailable = false,
        version: string | null = null,
        cliError: string | null = null,
        launchVerified = false;
      try {
        const result = await execute(
          [adapter.name, "--version"],
          data.worktree,
          { timeoutMs: PROBE_TIMEOUT_MS },
        );
        cliAvailable = result.code === 0;
        version = result.stdout.trim().slice(0, MAX_VERSION_LENGTH) || null;
        if (!cliAvailable) cliError = "Version probe failed or timed out";
        if (cliAvailable) {
          const help = await execute(
            adapter.name === "codex"
              ? [adapter.name, "exec", "--help"]
              : [adapter.name, "--help"],
            data.worktree,
            { timeoutMs: PROBE_TIMEOUT_MS },
          );
          launchVerified =
            help.code === 0 &&
            (adapter.name === "codex"
              ? /codex exec/.test(help.stdout) && /PROMPT/.test(help.stdout)
              : /--print/.test(help.stdout) && /--resume/.test(help.stdout));
        }
      } catch (error) {
        cliError = message(error);
      }
      const health = data.hookHealth?.[adapter.name];
      return {
        agent: adapter.name,
        configPath,
        installed: !configError && missingEvents.length === 0,
        installedEvents,
        missingEvents,
        configError,
        cliAvailable,
        executablePath,
        launchVerified,
        extendedHooks: !!data.extendedHooks,
        delivery: health?.lastSuccess ? "observed" : "not-observed",
        version,
        cliError,
        compatibility: "unverified",
        trust: "unknown",
        lastSuccess: health?.lastSuccess ?? null,
        lastError: health?.lastError ?? null,
        activity: activityView(data.activity?.[adapter.name]),
      };
    }),
  );
  let stateWritable = true;
  try {
    fs.accessSync(store.root, fs.constants.W_OK);
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
  } catch {
    stateWritable = false;
  }
  const report = {
    workspace: data.worktree,
    stateDirectory: path.dirname(file),
    stateWritable,
    staleAfterMs: STALE_AFTER_MS,
    agents,
  };
  if (asJson) json(report);
  else {
    console.log(
      `RL doctor: ${data.worktree}\nState writable from this process: ${stateWritable ? "yes" : "no"}`,
    );
    for (const item of agents) {
      console.log(
        `\n${item.agent}: hooks ${item.installed ? "installed" : "incomplete"}; CLI ${item.cliAvailable ? (item.version ?? "available") : "unavailable"}`,
      );
      console.log(
        `  CLI: ${item.executablePath ?? "not on PATH"}; launch flags: ${item.launchVerified ? "verified in installed help" : "unverified"}; hook trust: unknown`,
      );
      console.log(
        `  Last received event: ${item.lastSuccess ? `${item.lastSuccess.event} at ${item.lastSuccess.at}` : "none"}`,
      );
      if (item.missingEvents.length)
        console.log(
          `  Missing hooks: ${item.missingEvents.join(", ")}. Run rl adopt.`,
        );
      if (item.configError)
        console.log(`  Configuration error: ${item.configError}`);
      if (item.cliError) console.log(`  CLI error: ${item.cliError}`);
      if (item.lastError)
        console.log(
          `  Last recorded hook error: ${item.lastError.message} at ${item.lastError.at}`,
        );
      for (const activity of item.activity)
        console.log(
          `  ${activity.sessionId}${activity.childId ? ` / child ${activity.childId}` : ""}: ${activity.state}${activity.resumable ? "" : " (observation only)"}`,
        );
    }
    console.log(
      "\nInstallation does not prove hooks are enabled or trusted. Review agent hook settings and start a session here to verify delivery. Version compatibility is not certified. Activity is based on received events; after 30 minutes without an event it is stale, not confirmed running. Agent sandbox access may differ from this process.",
    );
  }
  return stateWritable &&
    agents.every((item) => item.installed && item.cliAvailable)
    ? 0
    : 1;
}
