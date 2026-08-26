# shellcheck shell=bash
set -euo pipefail
red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*" >&2; }
die()  { red "✖ $*"; exit 1; }

PROTECTED_BRANCHES='^(main|staging|prod)$'
COMMIT_TYPES='feat|fix|docs|refactor|test|chore|perf|build|ci|revert'
LOCAL_NOISE='(^|[^A-Z0-9])(PHASE|WEEK|SPRINT|STORY|TASK|TICKET|EPIC)[-_ ]?[0-9]+([^A-Z0-9]|$)|(^|[^A-Z0-9])(BE|FE|AI|QA|ARCH|CTO)-[0-9]+([^A-Z0-9]|$)'
STORY_ID='(^|[^A-Za-z0-9])[A-F][1-9]([^A-Za-z0-9]|$)'
upper() { printf %s "$1" | tr '[:lower:]' '[:upper:]'; }

has_script() {
  [ -f package.json ] || return 1
  node -e "process.exit(require('./package.json').scripts?.['$1']?0:1)" 2>/dev/null
}
run_script() {
  has_script "$1" || { warn "  ↷ skip pnpm $1 (not defined yet)"; return 0; }
  printf '  → pnpm %s\n' "$1" >&2
  pnpm "$1" || die "pnpm $1 failed. Fix it, or --no-verify and own the consequences."
}
