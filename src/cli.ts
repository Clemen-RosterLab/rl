import { message } from "./common.js";
import { isUsageError } from "./errors.js";
import { invocation, topicHelp, usageHint } from "./help.js";
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
import { main as mcpSetup } from "./mcp-setup.js";
import { main as task } from "./task.js";
import { main as storage } from "./storage.js";
import { main as clean } from "./clean.js";
import { main as prUpdate } from "./pr-update.js";
import { main as sync } from "./sync.js";
import { main as review } from "./review.js";
import { main as feedback } from "./review-feedback.js";
import { main as agentWorkflows } from "./agent-workflows.js";
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
  "mcp-setup": mcpSetup,
  task,
  storage,
  clean,
  "pr-update": prUpdate,
  sync,
  review,
  feedback,
  automation: agentWorkflows,
};

try {
  const [command, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command))
    throw new Error("Unknown internal command");
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  if (options.includes("--help") || options.includes("-h")) {
    console.log(
      topicHelp(
        invocation(
          command,
          options.filter((arg) => arg !== "--help" && arg !== "-h"),
        ),
      ),
    );
  } else {
    process.exitCode = await commands[command as keyof typeof commands](argv);
  }
} catch (error) {
  const detail = message(error).replace("; run rl --help", "");
  console.error(
    `rl: ${detail.startsWith("Usage:") ? "Invalid command arguments" : detail}`,
  );
  console.error(
    usageHint(
      process.argv[2] ?? "",
      process.argv.slice(3),
      isUsageError(error),
    ),
  );
  process.exitCode = 1;
}
