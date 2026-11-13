import path from "node:path";
import { canonical, inside } from "../common.js";
import { RlError, WorkspaceNotFoundError } from "../errors.js";
import type { Instance } from "../store.js";

export interface NamedWorkspaceItem {
  name: string;
  path: string;
  branch: string;
}

/**
 * Compute unambiguous display/selector names for active instances, preserving
 * managed relative names and falling back to full paths on outside basename collisions.
 */
export function nameActiveInstances(
  instances: readonly Instance[],
  repoRoot: string,
  managedDir: string,
): { instance: Instance; name: string }[] {
  const active = instances.filter(
    (item) => item.status === "active" && item.worktree !== repoRoot,
  );

  const entries = active.map((instance) => ({
    instance,
    managed: inside(instance.worktree, managedDir),
    name: inside(instance.worktree, managedDir)
      ? path.relative(managedDir, instance.worktree)
      : path.basename(instance.worktree),
  }));

  const usedNames = new Set(
    entries.filter((entry) => entry.managed).map((entry) => entry.name),
  );

  for (const entry of entries) {
    if (!entry.managed) {
      if (usedNames.has(entry.name)) {
        entry.name = entry.instance.worktree;
      }
      usedNames.add(entry.name);
    }
  }

  return entries.map(({ instance, name }) => ({ instance, name }));
}

export function selectMatchingItem<
  T extends { name: string; branch: string; path: string },
>(
  items: readonly T[],
  selector: string,
  options: {
    ambiguousMessage?: (selector: string) => string;
    notFoundMessage?: (selector: string) => string;
  } = {},
): T {
  const canonicalSelector = path.isAbsolute(selector)
    ? canonical(selector)
    : undefined;

  const matches = items.filter(
    (item) =>
      item.name === selector ||
      item.branch === selector ||
      (canonicalSelector !== undefined && item.path === canonicalSelector),
  );

  if (matches.length > 1) {
    throw new RlError(
      options.ambiguousMessage
        ? options.ambiguousMessage(selector)
        : `Ambiguous workspace: ${selector}; use its managed directory name`,
    );
  }

  if (matches.length === 0) {
    throw new WorkspaceNotFoundError(
      options.notFoundMessage
        ? options.notFoundMessage(selector)
        : `Workspace not found: ${selector}. Use rl list or rl switch --create.`,
    );
  }

  return matches[0];
}
