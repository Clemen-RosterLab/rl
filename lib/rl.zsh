# Shared implementation for the executable and optional zsh integration.
_rl_state() {
  command node "${${functions_source[_rl_state]}:A:h:h}/dist/cli.js" state \
    --repo "$repo_root" --state-dir "$state_dir" "$@"
}

_rl_repos() {
  command node "${${functions_source[_rl_repos]}:A:h:h}/dist/cli.js" repos \
    --state-dir "$state_dir" --base-dir "$base_dir" --legacy-root "$repo_root" \
    --legacy-name "$repo_name" --legacy-base "$default_base" --selection "$selected_repo" "$@"
}

_rl_enter() {
  _rl_state adopt --worktree "$1" --base "${base:-$default_base}" --quiet || return 1
  _rl_change_directory "$1"
}

_rl_change_directory() {
  local previous="$PWD"
  builtin cd -- "$1" || return 1
  if [[ "${RL_INTERNAL_SHELL:-0}" == 1 ]]; then
    typeset -g RL_PREVIOUS_WORKSPACE="$previous"
  elif [[ -n "${RL_SHELL_OUTPUT:-}" ]]; then
    print -rn -- "$PWD" > "$RL_SHELL_OUTPUT"
  else
    print -r -- "$PWD"
  fi
}

_rl_recover_directory() {
  [[ -d "$PWD" ]] && return 0
  builtin cd -- "$repo_root" || return 1
  if [[ -n "${RL_SHELL_OUTPUT:-}" ]]; then
    print -rn -- "$PWD" > "$RL_SHELL_OUTPUT"
  fi
}

_rl_help() {
  cat <<'HELP'
Usage:
  rl                             Pick a worktree with PR state and base commit counts
  rl new <name> [--base|-b <ref>]  Create a worktree (default: origin/test)
  rl open --branch|-b <branch>    Open a local or origin branch
  rl switch <name> [-c] [--base ref] [--no-fetch] [--setup]
  rl switch <name> --agent codex|claude [-- <agent args>]
  rl switch @|-                  Main checkout or previous workspace
  rl list [--json]               Show workspaces and branch status
  rl path [name]                 Print a workspace path
  rl exec [--workspace name] -- <command> [args...]
  rl setup [--workspace name] [--dry-run]  Run explicit project setup
  rl config init|show            Configure .rl/workflows.json
  rl delete [<name> ...]          Remove clean merged worktrees and branches
  rl delete --force <names>       Also remove dirty worktrees and unmerged branches
  rl delete --jobs 2 <names>      Limit parallel removals (default: 4)
  rl delete --dry-run <names>     Preview without deleting
  rl adopt [--extended-hooks]     Register worktree and optional extended hooks
  rl doctor [codex|claude] --repair  Repair project hooks
  rl agent start codex|claude [-- <args>]  Start an interactive agent
  rl agent run codex|claude --prompt <text>  Run an agent with a prompt
  rl handoff [codex|claude]       Export task context for another agent
  rl pause --file <handoff.json|->  Save session, changes, validation, and next steps
  rl continue [workspace] [--no-agent]  Open a saved task and resume its conversation
  rl mcp                         Serve task context and notes over stdio
  rl step commit -m <message>     Commit staged changes
  rl step rebase [--base ref]     Rebase this workspace onto its base
  rl step squash -m <message>    Squash feature commits into one
  rl merge [target] [--squash -m message] [--cleanup]  Integrate into a base checkout
  rl diff [--base ref] [-- --stat]  Show workspace changes
  rl log [--base ref] [-- --oneline]  Show feature commits
  rl pr checks                  Show pull request checks
  rl pr checkout <number>        Create a workspace for a pull request
  rl doctor [codex|claude] [--json]  Check hook setup and observed agent activity
  rl status                      Show this instance's metadata
  rl status --all [--fetch]       Branch overview across all registered repositories
  rl status --list [--json]       Branch overview for the selected repository
  rl repo add <alias> <path> [--base <ref>]  Register a repository
  rl repo list                   List registered repositories
  rl repo use <alias>             Set the default repository outside registered worktrees
  rl repo remove <alias>          Unregister only; retain worktrees and saved state
  rl --repo <alias> <command>     Select a repository explicitly
  rl instances                   List active and deleted instance records
  rl resume codex|claude          Resume this instance's last explicitly recorded session
  rl session list [agent]        Show recorded sessions
  rl session save [agent] [UUID] Save the current Codex session or an explicit UUID
  rl session add <agent> <UUID>   Explicitly associate an existing session
  rl context show|path            Read feature/domain documentation
  rl context set|append <file>    Replace or append documentation (- reads stdin)
  rl progress show|path           Read implementation documentation
  rl progress set|append <file>   Record completed work, remaining work, and details
  rl summary                     Save this instance's Markdown summary and print its path
  rl summary -o <file.md>         Export a summary to a chosen file
  rl summary --stdout [--base <ref>]  Print Markdown; optionally choose comparison base
  rl pr show                     Show cached GitHub PR state
  rl pr sync [number|URL]         Refresh and save PR state with gh
  rl help                       Show this help
  rl init zsh|bash              Print optional shell integration
  rl --version                  Print installed package version

Pickers auto-detect PRs (60s cache) and commits +ahead/-behind the base (local refs).
Deletion requires --force for uncommitted changes or unmerged branches.
Use shell integration to change the calling shell's directory.
HELP
}

