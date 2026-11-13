# Load with: eval "$(command rl setup shell zsh)"
rl() {
  local rl_home="${${functions_source[rl]}:A:h:h}"
  local tmp_dir="${TMPDIR:-/tmp}"
  local destination_file payload mode destination result previous="$PWD"
  destination_file=$(mktemp "${tmp_dir%/}/rl-shell.XXXXXXXX") || return 1
  if RL_SHELL_OUTPUT="$destination_file" RL_SHELL_PROTOCOL=v2 RL_PREVIOUS_WORKSPACE="${RL_PREVIOUS_WORKSPACE:-}" \
    command node "$rl_home/dist/public-cli.js" "$@"; then
    result=0
  else
    result=$?
  fi
  payload=$(<"$destination_file")
  command rm -f -- "$destination_file"
  if [[ -n "$payload" ]]; then
    mode="${payload%%:*}"
    destination="${payload#*:}"
    if [[ -n "$destination" ]]; then
      builtin cd -- "$destination" || return 1
      if [[ "$mode" == "cd" ]]; then
        typeset -g RL_PREVIOUS_WORKSPACE="$previous"
      fi
    fi
  fi
  return "$result"
}
