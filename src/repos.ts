import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stripVTControlCharacters } from "node:util";
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
  async checkout(name?: string, output?: string): Promise<void> {
    const data = this.read();
    const repos = Object.entries(data.repositories)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, repo]) => ({ name, ...repo }));
    if (!repos.length)
      throw new Error(
        "No registered repositories. Run 'rl repo add .' inside a repository first.",
      );
    let selected = name ? repos.find((repo) => repo.name === name) : undefined;
    if (name && !selected)
      throw new Error(`Unknown repository: ${name}. Use 'rl repo list'`);
    if (!name && repos.length === 1) selected = repos[0];
    if (!selected) {
      const visible = (value: string) =>
        stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      const cell = (value: string, width: number) => {
        const text = visible(value);
        return (
          text.length > width ? text.slice(0, width - 1) + "…" : text
        ).padEnd(width);
      };
      const nameWidth = Math.min(
        32,
        Math.max(12, ...repos.map((repo) => repo.name.length)),
      );
      const baseWidth = Math.min(
        24,
        Math.max(4, ...repos.map((repo) => visible(repo.base).length)),
      );
      const pathWidth = Math.max(
        12,
        (process.stderr.columns || 110) - nameWidth - baseWidth - 10,
      );
      const dim = (value: string) =>
        process.env.NO_COLOR !== undefined ? value : `\x1b[90m${value}\x1b[0m`;
      const home = os.homedir();
      const rows = repos.map((repo) => ({
        repo,
        line: `${repo.name}\t${cell(repo.name, nameWidth)}  ${dim(cell(repo.base, baseWidth))}  ${dim(cell(repo.root.startsWith(home + path.sep) ? "~" + repo.root.slice(home.length) : repo.root, pathWidth))}`,
      }));
      const result = await execute(
        [
          "fzf",
          "--ansi",
          "--prompt=Repository › ",
          "--delimiter=\t",
          "--with-nth=2..",
          "--height=~50%",
          "--min-height=8",
          "--border=rounded",
          "--info=inline",
          "--reverse",
          "--no-multi",
          "--no-sort",
          `--header=Enter open · Esc cancel\n\n${cell("REPOSITORY", nameWidth)}  ${cell("BASE", baseWidth)}  PATH`,
        ],
        process.cwd(),
        {
          input: rows.map((row) => row.line).join("\n") + "\n",
          terminalError: true,
        },
      );
      if ([1, 130].includes(result.code)) return;
      if (result.code) throw new Error(`fzf failed (exit ${result.code})`);
      const line = result.stdout.replace(/\r?\n$/, "");
      selected = rows.find(
        (row) =>
          stripVTControlCharacters(row.line) ===
            stripVTControlCharacters(line) || row.repo.name === line,
      )?.repo;
      if (!selected) throw new Error("Picker returned an unknown repository");
    }
    const current = this.read().repositories[selected.name];
    if (
      !current ||
      JSON.stringify(current) !==
        JSON.stringify(data.repositories[selected.name])
    )
      throw new Error(
        "Repository registration changed during selection; retry the command",
      );
    if (
      canonical(git(selected.root, "rev-parse", "--show-toplevel")) !==
        selected.root ||
      canonical(
        git(
          selected.root,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      ) !== selected.commonDir
    )
      throw new Error(
        "Repository checkout no longer matches its registration; register it again",
      );
    writeWorkspaceOutput(selected.root, output);
  }
  async manage(rest: string[], values: Record<string, unknown>): Promise<void> {
    await locked(
      path.dirname(this.file),
      ".repositories.typescript.lock",
      () => {
        const data = this.read(),
          repos = data.repositories,
          [action] = rest;
        let name = rest[1];
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
          arity(rest, 1, 3);
          if (rest.length === 3 && values.alias !== undefined)
            throw new Error(
              "Choose either --alias <name> or the legacy <alias> <path> form",
            );
          const target = rest.length === 3 ? rest[2] : (rest[1] ?? ".");
          const directoryPath = path.resolve(expandHome(target));
          if (
            !fs.existsSync(directoryPath) ||
            !fs.statSync(directoryPath).isDirectory()
          )
            throw new Error(
              `Repository directory does not exist: ${directoryPath}. Use 'rl repo add .' for the current repository, with --alias <name> to name it.`,
            );
          const root = canonical(worktrees(directoryPath)[0].worktree);
          name = String(
            values.alias ?? (rest.length === 3 ? name : repositoryName(root)),
          );
          if (!validName(name))
            throw new Error(
              "Repository names must contain letters, numbers, dots, underscores, or hyphens; supply --alias <name>",
            );
          if (Object.hasOwn(repos, name))
            throw new Error(
              `Repository name already registered: ${name}; choose --alias <name>`,
            );
          const common = canonical(
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
function repositoryName(root: string): string {
  let source: string;
  try {
    source = git(root, "remote", "get-url", "origin");
  } catch {
    return path.basename(root);
  }
  if (source.includes("://")) {
    try {
      source = new URL(source).pathname;
    } catch {
      /* Git also accepts local paths. */
    }
  }
  return source
    .replace(/\/+$/, "")
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, "");
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
      "COMMITS + / −",
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
    if (
      canonical(
        git(
          process.cwd(),
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      ) ===
      canonical(
        git(
          repo.root,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ),
      )
    ) {
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
    /* Outside the selected repository. */
  }
  const rows = result.rows.filter((row) => row.worktree !== repo.root);
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
    selection: registry.settings.selection
      ? "explicit"
      : currentWorkspace
        ? "current checkout"
        : "default",
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
    },
    fetched: fetch,
    errors: result.errors,
  };
  if (asJson) json(status);
  else {
    const safe = (value: string) =>
      stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const row = (label: string, value: string) =>
      `  ${label.padEnd(13)}${safe(value)}`;
    console.log(
      [
        "",
        `  ${safe(repo.name)}`,
        "",
        row("Repository", repo.root),
        row("Selected via", status.selection),
        row("Base", repo.base),
        row("Worktrees", status.repository.worktreeDirectory),
        row(
          "Current",
          currentWorkspace
            ? `${currentWorkspace.main ? "main checkout" : currentWorkspace.branch} · ${currentWorkspace.path}`
            : "outside this repository",
        ),
        row(
          "Workspaces",
          `${status.workspaces.total} total · ${status.workspaces.dirty} dirty · ${status.workspaces.unavailable} unavailable`,
        ),
        row(
          "Sessions",
          `${status.sessions.codex} Codex · ${status.sessions.claude} Claude saved`,
        ),
        row("Default", data.default ?? "legacy configuration"),
        "",
        "  rl checkout  switch repository · rl list  workspaces",
        "  rl status --workspace  current workspace, Git, PR and sessions",
        "",
      ].join("\n"),
    );
    for (const error of result.errors)
      console.error(`${safe(error.repository)}: ${safe(error.message)}`);
  }
  return result.errors.length ? 1 : 0;
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
  if (command === "status" && !values.all && !values.list)
    return repositoryStatus(registry, data, !!values.fetch, !!values.json);
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
