# rl

Git workspaces for Codex and Claude Code.

Create a workspace, start an agent, and keep task notes and sessions together.
Switch projects, prepare local dependencies, check PRs, and merge finished work
without losing your place.

Requires macOS or Linux, Git, zsh, and Node.js 22+. Bash users can use the Bash
integration. Install `fzf` for pickers, `gh` for PR commands, and whichever agent
you use.

## Install

Install from npm:

```sh
npm install --global rl-workspaces
```

The first npm release is pending; see Development below to build the unpublished version.

Add one line to your shell configuration, then open a new terminal:

```sh
eval "$(command rl setup shell zsh)"   # ~/.zshrc
# or
eval "$(command rl setup shell bash)"  # ~/.bashrc
```

Shell integration lets `rl` change your terminal's directory. Direct executable
calls print the selected path. The integration loads the current runtime on
each call, so an npm upgrade does not leave you using old commands.

## Get started

```sh
rl repo add . --base origin/test
rl switch feature/login -c --agent codex
# or: rl switch feature/login -c --agent claude

rl notes append progress implementation-notes.md
rl list
rl switch @                   # main checkout
rl switch -                   # previous workspace in this shell
rl switch feature/login
rl resume codex
```

The default base is `origin/test`. Use `--base`, `RL_DEFAULT_BASE`, or a registered
repository's base setting to choose another branch. Creation fetches origin first,
then branches from the refreshed remote base (including an explicit `--base origin/<branch>`).
A failed fetch stops creation. This refreshes remote refs without merging into a local
branch; add `--no-fetch` to work offline using cached refs. Notes and session links
survive workspace deletion.

## Commands and help

`rl help` shows a short list of command families. Arguments, options and examples
live in command-specific help, which works even outside a configured repository:

```sh
rl help
rl help pr
rl help pr update
rl workflow run --help
```

Invalid arguments show usage for that command instead of the full command list.
Git helpers live under `rl git`, shared documents under `rl notes`, saved sessions
under `rl agent`, cleanup under `rl storage`, and project/shell setup under
`rl setup`. Review policies remain separate from agent profiles and workflows.

| Command | Use |
| --- | --- |
| `rl` | Pick a workspace |
| `rl checkout` | Switch to a repository |
| `rl switch` | Open or create a workspace |
| `rl list` | List workspaces, optionally across repositories |
| `rl status` | Inspect the selected repository (`--workspace` for workspace details) |
| `rl delete` | Remove workspaces |
| `rl storage` | Inspect disk usage and clean generated files |

`rl help switch` also documents the specialized `new`, `open`, and `path`
helpers. `rl help exec` describes running an arbitrary command in a workspace.

Switching installs hooks and preserves existing notes. Creation validates names
and refuses path escapes or an already checked-out branch. `switch -c` requires a
new checkout; `new` and `open` can reopen an existing checkout. `open` flattens
slashes in directory names; `new` and `switch -c` retain nested names.

Pickers show cached PR state, commits ahead/behind the base, and recent use.
The `COMMITS + / −` column counts commits ahead/behind, rather than changed lines.
The picker compares with its displayed base; the status overview compares with the
displayed upstream. `CHANGES` reports changed files separately.
PR discovery uses `gh`; `RL_PR_OFFLINE=1` disables it. Status is offline by default.
`--fetch` explicitly refreshes tracking refs.

## Project setup

```sh
rl setup init
# Edit .rl/workflows.json in the main checkout.
rl setup --dry-run
rl setup
# Or: rl switch feature/login -c --setup
```

Example configuration:

```json
{
  "copy": [".env", ".cache"],
  "clean": ["node_modules", ".next", ".turbo"],
  "env": { "APP_MODE": "development" },
  "onCreate": [["npm", "ci"]],
  "onOpen": []
}
```

Setup runs only when explicitly requested. Commands are argument arrays, executed
in order without a shell; a failure stops setup and preserves the workspace.
`rl setup` runs both command lists. `switch --setup` runs `onCreate` for a new
checkout and `onOpen` whenever it opens one.

