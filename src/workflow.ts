import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { launchAgent } from "./agent-launch.js";
import { resolveBase } from "./base.js";
import {
  commandContext,
  contextOptions,
  resolveWorkspace,
  writeWorkspaceOutput,
  type CommandContext,
  type WorkspaceTarget,
} from "./command-context.js";
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
import { UsageError, WorkspaceNotFoundError } from "./errors.js";
import { GIT_WORKFLOW_DIRECTORY, GIT_WORKFLOW_LOCK } from "./git-safety.js";
import { worktrees } from "./repos.js";
import {
  EMPTY_WORKFLOW,
  readWorkflowConfig,
  setupWorkspace,
  WORKFLOW_FILE,
  workflowEnvironment,
} from "./workflow-config.js";

const SETUP_LOCK_DIR = ".workspace-setup";
const SUPPORTED_AGENTS = new Set(["codex", "claude", "agy"]);

const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  path: [],
  config: [],
  exec: ["workspace"],
  setup: ["workspace", "dry-run"],
  switch: ["create", "base", "no-fetch", "setup", "agent", "output-path"],
};

function setupLockName(workspacePath: string): string {
  const digest = createHash("sha256")
    .update(canonical(workspacePath))
    .digest("hex")
    .slice(0, 16);
  return `.setup-${digest}.lock`;
}

async function createWorkspace(
  context: CommandContext,
  name: string,
  base: string,
  noFetch: boolean,
  options: {
    reuseExisting?: boolean;
    requireBranch?: boolean;
  } = {},
): Promise<
  WorkspaceTarget & {
    created: boolean;
    startingCommit?: string;
    reviewBaseCommit?: string;
  }
