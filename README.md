# rl

Git workspaces, live PR review, and coding agents in your terminal.

Work with Codex, Claude Code, or Antigravity (`agy`). Keep each task's branch,
notes, and agent conversations together, then pick up where you left off.

## Install

```sh
npm install --global rl-workspaces
rl setup install
```

Requires macOS or Linux and Node.js 22+. Open a new terminal after setup.
Install and authenticate your chosen agent CLI separately. For GitHub features,
run `gh auth login`.

## Start working

Run these from your repository, replacing `origin/main` with your target branch:

```sh
rl repo add . --base origin/main
rl switch feature/login -c --agent codex
rl review
```

Use `--agent claude` or `--agent agy` for another agent.

## Workspaces

Run `rl` to pick a workspace, `rl switch -` to return to the previous one, or
`rl resume` to continue a saved agent conversation.


## Live review

Watch changes as agents work. Browse commits and files, inspect coloured diffs,
and review GitHub PRs without a checkout. Navigate with the keyboard or mouse.

```sh
rl review
rl review --pr https://github.com/owner/repo/pull/123
```

## Agent workflows

Your main agent coordinates research, implementation, and independent review
using its native subagents. Follow each role's reported progress and blockers:


## Customize and learn more

Use `rl help` or `rl <command> --help` for command options.

- [Workflow configuration](docs/reference.md#session-driven-agent-workflows): roles, models, review rules, and execution levels.
- [Full reference](docs/reference.md): setup, review controls, PRs, notes, and troubleshooting.
- [Cloud configuration](docs/cloud.md): connect using your own private settings.
- [Adding screenshots](docs/images/README.md): image locations and replacement instructions.

## Development

```sh
npm ci
npm run build
npm test
```

See the [development reference](docs/reference.md#development) for local installation.

[MIT license](LICENSE).
