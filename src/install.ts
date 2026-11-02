import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { atomicWrite, canonical, inside, shellQuote } from "./common.js";
import { inspectDependencies, setupDependencies } from "./dependencies.js";

const BEGIN = "# >>> rl shell integration >>>";
const END = "# <<< rl shell integration <<<";
const SHIM = "#!/bin/sh\n# Managed by RL installation\n";
interface InstallHost {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  packageRoot?: string;
  node?: string;
}
interface Change {
  file: string;
  before?: string;
  after: string;
  mode?: number;
}

function profileChange(
  home: string,
  requested: string,
  after: (before: string) => string,
): Change {
  const file = canonical(requested);
  if (!inside(file, home))
    throw new Error(
      `Shell setup path must stay in your home directory: ${requested}`,
    );
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.size > 1024 * 1024))
    throw new Error(`Expected a shell setup file up to 1 MiB: ${requested}`);
  const before = stat ? fs.readFileSync(file, "utf8") : undefined;
  return {
    file,
    before,
    after: after(before ?? ""),
    ...(stat ? { mode: stat.mode & 0o777 } : {}),
  };
}

function integration(text: string, block: string, shell: string): string {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    line === BEGIN ? [index] : [],
  );
  const ends = lines.flatMap((line, index) => (line === END ? [index] : []));
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0])
      throw new Error(
        "Malformed RL shell integration block; preserve your settings and repair its markers before reinstalling",
      );
    const prefix = lines.slice(0, starts[0]).join("\n");
    const suffix = lines.slice(ends[0] + 1).join("\n");
    return (prefix ? prefix + "\n" : "") + block + "\n" + suffix;
  }
  const existing = lines.findIndex((line) =>
    [
      `eval "$(rl setup shell ${shell})"`,
      `eval "$(command rl setup shell ${shell})"`,
      `eval "$(rl init ${shell})"`,
      `eval "$(command rl init ${shell})"`,
    ].includes(line.trim()),
  );
  if (existing >= 0) {
    lines[existing] = block;
    return lines.join("\n");
  }
  return (
    text + (text ? (text.endsWith("\n") ? "\n" : "\n\n") : "") + block + "\n"
  );
}

export function configureShell(host: InstallHost, requestedShell?: string) {
  const env = host.env ?? process.env;
  const home = canonical(host.home ?? os.homedir());
  const shell =
    requestedShell ??
    path.basename(
      env.SHELL ??
        ((host.platform ?? process.platform) === "darwin" ? "zsh" : "bash"),
    );
  if (shell !== "zsh" && shell !== "bash")
    throw new Error(
      `Automatic RL shell setup supports zsh and bash. Run 'rl setup install --shell zsh' or '--shell bash' for the shell you use.`,
    );
  const root =
    host.packageRoot ?? fileURLToPath(new URL("..", import.meta.url));
  const node = host.node ?? process.execPath;
  const executable = path.join(root, "bin/rl");
  const shimDirectory = path.join(home, ".local/share/rl/bin");
  const shim = profileChange(home, path.join(shimDirectory, "rl"), (before) => {
    if (before && !before.startsWith(SHIM))
      throw new Error(
        "The RL installation shim already contains an unmanaged command; it was not replaced",
      );
    return `${SHIM}exec ${shellQuote(node)} ${shellQuote(executable)} "$@"\n`;
  });
  shim.mode = 0o755;
  const toolDirectories = [
    ...new Set([
      path.dirname(node),
      ...inspectDependencies(env).flatMap((tool) =>
        tool.path ? [path.dirname(tool.path)] : [],
      ),
    ]),
  ];
  const block = [
    BEGIN,
    `export PATH=${shellQuote(shimDirectory)}:"$PATH":${toolDirectories.map(shellQuote).join(":")}`,
    `eval "$(${shellQuote(node)} ${shellQuote(executable)} setup shell ${shell})"`,
    END,
  ].join("\n");
  const targets = [
    path.join(
      shell === "zsh" && env.ZDOTDIR ? path.resolve(home, env.ZDOTDIR) : home,
      shell === "zsh" ? ".zshrc" : ".bashrc",
    ),
  ];
  if (shell === "bash") {
    const login = [".bash_profile", ".bash_login", ".profile"]
      .map((name) => path.join(home, name))
      .find((file) => fs.existsSync(file));
    targets.push(login ?? path.join(home, ".bash_profile"));
  }
  const profiles = targets.map((file) =>
    profileChange(home, file, (text) => integration(text, block, shell)),
  );
  const changes = [
    ...new Map(
      [shim, ...profiles].map((change) => [change.file, change]),
    ).values(),
  ];
  for (const change of changes) {
    const current = fs.existsSync(change.file)
      ? fs.readFileSync(change.file, "utf8")
      : undefined;
    if (current !== change.before)
      throw new Error("Shell configuration changed during installation; retry");
  }
  for (const change of changes) {
    if (change.before !== change.after) atomicWrite(change.file, change.after);
    if (change.mode !== undefined) fs.chmodSync(change.file, change.mode);
  }
  return {
    shell,
    profiles: profiles.map((change) => change.file),
    shim: shim.file,
  };
}

export async function installRl(
  argv: string[],
  host: InstallHost = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { shell: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length)
    throw new Error("Usage: rl setup install [--shell zsh|bash]");
  const env = host.env ?? process.env;
  if (
    env.npm_lifecycle_event === "postinstall" &&
    env.npm_config_global !== "true"
  ) {
    console.log(
      "RL checkout installed. Run 'rl setup install' to install system tools and register shell integration.",
    );
    return 0;
  }
  const code = await setupDependencies([], host);
  if (code) return code;
  const configured = configureShell(host, values.shell);
  console.log(
    `RL shell integration installed in ${configured.profiles.join(", ")}.`,
  );
  console.log(
    "New terminals can use rl directly. To activate directory switching in this terminal now, run:",
  );
  console.log(
    `  eval "$(${shellQuote(configured.shim)} setup shell ${configured.shell})"`,
  );
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await installRl(process.argv.slice(2));
  } catch (error) {
    console.error(
      `RL installation: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
