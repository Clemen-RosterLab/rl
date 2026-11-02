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
  command node "${${functions_source[_rl_help]}:A:h:h}/dist/help.js" "$@"
}

_rl_main() {
  emulate -L zsh
  # Help is independent of repository routing, config files, and agent tools.
  local -a help_args=("$@")
  [[ "$help_args[1]" == --repo ]] && help_args=("${help_args[@]:2}")
  [[ "$help_args[1]" == --repo=* ]] && help_args=("${help_args[@]:1}")
  local help_arg
  if [[ "$help_args[1]" == help ]]; then
    _rl_help "${help_args[@]}"
    return
  fi
  for help_arg in "${help_args[@]}"; do
    [[ "$help_arg" == -- ]] && break
    if [[ "$help_arg" == --help || "$help_arg" == -h ]]; then
      _rl_help "${help_args[@]}"
      return
    fi
  done
  if (( ${#help_args} == 1 )) && [[ "$help_args[1]" == (agent|workflow|policy|repo|git|notes|session|config|step) ]]; then
    _rl_help "${help_args[@]}"
    return
  fi

  # Canonical command families; older spellings remain compatibility aliases.
  # Preserve a leading repository selector while normalizing the public command.
  local -a routing_prefix=()
  if [[ "$1" == --repo ]]; then
    routing_prefix=("$1" "$2")
    shift 2
  elif [[ "$1" == --repo=* ]]; then
    routing_prefix=("$1")
    shift
  fi
  case "$1:$2" in
    git:commit|git:rebase|git:squash) argv=(step "$2" "${@:3}") ;;
    git:diff|git:log|git:merge) argv=("$2" "${@:3}") ;;
    agent:sessions) argv=(session list "${@:3}") ;;
    agent:save) argv=(session save "${@:3}") ;;
    agent:handoff) argv=(handoff "${@:3}") ;;
    agent:mcp) argv=(mcp "${@:3}") ;;
    storage:clean) argv=(clean "${@:3}") ;;
    setup:init|setup:show) argv=(config "$2" "${@:3}") ;;
    setup:adopt) argv=(adopt "${@:3}") ;;
    setup:run) argv=(setup "${@:3}") ;;
    setup:shell)
      command "${${functions_source[_rl_main]}:A:h:h}/bin/rl" init "${@:3}"
      return ;;
    notes:summary) argv=(summary "${@:3}") ;;
    notes:show|notes:path|notes:set|notes:append)
      local note_kind="${3:-context}"
      if [[ "$note_kind" != context && "$note_kind" != progress ]]; then
        print -u2 -r -- "Unknown document: $note_kind. Use context or progress."
        _rl_help notes "$2" >&2
        return 1
      fi
      argv=("$note_kind" "$2" "${@:4}") ;;
  esac
  if [[ "$1" == git || "$1" == notes ]]; then
    print -u2 -r -- "Unknown $1 command: $2"
    print -u2 -r -- "Run rl help $1 for available commands."
    return 1
  fi
  argv=("${routing_prefix[@]}" "$@")
  local config_file="${RL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/rl/config.zsh}"
  # Configuration is trusted zsh code, scoped to this invocation.
  local -x RL_REPO_ROOT="${RL_REPO_ROOT-}" RL_WORKTREE_DIR="${RL_WORKTREE_DIR-}"
  local -x RL_REPO_NAME="${RL_REPO_NAME-}" RL_DEFAULT_BASE="${RL_DEFAULT_BASE-}"
  local -x RL_STATE_DIR="${RL_STATE_DIR-}"
  local env_selection_present=${+RL_REPO}
  local -x RL_REPO="${RL_REPO-}"
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
  local repo_root="${env_root:-$RL_REPO_ROOT}"
  if [[ -z "$repo_root" ]]; then
    # Resolve only the current repository; the first NUL-delimited worktree
    # record identifies its main checkout, including from a linked worktree.
    local -a current_repository
    current_repository=("${(@0)$(command env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE \
      git -C "$PWD" worktree list --porcelain -z 2>/dev/null)}")
    if [[ "$current_repository[1]" == 'worktree '* ]]; then
      repo_root="${current_repository[1]#worktree }"
    else
      # Repository-management commands can run outside Git; registered defaults
      # are resolved below before workspace commands use this placeholder.
      repo_root="$PWD"
    fi
  fi
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
  if [[ "$command" == checkout ]]; then
    local destination_file destination checkout_result
    destination_file=$(mktemp "${TMPDIR:-/tmp}/rl-checkout.XXXXXXXX") || return 1
    {
      _rl_repos "$@" --output-path "$destination_file"
      checkout_result=$?
      destination=$(<"$destination_file")
      if (( checkout_result == 0 )) && [[ -n "$destination" ]]; then
        _rl_change_directory "$destination" || return 1
      fi
      return $checkout_result
    } always {
      command rm -f -- "$destination_file"
    }
  fi
  if [[ "$command" == list ]]; then
    shift
    if (( ${argv[(Ie)--all]} )); then
      _rl_repos status "$@"
    else
      _rl_repos status --list "$@"
    fi
    return
  fi
  if [[ "$command" == status ]] && (( ! ${argv[(Ie)--workspace]} )); then
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

  if [[ "$command" == pr && "$2" == update ]]; then
    command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" pr-update \
      --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
      --default-base "$default_base" "$@"
    return
  fi
  if [[ "$command" == pr && ( "$2" == checks || "$2" == checkout ) ]]; then
    command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" pr \
      --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
      --default-base "$default_base" "$@"
    return
  fi
  case "$command" in
    storage|clean)
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" storage \
        --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
        --default-base "$default_base" "$@"
      return ;;
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
    workflow|policy)
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" automation \
        --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
        --default-base "$default_base" "$@"
      return ;;
    agent|handoff)
      if [[ "$command" == agent && ( "$2" == list || "$2" == show || "$2" == add || "$2" == set ) ]]; then
        command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" automation \
          --repo "$repo_root" --state-dir "$state_dir" --base-dir "$base_dir/$repo_name" \
          --default-base "$default_base" "$@"
        return
      fi
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

  print -u2 -r -- "Unknown command: $command"
  print -u2 'Run rl help for available commands.'
  return 1
}
