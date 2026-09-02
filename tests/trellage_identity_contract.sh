#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fail() { printf 'trellage identity contract: FAIL: %s\n' "$1" >&2; exit 1; }

legacy_identity_pattern='@sandbox-harness|harness-(grok-)?profiles|harness-profile|harness-enter|HARNESS_PROFILE|HARNESS_IMAGE|HARNESS_NETWORK|HARNESS_INSTALL_DIR|dev\.sandbox-harness|/(usr/local/)?share/harness|harness-(codex|copilot)-entry'

scan_legacy_identity() {
  local scan_status
  if rg -n "$legacy_identity_pattern" "$@"; then
    scan_status=0
  else
    scan_status=$?
  fi

  case "$scan_status" in
    0)
      printf 'trellage identity contract: legacy product identity matched\n' >&2
      return 1
      ;;
    1) return 0 ;;
    *)
      printf 'trellage identity contract: rg audit failed with status %s\n' \
        "$scan_status" >&2
      return "$scan_status"
      ;;
  esac
}

scan_public_branding() {
  local scan_status
  if rg -n -F 'sandbox-harness' "$@"; then
    scan_status=0
  else
    scan_status=$?
  fi

  case "$scan_status" in
    0)
      printf 'trellage identity contract: legacy public product branding matched\n' >&2
      return 1
      ;;
    1) return 0 ;;
    *)
      printf 'trellage identity contract: public brand rg audit failed with status %s\n' \
        "$scan_status" >&2
      return "$scan_status"
      ;;
  esac
}

[[ -d "$repo_root/packages/trellage-cli" ]] || fail 'compiler package path is missing'
[[ ! -e "$repo_root/packages/harness-cli" ]] || fail 'legacy compiler package path remains'
[[ -d "$repo_root/prototypes/trellage-codex-profiles" ]] \
  || fail 'Codex profiles prototype path is missing'
[[ -d "$repo_root/prototypes/trellage-codex-common" ]] \
  || fail 'shared native Codex prototype path is missing'
[[ ! -e "$repo_root/prototypes/trellage-pstack-profiles" ]] \
  || fail 'standalone pstack launcher prototype remains'
[[ -d "$repo_root/prototypes/trellage-copilot-profiles" ]] \
  || fail 'Copilot profiles prototype path is missing'
[[ -d "$repo_root/prototypes/trellage-agency-profiles" ]] \
  || fail 'Agency profiles prototype path is missing'
[[ -d "$repo_root/prototypes/trellage-claude-profiles" ]] \
  || fail 'Claude profile prototype path is missing'
[[ -d "$repo_root/prototypes/trellage-claude-common" ]] \
  || fail 'shared native Claude prototype path is missing'
[[ -d "$repo_root/prototypes/trellage-firstmate-profiles" ]] \
  || fail 'Firstmate profiles prototype path is missing'
[[ ! -e "$repo_root/prototypes/trellage-profiles" ]] \
  || fail 'ambiguous legacy Copilot profiles prototype path remains'
[[ -d "$repo_root/prototypes/trellage-grok-profiles" ]] || fail 'Grok profiles prototype path is missing'
[[ -d "$repo_root/prototypes/trellage-jcode-profiles" ]] || fail 'jcode profile prototype path is missing'
[[ ! -e "$repo_root/prototypes/harness-profiles" ]] || fail 'legacy Copilot profiles prototype path remains'
[[ ! -e "$repo_root/prototypes/harness-grok-profiles" ]] || fail 'legacy Grok profiles prototype path remains'
[[ -x "$repo_root/prototypes/trellage/trellage" ]] || fail 'Trellage command is missing'
[[ -x "$repo_root/prototypes/trellage/install-trellage.sh" ]] || fail 'Trellage installer is missing'
[[ ! -e "$repo_root/prototypes/harness-enter-codex" ]] || fail 'legacy prototype path remains'
[[ ! -e "$repo_root/prototypes/trellage/harness" ]] || fail 'legacy command remains'

grep -Fqx '  "name": "@trellage/profile-compiler",' \
  "$repo_root/packages/trellage-cli/package.json" || fail 'npm package identity is stale'
grep -Fq '"trellage-profile": "dist/cli.js"' \
  "$repo_root/packages/trellage-cli/package.json" || fail 'npm binary identity is stale'
grep -Fq 'cd packages/trellage-cli' "$repo_root/Makefile" \
  || fail 'Makefile compiler path is stale'
grep -Fq 'cd prototypes/trellage' "$repo_root/Makefile" \
  || fail 'Makefile prototype path is stale'
grep -Fq 'bash prototypes/trellage/tests/claude_entry_contract.sh' "$repo_root/Makefile" \
  || fail 'Makefile does not run the Claude entry contract'
grep -Fq 'bash prototypes/trellage/tests/prime_entry_contract.sh' "$repo_root/Makefile" \
  || fail 'Makefile does not run the Prime entry contract'
for target in native-codex-catalog native-codex-installation native-codex-pstack native-copilot-profiles native-agency-profile native-claude-profile native-firstmate-profile native-jcode-profile; do
  grep -Eq "^\\.PHONY:.* ${target}( |$)" "$repo_root/Makefile" \
    || fail "Makefile does not declare ${target} phony"
  grep -Eq "^PARALLEL_TEST_TARGETS :=.* ${target}( |$)" "$repo_root/Makefile" \
    || fail "Makefile test does not run ${target}"
done
for target in native-codex-auth-config-launch native-codex-lifecycle native-grok-profiles; do
  grep -Eq "^\\.PHONY:.* ${target}( |$)" "$repo_root/Makefile" \
    || fail "Makefile does not declare ${target} phony"
  grep -Eq "^TIMING_SENSITIVE_TEST_TARGETS :=.* ${target}( |$)" "$repo_root/Makefile" \
    || fail "Makefile test does not isolate ${target}"
