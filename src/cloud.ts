import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "./agent-registry.js";
import type { CloudJob } from "./cloud-job-runner.js";
import { accessLabel } from "./access.js";
import { writeWorkspaceOutput } from "./command-context.js";
import {
  args,
  arity,
  canonical,
  execute,
  git,
  gitEnv,
  inside,
  json,
  locked,
  object,
  readJson,
  shellQuote,
  timestamp,
  writeJson,
} from "./common.js";
import { findExecutable } from "./dependencies.js";
import { RlError, UsageError } from "./errors.js";
import {
  type Candidate,
  openPickerWorktree,
  pickerRows,
  prState,
} from "./picker.js";
import { discoverPrs } from "./pr-discovery.js";
import { type OverviewRow, renderOverviewTable, worktrees } from "./repos.js";
import { changedFiles, reviewGit } from "./review-git.js";
import { liveReview } from "./review-live.js";
import { type BranchStatus, type Instance, Store } from "./store.js";
import { padCell, paintAnsi, sanitizeTerminalText } from "./tui/ansi.js";
import { type FzfItem, runFzf } from "./tui/fzf.js";
import { loadUserConfig, resolveCliEnvironment } from "./user-config.js";

const HOST_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,126}[A-Za-z0-9])?$/;
const SUPPORTED_AGENTS = new Set(Object.keys(adapters));

const STATE_COLORS: Readonly<Record<string, number>> = {
  merged: 35,
  open: 32,
  draft: 33,
  closed: 31,
  none: 90,
  unknown: 90,
};

const colorText = (val: string, code: number): string =>
  paintAnsi(val, code, process.env.NO_COLOR === undefined);

export interface CloudRepository {
  name: string;
  root: string;
  base: string;
  worktreeName: string;
  registered: boolean;
  isDefault: boolean;
  originUrl: string | null;
  branch: string;
}

interface CloudWorkspaceRecord {
  id: string;
  key: string | null;
  repository: string;
  repositoryName: string;
  worktree: string;
  branch: string;
  baseBranch?: string;
  status: string;
  pr: Instance["pr"];
  sessions?: Instance["sessions"];
  task?: Instance["task"];
  lastAccessedAt?: string | null;
  gitStatus: BranchStatus;
}

interface CloudProbeResult {
  home: string;
  rlInstalled: boolean;
  defaultRepo: string | null;
  repositories: CloudRepository[];
  instances: CloudWorkspaceRecord[];
  errors: { repository: string; message: string }[];
}

interface CloudSettings {
  stateDir: string;
  worktreeDir: string;
  configuredVm?: string;
}

interface PersistedCloudState {
  schemaVersion: 1;
  defaultVm: string | null;
}

interface CloudPickerTarget {
  kind: "cloud-workspace" | "cloud-repo" | "local-workspace";
  vm: string;
  repositoryName: string;
  repositoryRoot: string;
  originUrl: string | null;
  name: string;
  branch: string;
  base: string;
  path: string;
  changes: string;
  prLabel: string;
  sessionsLabel: string;
  accessedAt: string | null;
  localCandidate?: Candidate;
}

interface RemoteSnapshotInfo {
  repoRoot: string;
  worktree: string;
  branch: string;
  head: string;
  base: string;
  snapshot: string;
  dirty: boolean;
  refNamespace: string;
}

