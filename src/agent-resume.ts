import { agentAdapter } from "./agent-registry.js";
import { syncCodexSessions } from "./codex-sessions.js";
import { execute, message, now, sessionId, timestamp } from "./common.js";
import type { Agent } from "./agents.js";
import { Store } from "./store.js";
import { readWorkflowConfig, workflowEnvironment } from "./workflow-config.js";
import { stripVTControlCharacters } from "node:util";

export async function resumeSessions(
  store: Store,
  kind?: Agent,
  options: { latest?: boolean } = {},
): Promise<number> {
  if (kind !== "claude") await syncCodexSessions(store);
  const [, data] = await store.locked(() => store.current());
  const kinds: Agent[] = kind ? [kind] : ["codex", "claude"];
  const choices = kinds
    .flatMap((agent) =>
      data.sessions[agent].map((session) => ({ ...session, agent })),
    )
    .sort((a, b) => {
      const recent = timestamp(b.lastUsedAt) - timestamp(a.lastUsedAt);
      return recent > 0n
        ? 1
        : recent < 0n
          ? -1
          : a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id);
    });
  if (!choices.length)
    throw new Error(
      `No ${kind ? `${kind} ` : ""}session recorded for ${data.id}. Use 'rl agent save' to save a session first`,
    );
  let selected = choices[0];
  if (choices.length > 1 && !options.latest) {
    const visible = (value: string) =>
      stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const lines = choices.map(
      (choice) =>
        `${choice.agent}:${choice.id}\t${choice.agent}\t${choice.id}\tLast used: ${visible(choice.lastUsedAt)}\tStarted: ${visible(choice.createdAt)}`,
    );
    let result;
    try {
      result = await execute(
        [
          "fzf",
          "--delimiter=\t",
          "--with-nth=2..",
          "--no-multi",
          "--no-sort",
          "--height=70%",
          "--border=rounded",
          "--reverse",
          "--prompt=Resume session › ",
          `--header=${visible(data.id)} · Agent / session UUID / last used / started\nMost recently used first · Enter resume · Esc cancel`,
        ],
        data.worktree,
        { input: lines.join("\n") + "\n", terminalError: true },
      );
    } catch (error) {
      throw new Error(
        `Cannot open session selector: ${message(error)}. Install fzf to choose a saved session`,
      );
    }
    if ([1, 130].includes(result.code)) return 0;
    if (result.code)
      throw new Error(`Session selector failed (exit ${result.code})`);
    const index = lines.indexOf(result.stdout.replace(/\r?\n$/, ""));
    if (index < 0)
      throw new Error("Session selector returned an unknown selection");
    selected = choices[index];
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
        `No ${kind} session recorded for ${data.id}. Use 'rl agent save ${kind}${kind === "claude" ? " <UUID>" : ""}'`,
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
