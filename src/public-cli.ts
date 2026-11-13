import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { main as agentLaunchMain } from "./agent-launch.js";
import { main as agentWorkflowsMain } from "./agent-workflows.js";
import { main as cleanMain } from "./clean.js";
import {
  recoverDeletedDirectory,
  writeWorkspaceOutput,
} from "./command-context.js";
import { canonical, message, shellQuote } from "./common.js";
import { main as deleteMain } from "./delete.js";
import { setupDependencies } from "./dependencies.js";
import { isUsageError, RlError, UsageError } from "./errors.js";
import { main as gitMain } from "./git-workflow.js";
import { explicitHelp, topicHelp, usageHintForWords } from "./help.js";
import { installRl } from "./install.js";
import { main as mcpSetupMain } from "./mcp-setup.js";
import { main as mcpMain } from "./mcp.js";
import { candidates, select } from "./picker.js";
import { main as prUpdateMain } from "./pr-update.js";
import { main as prWorkflowMain } from "./pr-workflow.js";
import {
  main as reposMain,
  resolveRepositorySettings,
  type Settings as RepoSettings,
} from "./repos.js";
import { main as feedbackMain } from "./review-feedback.js";
import { main as reviewMain } from "./review.js";
import { main as stateMain } from "./state.js";
import { main as storageMain } from "./storage.js";
import { Store } from "./store.js";
import { main as summaryMain } from "./summary.js";
import { main as syncMain } from "./sync.js";
import { main as taskMain } from "./task.js";
import { resolveCliEnvironment } from "./user-config.js";
import { main as workflowMain } from "./workflow.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const REMOVED_COMMANDS = new Set([
  "new",
  "open",
  "instances",
  "merge",
  "summary",
  "handoff",
  "mcp",
  "session",
  "context",
  "progress",
  "config",
  "adopt",
  "init",
]);

const GROUP_TOPICS = new Set([
  "agent",
  "workflow",
  "policy",
  "repo",
  "git",
  "notes",
]);

const AUTOMATION_AGENT_ACTIONS = new Set(["list", "show", "add", "set"]);

