import { message } from "./common.js";
import { main as state } from "./state.js";
import { main as repos } from "./repos.js";
import { main as remove } from "./delete.js";
import { main as summary } from "./summary.js";
import { main as picker } from "./picker.js";
import { main as workflow } from "./workflow.js";
import { main as git } from "./git-workflow.js";
import { main as pr } from "./pr-workflow.js";
import { main as agent } from "./agent-launch.js";
import { main as mcp } from "./mcp.js";
import { main as task } from "./task.js";
const commands = {
  state,
  repos,
  delete: remove,
  summary,
  picker,
  workflow,
  git,
  pr,
  agent,
  mcp,
  task,
};
const help = {
  state: [
    "rl adopt [--worktree <path>] [--base <ref>] [--extended-hooks]",
    "rl status [--fetch] [--json] | rl instances",
    "rl resume codex|claude",
    "rl doctor [codex|claude] [--json] [--repair]",
    "rl session list [agent] | rl session add <agent> <UUID>",
    "rl session save [agent] [UUID] [--json] (defaults to the current Codex session)",
    "rl context|progress show|path|set <file>|append <file>",
    "rl pr show | rl pr sync [number|URL]",
  ],
  repos: [
    "rl repo add <alias> <path> [--base <ref>] [--worktree-name <name>]",
    "rl repo list [--json] | rl repo use <alias> | rl repo remove <alias>",
    "rl status --all|--list [--json] [--fetch] [--include-deleted]",
  ],
  delete: [
    "rl delete [--jobs <1..32>] [--dry-run] [--force] [names...]",
    "Omit names to multi-select worktrees with cached PR state and base commit counts.",
    "Refuses dirty or unmerged workspaces unless --force; retains RL state.",
  ],
  summary: [
    "rl summary [--base <ref>] [--stdout | --output|-o <file.md> [--force]]",
    "Defaults to summary.md in this instance's state directory.",
  ],
  picker: ["rl: pick a worktree with cached PR state and base commit counts."],
  workflow: [
    "rl switch <name|branch|@|-> [-c|--create] [--base <ref>] [--setup] [--agent codex|claude]",
    "rl new <branch> [--base <ref>] | rl open -b <branch> [--setup] [--no-fetch]",
    "rl path [name|branch|@] | rl exec [--workspace <name>] -- <command> [args...]",
    "rl config init|show | rl setup [--workspace <name>] [--dry-run]",
  ],
  git: [
    "rl step commit -m <message> [--all] [--dry-run]",
    "rl step rebase|squash [--base <ref>] [-m <message>] [--dry-run]",
    "rl merge [target-branch] [--squash -m <message>] [--cleanup] [--dry-run]",
    "rl diff|log [--base <ref>] [-- <git-options> [-- paths...]]",
  ],
  pr: ["rl pr checks [--json] | rl pr checkout <number> [--name <branch>]"],
  agent: [
    "rl agent start codex|claude [--workspace <name>] [-- <agent-options>]",
    "rl agent run codex|claude --prompt <text> [--workspace <name>] [-- <agent-options>]",
    "rl handoff [codex|claude] [--workspace <name>] [--stdout | --output <file>]",
  ],
  mcp: [
    "rl mcp: serve workspace status and notes over stdio for agent MCP clients.",
  ],
  task: [
    "rl pause --summary <text> --changes <text> --validation <text> --next <text> [--blockers <text>] [--session <UUID>] [--agent codex|claude]",
    "rl pause --file <handoff.json|-> [--workspace <name>] [--json]",
    "rl continue [workspace] [--no-agent] (most recently paused task in this repository)",
  ],
};
try {
  const [command, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command))
    throw new Error("Unknown internal command");
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  if (options.includes("--help") || options.includes("-h")) {
    console.log(help[command as keyof typeof help].join("\n"));
  } else {
    process.exitCode = await commands[command as keyof typeof commands](argv);
  }
} catch (error) {
  console.error(`rl: ${message(error)}`);
  process.exitCode = 1;
}
