import fs from "node:fs";
import path from "node:path";
import { activityView } from "./activity.js";
import { agentAdapter } from "./agent-registry.js";
import { resumeSessions } from "./agent-resume.js";
import { workflowSummary } from "./agent-runner.js";
import { syncCodexSessions } from "./codex-sessions.js";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  json,
  message,
  now,
  object,
  required,
} from "./common.js";
import { prText, statusText } from "./display.js";
import { doctor } from "./doctor.js";
import { UsageError } from "./errors.js";
import { gitCommonDir } from "./git/base.js";
import {
  resolveGitHubRepository,
  runGh,
  type GitHubRepositoryIdentity,
} from "./github/client.js";
import { handleHook } from "./hooks.js";
import { parseJson, parseJsonObject } from "./json.js";
import { readCachedBranchPr, writeCachedBranchPr } from "./pr-discovery.js";
import { github } from "./pr-workflow.js";
import { currentSessionId } from "./session.js";
import { type Agent, branchStatus, type Instance, Store } from "./store.js";
import { detectCurrentRepositoryRoot } from "./user-config.js";

function parseAgent(value: string): Agent {
  return agentAdapter(value).name;
}

const SYNC_PR_FIELDS =
  "number,url,state,title,headRefName,baseRefName,isDraft,updatedAt";
const SYNC_PR_FIELD_LIST = SYNC_PR_FIELDS.split(",");
const VIEW_PR_FIELDS = `${SYNC_PR_FIELDS},isCrossRepository`;
const LIST_PR_FIELDS = `${SYNC_PR_FIELDS},headRefOid,baseRefOid,isCrossRepository`;
const TRUNK_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "test",
  "staging",
  "production",
  "trunk",
]);

interface PrWorktreeContext {
  worktree: string;
  branch: string;
  file: string | null;
  data: Instance | null;
  savedPr: Instance["pr"];
}

interface ParsedPrCandidate {
  snapshot: NonNullable<Instance["pr"]>;
  isCrossRepository: boolean;
  headRefOid?: string;
  baseRefOid?: string;
}

type BranchPrResolution =
  | { kind: "found"; pr: NonNullable<Instance["pr"]> }
  | { kind: "missing"; message: string }
  | { kind: "unavailable"; error: Error; nonZeroExit: boolean };

function resolvePrStore(store: Store, cwd = process.cwd()): Store {
  if (process.env.RL_REPO || process.env.RL_REPO_ROOT) {
    return store;
  }
  try {
    if (gitCommonDir(cwd) !== gitCommonDir(store.repo)) {
      return new Store(detectCurrentRepositoryRoot(cwd), store.stateDir);
    }
  } catch {
    // Let store.worktree() report non-Git directory errors.
  }
  return store;
}

function resolveWorktreeContext(
  store: Store,
  cwd = process.cwd(),
): PrWorktreeContext {
  const [worktree, branch] = store.worktree(cwd);
  for (const [file, data] of store.records()) {
    if (
      data.status === "active" &&
      data.worktree === worktree &&
      data.branch === branch
    ) {
      return {
        worktree,
        branch,
        file,
        data,
        savedPr: data.pr ?? readCachedBranchPr(store, branch),
      };
    }
  }
  return {
    worktree,
    branch,
    file: null,
    data: null,
    savedPr: readCachedBranchPr(store, branch),
  };
}

function validateSavedPrUrl(urlText: string): void {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Invalid saved PR URL; run rl pr sync to refresh");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !/\/pull\/[1-9]\d*$/.test(url.pathname)
  ) {
    throw new Error("Invalid saved PR URL; run rl pr sync to refresh");
  }
}

async function persistResolvedPr(
  store: Store,
  context: PrWorktreeContext,
  pr: NonNullable<Instance["pr"]>,
): Promise<void> {
  await store.locked(() => {
    if (context.file) {
      const current = resolveWorktreeContext(store, context.worktree);
      if (current.file !== context.file || !current.data) {
        throw new Error("Instance changed while fetching PR state");
      }
      current.data.pr = pr;
      store.save(context.file, current.data);
    }
    if (typeof pr.headRefName === "string" && pr.headRefName) {
      writeCachedBranchPr(
        store,
        pr.headRefName,
        pr,
        typeof pr.syncedAt === "string" ? pr.syncedAt : now(),
      );
    }
  });
}

