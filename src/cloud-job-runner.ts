// Sent over SSH and run with Node on the host. Keep imports to Node built-ins:
// the remote RL installation supplies its own agent adapters and permissions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fork, spawn, spawnSync } from "node:child_process";

export interface CloudJob {
  id: string;
  workspace: string;
  repository: string;
  branch: string;
  agent: string;
  model?: string;
  status: "starting" | "running" | "completed" | "failed" | "interrupted";
  pid?: number;
  agentPid?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  log: string;
  lock: string;
}

interface Request {
  action: "launch" | "status";
  id?: string;
  workspace: string;
  repository: string;
  repositoryRoot: string;
  branch: string;
  agent: string;
  model?: string;
  prompt: string;
  source: string;
}

const root = path.join(
  process.env.RL_STATE_DIR || path.join(os.homedir(), ".rl/instances"),
  "cloud-jobs",
);
const stateFile = (dir: string) => path.join(dir, "job.json");
const read = <T>(file: string | number): T =>
  JSON.parse(fs.readFileSync(file, "utf8"));
function write(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(tmp, file);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function release(job: CloudJob): void {
  try {
    if (read<{ id: string }>(path.join(job.lock, "owner.json")).id === job.id) {
      fs.unlinkSync(path.join(job.lock, "owner.json"));
      fs.rmdirSync(job.lock);
    }
  } catch {
    /* An incomplete lock is deliberately retained for inspection. */
  }
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.stderr?.trim() ||
        result.error?.message ||
        "Cannot validate remote workspace",
    );
  return result.stdout.trim();
}
function validateWorkspace(request: Request): void {
  const actual = fs.realpathSync(
    git(request.workspace, "rev-parse", "--show-toplevel"),
  );
  const common = (cwd: string) =>
    fs.realpathSync(
      git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
  if (
    actual !== request.workspace ||
    common(actual) !== common(request.repositoryRoot) ||
    git(actual, "branch", "--show-current") !== request.branch
  )
    throw new Error(
      "Remote workspace identity changed; select it again before launching",
    );
}
function executable(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error("Invalid agent executable");
  if (
    !(process.env.PATH || "").split(path.delimiter).some((dir) => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  )
    throw new Error(
      `Required executable is not installed on the host: ${name}`,
    );
}
function status(id: string): CloudJob {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid cloud job identifier");
  const dir = path.join(root, id);
  const job = read<CloudJob>(stateFile(dir));
  if (
    (job.status === "running" || job.status === "starting") &&
    job.pid &&
    !alive(job.pid)
  ) {
    const latest = read<CloudJob>(stateFile(dir));
    if (latest.status !== "running" && latest.status !== "starting")
      return latest;
    job.status = "interrupted";
    job.error =
      "Supervisor stopped without an exit report. Inspect the log and workspace lock before relaunching.";
    job.finishedAt = new Date().toISOString();
    write(stateFile(dir), job);
  }
  return job;
}

async function launch(request: Request): Promise<CloudJob> {
  if (
    typeof request.prompt !== "string" ||
    !request.prompt.trim() ||
    request.prompt.includes("\0")
  )
    throw new Error("A non-empty prompt without NUL characters is required");
  executable("rl");
  executable(request.agent);
  request.workspace = fs.realpathSync(request.workspace);
  validateWorkspace(request);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockRoot = path.join(root, "locks");
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(
    lockRoot,
    createHash("sha256").update(request.workspace).digest("hex"),
  );
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "unknown (incomplete launch)";
    try {
      owner = read<{ id: string }>(path.join(lock, "owner.json")).id;
    } catch {
      /* Still locked. */
    }
    throw new Error(
      `Workspace already has a job lock: ${owner}. Inspect it with rl cloud job ${owner}. Lock: ${lock}`,
    );
  }
  const id = randomUUID(),
    dir = path.join(root, id);
  const job: CloudJob = {
    id,
    workspace: request.workspace,
    repository: request.repository,
    branch: request.branch,
    agent: request.agent,
    ...(request.model === undefined ? {} : { model: request.model }),
    status: "starting",
    startedAt: new Date().toISOString(),
    lock,
    log: path.join(dir, "output.log"),
  };
  let spawned = false;
  try {
    write(path.join(lock, "owner.json"), { id });
    fs.mkdirSync(dir, { mode: 0o700 });
    write(stateFile(dir), job);
    const workerFile = path.join(dir, "runner.mjs");
    fs.writeFileSync(workerFile, request.source, { mode: 0o600, flag: "wx" });
    // Prompt travels as private JSON, never through executable shell text.
    write(path.join(dir, "request.json"), { ...request, source: undefined });
    const log = fs.openSync(job.log, "ax", 0o600);
    const child = fork(workerFile, ["--worker", dir], {
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
      execArgv: [],
    });
    fs.closeSync(log);
    spawned = true;
    job.pid = child.pid;
    write(stateFile(dir), job);
    write(path.join(lock, "owner.json"), { id, pid: child.pid });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.connected) child.disconnect();
        child.unref();
        child.channel?.unref();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        done(
          new Error(
            `Launch confirmation timed out for job ${id}; inspect its status before retrying`,
          ),
        );
      }, 10000);
      child.once("message", (message: { error?: string }) =>
        done(
          message.error
            ? new Error(`Job ${id}: ${message.error}. Log: ${job.log}`)
            : undefined,
        ),
      );
      child.once("error", (error) => {
        spawned = false;
        done(error);
      });
      child.once("exit", (code, signal) =>
        done(
          new Error(
            `Job ${id} supervisor exited before confirmation (${signal ?? code}); inspect its log`,
          ),
        ),
      );
      child.send({ start: true }, (error) => {
        if (error) done(error);
      });
    });
    // Catch immediate native CLI/authentication failures without waiting for the task.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = status(id);
    if (current.status === "failed" || current.status === "interrupted")
      throw new Error(
        `Job ${id} ${current.status}: ${current.error || `exit ${current.exitCode}`}. Log: ${current.log}`,
      );
    return current;
  } catch (error) {
    if (!spawned) {
      job.status = "failed";
      job.error = String(error);
      job.finishedAt = new Date().toISOString();
      if (fs.existsSync(dir)) write(stateFile(dir), job);
      release(job);
    }
    throw error;
  }
}

