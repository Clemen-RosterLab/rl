# rl

Manage Git worktrees, project notes, and Codex or Claude sessions from your terminal.

Create a workspace for each feature, switch between them, and pick up where you
left off. RL keeps your notes and agent session links together and shows pull
request status across your workspaces.

Requires macOS or Linux, zsh, Git, and Node.js 22+. Install `fzf` for workspace
pickers, `gh` (signed in) for pull request status, and Codex or Claude to resume
their sessions.

## Install

```sh
npm install --global rl-workspaces
```

The first npm release is pending; this command will work once it is published.

Add this to `~/.zshrc` to switch directories when you open a workspace:

```zsh
eval "$(command rl init zsh)"
```

Restart your terminal, then register your project below.

## First workspace

Register your repository before creating a workspace:

```sh
rl repo add my-project /absolute/path/to/my-project --base origin/main
rl --repo my-project new feature/example
```

Use your repository's actual base branch in place of `origin/main`. Registration
makes it the default if it is the first repository.

## Multiple repositories

Register each repository explicitly. RL does not scan sibling directories:

```sh
rl repo add frontend /path/to/frontend --base origin/main
rl repo add backend /path/to/backend --base origin/main
rl repo list
rl repo use frontend

rl --repo backend new ROS-123
rl --repo frontend open -b feature/example
rl --repo backend delete old-task another-task
```

Repository selection follows this order: `--repo <alias>` before the command,
`RL_REPO` from the environment/config, the registered repository owning the current
Git worktree, the registry default, then the `RL_REPO_ROOT` configuration.
Inside a registered worktree or its subdirectories, commands such as `rl resume
codex` select that repository automatically unless explicitly overridden.

The first registration becomes the default; `rl repo use <alias>` changes the
default used outside registered worktrees. `rl repo remove <alias>` removes only
the registration, retaining all worktrees, branches, documents, and sessions.
Register the same path again to access its existing instance state.

Each repository has its own default base and worktree directory under
`RL_WORKTREE_DIR`. Use `repo add --worktree-name <directory>` to choose a directory;
directory names must be unique across registered repositories. Supply the same
directory name when re-registering a repository under a different alias.

If `--base` is omitted, a repository matching `RL_REPO_ROOT` uses `RL_DEFAULT_BASE`; other
repositories use `origin/HEAD` if configured, otherwise their main checkout's
current branch. No fetch occurs during registration. Registering a linked worktree
normalizes to its main checkout, and duplicate registrations of one Git repository
are rejected.

## Branch status overview

```sh
rl status --all                       # all registered repositories
rl --repo backend status --list       # all backend instances
rl status --all --fetch               # first refresh each repository's remotes
rl status --all --json                # structured overview
rl status --all --include-deleted     # also include archived instance records
rl status                            # current instance metadata + gitStatus (JSON)
```

The overview shows repository, instance, actual branch, lifecycle state, changes,
upstream, ahead/behind counts, and cached PR state. `S` means staged, `M` unstaged,
`?` untracked, and `!` conflicts. Counts are Git status entries; untracked directories
count as one entry. Detached HEADs, changed branches, missing worktrees, and unavailable
repositories are shown explicitly. Changed branches remain protected from accidental
session reassociation; use the overview to inspect them.

