import { agentAdapter } from "./agent-registry.js";
import type { Agent } from "./agents.js";
import { syncCodexSessions } from "./codex-sessions.js";
import { execute, message, now, sessionId, timestamp } from "./common.js";
import type { Store } from "./store.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import { runFzf } from "./tui/fzf.js";
import { readWorkflowConfig, workflowEnvironment } from "./workflow-config.js";

export async function resumeSessions(
  store: Store,
  kind?: Agent,
  options: { latest?: boolean } = {},
): Promise<number> {
  if (!kind || kind === "codex") {
    await syncCodexSessions(store);
  }
  const [, data] = await store.locked(() => store.current());
  const kinds: Agent[] = kind ? [kind] : ["codex", "claude", "agy"];
  const choices = kinds
    .flatMap((agent) =>
      (data.sessions[agent] ?? []).map((session) => ({ ...session, agent })),
    )
    .toSorted((a, b) => {
      const recent = timestamp(b.lastUsedAt) - timestamp(a.lastUsedAt);
      if (recent > 0n) return 1;
      if (recent < 0n) return -1;
      return a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id);
    });

  if (choices.length === 0) {
    throw new Error(
      `No ${kind ? `${kind} ` : ""}session recorded for ${data.id}. Use 'rl agent save' to save a session first`,
    );
  }

  let selected = choices[0];
  if (choices.length > 1 && !options.latest) {
    const fzfRows = choices.map((choice) => ({
      id: `${choice.agent}:${choice.id}`,
      line: `${choice.agent}\t${choice.id}\tLast used: ${sanitizeTerminalText(choice.lastUsedAt)}\tStarted: ${sanitizeTerminalText(choice.createdAt)}`,
      value: choice,
    }));

    let picked;
    try {
      picked = await runFzf(fzfRows, {
        cwd: data.worktree,
        prompt: "Resume session › ",
        header: `${sanitizeTerminalText(data.id)} · Agent / session UUID / last used / started\nMost recently used first · Enter resume · Esc cancel`,
        heightPercent: 70,
        errorLabel: "Session selector",
      });
    } catch (error) {
      const detail = message(error);
      if (detail.includes("unknown selection") || detail.includes("(exit ")) {
        throw error;
      }
      throw new Error(
        `Cannot open session selector: ${detail}. Install fzf to choose a saved session`,
        { cause: error },
      );
    }

    if (!picked) {
      return 0;
    }
    selected = picked.items[0];
  }

  return resumeAgent(store, selected.agent, {
    cwd: data.worktree,
    sessionId: selected.id,
    expectedKey: data.key,
  });
}

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
  if (kind === "codex" && options.sessionId === undefined) {
    await syncCodexSessions(store, cwd);
  }

  const [file, data, sid] = await store.locked(() => {
    const [instanceFile, instance] = store.current(cwd);
    if (options.expectedKey && instance.key !== options.expectedKey) {
      throw new Error("Instance changed before agent launch");
    }
    const sessions = instance.sessions[kind] ?? [];
    const item =
      options.sessionId !== undefined
        ? sessions.find((s) => s.id === sessionId(options.sessionId))
        : sessions.reduce<(typeof sessions)[number] | undefined>(
            (a, b) =>
              !a || timestamp(b.lastUsedAt) > timestamp(a.lastUsedAt) ? b : a,
            undefined,
          );
    if (!item) {
      const uuidHint = kind !== "codex" ? " <UUID>" : "";
      throw new Error(
        `No ${kind} session recorded for ${instance.id}. Use 'rl agent save ${kind}${uuidHint}'`,
      );
    }
    return [instanceFile, instance, sessionId(item.id)] as const;
  });

  const stamp = now();
  console.error(`Resuming ${kind} session ${sid} for ${data.id}`);
  const command = agentAdapter(kind).resumeArgs(sid, options.prompt);
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

  if (result.code === 0) {
    await store.locked(() => {
      const [currentFile, current] = store.current(data.worktree);
      if (currentFile !== file) {
        throw new Error("Instance changed while the agent was running");
      }
      store.recordSession(file, current, kind, sid, stamp);
    });
  }
  return result.code;
}
