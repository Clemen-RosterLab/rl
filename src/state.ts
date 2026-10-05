import fs from "node:fs";
import path from "node:path";
import {
  args,
  arity,
  atomicWrite,
  canonical,
  execute,
  git,
  json,
  now,
  object,
  required,
  run,
  sessionId,
  timestamp,
} from "./common.js";
import { Agent, branchStatus, contextText, Store } from "./store.js";
function agent(value: string): Agent {
  if (value !== "codex" && value !== "claude")
    throw new Error("Agent must be codex or claude");
  return value;
}
async function resume(store: Store, kind: Agent): Promise<number> {
  const [file, data, sid] = await store.locked(() => {
    const [file, data] = store.current(),
      sessions = data.sessions[kind];
    if (!sessions.length)
      throw new Error(
        `No ${kind} session recorded for ${data.id}. Start ${kind} here with RL hooks enabled, or use 'rl session add <agent> <UUID>'`,
      );
    const item = sessions.reduce((a, b) =>
      timestamp(a.lastUsedAt) >= timestamp(b.lastUsedAt) ? a : b,
    );
    return [file, data, sessionId(item.id)] as const;
  });
  const stamp = now();
  console.error(`Resuming ${kind} session ${sid} for ${data.id}`);
  const result = await execute(
    [kind, kind === "codex" ? "resume" : "--resume", sid],
    data.worktree,
    { interactive: true },
  );
  if (result.code === 0)
    await store.locked(() => {
      const [currentFile, current] = store.current(data.worktree);
      if (currentFile !== file)
        throw new Error("Instance changed while the agent was running");
      store.recordSession(file, current, kind, sid, stamp);
    });
  return result.code;
}
async function syncPr(store: Store, requested?: string): Promise<number> {
  const [file, data] = await store.locked(() => store.current());
  const selector = requested || data.pr?.url || data.branch;
  if (selector.startsWith("-"))
    throw new Error("PR selector must be a branch, number, or URL");
  const repository: unknown = JSON.parse(
    run(["gh", "repo", "view", "--json", "nameWithOwner,url"], data.worktree),
  );
  if (!object(repository) || typeof repository.url !== "string")
    throw new Error("GitHub returned invalid repository metadata");
  const repoUrl = repository.url.replace(/\/+$/, ""),
    parsed = new URL(repoUrl);
  if (
    parsed.protocol !== "https:" ||
    !parsed.host ||
    !parsed.pathname.replaceAll("/", "")
  )
    throw new Error("GitHub returned an invalid repository URL");
  const prefix = repoUrl + "/pull/";
  if (selector.includes("://") && !selector.startsWith(prefix))
    throw new Error("PR URL does not belong to this GitHub repository");
  const fields =
    "number,url,state,title,headRefName,baseRefName,isDraft,updatedAt";
  const pr: unknown = JSON.parse(
    run(
      [
        "gh",
        "pr",
        "view",
        selector,
        "--repo",
        parsed.host + parsed.pathname,
        "--json",
        fields,
      ],
      data.worktree,
    ),
  );
  if (!object(pr) || fields.split(",").some((field) => !(field in pr)))
    throw new Error("GitHub returned incomplete PR metadata");
  if (pr.headRefName !== data.branch)
    throw new Error("PR head branch does not match the RL instance branch");
  if (typeof pr.url !== "string" || !pr.url.startsWith(prefix))
    throw new Error("PR does not belong to this GitHub repository");
  pr.syncedAt = now();
  await store.locked(() => {
    const [currentFile, current] = store.current(data.worktree);
    if (currentFile !== file)
      throw new Error("Instance changed while fetching PR state");
    current.pr = pr as typeof current.pr;
    store.save(file, current);
  });
  json(pr);
  return 0;
}
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    ["repo", "state-dir", "worktree", "base"],
    ["quiet", "fetch", "json"],
  );
  const store = new Store(
    required(values, "repo"),
    required(values, "state-dir"),
  );
  const [command, ...rest] = positionals;
  if (command === "adopt") {
    arity(rest, 0);
    const [file, data] = await store.adopt(
      String(values.worktree ?? "."),
      typeof values.base === "string" ? values.base : undefined,
    );
    if (!values.quiet)
      console.log(
        `RL instance: ${data.id}\nState: ${path.dirname(file)}\nSession hooks installed. In Codex, review and trust them with /hooks.`,
      );
    return 0;
  }
  if (command === "resume") {
    arity(rest, 1);
    return resume(store, agent(rest[0]));
  }
  if (command === "hook") {
    arity(rest, 2);
    const kind = agent(rest[1]),
      payload: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!object(payload)) throw new Error("Hook input must be a JSON object");
    const event = payload.hook_event_name;
    if (
      !["SessionStart", "SubagentStart", "UserPromptSubmit"].includes(
        String(event),
      )
    )
      throw new Error("Unsupported session hook event");
    if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd))
      throw new Error("Hook requires an absolute cwd");
    const cwd = payload.cwd,
      sid = sessionId(payload.session_id);
    return store.locked(() => {
      const [file, data] = store.current(cwd);
      if (data.key !== rest[0])
        throw new Error(
          "Hook belongs to a different RL instance; run 'rl adopt' to repair it",
        );
      if (event !== "SubagentStart" && !payload.agent_id)
        store.recordSession(file, data, kind, sid);
      if (event !== "UserPromptSubmit")
        json({
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: contextText(file, data),
          },
        });
      return 0;
    });
  }
  if (command === "pr" && rest[0] === "sync") {
    arity(rest, 1, 2);
    return syncPr(store, rest[1]);
  }
  if (command === "status" && values.fetch)
    git(store.repo, "fetch", "--all", "--prune");
  let replacement = "";
  if (
    ["context", "progress"].includes(command) &&
    ["set", "append"].includes(rest[0])
  ) {
    arity(rest, 2);
    replacement = fs.readFileSync(rest[1] === "-" ? 0 : rest[1], "utf8");
  }
  return store.locked(() => {
    if (command === "instances") {
      arity(rest, 0);
      json(
        store.records().map(([, data]) => ({
          ...data,
          gitStatus: branchStatus(store.repo, data),
        })),
      );
      return 0;
    }
    if (command === "archive") {
      arity(rest, 0);
      const root = canonical(required(values, "worktree"));
      for (const [file, data] of store.records())
        if (data.status === "active" && data.worktree === root) {
          data.status = "deleted";
          data.deletedAt = now();
          store.save(file, data);
        }
      return 0;
    }
    const [file, data] = store.current();
    if (command === "status") {
      arity(rest, 0);
      json({
        ...data,
        stateDirectory: path.dirname(file),
        gitStatus: branchStatus(store.repo, data),
      });
    } else if (command === "session") {
      if (rest[0] === "add") {
        arity(rest, 3);
        const kind = agent(rest[1]);
        store.recordSession(file, data, kind, rest[2]);
        console.log(`Associated ${kind} session ${rest[2]} with ${data.id}`);
      } else if (rest[0] === "list") {
        arity(rest, 1, 2);
        json(rest[1] ? data.sessions[agent(rest[1])] : data.sessions);
      } else
        throw new Error("Usage: rl session list [agent] | add <agent> <UUID>");
    } else if (command === "context" || command === "progress") {
      const target = path.join(path.dirname(file), command + ".md"),
        action = rest[0];
      if (action === "path" || action === "show") {
        arity(rest, 1);
        if (action === "path") console.log(target);
        else process.stdout.write(fs.readFileSync(target, "utf8"));
      } else if (action === "set" || action === "append") {
        if (action === "append")
          replacement =
            fs.readFileSync(target, "utf8").trimEnd() +
            `\n\n### Update ${now()}\n\n` +
            replacement.trimEnd() +
            "\n";
        atomicWrite(target, replacement);
        store.save(file, data);
      } else
        throw new Error(
          `Usage: rl ${command} show|path|set <file>|append <file>`,
        );
    } else if (command === "pr" && rest[0] === "show") {
      arity(rest, 1);
      json(data.pr);
    } else throw new Error("Unknown state command");
    return 0;
  });
}
