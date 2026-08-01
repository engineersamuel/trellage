#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'workspace checks: FAIL: %s\n' "$1" >&2
  exit 1
}

checker='scripts/verify-workspace.sh'
[[ -x "$checker" ]] || fail "missing executable checker: $checker"

fixture_root="$(mktemp -d)"
cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT

fake_bin="$fixture_root/bin"
workspace="$fixture_root/workspace"
mkdir -p "$fake_bin" "$workspace"

cat >"$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_NPM_LOG"
printf 'fixture output for %s\n' "$*"
if [[ "$*" == 'run lint' ]]; then
  exit "${FAKE_LINT_STATUS:-0}"
fi
if [[ "$*" == 'run build' ]]; then
  mkdir -p "$HARNESS_WORKSPACE_ROOT/dist/public"
  printf '%s\n' '<!doctype html>' >"$HARNESS_WORKSPACE_ROOT/dist/public/index.html"
  printf '%s\n' 'body {}' >"$HARNESS_WORKSPACE_ROOT/dist/public/styles.css"
  chmod 0750 "$HARNESS_WORKSPACE_ROOT/dist" "$HARNESS_WORKSPACE_ROOT/dist/public"
  chmod 0640 \
    "$HARNESS_WORKSPACE_ROOT/dist/public/index.html" \
    "$HARNESS_WORKSPACE_ROOT/dist/public/styles.css"
fi
EOF
chmod 0555 "$fake_bin/npm"

export PATH="$fake_bin:$PATH"
export FAKE_NPM_LOG="$fixture_root/npm.log"
export HARNESS_WORKSPACE_ROOT="$workspace"
export FAKE_LINT_STATUS=9

if "$checker" >"$fixture_root/failed.stdout" 2>"$fixture_root/failed.stderr"; then
  fail 'a failed lint command produced a successful checker status'
fi

checks="$workspace/.harness/verification/checks.json"
[[ -f "$checks" ]] || fail 'checker did not write checks.json'
jq -e '
  .schemaVersion == 1
  and .overall == "failed"
  and .install == 0
  and .test == 0
  and .typecheck == 0
  and .lint == 9
  and .build == 0
  and .audit == 0
  and .prune == 0
  and .productionTree == 0
' "$checks" >/dev/null || fail 'failed check statuses were not normalized'
[[ "$(wc -l <"$FAKE_NPM_LOG" | tr -d ' ')" == '8' ]] \
  || fail 'checker stopped before restoring and verifying the production dependency tree'
[[ "$(sed -n '1p' "$FAKE_NPM_LOG")" == 'ci' ]] \
  || fail 'checker did not restore the lockfile-pinned development dependencies first'
[[ "$(sed -n '7p' "$FAKE_NPM_LOG")" == 'prune --omit=dev' ]] \
  || fail 'checker did not restore production-only dependencies after checks'
[[ "$(sed -n '8p' "$FAKE_NPM_LOG")" == 'ls --omit=dev --depth=0' ]] \
  || fail 'checker did not validate the final production dependency tree'

: >"$FAKE_NPM_LOG"
export FAKE_LINT_STATUS=0
"$checker" >/dev/null
jq -e '.overall == "passed" and ([.install, .test, .typecheck, .lint, .build, .audit, .prune, .productionTree] | all(. == 0))' \
  "$checks" >/dev/null || fail 'passing checks were not recorded'
[[ -z "$(find "$workspace/dist" -type d ! -perm -0700 -print -quit)" ]] \
  || fail 'build output directories are not owner-accessible'
[[ -z "$(find "$workspace/dist" -type f ! -perm -0600 -print -quit)" ]] \
  || fail 'build output files are not owner-readable'
[[ -z "$(find "$workspace/dist" \( -perm -0001 -o -perm -0002 -o -perm -0004 \) -print -quit)" ]] \
  || fail 'build output grants world access'

printf 'workspace checks: PASS\n'