const safeText = (value: string): string =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function readPackageVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function hasHelpFlag(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

function renderShellIntegration(shell: "zsh" | "bash"): string {
  if (shell === "zsh") {
    return `source ${shellQuote(path.join(PACKAGE_ROOT, "shell/rl.zsh"))}`;
  }

  const cliPath = path.join(PACKAGE_ROOT, "dist/public-cli.js");
  const nodeDir = path.dirname(process.execPath);
  return [
    `_rl_cli=${shellQuote(cliPath)}`,
    `_rl_node_dir=${shellQuote(nodeDir)}`,
    "rl() {",
    '  local tmp_dir="${TMPDIR:-/tmp}"',
    '  local destination_file payload mode destination result previous="$PWD"',
    '  destination_file=$(mktemp "${tmp_dir%/}/rl-shell.XXXXXXXX") || return 1',
    '  if RL_SHELL_OUTPUT="$destination_file" RL_SHELL_PROTOCOL=v2 RL_PREVIOUS_WORKSPACE="${RL_PREVIOUS_WORKSPACE:-}" PATH="$PATH:$_rl_node_dir" node "$_rl_cli" "$@"; then',
    "    result=0",
    "  else",
    "    result=$?",
    "  fi",
    '  payload=$(cat -- "$destination_file")',
    '  rm -f -- "$destination_file"',
    '  if [[ -n "$payload" ]]; then',
    '    mode="${payload%%:*}"',
    '    destination="${payload#*:}"',
    '    if [[ -n "$destination" ]]; then',
    '      builtin cd -- "$destination" || return 1',
    '      if [[ "$mode" == "cd" ]]; then',
    '        RL_PREVIOUS_WORKSPACE="$previous"',
    "      fi",
    "    fi",
    "  fi",
    '  return "$result"',
    "}",
  ].join("\n");
}

function stripLeadingRepoOption(argv: string[]): {
  selectedRepo?: string;
  rest: string[];
} {
  if (argv[0] === "--repo") {
    if (!argv[1]) {
      throw new UsageError("Usage: rl --repo <alias> <command>");
    }
    return { selectedRepo: argv[1], rest: argv.slice(2) };
  }
  if (argv[0]?.startsWith("--repo=")) {
    const alias = argv[0].slice("--repo=".length);
    if (!alias) {
      throw new RlError("Repository alias is required");
    }
    return { selectedRepo: alias, rest: argv.slice(1) };
  }
  return { rest: argv };
}

function optionsBeforeSeparator(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  return separator < 0 ? [...argv] : argv.slice(0, separator);
}

export async function runPublicCli(rawArgv: string[]): Promise<number> {
  if (rawArgv[0] === "__hook") {
    return stateMain(rawArgv.slice(1));
  }

  if (rawArgv[0] === "--version" || rawArgv[0] === "-V") {
    console.log(readPackageVersion());
    return 0;
  }

  // Help is independent of repository routing, config files, and installed tools.
  const withoutPreviewRepo =
    rawArgv[0] === "--repo"
      ? rawArgv.slice(2)
      : rawArgv[0]?.startsWith("--repo=")
        ? rawArgv.slice(1)
        : rawArgv;

  if (
    withoutPreviewRepo[0] === "help" ||
    hasHelpFlag(withoutPreviewRepo) ||
    (withoutPreviewRepo.length === 1 && GROUP_TOPICS.has(withoutPreviewRepo[0]))
  ) {
    try {
      console.log(explicitHelp(rawArgv));
      return 0;
    } catch (error) {
      console.error(
        `rl: ${safeText(message(error))}\nRun rl help for available commands.`,
      );
      return 1;
    }
  }

  let publicWords = withoutPreviewRepo;

  try {
    const { selectedRepo: explicitRepo, rest: args } =
      stripLeadingRepoOption(rawArgv);
    publicWords = args;

    const [command, ...rest] = args;

    if (command && REMOVED_COMMANDS.has(command)) {
      console.error(`Unknown command: ${command}`);
      console.error("Run rl help for available commands.");
      return 1;
    }

    if (command === "status") {
      const opts = optionsBeforeSeparator(rest);
      if (opts.includes("--all") || opts.includes("--list")) {
        console.error("Use rl list for workspace overviews.");
        return 1;
      }
    }

    // Standalone setup commands work before repository/config resolution.
    if (command === "setup" && rest[0] === "shell") {
      if (rest.length === 1) {
        console.log(topicHelp(["setup", "shell"]));
        return 0;
      }
      if (rest.length !== 2 || (rest[1] !== "zsh" && rest[1] !== "bash")) {
        console.error("Usage: rl setup shell <zsh|bash>");
        return 1;
      }
      console.log(renderShellIntegration(rest[1]));
      return 0;
    }

    if (command === "setup" && rest[0] === "dependencies") {
      return await setupDependencies(rest.slice(1));
    }

    if (command === "setup" && rest[0] === "install") {
      return await installRl(rest.slice(1));
    }

    if (command === "git") {
      if (rest[0] !== "merge") {
        console.error(`Unknown git command: ${rest[0] ?? ""}`);
        console.error("Run rl help git for available commands.");
        return 1;
      }
    }

    if (command === "notes") {
      const action = rest[0];
      if (
        action !== "summary" &&
        action !== "show" &&
        action !== "path" &&
        action !== "set" &&
        action !== "append"
      ) {
        console.error(`Unknown notes command: ${action ?? ""}`);
        console.error("Run rl help notes for available commands.");
        return 1;
      }
      if (action !== "summary") {
        const noteKind = rest[1] ?? "context";
        if (noteKind !== "context" && noteKind !== "progress") {
          console.error(
            `Unknown document: ${noteKind}. Use context or progress.`,
          );
          console.error(topicHelp(["notes", action]));
          return 1;
        }
      }
    }

    const initialCwd = process.cwd();
    const envSettings = resolveCliEnvironment(
      explicitRepo,
      process.env,
      initialCwd,
    );

    const repoSettings: RepoSettings = {
      stateDir: envSettings.stateDir,
      baseDir: envSettings.worktreeDir,
      legacyRoot: envSettings.repoRoot,
      legacyName: envSettings.repoName,
      legacyBase: envSettings.defaultBase,
      selection: envSettings.selectedRepo,
    };

    const repoFlags = [
      "--state-dir",
      repoSettings.stateDir,
      "--base-dir",
      repoSettings.baseDir,
      "--legacy-root",
      repoSettings.legacyRoot,
      "--legacy-name",
      repoSettings.legacyName,
      "--legacy-base",
      repoSettings.legacyBase,
      "--selection",
      repoSettings.selection,
    ];

    if (command === "repo") {
      return await reposMain([...repoFlags, "repo", ...rest]);
    }

    if (command === "checkout") {
      return await reposMain([...repoFlags, "checkout", ...rest]);
    }

    if (command === "list") {
      const opts = optionsBeforeSeparator(rest);
      const listFlags = opts.includes("--all")
        ? ["status", ...rest]
        : ["status", "--list", ...rest];
      return await reposMain([...repoFlags, ...listFlags]);
    }

    if (
      command === "status" &&
      !optionsBeforeSeparator(rest).includes("--workspace")
    ) {
      return await reposMain([...repoFlags, "status", ...rest]);
    }

    let { repoRoot, repoName, defaultBase } = envSettings;
    const resolvedRepo = resolveRepositorySettings(repoSettings);
    if (resolvedRepo) {
      repoRoot = resolvedRepo.root;
      repoName = resolvedRepo.worktreeName;
      defaultBase = resolvedRepo.base;
    }

    const managedDir = path.join(envSettings.worktreeDir, repoName);
    const contextFlags = [
      "--repo",
      repoRoot,
      "--state-dir",
      envSettings.stateDir,
      "--base-dir",
      managedDir,
      "--default-base",
      defaultBase,
    ];
    const stateFlags = [
      "--repo",
      repoRoot,
      "--state-dir",
      envSettings.stateDir,
    ];

    if (command === undefined) {
      const store = new Store(repoRoot, envSettings.stateDir);
      const selected = await select(
        store,
        candidates(store.repo, canonical(managedDir), store),
        defaultBase,
        false,
      );
      if (selected.length > 0) {
        await store.adopt(selected[0].path, defaultBase);
        writeWorkspaceOutput(selected[0].path);
      }
      return 0;
    }

    switch (command) {
      case "pr": {
        if (rest[0] === "update") {
          return await prUpdateMain([...contextFlags, "pr", ...rest]);
        }
        if (rest[0] === "checkout") {
          return await prWorkflowMain([...contextFlags, "pr", ...rest]);
        }
        return await stateMain([...stateFlags, "pr", ...rest]);
      }

      case "review":
        return await reviewMain([...contextFlags, ...rest]);

      case "feedback":
        return await feedbackMain([...contextFlags, ...rest]);

      case "clean":
        return await cleanMain([...contextFlags, ...rest]);

      case "sync":
        return await syncMain([...contextFlags, ...rest]);

      case "storage":
        return await storageMain([...contextFlags, "storage", ...rest]);

      case "pause":
        return await taskMain([...contextFlags, "pause", ...rest]);

      case "continue":
        return await taskMain([...contextFlags, "continue", ...rest]);

      case "git": {
        const code = await gitMain([
          ...contextFlags,
          "merge",
          ...rest.slice(1),
        ]);
        recoverDeletedDirectory(initialCwd, repoRoot);
        return code;
      }

      case "delete": {
        const code = await deleteMain([...contextFlags, ...rest]);
        recoverDeletedDirectory(initialCwd, repoRoot);
        return code;
      }

      case "workflow":
      case "policy":
        return await agentWorkflowsMain([...contextFlags, command, ...rest]);

      case "agent": {
        const sub = rest[0];
        if (sub && AUTOMATION_AGENT_ACTIONS.has(sub)) {
          return await agentWorkflowsMain([...contextFlags, "agent", ...rest]);
        }
        if (sub === "sessions") {
          return await stateMain([
            ...stateFlags,
            "session",
            "list",
            ...rest.slice(1),
          ]);
        }
        if (sub === "save") {
          return await stateMain([
            ...stateFlags,
            "session",
            "save",
            ...rest.slice(1),
          ]);
        }
        if (sub === "handoff") {
          return await agentLaunchMain([
            ...contextFlags,
            "handoff",
            ...rest.slice(1),
          ]);
        }
        if (sub === "mcp") {
          return await mcpMain([...stateFlags, ...rest.slice(1)]);
        }
        return await agentLaunchMain([...contextFlags, ...rest]);
      }

      case "notes": {
        const action = rest[0]!;
        if (action === "summary") {
          return await summaryMain([
            ...stateFlags,
            "--default-base",
            defaultBase,
            ...rest.slice(1),
          ]);
        }
        const noteKind = rest[1] ?? "context";
        return await stateMain([
          ...stateFlags,
          noteKind,
          action,
          ...rest.slice(2),
        ]);
      }

      case "doctor":
      case "status":
      case "resume":
        return await stateMain([...stateFlags, command, ...rest]);

      case "switch": {
        const switchArgs = [...rest];
        if (switchArgs[0] === "-") {
          const previous = process.env.RL_PREVIOUS_WORKSPACE;
          if (!previous) {
            console.error("No previous workspace in this shell");
            return 1;
          }
          switchArgs[0] = previous;
        }
        return await workflowMain([...contextFlags, "switch", ...switchArgs]);
      }

      case "path":
      case "exec":
        return await workflowMain([...contextFlags, command, ...rest]);

      case "setup": {
        const sub = rest[0];
        if (sub === "init" || sub === "show") {
          return await workflowMain([
            ...contextFlags,
            "config",
            sub,
            ...rest.slice(1),
          ]);
        }
        if (sub === "adopt") {
          return await stateMain([...stateFlags, "adopt", ...rest.slice(1)]);
        }
        if (sub === "mcp") {
          return await mcpSetupMain([...contextFlags, ...rest.slice(1)]);
        }
        if (sub === "run") {
          return await workflowMain([
            ...contextFlags,
            "setup",
            ...rest.slice(1),
          ]);
        }
        return await workflowMain([...contextFlags, "setup", ...rest]);
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run rl help for available commands.");
        return 1;
    }
  } catch (error) {
    const detail = message(error).replace("; run rl --help", "");
    console.error(
      `rl: ${detail.startsWith("Usage:") ? "Invalid command arguments" : detail}`,
    );
    if (publicWords.length > 0) {
      console.error(usageHintForWords(publicWords, isUsageError(error)));
    }
    return 1;
  }
}

if (
  process.argv[1] &&
  canonical(fileURLToPath(import.meta.url)) === canonical(process.argv[1])
) {
  process.exitCode = await runPublicCli(process.argv.slice(2));
}
