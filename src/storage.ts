import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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
import { commandContext, contextOptions } from "./command-context.js";
import { lastAccessed } from "./access.js";
import { protectedCleanupName } from "./cleanup-path.js";
import { containedPath, readWorkflowConfig } from "./workflow-config.js";
import {
  assertReady,
  GIT_WORKFLOW_DIRECTORY,
  GIT_WORKFLOW_LOCK,
} from "./git-safety.js";
import type { Instance } from "./store.js";

const DEPENDENCIES = new Set(["node_modules", ".venv", "venv"]);
const BUILDS = new Set([
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  ".vite",
  "out",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".parcel-cache",
  ".svelte-kit",
]);
type Category = "dependenciesBytes" | "buildsBytes" | "otherBytes";
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
interface Target {
  path: string;
  relative: string;
  dev: number;
  ino: number;
  usage: Usage;
}
const visible = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function size(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${i ? bytes.toFixed(1) : bytes} ${units[i]}`;
}
function category(relative: string, clean: string[]): Category {
  const parts = relative.split(path.sep);
  if (parts.some((part) => DEPENDENCIES.has(part))) return "dependenciesBytes";
  if (
    parts.some((part) => BUILDS.has(part)) ||
    clean.some(
      (item) => relative === item || relative.startsWith(item + path.sep),
    )
  )
    return "buildsBytes";
  return "otherBytes";
}

/** Read only this directory tree. Never follow symlinks or enter Git metadata. */
function measure(
  roots: { path: string; relative: string }[],
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
  const pending = [...roots];
  while (pending.length) {
    const item = pending.pop()!;
    const name = path.basename(item.path);
    if (protect && protectedCleanupName(name))
      throw new Error(
        `Cleanup contains protected metadata or credentials: ${item.relative}`,
      );
    if (!protect && name === ".git") continue;
    const stat = fs.lstatSync(item.path);
    const bytes = stat.blocks * 512;
    const kind = category(item.relative, clean);
    let counted = true;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(item.path).sort().reverse())
        pending.push({
          path: path.join(item.path, child),
          relative: path.join(item.relative, child),
        });
      usage.estimatedBytes += bytes;
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      if (stat.isSymbolicLink()) usage.symlinks++;
      else usage.files++;
      usage.logicalBytes += stat.size;
      if (stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`;
        const previous = links.get(key);
        if (previous) {
          previous.seen++;
          counted = false;
        } else links.set(key, { bytes, seen: 1, count: stat.nlink });
      } else usage.estimatedBytes += bytes;
    } else if (protect)
      throw new Error(`Cleanup contains a special file: ${item.relative}`);
    if (counted) {
      usage.allocatedBytes += bytes;
      usage[kind] += bytes;
      const top = item.relative.split(path.sep)[0];
      if (top) largest.set(top, (largest.get(top) ?? 0) + bytes);
    }
  }
  for (const link of links.values())
    if (link.seen >= link.count) usage.estimatedBytes += link.bytes;
  usage.largestPaths = [...largest]
    .map(([path, allocatedBytes]) => ({ path, allocatedBytes }))
    .sort(
      (a, b) =>
        b.allocatedBytes - a.allocatedBytes || a.path.localeCompare(b.path),
    );
  return usage;
}
function roots(clean: string[]): string[] {
  const sorted = [...new Set(clean)].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  return sorted.filter(
    (item, index) =>
      !sorted.slice(0, index).some((parent) => item.startsWith(parent + "/")),
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
  )
    throw new Error(`Cleanup path contains tracked files: ${relative}`);
  try {
    git(workspace, "check-ignore", "--no-index", "--", relative + "/");
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
  )
    throw new Error(`Cleanup path contains non-ignored files: ${relative}`);
}
function plan(workspace: string, clean: string[]): Target[] {
  return roots(clean).flatMap((relative) => {
    const target = containedPath(workspace, relative);
    if (!fs.existsSync(target)) return [];
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory())
      throw new Error(`Cleanup target must be a directory: ${relative}`);
    validateIgnored(workspace, relative);
    const cwd = canonical(process.cwd());
    if (cwd === target || inside(cwd, target))
      throw new Error(
        `Cleanup would remove the current directory: ${relative}. Change to the workspace root first`,
      );
    return [
      {
        path: target,
        relative,
        dev: stat.dev,
        ino: stat.ino,
        usage: measure([{ path: target, relative }], clean, true),
      },
    ];
  });
}
function verifyTarget(workspace: string, target: Target): void {
  const current = containedPath(workspace, target.relative);
  const stat = fs.lstatSync(current);
  if (!stat.isDirectory() || stat.dev !== target.dev || stat.ino !== target.ino)
    throw new Error(
      `Cleanup directory changed during inspection: ${target.relative}`,
    );
  validateIgnored(workspace, target.relative);
}