async function worker(dir: string): Promise<void> {
  const job = read<CloudJob>(stateFile(dir));
  const request = read<Request>(path.join(dir, "request.json"));
  let started = false;
  const fail = (error: Error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    write(stateFile(dir), job);
    release(job);
    if (process.connected) process.send!({ error: error.message }, () => {});
  };
  process.once("disconnect", () => {
    if (!started)
      fail(new Error("Launcher disconnected before starting the agent"));
  });
  process.once("message", () => {
    started = true;
    try {
      validateWorkspace(request);
      const env = { ...process.env };
      delete env.RL_SHELL_OUTPUT;
      delete env.RL_SHELL_PROTOCOL;
      const child = spawn(
        "rl",
        [
          "--repo",
          request.repository,
          "agent",
          "run",
          request.agent,
          "--prompt",
          request.prompt,
          ...(request.model === undefined
            ? []
            : ["--", "--model", request.model]),
        ],
        {
          cwd: request.workspace,
          env,
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      child.once("spawn", () => {
        job.status = "running";
        job.pid = process.pid;
        job.agentPid = child.pid;
        write(stateFile(dir), job);
        if (process.connected) process.send!({ started: true }, () => {});
      });
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        job.status = code === 0 ? "completed" : "failed";
        job.exitCode = code;
        job.signal = signal;
        job.finishedAt = new Date().toISOString();
        if (code !== 0)
          job.error = `Agent exited with ${signal ?? code}; inspect output.log`;
        write(stateFile(dir), job);
        release(job);
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

try {
  if (process.argv[2] === "--worker") await worker(process.argv[3]);
  else {
    const request = read<Request>(0);
    const result =
      request.action === "status" ? status(request.id!) : await launch(request);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