Ahead/behind is relative to each branch's configured upstream, which may be a base
branch such as `origin/develop`. A branch without an upstream is labeled accordingly.
Status is read-only and offline by default: remote counts use local tracking refs,
and PR state is the last `rl pr sync` snapshot. `--fetch` requests a fetch once per
repository; failures are reported while other repositories remain visible. Git status
parsing follows the [documented porcelain format](https://git-scm.com/docs/git-status).

Registered instance records are shown alongside existing managed Git worktrees
that have not yet been adopted (`unregistered`); viewing status does not install
hooks or create instances. Once repositories are registered, `--all` covers that
registry only. Register each repository you want to include. `rl instances` retains its JSON list
for the selected repository and now includes each instance's `gitStatus`.

## Use

```sh
rl new ROS-123
rl new ROS-123 --base main
rl open --branch feature/example
rl open -b origin/feature/example
rl                         # fzf worktree picker
rl delete                  # multi-select deletion picker
rl delete ROS-123
rl delete ROS-123 ROS-124 feature/old-task
```

`new` and `open` fetch origin first. New branches default to `origin/develop`.
A base that cannot be resolved locally is retried with `origin/` prefixed.
Existing local branches are reused; existing worktrees are opened. `open`
creates a tracking branch when only the origin branch exists, and replaces `/`
with `-` for the directory name. `new` retains the name as entered, including
nested branch paths. Both pickers list Git-registered worktrees beneath the
configured managed directory, including nested names. Each row shows automatically discovered PR
state and commits relative to its base:

```text
WORKSPACE     PR       + / −        BASE          LAST ACCESSED
ROS-123       draft    +3 / -1      origin/main   just now
feature/task  merged   +0 / -2      origin/main   2h ago
new-task      none     +1 / -0      origin/main   3d ago
```

Both pickers list most recently accessed workspaces first, including while
filtering. Opening with RL, adopting, and observed agent-session activity record
access; reading status, syncing PR metadata, or editing notes does not. Older
instances fall back to session usage and creation time. Worktrees with no saved
history show `—` and appear last. Plain `cd` or editor activity is not tracked.

Columns are aligned; long workspace names are abbreviated for display only.
Merged PRs are purple, open green, draft yellow, closed red, and none gray.
Commit additions are green and the behind count red. Set `NO_COLOR` to disable
row colors.

PR states are `merged`, `open`, `draft`, or `none`; a PR closed without merging
is shown as `closed`. Both pickers automatically look up branch PRs through
`gh`, including for worktrees that have not been adopted. Open/draft PRs take
precedence; otherwise the newest merged/closed PR is used. Successful results
(including confirmed absence) are cached for one minute. Queries are batched by
repository with an eight-second lookup budget. No Git fetch runs.

`none` means a successful lookup found no matching PR. `unknown` means the result
could not be verified, such as when authentication or the network is unavailable.
An asterisk, such as `merged*`, marks a retained snapshot after a failed refresh.
Lookup failures never erase a saved PR. Fork PRs with a coincidentally identical
branch name are excluded from discovery.

Run `rl pr sync` in a workspace for an immediate explicit refresh. Set
`RL_PR_OFFLINE=1` to use saved data without contacting GitHub. PR cache updates
do not change the last-accessed order. Persisted discoveries supply the PR target
to summaries and future agent sessions.

`+3 / -1` means three commits only on this workspace and one only on the base.
The comparison uses the cached PR's target branch (preferring its local
`origin/` ref), otherwise the base saved by `rl new --base`, otherwise the
repository's configured default. Older instances use that same fallback without
rewriting their state. When that default is missing, the picker checks cached
`origin/HEAD`, then existing `main`, `master`, or `develop` refs. Missing explicit
custom or PR bases display `—` rather than misleading zero counts. Counts use
locally cached refs; `rl status --list --fetch` refreshes remote refs. They describe
commit ancestry, so squash merges may still show commits ahead after a PR merges.

**`delete` force-removes the worktree, including uncommitted changes, and deletes
its local branch.** It never deletes the remote branch. Instance metadata,
notes, and session history are retained with `status: "deleted"`. `rl instances`
lists retained records; their notes remain in the state directory. Recreating a
deleted worktree creates a new instance, without inheriting old sessions.

## Batch deletion

Run `rl delete` and press **Tab** to select multiple workspaces, **Ctrl-A** to
select all displayed entries, **Ctrl-D** to clear the selection, and **Enter** to
delete. **Esc** cancels. The picker uses Git's registered worktrees and includes
nested workspace names such as `feature/old-task`.

```sh
rl delete ROS-123 ROS-124 ROS-125
rl delete --dry-run ROS-123 ROS-124
rl delete --jobs 2 ROS-123 ROS-124
```

