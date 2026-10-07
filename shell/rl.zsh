# Load with: eval "$(command rl init zsh)"
rl() {
  local RL_INTERNAL_SHELL=1
  if [[ "$1" == init || "$1" == --version || "$1" == -V || "$1" == __hook ]]; then
    command rl "$@"
  else
    # npm upgrades replace the runtime, while interactive shells retain functions.
    source "${${functions_source[rl]}:A:h:h}/lib/rl.zsh" || return 1
    _rl_main "$@"
  fi
}
