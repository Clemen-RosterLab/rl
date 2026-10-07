import fs from "node:fs";
import path from "node:path";
import { syncCodexSessions } from "./codex-sessions.js";
import {
  args,
  arity,
  canonical,
  execute,
  expandHome,
  git,
  gitRaw,
  inside,
  json,
  locked,
  message,
  object,
  pooled,
  readJson,
  required,
  writeJson,
} from "./common.js";
import {
  branchStatus,
  BranchStatus,
  Checkout,
  Instance,
  Store,
} from "./store.js";
export interface Repository {
  root: string;
  commonDir?: string;
  worktreeName: string;
  base: string;
}
interface NamedRepository extends Repository {
  name: string;
}
interface RegistryData {
  schemaVersion: 1;
  default: string | null;
  repositories: Record<string, Repository>;
}
interface Settings {
  stateDir: string;
  baseDir: string;
  legacyRoot: string;
  legacyName: string;
  legacyBase: string;
  selection: string;
}
const validName = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
export function worktrees(repo: string): Record<string, string>[] {
  return gitRaw(repo, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .map((block) =>
      Object.fromEntries(
        block
          .split("\0")
          .filter(Boolean)
          .map((part) => {
            const index = part.indexOf(" ");
            return index < 0
              ? [part, ""]
              : [part.slice(0, index), part.slice(index + 1)];
          }),
      ),
    )
    .filter((record) => "worktree" in record);
}
class Registry {
  readonly file: string;
  constructor(readonly settings: Settings) {
    this.file = path.join(settings.stateDir, "repositories.json");
  }
  read(): RegistryData {
    if (!fs.existsSync(this.file))
      return { schemaVersion: 1, default: null, repositories: {} };
    const data = readJson(this.file);
    try {
      if (data.schemaVersion !== 1 || !object(data.repositories))
        throw new Error();
      const roots = new Set(),
        directories = new Set();
      for (const [name, repo] of Object.entries(data.repositories)) {
        if (
          !validName(name) ||
          !object(repo) ||
          !validName(repo.worktreeName) ||
          typeof repo.root !== "string" ||
          !path.isAbsolute(repo.root) ||
          typeof repo.commonDir !== "string" ||
          !path.isAbsolute(repo.commonDir) ||
          typeof repo.base !== "string" ||
          !repo.base ||
          [repo.root, repo.commonDir, repo.base].some((value) =>
            /[\r\n]/.test(value),
          ) ||
          roots.has(repo.root) ||
          directories.has(repo.worktreeName)
        )
          throw new Error();
        roots.add(repo.root);
        directories.add(repo.worktreeName);
      }
      if (
        data.default !== null &&
        (typeof data.default !== "string" ||
          !Object.hasOwn(data.repositories, data.default))
      )
        throw new Error();
    } catch {
      throw new Error(`Invalid repository registry: ${this.file}`);
    }
    return data as unknown as RegistryData;
  }
  legacy(): NamedRepository {
    const s = this.settings;
    return {
      name: s.legacyName,
      root: canonical(s.legacyRoot),
      worktreeName: s.legacyName,
      base: s.legacyBase,
    };
  }
  resolve(data: RegistryData): NamedRepository {
    const repos = data.repositories,
      selection = this.settings.selection;
    if (selection) {
      if (!Object.hasOwn(repos, selection))
        throw new Error(`Unknown repository: ${selection}. Use 'rl repo list'`);
      return { name: selection, ...repos[selection] };
    }
    if (Object.keys(repos).length) {
      let common: string | null = null;
      try {
        common = canonical(
          git(
            process.cwd(),
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ),
        );
      } catch {
        /* Outside a checkout: use default. */
      }
      for (const [name, repo] of Object.entries(repos))
        if (repo.commonDir === common) return { name, ...repo };
      if (data.default) return { name: data.default, ...repos[data.default] };
    }
    return this.legacy();
  }
  async manage(rest: string[], values: Record<string, unknown>): Promise<void> {
    await locked(
      path.dirname(this.file),
      ".repositories.typescript.lock",
      () => {
        const data = this.read(),
          repos = data.repositories,
          [action, name, target] = rest;
        if (action === "list") {
          arity(rest, 1);
          if (values.json) json(data);
          else if (!Object.keys(repos).length)
            console.log(
              "No registered repositories; using legacy RL_REPO_ROOT configuration.",
            );
          else
            for (const name of Object.keys(repos).sort()) {
              const repo = repos[name];
              console.log(
                `${name === data.default ? "*" : " "} ${name}  ${repo.root}  base=${repo.base}  directory=${repo.worktreeName}`,
              );
            }
          return;
        }
        if (action === "add") {
          arity(rest, 3);
          if (!validName(name))
            throw new Error(
              "Repository names must contain letters, numbers, dots, underscores, or hyphens",
            );
          if (Object.hasOwn(repos, name))
            throw new Error(`Repository name already registered: ${name}`);
          const root = canonical(worktrees(expandHome(target))[0].worktree),
            common = canonical(
              git(
                root,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ),
            );
          if (Object.values(repos).some((repo) => repo.commonDir === common))
            throw new Error(
              "This Git repository is already registered under another name",
            );
          const isLegacy = root === this.legacy().root;
          const directory =
            values["worktree-name"] ??
            (isLegacy ? this.settings.legacyName : name);
          const base =
            values.base ??
            (isLegacy ? this.settings.legacyBase : defaultBase(root));
          if (
            !validName(directory) ||
            typeof base !== "string" ||
            !base ||
            /[\r\n]/.test(root + base)
          )
            throw new Error(
              "Invalid repository path, worktree directory name, or base",
            );
          if (
            Object.values(repos).some((repo) => repo.worktreeName === directory)
          )
            throw new Error(
              "Worktree directory name is already in use; choose --worktree-name",
            );
          Object.defineProperty(repos, name, {
            value: { root, commonDir: common, worktreeName: directory, base },
            enumerable: true,
            writable: true,
            configurable: true,
          });
          if (!data.default) data.default = name;
        } else {
          arity(rest, 2);
          if (action !== "use" && action !== "remove")
            throw new Error("Usage: rl repo add|list|use|remove");
          if (!Object.hasOwn(repos, name))
            throw new Error(`Unknown repository: ${name}`);
          if (action === "use") data.default = name;
          else {
            delete repos[name];
            if (data.default === name)
              data.default = Object.keys(repos)[0] ?? null;
          }
        }
        writeJson(this.file, data);
        console.log(`Repository ${action}: ${name}`);
      },
    );
  }
}
function defaultBase(root: string): string {
  try {
    return git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  } catch {
    const branch = git(root, "branch", "--show-current");
    if (!branch)
      throw new Error("Cannot infer default base; supply --base <branch>");
    return branch;
  }
}
interface Row extends Checkout {
  id: string;
  key: string | null;
  repository: string;
  pr: Instance["pr"];
  sessions?: Instance["sessions"];
  task?: Instance["task"];
  stateDirectory?: string;
  repositoryName: string;
  gitStatus: BranchStatus;
}
async function repositoryRows(
  repo: NamedRepository,
  settings: Settings,
  fetch: boolean,
  includeDeleted: boolean,
) {
  const store = new Store(repo.root, settings.stateDir),
    rows: Row[] = [],
    errors: string[] = [];
  if (fetch) {
    try {
      const result = await execute(
        ["git", "-C", repo.root, "fetch", "--all", "--prune"],
        repo.root,
      );
      if (result.code) errors.push(result.stderr.trim() || "Git fetch failed");
    } catch (error) {
      errors.push(message(error));
    }
  }
  try {
    await syncCodexSessions(store);
    const records = store.records(),
      activePaths = new Set(
        records
          .filter(([, data]) => data.status === "active")
          .map(([, data]) => data.worktree),
      );
    for (const [file, data] of records)
      if (data.status !== "deleted" || includeDeleted)
        rows.push({
          ...data,
          stateDirectory: path.dirname(file),
          repositoryName: repo.name,
          gitStatus: branchStatus(repo.root, data),
        });
    const base = canonical(path.join(settings.baseDir, repo.worktreeName));
    try {
      for (const item of worktrees(repo.root).slice(1)) {
        const root = canonical(item.worktree);
        if (!inside(root, base) || activePaths.has(root)) continue;
        const row = {
          id: path.relative(base, root),
          key: null,
          repository: repo.root,
          worktree: root,
          branch: (item.branch ?? "").replace(/^refs\/heads\//, ""),
          status: "unregistered",
          pr: null,
        };
        rows.push({
          ...row,
          repositoryName: repo.name,
          gitStatus: branchStatus(repo.root, row),
        });
      }
    } catch (error) {
      errors.push(message(error));
    }
    for (const row of rows)
      if (row.gitStatus.availability === "error")
        errors.push(`${row.id}: ${row.gitStatus.error}`);
  } catch (error) {
    errors.push(message(error));
  }
  return {
    rows,
    errors: errors.map((error) => ({ repository: repo.name, message: error })),
  };
}
function display(rows: Row[]): void {
  const table = [
    [
      "REPOSITORY",
      "INSTANCE",
      "BRANCH",
      "WORKTREE",
      "CHANGES",
      "UPSTREAM",
      "SYNC",
      "PR (cached)",
      "CODEX",
      "CLAUDE",
      "TASK",
    ],
  ];
  for (const row of rows) {
    const s = row.gitStatus;
    const changes =
      s.availability !== "ok"
        ? s.availability
        : !s.dirty
          ? "clean"
          : (
              [
                ["staged", "S"],
                ["unstaged", "M"],
                ["untracked", "?"],
                ["conflicts", "!"],
              ] as const
            )
              .filter(([key]) => s[key])
              .map(([key, letter]) => `${s[key]}${letter}`)
              .join("/");
    const sync = !s.upstream
      ? "no upstream"
      : s.ahead === null
        ? "unavailable"
        : `+${s.ahead}/-${s.behind}`;
    table.push([
      row.repositoryName,
      row.id,
      (s.branch || row.branch || "(detached)") +
        (s.branchChanged ? " [changed]" : ""),
      row.status,
      changes,
      s.upstream || "-",
      sync,
      row.pr ? `#${row.pr.number} ${row.pr.state}` : "-",
      String(row.sessions?.codex.length ?? 0),
      String(row.sessions?.claude.length ?? 0),
      row.task?.state ?? "-",
    ]);
  }
  const widths = table[0].map((_, col) =>
    Math.max(...table.map((row) => row[col].length)),
  );
  for (const row of table)
    console.log(
      row
        .map((value, col) => value.padEnd(widths[col]))
        .join("  ")
        .trimEnd(),
    );
  if (!rows.length) console.log("No RL instances found.");
}
export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [
      "state-dir",
      "base-dir",
      "legacy-root",
      "legacy-name",
      "legacy-base",
      "selection",
      "base",
      "worktree-name",
    ],
    ["all", "list", "json", "fetch", "include-deleted"],
  );
  const settings: Settings = {
    stateDir: required(values, "state-dir"),
    baseDir: required(values, "base-dir"),
    legacyRoot: required(values, "legacy-root"),
    legacyName: required(values, "legacy-name"),
    legacyBase: required(values, "legacy-base"),
    selection: String(values.selection ?? ""),
  };
  const registry = new Registry(settings),
    [command, ...rest] = positionals;
  if (command === "repo") {
    await registry.manage(rest, values);
    return 0;
  }
  const data = registry.read();
  arity(rest, 0);
  if (command === "resolve") {
    const repo = registry.resolve(data);
    console.log(
      [repo.root, repo.worktreeName, repo.base, repo.name].join("\n"),
    );
    return 0;
  }
  if (command !== "status" || !!values.all === !!values.list)
    throw new Error("Choose status --all or --list");
  if (values.all && settings.selection)
    throw new Error("Choose --repo <name> with status --list, or status --all");
  let repos = values.all
    ? Object.keys(data.repositories)
        .sort()
        .map((name) => ({ name, ...data.repositories[name] }))
    : [registry.resolve(data)];
  if (!repos.length) repos = [registry.legacy()];
  const results = await pooled(repos, 4, (repo) =>
    repositoryRows(repo, settings, !!values.fetch, !!values["include-deleted"]),
  );
  const rows = results
      .flatMap((result) => result.rows)
      .sort((a, b) =>
        [a.repositoryName, a.id, a.status]
          .join("\0")
          .localeCompare([b.repositoryName, b.id, b.status].join("\0")),
      ),
    errors = results.flatMap((result) => result.errors);
  if (values.json) json({ instances: rows, errors, fetched: !!values.fetch });
  else {
    display(rows);
    console.log(
      "S=staged M=unstaged ?=untracked !=conflicts; +ahead/-behind relative to upstream.",
    );
    console.log(
      "Remote refs: " +
        (values.fetch
          ? "fetch requested (see errors if any)."
          : "locally cached; use --fetch to refresh."),
    );
    for (const error of errors)
      console.error(`${error.repository}: ${error.message}`);
  }
  return errors.length ? 1 : 0;
}
