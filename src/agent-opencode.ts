import path from "node:path";
import { object, openCodeSessionId } from "./common.js";
import { parseJsonObject } from "./json.js";
import { lifecycleEvents, parseEvent, type AgentAdapter } from "./agents.js";

export const OPENCODE_PLUGIN_HEADER =
  "// Managed by RL workspace hooks (rl-session-hook)\n";

export const opencode: AgentAdapter = {
  name: "opencode",
  configPath: ".opencode/plugins/rl.js",
  events: lifecycleEvents,
  extraEvents: {},
  observedId: openCodeSessionId,
  startArgs: (argv) => ["opencode", ...argv],
  runArgs: (prompt, argv) => ["opencode", "run", ...argv, "--", prompt],
  resumeArgs: (id, prompt) => [
    "opencode",
    "--session",
    openCodeSessionId(id),
    ...(prompt === undefined ? [] : ["--prompt", prompt]),
  ],
  hookInput(payload, event) {
    if (!object(payload) || !event || !Object.hasOwn(opencode.events, event))
      throw new Error("OpenCode hooks require a supported event argument");
    if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd))
      throw new Error("OpenCode hooks require an absolute cwd");
    const rawArgs = object(payload.toolArgs)
      ? payload.toolArgs
      : object(payload.tool_input)
        ? payload.tool_input
        : {};
    const agentId = payload.agentId ?? payload.agent_id;
    return {
      ...payload,
      cwd: payload.cwd,
      session_id: payload.sessionId ?? payload.sessionID ?? payload.session_id,
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      hook_event_name: event,
      tool_name: payload.toolName ?? payload.tool ?? payload.tool_name,
      tool_input: {
        ...rawArgs,
        file_path: rawArgs.filePath ?? rawArgs.file_path ?? rawArgs.path,
        patch: rawArgs.patchText ?? rawArgs.patch,
        command: rawArgs.command ?? rawArgs.cmd,
      },
    };
  },
  parse: (payload) => parseEvent(opencode, payload),
  response(event, context) {
    if (
      context &&
      [
        "SessionStart",
        "UserPromptSubmit",
        "SubagentStart",
        "PreToolUse",
        "PostToolUse",
      ].includes(event.nativeEvent)
    ) {
      return { decision: "allow", additionalContext: context };
    }
    if (event.nativeEvent === "PreToolUse" || event.nativeEvent === "Stop") {
      return { decision: "allow" };
    }
    return {};
  },
  blockResponse(event, reason) {
    return {
      decision: event.nativeEvent === "Stop" ? "continue" : "deny",
      reason,
    };
  },
};

/**
 * Render a managed OpenCode workspace plugin.
 *
 * IMPORTANT: OpenCode's plugin loader iterates `Object.entries(mod)` and invokes every
 * exported value as a plugin factory function (deduplicating identical references).
 * Never export non-function constants or metadata objects from this generated module.
 */
