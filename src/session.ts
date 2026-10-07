import { Agent } from "./agents.js";
import { sessionId } from "./common.js";

export function currentSessionId(agent: Agent, explicit?: unknown): string {
  if (explicit !== undefined) return sessionId(explicit);
  if (agent !== "codex")
    throw new Error("Supply the Claude session UUID explicitly");
  // Resume the current conversation, including a fork, rather than its tree root.
  const id = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (!id)
    throw new Error(
      "No current Codex session ID. Run 'rl session save codex' inside Codex, or supply the full UUID: rl session save codex <UUID>",
    );
  return sessionId(id);
}
