#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'headless contract matrix: FAIL: %s\n' "$1" >&2
  exit 1
}

normalize_make_output() {
  sed -E 's/[[:space:]]+$//' | sed '/^$/d'
}

bash -n \
  scripts/verify-headless-contracts \
  scripts/verify-headless-live-contracts \
  tests/headless_contract_matrix.sh \
  || fail 'shell syntax check failed'

static_recipe="$(make --no-print-directory -n headless-matrix | normalize_make_output)"
[[ "$static_recipe" == 'scripts/verify-headless-contracts' ]] \
  || fail "unexpected headless-matrix recipe: $static_recipe"

argument_recipe="$(make --no-print-directory -n headless-matrix \
  HEADLESS_MATRIX_ARGS=--live | normalize_make_output)"
[[ "$argument_recipe" == 'scripts/verify-headless-contracts --live' ]] \
  || fail "HEADLESS_MATRIX_ARGS did not reach the verifier: $argument_recipe"

live_recipe="$(make --no-print-directory -n headless-matrix-live | normalize_make_output)"
[[ "$live_recipe" == 'scripts/verify-headless-contracts --live' ]] \
  || fail "unexpected headless-matrix-live recipe: $live_recipe"

test_recipe="$(make --no-print-directory -n headless-matrix-test | normalize_make_output)"
[[ "$test_recipe" == 'bash tests/headless_contract_matrix.sh' ]] \
  || fail "unexpected headless-matrix-test recipe: $test_recipe"

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-headless-matrix-test.XXXXXX")"
trap 'rm -rf -- "$temp_root"' EXIT

status=0
scripts/verify-headless-contracts invalid >"$temp_root/usage.out" 2>"$temp_root/usage.err" \
  || status=$?
[[ "$status" -eq 2 ]] || fail "invalid verifier usage returned $status instead of 2"
grep -Fqx 'Usage: scripts/verify-headless-contracts [--live]' "$temp_root/usage.err" \
  || fail 'invalid verifier usage diagnostic differs'

status=0
TRELLAGE_HEADLESS_LIVE_TIMEOUT_SECONDS=0 \
  scripts/verify-headless-live-contracts >"$temp_root/live.out" 2>"$temp_root/live.err" \
  || status=$?
[[ "$status" -eq 1 ]] || fail "invalid live timeout returned $status instead of 1"
grep -Fqx \
  'verify-headless-live-contracts: TRELLAGE_HEADLESS_LIVE_TIMEOUT_SECONDS must be an integer from 1 through 600' \
  "$temp_root/live.err" || fail 'invalid live timeout diagnostic differs'
[[ ! -s "$temp_root/live.out" ]] || fail 'invalid live timeout wrote stdout'

jq -e '
  (.profiles.council.description | startswith("Native Claude Code Council"))
  and .profiles.council.headless == null
' prototypes/trellage-claude-profiles/catalog.json >/dev/null \
  || fail 'Claude Council is missing from the Native profile catalog'

ledger='docs/headless-evidence.json'
jq -e '
  .schemaVersion == 1
  and .capabilitySchemaVersion == 1
  and ([.contracts[].id] | sort) == [
    "native-claude-2.1.233",
    "native-copilot-1.0.81",
    "native-omp-copilot-18.0.10",
    "native-pi-0.84.2"
  ]
  and all(.contracts[]; .liveEvidence.recorded == true)
  and any(.contracts[];
    .id == "native-omp-copilot-18.0.10"
    and .capabilities.questionToolControl == "prompt-only"
  )
  and all(.contracts[];
    .capabilities.testedHarnessVersion != null
    and (.deterministicEvidence | length > 0)
  )
' "$ledger" >/dev/null || fail 'evidence ledger summary differs'

while IFS= read -r evidence_path; do
  [[ -f "$evidence_path" && ! -L "$evidence_path" ]] \
    || fail "unsafe or missing deterministic evidence path: $evidence_path"
done < <(jq -r '.contracts[].deterministicEvidence[].path' "$ledger" | sort -u)

headless_section="$({
  awk '
    /^## Headless Contract Matrix$/ { in_section = 1; next }
    in_section && /^## / { exit }
    in_section { print }
  ' README.md
})"
[[ -n "$headless_section" ]] || fail 'README lacks the Headless Contract Matrix section'
for documented_command in \
  'scripts/verify-headless-contracts' \
  'make headless-matrix' \
  'make headless-matrix-test' \
  'scripts/verify-headless-contracts --live' \
  'make headless-matrix-live'; do
  grep -Fxq "$documented_command" <<<"$headless_section" \
    || fail "README lacks exact command: $documented_command"
done

grep -Fq 'docs/headless-evidence.json' scripts/verify-headless-contracts \
  || fail 'deterministic verifier does not load the evidence ledger'
grep -Fq 'scripts/verify-headless-live-contracts' scripts/verify-headless-contracts \
  || fail 'live verifier is not isolated behind the opt-in branch'
printf 'headless contract matrix: PASS\n'
