import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

interface Topic {
  description: string;
  usage: string;
  group?: string;
  options?: string[];
  notes?: string[];
  examples?: string[];
  related?: string[];
}
const topics: Record<string, Topic> = {
  checkout: {
    group: "Workspaces",
    description: "Switch to a repository",
    usage: "rl checkout [repository]",
    notes: [
      "Choose a registered repository, or omit its name to select from a picker.",
      "Enters its main checkout. Bare rl then selects a workspace in that repository.",
      "Shell integration changes your directory; the standalone executable prints the path.",
    ],
    examples: [
      "rl checkout",
      "rl checkout rosterlab-frontend",
      "rl checkout romeo",
    ],
    related: ["repo add", "switch"],
  },
  switch: {
    group: "Workspaces",
    description: "Open or create a workspace",
    usage: "rl switch <name|branch|@|-> [options]",
    options: [
      "-c, --create          Create a new branch workspace",
      "-b, --base <ref>      Creation base (default: origin/test unless configured)",
      "--no-fetch           Use cached refs when creating",
      "--setup              Run configured project setup",
      "--agent codex|claude  Start an agent after switching",
      "-- <agent args>      Forward options to the selected agent",
    ],
    notes: [
      "Use rl checkout [repository] to switch repositories in your shell.",
      "@ opens the main checkout; - returns to the previous workspace.",
      "Shell integration changes your terminal's directory.",
      "Related creation helpers: new reopens existing workspaces; open requires an existing branch.",
    ],
    examples: [
      "rl switch feature/login",
      "rl switch feature/login -c --base origin/test",
    ],
    related: ["new", "open", "path"],
  },
  list: {
    group: "Workspaces",
    description: "List workspaces",
    usage: "rl list [options]",
    options: [
      "--all                List workspaces across registered repositories",
      "--json               Print structured output",
      "--fetch              Refresh remote refs first",
      "--include-deleted    Include archived records",
    ],
    notes: [
      "Commit counts are relative to each row's displayed upstream; CHANGES counts files.",
    ],
  },
  status: {
    group: "Workspaces",
    description: "Inspect the selected repository",
    usage: "rl status [--workspace] [--json] [--fetch]",
    options: [
      "--workspace   Show the current workspace's Git, PR, sessions and task details",
      "--json   Print structured output",
      "--fetch  Refresh remote refs first",
    ],
    notes: [
      "Shows repository selection, checkout path, base, workspaces and saved session counts.",
      "--workspace includes Git changes, PR, sessions, task handoff and latest workflow.",
      "Use rl list for workspace overviews; status --list and --all remain supported.",
    ],
    related: ["list", "instances"],
  },
  delete: {
    group: "Workspaces",
    description: "Remove workspaces",
    usage: "rl delete [names...] [options]",
    options: [
      "--dry-run     Preview removals",
      "--force       Allow dirty or unmerged workspaces",
      "--jobs <n>    Parallel removals (1–32; default: 4)",
    ],
    notes: [
      "Without names, opens a multi-select picker.",
      "Saved sessions, notes and task history are retained.",
    ],
  },
  storage: {
    group: "Workspaces",
    description: "Inspect disk usage and clean generated files",
    usage: "rl storage [--json] [--older-than <age>]",
    options: [
      "--json               Print structured output",
      "--older-than <age>   Age for suggestions (default: 14d)",
    ],
    notes: [
      "Measures only the current adopted workspace. Cleanup uses its configured clean paths.",
    ],
    related: ["setup show"],
  },
  "storage clean": {
    description: "Remove configured generated directories",
    usage: "rl storage clean [--dry-run] [--json]",
    notes: [
      "Only removes configured ignored directories in the current workspace.",
      "Tracked source, credentials, notes and sessions are protected.",
    ],
    examples: ["rl storage clean --dry-run", "rl storage clean"],
  },
  resume: {
    group: "Agents and tasks",
    description: "Resume a saved conversation",
    usage: "rl resume [codex|claude] [--latest|-l|--l]",
    options: [
      "--latest, -l, --l  Resume the most recently used matching session directly",
    ],
    notes: [
      "Without a filter, offers both Codex and Claude sessions in this workspace.",
      "One match resumes automatically; multiple matches open a picker.",
    ],
    related: ["agent sessions", "agent save", "continue"],
  },
  agent: {
    group: "Agents and tasks",
    description: "Launch agents and manage profiles and sessions",
    usage: "rl agent <command>",
    related: ["resume", "workflow", "policy"],
  },
  "agent start": {
    description: "Start an interactive agent",
    usage:
      "rl agent start <codex|claude> [--workspace <name>] [-- <agent args>]",
    examples: ["rl agent start codex -- --model <model>"],
  },
  "agent run": {
    description: "Run an agent non-interactively",
    usage:
      "rl agent run <codex|claude> --prompt <text> [--workspace <name>] [-- <agent args>]",
    notes: [
      "Returns the agent's exit status and preserves its native options.",
    ],
  },
  "agent list": {
    description: "List workflow agent profiles",
    usage: "rl agent list [--json]",
  },
  "agent show": {
    description: "Inspect a workflow agent profile",
    usage: "rl agent show <name> [--json]",
    notes: [
      "Profiles live in .rl/agents.json; they contain instructions and execution settings.",
    ],
  },
  "agent sessions": {
    description: "List saved conversations",
    usage: "rl agent sessions [codex|claude]",
  },
  "agent save": {
    description: "Save the current or an explicit conversation",
    usage: "rl agent save [codex|claude] [UUID] [--json]",
    notes: [
      "Defaults to the current Codex session ID. Claude requires an explicit UUID.",
    ],
  },
  "agent handoff": {
    description: "Export shared task context",
    usage:
      "rl agent handoff [codex|claude] [--workspace <name>] [--stdout | --output <file>]",
    notes: [
      "Exports notes; agent conversations remain in their original sessions.",
    ],
  },
  "agent mcp": {
    description: "Serve workspace context and notes through MCP",
    usage: "rl agent mcp",
    notes: ["Uses stdio. Start the server in the adopted workspace."],
  },
  workflow: {
    group: "Agents and tasks",
    description: "Run and control agent workflows",
    usage: "rl workflow <command>",
    notes: [
      "Run controls apply only to this adopted workspace.",
      "Omit a run UUID, or use latest, to select its most recently created run.",
    ],
    related: ["agent", "policy"],
  },
  "workflow init": {
    description: "Create editable profiles, policies and workflows",
    usage: "rl workflow init [--provider codex|claude] [--json]",
    notes: [
      "Creates .rl/agents.json, .rl/policies.json and .rl/agent-workflows.json.",
      "Existing configuration is never overwritten.",
    ],
  },
  "workflow list": {
    description: "List configured workflows",
    usage: "rl workflow list [--json]",
  },
  "workflow show": {
    description: "Inspect steps and dependencies",
    usage: "rl workflow show <name> [--json]",
  },
  "workflow run": {
    description: "Run a configured agent workflow",
    usage: "rl workflow run [name] [options]",
    options: [
      "--base <ref>     Local comparison ref (default: repository setting)",
      "--prompt <text>  Feature intent for the reviewers",
      "--dry-run        Preview scope and steps without launching agents",
      "--json           Print structured results",
    ],
    notes: [
      "Default workflow: triple-review. Uses your existing CLI authentication.",
      "Review criteria and scores come from the selected policy; metrics are measured by RL.",
    ],
    examples: ["rl workflow run --base origin/test --dry-run"],
  },
  "workflow status": {
    description: "Inspect a saved run",
    usage: "rl workflow status [UUID|latest] [--json]",
  },
  "workflow metrics": {
    description: "Inspect measured duration and provider usage",
    usage: "rl workflow metrics [UUID|latest] [--json]",
  },
  "workflow pause": {
    description: "Pause a workflow run",
    usage: "rl workflow pause [UUID|latest] [--json]",
    notes: ["Pauses worker processes; completed stages remain saved."],
  },
  "workflow cancel": {
    description: "Cancel a workflow run",
    usage: "rl workflow cancel [UUID|latest] [--json]",
  },
  "workflow resume": {
    description: "Continue unfinished workflow stages",
    usage: "rl workflow resume [UUID|latest] [--json]",
    notes: [
      "Uses the saved configuration. Changed review scope requires a new run.",
    ],
  },
  "workflow score": {
    description: "Rescore saved findings using a policy",
    usage: "rl workflow score [UUID|latest] [--policy <name>] [--json]",
    notes: [
      "Makes no agent calls. Preserves the original configuration and assessment history.",
    ],
  },
  policy: {
    group: "Agents and tasks",
    description: "Inspect review criteria and scoring rules",
    usage: "rl policy <command>",
    notes: [
      "Edit .rl/policies.json to change criteria, weights and readiness gates.",
    ],
    related: ["workflow score"],
  },
  "policy list": {
    description: "List review policies",
    usage: "rl policy list [--json]",
  },
  "policy show": {
    description: "Inspect a review policy",
    usage: "rl policy show <name> [--json]",
  },
  pause: {
    group: "Agents and tasks",
    description: "Save a task handoff",
    usage: "rl pause --file <handoff.json|-> [--workspace <name>] [--json]",
    options: [
      "--summary <text>     Task summary",
      "--changes <text>     Concrete changes",
      "--validation <text>  Checks actually run, or Not run",
      "--next <text>        Next steps",
      "--blockers <text>    Optional blockers",
      "--agent codex|claude Agent owning the handoff (default: codex)",
      "--session <UUID>     Conversation ID; inferred inside Codex",
    ],
    notes: [
      "Alternatively, supply summary, changes, validation and next directly instead of --file.",
      "Saves the task; use workflow pause to pause an executing workflow.",
    ],
    related: ["continue"],
  },
  continue: {
    group: "Agents and tasks",
    description: "Continue a saved task handoff",
    usage: "rl continue [workspace] [--no-agent]",
    notes: [
      "Defaults to the most recently paused task in this repository.",
      "--no-agent opens the workspace without launching the saved conversation.",
    ],
    related: ["resume", "workflow resume"],
  },
  git: {
    group: "Code and reviews",
    description: "Inspect and integrate branch changes",
    usage: "rl git <command>",
  },
  "git diff": {
    description: "Show workspace changes against the base",
    usage: "rl git diff [--base <ref>] [-- <display options> [-- paths...]]",
    examples: ["rl git diff -- --stat"],
  },
  "git log": {
    description: "Show feature commits",
    usage: "rl git log [--base <ref>] [-- <display options>]",
    examples: ["rl git log -- --graph"],
  },
  "git commit": {
    description: "Commit staged changes",
    usage: "rl git commit -m <message> [--all] [--dry-run]",
    notes: ["--all includes modified tracked files."],
  },
  "git rebase": {
    description: "Rebase onto the base branch",
    usage: "rl git rebase [--base <ref>] [--dry-run]",
  },
  "git squash": {
    description: "Squash feature commits",
    usage: "rl git squash -m <message> [--base <ref>] [--dry-run]",
    notes: ["The original HEAD is retained under a printed backup ref."],
  },
  "git merge": {
    description: "Integrate into a checked-out base branch",
    usage:
      "rl git merge [target] [--squash -m <message>] [--cleanup] [--dry-run]",
    notes: [
      "Requires clean source and target workspaces; defaults to fast-forward only.",
      "Use pr update to merge the latest base into remote PR branches instead.",
    ],
  },
  pr: {
    group: "Code and reviews",
    description: "Open and manage pull requests",
    usage: "rl pr [command]",
    notes: ["With no command, opens this branch's PR in your browser."],
    related: ["workflow"],
  },
  "pr open": {
    description: "Open the current PR in a browser",
    usage: "rl pr [open] [--json]",
    notes: ["Keeps a usable URL in the output if the browser cannot open."],
  },
  "pr show": {
    description: "Read the cached PR summary",
    usage: "rl pr show [--json]",
    notes: ["Works offline; sync refreshes the saved snapshot."],
  },
  "pr sync": {
    description: "Refresh the saved PR snapshot",
    usage: "rl pr sync [number|URL] [--json]",
  },
  "pr checks": {
    description: "Show GitHub check results",
    usage: "rl pr checks [--json]",
  },
  "pr checkout": {
    description: "Create a workspace for a PR",
    usage: "rl pr checkout <number> [--name <branch>]",
  },
  "pr update": {
    description: "Merge the latest base into your RL session PRs",
    usage: "rl pr update [numbers...] [options]",
    options: [
      "--base <branch>  PR target branch (default: repository setting)",
      "--dry-run        Preview without changing remote branches",
      "--limit <n>      Maximum matching PRs to inspect (1–200; default: 100)",
      "--json           Print structured results",
    ],
    notes: [
      "Without numbers, opens a multi-select picker of behind PRs.",
      "Only branches belonging to active RL workspaces in this repository are eligible.",
      "PRs stay open; results report updates, conflicts, failures and pending work.",
    ],
    examples: ["rl pr update --base test", "rl pr update 123 456 --dry-run"],
  },
  notes: {
    group: "Project",
    description: "Read and update shared task notes",
    usage: "rl notes <command>",
  },
  "notes show": {
    description: "Read shared context or progress",
    usage: "rl notes show [context|progress]",
    notes: ["Defaults to context."],
  },
  "notes path": {
    description: "Print a shared document's path",
    usage: "rl notes path [context|progress]",
  },
  "notes set": {
    description: "Replace a shared document",
    usage: "rl notes set <context|progress> <file|->",
  },
  "notes append": {
    description: "Append a milestone or domain note",
    usage: "rl notes append <context|progress> <file|->",
    notes: [
      "- reads stdin. Appends are locked to preserve concurrent updates.",
    ],
  },
  "notes summary": {
    description: "Export a workspace summary",
    usage: "rl notes summary [--base <ref>] [--stdout | -o <file>] [--force]",
    notes: ["Defaults to summary.md in this instance's state directory."],
  },
  repo: {
    group: "Project",
    description: "Manage registered repositories",
    usage: "rl repo <command>",
    notes: [
      "Use rl checkout [repository] to switch repositories in your shell.",
      "Use rl --repo <alias> <command> to select a repository explicitly.",
    ],
  },
  "repo add": {
    description: "Register a repository",
    usage:
      "rl repo add [path] [--alias <name>] [--base <ref>] [--worktree-name <name>]",
    notes: [
      "Defaults to the current directory. Uses the origin repository name, or the main checkout directory name when there is no origin.",
      "Use --alias for a custom name. The existing <alias> <path> form also works.",
    ],
    examples: [
      "rl repo add .",
      "rl repo add . --alias frontend --base origin/test",
    ],
  },
  "repo list": {
    description: "List registered repositories",
    usage: "rl repo list [--json]",
  },
  "repo use": {
    description: "Set the default repository",
    usage: "rl repo use <alias>",
    notes: ["Applies outside registered workspaces."],
  },
  "repo remove": {
    description: "Unregister a repository",
    usage: "rl repo remove <alias>",
    notes: ["Retains its workspaces and saved state."],
  },
  setup: {
    group: "Project",
    description: "Configure and prepare a workspace",
    usage: "rl setup [run] [--workspace <name>] [--dry-run]",
    notes: ["With no subcommand, runs the configured project setup."],
    related: ["workflow init"],
  },
  "setup init": {
    description: "Create project setup configuration",
    usage: "rl setup init",
    notes: [
      "Creates .rl/workflows.json without overwriting existing configuration.",
    ],
  },
  "setup show": {
    description: "Show project setup configuration",
    usage: "rl setup show",
  },
  "setup run": {
    description: "Run configured project setup",
    usage: "rl setup [run] [--workspace <name>] [--dry-run]",
  },
  "setup adopt": {
    description: "Register the current workspace and install hooks",
    usage: "rl setup adopt [--extended-hooks]",
    notes: ["Preserves existing hooks. Review Codex hook trust with /hooks."],
  },
  "setup shell": {
    description: "Print shell integration",
    usage: "rl setup shell <zsh|bash>",
    examples: ['eval "$(rl setup shell zsh)"'],
  },
  doctor: {
    group: "Project",
    description: "Check and repair agent integration",
    usage: "rl doctor [codex|claude] [--repair] [--json]",
    notes: [
      "Reports CLI availability, installed hooks and observed activity.",
      "--repair reinstalls this workspace's RL hooks.",
    ],
  },
  new: {
    description: "Create or reopen a branch workspace",
    usage: "rl new <branch> [--base <ref>] [--no-fetch] [--setup]",
    related: ["switch"],
  },
  open: {
    description: "Open an existing local or origin branch",
    usage: "rl open --branch <branch> [--setup] [--no-fetch]",
    related: ["switch"],
  },
  path: {
    description: "Print a workspace path",
    usage: "rl path [name|branch|@]",
    related: ["switch"],
  },
  exec: {
    description: "Run a command in a workspace",
    usage: "rl exec [--workspace <name>] -- <command> [args...]",
    related: ["setup run"],
  },
  instances: {
    description: "Inspect active and archived instance records",
    usage: "rl instances",
    related: ["status", "list"],
  },
};