const REMOTE_PROBE_NODE_SCRIPT = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const opts = JSON.parse(process.argv[1] || "{}");
const home = os.homedir();
const extraPaths = [
  path.join(home, ".local/share/rl/bin"),
  path.join(home, ".local/bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];
const env = {
  ...process.env,
  PATH: [...extraPaths, process.env.PATH || "/usr/bin:/bin"].join(":"),
};

function runCmd(argv, cwd = home) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

function gitInfo(root) {
  const origin = runCmd(["git", "-C", root, "config", "--get", "remote.origin.url"]).stdout || null;
  const branch = runCmd(["git", "-C", root, "branch", "--show-current"]).stdout || "(detached)";
  return { originUrl: origin, branch };
}

const rlCheck = runCmd(["rl", "--version"]);
const rlInstalled = rlCheck.ok;
let defaultRepo = null;
const repositories = [];
const knownRoots = new Set();
const knownCommons = new Set();
const errors = [];
let instances = [];

function commonDir(root) {
  const res = runCmd(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return res.ok ? res.stdout : root;
}

if (rlInstalled) {
  const repoRes = runCmd(["rl", "repo", "list", "--json"]);
  if (repoRes.ok && repoRes.stdout) {
    try {
      const parsed = JSON.parse(repoRes.stdout);
      defaultRepo = parsed.default || null;
      const map = parsed.repositories || {};
      for (const name of Object.keys(map).sort()) {
        const entry = map[name];
        let realRoot = entry.root;
        try { realRoot = fs.realpathSync(entry.root); } catch {}
        knownRoots.add(realRoot);
        knownCommons.add(commonDir(realRoot));
        const info = gitInfo(realRoot);
        repositories.push({
          name,
          root: realRoot,
          base: entry.base || "origin/test",
          worktreeName: entry.worktreeName || name,
          registered: true,
          isDefault: name === defaultRepo,
          originUrl: info.originUrl,
          branch: info.branch,
        });
      }
    } catch (err) {
      errors.push({ repository: "cloud", message: String(err) });
    }
  }

  const listArgs = ["rl", "list", "--all", "--json"];
  if (opts.fetch) listArgs.push("--fetch");
  if (opts.includeDeleted) listArgs.push("--include-deleted");
  const listRes = runCmd(listArgs);
  if (listRes.stdout) {
    try {
      const parsed = JSON.parse(listRes.stdout);
      if (Array.isArray(parsed.instances)) {
        instances = parsed.instances.map((inst) => {
          let lastAccessedAt = inst.updatedAt || inst.createdAt || null;
          if (inst.stateDirectory) {
            try {
              const rawInst = JSON.parse(fs.readFileSync(path.join(inst.stateDirectory, "instance.json"), "utf8"));
              lastAccessedAt = rawInst.lastAccessedAt || rawInst.updatedAt || rawInst.createdAt || lastAccessedAt;
            } catch {}
          }
          return {
            id: inst.id,
            key: inst.key ?? null,
            repository: inst.repository,
            repositoryName: inst.repositoryName,
            worktree: inst.worktree,
            branch: inst.branch,
            baseBranch: inst.baseBranch,
            status: inst.status,
            pr: inst.pr ?? null,
            sessions: inst.sessions,
            task: inst.task,
            lastAccessedAt,
            gitStatus: inst.gitStatus,
          };
        });
      }
      if (Array.isArray(parsed.errors)) {
        errors.push(...parsed.errors);
      }
    } catch (err) {
      errors.push({ repository: "cloud", message: String(err) });
    }
  } else if (!listRes.ok && listRes.stderr && !/No registered repositories|No RL instances/i.test(listRes.stderr)) {
    errors.push({ repository: "cloud", message: listRes.stderr });
  }
}

const skipDirs = new Set(["node_modules", "vendor", "dist", "build", ".cache", ".local", ".npm", ".rl", ".gemini", ".config", ".ssh"]);
function scanDir(dir, depth) {
  if (depth > 2) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === ".git")) {
    let realRoot = dir;
    try { realRoot = fs.realpathSync(dir); } catch {}
    const common = commonDir(realRoot);
    if (!knownRoots.has(realRoot) && !knownCommons.has(common)) {
      knownRoots.add(realRoot);
      knownCommons.add(common);
      const info = gitInfo(realRoot);
      const baseName = path.basename(realRoot);
      repositories.push({
        name: baseName,
        root: realRoot,
        base: "origin/test",
        worktreeName: baseName,
        registered: false,
        isDefault: false,
        originUrl: info.originUrl,
        branch: info.branch,
      });
    }
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
    scanDir(path.join(dir, entry.name), depth + 1);
  }
}
scanDir(home, 0);

process.stdout.write(JSON.stringify({
  home,
  rlInstalled,
  defaultRepo,
  repositories,
  instances,
  errors,
}) + "\n");
`;

const REMOTE_SNAPSHOT_NODE_SCRIPT = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const input = JSON.parse(process.argv[1]);
const worktree = input.worktree;
const baseRef = input.baseRef || "origin/test";

function gitRun(argv, extraEnv = {}) {
  const res = spawnSync("git", ["-C", worktree, ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

if (!fs.existsSync(worktree)) {
  throw new Error("Remote workspace directory does not exist: " + worktree);
}

const wtList = gitRun(["worktree", "list", "--porcelain"]);
if (!wtList.ok) throw new Error(wtList.stderr || "Not a Git worktree: " + worktree);
const firstLine = (wtList.stdout.split("\n")[0] || "");
const repoRoot = firstLine.startsWith("worktree ") ? firstLine.slice("worktree ".length) : worktree;

const headRes = gitRun(["rev-parse", "HEAD"]);
if (!headRes.ok) throw new Error(headRes.stderr || "Cannot resolve HEAD");
const head = headRes.stdout;
const branch = gitRun(["branch", "--show-current"]).stdout || "(detached)";

let base = "";
for (const candidate of [baseRef, "origin/test", "origin/main", "origin/master", "origin/HEAD"]) {
  if (!candidate) continue;
  const mb = gitRun(["merge-base", "HEAD", candidate]);
  if (mb.ok && mb.stdout) {
    base = mb.stdout;
    break;
  }
}
if (!base) base = head;

const statusRes = gitRun(["status", "--porcelain"]);
const dirty = Boolean(statusRes.stdout);
let snapshot = head;

if (dirty) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-cloud-snap-"));
  const tmpIndex = path.join(tmpDir, "index");
  try {
    const gitDirRes = gitRun(["rev-parse", "--path-format=absolute", "--git-dir"]);
    if (!gitDirRes.ok) throw new Error(gitDirRes.stderr || "Cannot locate git dir");
    const realIndex = path.join(gitDirRes.stdout, "index");
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tmpIndex);
    }
    const addRes = gitRun(["add", "-A"], { GIT_INDEX_FILE: tmpIndex });
    if (!addRes.ok) throw new Error(addRes.stderr || "Cannot stage temporary snapshot");
    const treeRes = gitRun(["write-tree"], { GIT_INDEX_FILE: tmpIndex });
    if (!treeRes.ok) throw new Error(treeRes.stderr || "Cannot write temporary tree");
    const commitRes = gitRun(
      ["commit-tree", treeRes.stdout, "-p", head, "-m", "rl cloud working tree snapshot"],
      {
        GIT_AUTHOR_NAME: "RL Cloud Snapshot",
        GIT_AUTHOR_EMAIL: "rl-cloud@example.invalid",
        GIT_COMMITTER_NAME: "RL Cloud Snapshot",
        GIT_COMMITTER_EMAIL: "rl-cloud@example.invalid",
      },
    );
    if (!commitRes.ok) throw new Error(commitRes.stderr || "Cannot create snapshot commit");
    snapshot = commitRes.stdout;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const ns = crypto.createHash("sha256").update(worktree).digest("hex").slice(0, 16);
for (const [name, oid] of [["base", base], ["head", head], ["snapshot", snapshot]]) {
  const up = spawnSync("git", ["-C", repoRoot, "update-ref", "refs/rl/cloud-sync/" + ns + "/" + name, oid], { encoding: "utf8" });
  if (up.status !== 0) {
    throw new Error((up.stderr || "").trim() || "Cannot publish temporary cloud sync ref");
  }
}

process.stdout.write(JSON.stringify({
  repoRoot,
  worktree,
  branch,
  head,
  base,
  snapshot,
  dirty,
  refNamespace: ns,
}) + "\n");
`;

function validateHostName(name: string): string {
  if (!HOST_NAME_PATTERN.test(name)) {
    throw new UsageError(
      "Choose a valid SSH host or VM name, for example dev-box or user@host",
    );
  }
  return name;
}

function normalizeGitOriginIdentity(
  originUrl: string | null | undefined,
): string | null {
  if (!originUrl) return null;
  const trimmed = originUrl
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^ssh:\/\/(?:[^@]+@)?/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return trimmed ? trimmed.toLowerCase() : null;
}

function cloudHostOption(values: Record<string, unknown>): string | undefined {
  if (values.host && values.vm && values.host !== values.vm) {
    throw new UsageError("Choose either --host or --vm, not different hosts");
  }
  return (values.host ?? values.vm) as string | undefined;
}

function resolveCloudSettings(
  overrides: {
    stateDir?: string;
    worktreeDir?: string;

    vm?: string;
  } = {},
): CloudSettings {
  const config = loadUserConfig();
  const envResolved = resolveCliEnvironment(undefined);
  const configuredVm =
    overrides.vm ||
    process.env.RL_CLOUD_HOST ||
    process.env.RL_CLOUD_VM ||
    config.cloudHost ||
    config.cloudVm ||
    undefined;
  if (configuredVm) {
    validateHostName(configuredVm);
  }

  return {
    stateDir: overrides.stateDir ?? envResolved.stateDir,
    worktreeDir: overrides.worktreeDir ?? envResolved.worktreeDir,
    configuredVm,
  };
}

function cloudStateFile(stateDir: string): string {
  return path.join(stateDir, "cloud.json");
}

function readCloudState(stateDir: string): PersistedCloudState {
  const file = cloudStateFile(stateDir);
  if (!fs.existsSync(file)) {
    return { schemaVersion: 1, defaultVm: null };
  }
  try {
    const raw = readJson(file);
    const defaultVm =
      typeof raw.defaultVm === "string" && HOST_NAME_PATTERN.test(raw.defaultVm)
        ? raw.defaultVm
        : null;
    return { schemaVersion: 1, defaultVm };
  } catch {
    return { schemaVersion: 1, defaultVm: null };
  }
}

async function saveDefaultVm(stateDir: string, vmName: string): Promise<void> {
  validateHostName(vmName);
  await locked(stateDir, ".cloud.lock", () => {
    writeJson(cloudStateFile(stateDir), {
      schemaVersion: 1,
      defaultVm: vmName,
    } satisfies PersistedCloudState);
  });
}

async function resolveTargetVm(settings: CloudSettings): Promise<string> {
  const host =
    settings.configuredVm ?? readCloudState(settings.stateDir).defaultVm;
  if (host) return validateHostName(host);
  throw new RlError(
    "No cloud host configured. Run 'rl cloud use <ssh-host>' or pass --host <host>.",
  );
}

async function runSshCommand(
  settings: CloudSettings,
  vmName: string,
  remoteCommand: string,
  options: {
    interactive?: boolean;
    tty?: boolean;
    timeoutMs?: number;
    input?: string;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const buildArgv = () => [
    "ssh",
    ...(options.tty ? ["-t"] : []),
    "-o",
    "BatchMode=yes",
    vmName,
    remoteCommand,
  ];

  if (options.interactive) {
    return execute(
      ["ssh", ...(options.tty ? ["-t"] : []), vmName, remoteCommand],
      process.cwd(),
      { interactive: true },
    );
  }

  return execute(buildArgv(), process.cwd(), {
    timeoutMs: options.timeoutMs ?? 45000,
    input: options.input,
  });
}

async function probeCloudHost(
  settings: CloudSettings,
  vmName: string,
  options: { fetch?: boolean; includeDeleted?: boolean } = {},
): Promise<CloudProbeResult> {
  const payload = JSON.stringify({
    fetch: Boolean(options.fetch),
    includeDeleted: Boolean(options.includeDeleted),
  });
  const remoteCmd = `PATH="$HOME/.local/share/rl/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH" node -e ${shellQuote(REMOTE_PROBE_NODE_SCRIPT)} ${shellQuote(payload)}`;
  const res = await runSshCommand(settings, vmName, remoteCmd, {
    timeoutMs: options.fetch ? 90000 : 45000,
  });
  if (res.code !== 0) {
    throw new RlError(
      res.stderr.trim() ||
        `Cannot query SSH host '${vmName}'. Check your SSH connection and remote Node.js installation.`,
    );
  }
  const lastLine =
    res.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("{")) ?? res.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new RlError(`Invalid probe response from SSH host '${vmName}'`);
  }
  if (!object(parsed)) {
    throw new RlError(`Unexpected probe response from SSH host '${vmName}'`);
  }
  return parsed as unknown as CloudProbeResult;
}

function toOverviewRows(vm: string, probe: CloudProbeResult): OverviewRow[] {
  return probe.instances.map((inst) => ({
    id: inst.id,
    key: inst.key,
    repository: inst.repository,
    worktree: inst.worktree,
    branch: inst.branch,
    status: inst.status,
    pr: inst.pr,
    sessions: inst.sessions,
    task: inst.task,
    repositoryName: `${vm}:${inst.repositoryName}`,
    gitStatus: inst.gitStatus,
  }));
}

