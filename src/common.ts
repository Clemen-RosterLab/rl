import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import lockfile from "proper-lockfile";

export const now = (): string => new Date().toISOString();
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const json = (data: unknown): void =>
  console.log(JSON.stringify(data, null, 2));
export function canonical(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
    const parent = path.dirname(absolute);
    return parent === absolute
      ? absolute
      : path.join(canonical(parent), path.basename(absolute));
  }
}
export const expandHome = (value: string): string =>
  value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : value;
export function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
  ])
    delete env[key];
  return env;
}
export function run(argv: string[], cwd: string, raw = false): string {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: argv[0] === "git" ? gitEnv() : process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() || `Command failed: ${argv.join(" ")}`,
    );
  return raw ? result.stdout : result.stdout.trim();
}
export const git = (cwd: string, ...args: string[]): string =>
  run(["git", "-C", cwd, ...args], cwd);
export const gitRaw = (cwd: string, ...args: string[]): string =>
  run(["git", "-C", cwd, ...args], cwd, true);
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export async function execute(
  argv: string[],
  cwd: string,
  options: {
    input?: string;
    interactive?: boolean;
    terminalError?: boolean;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      timeout: options.timeoutMs,
      env: options.env ?? (argv[0] === "git" ? gitEnv() : process.env),
      stdio: options.interactive
        ? "inherit"
        : ["pipe", "pipe", options.terminalError ? "inherit" : "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        code: code ?? 128 + (os.constants.signals[signal!] ?? 1),
        stdout,
        stderr,
      });
    });
  });
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function readJson(file: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!object(data)) throw new Error("Expected a JSON object");
    return data;
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${message(error)}`);
  }
}
export function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.rl-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export const writeJson = (file: string, data: unknown): void =>
  atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
export async function locked<T>(
  directory: string,
  name: string,
  action: () => T | Promise<T>,
): Promise<T> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    realpath: false,
    lockfilePath: path.join(directory, name),
    stale: 120000,
    retries: { retries: 300, factor: 1, minTimeout: 25, maxTimeout: 100 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
export function sessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  )
    throw new Error(
      "Expected the agent's full session UUID, not a name or prefix",
    );
  return value.toLowerCase();
}
// Normalize timezone offsets while retaining Python's microsecond timestamp precision.
export function timestamp(value: string): bigint {
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Invalid timestamp");
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return (
    BigInt(Date.parse(value)) * 1000000n +
    BigInt(fraction.slice(3, 9).padEnd(6, "0"))
  );
}
export function args(
  argv: string[],
  strings: string[],
  booleans: string[] = [],
  short: Record<string, string> = {},
) {
  const options: Record<
    string,
    { type: "string" | "boolean"; short?: string }
  > = {};
  for (const name of strings)
    options[name] = {
      type: "string",
      ...(short[name] ? { short: short[name] } : {}),
    };
  for (const name of booleans)
    options[name] = {
      type: "boolean",
      ...(short[name] ? { short: short[name] } : {}),
    };
  return parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
  });
}
export function required(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing --${key}`);
  return value;
}
export function arity(values: string[], min: number, max = min): void {
  if (values.length < min || values.length > max)
    throw new Error("Invalid command arguments; run rl --help");
}
export async function pooled<T, R>(
  items: T[],
  limit: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await action(items[index]);
      }
    }),
  );
  return results;
}
export const isSymlink = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
