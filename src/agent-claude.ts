import { sessionId } from "./common.js";
import {
  AgentAdapter,
  contextResponse,
  lifecycleEvents,
  parseEvent,
} from "./agents.js";
export const claude: AgentAdapter = {
  name: "claude",
  configPath: ".claude/settings.local.json",
  events: { ...lifecycleEvents },
  extraEvents: { StopFailure: "turn.failed", Notification: "notification" },
  observedId: sessionId,
  resumeArgs: (id, prompt) => [
    "claude",
    "--resume",
    sessionId(id),
    ...(prompt === undefined ? [] : [prompt]),
  ],
  startArgs: (argv) => ["claude", ...argv],
  runArgs: (prompt, argv) => ["claude", "--print", ...argv, "--", prompt],
  parse(payload) {
    return parseEvent(claude, payload);
  },
  response: contextResponse,
};
