import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { args, arity, message, required } from "./common.js";
import { activityView } from "./activity.js";
import { contextText, Store } from "./store.js";
import { agentAdapter } from "./agent-registry.js";
import { currentSessionId } from "./session.js";
import { syncCodexSessions } from "./codex-sessions.js";
import { pauseTask, PAUSE_FIELDS } from "./task.js";
import { HANDOFF_FIELDS, MAX_HANDOFF_TEXT } from "./task-state.js";

import {
  isJsonObject,
  parseJson,
  readJsonObject,
  type JsonObject,
} from "./json.js";
const PROTOCOL_VERSION = "2025-11-25";
const RPC_VERSION = "2.0";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_NOTE_LENGTH = 64 * 1024;
const ERROR = {
  parse: -32700,
  request: -32600,
  method: -32601,
  params: -32602,
};
const TOOLS = [
  {
    name: "rl_task_pause",
    description:
      "When the user asks to pause this task, save its current session and a durable handoff for rl continue. Include concrete changes, checks actually run and their results (or Not run), next steps, and blockers. agent defaults to codex. Supply the current session UUID if this server does not inherit it. Saving a pause does not terminate the agent.",
    append: false,
  },
  {
    name: "rl_session_save",
    description:
      "Save a session for this workspace so it appears in status and can be resumed. agent defaults to codex. Supply sessionId with the full UUID of the current conversation; if omitted, Codex IDs are read from this server's environment when available. Claude requires sessionId.",
    append: false,
  },
  {
    name: "rl_status",
    description:
      "Discover and save Codex sessions for this workspace, then read its branch, sessions and observed agent activity.",
    append: false,
  },
  {
    name: "rl_context",
    description: "Read shared task context and progress for agent handoff.",
    append: false,
  },
  {
    name: "rl_progress",
    description: "Read the complete shared progress document.",
    append: false,
  },
  {
    name: "rl_context_append",
    description: "Append durable design or domain notes to shared context.",
    append: true,
  },
  {
    name: "rl_progress_append",
    description: "Append a milestone or handoff update to shared progress.",
    append: true,
  },
];

async function* readMessages(input: Readable): AsyncGenerator<string | null> {
  let parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new Error("MCP input must be bytes");
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      if (!oversized) {
        if (size + length > MAX_MESSAGE_BYTES) {
          oversized = true;
          parts = [];
          size = 0;
        } else {
          parts.push(chunk.subarray(start, end));
          size += length;
        }
      }
      if (newline < 0) break;
      yield oversized ? null : Buffer.concat(parts, size).toString("utf8");
      parts = [];
      size = 0;
      oversized = false;
      start = newline + 1;
    }
  }
  if (oversized || size)
    yield oversized ? null : Buffer.concat(parts, size).toString("utf8");
}

async function callTool(
  store: Store,
  tool: (typeof TOOLS)[number],
  input: JsonObject,
): Promise<string> {
  const name = tool.name;
  const session = name === "rl_session_save";
  const allowed = session
    ? ["agent", "sessionId"]
    : name === "rl_task_pause"
      ? PAUSE_FIELDS
      : tool.append
        ? ["text"]
        : [];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error("Unexpected tool argument");
  if (name === "rl_task_pause")
    return JSON.stringify(await pauseTask(store, input));
  const text = input.text;
  if (
    tool.append &&
    (typeof text !== "string" || !text.trim() || text.length > MAX_NOTE_LENGTH)
  )
    throw new Error(
      `text must be non-empty and at most ${MAX_NOTE_LENGTH} characters`,
    );
  if (name === "rl_status") await syncCodexSessions(store, process.cwd());
  return store.locked(() => {
    const [file, data] = store.current();
    switch (name) {
      case "rl_session_save": {
        if (input.agent !== undefined && typeof input.agent !== "string")
          throw new Error("agent must be codex or claude");
        const agent = agentAdapter(input.agent ?? "codex").name;
        const sid = currentSessionId(agent, input.sessionId);
        store.recordSession(file, data, agent, sid);
        return JSON.stringify({ agent, sessionId: sid, instance: data.id });
      }
      case "rl_status":
        return JSON.stringify({
          id: data.id,
          branch: data.branch,
          worktree: data.worktree,
          sessions: data.sessions,
          task: data.task ?? null,
          activity: {
            codex: activityView(data.activity?.codex),
            claude: activityView(data.activity?.claude),
          },
        });
      case "rl_context":
        return contextText(file, data);
      case "rl_progress":
        return store.readDocument(file, "progress");
      default: {
        if (typeof text !== "string") throw new Error("text is required");
        store.updateDocument(
          file,
          data,
          name === "rl_context_append" ? "context" : "progress",
          "append",
          text,
        );
        return "Update appended.";
      }
    }
  });
}

