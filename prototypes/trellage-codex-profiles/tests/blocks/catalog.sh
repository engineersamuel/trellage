#!/usr/bin/env bash

# Block C: catalog validation. Every command here is rejected before the
# launcher reaches Codex or any profile state, so a bare scaffold is enough.

set -u
set -o pipefail

blocks_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$blocks_dir/../lib/fixture.sh"

build_fixture_profiles
write_fake_bin


[ "$(grep -Fc -- '3.3.101' "$fixture_common_launcher")" -eq 0 ] \
  || fail 'launcher duplicates the HVE adapter version literal'
[ "$(grep -Fc -- 'https://github.com/obra/superpowers.git' "$fixture_common_launcher")" -eq 1 ] \
  || fail 'launcher does not centralize the Superpowers plugin repository'

restore_catalog() {
  cp "$catalog" "$fixture_catalog" || fail 'could not restore copied catalog'
}

assert_invalid_catalog_command() {
  label="$1"
  shift
  command_name="$1"
  shift
  output="$fixture_root/invalid-catalog-$label-$command_name.out"
  if HOME="$fixture_root/home" PATH="$fake_bin:$PATH" FAKE_CODEX_LOG="$fixture_root/fake-codex.log" \
    "$fixture_launcher" "$@" >"$output" 2>&1; then
    fail "untrusted catalog accepted for $label via $command_name"
  else
    status=$?
    [ "$status" -eq 1 ] || fail "untrusted catalog exit for $label via $command_name was $status, expected 1"
  fi
  grep -F -- 'cdx: invalid catalog:' "$output" >/dev/null \
    || fail "untrusted catalog was not rejected for $label via $command_name"
  grep -F -- 'not implemented' "$output" >/dev/null \
    && fail "untrusted catalog reached deferred path for $label via $command_name"
}

assert_catalog_rejected() {
  label="$1"
  rm -f "$fixture_root/fake-codex.log"
  assert_invalid_catalog_command "$label" list list
  assert_invalid_catalog_command "$label" deferred setup hve
  [ ! -e "$fixture_root/fake-codex.log" ] || fail "untrusted catalog invoked fake Codex for $label"
}

mutate_catalog() {
  label="$1"
  filter="$2"
  restore_catalog
  jq "$filter" "$fixture_catalog" >"$fixture_root/$label.json" \
    || fail "could not create $label catalog"
  mv "$fixture_root/$label.json" "$fixture_catalog"
  assert_catalog_rejected "$label"
}

restore_catalog
printf '{\n' >"$fixture_catalog"
assert_catalog_rejected malformed-json

restore_catalog
: >"$fixture_catalog"
assert_catalog_rejected zero-documents

restore_catalog
printf '\n' >>"$fixture_catalog"
cat "$catalog" >>"$fixture_catalog"
assert_catalog_rejected multiple-documents

mutate_catalog renamed-profile '.profiles.renamed = .profiles.hve | del(.profiles.hve)'
mutate_catalog missing-profile 'del(.profiles.hve)'
mutate_catalog extra-profile '.profiles.extra = .profiles.hve'
mutate_catalog changed-source '.profiles.hve.marketplaceSource = "other/source"'
mutate_catalog changed-kind '.profiles.hve.marketplaceKind = "git"'
mutate_catalog changed-name '.profiles.hve.marketplaceName = "other-marketplace"'
mutate_catalog changed-manifest '.profiles.hve.manifestUrl = "https://example.com/marketplace.json"'
mutate_catalog changed-upstream-repository '.profiles.hve.upstreamRepository = "https://example.com/hve.git"'
mutate_catalog changed-upstream-path '.profiles.hve.upstreamSkillsPath = ".github/other"'
mutate_catalog changed-plugin '.profiles.hve.plugin = "other@hve-core"'
mutate_catalog changed-headless-question '.profiles.hve.headless.questionToolControl = "invalid"'
mutate_catalog changed-headless-tested-version '.profiles.hve.headless.testedHarnessVersion = 1'
mutate_catalog wrong-type '.profiles.hve.plugin = 1'
mutate_catalog extra-profile-field '.profiles.hve.untrusted = "value"'
mutate_catalog changed-pstack-source '.profiles.pstack.marketplaceSource = "other/source"'
mutate_catalog changed-pstack-kind '.profiles.pstack.marketplaceKind = "git"'
mutate_catalog changed-pstack-name '.profiles.pstack.marketplaceName = "other-marketplace"'
mutate_catalog changed-pstack-upstream '.profiles.pstack.upstreamRepository = "https://example.com/pstack.git"'
mutate_catalog changed-pstack-plugin '.profiles.pstack.plugin = "other@pstack-for-codex-local"'
mutate_catalog changed-superpowers-source '.profiles.superpowers.marketplaceSource = "other/source"'
mutate_catalog changed-superpowers-kind '.profiles.superpowers.marketplaceKind = "local-adapter"'
mutate_catalog changed-superpowers-name '.profiles.superpowers.marketplaceName = "other-marketplace"'
mutate_catalog changed-superpowers-upstream '.profiles.superpowers.upstreamRepository = "https://example.com/superpowers-marketplace.git"'
mutate_catalog changed-superpowers-manifest '.profiles.superpowers.manifestUrl = "https://example.com/marketplace.json"'
mutate_catalog changed-superpowers-plugin '.profiles.superpowers.plugin = "other@superpowers-marketplace"'
mutate_catalog changed-superpowers-headless-output '.profiles.superpowers.headless.outputFormats = ["text", "xml"]'
mutate_catalog extra-superpowers-field '.profiles.superpowers.untrusted = "value"'

printf 'trellage Codex catalog contract: PASS\n'
