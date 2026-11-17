import { codex } from "./agent-codex.js";
import { claude } from "./agent-claude.js";
import { agy } from "./agent-agy.js";
import { opencode } from "./agent-opencode.js";
export const adapters = { codex, claude, agy, opencode };
export function agentAdapter(name: string) {
  if (
    name !== "codex" &&
    name !== "claude" &&
    name !== "agy" &&
    name !== "opencode"
  )
    throw new Error("Agent must be codex, claude, agy or opencode");
  return adapters[name];
}
