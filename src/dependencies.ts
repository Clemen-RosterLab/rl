import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const TOOL_NAMES = ["git", "zsh", "fzf", "gh"] as const;
type Tool = (typeof TOOL_NAMES)[number];
interface Host {
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
}
interface ToolStatus {
  name: Tool;
  path: string | null;
  available: boolean;
  version: string | null;
}
interface InstallCommand {
  executable: string;
  args: string[];
}

export function findExecutable(name: string, env = process.env): string | null {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}

export function inspectDependencies(env = process.env): ToolStatus[] {
  return TOOL_NAMES.map((name) => {
    const executable = findExecutable(name, env);
    const probe = executable
      ? spawnSync(executable, ["--version"], {
          env,
          encoding: "utf8",
          timeout: 5000,
        })
      : undefined;
    return {
      name,
      path: executable,
      available: probe?.status === 0,
      version:
        probe?.status === 0
          ? (probe.stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? null)
          : null,
    };
  });
}

function installPlan(
  missing: Tool[],
  host: Host,
  interactive: boolean,
): InstallCommand[] {
  const env = host.env ?? process.env;
  const platform = host.platform ?? process.platform;
  const brew = findExecutable("brew", env);
  if (brew) return [{ executable: brew, args: ["install", ...missing] }];
  if (platform === "darwin")
    throw new Error(
      "Homebrew is required to install missing RL tools on macOS. Install it from https://brew.sh, then run 'rl setup dependencies'.",
    );
  if (platform !== "linux") throw new Error("RL supports macOS and Linux");
  const managers = [
    { name: "apt-get", args: ["install", "-y"], packages: missing },
    { name: "dnf", args: ["install", "-y"], packages: missing },
    { name: "yum", args: ["install", "-y"], packages: missing },
    {
      name: "pacman",
      args: ["-S", "--needed", "--noconfirm"],
      packages: missing.map((name) => (name === "gh" ? "github-cli" : name)),
    },
    {
      name: "apk",
      args: ["add"],
      packages: missing.map((name) => (name === "gh" ? "github-cli" : name)),
    },
  ];
  for (const manager of managers) {
    const executable = findExecutable(manager.name, env);
    if (!executable) continue;
    const commands =
      manager.name === "apt-get"
        ? [
            { executable, args: ["update"] },
            { executable, args: [...manager.args, ...manager.packages] },
          ]
        : [{ executable, args: [...manager.args, ...manager.packages] }];
    const uid = host.uid ?? process.getuid?.();
    if (uid === 0) return commands;
    const sudo = findExecutable("sudo", env);
    if (!sudo)
      throw new Error(
        `Installing missing RL tools requires administrator access. Run: sudo ${manager.name} ${[...manager.args, ...manager.packages].join(" ")}`,
      );
    return commands.map((command) => ({
      executable: sudo,
      args: [
        ...(interactive ? [] : ["-n"]),
        command.executable,
        ...command.args,
      ],
    }));
  }
  throw new Error(
    "No supported package manager found. Install Git, zsh, fzf and gh, then run 'rl setup dependencies --check'.",
  );
}

export async function setupDependencies(
  argv: string[],
  host: Host = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      install: { type: "boolean" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (
    positionals.length ||
    (values.check && (values.install || values["dry-run"]))
  )
    throw new Error(
      "Usage: rl setup dependencies [--check | --dry-run] [--json]",
    );
  const env = host.env ?? process.env;
  let tools = inspectDependencies(env);
  const missing = tools
    .filter((tool) => !tool.available)
    .map((tool) => tool.name);
  let commands: InstallCommand[] = [];
  let error: string | undefined;
  const interactive =
    !!process.stdin.isTTY && !!process.stdout.isTTY && !values.json;
  if (missing.length && !values.check) {
    try {
      commands = installPlan(missing, host, interactive);
      if (!values["dry-run"]) {
        console.error(`RL: installing missing tools: ${missing.join(", ")}`);
        for (const command of commands) {
          const result = spawnSync(command.executable, command.args, {
            env: {
              ...env,
              HOMEBREW_NO_AUTO_UPDATE: "1",
              ...(interactive ? {} : { NONINTERACTIVE: "1" }),
            },
            stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          });
          if (!interactive) {
            if (result.stdout) process.stderr.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
          }
          if (result.error || result.status !== 0)
            throw new Error(
              `Could not install RL tools. Run '${command.executable} ${command.args.filter((arg) => arg !== "-n").join(" ")}' in your terminal, then rerun 'rl setup dependencies'.`,
            );
        }
        tools = inspectDependencies(env);
        const remaining = tools
          .filter((tool) => !tool.available)
          .map((tool) => tool.name);
        if (remaining.length)
          throw new Error(
            `Tools still unavailable on PATH: ${remaining.join(", ")}. Add the package manager's bin directory to PATH, then rerun 'rl setup dependencies'.`,
          );
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const ready = tools.every((tool) => tool.available);
  const report = {
    ready,
    dryRun: !!values["dry-run"],
    tools,
    commands,
    ...(error ? { error } : {}),
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const tool of tools)
      console.log(
        `${tool.name}: ${tool.available ? (tool.version ?? "installed") : "missing or not working"}`,
      );
    if (values["dry-run"])
      for (const command of commands)
        console.log(
          `Would run: ${command.executable} ${command.args.join(" ")}`,
        );
    if (error) console.error(`RL: ${error}`);
    else if (!ready && values.check)
      console.error("Run 'rl setup dependencies' to install missing tools.");
  }
  return error ? 1 : values["dry-run"] || ready ? 0 : 1;
}

export function executableError(
  error: Error,
  executable: string,
  cwd: string,
): Error {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") return error;
  if (!fs.existsSync(cwd))
    return new Error(`Working directory does not exist: ${cwd}`, {
      cause: error,
    });
  if ((TOOL_NAMES as readonly string[]).includes(path.basename(executable)))
    return new Error(
      `Missing required tool ${path.basename(executable)}. Run 'rl setup dependencies' to install Git, zsh, fzf and gh.`,
      { cause: error },
    );
  return error;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await setupDependencies(process.argv.slice(2));
  } catch (error) {
    console.error(
      `RL: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