export function renderOpenCodePlugin(options: {
  repo: string;
  stateDir: string;
  key: string;
  command: string;
}): string {
  return `${OPENCODE_PLUGIN_HEADER}import { spawnSync } from "node:child_process";

const COMMAND = ${JSON.stringify(options.command)};
const REPO = ${JSON.stringify(options.repo)};
const STATE_DIR = ${JSON.stringify(options.stateDir)};
const INSTANCE_KEY = ${JSON.stringify(options.key)};

function invokeHook(cwd, eventName, payload) {
  void COMMAND;
  const result = spawnSync(
    "rl",
    [
      "__hook",
      "--repo",
      REPO,
      "--state-dir",
      STATE_DIR,
      "hook",
      INSTANCE_KEY,
      "opencode",
      eventName,
    ],
    {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      shell: process.platform === "win32",
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    return undefined;
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export const rlSessionPlugin = async (ctx) => {
  const cwd =
    typeof ctx?.directory === "string" && ctx.directory
      ? ctx.directory
      : typeof ctx?.worktree === "string" && ctx.worktree
        ? ctx.worktree
        : process.cwd();
  const started = new Set();
  const turnPrepared = new Set();
  const latestContext = new Map();
  const children = new Map();

  const prepareTurn = (sid) => {
    const eventName = started.has(sid) ? "UserPromptSubmit" : "SessionStart";
    const res = invokeHook(cwd, eventName, {
      cwd,
      sessionId: sid,
      ...(children.has(sid) ? { agentId: sid } : {}),
    });
    started.add(sid);
    if (
      res &&
      typeof res.additionalContext === "string" &&
      res.additionalContext
    ) {
      latestContext.set(sid, res.additionalContext);
    }
  };

  return {
    "chat.message": async (input) => {
      const sid = input?.sessionID;
      if (typeof sid !== "string" || !sid) return;
      prepareTurn(sid);
      turnPrepared.add(sid);
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sid = input?.sessionID;
      if (typeof sid !== "string" || !sid) return;
      if (!turnPrepared.has(sid)) {
        prepareTurn(sid);
      }
      turnPrepared.delete(sid);
      const context = latestContext.get(sid);
      if (
        context &&
        Array.isArray(output?.system) &&
        !output.system.includes(context)
      ) {
        output.system.push(context);
      }
    },
    "tool.execute.before": async (input, output) => {
      const sid = input?.sessionID;
      if (typeof sid !== "string" || !sid) return;
      const res = invokeHook(cwd, "PreToolUse", {
        cwd,
        sessionId: sid,
        ...(children.has(sid) ? { agentId: sid } : {}),
        toolName: input?.tool,
        toolArgs: output?.args ?? input?.args,
      });
      if (res && res.decision === "deny") {
        throw new Error(
          typeof res.reason === "string" && res.reason
            ? res.reason
            : "Blocked by RL workflow hook",
        );
      }
      if (
        res &&
        typeof res.additionalContext === "string" &&
        res.additionalContext
      ) {
        latestContext.set(sid, res.additionalContext);
      }
    },
    "tool.execute.after": async (input, output) => {
      const sid = input?.sessionID;
      if (typeof sid !== "string" || !sid) return;
      const res = invokeHook(cwd, "PostToolUse", {
        cwd,
        sessionId: sid,
        ...(children.has(sid) ? { agentId: sid } : {}),
        toolName: input?.tool,
        toolArgs: input?.args ?? output?.args,
      });
      if (
        res &&
        typeof res.additionalContext === "string" &&
        res.additionalContext
      ) {
        latestContext.set(sid, res.additionalContext);
      }
    },
    event: async ({ event }) => {
      const type = event?.type;
      const props = event?.properties;
      if (type === "session.created") {
        const info = props?.info ?? props;
        const sid = info?.id;
        const parentId = info?.parentID;
        if (
          typeof sid === "string" &&
          sid &&
          typeof parentId === "string" &&
          parentId
        ) {
          children.set(sid, parentId);
          invokeHook(cwd, "SubagentStart", {
            cwd,
            sessionId: parentId,
            agentId: sid,
          });
        }
        return;
      }
      const sid = props?.sessionID ?? props?.info?.id;
      if (typeof sid !== "string" || !sid) return;
      if (type === "session.idle") {
        invokeHook(cwd, "Stop", {
          cwd,
          sessionId: sid,
          ...(children.has(sid) ? { agentId: sid } : {}),
        });
      } else if (type === "session.deleted") {
        const parentId = children.get(sid);
        if (parentId) {
          invokeHook(cwd, "SubagentStop", {
            cwd,
            sessionId: parentId,
            agentId: sid,
          });
        }
        invokeHook(cwd, "SessionEnd", {
          cwd,
          sessionId: sid,
          ...(children.has(sid) ? { agentId: sid } : {}),
        });
        started.delete(sid);
        turnPrepared.delete(sid);
        latestContext.delete(sid);
        children.delete(sid);
      }
    },
  };
};

export default rlSessionPlugin;
`;
}

export function opencodeResult(stdout: string): {
  sessionId: string;
  text: string;
} {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      events.push(parseJsonObject(line));
    } catch {
      // Ignore diagnostic lines when --format json emits non-JSON banners.
    }
  }
  if (events.length === 0) {
    throw new Error("OpenCode did not return any JSON stream events");
  }
  let seenSessionId: string | undefined;
  const textParts: string[] = [];
  for (const entry of events) {
    if (entry.type === "error") {
      const err = object(entry.error) ? entry.error : {};
      const data = object(err.data) ? err.data : {};
      const detail =
        (typeof data.message === "string" && data.message) ||
        (typeof err.message === "string" && err.message) ||
        (typeof err.name === "string" && err.name) ||
        "unknown";
      throw new Error(`OpenCode turn failed: ${detail}`);
    }
    if (typeof entry.sessionID === "string") {
      const normalized = openCodeSessionId(entry.sessionID);
      seenSessionId ??= normalized;
    }
    if (
      entry.type === "text" &&
      object(entry.part) &&
      typeof entry.part.text === "string"
    ) {
      textParts.push(entry.part.text);
    }
  }
  if (!seenSessionId) {
    throw new Error("OpenCode stream did not include a valid sessionID");
  }
  return { sessionId: seenSessionId, text: textParts.join("") };
}

export function opencodeStructuredResult(
  stdout: string,
): Record<string, unknown> {
  const { text } = opencodeResult(stdout);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("OpenCode did not return structured JSON text");
  }
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return parseJsonObject(unfenced);
}