done
for block in auth-config-launch lifecycle catalog installation pstack; do
  grep -Fqx $'\tbash prototypes/trellage-codex-profiles/tests/blocks/'"$block"'.sh' \
    "$repo_root/Makefile" || fail "Makefile Codex ${block} target is stale"
done
grep -Fqx $'\tbash prototypes/trellage-copilot-profiles/tests/contract.sh' \
  "$repo_root/Makefile" || fail 'Makefile Copilot profiles target is stale'
grep -Fqx $'\tbash prototypes/trellage-agency-profiles/tests/contract.sh' \
  "$repo_root/Makefile" || fail 'Makefile Agency profile target is stale'
grep -Fqx $'\tbash prototypes/trellage-claude-profiles/tests/contract.sh' \
  "$repo_root/Makefile" || fail 'Makefile Claude profile target is stale'
grep -Fqx $'\tbash prototypes/trellage-firstmate-profiles/tests/contract.sh' \
  "$repo_root/Makefile" || fail 'Makefile Firstmate profile target is stale'
grep -Fqx $'\tbash prototypes/trellage-grok-profiles/tests/contract.sh' \
  "$repo_root/Makefile" || fail 'Makefile Grok profiles target is stale'
grep -Fqx $'\tbash prototypes/trellage-jcode-profiles/tests/contract.sh' \
  "$repo_root/Makefile" || fail 'Makefile jcode profile target is stale'

audit_error_output="$(mktemp "${TMPDIR:-/tmp}/trellage-identity-audit-error.XXXXXX")"
public_brand_error_output="$(mktemp "${TMPDIR:-/tmp}/trellage-public-brand-audit-error.XXXXXX")"
public_brand_match_input="$(mktemp "${TMPDIR:-/tmp}/trellage-public-brand-audit-match.XXXXXX")"
trap 'rm -f -- "$audit_error_output" "$public_brand_error_output" "$public_brand_match_input"' EXIT
if scan_legacy_identity "$repo_root/.missing-trellage-audit-path" \
  >"$audit_error_output" 2>&1; then
  fail 'identity audit accepted an rg operational error as clean'
else
  audit_error_status=$?
fi
[[ "$audit_error_status" -ge 2 ]] \
  || fail 'identity audit collapsed an rg operational error into a clean or match status'
grep -Fq 'trellage identity contract: rg audit failed with status ' \
  "$audit_error_output" \
  || fail 'identity audit did not report its rg operational error'

printf '%s%s\n' 'sandbox-' 'harness' >"$public_brand_match_input"
if scan_public_branding "$public_brand_match_input" \
  >"$public_brand_error_output" 2>&1; then
  fail 'public brand audit accepted legacy product branding'
else
  public_brand_match_status=$?
fi
[[ "$public_brand_match_status" -eq 1 ]] \
  || fail 'public brand audit did not classify a legacy match as a contract failure'
grep -Fq 'trellage identity contract: legacy public product branding matched' \
  "$public_brand_error_output" \
  || fail 'public brand audit did not report its legacy match'

if scan_public_branding "$repo_root/.missing-trellage-public-brand-audit-path" \
  >"$public_brand_error_output" 2>&1; then
  fail 'public brand audit accepted an rg operational error as clean'
else
  public_brand_error_status=$?
fi
[[ "$public_brand_error_status" -ge 2 ]] \
  || fail 'public brand audit collapsed an rg operational error into a clean or match status'
grep -Fq 'trellage identity contract: public brand rg audit failed with status ' \
  "$public_brand_error_output" \
  || fail 'public brand audit did not report its rg operational error'

scan_legacy_identity \
  "$repo_root/packages/trellage-cli/src" \
  "$repo_root/prototypes/trellage/trellage" \
  "$repo_root/prototypes/trellage/install-trellage.sh" \
  "$repo_root/prototypes/trellage/adapt-agent-kit.sh" \
  "$repo_root/prototypes/trellage/build-image.sh" \
  "$repo_root/prototypes/trellage/runtime-entry.sh" \
  "$repo_root/prototypes/trellage/runtime-copilot-entry.sh" \
  "$repo_root/prototypes/trellage/runtime-claude-entry.sh" \
  "$repo_root/prototypes/trellage/runtime-prime-entry.sh" \
  "$repo_root/prototypes/trellage/finalize-copilot-seed.mjs" \
  "$repo_root/prototypes/trellage/mise.toml" \
  "$repo_root/prototypes/trellage-codex-profiles" \
  "$repo_root/prototypes/trellage-codex-common" \
  "$repo_root/prototypes/trellage-copilot-profiles" \
  "$repo_root/prototypes/trellage-agency-profiles" \
  "$repo_root/prototypes/trellage-claude-common" \
  "$repo_root/prototypes/trellage-claude-profiles" \
  "$repo_root/prototypes/trellage-firstmate-profiles" \
  "$repo_root/prototypes/trellage-grok-profiles" \
  "$repo_root/prototypes/trellage-jcode-profiles" \
  "$repo_root/Makefile" \
  || fail 'legacy product identity remains or the operational audit failed'

scan_public_branding \
  "$repo_root/compose.yaml" \
  "$repo_root/compose.copilot.yaml" \
  "$repo_root/scripts/harness" \
  "$repo_root/tests/playwright/package.json" \
  "$repo_root/tests/playwright/package-lock.json" \
  "$repo_root/tests/copilot_agent_image.sh" \
  || fail 'legacy product branding remains or the public root audit failed'

printf 'trellage identity contract: PASS\n'
