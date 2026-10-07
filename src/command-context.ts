import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { canonical, inside, required } from "./common.js";
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
export function writeWorkspaceOutput(workspace: string, output?: string): void {
  if (output === undefined) {
    console.log(workspace);
    return;
  }
  const target = path.resolve(output);
  if (!inside(canonical(target), canonical(os.tmpdir())))
    throw new Error("Shell output file must be inside the temporary directory");
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1)
      throw new Error("Shell output file must be an empty regular file");
    fs.writeFileSync(fd, workspace);
  } finally {
    fs.closeSync(fd);
  }
}
type OptionValues = Record<string, string | boolean | undefined>;

/** Settings have already been selected by the public CLI's repository router. */
export function commandContext(values: OptionValues): CommandContext {
  const repo = required(values, "repo"),
    stateDir = required(values, "state-dir"),
    managedDir = required(values, "base-dir");
  if (![repo, stateDir, managedDir].every((value) => path.isAbsolute(value)))
    throw new Error(
      "Repository, state and managed workspace paths must be absolute",
    );
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
  const choices = candidates(context.repo, context.managedDir);
  const matches = choices.filter(
    (item) =>
      item.name === selector ||
      item.branch === selector ||
      (path.isAbsolute(selector) && item.path === canonical(selector)),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous workspace: ${selector}; use its managed directory name`
        : `Workspace not found: ${selector}. Use rl list or rl switch --create.`,
    );
  const item = matches[0];
  // Revalidate repository identity and branch. Worktree metadata alone can be
  // stale after the directory has been removed or replaced.
  const [root, branch] = context.store.worktree(item.path);
  if (branch !== item.branch)
    throw new Error(
      "Workspace branch changed during selection; retry the command",
    );
  return { path: root, name: item.name, branch };
}
