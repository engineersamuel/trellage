#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
launcher="$root/bin/cdx"
fixture_parent="$(CDPATH= cd -P -- "${TMPDIR:-/tmp}" && pwd -P)"
fixture="$(mktemp -d "$fixture_parent/trellage-cdx-lifecycle.XXXXXX")"

cleanup() {
  case "$fixture" in
    "$fixture_parent"/trellage-cdx-lifecycle.*) rm -rf -- "$fixture" ;;
    *) printf 'refusing unsafe fixture cleanup: %s\n' "$fixture" >&2; exit 1 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'trellage Codex lifecycle contract failed: %s\n' "$1" >&2
  exit 1
}

HOME="$fixture" "$launcher" list >"$fixture/list.out" || fail 'list failed'
cmp -s "$fixture/list.out" <(printf '%s\n' \
  $'pstack\tpstack-for-codex@pstack-for-codex-local' \
  $'superpowers\tsuperpowers@superpowers-marketplace' \
  $'youtube\tyoutube-full') || fail 'list output differs'

for arguments in 'pstack --version' '--native-auth pstack --version'; do
  status=0
  # The words are fixed contract fixtures, not user input.
  # shellcheck disable=SC2086
  HOME="$fixture" "$launcher" $arguments >"$fixture/retired.out" 2>&1 || status=$?
  [ "$status" -eq 1 ] || fail "retired launch exit was $status, expected 1"
  grep -Fqx -- 'cdx: this private profile manager cannot launch agents; use trx run codex PROFILE' \
    "$fixture/retired.out" || fail 'retired launch diagnostic differs'
done

printf 'trellage Codex lifecycle contract: PASS\n'
