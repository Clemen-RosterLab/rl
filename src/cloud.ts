import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessLabel } from "./access.js";
import { writeWorkspaceOutput } from "./command-context.js";
import {
  args,
  arity,
  atomicWrite,
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
import { type Candidate, pickerRows, prState } from "./picker.js";
import { discoverPrs } from "./pr-discovery.js";
import { type OverviewRow, renderOverviewTable, worktrees } from "./repos.js";
import { changedFiles, reviewGit } from "./review-git.js";
import { liveReview } from "./review-live.js";
import { type BranchStatus, type Instance, Store } from "./store.js";
import { padCell, paintAnsi, sanitizeTerminalText } from "./tui/ansi.js";
import { type FzfItem, runFzf } from "./tui/fzf.js";
import { loadUserConfig, resolveCliEnvironment } from "./user-config.js";

const DEFAULT_MACHINE_TYPE = "e2-standard-4";
const DEFAULT_TUNNEL_PORT = 3000;
const SSH_MUX_REL_PATH = "~/.rl/ssh/%C";
const HOST_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,126}[A-Za-z0-9])?$/;
const GCP_VM_PATTERN = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,29}$/;
const ZONE_PATTERN = /^[a-z]+-[a-z]+\d+-[a-z]$/;
const SUPPORTED_AGENTS = new Set(["codex", "claude", "agy"]);

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

const dimText = (val: string): string => colorText(val, 90);

export interface CloudVm {
  name: string;
  zone: string;
  machineType: string;
  status: string;
  owner: string;
}

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
  project?: string;
  zone?: string;
  template?: string;
  stateDir: string;
  worktreeDir: string;
  configuredVm?: string;
}

interface PersistedCloudState {
  schemaVersion: 1;
  defaultVm: string | null;
}