Copy entries must be ignored, untracked regular files or directories in both
checkouts. RL validates the complete copy plan before writing, skips existing
files, and copies independently using filesystem cloning where available.
Symlinks, tracked files, path escapes, and Git/agent/state configuration paths
are rejected.

Setup, `exec`, and agent launch receive the configured environment,
`RL_WORKSPACE`, and a stable `RL_PORT` derived from the repository and workspace.
Use `RL_PORT` in your development server command. It is a suggested port, not a
reservation; another process can occupy it. Project environment keys are limited
to `APP_*`, `PUBLIC_*`, `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `PORT`,
`NODE_ENV`, `DATABASE_URL`, and `REDIS_URL`. Runtime loader, executable search,
agent configuration, and permission variables cannot be overridden by the project.

## Storage and cleanup

These commands operate only on the current adopted RL workspace, including when
run from a directory inside it. They reject workspace selectors and cross-repository
routing. They do not scan or clean sibling worktrees.

```sh
rl storage                 # disk usage, largest paths, and cleanup suggestions
rl storage --json          # structured usage report
rl storage clean --dry-run         # preview configured generated directories and savings
rl storage clean                  # remove those generated directories
```

Add a `clean` array to `.rl/workflows.json` in the current workspace:

```json
{ "clean": ["node_modules", ".next", ".turbo"] }
```

The default list is empty. Entries must be literal, ignored directory paths.
Cleanup validates the complete plan before deleting anything and refuses tracked
files, credentials such as `.env`, Git/agent/task metadata, and symlink targets.
Links inside generated directories are unlinked without traversing their targets.
Code changes, branches, notes, sessions, and task handoffs stay in place. Close
development servers before cleaning their dependencies; use your project's install
and build commands to regenerate them later.

Storage reports approximate allocated sizes, deduplicating hard links within the
workspace. Cleanup estimates exclude hard-linked file data retained outside the
selected directories; filesystem clones and snapshots can also reduce actual
savings. Suggestions use the current workspace's last-access time (14 days by
default, configurable with `--older-than 30d`) and its cached PR state. Nothing is
deleted automatically.

## Finish a feature

```sh
rl git diff --base origin/test -- --stat
rl git log --base origin/test -- --graph
rl git commit -m "Add login"         # staged changes
rl git commit --all -m "Fix login"   # tracked changes; untracked files require git add
rl git rebase --base origin/test
rl git squash --base origin/test -m "Add login"
rl git merge test --dry-run
rl git merge test --cleanup
```

Git mutation commands also accept `--dry-run`. Rebase and squash require a clean
workspace. Squash preserves the original HEAD under a printed
`refs/rl/backups/<UUID>` ref; it rewrites local feature history without pushing.

Merge targets a checked-out local branch in the main or a managed checkout.
It requires clean source and target workspaces and defaults to fast-forward only.
For an explicit squash merge, use `rl git merge test --squash -m "Add login"`.
Conflicts are left available for normal Git resolution. Nothing implicitly
stashes changes or force-pushes.

`--cleanup` removes the clean source checkout only after successful integration.
An unmerged source branch is retained if Git refuses safe branch deletion,
including after a squash merge. The main checkout cannot be removed.

```sh
rl delete old-task another-task
rl delete --dry-run old-task
rl delete --force abandoned-task
```

Default deletion refuses dirty workspaces and branches not merged into their
upstream, or the main checkout when no upstream exists. `--force` explicitly
discards uncommitted work and unmerged local branches. Remote branches are never
deleted. Locked worktrees remain protected. Deletion supports the multi-select
picker and `--jobs 1..32` (default 4), retaining notes and session history.

## Pull requests

```sh
rl pr                     # open this branch's PR in your browser
rl pr sync                # save this branch's PR state
rl pr show                # readable saved snapshot with the full PR link
rl pr show --json         # saved metadata for scripts
rl pr checks [--json]     # query checks and preserve gh's exit status
rl pr checkout 123        # new managed pr-123 workspace
rl pr checkout 123 --name review/login
rl pr update --base test   # select your RL session PRs behind test, then update them
rl pr update 123 456 --base test --dry-run  # preview an explicit selection
```

`rl status --workspace` groups Git, PR, session, and task details with aligned labels,
relative cache times, and terminal colors (`NO_COLOR=1` disables colors);
use `rl status --workspace --json` for scripts. `rl pr sync --json` keeps machine-readable
refresh output. `rl pr show` works offline. `rl pr` uses the saved URL when
available; if the browser cannot open, that link remains in its output. With no
saved PR, it looks up the current branch through `gh pr view --web`.

Opening, refreshing, checks, and checkout require authenticated `gh`. Checkout verifies the origin repository,
PR identity, and fetched commit before creating a workspace. Fork PR checkout
is currently rejected. It does not change your current branch, publish, or merge
a PR. Failed refreshes retain the previous snapshot.

`rl pr update` brings selected PR branches up to date by merging the latest base
branch into them on GitHub. Run it from your current adopted RL workspace; it
uses that repository's configured base by default, or `--base test` / `origin/test`.
Only PR branches belonging to your active RL session workspaces in this repository
are eligible. Deleted session records and unrelated PRs are excluded. Saved Codex
or Claude conversations and a cached PR link are not required: RL matches the
live PR's head branch to its workspace records. Explicit PR numbers follow the
same restriction, and session ownership is checked again before each update.
PRs remain open. This command updates remote branches and requires authenticated
`gh` with permission to update those PRs. Local branches, edits, sessions, and
sibling worktrees are left in place; it creates no additional worktrees.

Without PR numbers, `fzf` lets you select multiple open PRs from your RL sessions
targeting the chosen base and missing some of its commits. Tab selects, Ctrl-A
selects all displayed rows, and Enter updates the selection. The picker checks up
to 100 matching session PRs by default;
`--limit` accepts 1–200, and a single batch accepts at most 50 selections. Explicit
numbers avoid the picker. `--dry-run` performs read-only checks and reports what
would be updated. If GitHub hasn't calculated mergeability yet, the preview says so.

Each result includes the PR link, branch, behind count in commits, and an outcome:
updated, already up to date, conflict, changed since selection, failed, pending,
or skipped. RL continues after individual failures and prints a final summary;
`--json` provides structured results. GitHub's update request checks the expected
PR head commit so concurrent changes are rejected. RL verifies that the base is
included before reporting an update as complete; accepted updates that cannot
yet be verified stay pending. Conflicts and other incomplete outcomes return a
nonzero exit status. Closed, retargeted, and fork PRs are skipped.

## Codex and Claude

### Pause a task and continue later

Tell your agent “pause this task” once it has RL hooks or the RL MCP tools.
It saves a handoff containing the current session, concrete changes, reported
validation results, next steps, and blockers. The hook context tells agents how
to do this; MCP exposes `rl_task_pause` for a structured save.

```sh
rl continue                 # most recently paused task in the selected repository
rl continue feature/login   # choose a specific branch or workspace
rl continue --no-agent      # open it and print the handoff without launching an agent
```

With shell integration, `continue` changes your terminal's directory. It resumes
the exact conversation saved in the handoff, including when another session was
used more recently, and supplies the handoff as the initial prompt. It also points
the agent to the full shared context/progress documents. Hooks are not required
to deliver this continuation prompt. A failed launch leaves the task paused;
a newer handoff saved during the resumed session is retained. When no tasks are
paused, `continue` opens the most recently continued task. Selection stays within
the repository chosen by RL's normal routing or `--repo`.

An agent can save directly from its shell:

```sh
rl pause --summary "Login error states" \
  --changes "Added client-side validation in src/login.ts" \
  --validation "Unit tests passed; browser checks not run" \
  --next "Implement the server-error state, then run browser checks" \
  --blockers "Waiting for final copy"
