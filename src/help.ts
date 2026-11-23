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
      "--agent codex|claude|agy|opencode  Start an agent after switching",
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
      "--cloud              List workspaces on the cloud dev VM",
      "--include-cloud      Include cloud dev VM workspaces alongside local ones",
      "--vm <name>          Select a specific cloud VM",
      "--json               Print structured output",
      "--fetch              Refresh remote refs first",
      "--include-deleted    Include archived records",
    ],
    notes: [
      "Workspaces are grouped by repository; layout adapts automatically to terminal width.",
      "↑/↓ show commits ahead/behind upstream. PR and session columns appear when useful.",
      "Long names use ellipses. --json retains full names and all details.",
      "Existing Git worktrees appear automatically, labelled not initialized until added to RL.",
      "Pick one with rl to initialize it in place; listing does not initialize worktrees.",
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
    usage: "rl review [branch|worktree] [action] [options]",
    options: [
      "--all                     Choose a worktree from the review queue",
      "--branch <name>           Review a local or remote-tracking branch without checkout",
      "--cloud                   Review a workspace on the cloud dev VM over SSH",
      "--pr <number|URL>         Review a remote GitHub PR without a checkout",
      "--github-repo <owner/repo> Select a remote repository (optional HOST/ prefix)",
      "--local                   Combine --pr with the current working tree instead",
      "--live                    Require the live terminal interface",
      "--remote-interval <sec>   PR polling interval (default 60; minimum 10)",
      "--summary                 AI implementation summary (manual fallback if unavailable)",
      "--diff                    Complete feature diff against the fixed baseline",
      "--base <ref>              Branch comparison target; pin baseline for legacy worktree actions",
      "--checkpoint              Save an inspected source/index checkpoint",
      "--checkpoints             List saved checkpoints",
      "--since-last-review       Compare with the latest checkpoint",
      "--since <revision|UUID>   Revision → HEAD, or a legacy checkpoint UUID",
      "--snapshot <UUID>         Inspect an immutable saved snapshot",
      "--approve                 Approve the last inspected snapshot if still current",
      "--ready                   Mark this snapshot ready for human review",
      "--ai-review               Run an independent AI review",
      "--groups                  Browse logical groups backed by Git file/hunk IDs",
      "--provider codex|claude|agy|opencode    Select the AI provider",
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
      "A branch without an RL workspace shows committed changes from its merge-base with the configured default base (override with --base). Existing workspace names keep working-tree behavior; --branch explicitly chooses committed review. Remote-tracking branches use locally fetched refs; no automatic fetch or checkout.",
      "Local review watches source, HEAD and index. --pr uses an isolated bare Git cache and remote polling; no checkout is created. m/s retain exact reviewed revisions.",
      "In PR mode: i drafts an inline comment, D manages local drafts, and R submits a GitHub review after confirmation. Git files remain read-only.",
      "W opens live local workflow roles, blockers, criteria, check receipts and findings. Select a finding to open its diff or prepare a GitHub comment draft.",
      "Queue: Enter review, Alt-S summary, Alt-D diff, Alt-F feedback, Alt-A approve, Alt-O editor, Ctrl-R refresh, Esc quit.",
      "New rl switch -c branches record a fixed baseline. Older worktrees require explicit --base; no feature baseline is guessed.",
      "Temporary Git indexes capture committed, staged, unstaged and non-ignored untracked source without changing your real index or branch.",
      "Omitted sensitive/oversized paths, conflicts and unstable snapshots block approval. AI analysis never approves code or proves tests passed.",
      "Agent activity is last-observed hook activity, not process-liveness or task-completion proof. Review state lives beside existing notes and sessions.",
    ],
    examples: [
      "rl review",
      "rl review feature/login",
      "rl review origin/feature/login --base origin/main",
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
      "--agent <name>  Filter saved sessions to codex, claude, agy or opencode",
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
    usage:
      "rl resume [codex|claude|agy|opencode] [--latest|-l|--l] [--desktop]",
    options: [
      "--latest, -l, --l  Resume the most recently used matching session directly",
      "--desktop         Open Codex or Claude Desktop instead of the terminal",
    ],
    notes: [
      "Without a filter, offers both Codex and Claude sessions in this workspace.",
      "One match resumes automatically; multiple matches open a picker.",
      "Claude Desktop resumes the exact saved CLI session. Codex Desktop opens its workspace; choose the displayed session ID in the app.",
      "Desktop launch uses the native CLIs and their existing installation, platform and authentication requirements.",
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
      "rl agent start <codex|claude|agy|opencode> [--workspace <name>] [--desktop] [-- <agent args>]",
    options: [
      "--desktop  Open Codex or Claude Desktop on the resolved worktree",
    ],
    notes: [
      "--desktop does not accept forwarded terminal options or change global app settings.",
    ],
    examples: [
      "rl agent start codex -- --model <model>",
      "rl agent start codex --desktop",
      "rl agent start claude --desktop",
    ],
  },
  "agent run": {
    description: "Run an agent non-interactively",
    usage:
      "rl agent run <codex|claude|agy|opencode> --prompt <text> [--workspace <name>] [-- <agent args>]",
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
    usage: "rl agent sessions [codex|claude|agy|opencode]",
  },
  "agent save": {
    description: "Save the current or an explicit conversation",
    usage: "rl agent save [codex|claude|agy|opencode] [UUID] [--json]",
    notes: [
      "Defaults to the current Codex session ID. Claude requires an explicit UUID.",
    ],
  },
  "agent handoff": {
    description: "Export shared task context",
    usage:
      "rl agent handoff [codex|claude|agy|opencode] [--workspace <name>] [--stdout | --output <file>]",
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
    description: "View, configure and track agent workflows",
    usage: "rl workflow <command>",
    notes: [
      "Run controls apply only to this adopted workspace.",
      "Omit a run UUID, or use latest, to select its most recently created run.",
      "Agent coordination commands: rl workflow --help --all",
    ],
    examples: [
      "rl workflow show",
      "rl workflow configure",
      "rl workflow sniperflow 'Implement the ticket in tickets/2481.md'",
      "rl workflow status --follow",
    ],
  },
  "workflow sniperflow": {
    description:
      "Launch recursive ticket implementation with supervised Codex agents",
    usage:
      "rl workflow sniperflow '<objective>' [--lines 500] [--seconds 10800] [--agent-seconds N] [--writer-seconds N]",
    options: [
      "--agent-seconds <N>  Default delegated assignment time (300 seconds)",
      "--writer-seconds <N> Default writer time (900 seconds, or explicit --agent-seconds)",
      "--lines <N>         Set the total logic-line budget at launch or during a run",
      "--extend <seconds>  Extend the running workflow from a second terminal",
      "--status            Show the deadline, outcome and saved draft directory",
    ],
    notes: [
      "The orchestrator dispatches up to three file-exclusive writers. The product owner and three independent reviewers inspect their changes before acceptance.",
      "The budget counts added production lines since launch. Tests, styles and data files are exempt. Accepted patches are applied to the worktree.",
    ],
  },
  "workflow configure": {
    description: "Edit this workspace's workflow settings",
    usage: "rl workflow configure [--paths | --json]",
    notes: [
      "Creates editable defaults on first use; otherwise opens existing configuration files.",
      "Opens profiles, policies and workflows in $VISUAL or $EDITOR (default: vi).",
      "Use a waiting editor command, such as EDITOR='code --wait', for validation after editing.",
      "--paths, --json or a non-interactive terminal prints paths without opening an editor.",
    ],
  },
  "workflow init": {
    description: "Create editable profiles, policies and workflows",
    usage:
      "rl workflow init [--provider inherit|codex|claude|agy|opencode] [--json]",
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
    description: "Show the default workflow or a named workflow",
    usage: "rl workflow show [name] [--json]",
  },
  "workflow run": {
    description: "Prepare a workflow for this session's native agents",
    usage: "rl workflow run [name] [options]",
    options: [
      "--base <ref>     Local comparison ref (default: repository setting)",
      "--prompt <text>  Feature intent for the reviewers",
      "--level auto|light|standard|deep  Select execution depth (default auto for unnamed built-in runs)",
      "--file <plan.json|->  Acceptance criteria and optional level; see workflow context schemas",
      "--dry-run        Preview scope and steps without launching agents",
      "--json           Print structured results",
      "--agent codex|claude|agy|opencode  Parent session provider",
      "--session <UUID>     Parent conversation (inferred inside Codex)",
      "--request <UUID>     Start a queued workflow request instead of choosing a name",
    ],
    notes: [
      "Light runs writer then reviewer; Standard runs them concurrently; Deep also retains DRY. Auto considers sensitive behavior and scope, not just line count.",
      "Standard and Deep first run a read-only researcher that seeds multiple approaches. The coordinator records workflow decide before the writer starts.",
      "Leveled runs require host preflight and current evidence for required acceptance criteria. Explicit named/custom runs without --level retain their declared plan.",
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
    usage:
      "rl workflow pending [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow event": {
    description: "Report a milestone and match workflow triggers",
    usage:
      "rl workflow event --file <event.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow claim": {
    description: "Claim a ready step for a native subagent",
    usage:
      "rl workflow claim <run> [--step <name>] [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow report": {
    description: "Submit a claimed native agent's evidence or a check result",
    usage:
      "rl workflow report <run> --file <report.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow dismiss": {
    description: "Dismiss an unavailable workflow with a reason",
    usage:
      "rl workflow dismiss --file <dismissal.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow bind": {
    description: "Bind a role to the native peer spawned by this session",
    usage:
      "rl workflow bind <run> --file <binding.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow inbox": {
    description: "Read a peer's requests, review checkpoints and ratings",
    usage:
      "rl workflow inbox <run> --step <step> --claim <token> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow consult": {
    description: "Ask an existing peer through a configured workflow route",
    usage:
      "rl workflow consult <run> --file <consultation.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow answer": {
    description: "Return reuse or duplication evidence to a requesting peer",
    usage:
      "rl workflow answer <run> --file <answer.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow submit": {
    description: "Submit writer work to the existing reviewer",
    usage:
      "rl workflow submit <run> --file <submission.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow review": {
    description: "Return a rating and evidence for a stable writer checkpoint",
    usage:
      "rl workflow review <run> --file <review.json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
  },
  "workflow status": {
    description: "Inspect each agent's state, progress and waiting conditions",
    usage: "rl workflow status [UUID|latest] [--json|--watch|--follow]",
    notes: [
      "--watch refreshes per-agent activity every second in the current terminal. j/k or arrows scroll; q, Escape or Ctrl-C closes it. Recorded claims and heartbeats do not independently establish native process liveness.",
      "--follow streams timestamped activity, research choices and validation results as plain text. It checks every second and prints a waiting notice after 30 seconds without changes. Stops when the run completes, pauses or is cancelled; Ctrl-C closes the stream without cancelling the workflow.",
    ],
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
  "workflow preflight": {
    description:
      "Record actual native host capabilities before claiming leveled work",
    usage:
      "rl workflow preflight [UUID] --file <json|-> [--agent codex|claude|agy|opencode] [--session <UUID>]",
    notes: [
      "Input: run and capabilities {delegation,messaging,readOnly,models,degradedReason?}. Capabilities are host-reported; unavailable delegation blocks execution.",
    ],
  },
  "workflow assess": {
    description: "Record coordinator effort reasoning before claiming roles",
    usage: "rl workflow assess [UUID] --file <json|->",
    notes: [
      "Input: run and assessment {level,rationale,uncertainty,systems,consequences}. Auto is a baseline; the coordinator assesses complexity. Explicit user-selected levels remain pinned. A changed level rebuilds unclaimed roles and requires renewed host preflight.",
    ],
  },
  "workflow budget": {
    description: "Set bounded research, execution and review budgets",
    usage: "rl workflow budget [UUID] --file <json|->",
    notes: [
      "Input: run and budgets {researchMs,runMs,checkMs,submissions,consultations,reviewRounds}. Defaults apply to omitted budget fields. Budgets freeze after roles start and cannot be changed while a captured command is running.",
    ],
  },
  "workflow orient": {
    description: "Record the reviewer's independent first-pass risks",
    usage: "rl workflow orient [UUID] --file <json|->",
    notes: [
      "Input: run, step, claim, fingerprint, risks, checksToChallenge and assumptions. Research recommendations and writer rationale are withheld from claimed prompts/inboxes until this pass is saved; this is a protocol, not an access-control boundary.",
    ],
  },
  "workflow resolve": {
    description: "Resolve a rejected checkpoint disagreement with evidence",
    usage: "rl workflow resolve [UUID] --file <json|->",
    notes: [
      "Input: run, submission, decision (fix/reject/blocked), rationale and evidence. A resolution directs the next action; it does not accept a checkpoint, dismiss findings or bypass a fresh review.",
    ],
  },
  "workflow escalate": {
    description: "Create a higher-effort successor after host-confirmed stop",
    usage: "rl workflow escalate [UUID] --file <json|->",
    notes: [
      "Input: run, higher level, rationale and stopped:true. Stop all native children/checks before confirming. Auto runs may escalate; pinned user levels require a new user-selected run. Original records remain intact; successor evidence retains provenance and is revalidated by source identity.",
    ],
  },
  "workflow check": {
    description:
      "Execute a planned validation command and capture actual results",
    usage: "rl workflow check [UUID] --file <json|->",
    notes: [
      "Input: run, check, exact command argv, absolute cwd, mode (static/mocked/live) and optional timeoutMs. Runs within the worktree and current host permissions, without adding a shell. Output/time are bounded. Captured execution does not certify the reported mode or dependency coverage.",
    ],
  },
  "workflow outcome": {
    description: "Record a benchmark trial using captured outcome graders",
    usage: "rl workflow outcome [UUID] --file <json|->",
    notes: [
      "Input: run, suiteVersion:1, case, trial, kind (native/synthetic), acceptance and regression receipt UUIDs, observedDefects and notes. Requires current captured results from the suite's exact graders.",
    ],
  },
  "workflow eval": {
    description: "List representative tasks or compare saved outcome trials",
    usage: "rl workflow eval [--file <json|->] [--json]",
    notes: [
      "Without --file, prints versioned task fixtures and acceptance/regression commands. With {runs:[UUID,...]}, compares recorded trials by case, level and native/synthetic kind. This command never launches models, runs graders or changes source.",
    ],
  },
  "workflow criteria": {
    description: "Record explicit acceptance criteria before work begins",
    usage: "rl workflow criteria [UUID] --file <json|->",
    notes: [
      "Input: run and criteria [{id,text,required,validation:any|mocked|live,checks:[{id,expected,command?,mode?,source?,scope?}]}]. Required criteria need individually planned checks. IDs are unique across the run; every required check must pass. Criteria freeze once a role is claimed.",
    ],
  },
  "workflow research": {
    description: "Save multiple distinct approach seeds before implementation",
    usage: "rl workflow research [UUID] --file <json|->",
    notes: [
      "Requires the current researcher step/claim and a source-bound brief with 2–5 distinct mechanisms, evidence, tradeoffs, risks, validation and a viable recommendation. Aim for three credible alternatives; never invent viable choices.",
    ],
  },
  "workflow decide": {
    description: "Select a research approach before the writer starts",
    usage: "rl workflow decide [UUID] --file <json|->",
    notes: [
      "Input: run, approach ID and coordinator rationale. The selection must be a saved viable seed; recommendation alone does not authorize implementation.",
    ],
  },
  "workflow validation": {
    description: "Save actual check output against an exact source fingerprint",
    usage: "rl workflow validation [UUID] --file <json|->",
    notes: [
      "Input: run and receipt with check ID, criteria, argv command, cwd, exitCode, mode, fingerprint, files, artifacts, stdout, stderr and durationMs. Parent-reported; this command does not execute checks or satisfy a captured-only check. Use workflow check for command capture.",
    ],
  },
  "workflow heartbeat": {
    description: "Record progress and renew a current claim's inactivity lease",
    usage: "rl workflow heartbeat [UUID] --file <json|->",
    notes: [
      "Input: run, step, claim and message. Status and W in rl review expose stalled claims.",
    ],
  },
  "workflow recover": {
    description:
      "Recover an expired claim after the parent has stopped its native child",
    usage: "rl workflow recover [UUID] --file <json|->",
    notes: [
      "Input: run, step, claim, stopped:true and reason. Recovery invalidates the old claim and binding; it never kills or silently replaces a host-owned agent.",
    ],
  },
  "workflow cancel": {
    description: "Cancel a workflow run",
    usage: "rl workflow cancel [UUID|latest] [--json]",
  },
  "workflow resume": {
    description: "Continue unfinished workflow stages",
    usage:
      "rl workflow resume [UUID|latest] [--agent codex|claude|agy|opencode] [--session <UUID>] [--json]",
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
      "--agent codex|claude|agy|opencode Agent owning the handoff (default: codex)",
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
    description: "Register a local repository or clone a Git URL",
    usage:
      "rl repo add [path|git-url] [directory] [--alias <name>] [--base <ref>] [--worktree-name <name>]",
    notes: [
      "Defaults to the current directory. Uses the origin repository name, or the main checkout directory name when there is no origin.",
      "A Git URL clones into a new directory (default: ./<alias-or-repository-name>), registers it, and enters it with shell integration.",
      "Use --alias for a custom name. The existing <alias> <path> form also works.",
    ],
    examples: [
      "rl repo add .",
      "rl repo add . --alias frontend --base origin/test",
      "rl repo add git@github.com:owner/project.git",
    ],
  },
  "repo clone": {
    description: "Clone, register and enter a repository",
    usage:
      "rl repo clone <git-url|path> [directory] [--alias <name>] [--base <ref>] [--worktree-name <name>]",
    notes: [
      "Defaults to ./<alias-or-repository-name>. Existing destinations are never overwritten, including empty directories.",
      "Uses Git's normal authentication and the remote default branch. --base sets the workspace comparison base, not the clone branch.",
      "Shell integration enters the clone; the standalone executable prints its path. Project setup scripts are not run.",
      "Failed clones may leave a partial directory. If registration fails, the completed checkout is retained for manual registration.",
    ],
    examples: [
      "rl repo clone https://github.com/owner/project.git",
      "rl repo clone git@github.com:owner/project.git ./projects/frontend --alias frontend",
    ],
  },
  "repo list": {
    description: "List registered repositories",
    usage: "rl repo list [--cloud | --include-cloud] [--vm <name>] [--json]",
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
    description: "Register an existing workspace and install hooks",
    usage: "rl setup adopt [path] [--extended-hooks]",
    notes: [
      "Defaults to the current directory. The worktree must belong to the selected repository and have a checked-out branch.",
      "Registers it in place without moving it, checking out a branch or running project setup.",
      "Preserves existing hooks. Review Codex hook trust with /hooks.",
    ],
    examples: ["rl setup adopt /path/to/worktree"],
  },
  "setup mcp": {
    description: "Connect this workspace's RL MCP server to your agent",
    usage: "rl setup mcp [codex|claude|agy|opencode] [--dry-run] [--json]",
    notes: [
      "Configures both clients by default: .codex/config.toml and .mcp.json in this adopted workspace.",
      "Select agy for .agents/mcp_config.json with an instance-specific server name, or opencode for opencode.json. No global configuration is changed.",
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
    usage: "rl setup install [--shell-only] [--shell zsh|bash]",
    notes: [
      "Installs missing Git, zsh, fzf and gh, then registers zsh and bash shell integration in your startup files.",
      "Pass --shell-only to configure shell integration without installing tools.",
      "Pass --shell zsh or --shell bash to configure only one shell.",
      "Preserves your settings and updates one RL-owned block per file. New terminals load RL automatically; reload the installing terminal once.",
      "Run once after npm install --global rl-workspaces, or again at any time to repair setup.",
    ],
  },
  "setup shell": {
    description: "Print shell integration",
    usage: "rl setup shell <zsh|bash>",
    examples: ['eval "$(rl setup shell zsh)"'],
  },
  cloud: {
    group: "Workspaces",
    description: "Open, list and create workspaces on an SSH host",
    usage: "rl cloud [command] [options]",
    options: [
      "--host <name>          Target an existing SSH host (e.g. dev-box)",
      "--code               Open the selected cloud workspace in VS Code Remote-SSH",
      "--agent codex|claude|agy|opencode  Start an agent after entering the cloud workspace",
      "--resume             Resume a saved agent conversation in the cloud workspace",
    ],
    notes: [
      "With no subcommand, opens an interactive picker of cloud repositories and workspaces.",
      "Picker shortcuts: Enter opens an SSH shell in the remote directory, Alt-O opens VS Code, Alt-R reviews locally, Alt-C checks out locally.",
      "Uses your existing SSH configuration. Set a host with rl cloud use <host> or cloudHost in config.toml; --vm and cloudVm remain compatible aliases.",
    ],
    examples: [
      "rl cloud",
      "rl cloud repos",
      "rl cloud list",
      "rl cloud review",
      "rl cloud checkout feature/login",
      'rl cloud switch -c "blah" -p "My prompt"',
      'rl cloud switch -c "blah" -a agy -m "MODEL_NAME" -p "My prompt"',
      'rl cloud switch "blah"',
      "rl cloud create feature/login --repo frontend",
    ],
    related: ["list", "review"],
  },
  "cloud open": {
    description: "Pick or enter a cloud repository or workspace",
    usage:
      "rl cloud [open] [selector] [--host <name>] [--code] [--agent codex|claude|agy|opencode] [--resume]",
  },
  "cloud switch": {
    description:
      "Open a remote workspace, or create one and launch a detached agent",
    usage:
      "rl cloud switch [-c] <workspace> [-p <prompt>] [-a <agent>] [-m <model>] [options]",
    options: [
      "-c, --create          Create a Git branch and worktree on the existing host",
      "-p, --prompt <text>   Launch a detached background job (default agent: agy)",
      "-a, --agent <name>    agy, codex, claude or opencode",
      "-m, --model <name>    Native model override; omitted preserves agent configuration",
      "--host <host>        Existing SSH host",
      "--repo <name>        Remote repository; disambiguates existing workspace names",
      "--base <ref>         Starting revision when creating",
      "--no-fetch           Create using cached refs",
      "--setup              Run normal workspace setup when creating",
      "--code / --resume    Existing interactive open actions (without --prompt)",
      "--json               Print detached job details as JSON",
    ],
    notes: [
      "Without --create, the workspace must already exist; names match exactly.",
      "Without --prompt, enters the workspace interactively over SSH. With --prompt, returns after launch confirmation; the job survives SSH disconnects.",
      "One detached job per workspace. Launch confirmation does not mean task success; inspect its exit status and log with rl cloud job <id>.",
      "Uses existing SSH authentication and native agent permission settings; no bypass flags are added.",
    ],
  },
  "cloud job": {
    description:
      "Inspect a detached agent job's status, exit code and log location",
    usage: "rl cloud job <id> [--host <host>] [--json]",
    notes: [
      "Prints log-following and conversation-resume commands. Resume after the job stops and its normal agent hooks have recorded a conversation.",
      "Failed/interrupted jobs return nonzero. A completed job means the agent process exited successfully; review its output to verify the work.",
      "After an unreported supervisor crash, the workspace lock stays in place. Inspect remote processes before removing that job's lock directory manually.",
    ],
  },
  "cloud repos": {
    description: "List repositories on the SSH host",
    usage: "rl cloud repos [--host <name>] [--json]",
  },
  "cloud list": {
    description: "List RL workspaces on the SSH host",
    usage:
      "rl cloud list [--host <name>] [--fetch] [--include-deleted] [--json]",
  },
  "cloud code": {
    description: "Open a cloud repository or workspace in VS Code Remote-SSH",
    usage: "rl cloud code [selector] [--host <name>]",
  },
  "cloud fetch": {
    description: "Fetch a branch directly from the SSH host over SSH",
    usage: "rl cloud fetch [selector] [--host <name>] [--remote] [--json]",
  },
  "cloud checkout": {
    description: "Fetch a cloud branch over SSH into a local RL workspace",
    usage:
      "rl cloud checkout [selector] [--host <name>] [--include-uncommitted]",
  },
  "cloud review": {
    description:
      "Review committed and uncommitted cloud workspace changes locally",
    usage:
      "rl cloud review [selector] [--host <name>] [--diff] [--json] [--remote]",
  },
  "cloud use": {
    description: "Set the default SSH host",
    usage: "rl cloud use <ssh-host>",
  },
  "cloud create": {
    description: "Create a workspace on an existing SSH host",
    usage:
      "rl cloud create <name> [--repo <remote-repository>] [--host <host>] [--base <ref>] [--no-fetch] [-p <prompt>] [-a <agent>] [-m <model>]",
    notes: [
      "Requires rl and a registered repository on the server. Uses its default repository, or asks you to select one.",
      "Creates a Git worktree and branch using the server's normal rl workflow, and prints its path. Use rl cloud open to enter it.",
      "--repo selects a remote repository; it does not use your locally selected repository.",
      "Compatibility alias for the same creation flow as cloud switch --create. With --prompt it launches the same detached job. By default it prints the created path; explicit --agent, --code or --resume opens it afterward.",
    ],
    examples: [
      "rl cloud create feature/login --repo frontend",
      "rl cloud open frontend/feature/login",
    ],
  },
  doctor: {
    group: "Project",
    description: "Check and repair agent integration",
    usage: "rl doctor [codex|claude|agy|opencode] [--repair] [--json]",
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
const workflowMenu = [
  "show",
  "configure",
  "status",
  "list",
  "pause",
  "resume",
  "cancel",
];
const menuChildren = (name: string, all = false) =>
  name === "workflow" && !all
    ? workflowMenu.map((command): [string, Topic] => [
        `workflow ${command}`,
        topics[`workflow ${command}`],
      ])
    : children(name);

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
export function topicHelp(
  words: string[],
  strictLeaf = false,
  all = false,
): string {
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
  const commands = menuChildren(name, all);
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
      ...menuChildren(name).map(
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
  const all =
    words.includes("--all") &&
    words[words[0] === "help" ? 1 : 0] === "workflow";
  if (all) words = words.filter((word) => word !== "--all");
  if (words[0] === "help") {
    return topicHelp(words.slice(1), true, all);
  }
  const leading: string[] = [];
  for (const word of words) {
    if (word.startsWith("-")) break;
    leading.push(word);
  }
  return topicHelp(leading, false, all);
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
