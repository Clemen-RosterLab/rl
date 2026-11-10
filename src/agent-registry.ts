import { codex } from "./agent-codex.js";
import { claude } from "./agent-claude.js";
import { agy } from "./agent-agy.js";
export const adapters = { codex, claude, agy };
export function agentAdapter(name: string) {
  if (name !== "codex" && name !== "claude" && name !== "agy")
    throw new Error("Agent must be codex, claude or agy");
  return adapters[name];
}
