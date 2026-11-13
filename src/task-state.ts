import type { Agent } from "./agents.js";
import { object } from "./common.js";
import { StateValidationError } from "./errors.js";
import {
  HANDOFF_FIELDS,
  HandoffNotesInputSchema,
  MAX_HANDOFF_TEXT,
  TaskStateSchema,
} from "./schemas/instance.js";

export { HANDOFF_FIELDS, MAX_HANDOFF_TEXT };

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
  if (!object(value)) {
    throw new StateValidationError("Handoff must be an object");
  }
  const parsed = HandoffNotesInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new StateValidationError(
      parsed.error.issues[0]?.message ?? "Invalid task handoff notes",
    );
  }
  return parsed.data;
}

export function validateTask(value: unknown): asserts value is TaskState {
  const parsed = TaskStateSchema.safeParse(value);
  if (!parsed.success) {
    throw new StateValidationError(
      parsed.error.issues[0]?.message ?? "Invalid task handoff state",
    );
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
