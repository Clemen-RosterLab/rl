import { object, sessionId, timestamp } from "./common.js";
import type { Agent } from "./agents.js";

export const MAX_HANDOFF_TEXT = 16000;
export const HANDOFF_FIELDS = [
  "summary",
  "changes",
  "validation",
  "next",
  "blockers",
] as const;
export interface HandoffNotes {
  summary: string;
  changes: string;
  validation: string;
  next: string;
  blockers: string;
}
export interface TaskHandoff extends HandoffNotes {
  id: string;
  agent: Agent;
  sessionId: string;
  savedAt: string;
}
export interface TaskState {
  state: "paused" | "active";
  handoffs: TaskHandoff[];
  continuedAt?: string;
}
export function handoffNotes(value: unknown): HandoffNotes {
  if (!object(value)) throw new Error("Handoff must be an object");
  const notes = {} as HandoffNotes;
  for (const field of HANDOFF_FIELDS) {
    const text =
      value[field] === undefined
        ? field === "blockers"
          ? ""
          : undefined
        : value[field];
    if (
      typeof text !== "string" ||
      (field !== "blockers" && !text.trim()) ||
      text.includes("\0")
    )
      throw new Error(
        `Handoff ${field} must be non-empty text (use 'Not run' for unperformed validation)`,
      );
    notes[field] = text.trim();
  }
  if (Object.values(notes).join("\n").length > MAX_HANDOFF_TEXT)
    throw new Error(
      `Handoff text must be at most ${MAX_HANDOFF_TEXT} characters`,
    );
  return notes;
}
export function validateTask(value: unknown): asserts value is TaskState {
  if (
    !object(value) ||
    !["paused", "active"].includes(String(value.state)) ||
    !Array.isArray(value.handoffs) ||
    !value.handoffs.length
  )
    throw new Error("Invalid task handoff state");
  const ids = new Set<string>();
  for (const item of value.handoffs) {
    if (
      !object(item) ||
      !["codex", "claude"].includes(String(item.agent)) ||
      sessionId(item.id) !== item.id ||
      sessionId(item.sessionId) !== item.sessionId ||
      ids.has(item.id as string) ||
      typeof item.savedAt !== "string"
    )
      throw new Error("Invalid task handoff");
    ids.add(item.id as string);
    timestamp(item.savedAt);
    handoffNotes(item);
  }
  if (value.continuedAt !== undefined) {
    if (typeof value.continuedAt !== "string")
      throw new Error("Invalid continuation time");
    timestamp(value.continuedAt);
  }
}
export function handoffText(handoff: TaskHandoff): string {
  return [
    `Task handoff saved ${handoff.savedAt}`,
    `Session: ${handoff.agent} ${handoff.sessionId}`,
    `Summary:\n${handoff.summary}`,
    `Changes:\n${handoff.changes}`,
    `Reported validation:\n${handoff.validation}`,
    `Next steps:\n${handoff.next}`,
    `Blockers:\n${handoff.blockers || "None reported"}`,
  ].join("\n\n");
}
