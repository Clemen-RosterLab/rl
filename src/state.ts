import { agentAdapter } from "./agent-registry.js";
import { activityView } from "./activity.js";
import { handleHook } from "./hooks.js";
import { doctor } from "./doctor.js";
import { currentSessionId } from "./session.js";
import { syncCodexSessions } from "./codex-sessions.js";
import { resumeAgent } from "./agent-resume.js";
import fs from "node:fs";
import path from "node:path";
import {
  args,
  arity,
  canonical,
  git,
  json,
  now,
  object,
  required,
  run,
} from "./common.js";
import { Agent, branchStatus, Store } from "./store.js";
function agent(value: string): Agent {
  return agentAdapter(value).name;
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
    ["quiet", "fetch", "json", "repair", "extended-hooks"],
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
      values["extended-hooks"] ? true : undefined,
    );
    if (!values.quiet)
      console.log(
        `RL instance: ${data.id}\nState: ${path.dirname(file)}\nSession hooks installed. In Codex, review and trust them with /hooks.`,
      );
    return 0;
  }
  if (command === "resume") {
    arity(rest, 1);
    return resumeAgent(store, agent(rest[0]));
  }
  if (command === "doctor") {
    arity(rest, 0, 1);
    if (values.repair) {
      const [, data] = store.current();
      await store.adopt(data.worktree);
    }
    return doctor(store, rest[0], !!values.json);
  }
  if (command === "hook") {
    arity(rest, 2);
    return handleHook(store, rest[0], rest[1]);
  }
  if (command === "pr" && rest[0] === "sync") {
    arity(rest, 1, 2);
    return syncPr(store, rest[1]);
  }
  if (command === "status" || command === "instances") arity(rest, 0);
  if (command === "session" && rest[0] === "list") {
    arity(rest, 1, 2);
    if (rest[1]) agent(rest[1]);
  }
  if (command === "status" && values.fetch)
    git(store.repo, "fetch", "--all", "--prune");
  if (
    command === "status" ||
    command === "instances" ||
    (command === "session" && rest[0] === "list")
  )
    await syncCodexSessions(
      store,
      command === "instances" ? undefined : process.cwd(),
    );
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
      store.archiveWorktrees([root]);
      return 0;
    }
    const [file, data] = store.current();
    if (command === "status") {
      arity(rest, 0);
      json({
        ...data,
        activity: {
          codex: activityView(data.activity?.codex),
          claude: activityView(data.activity?.claude),
        },
        stateDirectory: path.dirname(file),
        gitStatus: branchStatus(store.repo, data),
      });
    } else if (command === "session") {
      if (rest[0] === "save") {
        arity(rest, 1, 3);
        const kind = agent(rest[1] ?? "codex");
        const sid = currentSessionId(kind, rest[2]);
        store.recordSession(file, data, kind, sid);
        if (values.json)
          json({ agent: kind, sessionId: sid, instance: data.id });
        else console.log(`Saved ${kind} session ${sid} for ${data.id}`);
      } else if (rest[0] === "add") {
        arity(rest, 3);
        const kind = agent(rest[1]);
        store.recordSession(file, data, kind, rest[2]);
        console.log(`Associated ${kind} session ${rest[2]} with ${data.id}`);
      } else if (rest[0] === "list") {
        arity(rest, 1, 2);
        json(rest[1] ? data.sessions[agent(rest[1])] : data.sessions);
      } else
        throw new Error(
          "Usage: rl session list [agent] | save [agent] [UUID] | add <agent> <UUID>",
        );
    } else if (command === "context" || command === "progress") {
      const target = path.join(path.dirname(file), command + ".md"),
        action = rest[0];
      if (action === "path" || action === "show") {
        arity(rest, 1);
        if (action === "path") console.log(target);
        else process.stdout.write(store.readDocument(file, command));
      } else if (action === "set" || action === "append") {
        store.updateDocument(file, data, command, action, replacement);
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
