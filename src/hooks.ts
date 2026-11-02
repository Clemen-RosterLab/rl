import fs from "node:fs";
import { observeWorkflowEvent } from "./session-workflows.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { agentAdapter } from "./agent-registry.js";
import { recordActivity } from "./activity.js";
import { git, json, message, now, object } from "./common.js";
import { contextText, Store } from "./store.js";

export async function handleHook(
  store: Store,
  key: string,
  name: string,
): Promise<number> {
  const adapter = agentAdapter(name);
  const payload: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
  if (
    !object(payload) ||
    typeof payload.cwd !== "string" ||
    !path.isAbsolute(payload.cwd)
  )
    throw new Error("Hook requires an absolute cwd");
  // Resolve repository membership before waiting for the state lock. Recheck
  // the branch inside it so a branch switch while waiting cannot bind a session.
  const [root] = store.worktree(payload.cwd);
  return store.locked(() => {
    // Establish ownership before persisting even diagnostics. A copied hook
    // cannot change the original instance or the destination instance.
    const [file, data] = store.instanceForWorktree(
      root,
      git(root, "branch", "--show-current"),
    );
    if (data.key !== key)
      throw new Error(
        "Hook belongs to a different RL instance; run 'rl setup adopt' to repair it",
      );
    try {
      const event = adapter.parse(payload);
      // Workflow workers are ephemeral. Supply task context without turning a
      // review pass into a saved conversation or changing the user's last-used
      // session. Other native/managed hooks remain under the CLI's own policy.
      if (process.env.RL_WORKFLOW_RUN && process.env.RL_WORKFLOW_STEP) {
        const context = [
          "session.started",
          "context.restored",
          "child.started",
          "turn.started",
        ].includes(event.type)
          ? contextText(file, data)
          : undefined;
        const response = adapter.response(event, context);
        if (response !== undefined) json(response);
        return 0;
      }
      const stamp = now();
      let context: string | undefined, hash: string | undefined;
      if (
        [
          "session.started",
          "context.restored",
          "child.started",
          "turn.started",
        ].includes(event.type)
      ) {
        const text = contextText(file, data);
        const digest = createHash("sha256").update(text);
        // Changes beyond the injected excerpt must also trigger a refresh.
        for (const name of ["context.md", "progress.md"])
          digest.update(fs.readFileSync(path.join(path.dirname(file), name)));
        hash = digest.digest("hex");
        const previous = data.activity?.[adapter.name]?.find(
          (s) => s.sessionId === event.sessionId && s.childId === event.childId,
        );
        if (event.type !== "turn.started" || previous?.contextHash !== hash)
          context = text;
      }
      // Keep last-used selection tied to starts/prompts, not a late shutdown
      // event from an older session or a child's activity.
      const used =
        event.resumable &&
        ["session.started", "context.restored", "turn.started"].includes(
          event.type,
        );
      if (used)
        store.associateSession(
          file,
          data,
          adapter.name,
          event.sessionId,
          stamp,
        );
      else store.assertSessionOwner(file, adapter.name, event.sessionId);
      recordActivity(data, adapter.name, event, stamp, hash);
      if (used) store.touch(file, data, stamp);
      else store.save(file, data);
      // Native workers never recursively schedule their own workflow. Tool hooks
      // describe what happened; the parent remains responsible for delegation.
      let queued: ReturnType<typeof observeWorkflowEvent> = [];
      if (!event.childId && !payload.stop_hook_active) {
        const tool =
          typeof payload.tool_name === "string" ? payload.tool_name : undefined;
        const input = object(payload.tool_input) ? payload.tool_input : {};
        const coordination =
          !!tool &&
          (tool.includes("rl_workflow_") ||
            (tool === "Bash" &&
              [input.command, input.cmd].some(
                (value) =>
                  typeof value === "string" &&
                  /^(?:command\s+)?rl\s+workflow\s+/.test(value.trim()),
              )));
        const paths: string[] = [];
        const addPath = (value: unknown) => {
          if (typeof value === "string") {
            const relative = path.relative(
              root,
              path.resolve(event.cwd, value),
            );
            if (relative && relative !== ".." && !relative.startsWith("../"))
              paths.push(relative);
          }
        };
        for (const value of [input.file_path, input.path]) addPath(value);
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
        ))
          addPath(match[1]);
        const edit =
          !!tool &&
          ["Edit", "Write", "MultiEdit", "apply_patch"].includes(tool);
        const milestone =
          event.type === "session.started"
            ? "session_start"
            : event.type === "turn.started"
              ? "prompt"
              : event.type === "turn.stopped"
                ? "before_finish"
                : event.type === "tool.before"
                  ? edit
                    ? "before_edit"
                    : "before_tool"
                  : event.type === "tool.after"
                    ? edit
                      ? "after_edit"
                      : "after_tool"
                    : undefined;
        if (milestone && !coordination)
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
      const notification = queued.length
        ? `RL workflow requests for this parent session (${adapter.name}, sessionId ${event.sessionId}): ${JSON.stringify(queued)}. Use rl_workflow_start with requestId, then rl_workflow_claim, spawn your own native subagents, and rl_workflow_report their evidence. If native delegation is unavailable, dismiss the request with the reason and tell the user. Follow current instructions and workspace permissions.`
        : undefined;
      if (notification)
        context = [context, notification].filter(Boolean).join("\n\n");
      if (context && !event.childId)
        context += `\nCurrent RL parent conversation: agent=${adapter.name}, sessionId=${event.sessionId}. Use this identity for workflow coordination tools.`;
      if (event.childId && context)
        context +=
          "\nYou are a native child. Follow your assigned role; do not create workflows or spawn further agents.";
      const response =
        event.type === "tool.before" && notification
          ? {
              hookSpecificOutput: {
                hookEventName: event.nativeEvent,
                permissionDecision: "deny",
                permissionDecisionReason: notification,
              },
            }
          : event.type === "turn.stopped" && notification
            ? { decision: "block", reason: notification }
            : adapter.response(event, context);
      if (response !== undefined) json(response);
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
