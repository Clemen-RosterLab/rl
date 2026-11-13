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
    examples: ["rl checkout", "rl checkout frontend", "rl checkout backend"],
    related: ["repo add", "switch"],
  },
  switch: {
    group: "Workspaces",
    description: "Open or create a workspace",
    usage: "rl switch <name|branch|@|-> [options]",
    options: [
      "-c, --create          Create a new branch workspace",
      "-b, --base <ref>      Creation base (default: origin/test unless configured)",
      "--no-fetch           Use cached refs when opening or creating",
      "--setup              Run configured project setup",
      "--agent codex|claude|agy  Start an agent after switching",
      "-- <agent args>      Forward options to the selected agent",
    ],
    notes: [
      "Use rl checkout [repository] to switch repositories in your shell.",
      "@ opens the main checkout; - returns to the previous workspace.",
      "Shell integration changes your terminal's directory.",
      "An existing branch without a checkout gets a managed workspace; origin branches are tracked.",
    ],
    examples: [
      "rl switch feature/login",
      "rl switch feature/login -c --base origin/test",
    ],
    related: ["path"],
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
      "Use rl list for workspace overviews and --include-deleted for archived records.",
    ],
    related: ["list"],
  },
  sync: {
    group: "Workspaces",
    description: "Fetch and merge each workspace's base into its branch",
    usage: "rl sync [workspaces...] [--dry-run] [--json]",
    options: [
      "--dry-run   Fetch and preview without changing branches or working files",
      "--json      Print structured results",
    ],
    notes: [
      "Defaults to all active RL workspaces in the selected repository. Optionally select by name, branch or absolute path.",
      "Uses each workspace's saved base, or the repository default. Unqualified bases prefer origin; explicit local refs stay local.",
      "Fetches configured remotes first. Any fetch failure stops merges. Local stacked bases are synced before their children.",
      "Skips dirty, locked, missing or busy worktrees. Conflicting merges are aborted so other branches can continue.",
      "Merges locally and does not push. Reports a result for every selected workspace; exits nonzero for conflicts, failures or skips.",
    ],
    examples: [
      "rl sync",
      "rl sync --dry-run",
      "rl sync feature/login feature/profile",
    ],
    related: ["switch", "pr update"],
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
  review: {
    group: "Code and reviews",
    description:
      "Live Git/PR review in the current terminal, plus saved snapshots",
    usage: "rl review [worktree] [action] [options]",
    options: [
      "--all                     Choose a worktree from the review queue",
      "--pr <number>             Inspect a GitHub PR (gh; local fallback if unavailable)",
      "--live                    Require the live terminal interface",
      "--remote-interval <sec>   PR polling interval (default 60; minimum 10)",
      "--summary                 AI implementation summary (manual fallback if unavailable)",
      "--diff                    Complete feature diff against the fixed baseline",
      "--base <ref>              Explicitly pin a legacy baseline (merge-base with HEAD)",
      "--checkpoint              Save an inspected source/index checkpoint",
      "--checkpoints             List saved checkpoints",
      "--since-last-review       Compare with the latest checkpoint",
      "--since <revision|UUID>   Revision → HEAD, or a legacy checkpoint UUID",
      "--snapshot <UUID>         Inspect an immutable saved snapshot",
      "--approve                 Approve the last inspected snapshot if still current",
      "--ready                   Mark this snapshot ready for human review",
      "--ai-review               Run an independent AI review",
      "--groups                  Browse logical groups backed by Git file/hunk IDs",
      "--provider codex|claude|agy    Select the AI provider",
      "--profile <name>           Editable RL agent profile (default: reviewer)",
      "--no-ai                   Use Git evidence without invoking a model",
      "--worktree-diff            Uncommitted source and staged content only",
      "--lazygit                 Optional live working-tree viewer (not feature-wide)",
      "--open                    Open the worktree in VS Code",
      "--filter <name>            all | needs-review | changed | clean | active | ready",
      "--label <text>             Label a checkpoint or approval",
      "--json                    Structured queue, snapshot or analysis output",
      "--interactive             Open pickers even with redirected output",
    ],
    notes: [
      "Default: live commits/files/diff for the current worktree. 1/2/3 focus; Tab cycles; j/k navigate; w working; p branch; r range; f freeze; m mark; s since; / search; o VS Code; ? help; q quit.",
      "Live review watches source, HEAD and index with polling fallback. Freeze retains immutable trees. Live m/s checkpoints are separate from legacy approval checkpoints.",
      "Queue: Enter review, Alt-S summary, Alt-D diff, Alt-F feedback, Alt-A approve, Alt-O editor, Ctrl-R refresh, Esc quit.",
      "New rl switch -c branches record a fixed baseline. Older worktrees require explicit --base; no feature baseline is guessed.",
      "Temporary Git indexes capture committed, staged, unstaged and non-ignored untracked source without changing your real index or branch.",
      "Omitted sensitive/oversized paths, conflicts and unstable snapshots block approval. AI analysis never approves code or proves tests passed.",
      "Agent activity is last-observed hook activity, not process-liveness or task-completion proof. Review state lives beside existing notes and sessions.",
    ],
    examples: [
      "rl review",
      "rl review feature/login --base origin/test",
      "rl review feature/login --diff",
      "rl review feature/login --checkpoint",
      "rl review feature/login --since-last-review",
      "rl review feature/login --approve",
    ],
    related: ["feedback", "pr", "workflow"],
  },
  feedback: {
    group: "Code and reviews",
    description:
      "Save corrections and route them to a worktree's coding session",
    usage:
      "rl feedback [worktree] [--message <text> | --file <path|->] [options]",
    options: [
      "--send          Run a noninteractive turn in a validated saved session",
      "--resume        Open the coding conversation with feedback as its prompt",
      "--agent <name>  Filter saved sessions to codex, claude or agy",
      "--session UUID  Select a session associated with this worktree",
      "--retry UUID    Retry saved feedback without losing it on failure",
      "--list          Show saved feedback and delivery status",
      "--json          Print structured results",
    ],
    notes: [
      "Feedback is saved before launching an agent. Without --send/--resume it stays saved. Interactive input uses VISUAL/EDITOR.",
      "Multiple sessions use a terminal picker, or require explicit noninteractive selection. Recently observed working sessions are not sent concurrent turns.",
      "Opened means the conversation launched, not acknowledged delivery. Delivered requires a successful noninteractive turn; failures retain feedback and errors.",
    ],
    examples: [
      "rl feedback feature/login --message 'Reuse the existing helper and add a regression test.'",
      "rl feedback feature/login --file feedback.md --send --agent codex --session <UUID>",
      "rl feedback feature/login --retry <UUID> --resume",
    ],
    related: ["review", "resume"],
  },
  storage: {
    group: "Workspaces",
    description: "Inspect workspace disk usage",
    usage: "rl storage [--json] [--older-than <age>]",
    options: [
      "--json               Print structured output",
      "--older-than <age>   Age for suggestions (default: 14d)",
    ],
    notes: [
      "Measures only the current adopted workspace. Cleanup uses its configured clean paths.",
    ],
    related: ["clean", "setup show"],
  },
  clean: {
    group: "Workspaces",
    description: "Clean generated files from selected worktrees",
    usage: "rl clean [worktrees...] [--all] [--dry-run] [--json]",
    options: [
      "--all       Clean every RL worktree in the selected repository",
      "--dry-run   Preview paths and estimated space without deleting files",
      "--json      Print structured per-worktree results",
    ],
    notes: [
      "Without names or --all, opens a multi-select picker. Tab selects; Ctrl-A selects all.",
      "Accepts worktree names, branches or absolute paths. Main checkouts and unadopted outside worktrees are excluded.",
      "Defaults to ignored dependency, build and cache directories such as node_modules, .venv, .next, .turbo and dist.",
      "A worktree's explicit clean list in .rl/workflows.json overrides the defaults; an empty list disables cleanup.",
      "Preserves source, Git metadata, credentials, notes and sessions. Locked or unsafe worktrees are reported while the others continue.",
    ],
    examples: [
      "rl clean",
      "rl clean --all --dry-run",
      "rl clean feature/login feature/profile",
    ],
    related: ["storage", "delete"],
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
    usage: "rl resume [codex|claude|agy] [--latest|-l|--l]",
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
    description: "Configure native agent roles and saved sessions",
    usage: "rl agent <command>",
    related: ["resume", "workflow", "policy"],
    notes: [
      "Existing agent sessions discover their workflow with rl workflow context --json. A special launcher or MCP connection is not required.",
    ],
  },
  "agent start": {
    description: "Start an interactive agent",
    usage:
      "rl agent start <codex|claude|agy> [--workspace <name>] [-- <agent args>]",
    examples: ["rl agent start codex -- --model <model>"],
  },
  "agent run": {
    description: "Run an agent non-interactively",
    usage:
      "rl agent run <codex|claude|agy> --prompt <text> [--workspace <name>] [-- <agent args>]",
    notes: [
      "Returns the agent's exit status and preserves its native options.",
    ],
  },
  "agent list": {
    description: "List workflow agent profiles",
    usage: "rl agent list [--json]",
  },
  "agent add": {
    description: "Add a role for your session's native subagents",
    usage:
      "rl agent add <name> --instructions <file|-> [--description <text>] [--model <name>] [--reasoning <level>]",
    notes: [
      "Alternatively use --file <profile.json|->. Profiles never launch another provider; the current session supplies native subagents.",
    ],
  },
  "agent set": {
    description: "Save an agent profile",
    usage: "rl agent set <name> --file <profile.json|->",
    notes: [
      "Use --instructions <file|-> to change instructions while preserving the profile's access, model and other settings.",
    ],
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
    usage: "rl agent sessions [codex|claude|agy]",
  },
  "agent save": {
    description: "Save the current or an explicit conversation",
    usage: "rl agent save [codex|claude|agy] [UUID] [--json]",
    notes: [
      "Defaults to the current Codex session ID. Claude requires an explicit UUID.",
    ],
  },
  "agent handoff": {
    description: "Export shared task context",
    usage:
      "rl agent handoff [codex|claude|agy] [--workspace <name>] [--stdout | --output <file>]",
    notes: [
      "Exports notes; agent conversations remain in their original sessions.",
    ],
  },
  "agent mcp": {
    description: "Serve workspace context and notes through MCP",
    usage: "rl agent mcp [--workspace <absolute-path>]",
    notes: [
      "Uses stdio. Start the server in the adopted workspace, or bind one explicitly with --workspace.",
    ],
    related: ["setup mcp"],
  },
  workflow: {
    group: "Agents and tasks",
    description: "Define and track session-driven agent workflows",
    usage: "rl workflow <command>",
    notes: [
      "Run controls apply only to this adopted workspace.",
      "Omit a run UUID, or use latest, to select its most recently created run.",
    ],
    related: ["agent", "policy"],
  },
  "workflow init": {
    description: "Create editable profiles, policies and workflows",
    usage: "rl workflow init [--provider inherit|codex|claude|agy] [--json]",
    notes: [
      "Creates .rl/agents.json, .rl/policies.json and .rl/agent-workflows.json.",
      "Existing configuration is never overwritten.",
      "Adopted workspaces use built-in writer/reviewer/DRY roles immediately. Init writes editable copies of their profiles, policy and workflow.",
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
    description: "Prepare a workflow for this session's native agents",
    usage: "rl workflow run [name] [options]",
    options: [
      "--base <ref>     Local comparison ref (default: repository setting)",
      "--prompt <text>  Feature intent for the reviewers",
      "--dry-run        Preview scope and steps without launching agents",
      "--json           Print structured results",
      "--agent codex|claude|agy  Parent session provider",
      "--session <UUID>     Parent conversation (inferred inside Codex)",
      "--request <UUID>     Start a queued workflow request instead of choosing a name",
    ],
    notes: [
      "Default workflow: writer-reviewer-dry. The parent spawns all three native peers in parallel and binds their handles; RL never launches agent processes.",
      "The parent claims ready steps, spawns native subagents and reports evidence. RL applies the policy; provider usage is parent-reported.",
    ],
    examples: ["rl workflow run --base origin/test --dry-run"],
  },
  "workflow add": {
    description: "Add a workflow with dependencies and spawn triggers",
    usage: "rl workflow add <name> --file <workflow.json|-> [--default]",
  },
  "workflow set": {
    description: "Save a workflow definition and trigger rules",
    usage: "rl workflow set <name> --file <workflow.json|-> [--default]",
  },
  "workflow context": {
    description: "Discover profiles, policies, workflows and trigger rules",
    usage: "rl workflow context [--json]",
    notes: [
      "For an existing agent session: --json includes profiles, policies, workflows, and protocol.tools with every CLI command and input schema. Use your normal shell tool; MCP and rl agent start are optional.",
    ],
  },
  "workflow pending": {
    description: "Read queued workflows for the parent session",
    usage: "rl workflow pending [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow event": {
    description: "Report a milestone and match workflow triggers",
    usage:
      "rl workflow event --file <event.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow claim": {
    description: "Claim a ready step for a native subagent",
    usage:
      "rl workflow claim <run> [--step <name>] [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow report": {
    description: "Submit a claimed native agent's evidence or a check result",
    usage:
      "rl workflow report <run> --file <report.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow dismiss": {
    description: "Dismiss an unavailable workflow with a reason",
    usage:
      "rl workflow dismiss --file <dismissal.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow bind": {
    description: "Bind a role to the native peer spawned by this session",
    usage:
      "rl workflow bind <run> --file <binding.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow inbox": {
    description: "Read a peer's requests, review checkpoints and ratings",
    usage:
      "rl workflow inbox <run> --step <step> --claim <token> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow consult": {
    description: "Ask an existing peer through a configured workflow route",
    usage:
      "rl workflow consult <run> --file <consultation.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow answer": {
    description: "Return reuse or duplication evidence to a requesting peer",
    usage:
      "rl workflow answer <run> --file <answer.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow submit": {
    description: "Submit writer work to the existing reviewer",
    usage:
      "rl workflow submit <run> --file <submission.json|-> [--agent codex|claude|agy] [--session <UUID>]",
  },
  "workflow review": {
    description: "Return a rating and evidence for a stable writer checkpoint",
    usage:
      "rl workflow review <run> --file <review.json|-> [--agent codex|claude|agy] [--session <UUID>]",
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
    notes: [
      "Stops new step claims. The parent session owns and stops native child processes; existing claims may still report while paused.",
    ],
  },
  "workflow cancel": {
    description: "Cancel a workflow run",
    usage: "rl workflow cancel [UUID|latest] [--json]",
  },
  "workflow resume": {
    description: "Continue unfinished workflow stages",
    usage:
      "rl workflow resume [UUID|latest] [--agent codex|claude|agy] [--session <UUID>] [--json]",
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
      "--agent codex|claude|agy Agent owning the handoff (default: codex)",
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
    description: "Integrate changes across workspaces",
    usage: "rl git <command>",
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
  "setup mcp": {
    description: "Connect this workspace's RL MCP server to your agent",
    usage: "rl setup mcp [codex|claude|agy] [--dry-run] [--json]",
    notes: [
      "Configures both clients by default: .codex/config.toml and .mcp.json in this adopted workspace.",
      "Select agy for .agents/mcp_config.json with an instance-specific server name. No global configuration is changed.",
      "Preserves other settings and servers. Existing unmanaged entries named rl require manual resolution.",
      "Launches the installed Node/RL directly, with this workspace and its RL state bound explicitly. Rerun after moving the installation.",
      "Reload your client and review its normal project trust/MCP approval. Your existing session creates native subagents.",
    ],
  },
  "setup dependencies": {
    description: "Install or check Git, zsh, fzf and GitHub CLI",
    usage: "rl setup dependencies [--check | --dry-run] [--json]",
    notes: [
      "Installs missing tools through an existing package manager, or checks availability with --check.",
      "Uses Homebrew on macOS, and Homebrew, APT, DNF, Yum, Pacman or APK on Linux. Administrator access may be required on Linux.",
      "Runs directly with Node, so it also works before zsh or a repository is available.",
    ],
  },
  "setup install": {
    description: "Complete or repair RL installation and shell integration",
    usage: "rl setup install [--shell zsh|bash]",
    notes: [
      "Installs missing Git, zsh, fzf and gh, then registers shell integration in your startup file.",
      "Preserves your settings and updates one RL-owned block. New terminals load RL automatically; reload the installing terminal once.",
      "Run once after npm install --global rl-workspaces, or again at any time to repair setup.",
    ],
  },
  "setup shell": {
    description: "Print shell integration",
    usage: "rl setup shell <zsh|bash>",
    examples: ['eval "$(rl setup shell zsh)"'],
  },
  doctor: {
    group: "Project",
    description: "Check and repair agent integration",
    usage: "rl doctor [codex|claude|agy] [--repair] [--json]",
    notes: [
      "Reports CLI availability, installed hooks and observed activity.",
      "--repair reinstalls this workspace's RL hooks.",
    ],
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
};

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
export function topicHelp(words: string[], strictLeaf = false): string {
  if (!words.length) return mainHelp();
  const name = match(words);
  if (
    !name ||
    ((strictLeaf || children(name).length > 0) &&
      words.length > name.split(" ").length)
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
      `Related: ${topic.related.map((related) => `rl help ${related}`).join(", ")}`,
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
  if (module === "summary") return ["notes", "summary", ...rest];
  if (module === "mcp") return ["agent", "mcp", ...rest];
  if (module === "mcp-setup") return ["setup", "mcp", ...rest];
  if (module === "delete") return ["delete", ...rest];
  if (module === "clean") return ["clean", ...rest];
  if (module === "review") return ["review", ...rest];
  if (module === "feedback") return ["feedback", ...rest];
  if (module === "sync") return ["sync", ...rest];
  if (module === "picker") return [];
  if (module === "agent") return ["agent", ...rest];
  if (module === "git") return ["git", ...rest];
  if (module === "storage")
    return rest[0] === "clean" ? ["storage", ...rest] : rest;
  if (module === "workflow" && rest[0] === "config")
    return ["setup", ...rest.slice(1)];
  if (module === "state") {
    if (rest[0] === "session")
      return [
        "agent",
        rest[1] === "list" ? "sessions" : "save",
        ...rest.slice(2),
      ];
    if (rest[0] === "adopt") return ["setup", ...rest];
    if (["context", "progress"].includes(rest[0]))
      return ["notes", rest[1] ?? "show", rest[0], ...rest.slice(2)];
  }
  if (
    module === "repos" &&
    rest[0] === "status" &&
    rest.some((word) => word === "--all" || word === "--list")
  )
    return ["list", ...rest.slice(1)];
  const defaults: Record<string, string> = {
    state: "status",
    repos: "repo",
    workflow: "switch",
    automation: "workflow",
    "pr-update": "pr",
  };
  return rest.length ? rest : defaults[module] ? [defaults[module]] : [];
}
export function usageHintForWords(words: string[], details = false): string {
  const leading: string[] = [];
  for (const word of words) {
    if (word.startsWith("-")) break;
    leading.push(word);
  }
  const name = match(leading.length ? leading : words);
  if (!name) return "Run rl help for available commands.";
  const topic = topics[name];
  const lines = [`Usage: ${topic.usage}`];
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

export function usageHint(
  module: string,
  argv: string[],
  details = false,
): string {
  return usageHintForWords(invocation(module, argv), details);
}

export function explicitHelp(argv: string[]): string {
  let words = [...argv];
  if (words[0] === "--repo") words = words.slice(2);
  else if (words[0]?.startsWith("--repo=")) words = words.slice(1);
  const separator = words.indexOf("--");
  if (separator >= 0) words = words.slice(0, separator);
  words = words.filter((word) => word !== "--help" && word !== "-h");
  if (words[0] === "help") {
    return topicHelp(words.slice(1), true);
  }
  const leading: string[] = [];
  for (const word of words) {
    if (word.startsWith("-")) break;
    leading.push(word);
  }
  return topicHelp(leading);
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