Removal runs concurrently with up to **4 workers** by default (`--jobs 1` through
`--jobs 32`). Branch deletion is batched and worktree metadata is pruned once
after the batch. This overlaps slow filesystem cleanup across workspaces; a
single large worktree still takes time proportional to its files and disk speed.
The command waits for cleanup to finish and reports each result.

Unknown names are rejected before deleting anything. Only registered worktrees
under the configured managed directory can be selected; the main/configured
checkout is excluded. Locked worktrees fail without having their branch deleted,
while other selected worktrees continue. A worktree containing another registered
worktree must have its children removed first. Failures produce a nonzero exit
status; successful removals still retain RL documentation and session history.

With zsh integration enabled, deleting the worktree containing the current shell
moves the shell back to the selected repository's root. A standalone executable cannot change the
parent shell's directory.

## Existing worktrees

Opening an existing worktree with `rl open`
or selecting it in the picker registers it automatically. Alternatively, run
`rl adopt` inside the worktree; this needs no fetch and does not change its branch
or application files. Repeating adoption preserves saved notes and session history.

An existing worktree initially receives fresh documentation templates and empty
session lists. Historical agent chats are not guessed or imported. Attach a known
session with `rl session add <agent> <UUID>`, or let enabled hooks record future
starts/resumes.

## Explicit agent sessions

`new`, `open`, and the picker register their worktree and install local lifecycle
hooks. For an existing worktree, run this once inside it:

```sh
rl adopt
```

Then start either agent normally inside that workspace:

```sh
codex
claude
```

The agent's `SessionStart` hook reports its session identifier to RL and supplies
the current feature documentation. `SubagentStart` supplies the same documentation
to delegated agents without registering their IDs as resumable sessions.
`UserPromptSubmit` refreshes the parent session's usage timestamp and supplies
updated notes when their contents have changed. Starts and resumes always receive
context, including `SessionStart` after compaction. A session is associated only
after an explicit hook event or manual registration. RL does not scan global
session histories, infer ownership from file timestamps, or inspect transcripts.

```sh
rl resume codex
rl resume claude
rl session list
rl session list codex
```

Resume selects the greatest `lastUsedAt` for the requested agent in this instance
and executes exactly `codex resume <UUID>` or `claude --resume <UUID>` from the
instance root. No global/latest flags or fallback pickers are used. Missing
associations, invalid UUIDs, changed branches, and corrupt metadata produce errors.
An agent launch failure propagates its exit status and never triggers a fallback.
Resume accepts no extra agent flags that could override the selected session.

To explicitly associate an existing session that predates the hooks:

```sh
rl session add codex 00000000-0000-4000-8000-000000000001
rl session add claude 00000000-0000-4000-8000-000000000002
```

Replace those example IDs with actual full session UUIDs. Manual registration is
your assertion of ownership; RL does not verify that the agent still has that
session. `createdAt` means first registration with RL, and `lastUsedAt` is the
most recent observed use or explicit registration. A session cannot be reassigned
to another instance in the same repository. Usage outside RL hooks/commands is
not observable.

### Agent activity and diagnostics

```sh
rl doctor                       # check both agents in this workspace
rl doctor codex                 # check one agent
rl doctor claude --json          # machine-readable diagnostics
rl status                       # includes per-session activity
```

RL installs `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`,
`SubagentStart`, and `SubagentStop` handlers. Run `rl adopt` in each existing
workspace after updating RL to install the full set, then review hook trust in
your agent and restart it.

Activity records show the last observed state: `working`, `idle`, or `ended`.
A start is idle until a prompt is submitted; a subagent start is working.
Context restoration after compaction preserves the prior activity state.
`Stop` and `SubagentStop` mean a response ended, not that the feature is complete.
Child activity never replaces the parent's resumable session or activity.
Non-ended activity becomes `stale` after 30 minutes without another event.
These are event observations, not process monitoring: a crash, interruption,
missing hook, or a long-running turn can leave activity stale. Events are applied
in received order; the agents do not provide a shared ordering contract.

