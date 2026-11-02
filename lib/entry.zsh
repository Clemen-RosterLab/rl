#!/bin/zsh -f
emulate -L zsh
readonly rl_home="${${(%):-%x}:A:h:h}"
if [[ "$1" == __hook ]]; then
  # Hooks resolve the installed CLI on PATH, not a version-specific package path.
  # Their explicit repository/state arguments must not be replaced by user config.
  shift
  exec node "$rl_home/dist/cli.js" state "$@"
fi
if [[ "$1" == --version || "$1" == -V ]]; then
  exec node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$rl_home/package.json"
fi
if [[ "$1" == setup && "$2" == shell ]]; then
  if (( $# == 2 )); then
    exec node "$rl_home/dist/help.js" setup shell
  fi
  for argument in "$@"; do
    [[ "$argument" == -- ]] && break
    if [[ "$argument" == --help || "$argument" == -h ]]; then
      exec node "$rl_home/dist/help.js" "$@"
    fi
  done
  if [[ "$3" != zsh && "$3" != bash || $# != 3 ]]; then
    print -u2 'Usage: rl setup shell <zsh|bash>'
    exit 1
  fi
  if [[ "$3" == zsh ]]; then
    print -r -- "source ${(q)rl_home}/shell/rl.zsh"
  else
    print -r -- "_rl_executable=${(qq)rl_home}/bin/rl"
    cat <<'BASH'
rl() {
  local destination_file destination result previous="$PWD"
  local -a arguments=("$@")
  if [[ "$1" == switch && "${2:-}" == - ]]; then
    [[ -n "${RL_PREVIOUS_WORKSPACE:-}" ]] || { printf '%s\n' 'No previous workspace in this shell' >&2; return 1; }
    arguments[1]="$RL_PREVIOUS_WORKSPACE"
  fi
  destination_file=$(mktemp "${TMPDIR:-/tmp}/rl-shell.XXXXXXXX") || return 1
  if RL_SHELL_OUTPUT="$destination_file" command "$_rl_executable" "${arguments[@]}"; then result=0; else result=$?; fi
  destination=$(cat -- "$destination_file")
  rm -f -- "$destination_file"
  if [[ -n "$destination" ]]; then
    builtin cd -- "$destination" || return 1
    RL_PREVIOUS_WORKSPACE="$previous"
  fi
  return "$result"
}
BASH
  fi
  exit 0
fi
source "$rl_home/lib/rl.zsh" || exit 1
_rl_main "$@"
