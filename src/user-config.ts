import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { expandHome, gitEnv, object, run } from "./common.js";
import { RlError, StateValidationError } from "./errors.js";
import { parseJsonObject } from "./json.js";

export interface UserConfigValues {
  repoRoot?: string;
  worktreeDir?: string;
  repoName?: string;
  defaultBase?: string;
  stateDir?: string;
  repo?: string;
}

export interface ResolvedCliEnvironment {
  repoRoot: string;
  worktreeDir: string;
  repoName: string;
  defaultBase: string;
  stateDir: string;
  selectedRepo: string;
}

const KEY_MAP: Readonly<Record<string, keyof UserConfigValues>> = {
  repoRoot: "repoRoot",
  RL_REPO_ROOT: "repoRoot",
  worktreeDir: "worktreeDir",
  RL_WORKTREE_DIR: "worktreeDir",
  repoName: "repoName",
  RL_REPO_NAME: "repoName",
  defaultBase: "defaultBase",
  RL_DEFAULT_BASE: "defaultBase",
  stateDir: "stateDir",
  RL_STATE_DIR: "stateDir",
  repo: "repo",
  RL_REPO: "repo",
};

const PATH_KEYS = new Set<keyof UserConfigValues>([
  "repoRoot",
  "worktreeDir",
  "stateDir",
]);

function expandConfigPath(value: string, home: string): string {
  if (value === "~" || value === "$HOME" || value === "${HOME}") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  if (value.startsWith("$HOME/")) {
    return path.join(home, value.slice(6));
  }
  if (value.startsWith("${HOME}/")) {
    return path.join(home, value.slice(8));
  }
  return expandHome(value);
}

function normalizeConfigObject(
  raw: Record<string, unknown>,
  file: string,
  home: string,
): UserConfigValues {
  const result: UserConfigValues = {};

  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const mapped = Object.hasOwn(KEY_MAP, rawKey) ? KEY_MAP[rawKey] : undefined;
    if (!mapped) {
      throw new StateValidationError(
        `Unknown configuration key '${rawKey}' in ${file}`,
      );
    }
    if (typeof rawValue !== "string") {
      throw new StateValidationError(
        `Configuration key '${rawKey}' in ${file} must be a string`,
      );
    }
    result[mapped] = PATH_KEYS.has(mapped)
      ? expandConfigPath(rawValue, home)
      : rawValue;
  }

  return result;
}

/**
 * Parse legacy key=value lines declaratively without invoking a shell.
 * Rejects command substitutions, backticks, or arbitrary shell syntax.
 */
