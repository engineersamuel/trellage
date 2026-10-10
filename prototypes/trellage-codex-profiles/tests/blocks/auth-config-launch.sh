#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
launcher="$root/bin/cdx"
fixture_parent="$(CDPATH= cd -P -- "${TMPDIR:-/tmp}" && pwd -P)"
fixture="$(mktemp -d "$fixture_parent/trellage-cdx-launch-retirement.XXXXXX")"

cleanup() {
  case "$fixture" in
    "$fixture_parent"/trellage-cdx-launch-retirement.*) rm -rf -- "$fixture" ;;
    *) printf 'refusing unsafe fixture cleanup: %s\n' "$fixture" >&2; exit 1 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'trellage Codex launch retirement contract failed: %s\n' "$1" >&2
  exit 1
}

expected_help="$fixture/expected-help.out"
printf '%s\n' \
  'Usage: cdx COMMAND' \
  '' \
  'Commands:' \
  '  list' \
  '  list --json' \
  '  inventory PROFILE --json' \
  '  inventory PROFILE --goal-features' \
  '  setup PROFILE|--all' \
  '  doctor PROFILE' \
  '  update --check PROFILE|--all' \
  '  update PROFILE|--all' \
  '  repair PROFILE' \
  '  skills-update PROFILE' \
  '  skills-check PROFILE' \
  '  harness-version' \
  '  harness-update' >"$expected_help"

HOME="$fixture" "$launcher" --help >"$fixture/help.out" || fail 'help failed'
cmp -s "$fixture/help.out" "$expected_help" || fail 'help advertises a retired launch form'

for arguments in '' 'pstack --version' '--native-auth pstack --version' 'unknown-profile'; do
  status=0
  if [ -n "$arguments" ]; then
    # The words are fixed contract fixtures, not user input.
    # shellcheck disable=SC2086
    HOME="$fixture" "$launcher" $arguments >"$fixture/retired.out" 2>&1 || status=$?
  else
    HOME="$fixture" "$launcher" >"$fixture/retired.out" 2>&1 || status=$?
  fi
  [ "$status" -eq 1 ] || fail "retired launch exit was $status, expected 1"
  grep -Fqx -- 'cdx: this private profile manager cannot launch agents; use trx run codex PROFILE' \
    "$fixture/retired.out" || fail 'retired launch diagnostic differs'
done

printf 'trellage Codex launch retirement contract: PASS\n'
