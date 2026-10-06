import fs from "node:fs";
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
        "Hook belongs to a different RL instance; run 'rl adopt' to repair it",
      );
    try {
      const event = adapter.parse(payload);
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
      const response = adapter.response(event, context);
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