_rl_main() {
  emulate -L zsh
  local config_file="${RL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/rl/config.zsh}"
  # Configuration is trusted zsh code, scoped to this invocation.
  local RL_REPO_ROOT="${RL_REPO_ROOT-}" RL_WORKTREE_DIR="${RL_WORKTREE_DIR-}"
  local RL_REPO_NAME="${RL_REPO_NAME-}" RL_DEFAULT_BASE="${RL_DEFAULT_BASE-}"
  local RL_STATE_DIR="${RL_STATE_DIR-}"
  local env_selection_present=${+RL_REPO}
  local RL_REPO="${RL_REPO-}"
  local env_root="$RL_REPO_ROOT" env_dir="$RL_WORKTREE_DIR"
  local env_name="$RL_REPO_NAME" env_base="$RL_DEFAULT_BASE"
  local env_state="$RL_STATE_DIR"
  local env_selection="$RL_REPO"
  if [[ -f "$config_file" ]]; then
    source "$config_file" || return 1
  elif [[ -n "${RL_CONFIG:-}" ]]; then
    print -u2 -r -- "Configuration not found: $config_file"
    return 1
  fi
  local repo_root="${env_root:-${RL_REPO_ROOT:-$HOME/Documents/GitHub/rosterlab-frontend}}"
  local base_dir="${env_dir:-${RL_WORKTREE_DIR:-$HOME/.rl/worktrees}}"
  local repo_name="${env_name:-${RL_REPO_NAME:-${repo_root:t}}}"
  local default_base="${env_base:-${RL_DEFAULT_BASE:-origin/test}}"
  local state_dir="${env_state:-${RL_STATE_DIR:-$HOME/.rl/instances}}"
  local selected_repo="$RL_REPO"
  (( env_selection_present )) && selected_repo="$env_selection"
  [[ "$repo_root" = /* && "$base_dir" = /* && "$state_dir" = /* ]] || {
    print -u2 'Repository, worktree, and state directories must be absolute paths.'
    return 1
  }
  [[ -n "$repo_name" && "$repo_name" != */* && "$repo_name" != . && "$repo_name" != .. ]] || {
    print -u2 'RL_REPO_NAME must be a single directory name.'
    return 1
  }

  if [[ "$1" == --repo ]]; then
    [[ -n "$2" ]] || { print -u2 'Usage: rl --repo <alias> <command>'; return 1; }
    selected_repo="$2"
    shift 2
  elif [[ "$1" == --repo=* ]]; then
    selected_repo="${1#--repo=}"
    [[ -n "$selected_repo" ]] || { print -u2 'Repository alias is required'; return 1; }
    shift
  fi
  local command="$1"
  local name worktree branch base existing_worktree

  if [[ "$command" == repo ]]; then
    _rl_repos "$@"
    return
  fi
  if [[ "$command" == list ]]; then
    shift
    _rl_repos status --list "$@"
    return
  fi
  if [[ "$command" == status ]] && (( ${argv[(Ie)--all]} || ${argv[(Ie)--list]} )); then
    _rl_repos "$@"
    return
  fi
  if [[ -f "$state_dir/repositories.json" || -n "$selected_repo" ]]; then
    local resolved
    local -a repository_fields
    resolved=$(_rl_repos resolve) || return 1
    repository_fields=("${(@f)resolved}")
    [[ ${#repository_fields} == 4 ]] || { print -u2 'Invalid resolved repository'; return 1; }
    repo_root="$repository_fields[1]"
    repo_name="$repository_fields[2]"
    default_base="$repository_fields[3]"
  fi

  if [[ "$command" == pr && ( "$2" == checks || "$2" == checkout ) ]]; then
    command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" pr \
      --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
      --default-base "$default_base" "$@"
    return
  fi
  case "$command" in
    pause)
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" task \
        --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
        --default-base "$default_base" "$@"
      return ;;
    step|merge|diff|log)
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" git \
        --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
        --default-base "$default_base" "$@"
      local git_result=$?
      _rl_recover_directory || return 1
      return $git_result ;;
    agent|handoff)
      [[ "$command" == agent ]] && shift
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" agent \
        --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
        --default-base "$default_base" "$@"
      return ;;
    mcp)
      shift
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" mcp \
        --repo "$repo_root" --state-dir "$state_dir" "$@"
      return ;;
    summary)
      shift
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" summary \
        --repo "$repo_root" --state-dir "$state_dir" --default-base "$default_base" "$@"
      return ;;
    adopt|doctor|status|instances|resume|session|context|progress|pr)
      _rl_state "$@"
      return ;;
  esac

  case "$command" in
    switch|new|open|continue)
      if [[ "$command" == switch && "$2" == - ]]; then
        [[ -n "${RL_PREVIOUS_WORKSPACE:-}" ]] || { print -u2 'No previous workspace in this shell'; return 1; }
        argv[2]="$RL_PREVIOUS_WORKSPACE"
      fi
      local destination_file destination workflow_result
      local workflow_command=workflow
      [[ "$command" == continue ]] && workflow_command=task
      destination_file=$(mktemp "${TMPDIR:-/tmp}/rl-switch.XXXXXXXX") || return 1
      {
        command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" "$workflow_command" \
          --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
          --default-base "$default_base" --output-path "$destination_file" "$@"
        workflow_result=$?
        destination=$(<"$destination_file")
        if [[ -n "$destination" ]]; then
          _rl_change_directory "$destination" || return 1
        fi
        return $workflow_result
      } always {
        command rm -f -- "$destination_file"
      }
      ;;
    path|exec|setup|config)
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" workflow \
        --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
        --default-base "$default_base" "$@"
      return ;;
  esac

  if [[ "$command" == "delete" ]]; then
    shift
    command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" delete \
      --repo "$repo_root" --state-dir "$state_dir" \
      --base-dir "$base_dir/$repo_name" --default-base "$default_base" "$@"
    local delete_result=$?
    # With shell integration, leave a deleted current directory gracefully.
    _rl_recover_directory || return 1
    return $delete_result
  fi

  # ------------------------------------------------------------
  # rl
  #
  # Interactive worktree picker
  # ------------------------------------------------------------
  if [[ -z "$command" ]]; then
    worktree=$(command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" picker \
      --repo "$repo_root" --state-dir "$state_dir" \
      --base-dir "$base_dir/$repo_name" --default-base "$default_base") || return $?
    if [[ -n "$worktree" ]]; then
      _rl_enter "$worktree"
    fi

    return
  fi

  _rl_help
  [[ "$command" == help || "$command" == --help || "$command" == -h ]] && return 0
  print -u2 -r -- "Unknown command: $command"
  return 1
}
