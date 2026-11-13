import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lastAccessed } from "./access.js";
import type { Tracking } from "./activity.js";
import { buildWorkspaceContextText } from "./agents/context-builder.js";
import {
  buildHookCommand,
  installWorkspaceHooks,
} from "./agents/hook-installer.js";
import type { Agent } from "./agents.js";
import {
  atomicWrite,
  canonical,
  execute,
  git,
  gitRaw,
  inside,
  locked,
  message,
  now,
  object,
  readJson,
  sessionId,
  timestamp,
  writeJson,
} from "./common.js";
import { StateValidationError } from "./errors.js";
import { gitCommonDir } from "./git/base.js";
import { InstanceDiskSchema } from "./schemas/instance.js";
import type { TaskState } from "./task-state.js";
import { NOTE_TEMPLATES } from "./templates.js";

export type { Agent } from "./agents.js";

export interface Session {
  id: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface PullRequestSnapshot extends Record<string, unknown> {
  url: string;
}

export interface Instance extends Tracking {
  schemaVersion: 1;
  key: string;
  id: string;
  repository: string;
  branch: string;
  baseBranch?: string;
  startingCommit?: string;
  reviewBaseCommit?: string;
  worktree: string;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  lastAccessedAt?: string;
  sessions: {
    codex: Session[];
    claude: Session[];
    agy?: Session[];
  };
  pr: PullRequestSnapshot | null;
  hookCommands?: Partial<Record<Agent, string>>;
  extendedHooks?: boolean;
  task?: TaskState;
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

function parsePorcelainV2Status(
  porcelainOutput: string,
  expectedBranch: string,
): BranchStatus {
  const result: BranchStatus = {
    availability: "ok",
    branch: null,
    expectedBranch,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    dirty: false,
    branchChanged: false,
  };

  const entries = porcelainOutput.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith("# branch.head ")) {
      result.branch = entry.slice("# branch.head ".length);
    } else if (entry.startsWith("# branch.oid ")) {
      result.head = entry.slice("# branch.oid ".length);
    } else if (entry.startsWith("# branch.upstream ")) {
      result.upstream = entry.slice("# branch.upstream ".length);
    } else if (entry.startsWith("# branch.ab ")) {
      const [ahead, behind] = entry.slice("# branch.ab ".length).split(" ");
      result.ahead = Number(ahead.slice(1));
      result.behind = Number(behind.slice(1));
    } else if (/^[12u] /.test(entry)) {
      const xy = entry.split(" ")[1];
      result.staged += Number(xy[0] !== ".");
      result.unstaged += Number(xy[1] !== ".");
      result.conflicts += Number(entry[0] === "u");
      if (entry[0] === "2") {
        // Skip the trailing original-path NUL field on renames/copies.
        i++;
      }
    } else if (entry.startsWith("? ")) {
      result.untracked++;
    }
  }

  result.dirty = Boolean(
    result.staged || result.unstaged || result.untracked || result.conflicts,
  );
  result.branchChanged = result.branch !== expectedBranch;
  return result;
}

