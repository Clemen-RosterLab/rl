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
  builtin cd -- "$1" || return 1
  if [[ "${RL_INTERNAL_SHELL:-0}" != 1 ]]; then
    print -r -- "$PWD"
  fi
}

_rl_validate_name() {
  case "$1" in
    ''|/*|.|..|./*|../*|*/../*|*/./*|*/..|*/.)
      print -u2 -r -- "Invalid workspace name: $1"
      return 1 ;;
  esac
  git check-ref-format --branch "$1" >/dev/null 2>&1 || {
    print -u2 -r -- "Invalid workspace name: $1"
    return 1
  }
}

_rl_help() {
  cat <<'HELP'
Usage:
  rl                             Pick a worktree with PR state and base commit counts
  rl new <name> [--base|-b <ref>]  Create a worktree (default: origin/develop)
  rl open --branch|-b <branch>    Open a local or origin branch
  rl delete [<name> ...]          Multi-select or batch-remove worktrees AND local branches
  rl delete --jobs 2 <names>      Limit parallel removals (default: 4)
  rl delete --dry-run <names>     Preview without deleting
  rl adopt                       Register this worktree and install session hooks
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
  rl init zsh                   Print optional shell integration
  rl --version                  Print installed package version

Pickers auto-detect PRs (60s cache) and commits +ahead/-behind the base (local refs).
Deletion includes uncommitted changes; remote branches are never deleted.
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
  local default_base="${env_base:-${RL_DEFAULT_BASE:-origin/develop}}"
  local state_dir="${env_state:-${RL_STATE_DIR:-$HOME/.rl/instances}}"
  local selected_repo="${env_selection:-$RL_REPO}"
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

  case "$command" in
    summary)
      shift
      command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" summary \
        --repo "$repo_root" --state-dir "$state_dir" --default-base "$default_base" "$@"
      return ;;
    adopt|status|instances|resume|session|context|progress|pr)
      _rl_state "$@"
      return ;;
  esac

  # ------------------------------------------------------------
  # rl new <name> [--base <branch>]
  # ------------------------------------------------------------
  if [[ "$command" == "new" ]]; then
    name="$2"

    if [[ -z "$name" ]]; then
      echo "Usage: rl new <name> [--base <branch>]"
      return 1
    fi

    # Default base branch.
    base="$default_base"

    shift 2

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --base|-b)
          if [[ -z "$2" ]]; then
            echo "Missing branch after $1"
            return 1
          fi

          base="$2"
          shift 2
          ;;

        *)
          echo "Unknown option: $1"
          echo "Usage: rl new <name> [--base <branch>]"
          return 1
          ;;
      esac
    done

    _rl_validate_name "$name" || return 1
    branch="$name"
    worktree="$base_dir/$repo_name/$name"

    mkdir -p "$base_dir/$repo_name" || return 1

    echo "Fetching origin..."
    git -C "$repo_root" fetch origin || return 1

    # Make origin/foo syntax optional.
    # If "foo" doesn't exist locally but origin/foo does,
    # use origin/foo as the base.
    if ! git -C "$repo_root" rev-parse \
      --verify "$base^{commit}" >/dev/null 2>&1; then

      if git -C "$repo_root" rev-parse \
        --verify "origin/$base^{commit}" >/dev/null 2>&1; then

        base="origin/$base"
      else
        echo "Base branch does not exist:"
        echo "  $base"
        return 1
      fi
    fi

    if [[ -e "$worktree" ]]; then
      echo "Worktree already exists:"
      echo "  $worktree"
      return 1
    fi

    # If <name> already exists, reuse it.
    if git -C "$repo_root" show-ref \
      --verify --quiet "refs/heads/$branch"; then

      echo "Branch already exists: $branch"

      existing_worktree=$(
        git -C "$repo_root" worktree list --porcelain |
        awk -v target="refs/heads/$branch" '
          /^worktree / {
            path = substr($0, 10)
          }

          /^branch / {
            if (substr($0, 8) == target) {
              print path
              exit
            }
          }
        '
      )

      if [[ -n "$existing_worktree" ]]; then
        echo "Branch already has a worktree:"
        echo "  $existing_worktree"
        _rl_enter "$existing_worktree"
        return
      fi

      git -C "$repo_root" worktree add \
        "$worktree" \
        "$branch" || return 1

    else

      echo "Creating:"
      echo "  branch: $branch"
      echo "  base:   $base"

      git -C "$repo_root" worktree add \
        -b "$branch" \
        "$worktree" \
        "$base" || return 1
    fi

    echo ""
    echo "Created workspace: $name"
    echo "Branch:   $branch"
    echo "Base:     $base"
    echo "Worktree: $worktree"

    _rl_enter "$worktree"
    return
  fi

  # ------------------------------------------------------------
  # rl open --branch <branch>
  # rl open -b <branch>
  # ------------------------------------------------------------
  if [[ "$command" == "open" ]]; then

    if [[ "$2" != "--branch" && "$2" != "-b" ]]; then
      echo "Usage:"
      echo "  rl open --branch <branch>"
      echo "  rl open -b <branch>"
      return 1
    fi

    branch="$3"

    if [[ -z "$branch" ]]; then
      echo "Usage: rl open --branch <branch>"
      return 1
    fi

    echo "Fetching origin..."
    git -C "$repo_root" fetch origin || return 1

    # Allow:
    #
    #   rl open --branch foo
    #   rl open --branch origin/foo
    #
    if [[ "$branch" == origin/* ]]; then
      branch="${branch#origin/}"
    fi

    git -C "$repo_root" check-ref-format --branch "$branch" >/dev/null 2>&1 || {
      print -u2 -r -- "Invalid branch: $branch"
      return 1
    }

    # Does local branch exist?
    if ! git -C "$repo_root" show-ref \
      --verify --quiet "refs/heads/$branch"; then

      # If not, check origin.
      if git -C "$repo_root" show-ref \
        --verify --quiet "refs/remotes/origin/$branch"; then

        echo "Creating local tracking branch:"
        echo "  $branch -> origin/$branch"

        git -C "$repo_root" branch \
          --track "$branch" "origin/$branch" || return 1

      else
        echo "Branch does not exist locally or on origin:"
        echo "  $branch"
        return 1
      fi
    fi

    # Check whether branch already has a worktree.
    existing_worktree=$(
      git -C "$repo_root" worktree list --porcelain |
      awk -v target="refs/heads/$branch" '
        /^worktree / {
          path = substr($0, 10)
        }

        /^branch / {
          if (substr($0, 8) == target) {
            print path
            exit
          }
        }
      '
    )

    if [[ -n "$existing_worktree" ]]; then
      echo "Opening existing worktree:"
      echo "  $existing_worktree"

      _rl_enter "$existing_worktree"
      return
    fi

    # Turn things like:
    #
    # feature/cliniko
    #
    # into:
    #
    # feature-cliniko
    #
    name="${branch//\//-}"
    worktree="$base_dir/$repo_name/$name"

    if [[ -e "$worktree" ]]; then
      echo "Worktree path already exists:"
      echo "  $worktree"
      return 1
    fi

    mkdir -p "$base_dir/$repo_name" || return 1

    echo "Creating worktree:"
    echo "  branch:   $branch"
    echo "  worktree: $worktree"

    git -C "$repo_root" worktree add \
      "$worktree" \
      "$branch" || return 1

    _rl_enter "$worktree"
    return
  fi

  if [[ "$command" == "delete" ]]; then
    shift
    command node "${${functions_source[_rl_main]}:A:h:h}/dist/cli.js" delete \
      --repo "$repo_root" --state-dir "$state_dir" \
      --base-dir "$base_dir/$repo_name" --default-base "$default_base" "$@"
    local delete_result=$?
    # With shell integration, leave a deleted current directory gracefully.
    [[ -d "$PWD" ]] || builtin cd -- "$repo_root"
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
