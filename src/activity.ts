import { object, timestamp } from "./common.js";
import { AgentEvent, Agent } from "./agents.js";

export interface Activity {
  sessionId: string;
  childId?: string;
  state: "idle" | "working" | "ended";
  lastEvent: string;
  observedAt: string;
  resumable: boolean;
  contextHash?: string;
}
export interface HookHealth {
  lastSuccess?: { event: string; at: string };
  lastError?: { message: string; at: string };
}
export interface Tracking {
  activity?: Partial<Record<Agent, Activity[]>>;
  hookHealth?: Partial<Record<Agent, HookHealth>>;
}
export const STALE_AFTER_MS = 30 * 60 * 1000;
export function activityView(items: Activity[] = [], at = Date.now()) {
  return items.map((item) => ({
    ...item,
    state:
      item.state !== "ended" &&
      at - Date.parse(item.observedAt) > STALE_AFTER_MS
        ? "stale"
        : item.state,
  }));
}
export function recordActivity(
  data: Tracking,
  agent: Agent,
  event: AgentEvent,
  stamp: string,
  contextHash?: string,
) {
  const records = ((data.activity ??= {})[agent] ??= []);
  let item = records.find(
    (entry) =>
      entry.sessionId === event.sessionId && entry.childId === event.childId,
  );
  if (!item) {
    item = {
      sessionId: event.sessionId,
      childId: event.childId,
      state: "idle",
      lastEvent: event.nativeEvent,
      observedAt: stamp,
      resumable: event.resumable,
    };
    records.push(item);
  }
  // Arrival order is the only portable ordering available. Do not invent a
  // source timestamp or claim this is a process-liveness signal.
  item.state =
    event.type === "context.restored" || event.type === "notification"
      ? item.state
      : event.type === "session.ended"
        ? "ended"
        : ["turn.started", "child.started"].includes(event.type)
          ? "working"
          : "idle";
  item.lastEvent = event.nativeEvent;
  item.observedAt = stamp;
  if (contextHash) item.contextHash = contextHash;
  // Keep one snapshot per identity so ownership remains known across sessions.
  records.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  ((data.hookHealth ??= {})[agent] ??= {}).lastSuccess = {
    event: event.nativeEvent,
    at: stamp,
  };
}
export function validateTracking(data: Record<string, unknown>): void {
  if (data.activity !== undefined) {
    if (!object(data.activity)) throw new Error("Invalid activity");
    for (const items of Object.values(data.activity)) {
      if (!Array.isArray(items)) throw new Error("Invalid activity");
      for (const item of items) {
        if (
          !object(item) ||
          typeof item.sessionId !== "string" ||
          (item.childId !== undefined && typeof item.childId !== "string") ||
          !["idle", "working", "ended"].includes(String(item.state)) ||
          typeof item.lastEvent !== "string" ||
          typeof item.observedAt !== "string" ||
          typeof item.resumable !== "boolean" ||
          (item.contextHash !== undefined &&
            typeof item.contextHash !== "string")
        )
          throw new Error("Invalid activity");
        timestamp(item.observedAt);
      }
    }
  }
  if (data.hookHealth !== undefined) {
    if (!object(data.hookHealth)) throw new Error("Invalid hook health");
    for (const health of Object.values(data.hookHealth)) {
      if (!object(health)) throw new Error("Invalid hook health");
      for (const key of ["lastSuccess", "lastError"]) {
        const entry = health[key];
        if (entry === undefined) continue;
        if (
          !object(entry) ||
          typeof entry.at !== "string" ||
          typeof entry[key === "lastSuccess" ? "event" : "message"] !== "string"
        )
          throw new Error("Invalid hook health");
        timestamp(entry.at);
      }
    }
  }
}
