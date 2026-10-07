import { adapters } from "./agent-registry.js";
import { Agent } from "./agents.js";
import { Tracking, validateTracking } from "./activity.js";
import { lastAccessed } from "./access.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  atomicWrite,
  canonical,
  git,
  gitRaw,
  inside,
  isSymlink,
  locked,
  message,
  now,
  object,
  readJson,
  sessionId,
  shellQuote,
  timestamp,
  writeJson,
} from "./common.js";
import { NOTE_TEMPLATES } from "./templates.js";
import { handoffText, validateTask, type TaskState } from "./task-state.js";
const HOOK_TIMEOUT_SECONDS = 10;
const CODEX_END_TIMEOUT_SECONDS = 3;

export type { Agent } from "./agents.js";
export interface Session {
  id: string;
  createdAt: string;
  lastUsedAt: string;
}
export interface Instance extends Tracking {
  schemaVersion: 1;
  key: string;
  id: string;
  repository: string;
  branch: string;
  worktree: string;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  lastAccessedAt?: string;
  sessions: Record<Agent, Session[]>;
  pr: (Record<string, unknown> & { url: string }) | null;
  hookCommands?: Record<Agent, string>;
  extendedHooks?: boolean;
  task?: TaskState;
  [key: string]: unknown;
}
export interface Checkout {
  status: string;
  branch: string;
  worktree: string;
}
export interface BranchStatus {
  availability: string;
  branch: string | null;
  expectedBranch: string;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  dirty: boolean | null;
  branchChanged: boolean;
  error?: string;
}
export type RecordEntry = [string, Instance];
export function branchStatus(repo: string, data: Checkout): BranchStatus {
  const result: BranchStatus = {
    availability: data.status,
    branch: null,
    expectedBranch: data.branch,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    dirty: null,
    branchChanged: false,
  };
  if (data.status === "deleted") return result;
  if (!fs.existsSync(data.worktree))
    return { ...result, availability: "missing" };
  try {
    const root = canonical(data.worktree);
    if (
      canonical(git(root, "rev-parse", "--show-toplevel")) !== root ||
      canonical(
        git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      ) !==
        canonical(
          git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        )
    )
      throw new Error("Worktree path no longer belongs to this repository");
    const entries = gitRaw(
      root,
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
      "-z",
    ).split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.startsWith("# branch.head ")) result.branch = entry.slice(14);
      else if (entry.startsWith("# branch.oid ")) result.head = entry.slice(13);
      else if (entry.startsWith("# branch.upstream "))
        result.upstream = entry.slice(18);
      else if (entry.startsWith("# branch.ab ")) {
        const [ahead, behind] = entry.slice(12).split(" ");
        result.ahead = Number(ahead.slice(1));
        result.behind = Number(behind.slice(1));
      } else if (/^[12u] /.test(entry)) {
        const xy = entry.split(" ")[1];
        result.staged += Number(xy[0] !== ".");
        result.unstaged += Number(xy[1] !== ".");
        result.conflicts += Number(entry[0] === "u");
        if (entry[0] === "2") i++;
      } else if (entry.startsWith("? ")) result.untracked++;
    }
    result.dirty = !!(
      result.staged ||
      result.unstaged ||
      result.untracked ||
      result.conflicts
    );
    result.branchChanged = result.branch !== data.branch;
    result.availability = "ok";
  } catch (error) {
    result.availability = "error";
    result.error = message(error);
  }
  return result;
}
export class Store {
  readonly repo: string;
  readonly stateDir: string;
  readonly root: string;
  constructor(repo: string, stateDir: string) {
    this.repo = canonical(repo);
    this.stateDir = canonical(stateDir);
    this.root = path.join(
      this.stateDir,
      createHash("sha256").update(this.repo).digest("hex").slice(0, 24),
    );
  }
  archiveWorktrees(paths: readonly string[]): void {
    for (const [file, data] of this.records()) {
      if (data.status !== "active" || !paths.includes(data.worktree)) continue;
      data.status = "deleted";
      data.deletedAt = now();
      this.save(file, data);
    }
  }
  readDocument(file: string, kind: "context" | "progress"): string {
    return fs.readFileSync(path.join(path.dirname(file), kind + ".md"), "utf8");
  }
  updateDocument(
    file: string,
    data: Instance,
    kind: "context" | "progress",
    action: "set" | "append",
    text: string,
  ): void {
    const content =
      action === "append"
        ? this.readDocument(file, kind).trimEnd() +
          `\n\n### Update ${now()}\n\n` +
          text.trimEnd() +
          "\n"
        : text;
    atomicWrite(path.join(path.dirname(file), kind + ".md"), content);
    this.save(file, data);
  }
  locked<T>(action: () => T | Promise<T>): Promise<T> {
    return locked(this.root, ".typescript.lock", action);
  }
  records(): RecordEntry[] {
    if (!fs.existsSync(this.root)) return [];
    const records: RecordEntry[] = [];
    for (const key of fs.readdirSync(this.root).sort()) {
      const file = path.join(this.root, key, "instance.json");
      if (!fs.existsSync(file)) continue;
      const data = readJson(file);
      try {
        if (
          data.schemaVersion !== 1 ||
          data.key !== key ||
          data.repository !== this.repo ||
          !["active", "deleted"].includes(String(data.status)) ||
          typeof data.id !== "string" ||
          !data.id ||
          typeof data.branch !== "string" ||
          !data.branch ||
          typeof data.worktree !== "string" ||
          !path.isAbsolute(data.worktree) ||
          !(
            data.pr === null ||
            (object(data.pr) && typeof data.pr.url === "string")
          ) ||
          !object(data.sessions) ||
          (data.extendedHooks !== undefined &&
            typeof data.extendedHooks !== "boolean")
        )
          throw new Error();
        validateTracking(data);
        if (data.task !== undefined) validateTask(data.task);
        for (const agent of ["codex", "claude"]) {
          const sessions = data.sessions[agent];
          if (!Array.isArray(sessions)) throw new Error();
          const seen = new Set();
          for (const item of sessions) {
            if (
              !object(item) ||
              sessionId(item.id) !== item.id ||
              seen.has(item.id) ||
              typeof item.createdAt !== "string" ||
              typeof item.lastUsedAt !== "string"
            )
              throw new Error();
            seen.add(item.id);
            timestamp(item.createdAt);
            timestamp(item.lastUsedAt);
          }
        }
      } catch {
        throw new Error(`Invalid instance metadata: ${file}`);
      }
      records.push([file, data as unknown as Instance]);
    }
    return records;
  }
  worktree(cwd: string): [string, string] {
    const root = canonical(git(cwd, "rev-parse", "--show-toplevel"));
    if (
      canonical(
        git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      ) !==
      canonical(
        git(
          this.repo,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      )
    )
      throw new Error(
        "Current directory does not belong to the configured RL repository",
      );
    const branch = git(root, "branch", "--show-current");
    if (!branch) throw new Error("RL instances require a checked-out branch");
    return [root, branch];
  }
  current(cwd = process.cwd()): RecordEntry {
    return this.instanceForWorktree(...this.worktree(cwd));
  }
  // Call only with a worktree validated by worktree().
  instanceForWorktree(root: string, branch: string): RecordEntry {
    for (const [file, data] of this.records())
      if (data.status === "active" && data.worktree === root) {
        if (data.branch !== branch)
          throw new Error(
            `Instance owns branch ${data.branch}; current branch is ${branch}`,
          );
        return [file, data];
      }
    throw new Error("No RL instance for this worktree. Run 'rl adopt' first");
  }
  save(file: string, data: Instance): void {
    data.updatedAt = now();
    writeJson(file, data);
  }
  touch(file: string, data: Instance, stamp = now()): void {
    const previous = lastAccessed(data);
    data.lastAccessedAt =
      previous && timestamp(previous) > timestamp(stamp) ? previous : stamp;
    this.save(file, data);
  }
  async adopt(
    cwd: string,
    baseBranch?: string,
    extendedHooks?: boolean,
  ): Promise<RecordEntry> {
    const [root, branch] = this.worktree(cwd);
    if (this.stateDir === root || inside(this.stateDir, root))
      throw new Error(
        "RL_STATE_DIR must be outside the worktree so state survives deletion",
      );
    return this.locked(() => {
      for (const [file, data] of this.records())
        if (data.status === "active" && data.worktree === root) {
          if (data.branch !== branch)
            throw new Error(`This instance already owns branch ${data.branch}`);
          if (extendedHooks !== undefined) data.extendedHooks = extendedHooks;
          installHooks(this, file, data);
          this.touch(file, data);
          return [file, data];
        }
      const key = randomUUID(),
        stamp = now(),
        file = path.join(this.root, key, "instance.json");
      const data: Instance = {
        schemaVersion: 1,
        key,
        id: branch,
        repository: this.repo,
        branch,
        worktree: root,
        status: "active",
        createdAt: stamp,
        lastAccessedAt: stamp,
        updatedAt: stamp,
        sessions: { codex: [], claude: [] },
        pr: null,
      };
      if (extendedHooks !== undefined) data.extendedHooks = extendedHooks;
      if (baseBranch) data.baseBranch = baseBranch;
      // Discovery also covers worktrees without instance records. Carry their
      // snapshot into the newly adopted instance without another network lookup.
      try {
        const cache = readJson(path.join(this.root, "pr-cache.json"));
        const entries = cache.branches;
        const entry = object(entries) ? entries[branch] : undefined;
        const pr = object(entry) ? entry.pr : undefined;
        if (
          object(pr) &&
          pr.headRefName === branch &&
          typeof pr.url === "string"
        )
          data.pr = pr as Instance["pr"];
      } catch {
        /* Missing/disposable cache does not prevent adoption. */
      }
      writeJson(file, data);
      for (const [name, template] of Object.entries(NOTE_TEMPLATES))
        atomicWrite(path.join(path.dirname(file), name), template);
      installHooks(this, file, data);
      return [file, data];
    });
  }
  assertSessionOwner(file: string, agent: Agent, id: string): void {
    for (const [otherFile, other] of this.records())
      if (
        otherFile !== file &&
        (other.sessions[agent].some((s) => s.id === id) ||
          other.activity?.[agent]?.some((s) => s.sessionId === id))
      )
        throw new Error(
          `Session ${id} already belongs to RL instance ${other.id}`,
        );
  }
  recordSession(
    file: string,
    data: Instance,
    agent: Agent,
    id: string,
    stamp = now(),
  ): void {
    this.associateSession(file, data, agent, id, stamp);
    this.touch(file, data, stamp);
  }
  // Mutate the supplied record; callers persist session and activity together.
  associateSession(
    file: string,
    data: Instance,
    agent: Agent,
    id: string,
    stamp = now(),
  ): void {
    const sid = sessionId(id);
    this.assertSessionOwner(file, agent, sid);
    const item = data.sessions[agent].find((s) => s.id === sid);
    if (!item)
      data.sessions[agent].push({
        id: sid,
        createdAt: stamp,
        lastUsedAt: stamp,
      });
    else if (timestamp(stamp) > timestamp(item.lastUsedAt))
      item.lastUsedAt = stamp;
  }
}
export function hookCommand(
  store: Store,
  data: Instance,
  agent: Agent,
): string {
  return (
    [
      "rl",
      "__hook",
      "--repo",
      store.repo,
      "--state-dir",
      store.stateDir,
      "hook",
      data.key,
      agent,
    ]
      .map(shellQuote)
      .join(" ") + " # rl-session-hook"
  );
}
function installHooks(store: Store, file: string, data: Instance): void {
  const updates: [string, Record<string, unknown>][] = [];
  const commands = {} as Record<Agent, string>;
  for (const adapter of Object.values(adapters)) {
    const agent = adapter.name,
      relative = adapter.configPath;
    const target = path.join(data.worktree, relative);
    if (isSymlink(target) || isSymlink(path.dirname(target)))
      throw new Error(
        `Refusing to install workspace hooks through a symlink: ${target}`,
      );
    const config = fs.existsSync(target) ? readJson(target) : {};
    const hooks = (config.hooks ??= {});
    if (!object(hooks)) throw new Error(`Invalid hooks object in ${target}`);
    commands[agent] = hookCommand(store, data, agent);
    for (const event of Object.keys({
      ...adapter.events,
      ...(data.extendedHooks ? adapter.extraEvents : {}),
    })) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups))
        throw new Error(`Invalid ${event} hooks in ${target}`);
      const kept: Record<string, unknown>[] = [];
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks))
          throw new Error(`Invalid hook group in ${target}`);
        const handlers = group.hooks.filter(
          (h: unknown) =>
            !(
              object(h) &&
              typeof h.command === "string" &&
              (h.command === data.hookCommands?.[agent] ||
                h.command.endsWith(" # rl-session-hook"))
            ),
        );
        if (handlers.length) kept.push({ ...group, hooks: handlers });
      }
      kept.push({
        hooks: [
          {
            type: "command",
            command: commands[agent],
            timeout:
              event === "Interrupt" ||
              (agent === "codex" && event === "SessionEnd")
                ? CODEX_END_TIMEOUT_SECONDS
                : HOOK_TIMEOUT_SECONDS,
          },
        ],
      });
      hooks[event] = kept;
    }
    updates.push([target, config]);
  }
  for (const [target, config] of updates)
    if (
      !fs.existsSync(target) ||
      JSON.stringify(readJson(target)) !== JSON.stringify(config)
    )
      writeJson(target, config);
  const exclude = path.resolve(
    data.worktree,
    git(data.worktree, "rev-parse", "--git-path", "info/exclude"),
  );
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  const missing = ["/.codex/hooks.json", "/.claude/settings.local.json"].filter(
    (entry) => !text.split(/\r?\n/).includes(entry),
  );
  if (missing.length)
    atomicWrite(
      exclude,
      text +
        (text && !text.endsWith("\n") ? "\n" : "") +
        missing.join("\n") +
        "\n",
    );
  if (JSON.stringify(data.hookCommands) !== JSON.stringify(commands)) {
    data.hookCommands = commands;
    store.save(file, data);
  }
}
export function contextText(file: string, data: Instance): string {
  const sections = [
    `RL feature workspace: ${data.id}\nBranch: ${data.branch}`,
    "The following RL-owned documents are shared living feature documentation, not just conversation memory. Read them before starting work, and read the full files when excerpts are truncated. At meaningful milestones and before finishing your task, document what changed, what remains, implementation details (file/symbol references, flows, APIs, data structures), decisions and rationale, checks actually run, and blockers. Keep completed and planned work distinct; do not mark unverified work as tested or done. Respect your assigned scope and permissions; read-only agents should return proposed documentation updates to their parent. Use 'rl context append <file>' for durable domain or design notes and 'rl progress append <file>' for milestone/handoff updates ('-' reads stdin). Append is locked so concurrent agents do not overwrite one another. Use 'rl context set <file>' or 'rl progress set <file>' only for a deliberate replacement after reading the latest document and coordinating with other writers. Re-read the documents before planning subsequent work.",
  ];
  sections.push(
    "When the user asks to pause or save this task for later, save a task handoff with rl_task_pause through MCP, or 'rl pause --summary <text> --changes <text> --validation <text> --next <text> [--blockers <text>]'. Include the current session UUID (Codex shell commands can infer it), concrete changes, checks actually run and their results, remaining work, and blockers. Use 'Not run' for unperformed checks. A pause saves task state; it does not terminate the agent. The user can return with 'rl continue'.",
  );
  const latest = data.task?.handoffs.at(-1);
  if (latest)
    sections.push(
      `RL task state: ${data.task!.state}\n\n${handoffText(latest)}`,
    );
  for (const name of ["context.md", "progress.md"]) {
    const source = path.join(path.dirname(file), name),
      text = fs.readFileSync(source, "utf8");
    sections.push(`${name} (${source}):\n${text.slice(0, 12000)}`);
    if (text.length > 12000)
      sections.push("[Excerpt truncated; read the file for the full context.]");
  }
  sections.push("Cached GitHub PR state:\n" + JSON.stringify(data.pr));
  return sections.join("\n\n");
}