```

Codex's current UUID is inferred from its environment. Outside Codex, pass
`--session <UUID>`; Claude also requires `--agent claude --session <UUID>`.
For automation, `rl pause --file handoff.json` or `rl pause --file -` accepts
JSON with `summary`, `changes`, `validation`, `next`, optional `blockers`,
`agent`, and `sessionId`. `--json` prints the saved checkpoint. Required text
fields cannot be empty; use “Not run” for checks that were not performed.

Pausing saves the handoff and session together under the state lock. It does not
stop the agent or alter Git files. Every checkpoint stays in the workspace's
`task.handoffs` history, including after workspace deletion. `rl status --workspace` includes
the saved handoffs, and `rl list` adds a TASK column showing `paused` or `active`.

### Start and resume agents

```sh
rl agent start codex -- --model <model>
rl agent start claude
rl agent run codex --prompt "Review the change" -- --json
rl agent run claude --prompt "Review the change"
rl agent handoff claude --output handoff.md
rl resume                # choose among this workspace's Codex and Claude sessions
rl resume --latest       # resume the most recently used session directly (-l / --l)
rl resume codex          # choose only among Codex sessions
rl resume codex --latest # resume the most recently used Codex session directly
rl resume claude         # choose only among Claude sessions
rl agent save codex     # from inside Codex, if needed
rl doctor
rl doctor --repair
```

Both launch modes preserve agent options after `--`, use the selected workspace,
and return the agent's exit status. Headless mode uses `codex exec` or
`claude --print`. RL leaves permissions and authentication to the agent.

`rl resume` lists saved Codex and Claude sessions for the current RL workspace.
If multiple sessions match, an `fzf` picker shows the agent, full session UUID,
last-used time, and start time, with the most recently used first. If exactly
one session matches, it resumes automatically. An optional `codex` or `claude`
argument filters the choices. Escape cancels without launching an agent.
Use `--latest` (or `-l` / `--l`) to skip the picker and resume the most recently
used matching session directly.
`rl continue` still resumes the exact session saved in its task handoff.

Run Codex normally in an adopted RL workspace, including in the Codex app.
`rl status`, `rl list`, `rl instances`, `rl agent sessions`, and `rl resume` / `rl resume codex`
automatically discover and save matching sessions through Codex's
[`thread/list` API](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination--filters).
Discovery filters by the exact workspace directory, excludes subagents and
ephemeral sessions, and checks branch metadata and existing ownership. Without
branch metadata, only sessions created after workspace adoption are imported.
It reads metadata from Codex's state database, preserves newer saved usage times,
and leaves saved sessions available if Codex is missing or discovery fails.
Overview tables show saved session counts in the CODEX and CLAUDE columns.

An agent can also run `rl agent save` (Codex by default) or
`rl agent save codex`; this uses its `CODEX_THREAD_ID`, falling back to
`CODEX_SESSION_ID`. `rl agent save <agent> <UUID>` explicitly saves a particular conversation.
Repeated saves update the existing entry. Resume uses the exact recorded UUID.
Observed Codex `thr_...` IDs are diagnostic only until UUID association is available.

Hooks supply shared context/progress at session start, after compaction, and to
subagents. Prompt submission refreshes changed notes. Codex hooks must be reviewed
and trusted with `/hooks` before they run; session discovery works independently.

| Integration | Codex | Claude Code |
| --- | --- | --- |
| Interactive / headless launch | `codex` / `codex exec` | `claude` / `claude --print` |
| Resume | `codex resume <UUID>` | `claude --resume <UUID>` |
| Project hooks | `.codex/hooks.json` | `.claude/settings.local.json` |
| Shared lifecycle | SessionStart, UserPromptSubmit, Stop, SessionEnd, SubagentStart, SubagentStop | Same |
| Optional extended hooks | Interrupt | StopFailure, Notification |

Run `rl setup adopt --extended-hooks` only with agent versions supporting those events.
Adoption preserves unrelated hooks/settings and excludes generated files locally.
It never edits global agent configuration. Review agent hook trust and restart
the agent after adoption or repair.

Doctor reports PATH/version/help probes, installed handlers, and observed events.
Installed help is evidence for launch options; installed files are not proof of
trusted hook delivery. Activity is `working`, `idle`, `ended`, or `stale` after
30 minutes without an event. It describes observations, not process liveness.

Compatibility is tested with documented payloads, stub processes, and installed
CLI help: Codex 0.160.1 and Claude Code 2.1.290. Live model sessions and all older
versions are not certified. See the official [Codex hooks](https://learn.chatgpt.com/docs/hooks)
and [Claude hooks](https://code.claude.com/docs/en/hooks) contracts.

## Agent workflows

RL owns agent profiles, workflow execution, review policies, and saved run state.
The built-in `triple-review` preset runs three independent, read-only roles:
behavior/security, reuse/complexity, and implementation quality. Each role can
use Codex or Claude; its model defaults to that CLI's configured model unless
you set one explicitly. Your existing interactive agent and session commands
continue to work alongside these review workflows.

```sh
rl workflow init                    # create editable configuration in this workspace
rl workflow init --provider claude  # alternative: initialize every role with Claude
rl agent list
rl agent show behavior
rl policy show review
rl workflow show triple-review
rl workflow run --base origin/test --dry-run
rl workflow run --base origin/test --prompt "Check the leave replacement feature"
rl workflow status                  # latest run in this workspace
rl status --workspace               # includes a compact summary of the latest workflow
rl workflow metrics
rl workflow pause                   # request a pause from another terminal
rl workflow cancel
rl workflow resume                  # continue unfinished steps using the saved configuration
rl workflow score --policy review   # apply current policy to saved findings; no agent calls
```

All commands operate on the current adopted RL workspace. Run IDs may be passed
after `status`, `metrics`, `pause`, `cancel`, `resume`, and `score`; `latest` or
omitting the ID selects the most recently created run. `--json` is available for
scripts. Inspection and dry runs never start agents. A real run uses your existing
CLI authentication and can consume model usage. Review workers are ephemeral;
their conversations do not replace your saved interactive sessions or become
the target of `rl resume --latest`. RL does not change global agent
settings, bypass approval or sandbox controls, or install dependencies.

Configuration is deliberately split into three versioned files:

| File | Owns |
| --- | --- |
| `.rl/agents.json` | Named profiles: `provider`, `description`, `instructions`, optional `model` and `reasoning` |
| `.rl/agent-workflows.json` | Named workflows: steps, dependencies, concurrency, reviewer retries, stage timeouts, and selected policy |
| `.rl/policies.json` | Shared review criteria, severity deduction weights, minimum passing score, and required-fix gating |

Each file has `"version": 1` and an `agents`, `workflows`, or `policies` object
keyed by name. Edit these project files to configure agents and add workflows or
policies. Missing files use the built-in defaults; `init` refuses to overwrite
existing configuration. Configuration is read from this worktree, not a sibling
checkout. Agent profiles contain no score formula: agents receive the policy's
shared criteria and return structured findings, evidence, confidence and coverage
limitations. RL calculates the score and readiness verdict.

For example, a workflow can run one shared check, then two reviewers in parallel:

```json
{
  "description": "Check once, then review",
  "policy": "review",
  "concurrency": 2,
  "retries": 1,
  "timeoutSeconds": 600,
  "steps": [
    { "id": "types", "command": ["pnpm", "tsc", "--noEmit"], "after": [] },
    { "id": "behavior", "agent": "behavior", "after": ["types"] },
    { "id": "quality", "agent": "quality", "after": ["types"] }
  ]
}
```

Add that object under a name in the `workflows` map, then run
`rl workflow run <name>`. Steps with no dependencies can run concurrently;
`after` lists the steps that must complete first. Commands are explicit argv
arrays, run without a shell, and execute once per run unless explicitly resumed
after failure. Configure only checks you intend RL to execute. A failed check
blocks its dependents. Reviewer failures retry according to `retries` (default
one); invalid output and provider errors cannot silently become clean reviews.
Reviewers can request configured check IDs. An unconfigured or failed requested
check makes the verdict incomplete.

Independent reviewers receive no peer reports. An explicit agent dependency
passes only its declared predecessors' results. After the initial passes, routed
leads receive one focused follow-up by their owning step; follow-ups never get
the source reviewer's full report. Remaining routing leads are coverage gaps.

The review scope includes committed branch changes from the merge-base, staged
and unstaged changes, and non-ignored untracked files. The base uses local refs
without fetching; specify `--base` or use the repository's configured default.
Scope snapshots are limited to 4 MiB. RL checks scope fingerprints before and
after steps, and rejects resuming results against changed code. No changes means
no agents are launched and no score is assigned.

The default policy starts at 100 and deducts 50/20/10/2 for critical/high/medium/low
findings, flooring at zero. Exact file/line/root-cause matches are deduplicated
conservatively, retaining the strongest severity and required-fix designation.
Any required fix blocks readiness by default; material coverage gaps, failed
steps and interrupted runs remain incomplete regardless of score. Evidence paths
and result contracts are validated; inferred findings still require human
judgment. Changing a policy and running `score` evaluates the recorded findings,
not newly changed code. It does not rerun reviewers or rewrite agent profiles.
Each assessment records its policy and result; the original run configuration
and earlier assessments remain available for comparison.

Runs, configuration snapshots, scope, outputs and measured stage durations live
under the current instance's `workflow-runs/<UUID>/` state directory. Pause and
cancel requests terminate only child processes owned by that runner; Ctrl-C
pauses the run. Resume retains completed stages and reruns unfinished ones.
Only one runner may own a given run. After an unclean process exit, its lock may
take up to ten seconds to become stale before resume is available. Token/cost
metrics use provider-reported values; unavailable or incomplete totals are
`null`, including totals where failed/retried attempts weren't fully reported.

The backend contracts follow the official
[Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude programmatic CLI documentation](https://code.claude.com/docs/en/headless).
These workflow profiles currently produce structured, read-only reviews;
interactive implementation remains available through `rl agent start`.

## Let agents use notes through MCP

`rl agent mcp` serves workspace-scoped tools over stdio: `rl_status`, `rl_context`,
`rl_progress`, `rl_context_append`, `rl_progress_append`, `rl_session_save`,
and `rl_task_pause`.
`rl_task_pause` accepts the handoff JSON described above and atomically saves
the session and task checkpoint. `rl_status` includes task state and handoff history.
`rl_status` automatically discovers Codex sessions for this workspace.
`rl_session_save` accepts `{"agent":"codex","sessionId":"<UUID>"}`;
`agent` defaults to Codex. If `sessionId` is omitted, it uses the MCP server's
Codex environment when available. Clients should pass their current UUID when
the server does not inherit it. Claude requires an explicit UUID.
Append tools take `{"text":"..."}`. They share the same locked document updates
as the CLI and expose no arbitrary command, deletion, or filesystem tool.

In the adopted workspace, add an entry to its trusted `.codex/config.toml`:

```toml
[mcp_servers.rl]
command = "rl"
args = ["agent", "mcp"]
```

For Claude, merge this entry into the workspace's `.mcp.json`:

```json
{
  "mcpServers": {
    "rl": { "type": "stdio", "command": "rl", "args": ["agent", "mcp"] }
  }
}
```

The client must launch the server in this workspace with `rl` on PATH.
With custom state settings, pass the same `RL_STATE_DIR` in the server environment.
Review project trust/server approval normally. Configuration follows the official
[Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and
[Claude MCP guide](https://code.claude.com/docs/en/mcp).
RL does not modify global client settings or relax agent sandbox permissions.

## Notes and reports

```sh
rl notes show context
rl notes show progress
rl notes set context feature-notes.md
rl notes append progress implementation-notes.md
printf 'Done: parser. Next: integration tests.\n' | rl notes append progress -
rl notes summary --stdout
rl notes summary --output feature-report.md
```

Context records scope, domain rules, acceptance criteria, and design decisions.
Progress records completed work, remaining tasks, implementation details, and
validation. Append preserves concurrent updates; set replaces a document.
Handoff and summary exports refuse to overwrite existing files; summary also
supports explicit `--force`. Long injected notes include an excerpt and their path.

State lives under `$RL_STATE_DIR/<repository-hash>/<instance-UUID>/`, outside
the checkout, with `instance.json`, `context.md`, and `progress.md`.
Deleting a workspace archives its record. Recreating it starts a new instance
with separate sessions. Back up state alongside your work.

## Multiple repositories and settings

```sh
rl repo add /path/to/rosterlab-frontend --base origin/test
rl repo add /path/to/romeo --base origin/test
# Or run `rl repo add .` inside each repository.
rl checkout rosterlab-frontend
rl                            # pick a frontend workspace
rl checkout romeo
rl checkout                   # pick a repository
rl repo list
rl repo use romeo              # default when outside registered repositories
rl --repo romeo list           # inspect another repo without switching
```

Registration uses the repository name from `origin`, or the main checkout folder
name without an origin. An alias is optional: `rl repo add . --alias frontend`.
The previous `rl repo add frontend /path/to/repository` syntax still works.
Name collisions require a distinct alias.

`rl checkout [repository]` enters that repository's main checkout using shell
integration (or prints its path when run directly). With no name, it offers a
repository picker; a single registered repository is selected automatically.
It preserves Git branches and changes, and leaves the configured default alone.
Bare `rl` then offers workspaces for the repository you entered. `rl status` shows
the selected repository, how it was selected, its base, workspaces and saved session
counts. Use `rl status --workspace` for the detailed current-workspace view;
`--json` follows the selected view.

Repositories are registered explicitly; RL does not scan siblings. Command selection
uses `--repo`, then `RL_REPO`, the current registered worktree, and the registry
default. An explicit `RL_REPO` override still applies after changing directories.
Removing a repository registration retains all worktrees and state.

| Environment setting | Default |
| --- | --- |
| `RL_WORKTREE_DIR` | `$HOME/.rl/worktrees` |
| `RL_STATE_DIR` | `$HOME/.rl/instances` |
| `RL_REPO` | Optional repository alias |
| `RL_PR_OFFLINE` | Set to `1` to disable PR queries |

Environment variables can also come from trusted zsh configuration selected by
`RL_CONFIG`, defaulting to `~/.config/rl/config.zsh`. See
[config.example.zsh](config.example.zsh). Registration supplies repository/base
settings; `rl help` and individual `--help` show command options.

## Compatibility aliases

Existing commands keep their behavior. They are omitted from the main help to
keep one primary spelling for each operation:

| Previous command | Primary command |
| --- | --- |
| `rl step commit/rebase/squash`, `rl diff/log/merge` | `rl git commit/rebase/squash/diff/log/merge` |
| `rl context/progress show/set/append/path` | `rl notes show/set/append/path context/progress` |
| `rl summary` | `rl notes summary` |
| `rl session list/save/add` | `rl agent sessions/save` |
| `rl handoff`, `rl mcp` | `rl agent handoff`, `rl agent mcp` |
| `rl clean` | `rl storage clean` |
| `rl config init/show`, `rl adopt`, `rl init` | `rl setup init/show`, `rl setup adopt`, `rl setup shell` |
| `rl status --list`, `rl status --all` | `rl list`, `rl list --all` |

## Development

```sh
npm ci
npm run build
npm test
npm run format:check
npm pack --dry-run
```

To install an unpublished checkout after building it, run `npm install --global .`
from that checkout.

Strict TypeScript modules share Store, Git execution, workspace resolution, and
agent adapters. Tests use isolated temporary repositories, representative hook
payloads, stub agents/GitHub, and a real offline tarball installation. They do
not modify your global install or launch paid sessions. `npm test` includes
package and shell smoke checks. No npm install script runs application setup.

Issues and pull requests are welcome. Include reproduction steps and validation.
Licensed under [MIT](LICENSE).
