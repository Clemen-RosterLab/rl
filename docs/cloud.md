# Remote workspaces

`rl cloud` opens, lists, creates and reviews workspaces on an existing SSH host.
Set up the server and SSH connection separately, then choose the host:

```sh
rl cloud use dev-box
rl cloud list
rl cloud create feature/login --repo frontend
rl cloud open frontend/feature/login
rl cloud open frontend/feature/login --code
rl cloud review frontend/feature/login
```

Creation requires `rl` installed on the server and a repository registered there
with `rl repo add <path>`. It creates a branch and worktree using the server's
normal workflow and prints the remote path. `--base <ref>` overrides the starting
point; `--no-fetch` uses the server's cached refs. Use `open` afterward to enter it.
`--repo` on `cloud create` selects the **remote** repository. Without it, RL uses
the server's default repository or asks you to pick one.

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