async function upstreamHeadBranch(
  worktree: string,
  branch: string,
  baseBranch?: string,
): Promise<string | null> {
  const [remoteRes, mergeRes, originHeadRes] = await Promise.all([
    execute(["git", "config", "--get", `branch.${branch}.remote`], worktree),
    execute(["git", "config", "--get", `branch.${branch}.merge`], worktree),
    execute(
      ["git", "symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
      worktree,
    ),
  ]);
  if (remoteRes.code !== 0 || mergeRes.code !== 0) {
    return null;
  }
  if (remoteRes.stdout.trim() !== "origin") {
    return null;
  }
  const mergeRef = mergeRes.stdout.trim();
  if (!mergeRef.startsWith("refs/heads/")) {
    return null;
  }
  const remoteBranch = mergeRef.slice("refs/heads/".length).trim();
  if (!remoteBranch || remoteBranch === branch) {
    return null;
  }
  if (remoteBranch.toLowerCase() === branch.toLowerCase()) {
    return remoteBranch;
  }

  const excluded = new Set<string>(TRUNK_BRANCHES);
  if (baseBranch) {
    excluded.add(baseBranch.replace(/^origin\//, "").toLowerCase());
  }
  if (originHeadRes.code === 0) {
    const symref = originHeadRes.stdout
      .trim()
      .replace(/^refs\/remotes\/origin\//, "");
    if (symref) {
      excluded.add(symref.toLowerCase());
    }
  }
  if (excluded.has(remoteBranch.toLowerCase())) {
    return null;
  }
  return remoteBranch;
}

function parsePrCandidate(
  raw: unknown,
  prefix: string,
  expectedRepoName: string,
  syncedAt: string,
): ParsedPrCandidate {
  if (!object(raw) || SYNC_PR_FIELD_LIST.some((field) => !(field in raw))) {
    throw new Error("GitHub returned incomplete PR metadata");
  }
  if (typeof raw.url !== "string" || !raw.url.startsWith(prefix)) {
    throw new Error("PR does not belong to this GitHub repository");
  }

  let isCrossRepository = raw.isCrossRepository === true;
  if ("headRepository" in raw && raw.headRepository === null) {
    isCrossRepository = true;
  } else if (
    object(raw.headRepository) &&
    typeof raw.headRepository.nameWithOwner === "string" &&
    raw.headRepository.nameWithOwner.toLowerCase() !==
      expectedRepoName.toLowerCase()
  ) {
    isCrossRepository = true;
  } else if (
    object(raw.headRepositoryOwner) &&
    typeof raw.headRepositoryOwner.login === "string" &&
    object(raw.headRepository) &&
    typeof raw.headRepository.name === "string" &&
    `${raw.headRepositoryOwner.login}/${raw.headRepository.name}`.toLowerCase() !==
      expectedRepoName.toLowerCase()
  ) {
    isCrossRepository = true;
  }

  return {
    snapshot: {
      number: raw.number,
      url: raw.url,
      state: raw.state,
      title: raw.title,
      headRefName: raw.headRefName,
      baseRefName: raw.baseRefName,
      isDraft: raw.isDraft,
      updatedAt: raw.updatedAt,
      syncedAt,
    },
    isCrossRepository,
    headRefOid: typeof raw.headRefOid === "string" ? raw.headRefOid : undefined,
    baseRefOid: typeof raw.baseRefOid === "string" ? raw.baseRefOid : undefined,
  };
}

function selectPreferredCandidate(
  candidates: ParsedPrCandidate[],
): NonNullable<Instance["pr"]> | null {
  const local = candidates.filter((item) => !item.isCrossRepository);
  if (local.length === 0) {
    return null;
  }
  const open = local.find(
    (item) => String(item.snapshot.state).toUpperCase() === "OPEN",
  );
  return (open ?? local[0]).snapshot;
}

async function listBranchCandidates(
  worktree: string,
  repoSlug: string,
  prefix: string,
  expectedRepoName: string,
  syncedAt: string,
  headBranch?: string,
): Promise<ParsedPrCandidate[] | null> {
  const result = await runGh(worktree, [
    "pr",
    "list",
    "--repo",
    repoSlug,
    ...(headBranch ? ["--head", headBranch] : []),
    "--state",
    "all",
    "--limit",
    headBranch ? "30" : "100",
    "--json",
    headBranch ? VIEW_PR_FIELDS : LIST_PR_FIELDS,
  ]);
  if (result.code !== 0) {
    return null;
  }
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const candidates: ParsedPrCandidate[] = [];
  for (const item of parsed) {
    try {
      candidates.push(
        parsePrCandidate(item, prefix, expectedRepoName, syncedAt),
      );
    } catch {
      // Ignore malformed list items from non-matching stubs.
    }
  }
  return candidates;
}

async function viewBranchCandidate(
  worktree: string,
  selector: string,
  repository: GitHubRepositoryIdentity,
  syncedAt: string,
  expectedBranch?: string,
): Promise<
  | { status: "found"; pr: NonNullable<Instance["pr"]> }
  | { status: "not_found"; stderr: string }
  | { status: "error"; error: Error; nonZeroExit: boolean }
> {
  const repoSlug = `${repository.host}/${repository.name}`;
  const prefix = `${repository.url}/pull/`;
  const result = await runGh(worktree, [
    "pr",
    "view",
    selector,
    "--repo",
    repoSlug,
    "--json",
    VIEW_PR_FIELDS,
  ]);
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (/no pull requests? found/i.test(stderr)) {
      return { status: "not_found", stderr };
    }
    return {
      status: "error",
      error: new Error(stderr || "Could not load PR metadata"),
      nonZeroExit: true,
    };
  }

  let candidate: ParsedPrCandidate;
  try {
    candidate = parsePrCandidate(
      parseJsonObject(result.stdout),
      prefix,
      repository.name,
      syncedAt,
    );
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error : new Error(message(error)),
      nonZeroExit: false,
    };
  }

  if (
    !candidate.isCrossRepository &&
    (!expectedBranch ||
      String(candidate.snapshot.headRefName).toLowerCase() ===
        expectedBranch.toLowerCase())
  ) {
    return { status: "found", pr: candidate.snapshot };
  }

  if (expectedBranch) {
    const listed = await listBranchCandidates(
      worktree,
      repoSlug,
      prefix,
      repository.name,
      syncedAt,
      expectedBranch,
    );
    const preferred = listed ? selectPreferredCandidate(listed) : null;
    if (preferred) {
      return { status: "found", pr: preferred };
    }
  }

  return {
    status: "not_found",
    stderr: `No pull requests found for branch "${expectedBranch ?? selector}"`,
  };
}

async function isCommitAheadOfBase(
  worktree: string,
  headOid: string,
  pr: ParsedPrCandidate,
  context: PrWorktreeContext,
): Promise<boolean> {
  if (context.data?.reviewBaseCommit === headOid) {
    return false;
  }
  if (pr.baseRefOid) {
    if (pr.baseRefOid === headOid) {
      return false;
    }
    const check = await execute(
      ["git", "merge-base", "--is-ancestor", headOid, pr.baseRefOid],
      worktree,
    );
    if (check.code === 0) {
      return false;
    }
    if (check.code === 1) {
      return true;
    }
  }
  const baseRef =
    typeof pr.snapshot.baseRefName === "string"
      ? `origin/${pr.snapshot.baseRefName}`
      : context.data?.baseBranch;
  if (baseRef) {
    const check = await execute(
      ["git", "merge-base", "--is-ancestor", headOid, baseRef],
      worktree,
    );
    if (check.code === 0) {
      return false;
    }
  }
  return true;
}

async function resolveCurrentBranchPr(
  context: PrWorktreeContext,
  strictJsonErrors = false,
): Promise<BranchPrResolution> {
  let repository: GitHubRepositoryIdentity;
  try {
    repository = await resolveGitHubRepository(context.worktree);
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error ? error : new Error(message(error)),
      nonZeroExit:
        !(error instanceof SyntaxError) && !/JSON/i.test(message(error)),
    };
  }

  const syncedAt = now();
  const primary = await viewBranchCandidate(
    context.worktree,
    context.branch,
    repository,
    syncedAt,
    context.branch,
  );
  if (primary.status === "found") {
    return { kind: "found", pr: primary.pr };
  }
  if (primary.status === "error") {
    if (strictJsonErrors) {
      throw primary.error;
    }
    return {
      kind: "unavailable",
      error: primary.error,
      nonZeroExit: primary.nonZeroExit,
    };
  }

  const upstream = await upstreamHeadBranch(
    context.worktree,
    context.branch,
    context.data?.baseBranch,
  );
  if (upstream && upstream !== context.branch) {
    const viaUpstream = await viewBranchCandidate(
      context.worktree,
      upstream,
      repository,
      syncedAt,
      upstream,
    );
    if (viaUpstream.status === "found") {
      return { kind: "found", pr: viaUpstream.pr };
    }
  }

  const savedDifferentHead =
    context.savedPr &&
    typeof context.savedPr.headRefName === "string" &&
    context.savedPr.headRefName !== context.branch
      ? context.savedPr.url
      : undefined;
  const prBranchMatch = /^pr-([1-9]\d*)$/.exec(context.branch);
  const checkoutSelector = savedDifferentHead ?? prBranchMatch?.[1];
  if (checkoutSelector) {
    const viaCheckout = await viewBranchCandidate(
      context.worktree,
      checkoutSelector,
      repository,
      syncedAt,
    );
    if (viaCheckout.status === "found") {
      return { kind: "found", pr: viaCheckout.pr };
    }
  }

  const repoSlug = `${repository.host}/${repository.name}`;
  const prefix = `${repository.url}/pull/`;
  const listed = await listBranchCandidates(
    context.worktree,
    repoSlug,
    prefix,
    repository.name,
    syncedAt,
  );
  if (listed && listed.length > 0) {
    const caseMatches = listed.filter(
      (item) =>
        String(item.snapshot.headRefName).toLowerCase() ===
        context.branch.toLowerCase(),
    );
    const byCase = selectPreferredCandidate(caseMatches);
    if (byCase) {
      return { kind: "found", pr: byCase };
    }

    let localHead = "";
    try {
      localHead = git(context.worktree, "rev-parse", "HEAD");
    } catch {
      localHead = "";
    }
    if (/^[a-f0-9]{40,64}$/.test(localHead)) {
      const openOidMatches: ParsedPrCandidate[] = [];
      for (const item of listed) {
        const headName = String(item.snapshot.headRefName);
        if (
          !item.isCrossRepository &&
          String(item.snapshot.state).toUpperCase() === "OPEN" &&
          item.headRefOid === localHead &&
          !TRUNK_BRANCHES.has(headName.toLowerCase()) &&
          headName !== item.snapshot.baseRefName &&
          (await isCommitAheadOfBase(
            context.worktree,
            localHead,
            item,
            context,
          ))
        ) {
          openOidMatches.push(item);
        }
      }
      if (openOidMatches.length === 1) {
        return { kind: "found", pr: openOidMatches[0].snapshot };
      }
    }
  }

  return {
    kind: "missing",
    message:
      primary.stderr || `No pull requests found for branch "${context.branch}"`,
  };
}

async function syncPr(
  store: Store,
  requested?: string,
  asJson = false,
): Promise<number> {
  const prStore = resolvePrStore(store);
  const context = await prStore.locked(() => resolveWorktreeContext(prStore));

  if (requested !== undefined) {
    if (requested.startsWith("-")) {
      throw new UsageError("PR selector must be a branch, number, or URL");
    }
    const repository = await resolveGitHubRepository(context.worktree);
    const prefix = `${repository.url}/pull/`;
    if (requested.includes("://") && !requested.startsWith(prefix)) {
      throw new Error("PR URL does not belong to this GitHub repository");
    }

    const prResult = await runGh(context.worktree, [
      "pr",
      "view",
      requested,
      "--repo",
      `${repository.host}/${repository.name}`,
      "--json",
      VIEW_PR_FIELDS,
    ]);
    if (prResult.code !== 0) {
      throw new Error(prResult.stderr.trim() || "Could not load PR metadata");
    }

    const candidate = parsePrCandidate(
      parseJsonObject(prResult.stdout),
      prefix,
      repository.name,
      now(),
    );
    if (candidate.isCrossRepository) {
      throw new Error("PR belongs to a fork, not this repository");
    }

    const upstream = await upstreamHeadBranch(
      context.worktree,
      context.branch,
      context.data?.baseBranch,
    );
    const headName = String(candidate.snapshot.headRefName);
    const prNumber = candidate.snapshot.number;
    const matchesBranch =
      headName.toLowerCase() === context.branch.toLowerCase() ||
      (upstream !== null &&
        headName.toLowerCase() === upstream.toLowerCase()) ||
      (context.savedPr !== null && context.savedPr.number === prNumber) ||
      context.branch === `pr-${String(prNumber)}`;

    if (!matchesBranch) {
      throw new Error("PR head branch does not match the RL instance branch");
    }

    await persistResolvedPr(prStore, context, candidate.snapshot);
    if (asJson) {
      json(candidate.snapshot);
    } else {
      console.log(prText(candidate.snapshot));
    }
    return 0;
  }

  const resolved = await resolveCurrentBranchPr(context, true);
  if (resolved.kind === "unavailable") {
    throw resolved.error;
  }
  if (resolved.kind === "missing") {
    throw new Error(resolved.message);
  }

  await persistResolvedPr(prStore, context, resolved.pr);
  if (asJson) {
    json(resolved.pr);
  } else {
    console.log(prText(resolved.pr));
  }
  return 0;
}

async function openPr(store: Store, asJson: boolean): Promise<number> {
  const prStore = resolvePrStore(store);
  const context = await prStore.locked(() => resolveWorktreeContext(prStore));

  if (context.savedPr) {
    validateSavedPrUrl(context.savedPr.url);
  }

  let resolved: BranchPrResolution | null = null;
  if (process.env.RL_PR_OFFLINE !== "1") {
    resolved = await resolveCurrentBranchPr(context, false);
    if (resolved.kind === "found") {
      validateSavedPrUrl(resolved.pr.url);
      await persistResolvedPr(prStore, context, resolved.pr);
    }
  }

  if (asJson) {
    if (resolved?.kind === "found") {
      json(resolved.pr);
      return 0;
    }
    if (resolved?.kind === "missing") {
      json(null);
      return 0;
    }
    if (
      resolved?.kind === "unavailable" &&
      resolved.nonZeroExit &&
      !context.savedPr
    ) {
      throw resolved.error;
    }
    json(context.savedPr);
    return 0;
  }

  if (resolved?.kind === "missing") {
    throw new Error(resolved.message);
  }

  const activePr = resolved?.kind === "found" ? resolved.pr : context.savedPr;

  if (activePr) {
    console.log(prText(activePr));
  } else if (resolved?.kind === "unavailable" && resolved.nonZeroExit) {
    throw resolved.error;
  } else {
    console.log(`Opening PR for ${context.branch}…`);
  }

  try {
    const result = await github(context.worktree, [
      "pr",
      "view",
      activePr?.url ?? context.branch,
      "--web",
    ]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || "Could not open PR in the browser",
      );
    }
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    return 0;
  } catch (error) {
    if (!activePr) {
      throw error;
    }
    console.error(
      `Could not open the browser: ${message(error)}. Use the PR link above.`,
    );
    return 0;
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = args(
    argv,
    ["repo", "state-dir", "worktree", "base"],
    [
      "quiet",
      "fetch",
      "json",
      "repair",
      "extended-hooks",
      "latest",
      "l",
      "workspace",
      "desktop",
    ],
    { latest: "l" },
  );

  const store = new Store(
    required(values, "repo"),
    required(values, "state-dir"),
  );
  const [command, ...rest] = positionals;

  if ((values.latest || values.l) && command !== "resume") {
    throw new UsageError("--latest is only supported by rl resume");
  }
  if (values.desktop && command !== "resume")
    throw new UsageError(
      "--desktop is only supported by rl resume and rl agent start",
    );

  if (command === "adopt") {
    arity(rest, 0, 1);
    if (rest[0] !== undefined && values.worktree !== undefined)
      throw new UsageError("Choose a worktree path or --worktree, not both");
    const [file, data] = await store.adopt(
      String(rest[0] ?? values.worktree ?? "."),
      typeof values.base === "string" ? values.base : undefined,
      values["extended-hooks"] ? true : undefined,
    );
    if (!values.quiet) {
      console.log(
        `RL instance: ${data.id}\nState: ${path.dirname(file)}\nSession hooks installed. In Codex, review and trust them with /hooks.`,
      );
    }
    return 0;
  }

  if (command === "resume") {
    arity(rest, 0, 1);
    return resumeSessions(
      store,
      rest[0] === undefined ? undefined : parseAgent(rest[0]),
      {
        latest: Boolean(values.latest || values.l),
        desktop: Boolean(values.desktop),
      },
    );
  }

  if (command === "doctor") {
    arity(rest, 0, 1);
    if (values.repair) {
      const [, data] = store.current();
      await store.adopt(data.worktree);
    }
    return doctor(store, rest[0], Boolean(values.json));
  }

  if (command === "hook") {
    arity(rest, 2, 3);
    if (rest.length === 3 && rest[1] !== "agy" && rest[1] !== "opencode") {
      throw new UsageError(
        "Only agy and opencode hooks accept an explicit native event",
      );
    }
    return handleHook(store, rest[0], rest[1], rest[2]);
  }

  if (command === "pr" && rest[0] === "sync") {
    arity(rest, 1, 2);
    return syncPr(store, rest[1], Boolean(values.json));
  }

  if (command === "pr" && (!rest.length || rest[0] === "open")) {
    arity(rest, 0, rest[0] === "open" ? 1 : 0);
    return openPr(store, Boolean(values.json));
  }

  if (command === "pr" && rest[0] === "show") {
    arity(rest, 1);
    const prStore = resolvePrStore(store);
    const context = await prStore.locked(() => resolveWorktreeContext(prStore));
    if (values.json) {
      json(context.savedPr);
    } else {
      console.log(prText(context.savedPr));
    }
    return 0;
  }

  if (command === "status") {
    arity(rest, 0);
  }

  if (command === "session" && rest[0] === "list") {
    arity(rest, 1, 2);
    if (rest[1]) {
      parseAgent(rest[1]);
    }
  }

  if (command === "status" && values.fetch) {
    git(store.repo, "fetch", "--all", "--prune");
  }

  if (command === "status" || (command === "session" && rest[0] === "list")) {
    await syncCodexSessions(store, process.cwd());
  }

  let replacement = "";
  if (
    (command === "context" || command === "progress") &&
    (rest[0] === "set" || rest[0] === "append")
  ) {
    arity(rest, 2);
    replacement = fs.readFileSync(rest[1] === "-" ? 0 : rest[1], "utf8");
  }

  return store.locked(() => {
    if (command === "archive") {
      arity(rest, 0);
      const root = canonical(required(values, "worktree"));
      store.archiveWorktrees([root]);
      return 0;
    }

    const [file, data] = store.current();
    if (command === "status") {
      arity(rest, 0);
      const status = {
        ...data,
        activity: {
          codex: activityView(data.activity?.codex),
          claude: activityView(data.activity?.claude),
          ...(data.activity?.agy
            ? { agy: activityView(data.activity.agy) }
            : {}),
          ...(data.activity?.opencode
            ? { opencode: activityView(data.activity.opencode) }
            : {}),
        },
        stateDirectory: path.dirname(file),
        gitStatus: branchStatus(store.repo, data),
        workflow: workflowSummary(store),
      };
      if (values.json) {
        json(status);
      } else {
        console.log(statusText(data, status.gitStatus, status.workflow));
      }
      return 0;
    }

    if (command === "session") {
      if (rest[0] === "save") {
        arity(rest, 1, 3);
        const kind = parseAgent(rest[1] ?? "codex");
        const sid = currentSessionId(kind, rest[2]);
        store.recordSession(file, data, kind, sid);
        if (values.json) {
          json({ agent: kind, sessionId: sid, instance: data.id });
        } else {
          console.log(`Saved ${kind} session ${sid} for ${data.id}`);
        }
        return 0;
      }
      if (rest[0] === "add") {
        arity(rest, 3);
        const kind = parseAgent(rest[1]);
        store.recordSession(file, data, kind, rest[2]);
        console.log(`Associated ${kind} session ${rest[2]} with ${data.id}`);
        return 0;
      }
      if (rest[0] === "list") {
        arity(rest, 1, 2);
        json(
          rest[1] ? (data.sessions[parseAgent(rest[1])] ?? []) : data.sessions,
        );
        return 0;
      }
      throw new UsageError(
        "Usage: rl agent sessions [agent] | save [agent] [UUID]",
      );
    }

    if (command === "context" || command === "progress") {
      const target = path.join(path.dirname(file), `${command}.md`);
      const action = rest[0];
      if (action === "path" || action === "show") {
        arity(rest, 1);
        if (action === "path") {
          console.log(target);
        } else {
          process.stdout.write(store.readDocument(file, command));
        }
        return 0;
      }
      if (action === "set" || action === "append") {
        store.updateDocument(file, data, command, action, replacement);
        return 0;
      }
      throw new UsageError(
        `Usage: rl ${command} show|path|set <file>|append <file>`,
      );
    }

    throw new UsageError("Unknown state command");
  });
}
