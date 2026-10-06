import { codex } from "./agent-codex.js";
import { claude } from "./agent-claude.js";
export const adapters = { codex, claude };
export function agentAdapter(name: string) {
  if (name !== "codex" && name !== "claude")
    throw new Error("Agent must be codex or claude");
  return adapters[name];
}
