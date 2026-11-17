import fs from "node:fs";
import path from "node:path";
import { writeWorkspaceOutput } from "./command-context.js";
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
  pooled,
  readJson,
  required,
  writeJson,
} from "./common.js";
import { StateValidationError, UsageError } from "./errors.js";
import { gitCommonDir } from "./git/base.js";
import { RegistryDataSchema } from "./schemas/instance.js";
import {
  type BranchStatus,
  branchStatusAsync,
  type Checkout,
  type Instance,
  Store,
} from "./store.js";
import {
  formatHomePath,
  padCell,
  paintAnsi,
  sanitizeTerminalText,
} from "./tui/ansi.js";
import { runFzf } from "./tui/fzf.js";
import { formatOverviewTable } from "./overview-table.js";

export interface Repository {
  root: string;
  commonDir?: string;
  worktreeName: string;
  base: string;
}

export interface NamedRepository extends Repository {
  name: string;
}

interface RegistryData {
  schemaVersion: 1;
  default: string | null;
  repositories: Record<string, Repository>;
}

export interface Settings {
  stateDir: string;
  baseDir: string;
  legacyRoot: string;
  legacyName: string;
  legacyBase: string;
  selection: string;
}

export interface WorktreeRecord {
  worktree: string;
  branch?: string;
  HEAD?: string;
  locked?: string;
  [key: string]: string | undefined;
}

const isValidRepoAlias = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

export function worktrees(repo: string): WorktreeRecord[] {
  return gitRaw(repo, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .map((block): Record<string, string | undefined> =>
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
    .filter(
      (record): record is WorktreeRecord =>
        typeof record.worktree === "string" && record.worktree.length > 0,
    );
}

function inferRepositoryName(root: string): string {
  let source: string;
  try {
    source = git(root, "remote", "get-url", "origin");
  } catch {
    return path.basename(root);
  }
  return repositorySourceName(source);
}

function isRemoteSource(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/\s:]+:.+/.test(source);
}

function repositorySourceName(source: string): string {
  if (source.includes("://")) {
    try {
      source = new URL(source).pathname;
    } catch {
      // Git also accepts local file paths.
    }
  }
  return source
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, "");
}

function inferDefaultBase(root: string): string {
  try {
    return git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  } catch {
    const branch = git(root, "branch", "--show-current");
    if (!branch) {
      throw new Error("Cannot infer default base; supply --base <branch>");
    }
    return branch;
  }
}

class Registry {
  readonly file: string;

  constructor(readonly settings: Settings) {
    this.file = path.join(settings.stateDir, "repositories.json");
  }

  read(): RegistryData {
    if (!fs.existsSync(this.file)) {
      return { schemaVersion: 1, default: null, repositories: {} };
    }
    const raw = readJson(this.file);
    const parsed = RegistryDataSchema.safeParse(raw);
    if (!parsed.success) {
      throw new StateValidationError(
        `Invalid repository registry: ${this.file}`,
      );
    }
    return parsed.data;
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
    const repos = data.repositories;
    const selection = this.settings.selection;

    if (selection) {
      if (!Object.hasOwn(repos, selection)) {
        throw new Error(`Unknown repository: ${selection}. Use 'rl repo list'`);
      }
      return { name: selection, ...repos[selection] };
    }

    if (Object.keys(repos).length > 0) {
      let currentCommon: string | null = null;
      try {
        currentCommon = gitCommonDir(process.cwd());
      } catch {
        // Outside a Git checkout: fall back to default registration.
      }
      for (const [name, repo] of Object.entries(repos)) {
        if (repo.commonDir === currentCommon) {
          return { name, ...repo };
        }
      }
      if (data.default) {
        return { name: data.default, ...repos[data.default] };
      }
    }

    return this.legacy();
  }

