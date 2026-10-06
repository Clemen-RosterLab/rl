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
  observedId: sessionId,
  resumeArgs: (id) => ["claude", "--resume", sessionId(id)],
  parse(payload) {
    return parseEvent(claude, payload);
  },
  response: contextResponse,
};