> {
  if (
    name.startsWith("-") ||
    name.startsWith("@") ||
    name
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..") ||
    path.isAbsolute(name)
  ) {
    throw new UsageError(`Invalid workspace name: ${name}`);
  }
  git(context.repo, "check-ref-format", "--branch", name);

  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    async () => {
      const destination = path.resolve(context.managedDir, name);
      if (
        !inside(destination, context.managedDir) ||
        canonical(destination) !== destination
      ) {
        throw new Error(
          "Workspace path must stay inside the managed directory without symlinks",
        );
      }

      const registered = worktrees(context.repo).find(
        (item) => item.branch === `refs/heads/${name}`,
      );
      if (registered) {
        if (!options.reuseExisting) {
          throw new Error(
            `Branch already checked out at ${registered.worktree}; use rl switch without --create`,
          );
        }
        const [root, branch] = context.store.worktree(registered.worktree);
        if (branch !== name) {
          throw new Error("Workspace branch changed during selection; retry");
        }
        return { path: root, name, branch, created: false };
      }

      if (fs.existsSync(destination)) {
        throw new Error(`Workspace path already exists: ${destination}`);
      }

      if (!noFetch) {
        const remotes = git(context.repo, "remote").split("\n");
        if (remotes.includes("origin")) {
          const result = await execute(
            ["git", "fetch", "origin"],
            context.repo,
            { terminalError: true },
          );
          if (result.code !== 0) {
            throw new Error("Fetch failed; retry or use --no-fetch");
          }
        }
      }

      const existsLocally = git(
        context.repo,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${name}`,
      )
        .split("\n")
        .includes(`refs/heads/${name}`);

      const remoteBranch = `refs/remotes/origin/${name}`;
      const existsOnRemote =
        Boolean(options.requireBranch) &&
        git(context.repo, "for-each-ref", "--format=%(refname)", remoteBranch)
          .split("\n")
          .includes(remoteBranch);

      if (options.requireBranch && !existsLocally && !existsOnRemote) {
        throw new Error(`Branch does not exist locally or on origin: ${name}`);
      }

      const resolved = existsLocally
        ? null
        : resolveBase(
            context.repo,
            options.requireBranch ? `origin/${name}` : base,
          );
      if (!existsLocally && !resolved) {
        throw new Error(`Base branch does not exist: ${base}`);
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });

      let creationArgs: string[] = [];
      if (existsLocally) {
        creationArgs = [destination, name];
      } else if (resolved) {
        creationArgs = [
          ...(options.requireBranch ? ["--track"] : []),
          "-b",
          name,
          destination,
          options.requireBranch ? `origin/${name}` : resolved.oid,
        ];
      }

      git(context.repo, "worktree", "add", ...creationArgs);

      return {
        path: destination,
        name,
        branch: name,
        created: true,
        startingCommit: existsLocally
          ? git(destination, "rev-parse", "HEAD")
          : resolved!.oid,
        ...(!existsLocally && !options.requireBranch
          ? { reviewBaseCommit: resolved!.oid }
          : {}),
      };
    },
  );
}

export async function main(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = args(
    separator < 0 ? argv : argv.slice(0, separator),
    [...contextOptions, "base", "workspace", "agent", "output-path"],
    ["create", "no-fetch", "setup", "dry-run"],
    { create: "c", base: "b" },
  );

  const context = commandContext(values);
  const [command, ...names] = positionals;
  const allowedOptions = COMMAND_OPTIONS[command];
  if (!allowedOptions) {
    throw new UsageError("Unknown workspace workflow command");
  }

  for (const option of Object.keys(values)) {
    if (!contextOptions.includes(option) && !allowedOptions.includes(option)) {
      throw new UsageError(`--${option} is not supported by rl ${command}`);
    }
  }
  if (command === "switch" && !values.create && values.base) {
    throw new UsageError("--base requires --create with rl switch");
  }

  const selector =
    typeof values.workspace === "string" ? values.workspace : undefined;
  if (
    forwarded.length > 0 &&
    command !== "exec" &&
    !(command === "switch" && values.agent)
  ) {
    throw new UsageError(
      "Arguments after -- require rl exec or rl switch --agent",
    );
  }

  if (command === "path") {
    arity(names, 0, 1);
    console.log(resolveWorkspace(context, names[0]).path);
    return 0;
  }

  if (command === "config") {
    arity(names, 1);
    if (names[0] === "show") {
      json(readWorkflowConfig(context.repo));
      return 0;
    }
    if (names[0] === "init") {
      const file = path.join(context.repo, WORKFLOW_FILE);
      if (
        fs
          .lstatSync(path.dirname(file), { throwIfNoEntry: false })
          ?.isSymbolicLink()
      ) {
        throw new Error("Workflow config directory must not be a symlink");
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(EMPTY_WORKFLOW, null, 2)}\n`, {
        flag: "wx",
      });
      console.log(file);
      return 0;
    }
    throw new UsageError("Usage: rl setup show|init");
  }

  if (command === "exec") {
    arity(names, 0);
    if (forwarded.length === 0) {
      throw new UsageError(
        "Usage: rl exec [--workspace name] -- <command> [args...]",
      );
    }
    const target = resolveWorkspace(context, selector);
    const result = await execute(forwarded, target.path, {
      interactive: true,
      env: workflowEnvironment(
        context.repo,
        target.path,
        readWorkflowConfig(context.repo),
      ),
    });
    return result.code;
  }

  if (command === "setup") {
    arity(names, 0);
    const target = resolveWorkspace(context, selector);
    return locked(
      path.join(context.store.root, SETUP_LOCK_DIR),
      setupLockName(target.path),
      () => {
        if (context.store.worktree(target.path)[1] !== target.branch) {
          throw new Error("Workspace branch changed before setup; retry");
        }
        return setupWorkspace(context.repo, target.path, {
          dryRun: Boolean(values["dry-run"]),
          create: true,
          open: true,
          stateDir: context.stateDir,
        });
      },
    );
  }

  arity(names, 1);
  const agent = typeof values.agent === "string" ? values.agent : undefined;
  if (agent && !SUPPORTED_AGENTS.has(agent)) {
    throw new UsageError("Agent must be codex, claude or agy");
  }

  const base =
    typeof values.base === "string" ? values.base : context.defaultBase;
  let target: WorkspaceTarget & {
    created?: boolean;
    startingCommit?: string;
    reviewBaseCommit?: string;
  };

  if (values.create) {
    target = await createWorkspace(
      context,
      names[0],
      base,
      Boolean(values["no-fetch"]),
    );
  } else {
    try {
      target = resolveWorkspace(context, names[0]);
    } catch (error) {
      if (!(error instanceof WorkspaceNotFoundError)) {
        throw error;
      }
      target = await createWorkspace(
        context,
        names[0].replace(/^origin\//, ""),
        base,
        Boolean(values["no-fetch"]),
        { reuseExisting: true, requireBranch: true },
      );
    }
  }

  await context.store.adopt(
    target.path,
    base,
    undefined,
    target.startingCommit
      ? {
          startingCommit: target.startingCommit,
          reviewBaseCommit: target.reviewBaseCommit,
        }
      : undefined,
  );

  if (values.setup) {
    const code = await locked(
      path.join(context.store.root, SETUP_LOCK_DIR),
      setupLockName(target.path),
      () => {
        if (context.store.worktree(target.path)[1] !== target.branch) {
          throw new Error("Workspace branch changed before setup; retry");
        }
        return setupWorkspace(context.repo, target.path, {
          create: target.created === true,
          open: true,
          stateDir: context.stateDir,
        });
      },
    );
    if (code !== 0) {
      return code;
    }
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
