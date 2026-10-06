import path from "node:path";
import { object, sessionId } from "./common.js";

export type Agent = "codex" | "claude";
export type EventType =
  | "session.started"
  | "context.restored"
  | "turn.started"
  | "turn.stopped"
  | "session.ended"
  | "child.started"
  | "child.stopped";
export interface AgentEvent {
  type: EventType;
  nativeEvent: string;
  sessionId: string;
  childId?: string;
  cwd: string;
  resumable: boolean;
}
export interface AgentAdapter {
  name: Agent;
  configPath: string;
  events: Readonly<Record<string, EventType>>;
  observedId(value: unknown): string;
  resumeArgs(id: string): string[];
  parse(payload: unknown): AgentEvent;
  response(event: AgentEvent, context?: string): unknown | undefined;
}
export const lifecycleEvents: Readonly<Record<string, EventType>> = {
  SessionStart: "session.started",
  UserPromptSubmit: "turn.started",
  Stop: "turn.stopped",
  SessionEnd: "session.ended",
  SubagentStart: "child.started",
  SubagentStop: "child.stopped",
};
export function parseEvent(
  adapter: AgentAdapter,
  payload: unknown,
): AgentEvent {
  if (!object(payload)) throw new Error("Hook input must be a JSON object");
  const nativeEvent = String(payload.hook_event_name);
  if (!Object.hasOwn(adapter.events, nativeEvent))
    throw new Error("Unsupported session hook event");
  if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd))
    throw new Error("Hook requires an absolute cwd");
  const id = adapter.observedId(payload.session_id);
  let childId: string | undefined;
  if (payload.agent_id !== undefined) {
    if (
      typeof payload.agent_id !== "string" ||
      !/^[\w-]{1,200}$/.test(payload.agent_id)
    )
      throw new Error("Invalid child agent identifier");
    childId = payload.agent_id;
  }
  const type =
    adapter.events[nativeEvent] === "session.started" &&
    payload.source === "compact"
      ? "context.restored"
      : adapter.events[nativeEvent];
  if (type.startsWith("child.") && !childId)
    throw new Error("Subagent hook requires agent_id");
  let resumable = false;
  try {
    sessionId(id);
    resumable = !childId;
  } catch {
    /* Observed IDs are not necessarily CLI resume IDs. */
  }
  return {
    type,
    nativeEvent,
    sessionId: id,
    childId,
    cwd: payload.cwd,
    resumable,
  };
}
export function contextResponse(
  event: AgentEvent,
  context?: string,
): unknown | undefined {
  if (
    context &&
    [
      "session.started",
      "context.restored",
      "child.started",
      "turn.started",
    ].includes(event.type)
  )
    return {
      hookSpecificOutput: {
        hookEventName: event.nativeEvent,
        additionalContext: context,
      },
    };
  // Codex Stop/SubagentStop require JSON rather than plain text. An empty
  // object is also a non-blocking response for Claude. End hooks are silent.
  if (event.type === "turn.stopped" || event.type === "child.stopped")
    return {};
  return undefined;
}