export async function fetchCloudOverview(options: {
  stateDir: string;
  vm?: string;

  fetch?: boolean;
  includeDeleted?: boolean;
}): Promise<{
  vm: string;
  rows: OverviewRow[];
  errors: { repository: string; message: string }[];
}> {
  const settings = resolveCloudSettings(options);
  const vm = await resolveTargetVm(settings);
  const probe = await probeCloudHost(settings, vm, {
    fetch: options.fetch,
    includeDeleted: options.includeDeleted,
  });
  return {
    vm,
    rows: toOverviewRows(vm, probe),
    errors: probe.errors.map((err) => ({
      repository: `${vm}:${err.repository}`,
      message: err.message,
    })),
  };
}

export async function fetchCloudRepositories(options: {
  stateDir: string;
  vm?: string;
}): Promise<{
  vm: string;
  defaultRepo: string | null;
  repositories: CloudRepository[];
}> {
  const settings = resolveCloudSettings(options);
  const vm = await resolveTargetVm(settings);
  const probe = await probeCloudHost(settings, vm);
  return {
    vm,
    defaultRepo: probe.defaultRepo,
    repositories: probe.repositories,
  };
}

function formatChangesLabel(s: BranchStatus | undefined): string {
  if (!s) return "clean";
  if (s.availability !== "ok") return s.availability;
  if (!s.dirty) return "clean";
  return (
    [
      ["staged", "S"],
      ["unstaged", "M"],
      ["untracked", "?"],
      ["conflicts", "!"],
    ] as const
  )
    .filter(([key]) => s[key] > 0)
    .map(([key, letter]) => `${s[key]}${letter}`)
    .join("/");
}

function formatSessionsLabel(sessions?: Instance["sessions"]): string {
  if (!sessions) return "-";
  const parts: string[] = [];
  if (sessions.codex.length > 0) parts.push(`${sessions.codex.length}cx`);
  if (sessions.claude.length > 0) parts.push(`${sessions.claude.length}cl`);
  if (sessions.agy && sessions.agy.length > 0) {
    parts.push(`${sessions.agy.length}agy`);
  }
  if (sessions.opencode && sessions.opencode.length > 0) {
    parts.push(`${sessions.opencode.length}oc`);
  }
  return parts.length > 0 ? parts.join("/") : "-";
}

function buildCloudPickerTargets(
  vm: string,
  probe: CloudProbeResult,
): CloudPickerTarget[] {
  const repoMap = new Map(probe.repositories.map((r) => [r.name, r]));
  const workspaceTargets: CloudPickerTarget[] = probe.instances
    .filter(
      (inst) => inst.status === "active" || inst.status === "unregistered",
    )
    .map((inst) => {
      const repoInfo = repoMap.get(inst.repositoryName);
      return {
        kind: "cloud-workspace",
        vm,
        repositoryName: inst.repositoryName,
        repositoryRoot: repoInfo?.root ?? inst.repository,
        originUrl: repoInfo?.originUrl ?? null,
        name: inst.id,
        branch: inst.gitStatus.branch || inst.branch || "(detached)",
        base: inst.baseBranch ?? repoInfo?.base ?? "origin/test",
        path: inst.worktree,
        changes: formatChangesLabel(inst.gitStatus),
        prLabel: inst.pr ? prState({ pr: inst.pr }) : "none",
        sessionsLabel: formatSessionsLabel(inst.sessions),
        accessedAt: inst.lastAccessedAt ?? null,
      };
    });

  const sortedWorkspaces = [...workspaceTargets].sort((a, b) => {
    const left = a.accessedAt ? safeTimestamp(a.accessedAt) : -1n;
    const right = b.accessedAt ? safeTimestamp(b.accessedAt) : -1n;
    if (left === right) {
      return `${a.repositoryName}/${a.name}`.localeCompare(
        `${b.repositoryName}/${b.name}`,
      );
    }
    return left > right ? -1 : 1;
  });

  const repoTargets: CloudPickerTarget[] = probe.repositories.map((repo) => ({
    kind: "cloud-repo",
    vm,
    repositoryName: repo.name,
    repositoryRoot: repo.root,
    originUrl: repo.originUrl,
    name: "@",
    branch: repo.branch,
    base: repo.base,
    path: repo.root,
    changes: repo.registered ? "main" : "unregistered",
    prLabel: "none",
    sessionsLabel: "-",
    accessedAt: null,
  }));

  return [...sortedWorkspaces, ...repoTargets];
}

function safeTimestamp(value: string): bigint {
  try {
    return timestamp(value);
  } catch {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? BigInt(ms) * 1000000n : -1n;
  }
}

function resolveSelectorTarget(
  targets: CloudPickerTarget[],
  selector: string,
): CloudPickerTarget {
  const normalized = selector.trim();
  const exactWorkspace = targets.filter(
    (t) =>
      t.kind === "cloud-workspace" &&
      (t.name === normalized ||
        t.branch === normalized ||
        `${t.repositoryName}/${t.name}` === normalized ||
        `${t.repositoryName}:${t.name}` === normalized ||
        `${t.repositoryName}/${t.branch}` === normalized ||
        `${t.repositoryName}:${t.branch}` === normalized ||
        t.path === normalized),
  );
  if (exactWorkspace.length === 1) {
    return exactWorkspace[0]!;
  }
  if (exactWorkspace.length > 1) {
    throw new RlError(
      `Ambiguous cloud workspace '${selector}'; qualify as <repo>/${selector} (${exactWorkspace.map((t) => `${t.repositoryName}/${t.name}`).join(", ")})`,
    );
  }

  const repoMatch = targets.find(
    (t) =>
      t.kind === "cloud-repo" &&
      (t.repositoryName === normalized ||
        `${t.repositoryName}/@` === normalized ||
        `${t.repositoryName}:@` === normalized ||
        (normalized === "@" &&
          targets.filter((r) => r.kind === "cloud-repo").length === 1) ||
        t.path === normalized),
  );
  if (repoMatch) {
    return repoMatch;
  }

  const fuzzy = targets.filter(
    (t) =>
      t.name.toLowerCase().includes(normalized.toLowerCase()) ||
      t.branch.toLowerCase().includes(normalized.toLowerCase()),
  );
  if (fuzzy.length === 1) {
    return fuzzy[0]!;
  }

  throw new RlError(
    `Cloud workspace or repository not found: ${selector}. Run 'rl cloud list' or 'rl cloud repos'.`,
  );
}

async function pickCloudTarget(
  vm: string,
  targets: CloudPickerTarget[],
  options: {
    prompt?: string;
    allowActions?: boolean;
    workspacesOnly?: boolean;
  } = {},
): Promise<{ key: string; target: CloudPickerTarget } | null> {
  const filtered = options.workspacesOnly
    ? targets.filter((t) => t.kind === "cloud-workspace")
    : targets;
  if (filtered.length === 0) {
    console.error(
      options.workspacesOnly
        ? `No active RL workspaces on ${vm}.`
        : `No repositories or workspaces found on ${vm}.`,
    );
    return null;
  }

  const multiRepo =
    new Set(filtered.map((t) => t.repositoryName)).size > 1 ||
    filtered.some((t) => t.kind === "cloud-repo");
  const labelFor = (t: CloudPickerTarget) => {
    if (t.kind === "cloud-repo") {
      return `${t.repositoryName} (@)`;
    }
    return multiRepo ? `${t.repositoryName}/${t.name}` : t.name;
  };

  const nameWidth = Math.min(
    46,
    Math.max(
      16,
      ...filtered.map((t) => sanitizeTerminalText(labelFor(t)).length),
    ),
  );
  const branchWidth = Math.min(
    32,
    Math.max(10, ...filtered.map((t) => sanitizeTerminalText(t.branch).length)),
  );

  const fzfItems: FzfItem<CloudPickerTarget>[] = filtered.map((t) => {
    const label = labelFor(t);
    const prCol = colorText(
      padCell(t.prLabel, 7),
      STATE_COLORS[t.prLabel] ?? 90,
    );
    const changesCol =
      t.changes === "clean" || t.changes === "main"
        ? colorText(padCell(t.changes, 12), 90)
        : colorText(padCell(t.changes, 12), 33);
    const branchCol = colorText(padCell(t.branch, branchWidth), 36);
    const sessCol = colorText(padCell(t.sessionsLabel, 10), 90);
    let accessedText = "never";
    if (t.accessedAt) {
      accessedText = accessLabel(t.accessedAt);
    } else if (t.kind === "cloud-repo") {
      accessedText = "repo root";
    }
    const accCol = colorText(accessedText, 90);
    return {
      id: `${t.kind}:${t.repositoryName}:${t.path}`,
      line: `${padCell(label, nameWidth)}  ${prCol}  ${changesCol}  ${branchCol}  ${sessCol}  ${accCol}`,
      value: t,
    };
  });

  const actionKeys = options.allowActions ? ["alt-o", "alt-r", "alt-c"] : [];
  const banner = options.allowActions
    ? `Enter SSH · Alt-O VS Code · Alt-R local review · Alt-C local checkout · Esc cancel (${vm})`
    : `Enter select · Esc cancel (${vm})`;
  const header = `${banner}\n\n${padCell("CLOUD WORKSPACE", nameWidth)}  ${padCell("PR", 7)}  ${padCell("CHANGES", 12)}  ${padCell("BRANCH", branchWidth)}  ${padCell("SESSIONS", 10)}  LAST ACCESSED`;

  const picked = await runFzf(fzfItems, {
    cwd: process.cwd(),
    prompt: options.prompt ?? `Cloud (${vm}) › `,
    header,
    ansi: true,
    expectKeys: actionKeys,
    heightPercent: 70,
    missingHint:
      "Install fzf (or run rl setup dependencies) to use the cloud picker.",
    errorLabel: "Cloud picker",
    unknownNoun: "cloud workspace",
  });
  if (!picked || picked.items.length === 0) {
    return null;
  }
  return { key: picked.key, target: picked.items[0]! };
}

