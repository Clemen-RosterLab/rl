# rl

Git workspaces for Codex, Claude Code and Antigravity (`agy`).

Create a workspace, start an agent, and keep task notes and sessions together.
Switch projects, prepare local dependencies, check PRs, and merge finished work
without losing your place.

Requires macOS or Linux and Node.js 22+. `rl setup install` sets up Git,
zsh, fzf, GitHub CLI and integration for your zsh or bash terminal.

## Install

Install from npm and run the one-time setup:

```sh
npm install --global rl-workspaces
rl setup install
```

See Development below to build and try unpublished changes.

`rl setup install` installs missing tools through your package manager, preserves
your shell settings, and registers one RL integration block. Open a new terminal
afterward; bare `rl` can then select a workspace and change directory.
For the terminal that ran setup, use the activation command printed by
`rl setup install`, or:

```sh
eval "$(command rl setup shell zsh)"
# or
eval "$(command rl setup shell bash)"
```

This activates the setup already registered for future terminals. Shell
integration is what lets `rl` change the calling terminal's directory; an
executable by itself can only print the selected path. The integration loads
the current runtime on each call, including after npm or Node upgrades.

Tool installation needs Homebrew on macOS, or Homebrew/APT/DNF/Yum/Pacman/APK
on Linux, with permission to install packages. `rl setup dependencies --check`
checks tools without changing them. GitHub PR commands require `gh auth login`.

If setup cannot finish, resolve the reported issue and run `rl setup install`
again. Agent commands also need your chosen Codex, Claude or Antigravity CLI
installed and signed in.

If npm reports `EACCES` or permission denied for its global directory, install
into a directory you own:

```sh
npm install --global rl-workspaces --prefix "$HOME/.local"
"$HOME/.local/bin/rl" setup install
```

Open a new terminal afterward, or use the absolute activation command printed
by the installer for the current terminal.

## Get started

