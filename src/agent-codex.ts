import { sessionId } from "./common.js";
import {
  AgentAdapter,
  contextResponse,
  lifecycleEvents,
  parseEvent,
} from "./agents.js";
export const codex: AgentAdapter = {
  name: "codex",
  configPath: ".codex/hooks.json",
  events: { ...lifecycleEvents },
  extraEvents: { Interrupt: "turn.interrupted" },
  observedId(value) {
    // The hook contract also documents thread IDs. Record these for diagnostics,
    // but don't send them to CLI resume until that contract is verified.
    if (typeof value === "string" && /^thr_[A-Za-z0-9_-]{1,128}$/.test(value))
      return value;
    return sessionId(value);
  },
  resumeArgs: (id) => ["codex", "resume", sessionId(id)],
  startArgs: (argv) => ["codex", ...argv],
  runArgs: (prompt, argv) => ["codex", "exec", ...argv, "--", prompt],
  parse(payload) {
    return parseEvent(codex, payload);
  },
  response: contextResponse,
};