  async checkout(name?: string, output?: string): Promise<void> {
    const data = this.read();
    const repos = Object.entries(data.repositories)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repoName, repo]) => ({ name: repoName, ...repo }));

    if (repos.length === 0) {
      throw new Error(
        "No registered repositories. Run 'rl repo add .' inside a repository first.",
      );
    }

    let selected = name
      ? repos.find((repo) => repo.name === name)
      : repos.length === 1
        ? repos[0]
        : undefined;

    if (name && !selected) {
      throw new Error(`Unknown repository: ${name}. Use 'rl repo list'`);
    }

    if (!selected) {
      const nameWidth = Math.min(
        32,
        Math.max(12, ...repos.map((repo) => repo.name.length)),
      );
      const baseWidth = Math.min(
        24,
        Math.max(
          4,
          ...repos.map((repo) => sanitizeTerminalText(repo.base).length),
        ),
      );
      const pathWidth = Math.max(
        12,
        (process.stderr.columns || 110) - nameWidth - baseWidth - 10,
      );
      const dim = (val: string) =>
        paintAnsi(val, 90, process.env.NO_COLOR === undefined);

      const fzfRows = repos.map((repo) => ({
        id: repo.name,
        line: `${padCell(repo.name, nameWidth)}  ${dim(padCell(repo.base, baseWidth))}  ${dim(padCell(formatHomePath(repo.root), pathWidth))}`,
        value: repo,
      }));

      const picked = await runFzf(fzfRows, {
        cwd: process.cwd(),
        prompt: "Repository › ",
        header: `Enter open · Esc cancel\n\n${padCell("REPOSITORY", nameWidth)}  ${padCell("BASE", baseWidth)}  PATH`,
        ansi: true,
        numericHeight: true,
        errorLabel: "Repository picker",
        unknownNoun: "repository",
      });

      if (!picked) {
        return;
      }
      selected = picked.items[0];
    }

    const current = this.read().repositories[selected.name];
    if (
      !current ||
      JSON.stringify(current) !==
        JSON.stringify(data.repositories[selected.name])
    ) {
      throw new Error(
        "Repository registration changed during selection; retry the command",
      );
    }

    if (
      canonical(git(selected.root, "rev-parse", "--show-toplevel")) !==
        selected.root ||
      gitCommonDir(selected.root) !== selected.commonDir
    ) {
      throw new Error(
        "Repository checkout no longer matches its registration; register it again",
      );
    }

    writeWorkspaceOutput(selected.root, output);
  }

  async clone(rest: string[], values: Record<string, unknown>): Promise<void> {
    arity(rest, 2, 3);
    const source = rest[1];
    if (!source || source.startsWith("-") || /[\x00-\x1f\x7f]/.test(source)) {
      throw new UsageError("Expected a Git URL or local repository path");
    }
    const name = String(values.alias ?? repositorySourceName(source));
    const directoryName = values["worktree-name"] ?? name;
    if (!isValidRepoAlias(name) || !isValidRepoAlias(directoryName)) {
      throw new UsageError("Invalid repository name; supply --alias <name>");
    }
    if (
      values.base !== undefined &&
      (typeof values.base !== "string" ||
        !values.base ||
        /[\r\n]/.test(values.base))
    ) {
      throw new UsageError("Invalid repository base");
    }
    const repos = this.read().repositories;
    if (Object.hasOwn(repos, name)) {
      throw new Error(
        `Repository name already registered: ${name}; choose --alias <name>`,
      );
    }
    if (
      Object.values(repos).some((repo) => repo.worktreeName === directoryName)
    ) {
      throw new Error(
        "Worktree directory name is already in use; choose --worktree-name",
      );
    }

    const destination = path.resolve(expandHome(rest[2] ?? name));
    if (/[\x00-\x1f\x7f]/.test(destination)) {
      throw new UsageError("Invalid clone destination");
    }
    // Reserve a new directory exclusively, including rejecting dangling symlinks.
    // Never delete a failed clone: another process may have written into it.
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.mkdirSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Clone destination already exists: ${destination}. Use 'rl repo add <path>' to register an existing checkout.`,
          { cause: error },
        );
      }
      throw error;
    }
    const result = await execute(
      [
        "git",
        "clone",
        "--origin",
        "origin",
        "--",
        expandHome(source),
        destination,
      ],
      process.cwd(),
      { interactive: true },
    );
    if (result.code !== 0) {
      throw new Error(
        `Git clone failed; repository was not registered. Inspect ${destination} before retrying.`,
      );
    }
    try {
      // Registration takes its usual lock and rechecks collisions after the clone.
      await this.manage(["add", destination], { ...values, alias: name });
    } catch (error) {
      throw new Error(
        `Cloned to ${destination}, but registration failed: ${message(error)}. The checkout has been kept; register it with 'rl repo add <path>'.`,
        { cause: error },
      );
    }
    writeWorkspaceOutput(
      canonical(destination),
      values["output-path"] as string | undefined,
    );
  }

  async manage(rest: string[], values: Record<string, unknown>): Promise<void> {
    await locked(
      path.dirname(this.file),
      ".repositories.typescript.lock",
      () => {
        const data = this.read();
        const repos = data.repositories;
        const [action] = rest;
        let aliasName = rest[1];

        if (action === "list") {
          arity(rest, 1);
          if (values.json) {
            json(data);
          } else if (Object.keys(repos).length === 0) {
            console.log(
              "No registered repositories; using legacy RL_REPO_ROOT configuration.",
            );
          } else {
            for (const key of Object.keys(repos).sort()) {
              const repo = repos[key];
              const marker = key === data.default ? "*" : " ";
              console.log(
                `${marker} ${key}  ${repo.root}  base=${repo.base}  directory=${repo.worktreeName}`,
              );
            }
          }
          return;
        }

        if (action === "add") {
          arity(rest, 1, 3);
          if (rest.length === 3 && values.alias !== undefined) {
            throw new UsageError(
              "Choose either --alias <name> or the legacy <alias> <path> form",
            );
          }

          const target = rest.length === 3 ? rest[2] : (rest[1] ?? ".");
          const directoryPath = path.resolve(expandHome(target));
          if (
            !fs.existsSync(directoryPath) ||
            !fs.statSync(directoryPath).isDirectory()
          ) {
            throw new Error(
              `Repository directory does not exist: ${directoryPath}. Use 'rl repo add .' for the current repository, with --alias <name> to name it.`,
            );
          }

          const root = canonical(worktrees(directoryPath)[0].worktree);
          aliasName = String(
            values.alias ??
              (rest.length === 3 ? aliasName : inferRepositoryName(root)),
          );
          if (!isValidRepoAlias(aliasName)) {
            throw new UsageError(
              "Repository names must contain letters, numbers, dots, underscores, or hyphens; supply --alias <name>",
            );
          }
          if (Object.hasOwn(repos, aliasName)) {
            throw new Error(
              `Repository name already registered: ${aliasName}; choose --alias <name>`,
            );
          }

          const common = gitCommonDir(root);
          if (Object.values(repos).some((repo) => repo.commonDir === common)) {
            throw new Error(
              "This Git repository is already registered under another name",
            );
          }

          const isLegacy = root === this.legacy().root;
          const worktreeDirectory =
            values["worktree-name"] ??
            (isLegacy ? this.settings.legacyName : aliasName);
          const base =
            values.base ??
            (isLegacy ? this.settings.legacyBase : inferDefaultBase(root));

          if (
            !isValidRepoAlias(worktreeDirectory) ||
            typeof base !== "string" ||
            !base ||
            /[\r\n]/.test(root + base)
          ) {
            throw new UsageError(
              "Invalid repository path, worktree directory name, or base",
            );
          }
          if (
            Object.values(repos).some(
              (repo) => repo.worktreeName === worktreeDirectory,
            )
          ) {
            throw new Error(
              "Worktree directory name is already in use; choose --worktree-name",
            );
          }

          Object.defineProperty(repos, aliasName, {
            value: {
              root,
              commonDir: common,
              worktreeName: worktreeDirectory,
              base,
            },
            enumerable: true,
            writable: true,
            configurable: true,
          });
          if (!data.default) {
            data.default = aliasName;
          }
        } else {
          arity(rest, 2);
          if (action !== "use" && action !== "remove") {
            throw new UsageError("Usage: rl repo add|list|use|remove");
          }
          if (!Object.hasOwn(repos, aliasName)) {
            throw new Error(`Unknown repository: ${aliasName}`);
          }
          if (action === "use") {
            data.default = aliasName;
          } else {
            delete repos[aliasName];
            if (data.default === aliasName) {
              data.default = Object.keys(repos)[0] ?? null;
            }
          }
        }

        writeJson(this.file, data);
        console.log(`Repository ${action}: ${aliasName}`);
      },
    );
  }
}

export interface OverviewRow extends Checkout {
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
  includeExisting = false,
) {
  const store = new Store(repo.root, settings.stateDir);
  const rows: OverviewRow[] = [];
  const errors: string[] = [];

  if (fetch) {
    try {
      const result = await execute(
        ["git", "-C", repo.root, "fetch", "--all", "--prune"],
        repo.root,
      );
      if (result.code !== 0) {
        errors.push(result.stderr.trim() || "Git fetch failed");
      }
    } catch (error) {
      errors.push(message(error));
    }
  }

  try {
    await syncCodexSessions(store);
    const records = store.records();
    const activePaths = new Set(
      records
        .filter(([, data]) => data.status === "active")
        .map(([, data]) => data.worktree),
    );

    let cachedCommonDir: string | undefined;
    try {
      cachedCommonDir = gitCommonDir(repo.root);
    } catch {
      // Missing or broken repository root will be reported per worktree below.
    }

    const pendingTargets: Array<
      | { kind: "instance"; file: string; data: Instance }
      | {
          kind: "unregistered";
          row: Omit<OverviewRow, "repositoryName" | "gitStatus">;
        }
    > = [];

    for (const [file, data] of records) {
      if (data.status !== "deleted" || includeDeleted) {
        pendingTargets.push({ kind: "instance", file, data });
      }
    }

    const managedBase = canonical(
      path.join(settings.baseDir, repo.worktreeName),
    );
    try {
      for (const item of worktrees(repo.root).slice(1)) {
        const root = canonical(item.worktree);
        if (
          (!includeExisting && !inside(root, managedBase)) ||
          activePaths.has(root)
        ) {
          continue;
        }
        pendingTargets.push({
          kind: "unregistered",
          row: {
            id: inside(root, managedBase)
              ? path.relative(managedBase, root)
              : (item.branch ?? "").replace(/^refs\/heads\//, "") ||
                path.basename(root),
            key: null,
            repository: repo.root,
            worktree: root,
            branch: (item.branch ?? "").replace(/^refs\/heads\//, ""),
            status: "unregistered",
            pr: null,
          },
        });
      }
    } catch (error) {
      errors.push(message(error));
    }

    const evaluated = await pooled(pendingTargets, 8, async (target) => {
      if (target.kind === "instance") {
        const gitStatus = await branchStatusAsync(
          repo.root,
          target.data,
          cachedCommonDir,
        );
        return {
          ...target.data,
          stateDirectory: path.dirname(target.file),
          repositoryName: repo.name,
          gitStatus,
        };
      }
      const gitStatus = await branchStatusAsync(
        repo.root,
        target.row,
        cachedCommonDir,
      );
      return {
        ...target.row,
        repositoryName: repo.name,
        gitStatus,
      };
    });

    rows.push(...evaluated);
    for (const row of rows) {
      if (row.gitStatus.availability === "error") {
        errors.push(`${row.id}: ${row.gitStatus.error}`);
      }
    }
  } catch (error) {
    errors.push(message(error));
  }

  return {
    rows,
    errors: errors.map((err) => ({ repository: repo.name, message: err })),
  };
}

export function renderOverviewTable(
  rows: OverviewRow[],
  fetched = false,
): void {
  console.log(formatOverviewTable(rows, { fetched }));
}

async function repositoryStatus(
  registry: Registry,
  data: RegistryData,
  fetch: boolean,
  asJson: boolean,
): Promise<number> {
  const repo = registry.resolve(data);
  const result = await repositoryRows(repo, registry.settings, fetch, false);

  let currentWorkspace: { path: string; branch: string; main: boolean } | null =
    null;
  try {
    if (gitCommonDir(process.cwd()) === gitCommonDir(repo.root)) {
      const root = canonical(
        git(process.cwd(), "rev-parse", "--show-toplevel"),
      );
      currentWorkspace = {
        path: root,
        branch: git(root, "branch", "--show-current") || "(detached)",
        main: root === repo.root,
      };
    }
  } catch {
    // Outside the selected repository.
  }

  const rows = result.rows.filter((row) => row.worktree !== repo.root);
  let selectionMode = "default";
  if (registry.settings.selection) {
    selectionMode = "explicit";
  } else if (currentWorkspace) {
    selectionMode = "current checkout";
  }

  const status = {
    repository: {
      name: repo.name,
      root: repo.root,
      base: repo.base,
      worktreeDirectory: path.join(
        registry.settings.baseDir,
        repo.worktreeName,
      ),
      registered: Object.hasOwn(data.repositories, repo.name),
    },
    selection: selectionMode,
    defaultRepository: data.default,
    registeredRepositories: Object.keys(data.repositories).length,
    currentWorkspace,
    workspaces: {
      total: rows.length,
      dirty: rows.filter((row) => row.gitStatus.dirty).length,
      unavailable: rows.filter((row) => row.gitStatus.availability !== "ok")
        .length,
    },
    sessions: {
      codex: result.rows.reduce(
        (n, row) => n + (row.sessions?.codex.length ?? 0),
        0,
      ),
      claude: result.rows.reduce(
        (n, row) => n + (row.sessions?.claude.length ?? 0),
        0,
      ),
      ...(result.rows.some((row) => row.sessions?.agy?.length)
        ? {
            agy: result.rows.reduce(
              (n, row) => n + (row.sessions?.agy?.length ?? 0),
              0,
            ),
          }
        : {}),
      ...(result.rows.some((row) => row.sessions?.opencode?.length)
        ? {
            opencode: result.rows.reduce(
              (n, row) => n + (row.sessions?.opencode?.length ?? 0),
              0,
            ),
          }
        : {}),
    },
    fetched: fetch,
    errors: result.errors,
  };

  if (asJson) {
    json(status);
  } else {
    const formatField = (label: string, value: string) =>
      `  ${label.padEnd(13)}${sanitizeTerminalText(value)}`;

    console.log(
      [
        "",
        `  ${sanitizeTerminalText(repo.name)}`,
        "",
        formatField("Repository", repo.root),
        formatField("Selected via", status.selection),
        formatField("Base", repo.base),
        formatField("Worktrees", status.repository.worktreeDirectory),
        formatField(
          "Current",
          currentWorkspace
            ? `${currentWorkspace.main ? "main checkout" : currentWorkspace.branch} · ${currentWorkspace.path}`
            : "outside this repository",
        ),
        formatField(
          "Workspaces",
          `${status.workspaces.total} total · ${status.workspaces.dirty} dirty · ${status.workspaces.unavailable} unavailable`,
        ),
        formatField(
          "Sessions",
          `${status.sessions.codex} Codex · ${status.sessions.claude} Claude${status.sessions.agy ? ` · ${status.sessions.agy} Antigravity` : ""}${status.sessions.opencode ? ` · ${status.sessions.opencode} OpenCode` : ""} saved`,
        ),
        formatField("Default", data.default ?? "legacy configuration"),
        "",
        "  rl checkout  switch repository · rl list  workspaces",
        "  rl status --workspace  current workspace, Git, PR and sessions",
        "",
      ].join("\n"),
    );
    for (const err of result.errors) {
      console.error(
        `${sanitizeTerminalText(err.repository)}: ${sanitizeTerminalText(err.message)}`,
      );
    }
  }

  return result.errors.length > 0 ? 1 : 0;
}

export function resolveRepositorySettings(
  settings: Settings,
): NamedRepository | null {
  const registry = new Registry(settings);
  if (!fs.existsSync(registry.file) && !settings.selection) {
    return null;
  }
  return registry.resolve(registry.read());
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
      "alias",
      "output-path",
      "vm",
    ],
    [
      "all",
      "list",
      "json",
      "fetch",
      "include-deleted",
      "include-existing",
      "cloud",
      "include-cloud",
    ],
  );

  if (values.cloud && values["include-cloud"]) {
    throw new UsageError("Choose either --cloud or --include-cloud");
  }

  const settings: Settings = {
    stateDir: required(values, "state-dir"),
    baseDir: required(values, "base-dir"),
    legacyRoot: required(values, "legacy-root"),
    legacyName: required(values, "legacy-name"),
    legacyBase: required(values, "legacy-base"),
    selection: String(values.selection ?? ""),
  };

  const registry = new Registry(settings);
  const [command, ...rest] = positionals;
  if (
    values["include-existing"] &&
    !(command === "status" && (values.list || values.all))
  )
    throw new UsageError("--include-existing requires rl list");
  if (values["include-existing"] && values.cloud)
    throw new UsageError(
      "--include-existing applies to local Git worktrees; omit --cloud",
    );

  if (command === "repo") {
    if (
      rest[0] === "clone" ||
      (rest[0] === "add" && isRemoteSource(rest[1] ?? ""))
    ) {
      await registry.clone(rest, values);
      return 0;
    }
    if (rest[0] === "list" && (values.cloud || values["include-cloud"])) {
      arity(rest, 1);
      const { fetchCloudRepositories } = await import("./cloud.js");
      const cloud = await fetchCloudRepositories({
        stateDir: settings.stateDir,
        vm: values.vm as string | undefined,
      });
      const localData = values["include-cloud"] ? registry.read() : null;
      if (values.json) {
        json(
          localData
            ? {
                local: localData,
                cloud: {
                  vm: cloud.vm,
                  default: cloud.defaultRepo,
                  repositories: cloud.repositories,
                },
              }
            : {
                vm: cloud.vm,
                default: cloud.defaultRepo,
                repositories: cloud.repositories,
              },
        );
      } else {
        if (localData) {
          for (const key of Object.keys(localData.repositories).sort()) {
            const repo = localData.repositories[key]!;
            const marker = key === localData.default ? "*" : " ";
            console.log(
              `${marker} [local] ${key}  ${repo.root}  base=${repo.base}  directory=${repo.worktreeName}`,
            );
          }
        }
        for (const repo of cloud.repositories) {
          const marker = repo.isDefault ? "*" : " ";
          const regTag = repo.registered ? "" : " [unregistered]";
          console.log(
            `${marker} [${cloud.vm}] ${repo.name}  ${repo.root}  base=${repo.base}  directory=${repo.worktreeName}${regTag}`,
          );
        }
      }
      return 0;
    }
    await registry.manage(rest, values);
    return 0;
  }

  if (command === "checkout") {
    arity(rest, 0, 1);
    await registry.checkout(
      rest[0],
      values["output-path"] as string | undefined,
    );
    return 0;
  }

  const data = registry.read();
  arity(rest, 0);

  if (command === "status" && !values.all && !values.list) {
    return repositoryStatus(
      registry,
      data,
      Boolean(values.fetch),
      Boolean(values.json),
    );
  }

  if (command === "resolve") {
    const repo = registry.resolve(data);
    console.log(
      [repo.root, repo.worktreeName, repo.base, repo.name].join("\n"),
    );
    return 0;
  }

  if (command !== "status" || Boolean(values.all) === Boolean(values.list)) {
    throw new UsageError("Choose status --all or --list");
  }
  if (values.all && settings.selection) {
    throw new UsageError(
      "Choose --repo <name> with status --list, or status --all",
    );
  }

  if (values.cloud) {
    const { fetchCloudOverview } = await import("./cloud.js");
    const cloud = await fetchCloudOverview({
      stateDir: settings.stateDir,
      vm: values.vm as string | undefined,
      fetch: Boolean(values.fetch),
      includeDeleted: Boolean(values["include-deleted"]),
    });
    if (values.json) {
      json({
        vm: cloud.vm,
        instances: cloud.rows,
        errors: cloud.errors,
        fetched: Boolean(values.fetch),
      });
    } else {
      renderOverviewTable(cloud.rows, Boolean(values.fetch));
      for (const err of cloud.errors) {
        console.error(
          `${sanitizeTerminalText(err.repository)}: ${sanitizeTerminalText(err.message)}`,
        );
      }
    }
    return cloud.errors.length > 0 ? 1 : 0;
  }

  let repos = values.all
    ? Object.keys(data.repositories)
        .sort()
        .map((name) => ({ name, ...data.repositories[name] }))
    : [registry.resolve(data)];
  if (repos.length === 0) {
    repos = [registry.legacy()];
  }

  const [results, cloudResult] = await Promise.all([
    pooled(repos, 4, (repo) =>
      repositoryRows(
        repo,
        settings,
        Boolean(values.fetch),
        Boolean(values["include-deleted"]),
        true,
      ),
    ),
    values["include-cloud"]
      ? import("./cloud.js").then(({ fetchCloudOverview }) =>
          fetchCloudOverview({
            stateDir: settings.stateDir,
            vm: values.vm as string | undefined,
            fetch: Boolean(values.fetch),
            includeDeleted: Boolean(values["include-deleted"]),
          }),
        )
      : Promise.resolve(null),
  ]);

  const localRows = results.flatMap((result) => result.rows);
  const combinedRows = [
    ...localRows,
    ...(cloudResult ? cloudResult.rows : []),
  ].sort((a, b) =>
    [a.repositoryName, a.id, a.status]
      .join("\0")
      .localeCompare([b.repositoryName, b.id, b.status].join("\0")),
  );
  const errors = [
    ...results.flatMap((result) => result.errors),
    ...(cloudResult ? cloudResult.errors : []),
  ];

  if (values.json) {
    json({
      instances: combinedRows,
      errors,
      fetched: Boolean(values.fetch),
      ...(cloudResult ? { cloudVm: cloudResult.vm } : {}),
    });
  } else {
    renderOverviewTable(combinedRows, Boolean(values.fetch));
    for (const err of errors) {
      console.error(
        `${sanitizeTerminalText(err.repository)}: ${sanitizeTerminalText(err.message)}`,
      );
    }
  }

  return errors.length > 0 ? 1 : 0;
}