interface ParsedDryRunSsh {
  user: string;
  hostKeyAlias: string;
  identityFile: string;
  userKnownHostsFile: string;
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

function validateGcpVmName(name: string): string {
  if (!GCP_VM_PATTERN.test(name) || name.length > 63) {
    throw new UsageError(
      "Choose a valid Compute Engine VM name (lowercase letters, digits, hyphens; max 63 chars)",
    );
  }
  return name;
}

function validateProjectId(project: string): string {
  if (!PROJECT_PATTERN.test(project)) {
    throw new UsageError(`Invalid Google Cloud project ID: ${project}`);
  }
  return project;
}

function validateZoneName(zone: string): string {
  if (!ZONE_PATTERN.test(zone)) {
    throw new UsageError(`Invalid Google Cloud zone: ${zone}`);
  }
  return zone;
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

function requireGcloudPath(): string {
  const found = findExecutable("gcloud");
  if (!found) {
    throw new RlError(
      "Install the Google Cloud CLI first: https://cloud.google.com/sdk/docs/install",
    );
  }
  return found;
}

function resolveCloudSettings(
  overrides: {
    stateDir?: string;
    worktreeDir?: string;
    project?: string;
    zone?: string;
    vm?: string;
  } = {},
): CloudSettings {
  const config = loadUserConfig();
  const envResolved = resolveCliEnvironment(undefined);
  const project =
    overrides.project ||
    process.env.RL_CLOUD_PROJECT ||
    config.cloudProject ||
    undefined;
  const zone =
    overrides.zone ||
    process.env.RL_CLOUD_ZONE ||
    config.cloudZone ||
    undefined;
  const template =
    process.env.RL_CLOUD_TEMPLATE || config.cloudTemplate || undefined;
  if (project) validateProjectId(project);
  if (zone) validateZoneName(zone);

  const configuredVm =
    overrides.vm || process.env.RL_CLOUD_VM || config.cloudVm || undefined;
  if (configuredVm) {
    validateHostName(configuredVm);
  }

  return {
    project,
    zone,
    template,
    stateDir: overrides.stateDir ?? envResolved.stateDir,
    worktreeDir: overrides.worktreeDir ?? envResolved.worktreeDir,
    configuredVm,
  };
}

function requireProject(settings: Pick<CloudSettings, "project">): string {
  if (!settings.project) {
    throw new RlError(
      "No Google Cloud project configured. Set cloudProject in ~/.config/rl/config.toml or pass --project <id>.",
    );
  }
  return validateProjectId(settings.project);
}

function requireZone(settings: Pick<CloudSettings, "zone">): string {
  if (!settings.zone) {
    throw new RlError(
      "No Google Cloud zone configured. Set cloudZone in ~/.config/rl/config.toml or pass --zone <zone>.",
    );
  }
  return validateZoneName(settings.zone);
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

function gcloudFlags(project: string): string[] {
  return [`--project=${project}`, `--billing-project=${project}`];
}

async function listCloudVms(
  settings: Pick<CloudSettings, "project">,
): Promise<CloudVm[]> {
  const project = requireProject(settings);
  const gcloud = requireGcloudPath();
  const result = await execute(
    [
      gcloud,
      "compute",
      "instances",
      "list",
      ...gcloudFlags(project),
      "--format=json(name,zone,machineType,status,labels)",
    ],
    process.cwd(),
    { timeoutMs: 25000 },
  );
  if (result.code !== 0) {
    throw new RlError(
      result.stderr.trim() ||
        "Failed to list cloud VMs. Verify your gcloud authentication ('gcloud auth login').",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    throw new RlError(
      "Unexpected JSON output from gcloud compute instances list",
    );
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter(object)
    .map((item) => {
      const labels = object(item.labels) ? item.labels : {};
      const zoneStr = typeof item.zone === "string" ? item.zone : "";
      const machineStr =
        typeof item.machineType === "string" ? item.machineType : "";
      return {
        name: String(item.name ?? ""),
        zone: zoneStr.split("/").at(-1) ?? zoneStr,
        machineType: machineStr.split("/").at(-1) ?? machineStr,
        status: String(item.status ?? "UNKNOWN"),
        owner: typeof labels.owner === "string" ? labels.owner : "-",
      };
    })
    .filter((vm) => Boolean(vm.name))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

async function currentGcloudOwner(): Promise<string | null> {
  const gcloud = findExecutable("gcloud");
  if (!gcloud) return null;
  const result = await execute(
    [gcloud, "config", "get-value", "account"],
    process.cwd(),
    { timeoutMs: 10000 },
  );
  if (result.code !== 0) return null;
  const email = result.stdout.trim();
  if (!email.includes("@")) return null;
  return email
    .split("@")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}

async function resolveTargetVm(
  settings: CloudSettings,
  options: { allowPick?: boolean; requireRunning?: boolean } = {},
): Promise<string> {
  if (settings.configuredVm) {
    return validateHostName(settings.configuredVm);
  }
  const saved = readCloudState(settings.stateDir);
  if (saved.defaultVm) {
    return saved.defaultVm;
  }

  if (!settings.project) {
    throw new RlError(
      "No cloud host configured. Run 'rl cloud use <ssh-host>', set cloudVm in ~/.config/rl/config.toml, or pass --vm <host>.",
    );
  }

  const vms = await listCloudVms(settings);
  if (vms.length === 0) {
    throw new RlError(
      "No cloud VMs found. Create one with 'rl cloud create <name>' or select an SSH host with 'rl cloud use <host>'.",
    );
  }

  const candidates = options.requireRunning
    ? vms.filter((vm) => vm.status === "RUNNING")
    : vms;

  if (candidates.length === 0) {
    const names = vms.map((vm) => `${vm.name} (${vm.status})`).join(", ");
    throw new RlError(
      `No running cloud VMs found (${names}). Start one with 'rl cloud start <name>'.`,
    );
  }

  if (candidates.length === 1) {
    await saveDefaultVm(settings.stateDir, candidates[0].name);
    return candidates[0].name;
  }

  const owner = await currentGcloudOwner();
  if (owner) {
    const owned = candidates.filter((vm) => vm.owner === owner);
    if (owned.length === 1) {
      await saveDefaultVm(settings.stateDir, owned[0].name);
      return owned[0].name;
    }
  }

  if (options.allowPick && process.stdin.isTTY && process.stderr.isTTY) {
    const fzfRows: FzfItem<CloudVm>[] = candidates.map((vm) => ({
      id: vm.name,
      line: `${padCell(vm.name, 24)}  ${padCell(vm.status, 10)}  ${dimText(padCell(vm.machineType, 16))}  ${dimText(vm.owner)}`,
      value: vm,
    }));
    const picked = await runFzf(fzfRows, {
      cwd: process.cwd(),
      prompt: "Cloud VM › ",
      header: `Enter select VM · Esc cancel\n\n${padCell("NAME", 24)}  ${padCell("STATUS", 10)}  ${padCell("MACHINE", 16)}  OWNER`,
      ansi: true,
      numericHeight: true,
      errorLabel: "Cloud VM picker",
      unknownNoun: "VM",
    });
    if (!picked) {
      throw new RlError("No cloud VM selected");
    }
    const chosen = picked.items[0]!.name;
    await saveDefaultVm(settings.stateDir, chosen);
    return chosen;
  }

  throw new RlError(
    `Multiple cloud VMs available (${candidates.map((vm) => vm.name).join(", ")}). Select a default with 'rl cloud use <name>' or pass --vm <name>.`,
  );
}

export function parseShellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let active = false;

  for (const ch of line.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      active = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      active = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      active = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (active) {
        words.push(current);
        current = "";
        active = false;
      }
      continue;
    }
    current += ch;
    active = true;
  }
  if (active) {
    words.push(current);
  }
  return words;
}

export function extractDryRunSshDetails(dryRunOutput: string): ParsedDryRunSsh {
  const lines = dryRunOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sshLine = lines.at(-1) ?? "";
  const tokens = parseShellWords(sshLine);

  let identityFile = path.join(os.homedir(), ".ssh/google_compute_engine");
  let hostKeyAlias = "";
  let userKnownHostsFile = path.join(
    os.homedir(),
    ".ssh/google_compute_known_hosts",
  );
  let target = "";

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "-i" && tokens[i + 1]) {
      identityFile = tokens[++i]!;
      continue;
    }
    if (tok === "-o" && tokens[i + 1]) {
      const opt = tokens[++i]!;
      if (opt.startsWith("HostKeyAlias=")) {
        hostKeyAlias = opt.slice("HostKeyAlias=".length);
      } else if (opt.startsWith("UserKnownHostsFile=")) {
        userKnownHostsFile = opt.slice("UserKnownHostsFile=".length);
      }
      continue;
    }
    if (tok.startsWith("-oHostKeyAlias=")) {
      hostKeyAlias = tok.slice("-oHostKeyAlias=".length);
      continue;
    }
    if (tok.startsWith("-oUserKnownHostsFile=")) {
      userKnownHostsFile = tok.slice("-oUserKnownHostsFile=".length);
      continue;
    }
    if (!tok.startsWith("-") && tok.includes("@")) {
      target = tok;
    }
  }

  const atIndex = target.indexOf("@");
  if (atIndex <= 0) {
    throw new RlError(
      "Could not determine OS Login SSH user from gcloud compute ssh --dry-run",
    );
  }
  const user = target.slice(0, atIndex);
  const targetHost = target.slice(atIndex + 1);
  if (!hostKeyAlias) {
    hostKeyAlias = targetHost;
  }

  if (
    /[\r\n"\\]/.test(user) ||
    /[\r\n"\\]/.test(hostKeyAlias) ||
    /[\r\n"]/.test(identityFile) ||
    /[\r\n"]/.test(userKnownHostsFile)
  ) {
    throw new RlError("Unsafe characters in resolved SSH configuration");
  }

  return {
    user,
    hostKeyAlias,
    identityFile,
    userKnownHostsFile,
  };
}

function sshConfigPaths(home = os.homedir()): {
  sshDir: string;
  configFile: string;
  muxDir: string;
} {
  return {
    sshDir: path.join(home, ".ssh"),
    configFile: path.join(home, ".ssh/config"),
    muxDir: path.join(home, ".rl/ssh"),
  };
}

function hasSshHostEntry(vmName: string, home = os.homedir()): boolean {
  const { configFile } = sshConfigPaths(home);
  if (!fs.existsSync(configFile)) return false;
  const content = fs.readFileSync(configFile, "utf8");
  if (content.includes(`# >>> rl cloud ssh (${vmName}) >>>`)) {
    return true;
  }
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("host ")) return false;
    return trimmed.slice(5).trim().split(/\s+/).includes(vmName);
  });
}

export function buildManagedSshBlock(params: {
  vm: string;
  isDefault: boolean;
  project: string;
  zone: string;
  gcloudPath: string;
  details: ParsedDryRunSsh;
}): string {
  const { vm, isDefault, project, zone, gcloudPath, details } = params;
  const gcloudDir = path.dirname(gcloudPath);
  const pathEntries = [
    ...new Set([
      gcloudDir,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]),
  ].join(":");
  const hostNames = isDefault ? `${vm} rl-cloud` : vm;
  const proxyCmd = `env PATH=${shellQuote(pathEntries)} ${shellQuote(gcloudPath)} compute start-iap-tunnel ${vm} %p --listen-on-stdin --project=${project} --billing-project=${project} --zone=${zone} --verbosity=warning`;

  return [
    `# >>> rl cloud ssh (${vm}) >>>`,
    `Host ${hostNames}`,
    `  HostName ${details.hostKeyAlias}`,
    `  User ${details.user}`,
    `  IdentityFile "${details.identityFile}"`,
    "  IdentitiesOnly yes",
    "  CheckHostIP no",
    "  HashKnownHosts no",
    `  HostKeyAlias ${details.hostKeyAlias}`,
    "  StrictHostKeyChecking yes",
    `  UserKnownHostsFile "${details.userKnownHostsFile}"`,
    "  ProxyUseFdpass no",
    `  ProxyCommand ${proxyCmd}`,
    "  ControlMaster auto",
    `  ControlPath ${SSH_MUX_REL_PATH}`,
    "  ControlPersist 15m",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 3",
    `# <<< rl cloud ssh (${vm}) <<<`,
  ].join("\n");
}

export function upsertSshConfigContent(
  existing: string,
  vm: string,
  block: string,
  isDefault: boolean,
): string {
  let updated = existing;
  if (isDefault) {
    updated = updated.replace(
      /(# >>> rl cloud ssh \([^)]+\) >>>\nHost [^\n]*?)\s+rl-cloud(\n)/g,
      "$1$2",
    );
  }
  const startMarker = `# >>> rl cloud ssh (${vm}) >>>`;
  const endMarker = `# <<< rl cloud ssh (${vm}) <<<`;
  const startIndex = updated.indexOf(startMarker);
  const endIndex = updated.indexOf(endMarker);

  if (startIndex >= 0 && endIndex > startIndex) {
    const before = updated.slice(0, startIndex).replace(/\n*$/, "");
    const after = updated
      .slice(endIndex + endMarker.length)
      .replace(/^\n*/, "");
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }

  const trimmed = updated.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

async function configureSshForVm(
  settings: CloudSettings,
  vmName: string,
  options: { dryRun?: boolean; setAsDefault?: boolean } = {},
): Promise<{
  vm: string;
  configFile: string;
  alias: string | null;
  user: string;
  hostKeyAlias: string;
  block: string;
  wrote: boolean;
}> {
  validateGcpVmName(vmName);
  const project = requireProject(settings);
  const zone = requireZone(settings);
  const gcloudPath = requireGcloudPath();
  const dryRun = await execute(
    [
      gcloudPath,
      "compute",
      "ssh",
      vmName,
      ...gcloudFlags(project),
      `--zone=${zone}`,
      "--tunnel-through-iap",
      "--dry-run",
    ],
    process.cwd(),
    { timeoutMs: 30000 },
  );
  if (dryRun.code !== 0) {
    throw new RlError(
      dryRun.stderr.trim() ||
        `Cannot resolve IAP SSH configuration for ${vmName}. Verify the VM exists and you are signed in to gcloud.`,
    );
  }

  const details = extractDryRunSshDetails(dryRun.stdout);
  const saved = readCloudState(settings.stateDir);
  const isDefault = Boolean(
    options.setAsDefault || !saved.defaultVm || saved.defaultVm === vmName,
  );
  const block = buildManagedSshBlock({
    vm: vmName,
    isDefault,
    project,
    zone,
    gcloudPath,
    details,
  });

  const { sshDir, configFile, muxDir } = sshConfigPaths();
  if (!options.dryRun) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(muxDir, { recursive: true, mode: 0o700 });
    await locked(settings.stateDir, ".cloud-ssh-config.lock", () => {
      const existing = fs.existsSync(configFile)
        ? fs.readFileSync(configFile, "utf8")
        : "";
      const next = upsertSshConfigContent(existing, vmName, block, isDefault);
      atomicWrite(configFile, next);
      fs.chmodSync(configFile, 0o600);
    });
    if (isDefault && saved.defaultVm !== vmName) {
      await saveDefaultVm(settings.stateDir, vmName);
    }
  }

  return {
    vm: vmName,
    configFile,
    alias: isDefault ? "rl-cloud" : null,
    user: details.user,
    hostKeyAlias: details.hostKeyAlias,
    block,
    wrote: !options.dryRun,
  };
}

async function ensureVmSshReady(
  settings: CloudSettings,
  vmName: string,
): Promise<void> {
  const { muxDir } = sshConfigPaths();
  fs.mkdirSync(muxDir, { recursive: true, mode: 0o700 });
  if (
    !hasSshHostEntry(vmName) &&
    !vmName.includes("@") &&
    settings.project &&
    settings.zone &&
    GCP_VM_PATTERN.test(vmName)
  ) {
    await configureSshForVm(settings, vmName);
  }
}

async function runSshCommand(
  settings: CloudSettings,
  vmName: string,
  remoteCommand: string,
  options: { interactive?: boolean; tty?: boolean; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  await ensureVmSshReady(settings, vmName);
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

  let res = await execute(buildArgv(), process.cwd(), {
    timeoutMs: options.timeoutMs ?? 45000,
  });
  if (
    res.code === 255 &&
    settings.project &&
    settings.zone &&
    GCP_VM_PATTERN.test(vmName) &&
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Permission denied/i.test(
      res.stderr,
    )
  ) {
    await configureSshForVm(settings, vmName);
    res = await execute(buildArgv(), process.cwd(), {
      timeoutMs: options.timeoutMs ?? 45000,
    });
  }
  return res;
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
        `Cannot query repositories on cloud VM '${vmName}'. Is the VM running ('rl cloud vms')?`,
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
    throw new RlError(`Invalid probe response from cloud VM '${vmName}'`);
  }
  if (!object(parsed)) {
    throw new RlError(`Unexpected probe response from cloud VM '${vmName}'`);
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
  project?: string;
  zone?: string;
  fetch?: boolean;
  includeDeleted?: boolean;
}): Promise<{
  vm: string;
  rows: OverviewRow[];
  errors: { repository: string; message: string }[];
}> {
  const settings = resolveCloudSettings(options);
  const vm = await resolveTargetVm(settings, { requireRunning: true });
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
  project?: string;
  zone?: string;
}): Promise<{
  vm: string;
  defaultRepo: string | null;
  repositories: CloudRepository[];
}> {
  const settings = resolveCloudSettings(options);
  const vm = await resolveTargetVm(settings, { requireRunning: true });
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

  const sortedWorkspaces = workspaceTargets.toSorted((a, b) => {
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
  await ensureVmSshReady(settings, vm);
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
  options: { agent?: string; resume?: boolean } = {},
): Promise<number> {
  const pathSetup = `export PATH="$HOME/.local/share/rl/bin:$HOME/.local/bin:/usr/local/bin:$PATH"`;
  let innerAction = `exec "\${SHELL:-/bin/bash}" -l`;
  if (options.resume) {
    const agentArg = options.agent ? ` ${shellQuote(options.agent)}` : "";
    innerAction = `rl resume${agentArg}`;
  } else if (options.agent) {
    innerAction = `rl agent start ${shellQuote(options.agent)}`;
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

  await ensureVmSshReady(settings, target.vm);
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
    ["vm", "project", "zone"],
    ["diff", "json", "live", "remote", "cloud"],
  );
  arity(positionals, 0, 1);
  if (values.live && (values.json || values.diff)) {
    throw new UsageError("Expected --live without --json or --diff");
  }

  const settings = resolveCloudSettings({
    stateDir: context.stateDir,
    worktreeDir: context.worktreeDir,
    vm: values.vm as string | undefined,
    project: values.project as string | undefined,
    zone: values.zone as string | undefined,
  });
  const vm = await resolveTargetVm(settings, {
    allowPick: true,
    requireRunning: true,
  });
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
  const vm = await resolveTargetVm(settings, {
    allowPick: true,
    requireRunning: true,
  });

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
    await options.store.adopt(choice.candidate.path, options.defaultBase);
    writeWorkspaceOutput(choice.candidate.path);
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

function renderVmsTable(vms: CloudVm[], defaultVm: string | null): void {
  if (vms.length === 0) {
    console.log("No shared cloud dev VMs found.");
    return;
  }
  const rows: string[][] = [
    ["DEFAULT", "NAME", "ZONE", "MACHINE_TYPE", "STATUS", "OWNER"],
    ...vms.map((vm) => [
      vm.name === defaultVm ? "*" : "",
      sanitizeTerminalText(vm.name),
      sanitizeTerminalText(vm.zone),
      sanitizeTerminalText(vm.machineType),
      sanitizeTerminalText(vm.status),
      sanitizeTerminalText(vm.owner),
    ]),
  ];
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

  const { values, positionals } = args(
    subArgv,
    ["vm", "project", "zone", "agent", "local-port", "output-path"],
    [
      "json",
      "fetch",
      "include-deleted",
      "code",
      "resume",
      "dry-run",
      "remote",
      "include-uncommitted",
    ],
  );

  const settings = resolveCloudSettings({
    stateDir: context.stateDir,
    worktreeDir: context.worktreeDir,
    vm: values.vm as string | undefined,
    project: values.project as string | undefined,
    zone: values.zone as string | undefined,
  });

  switch (sub) {
    case "open": {
      if (passthrough.length > 0) {
        throw new UsageError(
          "Use 'rl cloud ssh [vm] -- <command>' to run arbitrary remote commands",
        );
      }
      arity(positionals, 0, 1);
      const agent = values.agent as string | undefined;
      if (agent && !SUPPORTED_AGENTS.has(agent)) {
        throw new UsageError("Unsupported agent: choose codex, claude, or agy");
      }
      const vm = await resolveTargetVm(settings, {
        allowPick: true,
        requireRunning: true,
      });
      return openCloudInteractive(settings, vm, positionals[0], {
        code: Boolean(values.code),
        agent,
        resume: Boolean(values.resume),
        explicitLocalRepo: context.selectedRepo,
      });
    }

    case "code": {
      arity(positionals, 0, 1);
      const vm = await resolveTargetVm(settings, {
        allowPick: true,
        requireRunning: true,
      });
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
        project: settings.project,
        zone: settings.zone,
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
        project: settings.project,
        zone: settings.zone,
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
        renderOverviewTable(overview.rows);
        console.log(
          "S=staged M=unstaged ?=untracked !=conflicts; +ahead/-behind relative to upstream.",
        );
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
      const vm = await resolveTargetVm(settings, {
        allowPick: true,
        requireRunning: true,
      });
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
      const vm = await resolveTargetVm(settings, {
        allowPick: true,
        requireRunning: true,
      });
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

    case "ssh-config": {
      arity(positionals, 0, 1);
      const vm = positionals[0]
        ? validateGcpVmName(positionals[0])
        : await resolveTargetVm(settings, { allowPick: true });
      const configured = await configureSshForVm(settings, vm, {
        dryRun: Boolean(values["dry-run"]),
        setAsDefault: Boolean(positionals[0]),
      });
      if (values.json) {
        json(configured);
      } else if (values["dry-run"]) {
        console.log(configured.block);
      } else {
        console.log(
          `Configured SSH for ${configured.vm}${configured.alias ? ` (alias: ${configured.alias})` : ""} in ${configured.configFile}`,
        );
        console.log(
          `Native SSH, Git, scp and VS Code Remote-SSH now connect through IAP with connection multiplexing.`,
        );
      }
      return 0;
    }

    case "vms": {
      arity(positionals, 0);
      const project = requireProject(settings);
      const vms = await listCloudVms(settings);
      const defaultVm =
        settings.configuredVm ?? readCloudState(settings.stateDir).defaultVm;
      if (values.json) {
        json({ project, defaultVm, vms });
      } else {
        renderVmsTable(vms, defaultVm);
      }
      return 0;
    }

    case "use": {
      arity(positionals, 0, 1);
      let vmName = positionals[0];
      if (vmName) {
        validateHostName(vmName);
      } else {
        const vms = await listCloudVms(settings);
        if (vms.length === 0) {
          throw new RlError("No cloud VMs found");
        }
        const fzfRows: FzfItem<CloudVm>[] = vms.map((vm) => ({
          id: vm.name,
          line: `${padCell(vm.name, 24)}  ${padCell(vm.status, 10)}  ${padCell(vm.machineType, 16)}  ${vm.owner}`,
          value: vm,
        }));
        const picked = await runFzf(fzfRows, {
          cwd: process.cwd(),
          prompt: "Default Cloud VM › ",
          header: "Enter set default VM · Esc cancel",
          numericHeight: true,
          errorLabel: "Cloud VM picker",
          unknownNoun: "VM",
        });
        if (!picked) return 0;
        vmName = picked.items[0]!.name;
      }
      await saveDefaultVm(settings.stateDir, vmName);
      console.log(`Default cloud host: ${vmName}`);
      return 0;
    }

    case "ssh": {
      arity(positionals, 0, 1);
      const vm = positionals[0]
        ? validateHostName(positionals[0])
        : await resolveTargetVm(settings, {
            allowPick: true,
            requireRunning: true,
          });
      await ensureVmSshReady(settings, vm);
      const sshArgs = ["ssh", ...(passthrough.length === 0 ? ["-t"] : []), vm];
      if (passthrough.length > 0) {
        sshArgs.push(passthrough.map(shellQuote).join(" "));
      }
      const res = await execute(sshArgs, process.cwd(), { interactive: true });
      return res.code;
    }

    case "tunnel": {
      arity(positionals, 0, 2);
      let vm: string;
      let portRaw: string | undefined;
      if (positionals.length === 2) {
        vm = validateHostName(positionals[0]!);
        portRaw = positionals[1];
      } else if (
        positionals.length === 1 &&
        !/^\d+$/.test(positionals[0]!) &&
        HOST_NAME_PATTERN.test(positionals[0]!)
      ) {
        vm = validateHostName(positionals[0]!);
        portRaw = undefined;
      } else {
        vm = await resolveTargetVm(settings, {
          allowPick: true,
          requireRunning: true,
        });
        portRaw = positionals[0];
      }

      const remotePort = Number(portRaw ?? DEFAULT_TUNNEL_PORT);
      const localPort = Number(values["local-port"] ?? remotePort);
      for (const p of [remotePort, localPort]) {
        if (!Number.isInteger(p) || p < 1024 || p > 65535) {
          throw new UsageError(
            "Choose an unprivileged port between 1024 and 65535",
          );
        }
      }

      await ensureVmSshReady(settings, vm);
      console.log(
        `Forwarding http://localhost:${localPort} to ${vm}:${remotePort}. Keep this terminal open.`,
      );
      const res = await execute(
        [
          "ssh",
          "-N",
          "-o",
          "ControlMaster=no",
          "-o",
          "ControlPath=none",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `127.0.0.1:${localPort}:localhost:${remotePort}`,
          vm,
        ],
        process.cwd(),
        { interactive: true },
      );
      return res.code;
    }

    case "create": {
      arity(positionals, 1, 2);
      const vm = validateGcpVmName(positionals[0]!);
      const project = requireProject(settings);
      const zone = requireZone(settings);
      const machineType = positionals[1] ?? DEFAULT_MACHINE_TYPE;
      if (!/^[a-z0-9-]+$/.test(machineType)) {
        throw new UsageError(`Invalid machine type: ${machineType}`);
      }
      const gcloud = requireGcloudPath();
      const accountRes = await execute(
        [gcloud, "config", "get-value", "account"],
        process.cwd(),
        { timeoutMs: 10000 },
      );
      const account = accountRes.stdout.trim();
      if (!account || !account.includes("@")) {
        throw new RlError("Sign in with Google Cloud first: gcloud auth login");
      }
      const owner = account
        .split("@")[0]!
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-");
      const createArgs = [
        gcloud,
        "compute",
        "instances",
        "create",
        vm,
        ...gcloudFlags(project),
        `--zone=${zone}`,
        ...(settings.template
          ? [`--source-instance-template=${settings.template}`]
          : []),
        `--machine-type=${machineType}`,
        `--labels=environment=dev,owner=${owner}`,
      ];
      const res = await execute(createArgs, process.cwd(), {
        interactive: true,
      });
      if (res.code === 0) {
        await saveDefaultVm(settings.stateDir, vm);
      }
      return res.code;
    }

    case "start":
    case "stop": {
      arity(positionals, 0, 1);
      const project = requireProject(settings);
      const zone = requireZone(settings);
      const vm = positionals[0]
        ? validateGcpVmName(positionals[0])
        : await resolveTargetVm(settings, { allowPick: true });
      const gcloud = requireGcloudPath();
      const res = await execute(
        [
          gcloud,
          "compute",
          "instances",
          sub,
          vm,
          ...gcloudFlags(project),
          `--zone=${zone}`,
        ],
        process.cwd(),
        { interactive: true },
      );
      return res.code;
    }

    case "delete": {
      arity(positionals, 1);
      const project = requireProject(settings);
      const zone = requireZone(settings);
      const vm = validateGcpVmName(positionals[0]!);
      const gcloud = requireGcloudPath();
      const res = await execute(
        [
          gcloud,
          "compute",
          "instances",
          "delete",
          vm,
          ...gcloudFlags(project),
          `--zone=${zone}`,
        ],
        process.cwd(),
        { interactive: true },
      );
      return res.code;
    }

    default:
      throw new UsageError(`Unknown cloud command: ${sub}; see rl help cloud`);
  }
}
