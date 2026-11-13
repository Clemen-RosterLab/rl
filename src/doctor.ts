import fs from "node:fs";
import path from "node:path";
import { activityView, STALE_AFTER_MS } from "./activity.js";
import { adapters, agentAdapter } from "./agent-registry.js";
import { inspectInstalledHooks } from "./agents/hook-installer.js";
import { execute, json, message } from "./common.js";
import { findExecutable } from "./dependencies.js";
import type { Store } from "./store.js";

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
    : Object.values(adapters).filter(
        (adapter) =>
          adapter.name !== "agy" ||
          Boolean(findExecutable("agy")) ||
          Boolean(data.sessions.agy?.length) ||
          Boolean(data.activity?.agy?.length),
      );

  const agents = await Promise.all(
    selectedAdapters.map(async (adapter) => {
      const executablePath = findExecutable(adapter.name) ?? null;
      const { configPath, installedEvents, missingEvents, configError } =
        inspectInstalledHooks(store, data, adapter);

      let cliAvailable = false;
      let version: string | null = null;
      let cliError: string | null = null;
      let launchVerified = false;

      try {
        const probeResult = await execute(
          [adapter.name, adapter.name === "agy" ? "--help" : "--version"],
          data.worktree,
          { timeoutMs: PROBE_TIMEOUT_MS },
        );
        cliAvailable = probeResult.code === 0;
        version =
          adapter.name === "agy"
            ? null
            : probeResult.stdout.trim().slice(0, MAX_VERSION_LENGTH) || null;

        if (!cliAvailable) {
          cliError = "Version probe failed or timed out";
        } else {
          const helpResult =
            adapter.name === "agy"
              ? probeResult
              : await execute(
                  adapter.name === "codex"
                    ? [adapter.name, "exec", "--help"]
                    : [adapter.name, "--help"],
                  data.worktree,
                  { timeoutMs: PROBE_TIMEOUT_MS },
                );

          launchVerified =
            helpResult.code === 0 &&
            (adapter.name === "codex"
              ? /codex exec/.test(helpResult.stdout) &&
                /PROMPT/.test(helpResult.stdout)
              : /--print/.test(helpResult.stdout) &&
                (adapter.name === "agy"
                  ? /--conversation/.test(helpResult.stdout)
                  : /--resume/.test(helpResult.stdout)));
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
        extendedHooks: Boolean(data.extendedHooks),
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

  if (asJson) {
    json(report);
  } else {
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
      if (item.missingEvents.length > 0) {
        console.log(
          `  Missing hooks: ${item.missingEvents.join(", ")}. Run rl setup adopt.`,
        );
      }
      if (item.configError) {
        console.log(`  Configuration error: ${item.configError}`);
      }
      if (item.cliError) {
        console.log(`  CLI error: ${item.cliError}`);
      }
      if (item.lastError) {
        console.log(
          `  Last recorded hook error: ${item.lastError.message} at ${item.lastError.at}`,
        );
      }
      for (const activity of item.activity) {
        console.log(
          `  ${activity.sessionId}${activity.childId ? ` / child ${activity.childId}` : ""}: ${activity.state}${activity.resumable ? "" : " (observation only)"}`,
        );
      }
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