function emptyBranchStatus(data: Checkout): BranchStatus {
  return {
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
}

export function branchStatus(
  repo: string,
  data: Checkout,
  cachedRepoCommonDir?: string,
): BranchStatus {
  const empty = emptyBranchStatus(data);
  if (data.status === "deleted") {
    return empty;
  }
  if (!fs.existsSync(data.worktree)) {
    return { ...empty, availability: "missing" };
  }

  try {
    const root = canonical(data.worktree);
    const expectedCommonDir = cachedRepoCommonDir ?? gitCommonDir(repo);
    if (
      canonical(git(root, "rev-parse", "--show-toplevel")) !== root ||
      gitCommonDir(root) !== expectedCommonDir
    ) {
      throw new Error("Worktree path no longer belongs to this repository");
    }

    const porcelain = gitRaw(
      root,
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
      "-z",
    );
    return parsePorcelainV2Status(porcelain, data.branch);
  } catch (error) {
    return {
      ...empty,
      availability: "error",
      error: message(error),
    };
  }
}

export async function branchStatusAsync(
  repo: string,
  data: Checkout,
  cachedRepoCommonDir?: string,
): Promise<BranchStatus> {
  const empty = emptyBranchStatus(data);
  if (data.status === "deleted") {
    return empty;
  }
  if (!fs.existsSync(data.worktree)) {
    return { ...empty, availability: "missing" };
  }

  try {
    const root = canonical(data.worktree);
    const [topLevelRes, commonDirRes, repoCommonDir] = await Promise.all([
      execute(["git", "-C", root, "rev-parse", "--show-toplevel"], root),
      execute(
        [
          "git",
          "-C",
          root,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        root,
      ),
      cachedRepoCommonDir
        ? Promise.resolve(cachedRepoCommonDir)
        : execute(
            [
              "git",
              "-C",
              repo,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ],
            repo,
          ).then((res) => {
            if (res.code !== 0) {
              throw new Error(res.stderr.trim() || "Cannot inspect repository");
            }
            return canonical(res.stdout.trim());
          }),
    ]);

    if (
      topLevelRes.code !== 0 ||
      commonDirRes.code !== 0 ||
      canonical(topLevelRes.stdout.trim()) !== root ||
      canonical(commonDirRes.stdout.trim()) !== repoCommonDir
    ) {
      throw new Error("Worktree path no longer belongs to this repository");
    }

    const statusRes = await execute(
      [
        "git",
        "-C",
        root,
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=normal",
        "-z",
      ],
      root,
    );
    if (statusRes.code !== 0) {
      throw new Error(statusRes.stderr.trim() || "Git status failed");
    }

    return parsePorcelainV2Status(statusRes.stdout, data.branch);
  } catch (error) {
    return {
      ...empty,
      availability: "error",
      error: message(error),
    };
  }
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
      if (data.status !== "active" || !paths.includes(data.worktree)) {
        continue;
      }
      data.status = "deleted";
      data.deletedAt = now();
      this.save(file, data);
    }
  }

  readDocument(file: string, kind: "context" | "progress"): string {
    return fs.readFileSync(path.join(path.dirname(file), `${kind}.md`), "utf8");
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
        ? `${this.readDocument(file, kind).trimEnd()}\n\n### Update ${now()}\n\n${text.trimEnd()}\n`
        : text;
    atomicWrite(path.join(path.dirname(file), `${kind}.md`), content);
    this.save(file, data);
  }

  locked<T>(action: () => T | Promise<T>): Promise<T> {
    return locked(this.root, ".typescript.lock", action);
  }

  records(): RecordEntry[] {
    if (!fs.existsSync(this.root)) {
      return [];
    }
    const entries: RecordEntry[] = [];
    for (const key of fs.readdirSync(this.root).toSorted()) {
      const file = path.join(this.root, key, "instance.json");
      if (!fs.existsSync(file)) {
        continue;
      }
      const raw = readJson(file);
      const parsed = InstanceDiskSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.key !== key ||
        parsed.data.repository !== this.repo
      ) {
        throw new StateValidationError(`Invalid instance metadata: ${file}`);
      }
      entries.push([file, parsed.data as Instance]);
    }
    return entries;
  }

  worktree(cwd: string): [string, string] {
    const root = canonical(git(cwd, "rev-parse", "--show-toplevel"));
    if (gitCommonDir(root) !== gitCommonDir(this.repo)) {
      throw new Error(
        "Current directory does not belong to the configured RL repository",
      );
    }
    const branch = git(root, "branch", "--show-current");
    if (!branch) {
      throw new Error("RL instances require a checked-out branch");
    }
    return [root, branch];
  }

  current(cwd = process.cwd()): RecordEntry {
    return this.instanceForWorktree(...this.worktree(cwd));
  }

  /** Call only with a worktree validated by `worktree()`. */
  instanceForWorktree(root: string, branch: string): RecordEntry {
    for (const [file, data] of this.records()) {
      if (data.status === "active" && data.worktree === root) {
        if (data.branch !== branch) {
          throw new Error(
            `Instance owns branch ${data.branch}; current branch is ${branch}`,
          );
        }
        return [file, data];
      }
    }
    throw new Error(
      "No RL instance for this worktree. Run 'rl setup adopt' first",
    );
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
    creation?: { startingCommit: string; reviewBaseCommit?: string },
  ): Promise<RecordEntry> {
    const [root, branch] = this.worktree(cwd);
    if (this.stateDir === root || inside(this.stateDir, root)) {
      throw new Error(
        "RL_STATE_DIR must be outside the worktree so state survives deletion",
      );
    }

    return this.locked(() => {
      for (const [file, data] of this.records()) {
        if (data.status === "active" && data.worktree === root) {
          if (data.branch !== branch) {
            throw new Error(`This instance already owns branch ${data.branch}`);
          }
          if (extendedHooks !== undefined) {
            data.extendedHooks = extendedHooks;
          }
          installWorkspaceHooks(this, file, data);
          this.touch(file, data);
          return [file, data];
        }
      }

      const key = randomUUID();
      const stamp = now();
      const file = path.join(this.root, key, "instance.json");
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

      if (extendedHooks !== undefined) {
        data.extendedHooks = extendedHooks;
      }
      if (baseBranch) {
        data.baseBranch = baseBranch;
      }
      if (creation) {
        data.startingCommit = creation.startingCommit;
        if (creation.reviewBaseCommit) {
          data.reviewBaseCommit = creation.reviewBaseCommit;
          git(
            root,
            "update-ref",
            `refs/rl/review-baselines/${key}`,
            creation.reviewBaseCommit,
          );
        }
      }

      // Carry cached PR metadata discovered prior to adoption without another network lookup.
      try {
        const cache = readJson(path.join(this.root, "pr-cache.json"));
        const entries = cache.branches;
        const entry = object(entries) ? entries[branch] : undefined;
        const pr = object(entry) ? entry.pr : undefined;
        if (
          object(pr) &&
          pr.headRefName === branch &&
          typeof pr.url === "string"
        ) {
          data.pr = pr as PullRequestSnapshot;
        }
      } catch {
        // Missing or disposable cache does not block adoption.
      }

      writeJson(file, data);
      for (const [name, template] of Object.entries(NOTE_TEMPLATES)) {
        atomicWrite(path.join(path.dirname(file), name), template);
      }
      installWorkspaceHooks(this, file, data);
      return [file, data];
    });
  }

  assertSessionOwner(file: string, agent: Agent, id: string): void {
    for (const [otherFile, other] of this.records()) {
      if (
        otherFile !== file &&
        (other.sessions[agent]?.some((s) => s.id === id) ||
          other.activity?.[agent]?.some((s) => s.sessionId === id))
      ) {
        throw new Error(
          `Session ${id} already belongs to RL instance ${other.id}`,
        );
      }
    }
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

  /** Mutate the supplied record; callers persist session and activity together. */
  associateSession(
    file: string,
    data: Instance,
    agent: Agent,
    id: string,
    stamp = now(),
  ): void {
    const sid = sessionId(id);
    this.assertSessionOwner(file, agent, sid);
    const sessions = (data.sessions[agent] ??= []);
    const existing = sessions.find((s) => s.id === sid);
    if (!existing) {
      sessions.push({
        id: sid,
        createdAt: stamp,
        lastUsedAt: stamp,
      });
    } else if (timestamp(stamp) > timestamp(existing.lastUsedAt)) {
      existing.lastUsedAt = stamp;
    }
  }
}

export function hookCommand(
  store: Store,
  data: Instance,
  agent: Agent,
  event?: string,
): string {
  return buildHookCommand(store, data, agent, event);
}

export function contextText(file: string, data: Instance): string {
  return buildWorkspaceContextText(file, data);
}
