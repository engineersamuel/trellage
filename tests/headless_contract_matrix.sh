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
TRELLAGE_HEADLESS_SANDBOX_PROFILE= \
  scripts/verify-headless-live-contracts >"$temp_root/live.out" 2>"$temp_root/live.err" \
  || status=$?
[[ "$status" -eq 1 ]] || fail "unconfigured live driver returned $status instead of 1"
grep -Fqx \
  'verify-headless-live-contracts: set TRELLAGE_HEADLESS_SANDBOX_PROFILE to a verified Claude profile' \
  "$temp_root/live.err" || fail 'unconfigured live driver diagnostic differs'
[[ ! -s "$temp_root/live.out" ]] || fail 'unconfigured live driver wrote stdout'

status=0
TRELLAGE_HEADLESS_SANDBOX_PROFILE=tests/fixtures/headless-live-claude/profile.toml \
TRELLAGE_HEADLESS_SANDBOX_VERSION= \
  scripts/verify-headless-live-contracts >"$temp_root/live-version.out" 2>"$temp_root/live-version.err" \
  || status=$?
[[ "$status" -eq 1 ]] || fail "unconfigured live version returned $status instead of 1"
grep -Fqx \
  'verify-headless-live-contracts: set TRELLAGE_HEADLESS_SANDBOX_VERSION to the exact verified Claude version' \
  "$temp_root/live-version.err" || fail 'unconfigured live version diagnostic differs'
[[ ! -s "$temp_root/live-version.out" ]] || fail 'unconfigured live version wrote stdout'

status=0
TRELLAGE_HEADLESS_SANDBOX_PROFILE=tests/fixtures/headless-live-claude/profile.toml \
TRELLAGE_HEADLESS_SANDBOX_VERSION=2.1.229 \
TRELLAGE_HEADLESS_LIVE_SCOPE=invalid \
  scripts/verify-headless-live-contracts >"$temp_root/live-scope.out" 2>"$temp_root/live-scope.err" \
  || status=$?
[[ "$status" -eq 1 ]] || fail "invalid live scope returned $status instead of 1"
grep -Fqx \
  'verify-headless-live-contracts: TRELLAGE_HEADLESS_LIVE_SCOPE must be all or sandbox' \
  "$temp_root/live-scope.err" || fail 'invalid live scope diagnostic differs'
[[ ! -s "$temp_root/live-scope.out" ]] || fail 'invalid live scope wrote stdout'

live_profile='tests/fixtures/headless-live-claude/profile.toml'
live_lock='tests/fixtures/headless-live-claude/profile.linux-arm64.lock.toml'
[[ -f "$live_profile" && ! -L "$live_profile" ]] \
  || fail "missing or unsafe Sandbox live profile: $live_profile"
[[ -f "$live_lock" && ! -L "$live_lock" ]] \
  || fail "missing or unsafe Sandbox live lock: $live_lock"
grep -Fqx 'version = "2.1.229"' "$live_profile" \
  || fail 'Sandbox live profile does not pin Claude 2.1.229'
grep -Fqx 'version = "2.1.229"' "$live_lock" \
  || fail 'Sandbox live lock does not resolve Claude 2.1.229'
grep -Eq '^final_digest = "sha256:[0-9a-f]{64}"$' "$live_lock" \
  || fail 'Sandbox live lock has no final image digest'

council_profile='profiles/claude-council/profile.toml'
grep -Fqx 'version = "latest"' "$council_profile" \
  || fail 'Council development profile does not select the latest stable Claude release'
[[ ! -e 'profiles/claude-council/profile.linux-arm64.lock.toml' ]] \
  || fail 'Council development profile unexpectedly commits a release lock'

ledger='docs/headless-evidence.json'
jq -e '
  .schemaVersion == 1
  and .capabilitySchemaVersion == 1
  and ([.contracts[].id] | sort) == [
    "native-claude-2.1.233",
    "native-copilot-1.0.81",
    "native-omp-copilot-18.0.10",
    "native-pi-0.84.2",
    "sandbox-claude-core-2.1.229",
    "sandbox-claude-hyperresearch-2.1.229",
    "sandbox-claude-marketplace-2.1.251"
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

if [[ "${TRELLAGE_HEADLESS_SKIP_PUBLICATION_TEST-}" != 1 ]]; then
  (
    cd packages/trellage-cli
    npm test -- --run test/headless-publication.test.ts
  ) || fail 'publication gate test failed'
fi

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
  'TRELLAGE_HEADLESS_SANDBOX_VERSION=2.1.229 \' \
  '  scripts/verify-headless-contracts --live' \
  '  make headless-matrix-live'; do
  grep -Fxq "$documented_command" <<<"$headless_section" \
    || fail "README lacks exact command: $documented_command"
done

grep -Fq 'docs/headless-evidence.json' scripts/verify-headless-contracts \
  || fail 'deterministic verifier does not load the evidence ledger'
grep -Fq 'scripts/verify-headless-live-contracts' scripts/verify-headless-contracts \
  || fail 'live verifier is not isolated behind the opt-in branch'
grep -Fq 'prototypes/trellage-firstmate-profiles/tests/contract.sh' \
  scripts/verify-headless-contracts \
  || fail 'deterministic verifier does not run the Firstmate headless contract'

printf 'headless contract matrix: PASS\n'
