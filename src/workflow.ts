import fs from "node:fs";
import path from "node:path";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  inside,
  json,
  locked,
} from "./common.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
  writeWorkspaceOutput,
  type CommandContext,
  type WorkspaceTarget,
} from "./command-context.js";
import { resolveBase } from "./base.js";
import { worktrees } from "./repos.js";
import { launchAgent } from "./agent-launch.js";
import {
  EMPTY_WORKFLOW,
  WORKFLOW_FILE,
  readWorkflowConfig,
  setupWorkspace,
  workflowEnvironment,
} from "./workflow-config.js";

const CREATE_LOCK = ".workspace-create";
const SETUP_LOCK = ".workspace-setup";
const LOCK_FILE = ".lock";
const SUPPORTED_AGENTS = new Set(["codex", "claude"]);
const COMMAND_OPTIONS: Record<string, string[]> = {
  path: [],
  config: [],
  exec: ["workspace"],
  setup: ["workspace", "dry-run"],
  switch: ["create", "base", "no-fetch", "setup", "agent", "output-path"],
  new: ["base", "no-fetch", "setup", "output-path"],
  open: ["branch", "base", "no-fetch", "setup", "output-path"],
};

async function createWorkspace(
  context: CommandContext,
  name: string,
  base: string,
  noFetch: boolean,
  options: {
    reuseExisting?: boolean;
    directoryName?: string;
    requireBranch?: boolean;
  } = {},
): Promise<WorkspaceTarget & { created: boolean }> {
  if (
    name.startsWith("-") ||
    name.startsWith("@") ||
    name
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..") ||
    path.isAbsolute(name)
  )
    throw new Error(`Invalid workspace name: ${name}`);
  git(context.repo, "check-ref-format", "--branch", name);
  return locked(
    path.join(context.store.root, CREATE_LOCK),
    LOCK_FILE,
    async () => {
      const directoryName = options.directoryName ?? name;
      const destination = path.resolve(context.managedDir, directoryName);
      if (
        !inside(destination, context.managedDir) ||
        canonical(destination) !== destination
      )
        throw new Error(
          "Workspace path must stay inside the managed directory without symlinks",
        );
      const registered = worktrees(context.repo).find(
        (item) => item.branch === `refs/heads/${name}`,
      );
      if (registered) {
        if (!options.reuseExisting)
          throw new Error(
            `Branch already checked out at ${registered.worktree}; use rl switch without --create`,
          );
        const [root, branch] = context.store.worktree(registered.worktree);
        if (branch !== name)
          throw new Error("Workspace branch changed during selection; retry");
        return { path: root, name: directoryName, branch, created: false };
      }
      if (fs.existsSync(destination))
        throw new Error(`Workspace path already exists: ${destination}`);
      if (!noFetch) {
        const remotes = git(context.repo, "remote").split("\n");
        if (remotes.includes("origin")) {
          const result = await execute(
            ["git", "fetch", "origin"],
            context.repo,
            { terminalError: true },
          );
          if (result.code !== 0)
            throw new Error("Fetch failed; retry or use --no-fetch");
        }
      }
      const exists = git(
        context.repo,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${name}`,
      )
        .split("\n")
        .includes(`refs/heads/${name}`);
      const remoteBranch = `refs/remotes/origin/${name}`;
      const remoteExists =
        options.requireBranch &&
        git(context.repo, "for-each-ref", "--format=%(refname)", remoteBranch)
          .split("\n")
          .includes(remoteBranch);
      if (options.requireBranch && !exists && !remoteExists)
        throw new Error(`Branch does not exist locally or on origin: ${name}`);
      const resolved = exists
        ? null
        : resolveBase(
            context.repo,
            options.requireBranch ? `origin/${name}` : base,
          );
      if (!exists && !resolved)
        throw new Error(`Base branch does not exist: ${base}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const creationArgs = exists
        ? [destination, name]
        : resolved
          ? [
              ...(options.requireBranch ? ["--track"] : []),
              "-b",
              name,
              destination,
              options.requireBranch ? `origin/${name}` : resolved.oid,
            ]
          : [];
      git(context.repo, "worktree", "add", ...creationArgs);
      return {
        path: destination,
        name: directoryName,
        branch: name,
        created: true,
      };
    },
  );
}

export async function main(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = args(
    separator < 0 ? argv : argv.slice(0, separator),
    [...contextOptions, "base", "branch", "workspace", "agent", "output-path"],
    ["create", "no-fetch", "setup", "dry-run"],
    { create: "c", base: "b" },
  );
  const context = commandContext(values);
  const [command, ...names] = positionals;
  const allowedOptions = COMMAND_OPTIONS[command];
  if (!allowedOptions) throw new Error("Unknown workspace workflow command");
  for (const option of Object.keys(values))
    if (!contextOptions.includes(option) && !allowedOptions.includes(option))
      throw new Error(`--${option} is not supported by rl ${command}`);
  if (
    command === "switch" &&
    !values.create &&
    (values.base || values["no-fetch"])
  )
    throw new Error("--base and --no-fetch require --create with rl switch");
  const selector =
    typeof values.workspace === "string" ? values.workspace : undefined;
  if (
    forwarded.length &&
    command !== "exec" &&
    !(command === "switch" && values.agent)
  )
    throw new Error("Arguments after -- require rl exec or rl switch --agent");
  if (command === "path") {
    arity(names, 0, 1);
    console.log(resolveWorkspace(context, names[0]).path);
    return 0;
  }
  if (command === "config") {
    arity(names, 1);
    if (names[0] === "show") json(readWorkflowConfig(context.repo));
    else if (names[0] === "init") {
      const file = path.join(context.repo, WORKFLOW_FILE);
      if (
        fs
          .lstatSync(path.dirname(file), { throwIfNoEntry: false })
          ?.isSymbolicLink()
      )
        throw new Error("Workflow config directory must not be a symlink");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(EMPTY_WORKFLOW, null, 2) + "\n", {
        flag: "wx",
      });
      console.log(file);
    } else throw new Error("Usage: rl config show|init");
    return 0;
  }
  if (command === "exec") {
    arity(names, 0);
    if (!forwarded.length)
      throw new Error(
        "Usage: rl exec [--workspace name] -- <command> [args...]",
      );
    const target = resolveWorkspace(context, selector);
    return (
      await execute(forwarded, target.path, {
        interactive: true,
        env: workflowEnvironment(
          context.repo,
          target.path,
          readWorkflowConfig(context.repo),
        ),
      })
    ).code;
  }
  if (command === "setup") {
    arity(names, 0);
    const target = resolveWorkspace(context, selector);
    return locked(path.join(context.store.root, SETUP_LOCK), LOCK_FILE, () => {
      if (context.store.worktree(target.path)[1] !== target.branch)
        throw new Error("Workspace branch changed before setup; retry");
      return setupWorkspace(context.repo, target.path, {
        dryRun: !!values["dry-run"],
        create: true,
        open: true,
        stateDir: context.stateDir,
      });
    });
  }
  if (!["switch", "new", "open"].includes(command))
    throw new Error("Unknown workspace workflow command");
  arity(names, command === "open" ? 0 : 1);
  const selectedBranch =
    values.branch ?? (command === "open" ? values.base : undefined);
  if (command === "open" && typeof selectedBranch !== "string")
    throw new Error("Usage: rl open --branch <branch>");
  const agent = typeof values.agent === "string" ? values.agent : undefined;
  if (agent && !SUPPORTED_AGENTS.has(agent))
    throw new Error("Agent must be codex or claude");
  const base =
    command !== "open" && typeof values.base === "string"
      ? values.base
      : context.defaultBase;
  const creating = !!values.create || command === "new" || command === "open";
  const branch =
    typeof selectedBranch === "string"
      ? selectedBranch.replace(/^origin\//, "")
      : names[0];
  const target = creating
    ? await createWorkspace(
        context,
        branch,
        base,
        !!values["no-fetch"],
        command === "switch"
          ? {}
          : {
              reuseExisting: true,
              ...(command === "open"
                ? {
                    directoryName: branch.replaceAll("/", "-"),
                    requireBranch: true,
                  }
                : {}),
            },
      )
    : resolveWorkspace(context, names[0]);
  await context.store.adopt(target.path, base);
  if (values.setup) {
    const code = await locked(
      path.join(context.store.root, SETUP_LOCK),
      LOCK_FILE,
      () => {
        if (context.store.worktree(target.path)[1] !== target.branch)
          throw new Error("Workspace branch changed before setup; retry");
        return setupWorkspace(context.repo, target.path, {
          create: "created" in target && target.created === true,
          open: true,
          stateDir: context.stateDir,
        });
      },
    );
    if (code !== 0) return code;
  }
  writeWorkspaceOutput(
    target.path,
    typeof values["output-path"] === "string"
      ? values["output-path"]
      : undefined,
  );
  return agent
    ? launchAgent(context.store, agent, forwarded, { cwd: target.path })
    : 0;
}
