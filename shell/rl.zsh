# Load with: eval "$(command rl init zsh)"
source "${${(%):-%x}:A:h:h}/lib/rl.zsh"
rl() {
  local RL_INTERNAL_SHELL=1
  if [[ "$1" == init || "$1" == --version || "$1" == -V || "$1" == __hook ]]; then
    command rl "$@"
  else
    _rl_main "$@"
  fi
}
