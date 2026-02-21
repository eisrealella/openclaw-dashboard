#!/bin/zsh
set -euo pipefail

REPO_DIR="/Users/ella/Documents/Codex/openclaw-dashboard"
LOCK_DIR="/tmp/openclaw-dashboard-sync.lock"
BRANCH="main"
TARGET_FILE="public/data/dashboard.static.json"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GIT_TERMINAL_PROMPT=0

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "skip: git repo not found at $REPO_DIR"
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "skip: previous sync still running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

cd "$REPO_DIR"

push_with_timeout() {
  local timeout_sec="${1:-120}"
  git -c credential.interactive=never push origin "$BRANCH" &
  local push_pid=$!
  (
    sleep "$timeout_sec"
    if kill -0 "$push_pid" 2>/dev/null; then
      echo "push timeout after ${timeout_sec}s, terminating..."
      kill "$push_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!
  wait "$push_pid"
  local push_status=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$push_status"
}

npm run export:static

git add "$TARGET_FILE"

if git diff --cached --quiet; then
  local_ahead="$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)"
  if [[ "${local_ahead}" -gt 0 ]]; then
    echo "no snapshot changes, but local branch is ahead by ${local_ahead}; pushing..."
    push_with_timeout 120
    echo "sync complete (pushed pending commits)"
    exit 0
  fi
  echo "no changes"
  exit 0
fi

STAMP="$(date '+%Y-%m-%d %H:%M:%S %z')"
git commit -m "chore: auto-refresh dashboard snapshot (${STAMP})"
push_with_timeout 120

echo "sync complete"
