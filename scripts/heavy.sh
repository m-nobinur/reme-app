#!/usr/bin/env bash
# usage: scripts/heavy.sh <command> [args...]
# Runs a heavy local job one at a time on this machine. Two at once took the
# load average to 96 and the desktop with it. The lock is a flock(2) held by
# this shell, so a holder that dies frees it with no cleanup, and the lock file
# sits in the per-user temp dir, outside every worktree.
set -euo pipefail

# Nested call (pnpm test inside pre-push): the outer job already holds the lock.
[ -n "${REME_HEAVY_LOCK:-}" ] && exec "$@"
# shortcut: no lockf(1) on Linux, so CI and act containers run unlocked, add flock(1) if a Linux box runs local jobs.
command -v lockf >/dev/null || exec "$@"

lock="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || printf '%s/' "${TMPDIR:-/tmp}")reme-heavy.lock"
exec 9>>"$lock"
if ! lockf -s -t 0 9; then
  printf '  … waiting for pid %s\n' "$(cat "$lock")" >&2
  lockf -s 9
fi
printf '%s (%s)\n' "$$" "$*" >"$lock"
export REME_HEAVY_LOCK=$lock
# The job does not inherit fd 9: a child it leaves behind would hold the lock after it ends.
"$@" 9>&-