async function openInVsCodeRemote(
  settings: CloudSettings,
  vm: string,
  remotePath: string,
): Promise<number> {
  const codeBin = findExecutable("code");
  if (!codeBin) {
    throw new RlError(
      "VS Code CLI ('code') is not on PATH. Run 'Shell Command: Install code command in PATH' in VS Code.",
    );
  }
  const encodedPath = remotePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const uri = `vscode-remote://ssh-remote+${encodeURIComponent(vm)}${encodedPath}`;
  const res = await execute([codeBin, "--folder-uri", uri], process.cwd(), {
    timeoutMs: 15000,
  });
  if (res.code !== 0) {
    throw new RlError(
      res.stderr.trim() || "Failed to launch VS Code Remote-SSH",
    );
  }
  console.log(`Opened ${vm}:${remotePath} in VS Code.`);
  return 0;
}

async function sshIntoRemoteDirectory(
  settings: CloudSettings,
  vm: string,
  remotePath: string,
  options: { agent?: string; resume?: boolean; model?: string } = {},
): Promise<number> {
  const pathSetup = `export PATH="$HOME/.local/share/rl/bin:$HOME/.local/bin:/usr/local/bin:$PATH"`;
  let innerAction = `exec "\${SHELL:-/bin/bash}" -l`;
  if (options.resume) {
    const agentArg = options.agent ? ` ${shellQuote(options.agent)}` : "";
    innerAction = `rl resume${agentArg}`;
  } else if (options.agent) {
    innerAction = [
      "rl",
      "agent",
      "start",
      options.agent,
      ...(options.model === undefined ? [] : ["--", "--model", options.model]),
    ]
      .map(shellQuote)
      .join(" ");
  }
  const remoteCmd = `${pathSetup} && cd -- ${shellQuote(remotePath)} && ${innerAction}`;
  const res = await runSshCommand(settings, vm, remoteCmd, {
    interactive: true,
    tty: true,
  });
  return res.code;
}

interface MatchedLocalRepo {
  name: string;
  root: string;
  worktreeName: string;
  base: string;
}

function findMatchingLocalRepository(
  stateDir: string,
  target: Pick<CloudPickerTarget, "repositoryName" | "originUrl">,
  explicitRepo?: string,
): MatchedLocalRepo | null {
  const regFile = path.join(stateDir, "repositories.json");
  const cloudIdentity = normalizeGitOriginIdentity(target.originUrl);

  if (fs.existsSync(regFile)) {
    try {
      const data = readJson(regFile);
      const repos = object(data.repositories) ? data.repositories : {};
      if (explicitRepo) {
        const entry = repos[explicitRepo];
        if (!object(entry) || typeof entry.root !== "string") {
          throw new RlError(`Unknown local repository: ${explicitRepo}`);
        }
        return {
          name: explicitRepo,
          root: canonical(entry.root),
          worktreeName: String(entry.worktreeName ?? explicitRepo),
          base: String(entry.base ?? "origin/test"),
        };
      }

      for (const [alias, raw] of Object.entries(repos)) {
        if (!object(raw) || typeof raw.root !== "string") continue;
        try {
          const localOrigin = git(
            raw.root,
            "config",
            "--get",
            "remote.origin.url",
          );
          if (
            cloudIdentity &&
            normalizeGitOriginIdentity(localOrigin) === cloudIdentity
          ) {
            return {
              name: alias,
              root: canonical(raw.root),
              worktreeName: String(raw.worktreeName ?? alias),
              base: String(raw.base ?? "origin/test"),
            };
          }
        } catch {
          // Ignore broken local checkouts while scanning.
        }
      }

      for (const [alias, raw] of Object.entries(repos)) {
        if (!object(raw) || typeof raw.root !== "string") continue;
        if (
          alias === target.repositoryName ||
          path.basename(raw.root) === target.repositoryName
        ) {
          return {
            name: alias,
            root: canonical(raw.root),
            worktreeName: String(raw.worktreeName ?? alias),
            base: String(raw.base ?? "origin/test"),
          };
        }
      }
    } catch (error) {
      if (error instanceof RlError) throw error;
    }
  }

  try {
    const cwdTop = canonical(
      git(process.cwd(), "rev-parse", "--show-toplevel"),
    );
    const localOrigin = git(cwdTop, "config", "--get", "remote.origin.url");
    if (
      cloudIdentity &&
      normalizeGitOriginIdentity(localOrigin) === cloudIdentity
    ) {
      const wtRoot = canonical(worktrees(cwdTop)[0]!.worktree);
      return {
        name: path.basename(wtRoot),
        root: wtRoot,
        worktreeName: path.basename(wtRoot),
        base: "origin/test",
      };
    }
  } catch {
    // Outside a git checkout.
  }

  return null;
}

function sshGitRemoteUrl(vm: string, remoteRepoRoot: string): string {
  const cleanRoot = remoteRepoRoot.startsWith("/")
    ? remoteRepoRoot
    : `/${remoteRepoRoot}`;
  return `ssh://${vm}${cleanRoot}`;
}

