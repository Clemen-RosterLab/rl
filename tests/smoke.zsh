#!/bin/zsh
emulate -L zsh
setopt err_exit pipe_fail
root="${${(%):-%x}:A:h:h}"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/rl-test.XXXXXXXX")
scratch="${scratch:A}"
trap 'rm -rf -- "$scratch"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME='rl test' GIT_AUTHOR_EMAIL=rl@example.invalid
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export RL_REPO_ROOT="$scratch/main repo" RL_WORKTREE_DIR="$scratch/work trees"
export RL_REPO_NAME=example RL_CONFIG="$scratch/config.zsh"
export RL_PR_OFFLINE=1
export RL_STATE_DIR="$scratch/state"
unset RL_DEFAULT_BASE RL_REPO GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
print '# Empty test configuration' > "$RL_CONFIG"
git init --bare -q "$scratch/origin.git"
git init -q -b develop "$RL_REPO_ROOT"
git -C "$RL_REPO_ROOT" commit -q --allow-empty -m Initial
git -C "$RL_REPO_ROOT" remote add origin "$scratch/origin.git"
git -C "$RL_REPO_ROOT" push -q -u origin develop
git -C "$RL_REPO_ROOT" push -q origin develop:feature/remote
cd "$scratch"
"$root/bin/rl" new task
[[ -d "$RL_WORKTREE_DIR/example/task" ]]
[[ $(git -C "$RL_WORKTREE_DIR/example/task" branch --show-current) == task ]]
"$root/bin/rl" open -b task
"$root/bin/rl" open --branch origin/feature/remote
[[ $(git -C "$RL_WORKTREE_DIR/example/feature-remote" rev-parse --abbrev-ref '@{upstream}') == origin/feature/remote ]]
"$root/bin/rl" new custom-base -b develop
git -C "$RL_REPO_ROOT" branch reusable develop
"$root/bin/rl" new reusable
git -C "$RL_REPO_ROOT" branch elsewhere develop
git -C "$RL_REPO_ROOT" worktree add -q "$scratch/elsewhere" elsewhere
"$root/bin/rl" new elsewhere
if "$root/bin/rl" new ../escape; then exit 1; fi
if "$root/bin/rl" delete ../escape; then exit 1; fi
if "$root/bin/rl" new missing -b nonexistent; then exit 1; fi
if "$root/bin/rl" unknown; then exit 1; fi
print dirty > "$RL_WORKTREE_DIR/example/feature-remote/untracked"
"$root/bin/rl" delete feature-remote
[[ ! -d "$RL_WORKTREE_DIR/example/feature-remote" ]]
if git -C "$RL_REPO_ROOT" show-ref --verify --quiet refs/heads/feature/remote; then exit 1; fi
[[ -n $(git -C "$RL_REPO_ROOT" ls-remote origin refs/heads/feature/remote) ]]

# Installation through a path containing spaces, including repeat installation.
RL_INSTALL_DIR="$scratch/installed bin" "$root/install.sh"
RL_INSTALL_DIR="$scratch/installed bin" "$root/install.sh"
"$scratch/installed bin/rl" help
eval "$("$scratch/installed bin/rl" init zsh)"
rl open -b task
[[ "$PWD" == "$RL_WORKTREE_DIR/example/task" ]]

# Deterministic fzf substitute exercises selection and cancellation.
mkdir -p "$scratch/mock"
printf '#!/bin/zsh\ncat >/dev/null\nprint -rn -- "$TEST_SELECTION"\n' > "$scratch/mock/fzf"
chmod +x "$scratch/mock/fzf"
export PATH="$scratch/mock:$PATH" TEST_SELECTION=reusable
rl
[[ "$PWD" == "$RL_WORKTREE_DIR/example/reusable" ]]
export TEST_SELECTION=''
rl
[[ "$PWD" == "$RL_WORKTREE_DIR/example/reusable" ]]
export TEST_SELECTION=custom-base
rl delete
[[ ! -d "$RL_WORKTREE_DIR/example/custom-base" ]]
cd "$scratch"

# File configuration and environment precedence.
print 'RL_DEFAULT_BASE=nonexistent' > "$RL_CONFIG"
if "$root/bin/rl" new config-failure; then exit 1; fi
RL_DEFAULT_BASE=develop "$root/bin/rl" new config-override
print 'All smoke checks passed.'
