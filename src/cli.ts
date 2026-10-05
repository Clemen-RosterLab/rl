import { message } from "./common.js";
import { main as state } from "./state.js";
import { main as repos } from "./repos.js";
import { main as remove } from "./delete.js";
import { main as summary } from "./summary.js";
import { main as picker } from "./picker.js";
const commands = { state, repos, delete: remove, summary, picker };
const help = {
  state: [
    "rl adopt [--worktree <path>] [--base <ref>]",
    "rl status [--fetch] [--json] | rl instances",
    "rl resume codex|claude",
    "rl session list [agent] | rl session add <agent> <UUID>",
    "rl context|progress show|path|set <file>|append <file>",
    "rl pr show | rl pr sync [number|URL]",
  ],
  repos: [
    "rl repo add <alias> <path> [--base <ref>] [--worktree-name <name>]",
    "rl repo list [--json] | rl repo use <alias> | rl repo remove <alias>",
    "rl status --all|--list [--json] [--fetch] [--include-deleted]",
  ],
  delete: [
    "rl delete [--jobs <1..32>] [--dry-run] [names...]",
    "Omit names to multi-select worktrees with cached PR state and base commit counts.",
    "Force-removes worktrees, uncommitted changes, and local branches; retains RL state.",
  ],
  summary: [
    "rl summary [--base <ref>] [--stdout | --output|-o <file.md> [--force]]",
    "Defaults to summary.md in this instance's state directory.",
  ],
  picker: ["rl: pick a worktree with cached PR state and base commit counts."],
};
try {
  const [command, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command))
    throw new Error("Unknown internal command");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(help[command as keyof typeof help].join("\n"));
  } else {
    process.exitCode = await commands[command as keyof typeof commands](argv);
  }
} catch (error) {
  console.error(`rl: ${message(error)}`);
  process.exitCode = 1;
}
