#!/bin/zsh -f
emulate -L zsh
setopt err_exit
root="${${(%):-%x}:A:h}"
destination="${RL_INSTALL_DIR:-$HOME/.local/bin}"
if (( $# )); then
  print -u2 'Usage: RL_INSTALL_DIR=/absolute/bin ./install.sh'
  exit 1
fi
[[ "$destination" = /* ]] || { print -u2 'RL_INSTALL_DIR must be absolute'; exit 1; }
[[ -f "$root/dist/cli.js" && -d "$root/node_modules/proper-lockfile" ]] || {
  print -u2 'Build the checkout first: npm ci && npm run build'
  exit 1
}
mkdir -p "$destination"
if [[ -e "$destination/rl" || -L "$destination/rl" ]]; then
  if [[ "$destination/rl" -ef "$root/bin/rl" ]]; then
    print -r -- "Already installed: $destination/rl"
    exit 0
  fi
  print -u2 -r -- "Refusing to replace existing file: $destination/rl"
  exit 1
fi
ln -s "$root/bin/rl" "$destination/rl"
print -r -- "Installed: $destination/rl"
print -r -- "Ensure $destination is on PATH. Keep this checkout in place."