```sh
rl repo add . --base origin/test
rl switch feature/login -c --agent codex
# or: rl switch feature/login -c --agent claude
# or: rl switch feature/login -c --agent agy

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
| `rl sync` | Fetch and merge each active workspace's base into its branch |
| `rl delete` | Remove workspaces |
| `rl storage` | Inspect workspace disk usage |
| `rl clean` | Clean generated files from selected worktrees |

`rl switch <branch>` opens an existing checkout or creates a managed workspace
for an existing local or origin branch. Remote branches are tracked automatically.
`rl switch -c <branch>` creates a feature workspace from the configured base and
refuses an already checked-out branch. Both use nested branch names as directory
paths. Switching installs hooks and preserves existing notes. A checkout that RL
adopts outside its usual worktree folder also appears in the open picker and can
be selected by directory name or branch. Unadopted outside checkouts stay hidden;
the delete picker remains restricted to the managed worktree folder.

`rl help path` documents printing workspace paths, and `rl help exec` describes
running a command with a workspace's configured environment.

Pickers show cached PR state, commits ahead/behind the base, and recent use.
The `COMMITS + / −` column counts commits ahead/behind, rather than changed lines.
The picker compares with its displayed base; the status overview compares with the
displayed upstream. `CHANGES` reports changed files separately.
PR discovery uses `gh`; `RL_PR_OFFLINE=1` disables it. Status is offline by default.
`--fetch` explicitly refreshes tracking refs.

## Sync workspace branches

```sh
rl sync                       # sync all active RL workspaces in this repository
rl sync --dry-run             # fetch and preview; leave branches and working files unchanged
rl sync feature/login other   # sync only these workspace names or branches
```

Sync fetches each configured remote once, then merges every workspace's saved
base into that workspace's branch. If no base was saved, it uses the repository
default. Unqualified bases such as `test` prefer the fetched `origin/test`;
explicit local bases such as `refs/heads/parent-feature` stay local. Local stacked
bases run before their dependent branches.

Only active RL workspaces in the selected repository are included. The main
checkout, archived instances and unadopted branches are excluded. Dirty, locked,
missing and busy worktrees are skipped. A fetch failure stops all merges.
Conflicting merges are aborted to leave that branch unchanged, and independent
workspaces continue. The final summary lists updated, current, conflicted, skipped
and failed branches; `--json` supplies structured results and conflicting files.
Sync creates local merge commits when needed. Push the resulting branches when
ready; `rl pr update` separately updates PR branches through GitHub.

## Human review across worktrees

```sh
rl review                                # live three-panel review of the current worktree
rl review --all                          # choose from the worktree review queue
rl review --since HEAD~3                 # cumulative revision → HEAD comparison
rl review --pr 9935                      # discover and inspect a GitHub PR
rl review feature/login                  # inspect one worktree without switching directories
rl review feature/login --base origin/test # choose a baseline for an older worktree
rl review feature/login --diff           # complete feature diff, including committed changes
rl review feature/login --summary --provider claude
rl review feature/login --checkpoint --label "First pass"
rl feedback feature/login --message "Reuse the existing helper and add a regression test." --resume
rl review feature/login --since-last-review
rl review feature/login --approve
```

The queue prioritises outstanding review work. It shows branch/source changes,
review state, changes since the last checkpoint, cached PR state, and observed
agent activity. Use `--filter all|needs-review|changed|clean|active|ready` to narrow
it. `active` means recently observed working through hooks, not verified process
liveness. A stopped agent turn is not assumed to mean a completed feature.
Coding agents can explicitly mark the current source with `rl review --ready`;
that readiness expires when its source or staged versions change.

`rl review` stays in the current Ghostty or other ANSI terminal. It resolves the
current Git checkout against the selected RL repository, without consulting a
remembered agent directory. An explicit worktree name selects that instance.
The interface stacks commits, files and working-tree changes in a left sidebar,
with a wider, independently scrollable diff on the right. Charcoal and slate
surfaces, pale blue selections, green additions and red deletions follow the
review palette. Below 85 columns, the focused panel takes the full width. Node's terminal APIs
keep the CLI dependency-light; no React, browser, server or extra TUI executable
is needed for single-worktree review.

Use `1`/`2`/`3` and Tab/Shift-Tab to focus panels; `j`/`k` or arrows navigate;
Click commits, files, working-tree entries or footer actions to select them.
Use the commit checkboxes or press Space in the commits panel to select several
commits. The file list shows each selected commit’s patch under its commit SHA.
Click a commit title to return to a single commit.
The mouse wheel scrolls the panel under the pointer; over a file diff it scrolls
only that file, three lines at a time; rapid trackpad events are rate-limited.
Sidebar wheel navigation stays at one entry per step. Scrolling commits browses
the timeline without changing the selected commit or diff; click a commit to
inspect it. The
selected file stays highlighted while the diff has focus. Each file remembers
its scroll position. Enter advances focus;
in the diff, Enter or the clickable `[Expand]` control opens a full-width file
view. `[Back]` or Escape restores the sidebar. PageUp/PageDown scroll by a page,
Home/End jump to the start/end. Click the scrollbar track to jump, or click and
hold the thumb to drag it; scrolling continues with the pointer outside the bar
until you release the button. In the diff,
Left/Right or Shift+wheel scroll horizontally. `w` selects staged, unstaged and
untracked layers; `p` compares the committed branch with its target merge-base;
`r` accepts `FROM TO` revisions. Initial commits compare against the empty tree;
merge commits compare with their first parent. The timeline includes the latest
10 commits, loaded with their statistics in one Git call. `/` searches file paths in the files panel and text in the selected
diff; `n`/`N` jump between matches. `o` opens the captured Git version and source
line with `code --goto`, including historical or PR-only files. These cached
copies are read-only; `O` opens the current worktree file instead. `?` shows help
and `q` quits.

Drag across preview text to select it, then press `y` or Ctrl-C to copy it to
the clipboard using the terminal's [OSC 52 protocol](https://ghostty.org/docs/vt/osc/52).
Escape clears the selection. Selected text retains its displayed version while
live changes are detected; the status shows when a newer diff is available.
Clearing the selection loads that latest diff. Ctrl-C quits when no text is selected.

Drag the vertical divider to resize the sidebar and preview, or press `-`/`+`
to shrink/grow the sidebar by four columns. `=` restores the default width.
The width is saved for this worktree and adapts to terminal resizing.
In an expanded preview, Tab/Shift-Tab and `]`/`[` move to the next/previous file
without collapsing it. Arrows and `j`/`k` scroll, PageUp/PageDown page, and
Home/End jump to the start/end. Each file retains its scroll position. Enter
or Escape restores the sidebar; `1`/`2` focus commits/files.

Tests, styles and common boilerplate are hidden by default across working-tree,
commit, range and branch/PR views. Press `T` or click `[Filters]` to choose which
categories to hide independently. Click a checkbox, use arrows/`j`/`k` then
Space/Enter, or press `1`–`5` to toggle a category. Dependency lockfiles and
generated artifacts have independent overrides. `h` edits comma-separated hide
globs; `i` edits always-show exceptions. Patterns match repository-relative
paths: `**/vendor/**`, `docs/`, `**/*.test.ts`. Always-show rules take priority.
`w` sets preview wheel speed from 1 to 20 lines, saved for this worktree.
`a` hides all categories,
`n` shows all, `d` restores defaults, and Escape/`T` closes the menu. Choices
are saved immediately in RL's local metadata for this worktree and apply to
later review sessions, including other branches or PRs in that same worktree.

Press `t` or click `[t Focus: N hidden]` to temporarily show all files; press
`t` again to restore your configured filters. The header counts hidden
file layers. The naming rules recognise test/spec files, test directories,
snapshots, CSS/SCSS/Sass/Less/Stylus styles, CSS-in-TS, dependency lockfiles,
generated artifacts, source maps and minified JavaScript. Ordinary source,
entry points, configuration and handwritten type declarations remain visible.
This is path filtering, not semantic ranking. The temporary show-all toggle
lasts for the current review session. Filtering preserves the selected source
file and its scroll and does not change commits, snapshots or review checkpoints.

Press `v` to toggle the displayed file reviewed; `u`/`U` jumps to the next/previous
unreviewed file. Marks retain both reviewed blob identities, so unrelated edits
preserve them and a change to either side resets them. Progress is local to this
worktree and branch/explicit PR. A dot marks a file changed since it was last
viewed. `d` compares its last-viewed target tree with its current target; the
saved version is retained across Git GC. Leaving a file records the viewed
version. These per-file marks do not approve a PR or advance the `m` checkpoint.

`{`/`}` jumps between hunks. Old/new line gutters identify source positions.
`C` cycles 3, 12 and 40 context lines. `c` toggles complete file context and `e`
switches before/after versions. `b` opens a clickable, keyboard-navigable
base/target revision picker; its direction is always base → target.

In the `/` search prompt, Tab/Shift-Tab selects the scope: current diff, visible
file paths, changed lines across visible files, or complete reviewed files.
Ctrl-F starts cross-file changed-line search directly. Results are clickable
and open the corresponding version and line. Search is plain text, bounded to
200 file layers, 100 hits and 16 MiB; incomplete results are labelled.

`L` applies logic-first ordering with reasons above the preview. This is a
text heuristic by default; an optional compatible TypeScript compiler API adds
syntax evidence when available. It does not claim semantic references. `A`
explicitly chooses Codex, Claude or Antigravity for read-only agent ranking of
up to 60 captured patches. This can use provider quota; it never runs
automatically. Ctrl-G cancels agent analysis. Live updates keep the chosen
order stable, label stale rankings and append newly seen files; press `L` to
refresh stale rankings or restore Git order when the ranking is current.

Local directory events are debounced for 180 ms, with a 2.5-second Git/status
polling fallback. Worktree-specific HEAD/index and shared refs are watched
separately. Source watching uses Git-listed directories and skips dependencies
and build caches. Git runs in a background process that Quit can stop. Immutable commit metadata and
recent patches are cached, file patches load lazily and only changed terminal
rows are drawn. Diff display is capped at 8 MiB per file with an explicit
truncation notice. A live update keeps the selected commit/file and scroll where
possible and increments the visible update counter.

Quit cancels background Git and GitHub reads, disables mouse reporting and
drains in-flight terminal input before returning control to the shell. Terminal
attributes are saved and restored explicitly; the previous shell screen is
revealed only after input is ready. Starting review also repairs inherited raw
or no-echo input left by a crashed terminal application. A
checkpoint save already in progress gets a bounded grace period; if it needs
longer, its isolated worker completes the atomic save after terminal handoff.
Private freeze-ref cleanup also retries independently when Git is too slow
for the terminal handoff deadline.

Press `f` to freeze the captured source/index trees. Temporary private
`refs/rl/live-freeze` refs retain them across Git GC and are removed on unfreeze
or normal exit. The entire displayed local
state stays fixed while a NEW CHANGES indicator reports background updates;
unfreezing loads the latest snapshot. Press `m` to retain the exact inspected
target as a review checkpoint, then `s` to compare its source and index with the
current snapshot. These live checkpoints are scoped to worktree and branch (and
explicit PR number), retained under private `refs/rl/live-review` refs across Git
GC, and stored in the existing repository state directory under `live-review`.
For registered RL instances, new marks also appear in `--checkpoints` and the
review queue. Command checkpoints update the live comparison checkpoint too;
`s` can import an existing command checkpoint. Marking reviewed does not submit
or grant an approval.
Missing checkpoints are errors; rewritten history compares the saved trees with
an explicit notice. No branch checkout, staging, commit or file edit occurs.

`gh` discovers PR metadata in the background. Authentication/network failures
leave local review usable. PR metadata polls independently every 60 seconds;
`--remote-interval <seconds>` changes this (minimum 10), and Ctrl-R refreshes
both sources. Explicit `--pr` downloads missing commit objects into private
`refs/rl/live-pr` refs, without changing HEAD, FETCH_HEAD or remote-tracking
branches. Automatic discovery downloads nothing. Branch comparison uses the PR
target when known, otherwise the configured RL default base; an unavailable
base produces an error so a revision range can be chosen explicitly.

`--all` uses RL's fzf worktree queue: Enter launches live review, Alt-S opens its
summary, Alt-D its feature diff, Alt-F feedback, Alt-A approval, Alt-O VS Code,
and Ctrl-R refreshes the queue. `--interactive` preserves legacy pickers for
scripted input. Noninteractive `rl review` prints the queue; `--json` supplies
structured records. `--since <revision> --json` and `--pr <number> --json` inspect
the current worktree without a terminal. Existing workspace, session, workflow
and GitHub PR commands remain independent.

New feature branches created with `rl switch -c` store their starting commit and
pin a fixed review baseline. Advancing or deleting the base branch does not
silently move that baseline. Older/adopted worktrees show **Baseline required**
until you explicitly choose `--base <ref>` or use the baseline action. The chosen
reference's merge-base with HEAD is recorded. No shared ancestor is an error;
rewritten history keeps the original baseline and displays a warning.

Review snapshots capture HEAD, the staged index, conflict stages and working
source, including relevant non-ignored untracked files. They use temporary Git
indexes and Git tree objects, preserving your real index, working files, stash
and branch history. Git attributes/clean filters apply as with ordinary Git
staging. Captures are repeated to detect moving source. Snapshots with unresolved
conflicts, unstable captures, or omitted source cannot be approved. Ignored files
are not included; untracked credential/agent metadata, dependency trees and files
above 16 MiB are explicitly excluded and reported, so an incomplete capture
cannot become a complete review checkpoint. Track or ignore such paths explicitly
before approval.
Uncommitted submodule contents are refused with an actionable error: a parent
Git tree can retain the submodule commit pointer, but not its nested working files.

`--checkpoint` records the exact inspected source and staged versions; `--checkpoints`
lists them. `--since-last-review` and `--since <checkpoint UUID>` compare immutable
trees, including edits to uncommitted files, changed staging and untracked files.
Approval is explicit, creates a checkpoint, and is valid only while its source
fingerprint still matches. Further changes show **Changed since review**.
AI analyses never create human approvals or advance checkpoints. All review
state, analysis and feedback live beside the existing instance notes and
sessions. Private `refs/rl/reviews`, `refs/rl/review-heads` and
`refs/rl/review-baselines` and `refs/rl/review-snapshot-bases` retain their objects
through Git GC. This local history is retained with RL state; ordinary branch
pushes do not publish these refs.

`--summary`, `--ai-review` and `--groups` use the editable RL `reviewer` profile
and review policy. Override the profile with `--profile`, or the provider with
`--provider codex|claude|agy`. Each analysis uses a fresh session, a bounded context
from its saved Git trees, changed source and recorded notes. Summaries cover
implementation, architecture, behaviour, tests and concerns. Source facts and
agent-reported claims are labelled separately; this command does not run tests
or claim that recorded validation still passes. Provider/credential errors fall
back to manual evidence for summaries, and `--no-ai` invokes no model. Codex runs
read-only; Claude analysis has built-in and MCP tools disabled; Antigravity uses
plan mode and structured streaming output. No permission
bypass flags are used.

Logical groups reference validated Git file/hunk IDs, can overlap across files,
and keep uncertain changes uncategorised. Their patches always come from Git.
The complete feature diff remains available through Git's normal pager. An
optional `--lazygit` opens the **live working-tree view**, which is not equivalent
to the complete feature or checkpoint diff; missing Lazygit falls back to Git
with an installation hint. `--open` uses VS Code's `code` command.

Feedback is persisted before any agent launch. Use `--message`, `--file <path>`,
`--file -` for stdin, or VISUAL/EDITOR in a terminal. Without a delivery action,
it stays saved and appears in that worktree's normal agent hook/MCP context.
`--resume` opens its coding session with the feedback available as a prompt;
**opened** does not mean delivery was acknowledged. `--send` explicitly runs a
noninteractive correction turn and reports **delivered** only after successful
completion. Saved sessions are checked against the selected worktree; multiple
sessions require a picker or explicit `--agent`/`--session`. A recently observed
working session is not sent a competing turn. Failed attempts retain their text
and error; use `rl feedback <worktree> --list` and `--retry <feedback UUID>` to
resume or send later. Starting an agent and associating a session still uses the
existing `rl agent start` and `rl agent save` commands.

The implementation follows the official [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Git temporary-index](https://git-scm.com/docs/git-read-tree) mechanisms.

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

`rl storage` measures the current adopted RL workspace. `rl clean` removes
generated files from selected RL worktrees in the selected repository:

```sh
rl storage                 # disk usage, largest paths, and cleanup suggestions
rl storage --json          # structured usage report
rl clean                   # multi-select worktrees: Tab to select, Ctrl-A for all
rl clean --all             # clean every RL worktree in this repository
rl clean one feature/two   # clean only these worktree names or branches
rl clean --all --dry-run   # preview generated paths and estimated savings
```

By default, cleanup targets ignored dependency directories such as `node_modules`
and `.venv`, plus known build, cache and temporary directories such as `.next`,
`.turbo`, `.cache`, `dist` and `tmp`. Main checkouts and unadopted worktrees outside
RL's managed directory are excluded. `--all` stays within one repository; select
another explicitly with `rl --repo <alias> clean --all`.

Override the defaults with a `clean` array in each worktree's `.rl/workflows.json`:

```json
{ "clean": ["node_modules", ".next", ".turbo"] }
```

An explicit empty array disables cleanup for that worktree. Entries must be
literal, ignored directory paths. Nested artifact directories can be listed
explicitly, for example `apps/web/.next`.

Cleanup validates the complete plan before deleting anything and refuses tracked
files, credentials such as `.env`, Git/agent/task metadata, and symlink targets.
Links inside generated directories are unlinked without traversing their targets.
Code changes, branches, notes, sessions, and task handoffs stay in place. Results
include each worktree and an estimated total; `--json` provides structured output.
Locked or unsafe targets are reported while other selected worktrees continue.
Close development servers before cleaning their dependencies; use your project's install
and build commands to regenerate them later.

Storage reports approximate allocated sizes, deduplicating hard links within the
workspace. Cleanup estimates exclude hard-linked file data retained outside the
selected directories; filesystem clones and snapshots can also reduce actual
savings. Suggestions use the current workspace's last-access time (14 days by
default, configurable with `--older-than 30d`) and its cached PR state. Nothing is
deleted automatically. The older `rl storage clean` command still operates only
on the current adopted workspace and requires an explicit configured clean list.

## Finish a feature

Use Git directly to inspect changes, commit, rebase, or squash feature history.
RL handles merging across checkouts and removing the finished workspace:

```sh
rl git merge test --dry-run
rl git merge test --cleanup
```

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

Opening, refreshing, and checkout require authenticated `gh`. Use `gh pr checks`
to inspect CI results. Checkout verifies the origin repository,
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
rl agent start agy
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
`claude --print` or `agy --print`. RL leaves permissions and authentication to the agent.

`rl resume` lists saved Codex and Claude sessions for the current RL workspace.
If multiple sessions match, an `fzf` picker shows the agent, full session UUID,
last-used time, and start time, with the most recently used first. If exactly
one session matches, it resumes automatically. An optional `codex`, `claude` or `agy`
argument filters the choices. Escape cancels without launching an agent.
Use `--latest` (or `-l` / `--l`) to skip the picker and resume the most recently
used matching session directly.
`rl continue` still resumes the exact session saved in its task handoff.

Run Codex normally in an adopted RL workspace, including in the Codex app.
`rl status`, `rl list`, `rl agent sessions`, and `rl resume` / `rl resume codex`
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

| Integration | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| Interactive / headless launch | `codex` / `codex exec` | `claude` / `claude --print` | `agy` / `agy --print` |
| Resume | `codex resume <UUID>` | `claude --resume <UUID>` | `agy --conversation <UUID>` |
| Project hooks | `.codex/hooks.json` | `.claude/settings.local.json` | `.agents/hooks.json` |
| Lifecycle | SessionStart, UserPromptSubmit, Stop, SessionEnd, SubagentStart, SubagentStop | Same | SessionStart, PreInvocation, PreToolUse, PostToolUse, Stop |
| Optional extended hooks | Interrupt | StopFailure, Notification | None |

For Antigravity, run `rl setup adopt` once in an existing worktree, then start
`agy` normally or use `rl agent start agy`. Its native hooks save conversation
UUIDs automatically, so `rl resume agy` uses the same picker and `--latest`
option as the other providers. An explicit `rl agent save agy <UUID>` also works.
`rl doctor agy` checks its installed hooks and CLI help. Multi-root Antigravity
hook payloads are refused because they cannot identify one owning RL worktree.
Foreground stops with background work still running remain observed working.
When using the native writer/reviewer/DRY workflow, bind each peer's actual
Antigravity conversation UUID before implementation. RL uses the saved binding
to keep peers separate from the parent session and prevent recursive workflows.

Antigravity uses its documented named hook definitions, camelCase input and
`injectSteps`/decision responses; RL preserves unrelated definitions. Feedback
can resume with `--prompt-interactive`, or send one structured streaming turn to
the saved conversation. Successful delivery requires a successful result for
that exact conversation, rather than merely a zero process exit code.

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

## Session-driven agent workflows

An adopted workspace has a built-in `writer-reviewer-dry` workflow immediately,
without creating configuration files. Your current Codex, Claude or Antigravity session
creates and controls its native children. RL supplies their editable roles,
handoff rules, review policy and durable run records. RL never launches a
provider CLI, model API or check process for a workflow.

Use your normal agent session in the workspace. RL's hooks advertise discovery
automatically; a special launcher or pasted workflow prompt is unnecessary.
An agent can run `rl workflow context --json` through its ordinary shell tool.
The response includes active definitions plus `protocol.tools`: each operation's
input schema, CLI command, positional/flag mappings and JSON stdin requirements.
The same schemas are advertised through MCP, so an agent can use either connection.
Native subagent support still comes from the current session's host.

The default team starts together and stays available for the task:

- **Writer** implements scoped changes. Before adding a function, it asks DRY
  about existing implementations and waits for the answer. It submits stable
  file groups to the reviewer, then fixes and resubmits rejected work.
- **Reviewer** stays read-only, reviews writer checkpoints and returns a rating
  with evidence and actionable feedback. On suspected duplication it asks the
  same DRY agent before returning its review.
- **DRY** stays read-only and serves both peers, returning paths, symbols,
  behavioral differences and reuse options, or explicitly reporting that no
  suitable implementation was found.

Submitted files stay frozen while awaiting review; the writer can work on
unrelated files meanwhile. Ratings apply to saved file contents and staged
versions. RL rejects changed or superseded checkpoints and requires current
accepted reviews for the writer's changes before completion. The defaults are
**90/100** and at most **five review rounds** per file group. Required fixes
and incomplete coverage block acceptance regardless of rating. Pending check
requests or routing leads must be resolved before a checkpoint can be accepted.

```sh
rl workflow context --json           # discover active definitions and their source
rl agent list
rl agent show writer
rl policy show review
rl workflow init                     # write editable copies and refresh workspace hooks
rl agent set writer --instructions writer.md
rl workflow set writer-reviewer-dry --file workflow.json --default
rl workflow status                   # latest saved run and checkpoint ratings
rl workflow metrics
```

Export a definition before editing it:
`rl workflow show writer-reviewer-dry --json > workflow.json`.
`agent set --instructions` preserves the profile's other settings. Complete
profiles can be saved with `rl agent set writer --file profile.json`.
Use `rl agent add` and `rl workflow add` to create additional definitions.

Configuration stays in this worktree. The three concerns remain separate:

| File | Owns |
| --- | --- |
| `.rl/agents.json` | Roles: description, instructions, optional model/reasoning and access preferences; provider defaults to inherit |
| `.rl/agent-workflows.json` | Default workflow, triggers, dependencies, concurrency, retries, deadlines, collaboration routes and review rounds |
| `.rl/policies.json` | Review criteria, rating scale/threshold, severity deduction weights and acceptance requirements |

Each file has `"version": 1` and a named `agents`, `workflows` or `policies` map.
The workflow file also accepts `"default": "writer-reviewer-dry"`; use
`workflow add/set --default` to select a different default. Existing explicit
configurations are preserved, including workspaces with partial legacy settings.
A missing file uses built-in definitions, which
are active for automatic triggers too. Run `workflow init` only when you want
editable copies and none of the three files exists yet.

The default workflow's `collaboration` section is editable:

```json
{
  "writer": "writer",
  "reviewer": "reviewer",
  "dry": "dry",
  "maxRounds": 5,
  "rules": [
    { "from": "writer", "event": "new_function", "to": "dry", "required": true },
    { "from": "reviewer", "event": "suspected_duplicate", "to": "dry", "required": true }
  ]
}
```

These names refer to step IDs. All three collaboration steps must be ready at
startup with concurrency at least three; reviewer and DRY must be read-only.
Change routes, requirements, review rounds, triggers and profiles as needed.
Required gates support writer `new_function` and reviewer `suspected_duplicate`;
additional event routes can be added with `required: false` for optional messaging.
Other workflows can use sequential/parallel dependencies and parent-run command
steps without collaboration. A writing stage runs exclusively in those workflows;
explicit dependency results are shared and independent reviews remain isolated.

The separate policy has a `rating` object with `min`, `max`, `minimum` and
`instructions`. Agents use that rubric to rate checkpoints. RL also calculates
a separate score from findings: the default deducts 50/20/10/2 for
critical/high/medium/low findings, deduplicates exact file/line/root-cause matches,
and blocks readiness on required fixes or coverage gaps. `rl workflow score`
rescores saved evidence without agent calls. Native model/reasoning settings are
preferences applied by the parent where supported; unsupported settings must be
reported. Provider preferences never authorize another provider process.

Session-start hooks identify the active configuration and teach the parent the
protocol. Prompt hooks refresh it after configuration changes and compaction.
The default queues the team at the parent's `task_planned` coding milestone or
before its first edit. Before-edit/tool rules deny the pending tool until their
request completes, is explicitly dismissed or its run is cancelled. Coordination
tools are excluded from this gate. Child hooks do not recursively queue teams.
Normal session resume and task checkpoints remain independent.

Automatic events are `session_start`, `prompt`, `before_edit`, `after_edit`,
`before_tool`, `after_tool` and `before_finish`. Edit events recognize
Edit/Write/MultiEdit/apply_patch; other tools, including shell commands, use the
tool events. `tools` matches exact hook tool names; `paths` matches workspace
relative paths with `*` and `**`. Path filtering reads structured edit paths
and patch headers, without guessing about shell commands. `changes: true`
requires changes in the local comparison scope. Semantic events such as
`task_planned` are reported by the parent, since RL cannot observe private
reasoning. All conditions on a rule must match; multiple rules are alternatives.

Matching requests belong to that parent conversation only. Identical
scope/configuration events are deduplicated; newer changes coalesce into an
unclaimed request. Before-finish hooks can continue the turn once, guarding
against repeated Stop-hook loops. If native delegation is unavailable or
disallowed, the session must dismiss the request with its concrete reason and
report that limitation. Current permissions and workspace boundaries apply to
every child. Host permissions are enforced by the host.

The MCP server (`rl agent mcp`) exposes:

| Tool | Purpose |
| --- | --- |
| `rl_workflow_context` | Discover roles, workflows, triggers, policies and configuration source |
| `rl_workflow_pending` | Read this parent's queued requests |
| `rl_workflow_event` | Report a milestone and match trigger rules |
| `rl_workflow_start` | Prepare a session-owned run, optionally from a request |
| `rl_workflow_claim` | Claim a ready step and receive its prompt, scope, result schema and native settings |
| `rl_workflow_report` | Return final evidence, actual check output or failure with the claim token |
| `rl_workflow_dismiss` | Decline a queued request with a recorded reason |
| `rl_workflow_bind` | Bind a claimed role to its unique native child ID |
| `rl_workflow_inbox` | Read that role's consultations, submissions, ratings and peer handles |
| `rl_workflow_consult` | Ask an existing peer through a configured route |
| `rl_workflow_answer` | Answer a consultation addressed to that role |
| `rl_workflow_submit` | Submit a writer checkpoint and declare new functions as path#function subjects |
| `rl_workflow_review` | Return a rating, rationale, evidence and declared duplicate suspicions |

The parent claims, spawns and binds all three peers, then announces readiness.
Handoff tools return a `notify` destination with the peer's native handle. The
caller delivers it through native messaging or asks the parent to relay it.
RL persists the handoff; it cannot wake native children on its own. Peers use
native wait/messaging tools while idle. Finish the writer first, then reviewer,
then DRY, reporting final evidence through `rl_workflow_report`.

RL verifies answered consultations for declared new functions and duplicate
suspicions. Identifying those semantic events and declaring them honestly is
the agents' responsibility; RL cannot independently prove that every new
function was declared.

Supply `agent` and the parent's full `sessionId`; Codex may infer its ID from
the environment, while Claude supplies its UUID explicitly. Observed Codex
`thr_` IDs also coordinate workflows, but never enter UUID-based resumable
history. These are local coordination identities, not an authentication boundary
against a process that already has access to the state files.

CLI equivalents are available without an MCP connection:

```sh
rl workflow pending --agent claude --session <UUID>
rl workflow event --file event.json --agent claude --session <UUID>
rl workflow run --request <request-UUID> --agent claude --session <UUID>
rl workflow claim <run> --step writer --agent claude --session <UUID>
rl workflow bind <run> --file binding.json --agent claude --session <UUID>
rl workflow inbox <run> --step writer --claim <token> --agent claude --session <UUID>
rl workflow report <run> --file report.json --agent claude --session <UUID>
```

An event file contains `{ "event": "task_planned" }`. Binding files contain
`step`, `claim` and `childId`. CLI equivalents for `consult`, `answer`,
`submit` and `review` take `--file` with the same tool fields. Each role's
prompt supplies its claim token and parent conversation identity. Final reports
contain `step`, `claim` and `result` (the supplied schema), or an actual
`check` result or `error`. Reports may include native `childId` and token/cost
usage. `workflow run` prepares work without spawning agents; `--dry-run`
previews the scope without creating a run.

Review scope includes committed branch changes from the merge-base, staged,
unstaged and non-ignored untracked changes, capped at 4 MiB. Bases use local refs
without fetching; event detection falls back to HEAD if the saved base is
unresolvable. Generic workflows validate whole-scope fingerprints; collaborative
reviews validate each saved file group while implementation continues. Initial
unrelated dirty files need no submission unless changed during the run. RL
refreshes the whole scope when the writer closes and verifies it for remaining
final reports. Earlier checks/reviews in generic workflows remain historical
after writing; place final validation after the writer. Failed checks block
dependents. Reported failures can be retried within the configured budget.
Generic routing leads receive one focused follow-up; further leads remain
limitations. Collaborative peers handle consultations without replacement stages.

`workflow pause` stops new claims and submissions but lets claimed children
report and finish pending answers/reviews. The parent owns child cancellation.
`workflow resume` lets collaborative peers continue with the same claims and
native handles. Generic workflows require running children to report first.
Cancellation rejects further results and requires a new run. Neither command
sends process signals. Run records retain the parent identity, native IDs,
claims, evidence, checkpoints and assessments under this instance's
`workflow-runs/` directory. RL measures claim-to-report elapsed time; token/cost
usage is parent-reported and missing totals remain unknown.

After upgrading existing workspaces, run `rl doctor --repair` to add tool hooks,
and restart/review hooks as required by your host. Automated tests exercise
hook payloads and MCP/CLI coordination; they do not certify live model compliance
or native delegation availability in every client.

## Let agents use notes through MCP

`rl agent mcp` serves workspace-scoped tools over stdio: `rl_status`, `rl_context`,
`rl_progress`, `rl_context_append`, `rl_progress_append`, `rl_session_save`,
`rl_task_pause`, and the thirteen `rl_workflow_*` coordination tools described above.
`rl_task_pause` accepts the handoff JSON described above and atomically saves
the session and task checkpoint. `rl_status` includes task state and handoff history.
`rl_status` automatically discovers Codex sessions for this workspace.
`rl_session_save` accepts `{"agent":"codex","sessionId":"<UUID>"}`;
`agent` defaults to Codex. If `sessionId` is omitted, it uses the MCP server's
Codex environment when available. Clients should pass their current UUID when
the server does not inherit it. Claude and Antigravity require an explicit UUID.
Append tools take `{"text":"..."}`. They share the same locked document updates
as the CLI and expose no arbitrary command, deletion, or filesystem tool.

From an adopted RL workspace, connect your current agent with:

```sh
rl setup mcp
```

This configures both `.codex/config.toml` and `.mcp.json` in the current checkout.
Pass `codex` or `claude` to select one client, or `--dry-run` to preview changes.
Use `rl setup mcp agy` for Antigravity's workspace-local `.agents/mcp_config.json`.
Its managed server name includes the RL instance UUID, preventing a server
already running for another worktree from taking precedence. Reconfiguring a
copied file replaces obsolete RL-managed entries while preserving other servers.
Setup preserves other servers and settings, including Codex comments. It updates
RL-managed entries on later runs and leaves a conflicting manually configured
`rl` entry for you to resolve. Both files are validated before writing either.

The client starts the installed Node and RL entry point directly. The server is
bound to this checkout, repository and RL state directory, even when the client
starts it elsewhere or has no `rl` executable on PATH. Entries contain local
installation/workspace paths: run setup in each checkout and rerun after moving
Node or RL. Setup changes only this workspace's configuration.

Reload the client and review its normal project trust/MCP approval. The server
supplies discovery, consultations and rated reviews to your existing session;
the host supplies native agent creation and messaging. CLI discovery remains
available without an MCP connection. The stdio server can also be launched with
`rl agent mcp`, or `rl agent mcp --workspace <absolute-path>` when the repository
has been selected explicitly. Configuration follows the official
[Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and
[Claude MCP guide](https://code.claude.com/docs/en/mcp).
Antigravity integration follows its official [hooks](https://antigravity.google/docs/hooks?tab=cli),
[MCP](https://antigravity.google/docs/mcp?tab=cli), and
[headless CLI](https://antigravity.google/docs/cli/headless) contracts.
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
rl repo add /path/to/frontend --base origin/test
rl repo add /path/to/backend --base origin/test
# Or run `rl repo add .` inside each repository.
rl checkout frontend
rl                            # pick a frontend workspace
rl checkout backend
rl checkout                   # pick a repository
rl repo list
rl repo use backend            # default when outside registered repositories
rl --repo backend list         # inspect another repo without switching
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
Without registered repositories or an explicit `RL_REPO_ROOT`, RL detects the
main checkout of the current Git repository, including from linked worktrees
and subdirectories.

| Environment setting | Default |
| --- | --- |
| `RL_WORKTREE_DIR` | `$HOME/.rl/worktrees` |
| `RL_STATE_DIR` | `$HOME/.rl/instances` |
| `RL_REPO` | Optional repository alias |
| `RL_PR_OFFLINE` | Set to `1` to disable PR queries |

Defaults can also come from declarative configuration selected by `RL_CONFIG`,
defaulting to `~/.config/rl/config.toml` (or `config.json`). See
[config.example.toml](config.example.toml). Registration supplies repository/base
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
package and shell smoke checks. Local `npm ci` leaves system tools and shell
settings untouched; project dependency installation is explicit with `rl setup run`.

Issues and pull requests are welcome. Include reproduction steps and validation.
Licensed under [MIT](LICENSE).
