import { agentAdapter } from "./agent-registry.js";
import { syncCodexSessions } from "./codex-sessions.js";
import { execute, now, sessionId, timestamp } from "./common.js";
import type { Agent } from "./agents.js";
import { Store } from "./store.js";
import { readWorkflowConfig, workflowEnvironment } from "./workflow-config.js";

export async function resumeAgent(
  store: Store,
  kind: Agent,
  options: {
    cwd?: string;
    sessionId?: string;
    prompt?: string;
    expectedKey?: string;
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  if (kind === "codex" && options.sessionId === undefined)
    await syncCodexSessions(store, cwd);
  const [file, data, sid] = await store.locked(() => {
    const [file, data] = store.current(cwd);
    if (options.expectedKey && data.key !== options.expectedKey)
      throw new Error("Instance changed before agent launch");
    const sessions = data.sessions[kind];
    const item =
      options.sessionId !== undefined
        ? sessions.find((item) => item.id === sessionId(options.sessionId))
        : sessions.reduce<(typeof sessions)[number] | undefined>(
            (a, b) =>
              !a || timestamp(b.lastUsedAt) > timestamp(a.lastUsedAt) ? b : a,
            undefined,
          );
    if (!item)
      throw new Error(
        `No ${kind} session recorded for ${data.id}. Use 'rl session save ${kind}${kind === "claude" ? " <UUID>" : ""}'`,
      );
    return [file, data, sessionId(item.id)] as const;
  });
  const stamp = now();
  console.error(`Resuming ${kind} session ${sid} for ${data.id}`);
  const command = agentAdapter(kind).resumeArgs(sid);
  if (options.prompt !== undefined) command.push(options.prompt);
  const result = await execute(command, data.worktree, {
    interactive: true,
    env: {
      ...workflowEnvironment(
        store.repo,
        data.worktree,
        readWorkflowConfig(store.repo),
      ),
      RL_STATE_DIR: store.stateDir,
    },
  });
  if (result.code === 0)
    await store.locked(() => {
      const [currentFile, current] = store.current(data.worktree);
      if (currentFile !== file)
        throw new Error("Instance changed while the agent was running");
      store.recordSession(file, current, kind, sid, stamp);
    });
  return result.code;
}
