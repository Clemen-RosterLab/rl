import { z } from "zod";
import type { Agent, AgentEvent } from "./agents.js";
import { timestamp } from "./common.js";
import { StateValidationError } from "./errors.js";
import { AGENTS } from "./schemas/common.js";
import { ActivityEntrySchema, HookHealthSchema } from "./schemas/instance.js";

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
  return items.map((item) => {
    const isStale =
      item.state !== "ended" &&
      at - Date.parse(item.observedAt) > STALE_AFTER_MS;
    return {
      ...item,
      state: isStale ? ("stale" as const) : item.state,
    };
  });
}

function nextActivityState(
  currentState: Activity["state"],
  eventType: AgentEvent["type"],
): Activity["state"] {
  if (
    eventType === "context.restored" ||
    eventType === "notification" ||
    eventType === "tool.before" ||
    eventType === "tool.after"
  ) {
    return currentState;
  }
  if (eventType === "session.ended") {
    return "ended";
  }
  if (eventType === "turn.started" || eventType === "child.started") {
    return "working";
  }
  return "idle";
}

function compareObservedTimestamps(a: Activity, b: Activity): number {
  try {
    const diff = timestamp(a.observedAt) - timestamp(b.observedAt);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  } catch {
    return a.observedAt.localeCompare(b.observedAt);
  }
}

export function recordActivity(
  data: Tracking,
  agent: Agent,
  event: AgentEvent,
  stamp: string,
  contextHash?: string,
): void {
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
  item.state = nextActivityState(item.state, event.type);
  item.lastEvent = event.nativeEvent;
  item.observedAt = stamp;
  if (contextHash) {
    item.contextHash = contextHash;
  }

  records.sort(compareObservedTimestamps);
  ((data.hookHealth ??= {})[agent] ??= {}).lastSuccess = {
    event: event.nativeEvent,
    at: stamp,
  };
}

const TrackingValidatorSchema = z.looseObject({
  activity: z
    .record(z.string(), z.array(ActivityEntrySchema))
    .refine((rec) =>
      Object.keys(rec).every((k) => (AGENTS as readonly string[]).includes(k)),
    )
    .optional(),
  hookHealth: z
    .record(z.string(), HookHealthSchema)
    .refine((rec) =>
      Object.keys(rec).every((k) => (AGENTS as readonly string[]).includes(k)),
    )
    .optional(),
});

export function validateTracking(data: Record<string, unknown>): void {
  const parsed = TrackingValidatorSchema.safeParse(data);
  if (!parsed.success) {
    throw new StateValidationError("Invalid activity or hook health metadata");
  }
}