async function fetchBranchFromCloud(
  settings: CloudSettings,
  target: CloudPickerTarget,
  options: {
    addRemote?: boolean;
    explicitLocalRepo?: string;
    asJson?: boolean;
  } = {},
): Promise<{
  localRepo: MatchedLocalRepo;
  remoteRef: string;
  remoteUrl: string;
  oid: string;
}> {
  if (!target.branch || target.branch === "(detached)") {
    throw new RlError(
      `Cloud target '${target.name}' is detached and has no named branch to fetch`,
    );
  }
  git(process.cwd(), "check-ref-format", "--branch", target.branch);

  const localRepo = findMatchingLocalRepository(
    settings.stateDir,
    target,
    options.explicitLocalRepo,
  );
  if (!localRepo) {
    throw new RlError(
      `No matching local RL repository found for '${target.repositoryName}'. Clone and register it locally with 'rl repo add', or use 'rl cloud review' which works without a local clone.`,
    );
  }

  const remoteUrl = sshGitRemoteUrl(target.vm, target.repositoryRoot);

  if (options.addRemote) {
    const remotes = git(localRepo.root, "remote")
      .split(/\r?\n/)
      .filter(Boolean);
    if (remotes.includes(target.vm)) {
      git(localRepo.root, "remote", "set-url", target.vm, remoteUrl);
    } else {
      git(localRepo.root, "remote", "add", target.vm, remoteUrl);
    }
  }

  const trackingRef = `refs/remotes/${target.vm}/${target.branch}`;
  const fetchSource = options.addRemote ? target.vm : remoteUrl;
  const fetchRes = await execute(
    [
      "git",
      "-C",
      localRepo.root,
      "fetch",
      "--no-tags",
      fetchSource,
      `+refs/heads/${target.branch}:${trackingRef}`,
    ],
    localRepo.root,
    { timeoutMs: 60000, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" } },
  );
  if (fetchRes.code !== 0) {
    throw new RlError(
      fetchRes.stderr.trim() ||
        `Failed to fetch branch '${target.branch}' from ${target.vm}`,
    );
  }

  const oid = git(localRepo.root, "rev-parse", trackingRef);
  return {
    localRepo,
    remoteRef: `${target.vm}/${target.branch}`,
    remoteUrl,
    oid,
  };
}

async function checkoutFromCloud(
  settings: CloudSettings,
  target: CloudPickerTarget,
  options: {
    includeUncommitted?: boolean;
    explicitLocalRepo?: string;
    outputPath?: string;
  } = {},
): Promise<number> {
  const fetched = await fetchBranchFromCloud(settings, target, {
    addRemote: true,
    explicitLocalRepo: options.explicitLocalRepo,
  });
  const { localRepo } = fetched;
  const branch = target.branch;
  const managedBase = path.join(settings.worktreeDir, localRepo.worktreeName);
  fs.mkdirSync(managedBase, { recursive: true });
  const destination = path.resolve(managedBase, branch);
  if (!inside(destination, managedBase)) {
    throw new UsageError(`Invalid workspace branch path: ${branch}`);
  }

  const existingWt = worktrees(localRepo.root).find(
    (item) => item.branch === `refs/heads/${branch}`,
  );
  let worktreePath: string;
  if (existingWt) {
    worktreePath = canonical(existingWt.worktree);
    const ff = await execute(
      ["git", "-C", worktreePath, "merge", "--ff-only", fetched.remoteRef],
      worktreePath,
    );
    if (ff.code !== 0) {
      console.error(
        `Fetched ${fetched.remoteRef} (${fetched.oid.slice(0, 8)}); local branch '${branch}' has diverged so working tree at ${worktreePath} was left untouched.`,
      );
    }
  } else {
    if (fs.existsSync(destination)) {
      throw new RlError(`Local workspace path already exists: ${destination}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const hasLocalBranch = git(
      localRepo.root,
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${branch}`,
    )
      .split(/\r?\n/)
      .includes(`refs/heads/${branch}`);

    if (hasLocalBranch) {
      git(localRepo.root, "worktree", "add", destination, branch);
      await execute(
        ["git", "-C", destination, "merge", "--ff-only", fetched.remoteRef],
        destination,
      );
    } else {
      git(
        localRepo.root,
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        destination,
        fetched.remoteRef,
      );
    }
    worktreePath = canonical(destination);
  }

  if (options.includeUncommitted) {
    const snap = await captureRemoteSnapshot(settings, target);
    if (snap.dirty) {
      await fetchSnapshotRefs(localRepo.root, target.vm, snap);
      const localSnapRef = `refs/rl/cloud/${target.vm}/${snap.refNamespace}/snapshot`;
      const patchRes = await execute(
        [
          "git",
          "-C",
          localRepo.root,
          "diff",
          "--binary",
          snap.head,
          localSnapRef,
        ],
        localRepo.root,
      );
      if (patchRes.code === 0 && patchRes.stdout) {
        const applyRes = await execute(
          ["git", "-C", worktreePath, "apply", "--3way", "-"],
          worktreePath,
          { input: patchRes.stdout },
        );
        if (applyRes.code !== 0) {
          console.error(
            `Warning: could not cleanly apply uncommitted cloud changes: ${applyRes.stderr.trim()}`,
          );
        }
      }
    }
  }

  const store = new Store(localRepo.root, settings.stateDir);
  await store.adopt(worktreePath, target.base || localRepo.base);
  writeWorkspaceOutput(worktreePath, options.outputPath);
  console.error(`Checked out ${target.vm}:${branch} → ${worktreePath}`);
  return 0;
}

async function captureRemoteSnapshot(
  settings: CloudSettings,
  target: CloudPickerTarget,
): Promise<RemoteSnapshotInfo> {
  const payload = JSON.stringify({
    worktree: target.path,
    baseRef: target.base || "origin/test",
  });
  const remoteCmd = `node -e ${shellQuote(REMOTE_SNAPSHOT_NODE_SCRIPT)} ${shellQuote(payload)}`;
  const res = await runSshCommand(settings, target.vm, remoteCmd, {
    timeoutMs: 45000,
  });
  if (res.code !== 0) {
    throw new RlError(
      res.stderr.trim() ||
        `Failed to capture Git snapshot on ${target.vm}:${target.path}`,
    );
  }
  const line =
    res.stdout
      .trim()
      .split(/\r?\n/)
      .findLast((l) => l.startsWith("{")) ?? res.stdout.trim();
  return JSON.parse(line) as RemoteSnapshotInfo;
}

async function ensureCloudBareCache(
  stateDir: string,
  vm: string,
  repoName: string,
): Promise<string> {
  const id = createHash("sha256")
    .update(`${vm}:${repoName}`)
    .digest("hex")
    .slice(0, 24);
  const dir = path.join(canonical(stateDir), "cloud-cache", id);
  const bareRoot = path.join(dir, "objects.git");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await locked(dir, ".init.lock", async () => {
    if (!fs.existsSync(bareRoot)) {
      const initRes = await execute(
        ["git", "init", "--bare", "--initial-branch=rl-unborn", bareRoot],
        dir,
        { env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" } },
      );
      if (initRes.code !== 0) {
        throw new RlError(
          initRes.stderr.trim() || "Failed to initialize local cloud Git cache",
        );
      }
      await execute(
        [
          "git",
          `--git-dir=${bareRoot}`,
          "config",
          "core.hooksPath",
          "/dev/null",
        ],
        dir,
      );
    }
  });
  return bareRoot;
}

async function fetchSnapshotRefs(
  localGitRepo: string,
  vm: string,
  snap: RemoteSnapshotInfo,
): Promise<{ baseRef: string; headRef: string; snapshotRef: string }> {
  const remoteUrl = sshGitRemoteUrl(vm, snap.repoRoot);
  const ns = snap.refNamespace;
  const baseRef = `refs/rl/cloud/${vm}/${ns}/base`;
  const headRef = `refs/rl/cloud/${vm}/${ns}/head`;
  const snapshotRef = `refs/rl/cloud/${vm}/${ns}/snapshot`;
  const res = await execute(
    [
      "git",
      `--git-dir=${resolveGitDirForFetch(localGitRepo)}`,
      "fetch",
      "--no-tags",
      remoteUrl,
      `+refs/rl/cloud-sync/${ns}/base:${baseRef}`,
      `+refs/rl/cloud-sync/${ns}/head:${headRef}`,
      `+refs/rl/cloud-sync/${ns}/snapshot:${snapshotRef}`,
    ],
    process.cwd(),
    { timeoutMs: 60000, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" } },
  );
  if (res.code !== 0) {
    throw new RlError(
      res.stderr.trim() || `Failed to fetch cloud snapshot from ${vm}`,
    );
  }
  return { baseRef, headRef, snapshotRef };
}

function resolveGitDirForFetch(repoPath: string): string {
  const isBare =
    reviewGit(repoPath, ["rev-parse", "--is-bare-repository"]).trim() ===
    "true";
  if (isBare) return repoPath;
  return canonical(
    reviewGit(repoPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim(),
  );
}

export async function runCloudReview(
  argv: string[],
  context: { stateDir: string; worktreeDir: string; selectedRepo?: string },
): Promise<number> {
  const { values, positionals } = args(
    argv,
    ["host", "vm"],
    ["diff", "json", "live", "remote", "cloud"],
  );
  arity(positionals, 0, 1);
  if (values.live && (values.json || values.diff)) {
    throw new UsageError("Expected --live without --json or --diff");
  }

  const settings = resolveCloudSettings({
    stateDir: context.stateDir,
    worktreeDir: context.worktreeDir,
    vm: cloudHostOption(values),
  });
  const vm = await resolveTargetVm(settings);
  const probe = await probeCloudHost(settings, vm);
  const allTargets = buildCloudPickerTargets(vm, probe);

  let target: CloudPickerTarget | undefined;
  if (positionals[0]) {
    target = resolveSelectorTarget(allTargets, positionals[0]);
  } else {
    const picked = await pickCloudTarget(vm, allTargets, {
      prompt: `Review (${vm}) › `,
    });
    if (!picked) return 0;
    target = picked.target;
  }

  if (values.remote) {
    const remoteCmd = `export PATH="$HOME/.local/share/rl/bin:$HOME/.local/bin:/usr/local/bin:$PATH" && cd -- ${shellQuote(target.path)} && rl review`;
    const res = await runSshCommand(settings, vm, remoteCmd, {
      interactive: true,
      tty: true,
    });
    return res.code;
  }

  const snap = await captureRemoteSnapshot(settings, target);
  const matchedLocal = findMatchingLocalRepository(
    settings.stateDir,
    target,
    context.selectedRepo,
  );
  const backingRepo = matchedLocal
    ? matchedLocal.root
    : await ensureCloudBareCache(settings.stateDir, vm, target.repositoryName);

  await fetchSnapshotRefs(backingRepo, vm, snap);

  if (values.json) {
    const files = changedFiles(backingRepo, snap.base, snap.snapshot);
    const logOut = reviewGit(backingRepo, [
      "log",
      "--format=%H%x1f%s%x1f%an%x1f%aI",
      `${snap.base}..${snap.head}`,
    ]).trim();
    const commits = logOut
      ? logOut.split(/\r?\n/).map((line) => {
          const [sha, subject, author, date] = line.split("\x1f");
          return { sha, subject, author, date };
        })
      : [];
    json({
      source: "cloud",
      vm,
      repository: target.repositoryName,
      remotePath: target.path,
      branch: snap.branch,
      base: snap.base,
      head: snap.head,
      snapshot: snap.snapshot,
      dirty: snap.dirty,
      commits,
      files,
    });
    return 0;
  }

  const interactiveLive =
    (process.stdin.isTTY && process.stdout.isTTY && !values.diff) ||
    Boolean(values.live);

  if (!interactiveLive) {
    const patch = reviewGit(backingRepo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      snap.base,
      snap.snapshot,
      "--",
    ]);
    console.log(
      `${vm}:${target.repositoryName}/${target.name} (${snap.branch}${snap.dirty ? ", includes uncommitted cloud changes" : ""}) ${snap.base.slice(0, 8)} → ${snap.snapshot.slice(0, 8)}`,
    );
    if (patch.trim()) {
      console.log(patch.trimEnd());
    }
    return 0;
  }

  const reviewStateDir = path.join(
    canonical(settings.stateDir),
    "cloud-review",
    createHash("sha256")
      .update(`${vm}:${target.path}`)
      .digest("hex")
      .slice(0, 20),
  );
  fs.mkdirSync(reviewStateDir, { recursive: true, mode: 0o700 });
  const tempWorktree = path.join(
    reviewStateDir,
    `wt-${randomUUID().slice(0, 8)}`,
  );

  const addRes = await execute(
    [
      "git",
      `--git-dir=${resolveGitDirForFetch(backingRepo)}`,
      "worktree",
      "add",
      "--detach",
      tempWorktree,
      snap.head,
    ],
    reviewStateDir,
    { env: gitEnv() },
  );
  if (addRes.code !== 0) {
    throw new RlError(
      addRes.stderr.trim() ||
        "Cannot materialize temporary local review worktree",
    );
  }

  try {
    if (snap.dirty && snap.snapshot !== snap.head) {
      await execute(
        ["git", "-C", tempWorktree, "checkout", snap.snapshot, "--", "."],
        tempWorktree,
        { env: gitEnv() },
      );
      await execute(
        ["git", "-C", tempWorktree, "reset", "--mixed", snap.head],
        tempWorktree,
        { env: gitEnv() },
      );
    }
    await liveReview({
      root: tempWorktree,
      repository: backingRepo,
      directory: reviewStateDir,
      defaultBase: snap.base,
      ...(snap.dirty ? {} : { since: snap.base }),
    });
  } finally {
    await execute(
      [
        "git",
        `--git-dir=${resolveGitDirForFetch(backingRepo)}`,
        "worktree",
        "remove",
        "--force",
        tempWorktree,
      ],
      reviewStateDir,
      { env: gitEnv() },
    );
    fs.rmSync(tempWorktree, { recursive: true, force: true });
  }
  return 0;
}

export async function pickWorkspaceWithCloud(options: {
  store: Store;
  localCandidates: Candidate[];
  defaultBase: string;
  stateDir: string;
  worktreeDir: string;
  cloudOnly: boolean;
  vm?: string;
}): Promise<number> {
  const settings = resolveCloudSettings({
    stateDir: options.stateDir,
    worktreeDir: options.worktreeDir,
    vm: options.vm,
  });
  const vm = await resolveTargetVm(settings);

  if (options.cloudOnly) {
    return openCloudInteractive(settings, vm);
  }

  const [prs, probe] = await Promise.all([
    discoverPrs(
      options.store,
      options.localCandidates.map((item) => item.branch),
    ),
    probeCloudHost(settings, vm),
  ]);

  const localRows =
    options.localCandidates.length > 0
      ? pickerRows(
          options.store,
          options.localCandidates,
          options.defaultBase,
          prs,
        )
      : [];
  const cloudTargets = buildCloudPickerTargets(vm, probe).filter(
    (t) => t.kind === "cloud-workspace",
  );

  if (localRows.length === 0 && cloudTargets.length === 0) {
    console.error("No local or cloud RL workspaces found.");
    return 0;
  }

  const combinedItems: FzfItem<
    | { kind: "local"; candidate: Candidate }
    | { kind: "cloud"; target: CloudPickerTarget }
  >[] = [];

  for (const row of localRows) {
    const tabIdx = row.line.indexOf("\t");
    const display = row.line.slice(tabIdx + 1);
    combinedItems.push({
      id: `local:${row.item.path}`,
      line: `${colorText("[local]".padEnd(10), 36)}  ${display}`,
      value: { kind: "local", candidate: row.item },
    });
  }

  for (const t of cloudTargets) {
    const hostTag = colorText(`[${vm}]`.slice(0, 10).padEnd(10), 35);
    const label = padCell(`${t.repositoryName}/${t.name}`, 32);
    const prCol = colorText(
      padCell(t.prLabel, 7),
      STATE_COLORS[t.prLabel] ?? 90,
    );
    const changesCol = colorText(
      padCell(t.changes, 13),
      t.changes === "clean" ? 90 : 33,
    );
    const baseCol = colorText(padCell(t.base, 16), 90);
    const accCol = colorText(
      t.accessedAt ? accessLabel(t.accessedAt) : "never",
      90,
    );
    combinedItems.push({
      id: `cloud:${t.repositoryName}:${t.path}`,
      line: `${hostTag}  ${label}  ${prCol}  ${changesCol}  ${baseCol}  ${accCol}`,
      value: { kind: "cloud", target: t },
    });
  }

  const picked = await runFzf(combinedItems, {
    cwd: options.store.repo,
    prompt: "Workspace (local + cloud) › ",
    header: `Enter open (cd local / SSH ${vm}) · Esc cancel`,
    ansi: true,
    heightPercent: 70,
    errorLabel: "Workspace picker",
    unknownNoun: "workspace",
  });
  if (!picked || picked.items.length === 0) {
    return 0;
  }

  const choice = picked.items[0]!;
  if (choice.kind === "local") {
    writeWorkspaceOutput(
      await openPickerWorktree(
        options.store,
        choice.candidate,
        options.defaultBase,
      ),
    );
    return 0;
  }
  return sshIntoRemoteDirectory(settings, vm, choice.target.path);
}

async function openCloudInteractive(
  settings: CloudSettings,
  vm: string,
  selector?: string,
  options: {
    code?: boolean;
    agent?: string;
    resume?: boolean;
    explicitLocalRepo?: string;
  } = {},
): Promise<number> {
  const probe = await probeCloudHost(settings, vm);
  const targets = buildCloudPickerTargets(vm, probe);

  if (selector) {
    const target = resolveSelectorTarget(targets, selector);
    if (options.code) {
      return openInVsCodeRemote(settings, vm, target.path);
    }
    return sshIntoRemoteDirectory(settings, vm, target.path, {
      agent: options.agent,
      resume: options.resume,
    });
  }

  const picked = await pickCloudTarget(vm, targets, { allowActions: true });
  if (!picked) {
    return 0;
  }

  if (picked.key === "alt-o" || options.code) {
    return openInVsCodeRemote(settings, vm, picked.target.path);
  }
  if (picked.key === "alt-r") {
    return runCloudReview([picked.target.path, "--vm", vm], {
      stateDir: settings.stateDir,
      worktreeDir: settings.worktreeDir,
      selectedRepo: options.explicitLocalRepo,
    });
  }
  if (picked.key === "alt-c") {
    return checkoutFromCloud(settings, picked.target, {
      explicitLocalRepo: options.explicitLocalRepo,
    });
  }

  return sshIntoRemoteDirectory(settings, vm, picked.target.path, {
    agent: options.agent,
    resume: options.resume,
  });
}

function renderCloudReposTable(
  vm: string,
  repositories: CloudRepository[],
): void {
  if (repositories.length === 0) {
    console.log(`No Git repositories found on ${vm}.`);
    return;
  }
  const rows: string[][] = [
    [
      "DEFAULT",
      "VM",
      "REPOSITORY",
      "BRANCH",
      "BASE",
      "RL",
      "REMOTE PATH",
      "SSH GIT URL",
    ],
  ];
  for (const repo of repositories) {
    rows.push([
      repo.isDefault ? "*" : "",
      sanitizeTerminalText(vm),
      sanitizeTerminalText(repo.name),
      sanitizeTerminalText(repo.branch),
      sanitizeTerminalText(repo.base),
      repo.registered ? "registered" : "unregistered",
      sanitizeTerminalText(repo.root),
      sanitizeTerminalText(sshGitRemoteUrl(vm, repo.root)),
    ]);
  }
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((row) => row[col]!.length)),
  );
  for (const row of rows) {
    console.log(
      row
        .map((val, col) => val.padEnd(widths[col]!))
        .join("  ")
        .trimEnd(),
    );
  }
}

function exactCloudWorkspace(
  vm: string,
  probe: CloudProbeResult,
  selector: string,
  repo?: string,
): CloudPickerTarget {
  const targets = buildCloudPickerTargets(vm, probe).filter(
    (target) =>
      target.kind === "cloud-workspace" &&
      (!repo || target.repositoryName === repo) &&
      [
        target.name,
        target.branch,
        target.path,
        `${target.repositoryName}/${target.name}`,
        `${target.repositoryName}:${target.name}`,
        `${target.repositoryName}/${target.branch}`,
        `${target.repositoryName}:${target.branch}`,
      ].includes(selector),
  );
  if (targets.length !== 1)
    throw new RlError(
      targets.length
        ? `Ambiguous remote workspace: ${selector}; choose --repo <name>`
        : `Remote workspace not found: ${selector}. Use rl cloud list or rl cloud switch -c ${shellQuote(selector)}.`,
    );
  return targets[0];
}

async function cloudJob(
  settings: CloudSettings,
  host: string,
  request: Record<string, unknown>,
): Promise<CloudJob> {
  const source = fs.readFileSync(
    new URL("./cloud-job-runner.js", import.meta.url),
    "utf8",
  );
  const command = `export PATH="$HOME/.local/share/rl/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; node --input-type=module -e ${shellQuote(source)}`;
  const result = await runSshCommand(settings, host, command, {
    input: JSON.stringify({
      ...request,
      ...(request.action === "launch" ? { source } : {}),
    }),
    timeoutMs: 45000,
  });
  if (result.code !== 0)
    throw new RlError(result.stderr.trim() || "Remote job request failed");
  const parsed: unknown = JSON.parse(
    result.stdout.trim().split("\n").at(-1) || "null",
  );
  if (
    !object(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.workspace !== "string" ||
    typeof parsed.status !== "string"
  )
    throw new RlError("Invalid remote job response");
  return parsed as unknown as CloudJob;
}

function printCloudJob(host: string, job: CloudJob, structured: boolean): void {
  const command = (argv: string[]) => argv.map(shellQuote).join(" ");
  // The caller may be running a checkout alongside an older rl on PATH.
  const cli = fileURLToPath(new URL("../bin/rl", import.meta.url));
  const inspect = command([cli, "cloud", "job", job.id, "--host", host]);
  const logs = command([
    "ssh",
    host,
    command(["tail", "-n", "100", "-f", "--", job.log]),
  ]);
  const resume = command([
    cli,
    "cloud",
    "open",
    job.workspace,
    "--host",
    host,
    "--agent",
    job.agent,
    "--resume",
  ]);
  if (structured) {
    json({ host, ...job, inspect, logs, resume });
    return;
  }
  for (const line of [
    `Host: ${host}`,
    `Workspace: ${job.workspace}`,
    `Job: ${job.id}`,
    `Agent: ${job.agent}${job.model ? ` · model: ${job.model}` : " · configured model"}`,
    `Status: ${job.status}${job.exitCode !== undefined ? ` · exit: ${job.exitCode}` : job.status === "running" ? " (launch confirmed; task completion is not yet known)" : ""}`,
    ...(job.error ? [`Error: ${job.error}`] : []),
    `Inspect: ${inspect}`,
    `Log: ${logs}`,
    `Resume a saved conversation after the job stops: ${resume}`,
    `In the workspace, run rl agent sessions ${sanitizeTerminalText(job.agent)} to see saved conversations. Use Inspect or Log to check the job.`,
  ])
    console.log(sanitizeTerminalText(line));
}

async function validateCloudWorkspaceName(name: string): Promise<void> {
  if (name.startsWith("-") || /[\x00-\x1f\x7f]/.test(name)) {
    throw new UsageError("Expected a workspace branch name");
  }
  const valid = await execute(
    ["git", "check-ref-format", "--branch", name],
    process.cwd(),
  );
  if (valid.code !== 0) throw new UsageError("Invalid workspace branch name");
}

async function createCloudWorkspace(
  settings: CloudSettings,
  vm: string,
  probe: CloudProbeResult,
  name: string,
  values: Record<string, string | boolean | undefined>,
  detached: boolean,
): Promise<number | undefined> {
  if (!probe.rlInstalled) {
    throw new RlError("Install rl on the SSH host before creating workspaces.");
  }
  const repos = probe.repositories.filter((repo) => repo.registered);
  const requested = values.repo as string | undefined;
  let repo = requested
    ? repos.find((entry) => entry.name === requested)
    : (repos.find((entry) => entry.name === probe.defaultRepo) ??
      (repos.length === 1 ? repos[0] : undefined));
  if (requested && !repo) {
    throw new UsageError(
      `Remote repository is not registered: ${requested}. Run rl repo add on the server first.`,
    );
  }
  if (!repo) {
    if (!repos.length)
      throw new RlError(
        "No registered remote repositories. Run rl repo add on the server first.",
      );
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new UsageError(
        "Multiple remote repositories; choose --repo <name>",
      );
    }
    const picked = await runFzf(
      repos.map((entry) => ({
        id: entry.name,
        line: `${sanitizeTerminalText(entry.name)}  ${sanitizeTerminalText(entry.root)}`,
        value: entry,
      })),
      {
        cwd: process.cwd(),
        prompt: "Create workspace in › ",
        header: "Enter select repository · Esc cancel",
        errorLabel: "Remote repository picker",
        unknownNoun: "repository",
      },
    );
    if (!picked) return undefined;
    repo = picked.items[0];
  }
  values.repo = repo.name;
  const remoteArgs = [
    "rl",
    "--repo",
    repo.name,
    "switch",
    name,
    "--create",
    ...(values.base ? ["--base", String(values.base)] : []),
    ...(values["no-fetch"] ? ["--no-fetch"] : []),
    ...(values.setup ? ["--setup"] : []),
  ];
  const command = `export PATH="$HOME/.local/share/rl/bin:$HOME/.local/bin:/usr/local/bin:$PATH" && cd -- ${shellQuote(repo.root)} && ${remoteArgs.map(shellQuote).join(" ")}`;
  const result = await runSshCommand(settings, vm, command, {
    interactive: !detached,
    timeoutMs: 120000,
  });
  if (detached && result.code !== 0)
    throw new RlError(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "Remote workspace creation failed",
    );
  return result.code;
}

export async function main(
  argv: string[],
  context: {
    stateDir: string;
    worktreeDir: string;
    selectedRepo?: string;
  },
): Promise<number> {
  const separator = argv.indexOf("--");
  const passthrough = separator >= 0 ? argv.slice(separator + 1) : [];
  const headArgv = separator >= 0 ? argv.slice(0, separator) : argv;

  const sub =
    headArgv[0] && !headArgv[0].startsWith("-") ? headArgv[0] : "open";
  const subArgv =
    headArgv[0] && !headArgv[0].startsWith("-") ? headArgv.slice(1) : headArgv;

  if (sub === "review") {
    if (passthrough.length > 0) {
      throw new UsageError("Unexpected '--' arguments for rl cloud review");
    }
    return runCloudReview(subArgv, context);
  }

  if (passthrough.length > 0)
    throw new UsageError(
      "Unexpected arguments after --; use SSH directly for remote commands",
    );
  if (
    ["vms", "ssh-config", "ssh", "tunnel", "start", "stop", "delete"].includes(
      sub,
    )
  ) {
    throw new UsageError(
      "Cloud infrastructure commands have been removed. Use SSH or your cloud provider's tools; rl cloud manages workspaces on an existing host.",
    );
  }

  const { values, positionals } = args(
    subArgv,
    ["host", "vm", "agent", "model", "prompt", "output-path", "repo", "base"],
    [
      "json",
      "fetch",
      "include-deleted",
      "code",
      "resume",
      "no-fetch",
      "remote",
      "include-uncommitted",
      "create",
      "setup",
    ],
    { create: "c", prompt: "p", agent: "a", model: "m" },
  );
  if (
    sub !== "switch" &&
    sub !== "create" &&
    ["create", "prompt", "model", "setup"].some(
      (name) => values[name] !== undefined,
    )
  )
    throw new UsageError(
      "--create, --prompt, --model and --setup are options for cloud switch/create",
    );

  const settings = resolveCloudSettings({
    stateDir: context.stateDir,
    worktreeDir: context.worktreeDir,
    vm: cloudHostOption(values),
  });

  switch (sub) {
    case "create":
    case "switch": {
      arity(positionals, 1);
      const create = sub === "create" || Boolean(values.create);
      const prompt =
        typeof values.prompt === "string" ? values.prompt : undefined;
      if (prompt !== undefined && (!prompt.trim() || prompt.includes("\0")))
        throw new UsageError(
          "--prompt requires non-empty text without NUL characters",
        );
      const agent =
        typeof values.agent === "string"
          ? values.agent
          : prompt !== undefined
            ? "agy"
            : undefined;
      if (agent && !SUPPORTED_AGENTS.has(agent))
        throw new UsageError(
          `Unsupported agent: choose ${[...SUPPORTED_AGENTS].join(", ")}`,
        );
      if (
        values.model !== undefined &&
        (!agent ||
          !String(values.model).trim() ||
          String(values.model).includes("\0"))
      )
        throw new UsageError(
          "--model requires an agent or prompt, and a non-empty model name",
        );
      if (values.resume && (prompt !== undefined || values.model !== undefined))
        throw new UsageError(
          "--resume cannot be combined with --prompt or --model",
        );
      if (prompt !== undefined && values.code)
        throw new UsageError(
          "Use --prompt for a detached job or --code for VS Code, not both",
        );
      if (!create && (values.base || values["no-fetch"] || values.setup))
        throw new UsageError("--base, --no-fetch and --setup require --create");
      if (values.json && prompt === undefined)
        throw new UsageError(
          "--json requires --prompt for cloud switch/create",
        );
      if (create) await validateCloudWorkspaceName(positionals[0]);
      const vm = await resolveTargetVm(settings);
      let probe = await probeCloudHost(settings, vm);
      if (prompt !== undefined && !probe.rlInstalled)
        throw new RlError(
          "Install rl on the SSH host before launching agent jobs.",
        );
      let requestedRepo = values.repo as string | undefined;
      if (create) {
        const code = await createCloudWorkspace(
          settings,
          vm,
          probe,
          positionals[0],
          values,
          prompt !== undefined,
        );
        if (code === undefined) return 0;
        if (
          code !== 0 ||
          (sub === "create" &&
            prompt === undefined &&
            !agent &&
            !values.code &&
            !values.resume)
        )
          return code;
        // Resolve the result through server metadata, never guess a workspace path.
        probe = await probeCloudHost(settings, vm);
        // The create implementation selected the repo when one was omitted.
        requestedRepo =
          typeof values.repo === "string" ? values.repo : undefined;
      }
      const target = exactCloudWorkspace(
        vm,
        probe,
        positionals[0],
        requestedRepo,
      );
      if (prompt !== undefined) {
        const job = await cloudJob(settings, vm, {
          action: "launch",
          workspace: target.path,
          repository: target.repositoryName,
          repositoryRoot: target.repositoryRoot,
          branch: target.branch,
          agent: agent!,
          prompt,
          ...(values.model === undefined
            ? {}
            : { model: String(values.model) }),
        });
        printCloudJob(vm, job, Boolean(values.json));
        return 0;
      }
      if (values.code) return openInVsCodeRemote(settings, vm, target.path);
      return sshIntoRemoteDirectory(settings, vm, target.path, {
        agent,
        resume: Boolean(values.resume),
        model: values.model as string | undefined,
      });
    }

    case "job": {
      arity(positionals, 1);
      const vm = await resolveTargetVm(settings);
      const job = await cloudJob(settings, vm, {
        action: "status",
        id: positionals[0],
      });
      printCloudJob(vm, job, Boolean(values.json));
      return job.status === "failed" || job.status === "interrupted" ? 1 : 0;
    }

    case "open": {
      if (passthrough.length > 0) {
        throw new UsageError(
          "Unexpected arguments after --; use SSH directly for remote commands",
        );
      }
      arity(positionals, 0, 1);
      const agent = values.agent as string | undefined;
      if (agent && !SUPPORTED_AGENTS.has(agent)) {
        throw new UsageError(
          "Unsupported agent: choose codex, claude, agy, or opencode",
        );
      }
      const vm = await resolveTargetVm(settings);
      return openCloudInteractive(settings, vm, positionals[0], {
        code: Boolean(values.code),
        agent,
        resume: Boolean(values.resume),
        explicitLocalRepo: context.selectedRepo,
      });
    }

    case "code": {
      arity(positionals, 0, 1);
      const vm = await resolveTargetVm(settings);
      const probe = await probeCloudHost(settings, vm);
      const targets = buildCloudPickerTargets(vm, probe);
      if (positionals[0]) {
        const target = resolveSelectorTarget(targets, positionals[0]);
        return openInVsCodeRemote(settings, vm, target.path);
      }
      const picked = await pickCloudTarget(vm, targets, {
        prompt: `VS Code (${vm}) › `,
      });
      if (!picked) return 0;
      return openInVsCodeRemote(settings, vm, picked.target.path);
    }

    case "repos": {
      arity(positionals, 0);
      const { vm, defaultRepo, repositories } = await fetchCloudRepositories({
        stateDir: settings.stateDir,
        vm: settings.configuredVm,
      });
      if (values.json) {
        json({ vm, default: defaultRepo, repositories });
      } else {
        renderCloudReposTable(vm, repositories);
      }
      return 0;
    }

    case "list": {
      arity(positionals, 0);
      const overview = await fetchCloudOverview({
        stateDir: settings.stateDir,
        vm: settings.configuredVm,

        fetch: Boolean(values.fetch),
        includeDeleted: Boolean(values["include-deleted"]),
      });
      if (values.json) {
        json({
          vm: overview.vm,
          instances: overview.rows,
          errors: overview.errors,
          fetched: Boolean(values.fetch),
        });
      } else {
        renderOverviewTable(overview.rows, Boolean(values.fetch));
        for (const err of overview.errors) {
          console.error(
            `${sanitizeTerminalText(err.repository)}: ${sanitizeTerminalText(err.message)}`,
          );
        }
      }
      return overview.errors.length > 0 ? 1 : 0;
    }

    case "fetch": {
      arity(positionals, 0, 1);
      const vm = await resolveTargetVm(settings);
      const probe = await probeCloudHost(settings, vm);
      const targets = buildCloudPickerTargets(vm, probe);
      let target: CloudPickerTarget | undefined;
      if (positionals[0]) {
        target = resolveSelectorTarget(targets, positionals[0]);
      } else {
        const picked = await pickCloudTarget(vm, targets, {
          prompt: `Fetch from ${vm} › `,
          workspacesOnly: true,
        });
        if (!picked) return 0;
        target = picked.target;
      }
      const result = await fetchBranchFromCloud(settings, target, {
        addRemote: Boolean(values.remote),
        explicitLocalRepo: context.selectedRepo,
      });
      if (values.json) {
        json({
          vm,
          branch: target.branch,
          localRepository: result.localRepo.name,
          localRoot: result.localRepo.root,
          remoteRef: result.remoteRef,
          oid: result.oid,
        });
      } else {
        console.log(
          `Fetched ${vm}:${target.branch} → ${result.remoteRef} (${result.oid.slice(0, 8)}) in ${result.localRepo.name}`,
        );
      }
      return 0;
    }

    case "checkout": {
      arity(positionals, 0, 1);
      const vm = await resolveTargetVm(settings);
      const probe = await probeCloudHost(settings, vm);
      const targets = buildCloudPickerTargets(vm, probe);
      let target: CloudPickerTarget | undefined;
      if (positionals[0]) {
        target = resolveSelectorTarget(targets, positionals[0]);
      } else {
        const picked = await pickCloudTarget(vm, targets, {
          prompt: `Checkout from ${vm} › `,
          workspacesOnly: true,
        });
        if (!picked) return 0;
        target = picked.target;
      }
      return checkoutFromCloud(settings, target, {
        includeUncommitted: Boolean(values["include-uncommitted"]),
        explicitLocalRepo: context.selectedRepo,
        outputPath: values["output-path"] as string | undefined,
      });
    }

    case "use": {
      arity(positionals, 1);
      const host = validateHostName(positionals[0]);
      await saveDefaultVm(settings.stateDir, host);
      console.log(`Default cloud host: ${host}`);
      return 0;
    }

    default:
      throw new UsageError(`Unknown cloud command: ${sub}; see rl help cloud`);
  }
}