function parseLegacyDeclarativeZsh(
  text: string,
  file: string,
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      throw new StateValidationError(
        `Legacy zsh scripting is not supported in ${file}; migrate settings to declarative config.toml`,
      );
    }

    const [, key, rhsRaw] = match;
    let rhs = rhsRaw.trim();

    if (rhs.startsWith('"')) {
      const closing = rhs.indexOf('"', 1);
      if (
        closing < 0 ||
        rhs
          .slice(closing + 1)
          .trim()
          .replace(/^#.*$/, "") !== ""
      ) {
        throw new StateValidationError(
          `Unsupported quoting in ${file}; migrate settings to config.toml`,
        );
      }
      rhs = rhs.slice(1, closing);
      if (rhs.includes("$(") || rhs.includes("`")) {
        throw new StateValidationError(
          `Shell command substitution is not supported in ${file}; migrate settings to config.toml`,
        );
      }
    } else if (rhs.startsWith("'")) {
      const closing = rhs.indexOf("'", 1);
      if (
        closing < 0 ||
        rhs
          .slice(closing + 1)
          .trim()
          .replace(/^#.*$/, "") !== ""
      ) {
        throw new StateValidationError(
          `Unsupported quoting in ${file}; migrate settings to config.toml`,
        );
      }
      rhs = rhs.slice(1, closing);
    } else {
      rhs = rhs.replace(/\s+#.*$/, "").trim();
      if (
        /[$`|;&<>(){}[\]*?]/.test(rhs) &&
        !/^\$(?:HOME|\{HOME\})(?:\/[\w./-]*)?$/.test(rhs)
      ) {
        throw new StateValidationError(
          `Shell expansion is not supported in ${file}; migrate settings to config.toml`,
        );
      }
    }

    entries[key] = rhs;
  }

  return entries;
}

export function loadUserConfig(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): UserConfigValues {
  const explicit = env.RL_CONFIG;
  let file: string | undefined;

  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new RlError(`Configuration not found: ${explicit}`);
    }
    file = explicit;
  } else {
    const configBase = path.join(
      env.XDG_CONFIG_HOME || path.join(home, ".config"),
      "rl",
    );
    file = [
      path.join(configBase, "config.toml"),
      path.join(configBase, "config.json"),
      path.join(configBase, "config.zsh"),
    ].find((candidate) => fs.existsSync(candidate));
  }

  if (!file) {
    return {};
  }

  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new StateValidationError(
      `Expected a regular configuration file: ${file}`,
    );
  }

  const content = fs.readFileSync(file, "utf8");
  const extension = path.extname(file).toLowerCase();

  let parsed: unknown;
  if (extension === ".json") {
    parsed = parseJsonObject(content);
  } else if (extension === ".zsh") {
    parsed = parseLegacyDeclarativeZsh(content, file);
  } else {
    try {
      parsed = parseToml(content);
    } catch (error) {
      if (!explicit) {
        throw new StateValidationError(
          `Invalid TOML configuration in ${file}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      // Custom RL_CONFIG paths without an extension may still hold declarative KEY=VALUE lines.
      parsed = parseLegacyDeclarativeZsh(content, file);
    }
  }

  if (!object(parsed)) {
    throw new StateValidationError(`Expected a configuration table in ${file}`);
  }

  return normalizeConfigObject(parsed, file, home);
}

export function detectCurrentRepositoryRoot(cwd = process.cwd()): string {
  try {
    const output = run(
      ["git", "-C", cwd, "worktree", "list", "--porcelain", "-z"],
      cwd,
      true,
    );
    const firstRecord = output.split("\0")[0] ?? "";
    if (firstRecord.startsWith("worktree ")) {
      return firstRecord.slice("worktree ".length);
    }
  } catch {
    // Commands like `rl repo` or `rl checkout` may run outside any Git checkout.
  }
  return cwd;
}

export function resolveCliEnvironment(
  explicitRepo: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ResolvedCliEnvironment {
  const home = os.homedir();
  const config = loadUserConfig(env, home);

  const repoRoot =
    (env.RL_REPO_ROOT ? expandConfigPath(env.RL_REPO_ROOT, home) : undefined) ||
    config.repoRoot ||
    detectCurrentRepositoryRoot(cwd);

  const worktreeDir =
    (env.RL_WORKTREE_DIR
      ? expandConfigPath(env.RL_WORKTREE_DIR, home)
      : undefined) ||
    config.worktreeDir ||
    path.join(home, ".rl/worktrees");

  const repoName =
    env.RL_REPO_NAME || config.repoName || path.basename(repoRoot);

  const defaultBase =
    env.RL_DEFAULT_BASE || config.defaultBase || "origin/test";

  const stateDir =
    (env.RL_STATE_DIR ? expandConfigPath(env.RL_STATE_DIR, home) : undefined) ||
    config.stateDir ||
    path.join(home, ".rl/instances");

  const selectedRepo =
    explicitRepo !== undefined
      ? explicitRepo
      : Object.hasOwn(env, "RL_REPO")
        ? (env.RL_REPO ?? "")
        : (config.repo ?? "");

  if (
    !path.isAbsolute(repoRoot) ||
    !path.isAbsolute(worktreeDir) ||
    !path.isAbsolute(stateDir)
  ) {
    throw new RlError(
      "Repository, worktree, and state directories must be absolute paths.",
    );
  }

  if (
    !repoName ||
    repoName.includes("/") ||
    repoName === "." ||
    repoName === ".."
  ) {
    throw new RlError("RL_REPO_NAME must be a single directory name.");
  }

  return {
    repoRoot,
    worktreeDir,
    repoName,
    defaultBase,
    stateDir,
    selectedRepo,
  };
}

export { gitEnv };
