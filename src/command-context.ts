import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical, inside, required } from "./common.js";
import { RlError, WorkspaceNotFoundError } from "./errors.js";
import { candidates } from "./picker.js";
import { Store } from "./store.js";

export const contextOptions = ["repo", "state-dir", "base-dir", "default-base"];

export interface CommandContext {
  repo: string;
  stateDir: string;
  managedDir: string;
  defaultBase: string;
  store: Store;
}

export interface WorkspaceTarget {
  path: string;
  name: string;
  branch: string;
}

function writeValidatedShellFile(file: string, content: string): void {
  const target = path.resolve(file);
  if (!inside(canonical(target), canonical(os.tmpdir()))) {
    throw new RlError(
      "Shell output file must be inside the temporary directory",
    );
  }

  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1) {
      throw new RlError("Shell output file must be an empty regular file");
    }
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeWorkspaceOutput(workspace: string, output?: string): void {
  if (output !== undefined) {
    writeValidatedShellFile(output, workspace);
    return;
  }

  const shellOutput = process.env.RL_SHELL_OUTPUT;
  if (shellOutput) {
    const payload =
      process.env.RL_SHELL_PROTOCOL === "v2" ? `cd:${workspace}` : workspace;
    writeValidatedShellFile(shellOutput, payload);
    return;
  }

  console.log(workspace);
  if (process.stdout.isTTY && process.stderr.isTTY) {
    const shellName = path.basename(process.env.SHELL ?? "");
    if (shellName === "zsh" || shellName === "bash") {
      console.error(
        `Enable directory switching: eval "$(rl setup shell ${shellName})"`,
      );
    } else {
      console.error(
        "Enable directory switching with shell integration: rl help setup shell",
      );
    }
  }
}

export function recoverDeletedDirectory(
  initialCwd: string,
  repoRoot: string,
): void {
  if (fs.existsSync(initialCwd)) {
    return;
  }
  const shellOutput = process.env.RL_SHELL_OUTPUT;
  if (!shellOutput) {
    return;
  }
  try {
    const stat = fs.lstatSync(shellOutput);
    if (stat.isFile() && stat.size === 0) {
      const payload =
        process.env.RL_SHELL_PROTOCOL === "v2"
          ? `recover:${repoRoot}`
          : repoRoot;
      writeValidatedShellFile(shellOutput, payload);
    }
  } catch {
    // Best-effort shell directory recovery when temporary output is unavailable.
  }
}

type OptionValues = Record<string, string | boolean | undefined>;

/** Settings have already been selected by the public CLI's repository router. */
export function commandContext(values: OptionValues): CommandContext {
  const repo = required(values, "repo");
  const stateDir = required(values, "state-dir");
  const managedDir = required(values, "base-dir");

  if (![repo, stateDir, managedDir].every((value) => path.isAbsolute(value))) {
    throw new RlError(
      "Repository, state and managed workspace paths must be absolute",
    );
  }

  const store = new Store(repo, stateDir);
  return {
    repo: store.repo,
    stateDir: store.stateDir,
    managedDir: canonical(managedDir),
    defaultBase: String(values["default-base"] ?? "origin/test"),
    store,
  };
}

/** Resolve only the current checkout or registered managed worktrees, never scan. */
export function resolveWorkspace(
  context: CommandContext,
  selector?: string,
): WorkspaceTarget {
  if (!selector) {
    const [root, branch] = context.store.worktree(process.cwd());
    return { path: root, name: path.basename(root), branch };
  }

  if (
    selector === "@" ||
    (path.isAbsolute(selector) && canonical(selector) === context.repo)
  ) {
    const [root, branch] = context.store.worktree(context.repo);
    return { path: root, name: "@", branch };
  }

  const choices = candidates(context.repo, context.managedDir, context.store);
  const matches = choices.filter(
    (item) =>
      item.name === selector ||
      item.branch === selector ||
      (path.isAbsolute(selector) && item.path === canonical(selector)),
  );

  if (matches.length > 1) {
    throw new RlError(
      `Ambiguous workspace: ${selector}; use its managed directory name`,
    );
  }
  if (matches.length === 0) {
    throw new WorkspaceNotFoundError(
      `Workspace not found: ${selector}. Use rl list or rl switch --create.`,
    );
  }

  const item = matches[0];
  // Revalidate repository identity and branch. Worktree metadata alone can be
  // stale after the directory has been removed or replaced.
  const [root, branch] = context.store.worktree(item.path);
  if (branch !== item.branch) {
    throw new RlError(
      "Workspace branch changed during selection; retry the command",
    );
  }
  return { path: root, name: item.name, branch };
}
