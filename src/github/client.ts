import { execute, git, type CommandResult } from "../common.js";
import { RlError } from "../errors.js";
import { parseJsonObject } from "../json.js";

export const DEFAULT_GH_TIMEOUT_MS = 20_000;

export interface GhExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  abortGraceMs?: number;
  processGroup?: boolean;
  offlineMessage?: string;
}

export interface GitHubRepositoryIdentity {
  name: string;
  owner: string;
  repo: string;
  host: string;
  url: string;
}

export function cleanGhEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, GH_PROMPT_DISABLED: "1" };
  delete env.GH_REPO;
  return env;
}

export function normalizeGitRemoteHostPath(remoteUrl: string): string {
  return remoteUrl
    .replace(/^https:\/\//, "")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export async function runGh(
  cwd: string,
  argv: string[],
  options: GhExecOptions = {},
): Promise<CommandResult> {
  if (process.env.RL_PR_OFFLINE === "1") {
    throw new RlError(
      options.offlineMessage ?? "GitHub is offline (RL_PR_OFFLINE=1)",
    );
  }
  return execute(["gh", ...argv], cwd, {
    timeoutMs: options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
    env: cleanGhEnvironment(),
    signal: options.signal,
    maxOutputBytes: options.maxOutputBytes,
    abortGraceMs: options.abortGraceMs,
    processGroup: options.processGroup,
  });
}

export async function resolveGitHubRepository(
  cwd: string,
  options: {
    verifyOrigin?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<GitHubRepositoryIdentity> {
  const result = await runGh(
    cwd,
    ["repo", "view", "--json", "nameWithOwner,url"],
    {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    },
  );
  if (result.code !== 0) {
    throw new RlError(
      result.stderr.trim() || "Cannot determine GitHub repository",
    );
  }

  const raw = parseJsonObject(result.stdout);
  if (
    typeof raw.nameWithOwner !== "string" ||
    typeof raw.url !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(raw.nameWithOwner)
  ) {
    throw new RlError("Invalid GitHub repository identity");
  }

  const [owner, repo, extra] = raw.nameWithOwner.split("/");
  const cleanUrl = raw.url.replace(/\/+$/, "");
  const parsed = new URL(cleanUrl);
  if (
    !owner ||
    !repo ||
    extra ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== `/${raw.nameWithOwner}`
  ) {
    throw new RlError("Invalid GitHub repository URL");
  }

  if (options.verifyOrigin) {
    const originUrl = git(cwd, "remote", "get-url", "origin");
    const expected = `${parsed.host}/${raw.nameWithOwner}`.toLowerCase();
    if (normalizeGitRemoteHostPath(originUrl) !== expected) {
      throw new RlError("GitHub repository identity does not match origin");
    }
  }

  return {
    name: raw.nameWithOwner,
    owner,
    repo,
    host: parsed.host,
    url: cleanUrl,
  };
}

export function extractGhApiError(stdout: string, stderr: string): string {
  try {
    const response = parseJsonObject(stdout);
    if (typeof response.message === "string" && response.message) {
      return response.message;
    }
  } catch {
    // Transport or CLI errors may write plain text to stderr only.
  }
  return stderr.trim() || "GitHub request failed";
}

export function classifyPrUpdateFailure(
  errorMessage: string,
  httpStatus?: number,
): "conflict" | "changed" | "failed" {
  if (
    httpStatus === 422 &&
    /(?:head|sha).*(?:changed|modified|match|expected)|(?:changed|modified).*(?:head|sha)/i.test(
      errorMessage,
    )
  ) {
    return "changed";
  }
  if (httpStatus === 409 && /\bconflicts?\b/i.test(errorMessage)) {
    return "conflict";
  }
  if (/\bconflicts?\b/i.test(errorMessage)) {
    return "conflict";
  }
  if (
    /(?:head|sha).*(?:changed|modified|match|expected)|(?:changed|modified).*(?:head|sha)/i.test(
      errorMessage,
    )
  ) {
    return "changed";
  }
  return "failed";
}
