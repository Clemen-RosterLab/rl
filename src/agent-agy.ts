import path from "node:path";
import { object, sessionId } from "./common.js";
import { parseJsonObject } from "./json.js";
import { parseEvent, type AgentAdapter } from "./agents.js";

/** Antigravity's hook schema and camelCase wire protocol differ from Claude's. */
export const agy: AgentAdapter = {
  name: "agy",
  configPath: ".agents/hooks.json",
  hookNamespace: "rl-session-hooks",
  directHookEvents: ["SessionStart", "PreInvocation", "Stop"],
  events: {
    SessionStart: "session.started",
    PreInvocation: "turn.started",
    PreToolUse: "tool.before",
    PostToolUse: "tool.after",
    Stop: "turn.stopped",
  },
  extraEvents: {},
  observedId: sessionId,
  startArgs: (argv) => ["agy", ...argv],
  runArgs: (prompt, argv) => ["agy", ...argv, "--print", prompt],
  resumeArgs: (id, prompt) => [
    "agy",
    "--conversation",
    sessionId(id),
    ...(prompt === undefined ? [] : ["--prompt-interactive", prompt]),
  ],
  hookInput(payload, event) {
    if (!object(payload) || !event || !Object.hasOwn(agy.events, event))
      throw new Error("Antigravity hooks require a supported event argument");
    if (
      !Array.isArray(payload.workspacePaths) ||
      payload.workspacePaths.length !== 1 ||
      typeof payload.workspacePaths[0] !== "string" ||
      !path.isAbsolute(payload.workspacePaths[0])
    )
      throw new Error(
        "Antigravity hooks require exactly one absolute workspace path; multi-root conversations cannot be associated safely",
      );
    const tool = object(payload.toolCall) ? payload.toolCall : {};
    const input = object(tool.args) ? tool.args : {};
    return {
      ...payload,
      cwd: payload.workspacePaths[0],
      session_id: payload.conversationId,
      hook_event_name: event,
      tool_name: tool.name,
      tool_input: {
        ...input,
        file_path: input.TargetFile ?? input.AbsolutePath,
        command: input.CommandLine,
      },
    };
  },
  parse(payload) {
    const event = parseEvent(agy, payload);
    // A stopped foreground loop can still have background work running.
    if (
      event.nativeEvent === "Stop" &&
      object(payload) &&
      payload.fullyIdle === false
    )
      event.type = "notification";
    return event;
  },
  response(event, context) {
    if (["SessionStart", "PreInvocation"].includes(event.nativeEvent))
      return { injectSteps: context ? [{ ephemeralMessage: context }] : [] };
    if (event.nativeEvent === "PreToolUse") return { decision: "allow" };
    if (event.nativeEvent === "Stop") return { decision: "allow" };
    return {};
  },
  blockResponse(event, reason) {
    return {
      decision: event.nativeEvent === "Stop" ? "continue" : "deny",
      reason,
    };
  },
};

/** Stream one bounded prompt instead of putting large review evidence in argv. */
export function agyTurn(prompt: string, flags: string[] = []) {
  return {
    command: [
      "agy",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      ...flags,
    ],
    input:
      JSON.stringify({ event: "user", message: { content: prompt } }) + "\n",
  };
}

export function agyResult(stdout: string): Record<string, unknown> {
  const results = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseJsonObject)
    .filter((entry) => entry.event === "result");
  if (results.length !== 1 || !object(results[0].result))
    throw new Error("Antigravity did not return exactly one completed turn");
  const result = results[0].result;
  if (result.status !== "SUCCESS")
    throw new Error(
      `Antigravity turn failed: ${String(result.error ?? result.status ?? "unknown")}`,
    );
  sessionId(result.conversation_id);
  return result;
}
