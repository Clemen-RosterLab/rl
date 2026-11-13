import fs from "node:fs";
import path from "node:path";
import { lastAccessed } from "./access.js";
import { protectedCleanupName } from "./cleanup-path.js";
import {
  commandContext,
  contextOptions,
  type CommandContext,
} from "./command-context.js";
import {
  args,
  arity,
  canonical,
  git,
  inside,
  json,
  locked,
  message,
} from "./common.js";
import {
  BUILD_AND_CACHE_DIRECTORIES,
  DEPENDENCY_DIRECTORIES,
} from "./core/protected-paths.js";
import { UsageError } from "./errors.js";
import {
  assertReady,
  GIT_WORKFLOW_DIRECTORY,
  GIT_WORKFLOW_LOCK,
} from "./git-safety.js";
import { worktrees } from "./repos.js";
import type { Instance } from "./store.js";
import { sanitizeTerminalText } from "./tui/ansi.js";
import { containedPath, readWorkflowConfig } from "./workflow-config.js";

type UsageCategory = "dependenciesBytes" | "buildsBytes" | "otherBytes";

interface Usage {
  allocatedBytes: number;
  logicalBytes: number;
  estimatedBytes: number;
  dependenciesBytes: number;
  buildsBytes: number;
  otherBytes: number;
  files: number;
  symlinks: number;
  largestPaths: { path: string; allocatedBytes: number }[];
}

interface CleanupTarget {
  path: string;
  relative: string;
  dev: number;
  ino: number;
}

export function size(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let scaled = bytes;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  return `${index > 0 ? scaled.toFixed(1) : scaled} ${units[index]}`;
}

function classifyCategory(relative: string, clean: string[]): UsageCategory {
  const parts = relative.split(path.sep);
  if (parts.some((part) => DEPENDENCY_DIRECTORIES.has(part))) {
    return "dependenciesBytes";
  }
  if (
    parts.some((part) => BUILD_AND_CACHE_DIRECTORIES.has(part)) ||
    clean.some(
      (item) => relative === item || relative.startsWith(item + path.sep),
    )
  ) {
    return "buildsBytes";
  }
  return "otherBytes";
}

