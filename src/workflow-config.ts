import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execute, git, gitEnv, inside } from "./common.js";
import { isJsonObject, readJsonObject } from "./json.js";

export const WORKFLOW_FILE = ".rl/workflows.json";
const RESERVED_DIRECTORIES = new Set([".git", ".rl", ".codex", ".claude"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PREFIX = /^(APP_|PUBLIC_|VITE_|NEXT_PUBLIC_|REACT_APP_)/;
const ENV_NAMES = new Set(["PORT", "NODE_ENV", "DATABASE_URL", "REDIS_URL"]);
const PORT_START = 10000;
const PORT_COUNT = 40000;
const CONFIG_KEYS = new Set(["copy", "env", "onCreate", "onOpen"]);
export interface WorkflowConfig {
  copy: string[];
  env: Record<string, string>;
  onCreate: string[][];
  onOpen: string[][];
}
export const EMPTY_WORKFLOW: WorkflowConfig = {
  copy: [],
  env: {},
  onCreate: [],
  onOpen: [],
};

export function readWorkflowConfig(repo: string): WorkflowConfig {
  const file = path.join(repo, WORKFLOW_FILE);
  if (
    fs
      .lstatSync(path.dirname(file), { throwIfNoEntry: false })
      ?.isSymbolicLink() ||
    fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()
  )
    throw new Error("Workflow configuration must not be a symlink");
  if (!fs.existsSync(file)) return { ...EMPTY_WORKFLOW };
  const data = readJsonObject(file);
  for (const key of Object.keys(data))
    if (!CONFIG_KEYS.has(key))
      throw new Error(`Unknown workflow setting: ${key}`);
  const copy = data.copy ?? [];
  if (
    !Array.isArray(copy) ||
    !copy.every(
      (item): item is string => typeof item === "string" && item.length > 0,
    )
  )
    throw new Error("Workflow copy must be an array of relative paths");
  const env: Record<string, string> = {};
  if (data.env !== undefined) {
    if (!isJsonObject(data.env))
      throw new Error("Workflow env must be an object of strings");
    for (const [key, value] of Object.entries(data.env)) {
      if (
        !ENV_NAME.test(key) ||
        (!ENV_PREFIX.test(key) && !ENV_NAMES.has(key)) ||
        typeof value !== "string" ||
        value.includes("\0")
      )
        throw new Error(
          `Unsupported workflow environment variable: ${key}. Use APP_, PUBLIC_, VITE_, NEXT_PUBLIC_, REACT_APP_ prefixes or PORT, NODE_ENV, DATABASE_URL, REDIS_URL`,
        );
      env[key] = value;
    }
  }
  const result: WorkflowConfig = { copy, env, onCreate: [], onOpen: [] };
  for (const event of ["onCreate", "onOpen"] as const) {
    const commands = data[event] ?? [];
    if (!Array.isArray(commands))
      throw new Error(`Workflow ${event} must be an array of argv arrays`);
    for (const command of commands) {
      if (
        !Array.isArray(command) ||
        !command.length ||
        !command.every(
          (argument): argument is string =>
            typeof argument === "string" && !argument.includes("\0"),
        ) ||
        !command[0]
      )
        throw new Error(
          `Workflow ${event} commands must be nonempty argv arrays`,
        );
      result[event].push(command);
    }
  }
  return result;
}

export function workflowEnvironment(
  repo: string,
  workspace: string,
  config: WorkflowConfig,
): NodeJS.ProcessEnv {
  const hash = createHash("sha256")
    .update(repo)
    .update("\0")
    .update(workspace)
    .digest();
  const inherited = gitEnv();
  delete inherited.RL_SHELL_OUTPUT;
  delete inherited.RL_INTERNAL_SHELL;
  return {
    ...inherited,
    ...config.env,
    RL_REPO: "",
    RL_REPO_ROOT: repo,
    RL_WORKSPACE: workspace,
    RL_PORT: String(PORT_START + (hash.readUInt32BE(0) % PORT_COUNT)),
  };
}

function containedPath(root: string, relative: string): string {
  const components = relative.split(/[\\/]/);
  if (
    path.isAbsolute(relative) ||
    components.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        RESERVED_DIRECTORIES.has(part.toLowerCase()),
    ) ||
    relative.includes("\0")
  )
    throw new Error(`Unsafe workflow copy path: ${relative}`);
  const target = path.resolve(root, relative);
  if (!inside(target, root))
    throw new Error(`Copy path escapes workspace: ${relative}`);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Workflow copy does not support symlinks: ${current}`);
  }
  return target;
}

interface CopyFile {
  source: string;
  destination: string;
  relative: string;
}
function collectCopies(
  repo: string,
  workspace: string,
  relative: string,
  files: CopyFile[],
  stateDir?: string,
): void {
  const source = containedPath(repo, relative);
  const destination = containedPath(workspace, relative);
  if (
    stateDir &&
    [source, destination].some(
      (file) => file === stateDir || inside(file, stateDir),
    )
  )
    throw new Error(`Workflow copy cannot include RL state: ${relative}`);
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory())
      throw new Error(`Copy destination is not a directory: ${destination}`);
    for (const child of fs.readdirSync(source).sort())
      collectCopies(
        repo,
        workspace,
        path.join(relative, child),
        files,
        stateDir,
      );
    return;
  }
  if (!stat.isFile())
    throw new Error(
      `Copy supports only regular files and directories: ${relative}`,
    );
  for (const root of [repo, workspace]) {
    if (git(root, "--literal-pathspecs", "ls-files", "--", relative))
      throw new Error(`Workflow copy path is tracked: ${relative}`);
    try {
      git(root, "check-ignore", "--no-index", "--", relative);
    } catch {
      throw new Error(
        `Workflow copy path must be ignored in source and destination: ${relative}`,
      );
    }
  }
  if (fs.existsSync(destination)) {
    if (!fs.lstatSync(destination).isFile())
      throw new Error(`Copy destination is not a regular file: ${destination}`);
    return;
  }
  if (!files.some((file) => file.destination === destination))
    files.push({ source, destination, relative });
}

export async function setupWorkspace(
  repo: string,
  workspace: string,
  options: {
    dryRun?: boolean;
    create?: boolean;
    open?: boolean;
    stateDir?: string;
  } = {},
): Promise<number> {
  const config = readWorkflowConfig(repo);
  const files: CopyFile[] = [];
  for (const relative of new Set(config.copy))
    collectCopies(repo, workspace, relative, files, options.stateDir);
  const commands = [
    ...(options.create ? config.onCreate : []),
    ...(options.open ? config.onOpen : []),
  ];
  for (const file of files)
    console.error(`${options.dryRun ? "Would copy" : "Copy"} ${file.relative}`);
  for (const command of commands)
    console.error(
      `${options.dryRun ? "Would run" : "Run"} ${JSON.stringify(command)}`,
    );
  if (options.dryRun) return 0;
  for (const file of files) {
    containedPath(repo, file.relative);
    containedPath(workspace, file.relative);
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    fs.copyFileSync(
      file.source,
      file.destination,
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
  }
  for (const command of commands) {
    const result = await execute(command, workspace, {
      interactive: true,
      env: workflowEnvironment(repo, workspace, config),
    });
    if (result.code !== 0) return result.code;
  }
  return 0;
}