`rl doctor` reports hook configuration, CLI version availability, the last
successful event, the last recorded handler error, and activity. It is read-only
apart from invoking each selected agent's `--version` command. Exit status is
nonzero for incomplete hook configuration, a failed CLI version probe, or a state
directory that this process cannot write. Hook trust and version compatibility
are reported as unknown/unverified; neither installed files nor a version string
prove that an agent will deliver events. Successful events establish delivery
for that event only. Agent sandbox access can differ from your terminal's access.

Errors are retained only after the handler validates the workspace and instance.
Malformed input, ownership failures, and inaccessible state can only be reported
on stderr; they cannot reliably update the diagnostics. A successful later event
does not erase the last error's timestamp. Hooks never read agent transcripts or
launch another agent, and they do not request continuation at the end of a turn.

Codex thread identifiers such as `thr_…` are recorded for observation only.
Automatic CLI resume remains limited to full session UUIDs; an observed thread
identifier alone is not treated as proof that the CLI can resume it.

### Hook setup and trust

If `/hooks` has no RL entries, run `rl adopt` from a normal terminal inside the
exact worktree, confirm `.codex/hooks.json` exists, and restart Codex there.
Project-local hooks require a trusted project configuration layer and a Codex
version supporting these hooks. `rl session list codex` shows registrations; an
empty list alone does not identify whether hooks are absent, disabled, or failing.

Hook trust does not grant filesystem access to agent tools. RL state lives outside
the worktree; a workspace-restricted agent may be unable to update its notes or
create the state lock. In that case, have the agent save its handoff inside the
workspace, then append it from your normal terminal with
`rl progress append /path/to/handoff.md` (or `rl context append` for domain notes).
RL does not change sandbox permissions or global agent configuration.

RL merges its handlers into `.codex/hooks.json` and `.claude/settings.local.json`
inside the worktree, preserving unrelated hooks and settings. Generated files
are excluded locally through Git's `info/exclude`; tracked files remain tracked,
so review any existing tracked hook file before committing it. No global agent
configuration, shell aliases, or agent permission settings are changed.

Use agent versions supporting the six lifecycle hooks listed above. Trust
the workspace normally, then use Codex's `/hooks` to review and trust the RL
handlers. Until trusted, Codex skips them. If startup already occurred, the next
prompt can record the ID; restart/resume after trusting to load feature context.
Claude must likewise allow project hooks. Disabled hooks, bare/safe modes, or
older CLIs cannot provide automatic detection; `rl session add` remains explicit.

Hook commands bind to an immutable RL instance key and validate the reported
worktree and branch. Copying a hook into another worktree cannot attach sessions
to the original instance. Hooks call the stable `rl __hook` entry point through
`PATH`, with explicit instance/repository/state arguments; they do not depend on
user config loading or a particular Node/package installation path. Re-run
`rl adopt` after changing the state directory.
Changing `RL_STATE_DIR` selects
a separate store; it does not migrate existing records. Avoid moving registered
worktrees without also migrating their metadata.

