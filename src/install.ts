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
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
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
  const manual = new RegExp(
    `^\\s*eval[ \\t]+"\\$\\((?:command[ \\t]+)?rl[ \\t]+(?:setup[ \\t]+shell|init)[ \\t]+${shell}\\)"[ \\t]*(#[^\\r\\n]*)?$`,
  );
  const migrate = (source: string[], replacement: string[] = []) =>
    source.flatMap((line) => {
      const match = manual.exec(line);
      if (!match) return [line];
      const migrated = [...(match[1] ? [match[1]] : []), ...replacement];
      replacement = [];
      return migrated;
    });
  const starts = lines.flatMap((line, index) =>
    line === BEGIN ? [index] : [],
  );
  const ends = lines.flatMap((line, index) => (line === END ? [index] : []));
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0])
      throw new Error(
        "Malformed RL shell integration block; preserve your settings and repair its markers before reinstalling",
      );
    const prefix = migrate(lines.slice(0, starts[0])).join("\n");
    const suffix = migrate(lines.slice(ends[0] + 1)).join("\n");
    return (prefix ? prefix + "\n" : "") + block + "\n" + suffix;
  }
  if (lines.some((line) => manual.test(line)))
    return migrate(lines, [block]).join("\n");
  return (
    text + (text ? (text.endsWith("\n") ? "\n" : "\n\n") : "") + block + "\n"
  );
}

type ShellName = "zsh" | "bash";

function isSupportedShell(value: string): value is ShellName {
  return value === "zsh" || value === "bash";
}

function targetsForShell(
  home: string,
  env: NodeJS.ProcessEnv,
  shell: ShellName,
): string[] {
  if (shell === "zsh") {
    return [
      path.join(env.ZDOTDIR ? path.resolve(home, env.ZDOTDIR) : home, ".zshrc"),
    ];
  }
  const login = [".bash_profile", ".bash_login", ".profile"]
    .map((name) => path.join(home, name))
    .find((file) => fs.existsSync(file));
  return [
    path.join(home, ".bashrc"),
    login ?? path.join(home, ".bash_profile"),
  ];
}

export function configureShell(host: InstallHost, requestedShell?: string) {
  const env = host.env ?? process.env;
  const home = canonical(host.home ?? os.homedir());
  const detected = path.basename(
    env.SHELL ||
      ((host.platform ?? process.platform) === "darwin" ? "zsh" : "bash"),
  );
  const shell = requestedShell ?? detected;
  if (!isSupportedShell(shell))
    throw new Error(
      `Automatic RL shell setup supports zsh and bash. Run 'rl setup install --shell zsh' or '--shell bash' for the shell you use.`,
    );
  const shells: ShellName[] = requestedShell
    ? [shell]
    : [shell, shell === "bash" ? "zsh" : "bash"];
  const root = host.packageRoot ?? PACKAGE_ROOT;
  const node = host.node ?? process.execPath;
  const nodeDirectory = path.dirname(node);
  const executable = path.join(root, "bin/rl");
  const shimDirectory = path.join(home, ".local/share/rl/bin");
  const shim = profileChange(home, path.join(shimDirectory, "rl"), (before) => {
    if (before && !before.startsWith(SHIM))
      throw new Error(
        "The RL installation shim already contains an unmanaged command; it was not replaced",
      );
    return `${SHIM}PATH="$PATH":${shellQuote(nodeDirectory)}\nexec node ${shellQuote(executable)} "$@"\n`;
  });
  shim.mode = 0o755;
  const toolDirectories = [
    ...new Set([
      nodeDirectory,
      ...inspectDependencies(env).flatMap((tool) =>
        tool.path ? [path.dirname(tool.path)] : [],
      ),
    ]),
  ];
  const profiles = shells.flatMap((targetShell) => {
    const block = [
      BEGIN,
      `export PATH=${shellQuote(shimDirectory)}:"$PATH":${toolDirectories.map(shellQuote).join(":")}`,
      `eval "$(node ${shellQuote(executable)} setup shell ${targetShell})"`,
      END,
    ].join("\n");
    return targetsForShell(home, env, targetShell).map((file) =>
      profileChange(home, file, (text) =>
        integration(text, block, targetShell),
      ),
    );
  });
  const byFile = new Map<string, Change>();
  for (const change of [shim, ...profiles]) {
    const existing = byFile.get(change.file);
    if (existing && existing.after !== change.after)
      throw new Error(
        `Conflicting shell setup target: ${change.file} cannot serve both zsh and bash`,
      );
    byFile.set(change.file, change);
  }
  const changes = [...byFile.values()];
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
    shells,
    profiles: [...new Set(profiles.map((change) => change.file))],
    shim: shim.file,
  };
}

/** npm global installs opt into shell setup; project dependencies never do. */
export function autoConfigureShell(host: InstallHost = {}): void {
  const env = host.env ?? process.env;
  if (
    env.npm_config_global !== "true" ||
    /^(1|true)$/i.test(env.RL_SKIP_SHELL_SETUP ?? "") ||
    /^(1|true)$/i.test(env.CI ?? "")
  )
    return;
  if ((host.uid ?? process.getuid?.()) === 0 || env.SUDO_USER || env.SUDO_UID) {
    console.warn(
      "rl: shell setup skipped for elevated installation. Run rl setup install as your normal user.",
    );
    return;
  }
  // npm also sets global=true for dependencies of other global packages.
  // Only the directly installed RL package may change startup configuration.
  const root = canonical(host.packageRoot ?? PACKAGE_ROOT);
  if (
    !env.npm_config_prefix ||
    canonical(
      path.join(env.npm_config_prefix, "lib/node_modules/rl-workspaces"),
    ) !== root
  )
    return;
  try {
    const shell = path.basename(
      env.SHELL ||
        ((host.platform ?? process.platform) === "darwin" ? "zsh" : "bash"),
    );
    const configured = configureShell(host, shell);
    console.log(
      `rl: shell integration enabled in ${configured.profiles.join(", ")}. Open a new terminal to activate workspace switching.`,
    );
    console.log(
      `For this terminal: eval "$(command rl setup shell ${configured.shell})"`,
    );
  } catch (error) {
    // A dotfile problem must not make the installed CLI unavailable.
    console.warn(
      `rl: automatic shell setup skipped: ${error instanceof Error ? error.message : String(error)}. Run rl setup install to repair it.`,
    );
  }
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
  if (positionals.length) {
    throw new Error("Usage: rl setup install [--shell zsh|bash]");
  }

  const code = await setupDependencies([], host);
  if (code !== 0) {
    return code;
  }

  const configured = configureShell(host, values.shell);
  console.log(
    `RL shell integration installed in ${configured.profiles.join(", ")}.`,
  );
  console.log(
    "New terminals can use rl directly. To activate directory switching in this terminal now, run:",
  );
  for (const targetShell of configured.shells) {
    const suffix = configured.shells.length > 1 ? ` # ${targetShell}` : "";
    console.log(
      `  eval "$(${shellQuote(configured.shim)} setup shell ${targetShell})"${suffix}`,
    );
  }
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