const aliases: [string[], string[]][] = [
  [["step"], ["git"]],
  [["diff"], ["git", "diff"]],
  [["log"], ["git", "log"]],
  [["merge"], ["git", "merge"]],
  [["clean"], ["storage", "clean"]],
  [["summary"], ["notes", "summary"]],
  [["handoff"], ["agent", "handoff"]],
  [["mcp"], ["agent", "mcp"]],
  [
    ["session", "list"],
    ["agent", "sessions"],
  ],
  [
    ["session", "save"],
    ["agent", "save"],
  ],
  [
    ["session", "add"],
    ["agent", "save"],
  ],
  [["session"], ["agent"]],
  [
    ["config", "init"],
    ["setup", "init"],
  ],
  [
    ["config", "show"],
    ["setup", "show"],
  ],
  [["config"], ["setup"]],
  [["adopt"], ["setup", "adopt"]],
  [["init"], ["setup", "shell"]],
];
function canonical(words: string[]): string[] {
  if (
    words[0] === "status" &&
    words.some((word) => word === "--all" || word === "--list")
  )
    return ["list", ...words.slice(1)];
  if (["context", "progress"].includes(words[0]))
    return ["notes", words[1] ?? "show", words[0], ...words.slice(2)];
  const alias = aliases.find(([from]) =>
    from.every((word, i) => words[i] === word),
  );
  return alias ? [...alias[1], ...words.slice(alias[0].length)] : words;
}
const children = (name: string) =>
  Object.entries(topics).filter(
    ([key]) =>
      key.startsWith(name + " ") &&
      key.split(" ").length === name.split(" ").length + 1,
  );