The adapters follow the official [Codex hook contract](https://learn.chatgpt.com/docs/hooks),
[Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
and [Claude Code hook contract](https://code.claude.com/docs/en/hooks).

## Living feature and implementation documentation

The documents are intended to explain the feature to a developer or a fresh agent,
not merely preserve a chat summary. New instances start with these sections:

| Document | Contents |
| --- | --- |
| `context.md` | Purpose/scope, domain rules, acceptance criteria, design decisions and rationale, references |
| `progress.md` | Completed work, remaining checklist, implementation details, validation results, blockers, next steps, progress log |

Implementation details should name relevant files/symbols, explain how the code
works, and describe important APIs, data structures, and integration points. Record
what was actually tested and what is still unverified. Existing notes are never
overwritten when an instance is reopened or adopted again.

Both agents, newly launched sessions, and delegated subagents receive the latest
saved documents through their startup hooks:

```sh
rl context set feature-notes.md
rl progress set implementation-handoff.md
printf 'Done: parser. Next: validation tests. Details: src/parser.ts.\n' | rl progress append -
rl context append domain-decisions.md
rl context show
rl progress show
rl context path
rl progress path
```

`append` adds a timestamped update under the same lock as other state mutations,
so concurrent agent updates are preserved. `set` deliberately replaces the whole
document; use it to consolidate notes after coordinating with other writers. Both
accept a UTF-8 file or stdin (`-`).
`path` returns its persistent location for editing. These documents live outside
the worktree and outside agent-specific storage. They are included on session
start/resume and subagent launch, together with cached PR state. Each launch reads
the current files, so later agents receive updates saved by earlier agents. Long
notes include an excerpt and the full file path.

The injected instructions ask agents to maintain these documents at meaningful
milestones and before finishing, distinguish completed work from plans, preserve
other agents' updates, and document validation evidence. Read-only agents return
proposed updates to their parent. Agent permissions still apply. RL does not invent
summaries, automatically claim tasks are done, or scrape transcripts; the user and
agents write the documentation explicitly. An already-running session should
re-read it before planning later work (`rl context show`, `rl progress show`).

## Markdown summary export

From any directory inside an adopted RL worktree:

```sh
rl summary                           # save summary.md in the instance state directory
rl summary --output feature-report.md
rl summary --stdout                  # Markdown to stdout, without saving
rl summary --base origin/main        # choose a different comparison branch/commit
```

The default command prints the absolute path of the generated file, so you can
open it with `code "$(rl summary)"`. It refreshes the instance's saved `summary.md`
without adding files to the checkout. The report survives worktree deletion.
`--output` resolves relative to the calling directory and refuses to overwrite
an existing file unless `--force` is supplied; it cannot overwrite the instance's
source context/progress documents. Choose a `.md` destination.

The report includes saved progress (completed work, remaining tasks, implementation
details, and recorded validation), feature/domain notes, commits and file-change
statistics, staged/unstaged changes, untracked paths, upstream divergence, and the
cached PR snapshot. It exports the existing documents and Git evidence without
invoking an agent, reading session transcripts, fetching remotes, or inferring
that changed code is complete or tested. Empty documentation templates are labeled
as having no notes recorded.

Committed changes are measured from the merge-base of HEAD and the cached PR's
target branch, preferring its `origin/` ref over a local branch. Without a PR
target, RL uses the saved workspace base, then the configured default. A missing
PR target fails without replacing the previous report rather than comparing
against another branch. Run `rl pr sync` after retargeting a PR. `--base` remains
an explicit one-off report override. A bare
branch name is also tried with `origin/`; an unavailable default `origin/<branch>`
is retried as local `<branch>`. If the default still cannot be resolved, the report
omits committed work and explains how to select a base. An invalid explicit base
fails without replacing a previous report. Remote refs/PR metadata may be stale,
and Git is sampled while the command runs rather than frozen in a snapshot.

## GitHub PR state

```sh
rl pr sync          # query this branch, or refresh the already-associated PR
rl pr sync 1234     # explicitly associate and fetch a PR
rl pr show          # read the saved snapshot without network access
```

RL uses read-only `gh repo view`, `gh pr view`, and batched GraphQL queries, validates the PR repository
and head branch, and saves its number, URL, title, state, draft flag, base/head
branches, GitHub update time, and local sync time. Failed refreshes preserve the
previous snapshot. This does not create, publish, merge, or close PRs. The snapshot
is current as of `syncedAt`, not a live subscription.

## State layout

`rl status` shows the current instance and its state directory. Records live at:

```text
$RL_STATE_DIR/<repository-path-hash>/<instance-UUID>/
  instance.json
  context.md
  progress.md
  summary.md       # generated by rl summary
```

The explicit repository registry lives in `$RL_STATE_DIR/repositories.json`, with
its own write lock. Registering aliases does not change the repository-path hashes
or existing instance UUIDs. Agent hooks keep their explicit repository identity
and do not depend on whichever repository is selected in the shell.

The JSON uses a versioned schema and includes `id` (initial branch name), immutable
`key`, `repository`, `branch`, `worktree`, lifecycle timestamps, `status`, separate
`sessions.codex` and `sessions.claude` lists, and `pr`. Each session stores its UUID,
`createdAt`, and `lastUsedAt`. A per-repository file lock and atomic replacement
protect updates from concurrent terminals and hooks. Back up the state directory
to preserve notes and associations; the agents still own their actual transcripts.

## Directory switching

An executable cannot change its parent shell's directory. Direct CLI calls
print the selected path after their status messages. To switch directories automatically,
add this to `~/.zshrc`:

```zsh
eval "$(command rl init zsh)"
```

Restart your terminal after adding the integration or upgrading RL.

## Configuration

Register repositories with `rl repo add` and choose their base with `--base`.
For other settings, use environment variables or a configuration file.
Copy `config.example.zsh` to `${XDG_CONFIG_HOME:-$HOME/.config}/rl/config.zsh`,
or select a file with `RL_CONFIG`. Configuration is trusted zsh code.

| Setting | Default |
| --- | --- |
| `RL_WORKTREE_DIR` | `$HOME/.rl/worktrees` |
| `RL_STATE_DIR` | `$HOME/.rl/instances` |
| `RL_REPO` | Optional registered repository alias; unset to select automatically |

Nonempty environment settings override the file. Repository and worktree
and state directories must be absolute. The state directory must be outside the
worktree. Each registered repository has its own directory under
`RL_WORKTREE_DIR` and its own base branch.
Git operations target the selected repository even when run outside its checkout.

## Development

The source is split into typed modules under `src/`: `store.ts` handles persisted
records and hook installation; `state.ts` handles sessions, documentation, and
PR snapshots; `repos.ts` handles routing and overview; `delete.ts` handles batch
removal; `picker.ts` builds annotated selections; `summary.ts` exports Markdown.
Shared process, filesystem, and locking helpers live in `common.ts`.
`agent-codex.ts` and `agent-claude.ts` translate native hook contracts into RL
lifecycle events; `hooks.ts` handles validated events, `activity.ts` tracks
observations, and `doctor.ts` diagnoses configuration and delivery. Add agent
contracts in adapters rather than agent-specific branches in the state handler.

`npm run build` compiles strict TypeScript into `dist/`. `bin/rl` and
`lib/rl.zsh` handle shell configuration and worktree commands, while
`shell/rl.zsh` provides parent-shell directory switching. The executable skips
user zsh startup files; configuration comes from the documented file and environment.

```sh
npm ci
npm run build
npm test
npm run test:package
npm run format:check
npm pack --dry-run
```

Tests are written in TypeScript and run with Node's built-in test runner.

Tests use temporary local Git repositories, representative hook payloads, and stub agent/gh
executables. They exercise explicit resume arguments, workspace isolation,
concurrent updates, persistent notes, deletion, PR validation, and error paths.
They do not launch paid agent sessions or access GitHub.

Package tests build a real tarball, check its file allowlist, install it into a
temporary npm prefix, and exercise the installed CLI, shell integration, and
hooks after relocation/reinstallation. They do not alter your global installation.

## Packaging and publication

`package.json` defines npm's `rl` executable and includes only runtime files,
bundled runtime dependencies, the configuration example, and this README. Tests, caches, workspace metadata,
and development artifacts are not shipped. See npm's official documentation for
[package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
and [packing a release](https://docs.npmjs.com/cli/v11/commands/npm-pack/).

RL is licensed under the [MIT License](LICENSE).

Before publishing to npm, confirm ownership/availability of `rl-workspaces` (or
change the package name to your npm scope). The executable can remain `rl`
regardless of package name. No registry publication is performed by the build or tests.

## Contributing

Issues and pull requests are welcome. Describe the problem, expected behavior,
and steps to reproduce it. For changes, run the development checks above and
include relevant validation in your pull request. Keep tests isolated in temporary
repositories and avoid real agent sessions or GitHub requests in tests.
