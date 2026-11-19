# Remote workspaces

`rl cloud` opens, lists, creates and reviews workspaces on an existing SSH host.
Set up the server and SSH connection separately, then choose the host:

```sh
rl cloud use dev-box
rl cloud list
rl cloud switch -c "blah" -p "My prompt"
rl cloud switch -c "blah" -a agy -m "MODEL_NAME" -p "My prompt"
rl cloud switch "blah"
rl cloud create feature/login --repo frontend
rl cloud open frontend/feature/login
rl cloud open frontend/feature/login --code
rl cloud review frontend/feature/login
```

Creation requires `rl` installed on the server and a repository registered there
with `rl repo add <path>`. It creates a branch and worktree using the server's
normal workflow. `--base <ref>` overrides the starting point; `--no-fetch` uses
the server's cached refs. Plain `cloud create` prints the path; `cloud switch -c`
opens it immediately, or launches the supplied prompt.
`--repo` on `cloud switch -c` or `cloud create` selects the **remote** repository. Without it, RL uses
the server's default repository or asks you to pick one.

`cloud switch` mirrors local switching: `-c` / `--create` uses the server's normal
RL creation and hook setup; without it, an exact existing workspace name, branch,
or absolute path is required. Use `--repo` to disambiguate names. Without a prompt,
switching opens an interactive SSH session (or uses `--code`, `--agent`, or
`--resume`). `--setup` requests the usual optional workspace setup during creation.
`cloud create` remains compatible and uses the same creation implementation.

With `-p` / `--prompt`, RL launches `rl agent run` inside the selected workspace
under a detached supervisor. SSH can disconnect and the laptop can close while
the server continues running it. AGY is the default; `-a` / `--agent` also accepts
Codex, Claude, and OpenCode. `-m` / `--model` forwards the exact model name to the
agent's native `--model` option. Omitting it preserves native configuration.
Authentication and agent permissions stay unchanged, so authenticate on the
server beforehand; a job cannot answer interactive permission prompts.

The response prints the host, workspace, job ID, status, and commands to inspect,
follow logs, or resume the conversation after it stops. For example:

```sh
rl cloud job <job-id> --host dev-box
rl cloud job <job-id> --host dev-box --json
rl cloud open /remote/worktree/path --host dev-box --agent agy --resume
```

Launch confirmation means the process started, not that the task succeeded.
Jobs retain their exit code and log; `failed` or `interrupted` status exits nonzero.
Logs include native errors, and buffered agent output may only appear at exit.
Resume uses the conversation recorded by the agent's normal RL hooks.

Job records, private prompt files and logs live under the server's
`$RL_STATE_DIR/cloud-jobs` (default `~/.rl/instances/cloud-jobs`). A lock prevents
another detached job in the same canonical workspace. Normal completion or failure
releases it. After a supervisor crash, the lock stays in place: inspect the job
and its remote process group before manually removing the reported lock directory.
These jobs survive client disconnects, not server shutdowns or reboots.

Use `rl cloud repos` to see remote repositories. Existing `code`, `fetch`, and
`checkout` commands remain available for workspace actions. Opening supports
`--agent codex|claude|agy` and `--resume`.

For a private configuration file, use `~/.config/rl/config.toml`:

```toml
cloudHost = "dev-box"
```

Host selection: `--host` (or `--vm`), then `RL_CLOUD_HOST` (or `RL_CLOUD_VM`),
then `cloudHost` (or `cloudVm`), then the host saved by `rl cloud use`.
`RL_CONFIG` and `XDG_CONFIG_HOME` still select alternate private configuration.
Keep credentials in your normal SSH setup.

VM creation, deletion, start/stop, discovery, SSH configuration generation and
tunnelling are no longer RL commands. Use SSH and your infrastructure tools for
those tasks. Existing SSH configuration, including previously generated IAP
entries, is left untouched and continues to be used by SSH. Old `cloudProject`,
`cloudZone` and `cloudTemplate` settings are accepted for compatibility but ignored.