const safe = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function mainHelp(): string {
  const lines = [
    "rl — workspaces, agents, and reviews",
    "",
    "  rl            Pick a workspace",
  ];
  for (const group of [
    "Workspaces",
    "Agents and tasks",
    "Code and reviews",
    "Project",
  ]) {
    lines.push("", group);
    for (const [name, topic] of Object.entries(topics))
      if (topic.group === group)
        lines.push(`  ${name.padEnd(12)}${topic.description}`);
  }
  return [...lines, "", "Run rl help <command> for usage and options."].join(
    "\n",
  );
}
function match(words: string[]): string | undefined {
  let name: string | undefined;
  for (let length = 1; length <= words.length; length++)
    if (Object.hasOwn(topics, words.slice(0, length).join(" ")))
      name = words.slice(0, length).join(" ");
  return name;
}
export function topicHelp(words: string[]): string {
  if (!words.length) return mainHelp();
  const normalized = canonical(words),
    name = match(normalized);
  if (
    !name ||
    (children(name).length && normalized.length > name.split(" ").length)
  )
    throw new Error(`Unknown help topic: ${safe(words.join(" "))}`);
  const topic = topics[name];
  const lines = [topic.description, "", `Usage: ${topic.usage}`];
  const commands = children(name);
  if (commands.length)
    lines.push(
      "",
      "Commands:",
      ...commands.map(
        ([key, item]) =>
          `  ${key.split(" ").at(-1)!.padEnd(12)}${item.description}`,
      ),
    );
  if (topic.options?.length)
    lines.push("", "Options:", ...topic.options.map((option) => "  " + option));
  if (topic.notes?.length) lines.push("", ...topic.notes);
  if (topic.examples?.length)
    lines.push(
      "",
      "Examples:",
      ...topic.examples.map((example) => "  " + example),
    );
  if (topic.related?.length)
    lines.push(
      "",
      `Related: ${topic.related.map((name) => `rl help ${name}`).join(", ")}`,
    );
  return [
    ...lines,
    "",
    commands.length ? `Run rl help ${name} <command> for details.` : "",
  ]
    .filter((line, index, array) => line !== "" || index < array.length - 1)
    .join("\n");
}
const CONTEXT = new Set([
  "repo",
  "state-dir",
  "base-dir",
  "default-base",
  "legacy-root",
  "legacy-name",
  "legacy-base",
  "selection",
  "output-path",
]);
export function invocation(module: string, argv: string[]): string[] {
  let index = 0;
  while (argv[index]?.startsWith("--") && CONTEXT.has(argv[index].slice(2)))
    index += 2;
  const rest = argv.slice(index);
  const prefix: Record<string, string[]> = {
    delete: ["delete"],
    summary: ["summary"],
    mcp: ["mcp"],
    picker: [],
  };
  const words = Object.hasOwn(prefix, module)
    ? [...prefix[module], ...rest]
    : module === "agent" && rest[0] !== "handoff"
      ? ["agent", ...rest]
      : rest;
  const defaults: Record<string, string> = {
    state: "status",
    repos: "repo",
    workflow: "switch",
    git: "git",
    agent: "agent",
    automation: "workflow",
    storage: "storage",
    "pr-update": "pr",
  };
  return canonical(
    words.length ? words : defaults[module] ? [defaults[module]] : [],
  );
}
export function usageHint(
  module: string,
  argv: string[],
  details = false,
): string {
  const words = invocation(module, argv),
    name = match(words);
  if (!name) return "Run rl help for available commands.";
  const topic = topics[name],
    lines = [`Usage: ${topic.usage}`];
  if (details && topic.options?.length)
    lines.push("", "Options:", ...topic.options.map((option) => "  " + option));
  if (details && children(name).length)
    lines.push(
      "",
      "Commands:",
      ...children(name).map(
        ([key, child]) =>
          `  ${key.split(" ").at(-1)!.padEnd(12)}${child.description}`,
      ),
    );
  return [...lines, `See rl help ${name}.`].join("\n");
}
export function explicitHelp(argv: string[]): string {
  let words = [...argv];
  if (words[0] === "--repo") words = words.slice(2);
  else if (words[0]?.startsWith("--repo=")) words = words.slice(1);
  if (words[0] === "help") words.shift();
  const separator = words.indexOf("--");
  if (separator >= 0) words = words.slice(0, separator);
  words = words.filter((word) => word !== "--help" && word !== "-h");
  return topicHelp(words);
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    console.log(explicitHelp(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `rl: ${safe(error instanceof Error ? error.message : String(error))}\nRun rl help for available commands.`,
    );
    process.exitCode = 1;
  }
}
