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
eval "$(command rl init zsh)"   # ~/.zshrc
# or
eval "$(command rl init bash)"  # ~/.bashrc
```

Shell integration lets `rl` change your terminal's directory. Direct executable
calls print the selected path. The integration loads the current runtime on
each call, so an npm upgrade does not leave you using old commands.

## Get started

```sh
rl repo add my-project /absolute/path/to/my-project --base origin/test
rl switch feature/login -c --agent codex
# or: rl switch feature/login -c --agent claude

rl progress append implementation-notes.md
rl list
rl switch @                   # main checkout
rl switch -                   # previous workspace in this shell
rl switch feature/login
rl resume codex
```

The default base is `origin/test`. Use `--base`, `RL_DEFAULT_BASE`, or a registered
repository's base setting to choose another branch. Creation fetches origin when present;
add `--no-fetch` to work offline. Notes and session links survive workspace deletion.

## Workspace commands

| Command | Use |
| --- | --- |
| `rl` | Pick a workspace with `fzf` |
| `rl switch <name|branch> [-c]` | Open a workspace; `-c` creates one |
| `rl switch @` / `rl switch -` | Main checkout / previous workspace |
| `rl switch <name> --agent codex\|claude` | Open a workspace and start an agent |
| `rl new <branch> [--base ref]` | Create or reopen a branch workspace |
| `rl open -b <branch>` | Open a local or origin branch |
| `rl path [name|branch|@]` | Print a workspace path |
| `rl exec [--workspace name] -- <command> [args...]` | Run a command in a workspace |
| `rl list [--json]` | Branch status for this repository |
| `rl status --all [--fetch] [--json]` | Status across registered repositories |
| `rl adopt` | Register an existing worktree and install local agent hooks |

Switching installs hooks and preserves existing notes. Creation validates names
and refuses path escapes or an already checked-out branch. `switch -c` requires a
new checkout; `new` and `open` can reopen an existing checkout. `open` flattens
slashes in directory names; `new` and `switch -c` retain nested names.

Pickers show cached PR state, commits ahead/behind the base, and recent use.
PR discovery uses `gh`; `RL_PR_OFFLINE=1` disables it. Status is offline by default.
`--fetch` explicitly refreshes tracking refs.

## Project setup

```sh
rl config init
# Edit .rl/workflows.json in the main checkout.
rl setup --dry-run
rl setup
# Or: rl switch feature/login -c --setup
```

Example configuration:

```json
{
  "copy": [".env", ".cache"],
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

## Finish a feature

```sh
rl diff --base origin/main -- --stat
rl log --base origin/main -- --graph
rl step commit -m "Add login"         # staged changes
rl step commit --all -m "Fix login"   # tracked changes; untracked files require git add
rl step rebase --base origin/main
rl step squash --base origin/main -m "Add login"
rl merge main --dry-run
rl merge main --cleanup
```

Step commands also accept `--dry-run`. Rebase and squash require a clean
workspace. Squash preserves the original HEAD under a printed
`refs/rl/backups/<UUID>` ref; it rewrites local feature history without pushing.

Merge targets a checked-out local branch in the main or a managed checkout.
It requires clean source and target workspaces and defaults to fast-forward only.
For an explicit squash merge, use `rl merge main --squash -m "Add login"`.
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
rl pr sync                # save this branch's PR state
rl pr show                # show the saved snapshot
rl pr checks [--json]     # query checks and preserve gh's exit status
rl pr checkout 123        # new managed pr-123 workspace
rl pr checkout 123 --name review/login
```

PR commands require authenticated `gh`. Checkout verifies the origin repository,
PR identity, and fetched commit before creating a workspace. Fork PR checkout
is currently rejected. It does not change your current branch, publish, or merge
a PR. Failed refreshes retain the previous snapshot.

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
`task.handoffs` history, including after workspace deletion. `rl status` includes
the saved handoffs, and `rl list` adds a TASK column showing `paused` or `active`.

### Start and resume agents

```sh
rl agent start codex -- --model <model>
rl agent start claude
rl agent run codex --prompt "Review the change" -- --json
rl agent run claude --prompt "Review the change"
rl handoff claude --output handoff.md
rl resume codex
rl resume claude
rl session save codex     # from inside Codex, if needed
rl doctor
rl doctor --repair
```

Both launch modes preserve agent options after `--`, use the selected workspace,
and return the agent's exit status. Headless mode uses `codex exec` or
`claude --print`. RL leaves permissions and authentication to the agent.

Run Codex normally in an adopted RL workspace, including in the Codex app.
`rl status`, `rl list`, `rl instances`, `rl session list`, and `rl resume codex`
automatically discover and save matching sessions through Codex's
[`thread/list` API](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination--filters).
Discovery filters by the exact workspace directory, excludes subagents and
ephemeral sessions, and checks branch metadata and existing ownership. Without
branch metadata, only sessions created after workspace adoption are imported.
It reads metadata from Codex's state database, preserves newer saved usage times,
and leaves saved sessions available if Codex is missing or discovery fails.
Overview tables show saved session counts in the CODEX and CLAUDE columns.

An agent can also run `rl session save` (Codex by default) or
`rl session save codex`; this uses its `CODEX_THREAD_ID`, falling back to
`CODEX_SESSION_ID`. `rl session save <agent> <UUID>` and the existing
`rl session add <agent> <UUID>` explicitly save a particular conversation.
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

Run `rl adopt --extended-hooks` only with agent versions supporting those events.
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

## Let agents use notes through MCP

`rl mcp` serves workspace-scoped tools over stdio: `rl_status`, `rl_context`,
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
args = ["mcp"]
```

For Claude, merge this entry into the workspace's `.mcp.json`:

```json
{
  "mcpServers": {
    "rl": { "type": "stdio", "command": "rl", "args": ["mcp"] }
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
rl context show|path
rl progress show|path
rl context set feature-notes.md
rl progress append implementation-notes.md
printf 'Done: parser. Next: integration tests.\n' | rl progress append -
rl summary --stdout
rl summary --output feature-report.md
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
rl repo add frontend /path/to/frontend --base origin/main
rl repo add backend /path/to/backend --base origin/main
rl repo use frontend
rl --repo backend switch api-change -c
rl repo list
rl repo remove backend
```

Repositories are registered explicitly; RL does not scan siblings. Selection
uses `--repo`, then `RL_REPO`, the current registered worktree, and the registry
default. Removing an alias retains all worktrees and state.

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