/** Stage within the current workspace before deletion; validation failures restore artifacts. */
function remove(
  workspace: string,
  targets: Target[],
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
  const staged: { target: Target; path: string }[] = [];
  const removed: string[] = [];
  try {
    for (const target of targets) {
      recheck();
      verifyTarget(workspace, target);
      const destination = path.join(holding, String(staged.length));
      fs.renameSync(target.path, destination);
      staged.push({ target, path: destination });
      const stat = fs.lstatSync(destination);
      if (
        stat.dev !== target.dev ||
        stat.ino !== target.ino ||
        !stat.isDirectory()
      )
        throw new Error("Cleanup directory changed while staging");
      // Recheck credentials/metadata added while the initial plan was being built.
      measure([{ path: destination, relative: target.relative }], [], true);
    }
    recheck();
    for (const item of staged) validateIgnored(workspace, item.target.relative);
    for (const item of staged) {
      recheck();
      if (!holdingValid()) throw new Error("Cleanup staging directory changed");
      const stagedIdentity = fs.lstatSync(item.path);
      if (
        !stagedIdentity.isDirectory() ||
        stagedIdentity.dev !== item.target.dev ||
        stagedIdentity.ino !== item.target.ino
      )
        throw new Error("Cleanup artifact changed before removal");
      fs.rmSync(item.path, { recursive: true });
      removed.push(item.target.relative);
    }
    return removed;
  } catch (error) {
    // A replaced staging path must never redirect rollback into another directory.
    if (!holdingValid())
      throw new Error(
        `${message(error)}. Staging path changed; inspect retained artifacts in the current workspace`,
      );
    for (const item of staged.reverse()) {
      if (!fs.existsSync(item.path)) continue;
      try {
        containedPath(workspace, item.target.relative);
        if (!fs.existsSync(item.target.path))
          fs.renameSync(item.path, item.target.path);
      } catch {
        /* Preserve artifacts in the staging directory on restore failure. */
      }
    }
    throw new Error(
      `${message(error)}${fs.readdirSync(holding).length ? `. Remaining artifacts retained at ${holding}` : ""}`,
    );
  } finally {
    if (holdingValid() && !fs.readdirSync(holding).length)
      fs.rmdirSync(holding);
  }
}
function suggestions(
  data: Instance,
  usage: Usage,
  estimatedBytes: number,
  days: number,
): string[] {
  const result: string[] = [];
  if (estimatedBytes)
    result.push(
      `Run rl clean --dry-run to preview ${size(estimatedBytes)} of configured generated files.`,
    );
  else if (usage.dependenciesBytes || usage.buildsBytes)
    result.push(
      "Add generated directory paths to the clean list in this workspace's .rl/workflows.json.",
    );
  const accessed = lastAccessed(data);
  if (accessed && Date.now() - Date.parse(accessed) >= days * 86_400_000)
    result.push(`This workspace has not been used for at least ${days} days.`);
  if (String(data.pr?.state).toUpperCase() === "MERGED")
    result.push(
      "The cached PR is merged. Consider deleting this workspace when finished.",
    );
  return result;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    [...contextOptions, "older-than"],
    ["json", "dry-run"],
  );
  const [command, ...rest] = positionals;
  arity(rest, 0);
  if (
    !["storage", "clean"].includes(command) ||
    (command === "storage" && values["dry-run"]) ||
    (command === "clean" && values["older-than"] !== undefined)
  )
    throw new Error(
      "Usage: rl storage [--json] [--older-than 14d] | rl clean [--dry-run] [--json] (current workspace only)",
    );
  const context = commandContext(values);
  // Resolve from the caller's cwd before any scan, lock creation, or mutation.
  const [file, data] = context.store.current();
  const workspaceIdentity = fs.lstatSync(data.worktree);
  const clean = readWorkflowConfig(data.worktree).clean;
  const workspace = { id: data.id, branch: data.branch, path: data.worktree };
  const days = Number(String(values["older-than"] ?? "14d").replace(/d$/, ""));
  if (!Number.isInteger(days) || days < 1 || days > 36500)
    throw new Error(
      "--older-than must be a positive number of days, such as 14d",
    );
  if (command === "storage") {
    const usage = measure(
      fs.readdirSync(data.worktree).map((name) => ({
        path: path.join(data.worktree, name),
        relative: name,
      })),
      clean,
    );
    let targets: Target[] = [],
      cleanupError: string | null = null;
    try {
      targets = plan(data.worktree, clean);
    } catch (error) {
      cleanupError = message(error);
    }
    const estimatedBytes = targets.length
      ? measure(
          targets.map((target) => ({
            path: target.path,
            relative: target.relative,
          })),
          clean,
          true,
        ).estimatedBytes
      : 0;
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
      suggestions: suggestions(data, usage, estimatedBytes, days),
    };
    if (values.json) json(report);
    else {
      console.log(
        `Storage: ${visible(data.id)} (${visible(data.branch)})\n${visible(data.worktree)}\n\nTotal: ${size(usage.allocatedBytes)}\nDependencies: ${size(usage.dependenciesBytes)}\nBuilds / caches: ${size(usage.buildsBytes)}\nOther: ${size(usage.otherBytes)}\nConfigured cleanup: ${size(estimatedBytes)} estimated`,
      );
      console.log("\nLargest paths:");
      for (const item of usage.largestPaths.slice(0, 8))
        console.log(
          `  ${size(item.allocatedBytes).padStart(12)}  ${visible(item.path)}`,
        );
      if (cleanupError)
        console.log(`\nCleanup unavailable: ${visible(cleanupError)}`);
      for (const item of report.suggestions) console.log(`\n${item}`);
      console.log(
        "\nApproximate sizes; filesystem sharing can reduce the space actually freed.",
      );
    }
    return 0;
  }
  const recheck = () => {
    const currentIdentity = fs.lstatSync(data.worktree);
    if (
      !currentIdentity.isDirectory() ||
      currentIdentity.dev !== workspaceIdentity.dev ||
      currentIdentity.ino !== workspaceIdentity.ino ||
      canonical(data.worktree) !== data.worktree
    )
      throw new Error("Current workspace directory changed during cleanup");
    const [currentFile, current] = context.store.current();
    if (currentFile !== file || current.key !== data.key)
      throw new Error("Current RL workspace changed during cleanup");
    assertReady(data.worktree, false, data.branch);
  };
  const perform = () => {
    recheck();
    const currentClean = readWorkflowConfig(data.worktree).clean;
    if (JSON.stringify(currentClean) !== JSON.stringify(clean))
      throw new Error("Cleanup configuration changed; retry");
    const targets = plan(data.worktree, clean);
    const estimatedBytes = targets.length
      ? measure(
          targets.map((target) => ({
            path: target.path,
            relative: target.relative,
          })),
          clean,
          true,
        ).estimatedBytes
      : 0;
    const removedPaths =
      !values["dry-run"] && targets.length
        ? remove(data.worktree, targets, recheck)
        : [];
    const report = {
      workspace,
      dryRun: !!values["dry-run"],
      paths: targets.map((target) => target.relative),
      estimatedBytes,
      removedPaths,
    };
    if (values.json) json(report);
    else {
      console.log(
        `${values["dry-run"] ? "Cleanup preview" : "Cleanup"}: ${visible(data.id)}\n${visible(data.worktree)}`,
      );
      for (const target of targets)
        console.log(
          `  ${values["dry-run"] ? "Would remove" : "Removed"} ${visible(target.relative)} (${size(target.usage.allocatedBytes)})`,
        );
      console.log(
        `Estimated ${values["dry-run"] ? "space to free" : "cleanup size"}: ${size(estimatedBytes)}`,
      );
      if (!clean.length)
        console.log(
          'Configure "clean": ["node_modules", ".next", ".turbo"] in this workspace\'s .rl/workflows.json first.',
        );
      else if (!targets.length)
        console.log("No configured generated directories exist.");
    }
    return 0;
  };
  // A preview does not create locks or write RL state.
  return values["dry-run"] || !clean.length
    ? perform()
    : locked(
        path.join(context.store.root, GIT_WORKFLOW_DIRECTORY),
        GIT_WORKFLOW_LOCK,
        perform,
      );
}
