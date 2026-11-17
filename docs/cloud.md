# Cloud and SSH configuration

`rl cloud` has no built-in project, zone, VM name, or VM template. Keep your
deployment settings in your personal `~/.config/rl/config.toml`, outside the
repository. Edit that file rather than the public `config.example.toml`.
If the file already exists, preserve its other settings.

For Google Cloud IAP, add your own values using this fictional example:

```toml
cloudProject = "example-cloud-project"
cloudZone = "us-central1-a"
cloudVm = "dev-box"
cloudTemplate = "dev-vm-template"
```

`cloudProject` is required to list or manage GCP VMs. A zone is also required
for VM lifecycle commands and `rl cloud ssh-config`. `cloudTemplate` selects
the template for `rl cloud create`; it is optional. Credentials remain managed
by Google Cloud and SSH—do not put passwords, tokens, or private keys in RL's
configuration.

For an existing SSH host, only the host alias is needed:

```toml
cloudVm = "my-ssh-box"
```

Plain SSH hosts use your normal SSH configuration and do not need a GCP project
or zone. `rl cloud use <host>` can also save a default host in your local RL
state.

Settings are selected in this order:

1. Command flags: `--project`, `--zone`, and `--vm`.
2. Environment variables: `RL_CLOUD_PROJECT`, `RL_CLOUD_ZONE`,
   `RL_CLOUD_VM`, and `RL_CLOUD_TEMPLATE`.
3. Your personal configuration file.

Use `RL_CONFIG=/absolute/path/to/config.toml` to select another private file.
Without `RL_CONFIG`, RL also respects `XDG_CONFIG_HOME`. Missing required GCP
settings produce an error before running a cloud command; they never select
the developer's infrastructure as a fallback.

```sh
rl cloud vms
rl cloud ssh
rl cloud review
```

GCP commands require your own authenticated `gcloud` installation and access
permissions. This setup does not create accounts or grant access.