/** Read only this directory tree. Never follow symlinks or enter Git metadata. */
function measureTree(
  initialRoots: { path: string; relative: string }[],
  clean: string[],
  protect = false,
): Usage {
  const usage: Usage = {
    allocatedBytes: 0,
    logicalBytes: 0,
    estimatedBytes: 0,
    dependenciesBytes: 0,
    buildsBytes: 0,
    otherBytes: 0,
    files: 0,
    symlinks: 0,
    largestPaths: [],
  };
  const largest = new Map<string, number>();
  const links = new Map<
    string,
    { bytes: number; seen: number; count: number }
  >();
  const pending = [...initialRoots];

  while (pending.length > 0) {
    const item = pending.pop()!;
    const name = path.basename(item.path);
    if (protect && protectedCleanupName(name)) {
      throw new Error(
        `Cleanup contains protected metadata or credentials: ${item.relative}`,
      );
    }
    if (!protect && name === ".git") {
      continue;
    }

    const stat = fs.lstatSync(item.path);
    const bytes = stat.blocks * 512;
    const kind = classifyCategory(item.relative, clean);
    let counted = true;

    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(item.path).toSorted().toReversed()) {
        pending.push({
          path: path.join(item.path, child),
          relative: path.join(item.relative, child),
        });
      }
      usage.estimatedBytes += bytes;
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      if (stat.isSymbolicLink()) {
        usage.symlinks++;
      } else {
        usage.files++;
      }
      usage.logicalBytes += stat.size;
      if (stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`;
        const previous = links.get(key);
        if (previous) {
          previous.seen++;
          counted = false;
        } else {
          links.set(key, { bytes, seen: 1, count: stat.nlink });
        }
      } else {
        usage.estimatedBytes += bytes;
      }
    } else if (protect) {
      throw new Error(`Cleanup contains a special file: ${item.relative}`);
    }

    if (counted) {
      usage.allocatedBytes += bytes;
      usage[kind] += bytes;
      const top = item.relative.split(path.sep)[0];
      if (top) {
        largest.set(top, (largest.get(top) ?? 0) + bytes);
      }
    }
  }

  for (const link of links.values()) {
    if (link.seen >= link.count) {
      usage.estimatedBytes += link.bytes;
    }
  }

  usage.largestPaths = [...largest]
    .map(([entryPath, allocatedBytes]) => ({ path: entryPath, allocatedBytes }))
    .toSorted(
      (a, b) =>
        b.allocatedBytes - a.allocatedBytes || a.path.localeCompare(b.path),
    );

  return usage;
}

function deduplicateCleanRoots(clean: string[]): string[] {
  const sorted = [...new Set(clean)].toSorted(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  return sorted.filter(
    (item, index) =>
      !sorted.slice(0, index).some((parent) => item.startsWith(`${parent}/`)),
  );
}

function validateIgnored(workspace: string, relative: string): void {
  if (
    git(
      workspace,
      "--literal-pathspecs",
      "ls-files",
      "--cached",
      "-z",
      "--",
      relative,
    )
  ) {
    throw new Error(`Cleanup path contains tracked files: ${relative}`);
  }
  try {
    git(workspace, "check-ignore", "--no-index", "--", `${relative}/`);
  } catch {
    throw new Error(`Cleanup path must be ignored by Git: ${relative}`);
  }
  if (
    git(
      workspace,
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      relative,
    )
  ) {
    throw new Error(`Cleanup path contains non-ignored files: ${relative}`);
  }
}

function buildCleanupPlan(
  workspace: string,
  clean: string[],
): { targets: CleanupTarget[]; estimatedBytes: number } {
  const targets = deduplicateCleanRoots(clean).flatMap((relative) => {
    const target = containedPath(workspace, relative);
    if (!fs.existsSync(target)) {
      return [];
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) {
      throw new Error(`Cleanup target must be a directory: ${relative}`);
    }
    validateIgnored(workspace, relative);
    const cwd = canonical(process.cwd());
    if (cwd === target || inside(cwd, target)) {
      throw new Error(
        `Cleanup would remove the current directory: ${relative}. Change to the workspace root first`,
      );
    }
    return [
      {
        path: target,
        relative,
        dev: stat.dev,
        ino: stat.ino,
      },
    ];
  });

  // Measure all targets together in a single traversal so hard-link deduplication
  // across targets is exact without walking node_modules multiple times.
  const estimatedBytes =
    targets.length > 0
      ? measureTree(
          targets.map((target) => ({
            path: target.path,
            relative: target.relative,
          })),
          clean,
          true,
        ).estimatedBytes
      : 0;

  return { targets, estimatedBytes };
}

function verifyTargetIdentity(workspace: string, target: CleanupTarget): void {
  const current = containedPath(workspace, target.relative);
  const stat = fs.lstatSync(current);
  if (
    !stat.isDirectory() ||
    stat.dev !== target.dev ||
    stat.ino !== target.ino
  ) {
    throw new Error(
      `Cleanup directory changed during inspection: ${target.relative}`,
    );
  }
  validateIgnored(workspace, target.relative);
}

/** Stage within the current workspace before deletion; validation failures restore artifacts. */
function stageAndRemove(
  workspace: string,
  targets: CleanupTarget[],
  recheck: () => void,
): string[] {
  const holding = fs.mkdtempSync(path.join(workspace, ".rl-clean-"));
  const holdingIdentity = fs.lstatSync(holding);
  const holdingValid = () => {
    try {
      const current = fs.lstatSync(holding);
      return (
        current.isDirectory() &&
        current.dev === holdingIdentity.dev &&
        current.ino === holdingIdentity.ino &&
        canonical(holding) === holding
      );
    } catch {
      return false;
    }
  };

  const staged: { target: CleanupTarget; path: string }[] = [];
  const removed: string[] = [];

  try {
    for (const target of targets) {
      recheck();
      verifyTargetIdentity(workspace, target);
      const destination = path.join(holding, String(staged.length));
      fs.renameSync(target.path, destination);
      staged.push({ target, path: destination });

      const stat = fs.lstatSync(destination);
      if (
        stat.dev !== target.dev ||
        stat.ino !== target.ino ||
        !stat.isDirectory()
      ) {
        throw new Error("Cleanup directory changed while staging");
      }
      // Recheck credentials/metadata added while the initial plan was being built.
      measureTree([{ path: destination, relative: target.relative }], [], true);
    }

    recheck();
    for (const item of staged) {
      validateIgnored(workspace, item.target.relative);
    }

    for (const item of staged) {
      recheck();
      if (!holdingValid()) {
        throw new Error("Cleanup staging directory changed");
      }
      const stagedIdentity = fs.lstatSync(item.path);
      if (
        !stagedIdentity.isDirectory() ||
        stagedIdentity.dev !== item.target.dev ||
        stagedIdentity.ino !== item.target.ino
      ) {
        throw new Error("Cleanup artifact changed before removal");
      }
      fs.rmSync(item.path, { recursive: true });
      removed.push(item.target.relative);
    }
    return removed;
  } catch (error) {
    if (!holdingValid()) {
      throw new Error(
        `${message(error)}. Staging path changed; inspect retained artifacts in the current workspace`,
        { cause: error },
      );
    }
    for (const item of staged.toReversed()) {
      if (!fs.existsSync(item.path)) continue;
      try {
        containedPath(workspace, item.target.relative);
        if (!fs.existsSync(item.target.path)) {
          fs.renameSync(item.path, item.target.path);
        }
      } catch {
        // Preserve artifacts in the staging directory on restore failure.
      }
    }
    const retainedSuffix = fs.readdirSync(holding).length
      ? `. Remaining artifacts retained at ${holding}`
      : "";
    throw new Error(`${message(error)}${retainedSuffix}`, { cause: error });
  } finally {
    if (holdingValid() && fs.readdirSync(holding).length === 0) {
      fs.rmdirSync(holding);
    }
  }
}

function buildStorageSuggestions(
  data: Instance,
  usage: Usage,
  estimatedBytes: number,
  days: number,
): string[] {
  const result: string[] = [];
  if (estimatedBytes > 0) {
    result.push(
      `Run rl storage clean --dry-run to preview ${size(estimatedBytes)} of configured generated files.`,
    );
  } else if (usage.dependenciesBytes > 0 || usage.buildsBytes > 0) {
    result.push(
      "Add generated directory paths to the clean list in this workspace's .rl/workflows.json.",
    );
  }

  const accessed = lastAccessed(data);
  if (accessed && Date.now() - Date.parse(accessed) >= days * 86_400_000) {
    result.push(`This workspace has not been used for at least ${days} days.`);
  }
  if (String(data.pr?.state).toUpperCase() === "MERGED") {
    result.push(
      "The cached PR is merged. Consider deleting this workspace when finished.",
    );
  }
  return result;
}

/** Standard top-level artifacts are eligible only when ignored by this checkout. */
function defaultCleanupPaths(workspace: string): string[] {
  return [...BUILD_AND_CACHE_DIRECTORIES, ...DEPENDENCY_DIRECTORIES].filter(
    (relative) => {
      if (!fs.existsSync(path.join(workspace, relative))) {
        return false;
      }
      try {
        git(workspace, "check-ignore", "--no-index", "--", `${relative}/`);
        return true;
      } catch {
        return false;
      }
    },
  );
}

export interface CleanupReport {
  workspace: { id: string; branch: string; path: string };
  dryRun: boolean;
  paths: string[];
  estimatedBytes: number;
  removedPaths: string[];
}

/** The caller holds `GIT_WORKFLOW_LOCK` for mutation. A preview writes nothing. */
export function cleanWorkspace(
  context: CommandContext,
  requested: string,
  dryRun: boolean,
  useDefaults = false,
): CleanupReport {
  const [root, branch] = context.store.worktree(requested);
  if (root !== requested) {
    throw new Error("Cleanup requires an RL worktree root");
  }

  const findOwned = () =>
    context.store
      .records()
      .find(
        ([, instance]) =>
          instance.status === "active" && instance.worktree === root,
      );

  const original = findOwned();
  if (!original && !inside(root, context.managedDir)) {
    throw new Error("Cleanup target is not an RL worktree");
  }
  if (original && original[1].branch !== branch) {
    throw new Error(
      `Instance owns branch ${original[1].branch}; current branch is ${branch}`,
    );
  }

  const identity = fs.lstatSync(root);
  const fallbackClean = useDefaults ? defaultCleanupPaths(root) : undefined;
  const clean = readWorkflowConfig(root, fallbackClean).clean;

  const recheck = () => {
    const currentIdentity = fs.lstatSync(root);
    if (
      !currentIdentity.isDirectory() ||
      currentIdentity.dev !== identity.dev ||
      currentIdentity.ino !== identity.ino ||
      canonical(root) !== root
    ) {
      throw new Error("Workspace directory changed during cleanup");
    }
    const current = findOwned();
    if (current?.[1].key !== original?.[1].key) {
      throw new Error("RL workspace changed during cleanup");
    }
    if (context.store.worktree(root)[0] !== root) {
      throw new Error("Worktree identity changed during cleanup");
    }
    assertReady(root, false, branch);
    if (
      JSON.stringify(readWorkflowConfig(root, fallbackClean).clean) !==
      JSON.stringify(clean)
    ) {
      throw new Error("Cleanup configuration changed; retry");
    }
  };

  recheck();
  const { targets, estimatedBytes } = buildCleanupPlan(root, clean);
  const registered = worktrees(context.repo);
  if (
    targets.some((target) =>
      registered.some((other) => {
        const otherRoot = canonical(other.worktree);
        return otherRoot === target.path || inside(otherRoot, target.path);
      }),
    )
  ) {
    throw new Error("Cleanup contains another registered worktree");
  }

  const removedPaths =
    !dryRun && targets.length > 0 ? stageAndRemove(root, targets, recheck) : [];

  return {
    workspace: { id: original?.[1].id ?? branch, branch, path: root },
    dryRun,
    paths: targets.map((target) => target.relative),
    estimatedBytes,
    removedPaths,
  };
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "older-than"],
    ["json", "dry-run"],
  );
  let [command, ...rest] = positionals;
  if (command === "storage" && rest[0] === "clean") {
    command = "clean";
    rest = rest.slice(1);
  }
  arity(rest, 0);

  if (
    (command !== "storage" && command !== "clean") ||
    (command === "storage" && values["dry-run"]) ||
    (command === "clean" && values["older-than"] !== undefined)
  ) {
    throw new UsageError(
      "Usage: rl storage [--json] [--older-than 14d] | rl storage clean [--dry-run] [--json] (current workspace only)",
    );
  }

  const context = commandContext(values);
  const [, data] = context.store.current();
  const clean = readWorkflowConfig(data.worktree).clean;
  const workspace = { id: data.id, branch: data.branch, path: data.worktree };

  const days = Number(String(values["older-than"] ?? "14d").replace(/d$/, ""));
  if (!Number.isInteger(days) || days < 1 || days > 36500) {
    throw new UsageError(
      "--older-than must be a positive number of days, such as 14d",
    );
  }

  if (command === "storage") {
    const usage = measureTree(
      fs.readdirSync(data.worktree).map((name) => ({
        path: path.join(data.worktree, name),
        relative: name,
      })),
      clean,
    );

    let targets: CleanupTarget[] = [];
    let estimatedBytes = 0;
    let cleanupError: string | null = null;
    try {
      const planned = buildCleanupPlan(data.worktree, clean);
      targets = planned.targets;
      estimatedBytes = planned.estimatedBytes;
    } catch (error) {
      cleanupError = message(error);
    }

    const report = {
      workspace,
      usage,
      clean: {
        configuredPaths: clean,
        paths: targets.map((target) => target.relative),
        estimatedBytes,
        error: cleanupError,
      },
      lastAccessedAt: lastAccessed(data) ?? null,
      suggestions: buildStorageSuggestions(data, usage, estimatedBytes, days),
    };

    if (values.json) {
      json(report);
    } else {
      console.log(
        `Storage: ${sanitizeTerminalText(data.id)} (${sanitizeTerminalText(data.branch)})\n${sanitizeTerminalText(data.worktree)}\n\nTotal: ${size(usage.allocatedBytes)}\nDependencies: ${size(usage.dependenciesBytes)}\nBuilds / caches: ${size(usage.buildsBytes)}\nOther: ${size(usage.otherBytes)}\nConfigured cleanup: ${size(estimatedBytes)} estimated`,
      );
      console.log("\nLargest paths:");
      for (const item of usage.largestPaths.slice(0, 8)) {
        console.log(
          `  ${size(item.allocatedBytes).padStart(12)}  ${sanitizeTerminalText(item.path)}`,
        );
      }
      if (cleanupError) {
        console.log(
          `\nCleanup unavailable: ${sanitizeTerminalText(cleanupError)}`,
        );
      }
      for (const item of report.suggestions) {
        console.log(`\n${item}`);
      }
      console.log(
        "\nApproximate sizes; filesystem sharing can reduce the space actually freed.",
      );
    }
    return 0;
  }

  const dryRun = Boolean(values["dry-run"]);
  const perform = () => {
    const report = cleanWorkspace(context, data.worktree, dryRun);
    if (values.json) {
      json(report);
    } else {
      console.log(
        `${dryRun ? "Cleanup preview" : "Cleanup"}: ${sanitizeTerminalText(data.id)}\n${sanitizeTerminalText(data.worktree)}`,
      );
      for (const relative of report.paths) {
        console.log(
          `  ${dryRun ? "Would remove" : "Removed"} ${sanitizeTerminalText(relative)}`,
        );
      }
      console.log(
        `Estimated ${dryRun ? "space to free" : "cleanup size"}: ${size(report.estimatedBytes)}`,
      );
      if (clean.length === 0) {
        console.log(
          'Configure "clean": ["node_modules", ".next", ".turbo"] in this workspace\'s .rl/workflows.json first.',
        );
      } else if (report.paths.length === 0) {
        console.log("No configured generated directories exist.");
      }
    }
    return 0;
  };

  if (dryRun || clean.length === 0) {
    return perform();
  }
  return locked(
    path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
    GIT_WORKFLOW_LOCK,
    perform,
  );
}
