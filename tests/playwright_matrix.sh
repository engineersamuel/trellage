#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'playwright matrix: FAIL: %s\n' "$1" >&2
  exit 1
}

playwright_bin='tests/playwright/node_modules/.bin/playwright'
[[ -x "$playwright_bin" ]] || fail 'Playwright dependencies are missing; run npm ci in tests/playwright'

list_output="$(mktemp)"
error_output="$(mktemp)"
cleanup() {
  rm -f "$list_output" "$error_output"
}
trap cleanup EXIT

HARNESS_BASE_URLS='codex-wshobson=http://127.0.0.1:4173,copilot-awesome=http://127.0.0.1:4174' \
  "$playwright_bin" test --config tests/playwright/playwright.config.ts --list \
  >"$list_output"

grep -Fq '[codex-wshobson]' "$list_output" \
  || fail 'Codex contestant project is missing'
grep -Fq '[copilot-awesome]' "$list_output" \
  || fail 'Copilot contestant project is missing'
[[ "$(grep -Fc 'supports CRUD and persists state across a reload' "$list_output")" == '2' ]] \
  || fail 'common CRUD test is not listed once per contestant'
[[ "$(grep -Fc 'keeps the completed task after an app-container restart' "$list_output")" == '2' ]] \
  || fail 'common persistence test is not listed once per contestant'

if HARNESS_BASE_URLS='unsafe=https://example.com' \
  "$playwright_bin" test --config tests/playwright/playwright.config.ts --list \
  >"$error_output" 2>&1; then
  fail 'non-loopback browser target was accepted'
fi
grep -Fq 'HARNESS_BASE_URLS target must use http://127.0.0.1' "$error_output" \
  || fail 'non-loopback rejection was unclear'

if HARNESS_BASE_URLS='duplicate=http://127.0.0.1:4173,duplicate=http://127.0.0.1:4174' \
  "$playwright_bin" test --config tests/playwright/playwright.config.ts --list \
  >"$error_output" 2>&1; then
  fail 'duplicate browser project identifier was accepted'
fi
grep -Fq 'duplicate HARNESS_BASE_URLS contestant id' "$error_output" \
  || fail 'duplicate-project rejection was unclear'

if HARNESS_ACCEPTANCE_SPEC='../todo.spec.ts' \
  "$playwright_bin" test --config tests/playwright/playwright.config.ts --list \
  >"$error_output" 2>&1; then
  fail 'unsafe browser acceptance spec was accepted'
fi
grep -Fq 'invalid HARNESS_ACCEPTANCE_SPEC' "$error_output" \
  || fail 'unsafe acceptance-spec rejection was unclear'

printf 'playwright matrix: PASS\n'
