import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { recordActivity } from "./activity.js";
import { agentAdapter } from "./agent-registry.js";
import { boundAntigravityPeer } from "./agent-runner.js";
import type { Agent, AgentAdapter, AgentEvent } from "./agents.js";
import {
  git,
  json,
  message,
  now,
  object,
  readJson,
  writeJson,
} from "./common.js";
import { observeWorkflowEvent } from "./session-workflows.js";
import { contextText, Store, type Instance } from "./store.js";

const CONTEXT_INJECTION_EVENTS = new Set<AgentEvent["type"]>([
  "session.started",
  "context.restored",
  "child.started",
  "turn.started",
]);

const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "apply_patch",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

function scrubPrematurePeerRequests(
  instanceFile: string,
  agent: Agent,
  peerSessionId: string,
): void {
  const eventsPath = path.join(
    path.dirname(instanceFile),
    "workflow-events.json",
  );
  if (
    !fs.existsSync(eventsPath) ||
    fs.lstatSync(eventsPath, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    return;
  }
  try {
    const parsed = readJson(eventsPath);
    if (parsed.version !== 1 || !Array.isArray(parsed.requests)) {
      return;
    }
    const filtered = parsed.requests.filter(
      (req: unknown) =>
        !(
          object(req) &&
          req.agent === agent &&
          req.sessionId === peerSessionId &&
          !req.runId
        ),
    );
    if (filtered.length !== parsed.requests.length) {
      writeJson(eventsPath, { version: 1, requests: filtered });
    }
  } catch {
    // Malformed workflow-events.json will surface on workflow operations.
  }
}

function extractHookToolMetadata(
  payload: Record<string, unknown>,
  event: AgentEvent,
  worktreeRoot: string,
): {
  tool?: string;
  paths: string[];
  coordination: boolean;
  milestone?: string;
} {
  const tool =
    typeof payload.tool_name === "string" ? payload.tool_name : undefined;
  const input = object(payload.tool_input) ? payload.tool_input : {};

  const coordination =
    Boolean(tool) &&
    (tool!.includes("rl_workflow_") ||
      (["Bash", "run_command"].includes(tool!) &&
        [input.command, input.cmd].some(
          (value) =>
            typeof value === "string" &&
            /^(?:command\s+)?rl\s+workflow\s+/.test(value.trim()),
        )));

  const paths: string[] = [];
  const addPath = (value: unknown) => {
    if (typeof value !== "string") return;
    const relative = path.relative(
      worktreeRoot,
      path.resolve(event.cwd, value),
    );
    if (relative && relative !== ".." && !relative.startsWith("../")) {
      paths.push(relative);
    }
  };

  addPath(input.file_path);
  addPath(input.path);

  const patch =
    typeof input.patch === "string"
      ? input.patch
      : typeof input.input === "string"
        ? input.input
        : typeof payload.tool_input === "string"
          ? payload.tool_input
          : "";
  for (const match of patch.matchAll(
    /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm,
  )) {
    addPath(match[1]);
  }

  const isEdit = Boolean(tool) && EDIT_TOOL_NAMES.has(tool!);
  let milestone: string | undefined;
  switch (event.type) {
    case "session.started":
      milestone = "session_start";
      break;
    case "turn.started":
      milestone = "prompt";
      break;
    case "turn.stopped":
      milestone = "before_finish";
      break;
    case "tool.before":
      milestone = isEdit ? "before_edit" : "before_tool";
      break;
    case "tool.after":
      milestone = isEdit ? "after_edit" : "after_tool";
      break;
  }

  return { tool, paths, coordination, milestone };
}

function buildPeerContextText(
  store: Store,
  instanceFile: string,
  peer: NonNullable<ReturnType<typeof boundAntigravityPeer>>,
): string {
  const roleInstructions = peer.stage.agent
    ? peer.run.config.agents[peer.stage.agent].instructions
    : "";
  return [
    `You are the bound native RL peer ${peer.stage.id}, not a workflow coordinator. Do not create workflows or delegate. Run status: ${peer.run.status}.`,
    `Parent identity: agent=agy, sessionId=${peer.run.owner!.sessionId}. Use this parent identity for RL collaboration tools, with run=${peer.run.id}, step=${peer.stage.id}, claim=${peer.stage.claim}. Follow the parent and your assigned role.`,
    roleInstructions,
    `Shared context (excerpt):\n${store.readDocument(instanceFile, "context").slice(0, 12000)}`,
    `Recorded progress claims (excerpt):\n${store.readDocument(instanceFile, "progress").slice(0, 12000)}`,
  ].join("\n\n");
}

function buildHookResponse(
  adapter: AgentAdapter,
  event: AgentEvent,
  context: string | undefined,
  notification: string | undefined,
): unknown {
  if (
    notification &&
    adapter.blockResponse &&
    (event.type === "tool.before" || event.type === "turn.stopped")
  ) {
    return adapter.blockResponse(event, notification);
  }
  if (event.type === "tool.before" && notification) {
    return {
      hookSpecificOutput: {
        hookEventName: event.nativeEvent,
        permissionDecision: "deny",
        permissionDecisionReason: notification,
      },
    };
  }
  if (event.type === "turn.stopped" && notification) {
    return { decision: "block", reason: notification };
  }
  return adapter.response(event, context);
}

export async function handleHook(
  store: Store,
  key: string,
  name: string,
  nativeEvent?: string,
): Promise<number> {
  const adapter = agentAdapter(name);
  const raw: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
  const payload = adapter.hookInput ? adapter.hookInput(raw, nativeEvent) : raw;
  if (
    !object(payload) ||
    typeof payload.cwd !== "string" ||
    !path.isAbsolute(payload.cwd)
  ) {
    throw new Error("Hook requires an absolute cwd");
  }

  // Resolve repository membership before waiting for the state lock. Recheck
  // the branch inside it so a branch switch while waiting cannot bind a session.
  const [root] = store.worktree(payload.cwd);

  return store.locked(() => {
    // Establish ownership before persisting even diagnostics. A copied hook
    // cannot change the original instance or the destination instance.
    const [file, data]: [string, Instance] = store.instanceForWorktree(
      root,
      git(root, "branch", "--show-current"),
    );
    if (data.key !== key) {
      throw new Error(
        "Hook belongs to a different RL instance; run 'rl setup adopt' to repair it",
      );
    }

    try {
      const event = adapter.parse(payload);
      const peer =
        adapter.name === "agy"
          ? boundAntigravityPeer(file, data, event.sessionId)
          : undefined;

      if (peer) {
        event.childId = event.sessionId;
        event.resumable = false;
        // SessionStart can arrive before the parent has received and bound the
        // new handle. Reclassify only when the persisted binding proves it.
        if (data.sessions.agy) {
          const remaining = data.sessions.agy.filter(
            (session) => session.id !== event.sessionId,
          );
          if (remaining.length > 0) {
            data.sessions.agy = remaining;
          } else {
            delete data.sessions.agy;
          }
        }
        for (const activity of data.activity?.agy ?? []) {
          if (activity.sessionId === event.sessionId) {
            activity.childId = event.childId;
            activity.resumable = false;
          }
        }
        scrubPrematurePeerRequests(file, "agy", event.sessionId);
      }

      const sharedContext = () =>
        peer
          ? buildPeerContextText(store, file, peer)
          : contextText(file, data);

      // Ephemeral standalone workflow workers supply task context without mutating sessions.
      if (process.env.RL_WORKFLOW_RUN && process.env.RL_WORKFLOW_STEP) {
        const context = CONTEXT_INJECTION_EVENTS.has(event.type)
          ? sharedContext()
          : undefined;
        const response = adapter.response(event, context);
        if (response !== undefined) {
          json(response);
        }
        return 0;
      }

      const stamp = now();
      let context: string | undefined;
      let hash: string | undefined;

      if (CONTEXT_INJECTION_EVENTS.has(event.type)) {
        const text = sharedContext();
        const digest = createHash("sha256").update(text);
        // Changes beyond the injected excerpt must also trigger a refresh.
        for (const docName of ["context.md", "progress.md"]) {
          digest.update(
            fs.readFileSync(path.join(path.dirname(file), docName)),
          );
        }
        hash = digest.digest("hex");
        const previous = data.activity?.[adapter.name]?.find(
          (s) => s.sessionId === event.sessionId && s.childId === event.childId,
        );
        if (event.type !== "turn.started" || previous?.contextHash !== hash) {
          context = text;
        }
      }

      const used =
        event.resumable &&
        (event.type === "session.started" ||
          event.type === "context.restored" ||
          event.type === "turn.started");

      if (used) {
        store.associateSession(
          file,
          data,
          adapter.name,
          event.sessionId,
          stamp,
        );
      } else {
        store.assertSessionOwner(file, adapter.name, event.sessionId);
      }

      recordActivity(data, adapter.name, event, stamp, hash);
      if (used) {
        store.touch(file, data, stamp);
      } else {
        store.save(file, data);
      }

      // Native workers never recursively schedule their own workflow.
      let queued: ReturnType<typeof observeWorkflowEvent> = [];
      if (!event.childId && !payload.stop_hook_active) {
        const { tool, paths, coordination, milestone } =
          extractHookToolMetadata(payload, event, root);
        if (milestone && !coordination) {
          queued = observeWorkflowEvent(
            store,
            file,
            data,
            { agent: adapter.name, sessionId: event.sessionId },
            milestone,
            tool,
            paths,
          );
        }
      }

      const notification =
        queued.length > 0
          ? `RL workflow requests for this parent session (${adapter.name}, sessionId ${event.sessionId}): ${JSON.stringify(queued)}. Use rl_workflow_start with requestId, then rl_workflow_claim, spawn your own native subagents, and rl_workflow_report their evidence. If native delegation is unavailable, dismiss the request with the reason and tell the user. Follow current instructions and workspace permissions.`
          : undefined;

      if (notification) {
        context = [context, notification].filter(Boolean).join("\n\n");
      }
      if (context && !event.childId) {
        context += `\nCurrent RL parent conversation: agent=${adapter.name}, sessionId=${event.sessionId}. Use this identity for workflow coordination tools.`;
      }
      if (event.childId && context) {
        context +=
          "\nYou are a native child. Follow your assigned role; do not create workflows or spawn further agents.";
      }

      const response = buildHookResponse(adapter, event, context, notification);
      if (response !== undefined) {
        json(response);
      }
      return 0;
    } catch (error) {
      ((data.hookHealth ??= {})[adapter.name] ??= {}).lastError = {
        message: message(error),
        at: now(),
      };
      store.save(file, data);
      throw error;
    }
  });
}