export async function serveMcp(store: Store): Promise<number> {
  const metadata = readJsonObject(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  );
  if (typeof metadata.version !== "string")
    throw new Error("Invalid package version");
  const version = metadata.version;
  let initialized = false;
  let ready = false;
  for await (const line of readMessages(process.stdin)) {
    let id: string | number | null = null;
    let code = ERROR.parse;
    try {
      if (line === null) throw new Error("Message too large");
      const raw = parseJson(line);
      code = ERROR.request;
      if (
        !isJsonObject(raw) ||
        raw.jsonrpc !== RPC_VERSION ||
        typeof raw.method !== "string"
      )
        throw new Error("Invalid JSON-RPC request");
      if (
        raw.id !== undefined &&
        typeof raw.id !== "string" &&
        typeof raw.id !== "number"
      )
        throw new Error("Invalid request id");
      if (raw.id === undefined) {
        if (raw.method === "notifications/initialized" && initialized)
          ready = true;
        continue;
      }
      id = raw.id;
      const params = raw.params ?? {};
      code = ERROR.params;
      if (!isJsonObject(params)) throw new Error("params must be an object");
      let result: JsonObject;
      if (raw.method === "initialize") {
        if (initialized) throw new Error("Already initialized");
        if (
          typeof params.protocolVersion !== "string" ||
          !isJsonObject(params.capabilities) ||
          !isJsonObject(params.clientInfo) ||
          typeof params.clientInfo.name !== "string" ||
          typeof params.clientInfo.version !== "string"
        )
          throw new Error("Invalid initialization parameters");
        initialized = true;
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "rl", version },
        };
      } else if (raw.method === "ping") result = {};
      else {
        if (!ready) throw new Error("Initialize before using tools");
        if (raw.method === "tools/list") {
          result = {
            tools: TOOLS.map((tool): JsonObject => ({
              name: tool.name,
              description: tool.description,
              inputSchema: {
                type: "object",
                properties:
                  tool.name === "rl_task_pause"
                    ? {
                        ...Object.fromEntries(
                          HANDOFF_FIELDS.map((field) => [
                            field,
                            {
                              type: "string",
                              maxLength: MAX_HANDOFF_TEXT,
                              ...(field === "blockers" ? {} : { minLength: 1 }),
                            },
                          ]),
                        ),
                        agent: { type: "string", enum: ["codex", "claude"] },
                        sessionId: {
                          type: "string",
                          description: "Full UUID of the current conversation.",
                        },
                      }
                    : tool.name === "rl_session_save"
                      ? {
                          agent: { type: "string", enum: ["codex", "claude"] },
                          sessionId: {
                            type: "string",
                            description:
                              "Full session UUID; never a name or prefix.",
                          },
                        }
                      : tool.append
                        ? {
                            text: {
                              type: "string",
                              minLength: 1,
                              maxLength: MAX_NOTE_LENGTH,
                            },
                          }
                        : {},
                required:
                  tool.name === "rl_task_pause"
                    ? ["summary", "changes", "validation", "next"]
                    : tool.append
                      ? ["text"]
                      : [],
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint:
                  !tool.append &&
                  tool.name !== "rl_session_save" &&
                  tool.name !== "rl_status" &&
                  tool.name !== "rl_task_pause",
                destructiveHint: false,
                openWorldHint: false,
              },
            })),
          };
        } else if (raw.method === "tools/call") {
          if (
            typeof params.name !== "string" ||
            (params.arguments !== undefined && !isJsonObject(params.arguments))
          )
            throw new Error("Invalid tool call");
          const tool = TOOLS.find((item) => item.name === params.name);
          if (!tool) throw new Error(`Unknown tool: ${params.name}`);
          try {
            const text = await callTool(store, tool, params.arguments ?? {});
            result = { content: [{ type: "text", text }] };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: "text", text: message(error) }],
            };
          }
        } else {
          code = ERROR.method;
          throw new Error("Method not found");
        }
      }
      process.stdout.write(
        JSON.stringify({ jsonrpc: RPC_VERSION, id, result }) + "\n",
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: RPC_VERSION,
          id,
          error: { code, message: message(error) },
        }) + "\n",
      );
    }
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(argv, ["repo", "state-dir"], []);
  arity(positionals, 0);
  return serveMcp(
    new Store(required(values, "repo"), required(values, "state-dir")),
  );
}
