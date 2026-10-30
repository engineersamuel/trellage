#!/usr/bin/env bash
set -euo pipefail

unset TRELLAGE_TRX_SOURCE_ROOT TRELLAGE_TRX_NATIVE_SOURCE
unset TRELLAGE_NATIVE_COMPOSITION_HARNESS TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT

prototype_root="$(cd -P "$(dirname "$0")/.." && pwd -P)"
. "$prototype_root/../../tests/helpers/floating_skills_fixture.sh"
fixture_root="$prototype_root/.contract-fixture.$$"
fixture_home="$fixture_root/home"
fixture_bin="$fixture_home/.local/bin"
runtime_parent="$fixture_home/.local/share/trellage"
argument_log="$fixture_root/arguments.bin"
inventory_log="$fixture_root/inventory.log"
upgrade_log="$fixture_root/upgrade.log"
skills_update_log="$fixture_root/skills-update.log"
skills_cache_log="$fixture_root/skills-cache.jsonl"
discovery_log="$fixture_root/discovery.log"
real_node="$(mise which node --tool=node@24 2>/dev/null || command -v node)"
real_bun="$(command -v bun)"
real_jq="$(command -v jq)"
fixture_source="$runtime_parent/trx/source"
fixture_picker="$fixture_source/packages/trellage-launcher/src/cli.tsx"

refresh_fixture_source() {
  "$real_bun" --no-install --no-env-file \
    "--config=$prototype_root/../../packages/trellage-runtime/bunfig.toml" \
    "$prototype_root/../../packages/trellage-runtime/test/refresh-fixture.ts" "${1:-$fixture_source}"
}

cleanup() {
  if [[ "${TRX_KEEP_FIXTURE-}" == 1 ]]; then
    printf 'trx contract fixture: %s\n' "$fixture_root" >&2
    return
  fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fail() {
  printf 'trx contract: FAIL: %s\n' "$1" >&2
  exit 1
}

fixture_registry="$(npm config get registry --workspaces=false)" \
  || fail 'could not discover the host npm registry'
[[ -n "$fixture_registry" ]] || fail 'host npm registry is empty'
export BUN_INSTALL_CACHE_DIR="${TRELLAGE_TEST_PACKAGE_CACHE:-$fixture_root/bun-cache}"
export npm_config_registry="$fixture_registry"

assert_contains() {
  local expected="$1"
  local file="$2"
  grep -Fq -- "$expected" "$file" || fail "missing '$expected' in $file"
}

reset_upgrade_logs() {
  : >"$upgrade_log"
  : >"$skills_update_log"
  : >"$skills_cache_log"
}

assert_no_upgrade_mutation() {
  [[ ! -s "$upgrade_log" && ! -s "$skills_update_log" && ! -s "$skills_cache_log" ]] \
    || fail "$1 started a harness update, skill update, or dependency bootstrap"
}

assert_native_skills_refreshed() {
  jq -se --arg router "$runtime_parent/trx/bin/trx" '
    length == 1 and all(.[]; .args == [] and .routerCommandPath == $router)
  ' "$skills_cache_log" >/dev/null || fail 'unified update did not refresh the configured skill maintenance once through its own router'
  [[ "$(wc -l <"$skills_update_log" | tr -d ' ')" == 21 ]] \
    || fail 'unified update did not copy every managed composition exactly once'
  [[ "$(sort -u "$skills_update_log" | wc -l | tr -d ' ')" == 21 ]] \
    || fail 'unified update copied a managed composition more than once'
}

mkdir -p "$fixture_home" "$fixture_bin"
export TMPDIR="$fixture_root"
seed_floating_skills_cache "$fixture_home"
seed_native_skills_fixture "$fixture_home"
"$real_bun" --no-env-file "$prototype_root/../../tests/helpers/native-preset-sources.ts" "$fixture_home" codex copilot
ln -s "$real_node" "$fixture_bin/node"
ln -s "$real_bun" "$fixture_bin/bun"
if [[ -n "${TRELLAGE_TEST_BIN-}" ]]; then
  ln -s "$TRELLAGE_TEST_BIN/ps" "$fixture_bin/ps"
fi
ln -s "$real_jq" "$fixture_bin/jq"
ln -s "$(command -v python3)" "$fixture_bin/python3"

create_native_launcher() {
  local launcher="$1"
  local harness="$2"
  local marker="$3"
  local marker_value="$4"
  local dest_root="${5:-$runtime_parent/$launcher}"
  local description_suffix="${6-}"
  local runtime="$dest_root"
  local description="$launcher$description_suffix"
  local standalone_mcps='[]'
  local profile_name="${launcher}-p"

  if [[ "$launcher" == agx ]]; then
    profile_name='trellage-azure'
  elif [[ "$launcher" == prx ]]; then
    profile_name='default'
  fi

  if [[ "$launcher" == cpx ]]; then
    printf -v description '%1200s' ''
    description="${description// /x}$description_suffix"
    standalone_mcps='["docs", {"name":"files","transport":"stdio"}]'
  fi


  mkdir -p "$runtime/bin"
  printf '%s\n' "$marker_value" >"$runtime/$marker"
  if [[ "$launcher" == omp ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "omp",
  "harness": "oh-my-pi",
  "profiles": [
    {
      "name": "copilot",
      "description": "Native GitHub Copilot",
      "headless": {
        "schemaVersion": 1,
        "prompt": true,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "prompt-only",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": "18.0.9"
      },
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": []
    },
    {
      "name": "local",
      "description": "Local Qwen",
      "headless": {
        "schemaVersion": 1,
        "prompt": false,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "none",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": null
      },
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": []
    }
  ]
}
EOF
  else
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "$launcher",
  "harness": "$harness",
  "profiles": [
    {
      "name": "$profile_name",
      "description": "$description",
      "headless": {
        "schemaVersion": 1,
        "prompt": true,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "none",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": "1.2.3"
      },
      "plugin": "${launcher}-plug",
      "source": null,
      "marketplace": null,
      "standaloneMcps": $standalone_mcps
    }
  ]
}
EOF
  fi
  cat >"$runtime/bin/$launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
runtime="$(cd -P "$(dirname "$0")/.." && pwd -P)"
  if [[ -n "${TRX_ENV_LOG-}" ]]; then
    if [[ -n "${TRANSCRIPT_API_KEY-}" || "${trx_transcript_api_key+x}" == x ]]; then
      printf '%s:true\n' "$(basename "$0")" >>"$TRX_ENV_LOG"
    else
      printf '%s:false\n' "$(basename "$0")" >>"$TRX_ENV_LOG"
    fi
  fi
  if [[ "${1-} ${2-}" == 'list --json' ]]; then
  if [[ -n "${TRX_CATALOG_ARGS_LOG-}" ]]; then
    printf '%s:%s\n' "$(basename "$0")" "$*" >>"$TRX_CATALOG_ARGS_LOG"
  fi
  if [[ -n "${TRX_DISCOVERY_LOG-}" ]]; then
    printf '%s\n' "$(basename "$0")" >>"$TRX_DISCOVERY_LOG"
  fi
  cat "$runtime/catalog.json"
  exit 0
fi
if [[ "${1-}" == --help ]]; then
  if [[ "${TRX_UPGRADE_LEGACY_LAUNCHER-}" == "$(basename "$0")" ]]; then
    printf 'Usage: launcher PROFILE [AGENT_ARGS]\n'
  elif [[ "${TRX_SKILLS_LEGACY_LAUNCHER-}" == "$(basename "$0")" ]]; then
    printf 'Usage: launcher harness-update\n'
  else
    printf 'Usage: launcher harness-update\nUsage: launcher skills-update PROFILE\n'
  fi
  exit 0
fi
if [[ "${1-}" == skills-update ]]; then
  [[ "$#" -eq 2 && -n "${TRX_SKILLS_UPDATE_LOG-}" ]] || exit 64
  launcher="$(basename "$0")"
  printf '%s:%s\n' "$launcher" "$*" >>"$TRX_SKILLS_UPDATE_LOG"
  if [[ "${TRX_SKILLS_UPDATE_FAIL-}" == "$launcher/$2" ]]; then
    printf 'fixture skill verification failed: %s/%s\n' "$launcher" "$2" >&2
    exit 9
  fi
  exit 0
fi
if [[ "${1-}" == harness-version ]]; then
  installed='"3.0.0"'
  [[ "${TRX_UPGRADE_VERSION_FAIL-}" != "$(basename "$0")" ]] || installed=null
  printf '{"schemaVersion":1,"installed":%s,"latestKnown":true,"latest":"3.0.0"}\n' "$installed"
  exit 0
fi
if [[ "${1-}" == harness-update || "${1-}" == update ]]; then
  [[ -n "${TRX_UPGRADE_LOG-}" ]] || exit 64
  launcher="$(basename "$0")"
  printf '%s:%s\n' "$launcher" "$*" >>"$TRX_UPGRADE_LOG"
  if [[ "${TRX_UPGRADE_FAIL-}" == "$launcher" ]]; then
    printf 'fixture harness update failed: %s\n' "$launcher" >&2
    exit 9
  fi
  if [[ "${TRX_UPGRADE_WAIT-}" == "$launcher" ]]; then
    while :; do sleep 1; done
  fi
  printf 'fixture harness updated: %s\n' "$launcher"
  exit 0
fi
if [[ "${1-}" == inventory && "${3-}" == --json ]]; then
  launcher="$(basename "$0")"
  sleep "${TRX_INVENTORY_DELAY-0}"
  if [[ -n "${TRX_INVENTORY_LOG-}" ]]; then
    printf '%s:%s\n' "$launcher" "$2" >>"$TRX_INVENTORY_LOG"
  fi
  package_count=2
  jq -cn \
    --arg launcher "$launcher" \
    --arg harness "$(jq -r .harness "$runtime/catalog.json")" \
    --arg profile "$2" \
    --arg readiness "${TRX_INVENTORY_READINESS:-healthy}" \
    --argjson packageCount "$package_count" \
    '{
      schemaVersion:1,
      launcher:$launcher,
      harness:$harness,
      profile:$profile,
      readiness:$readiness,
      plugins:[{name:($launcher + "-plug"),version:"1.2.3"}],
      skills:{packageCount:$packageCount,visibleCount:4},
      mcps:["docs","files"]
    } + (if $launcher == "agx" then {authenticationMethod:"azure-cli"} else {} end)'
  exit 0
fi
if [[ "$(basename "$0")" == cldx && "${1-}" == _trx-admit ]]; then
  [[ "${TRELLAGE_TRX_CLAUDE_ADAPTER:-0}" == 1 && "$#" -eq 2 ]] || exit 64
  printf '{"pluginDir":null}\n'
  exit 0
fi
if [[ "$(basename "$0")" == omp && "${1-}" == _trx-admit ]]; then
  [[ "${TRELLAGE_TRX_OMP_ADAPTER:-0}" == 1 && "$#" -eq 2 ]] || exit 64
  case "$2" in
    default) omp_profile=trellage-copilot-native ;;
    local) omp_profile=trellage-qwen-local ;;
    *) exit 64 ;;
  esac
  jq -cn \
    --arg executable "$runtime/bin/omp" \
    --arg ompProfile "$omp_profile" \
    --arg piConfigFiles "$runtime/omp-config.toml" \
    --arg version "18.8.5" \
    '{schemaVersion:1,executable:$executable,ompProfile:$ompProfile,piConfigFiles:$piConfigFiles,version:$version,copilotCredentialFile:null}'
  exit 0
fi
profile="${1-}"
shift || true
if [[ -n "${TRX_ARGUMENT_LOG-}" ]]; then
  {
    printf '%s\0' "$(basename "$0")" "$profile"
    if (( $# > 0 )); then
      printf '%s\0' "$@"
    fi
  } >"$TRX_ARGUMENT_LOG"
fi
if [[ "${TRX_WAIT-}" == 1 ]]; then
  printf 'CHILD_READY\n'
  while :; do sleep 1; done
fi
exit "${TRX_CHILD_EXIT-0}"
EOF
  chmod 0755 "$runtime/bin/$launcher"
  if [[ "$dest_root" == "$runtime_parent/$launcher" ]]; then
    ln -s "$runtime/bin/$launcher" "$fixture_bin/$launcher"
  fi
}

create_native_launcher cpx copilot .managed-by-trellage-profiles trellage-profiles-v1
ln -s "$runtime_parent/cpx/bin/cpx" "$fixture_bin/copilot"
create_native_launcher cldx claude .managed-by-trellage-claude-profiles trellage-claude-profiles-v1
create_native_launcher jcx jcode .managed-by-trellage-jcode-profiles trellage-jcode-profiles-v1
create_native_launcher omp oh-my-pi .managed-by-trellage-omp-profiles trellage-omp-profiles-v2
create_native_launcher prx prime .managed-by-trellage-prime-profiles trellage-prime-profiles-v1
create_native_launcher agx agency .managed-by-trellage-agency-profiles trellage-agency-profiles-v1
ln -s "$runtime_parent/cldx/bin/cldx" "$fixture_bin/claude"
ln -s "$runtime_parent/jcx/bin/jcx" "$fixture_bin/jcode"
ln -s "$runtime_parent/prx/bin/prx" "$fixture_bin/prime-agent"
ln -s "$runtime_parent/agx/bin/agx" "$fixture_bin/agency"

write_fixture_guide() {
  local launcher="$1"
  local profile="$2"
  local guide_harness="$launcher" guide_profile="$profile"
  case "$launcher" in cpx) guide_harness=copilot ;; cldx) guide_harness=claude ;; jcx) guide_harness=jcode ;; prx) guide_harness=prime ;; agx) guide_harness=agency; guide_profile=azure ;; omp) [[ "$profile" != copilot ]] || guide_profile=default ;; esac
  local destination="$runtime_parent/trx/share/profile-guides/native/$guide_harness/$guide_profile.md"

  mkdir -p "$(dirname "$destination")"
  cat >"$destination" <<'EOF'
---
schemaVersion: 1
capabilities:
  - fixture-delivery
bestFor:
  - Fixture delivery
  - Router integration tests
avoidFor:
  - Unrelated fixture work
  - Production profile selection
prerequisites: []
workflows:
  - id: deliver
    description: Deliver fixture work
    examples:
      - Build the fixture
      - Test the fixture
      - Review the fixture
    promptTemplate: |
      {{intent}}
---
# Fixture profile

Use this profile for router contract fixtures.
EOF
}

export HOME="$fixture_home"
export PATH="$fixture_bin:/usr/bin:/bin"
unset XDG_CONFIG_HOME TRELLAGE_CONFIG TRELLAGE_ENVIRONMENT TYPESAFE_API_KEY _TRELLAGE_JEV_API_KEY

"$prototype_root/install.sh" >"$fixture_root/install.out"
[[ -L "$fixture_bin/trx" ]] || fail 'installer did not publish trx command symlink'
[[ "$(readlink "$fixture_bin/trx")" == "$runtime_parent/trx/bin/trx" ]] \
  || fail 'installer published the wrong trx command target'
cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v3\n') \
  || fail 'installer ownership marker differs'
assert_contains 'Installed trx' "$fixture_root/install.out"

printf 'trellage-router-v3\n' \
  >"$runtime_parent/trx/.managed-by-trellage-router"
cat >"$runtime_parent/trx/bin/trx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
launcher="$0"
if [[ -L "$launcher" ]]; then
  launcher="$(readlink "$launcher")"
fi
runtime="$(cd -P "$(dirname "$launcher")/.." && pwd -P)"
[[ "$(<"$runtime/.managed-by-trellage-router")" == trellage-router-v3 ]] \
  || exit 1
printf 'trx-v3-fixture\n'
EOF
chmod 0755 "$runtime_parent/trx/bin/trx"
[[ "$("$fixture_bin/trx" --version)" == trx-v3-fixture ]] \
  || fail 'current router fixture was not usable before reinstall'
mkdir "$runtime_parent/.trx-install.lock"
if "$prototype_root/install.sh" >"$fixture_root/reinstall-lock.out" 2>&1; then
  fail 'router install unexpectedly ignored an active install lock'
fi
assert_contains \
  'another router install is in progress' \
  "$fixture_root/reinstall-lock.out"
[[ "$("$fixture_bin/trx" --version)" == trx-v3-fixture ]] \
  || fail 'lock refusal changed the usable current router'
rmdir "$runtime_parent/.trx-install.lock"
if TRX_INSTALL_TEST_FAIL_AT=after-runtime-publication \
  "$prototype_root/install.sh" >"$fixture_root/reinstall-failure.out" 2>&1; then
  fail 'injected router publication failure unexpectedly succeeded'
fi
assert_contains \
  'injected failure at after-runtime-publication' \
  "$fixture_root/reinstall-failure.out"
cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v3\n') \
  || fail 'failed reinstall did not restore the ownership marker'
[[ "$("$fixture_bin/trx" --version)" == trx-v3-fixture ]] \
  || fail 'failed reinstall did not restore the usable router'
[[ ! -e "$runtime_parent/.trx-install.lock" ]] \
  || fail 'failed reinstall left the router install lock behind'
"$prototype_root/install.sh" >"$fixture_root/reinstall.out"
cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v3\n') \
  || fail 'repeat install changed the router ownership marker'
[[ -x "$runtime_parent/trx/bin/trx" ]] || fail 'repeat install removed launcher'
[[ -f "$fixture_picker" ]] \
  || fail 'upgrade did not install the Ink launcher'
[[ -x "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" ]] \
  || fail 'upgrade did not install the dependency bootstrap'
[[ -f "$runtime_parent/trx/share/profile-guides/native/copilot/awesome.md" ]] \
  || fail 'installer did not publish profile guides'

rm -rf -- "$runtime_parent/trx/share/profile-guides"
for pair in \
  cpx:cpx-p \
  cldx:cldx-p \
  fx:default \
  jcx:jcx-p \
  omp:copilot \
  omp:local \
  prx:default \
  agx:trellage-azure \
  headlong:default; do
  write_fixture_guide "${pair%%:*}" "${pair#*:}"
done
write_fixture_guide claude firstmate
write_fixture_guide pi firstmate
export TRELLAGE_TRX_GUIDE_ROOT="$runtime_parent/trx/share/profile-guides"

for mapping in \
  cpx:trellage-copilot-profiles \
  cldx:trellage-claude-profiles \
  jcx:trellage-jcode-profiles \
  omp:trellage-omp-profiles \
  prx:trellage-prime-profiles \
  agx:trellage-agency-profiles; do
  fixture_launcher="${mapping%%:*}"
  source_package="${mapping#*:}"
  cp "$runtime_parent/$fixture_launcher/catalog.json" \
    "$runtime_parent/trx/source/prototypes/$source_package/catalog.json"
done
refresh_fixture_source

"$fixture_bin/trx" --help >"$fixture_root/help.out"
assert_contains 'trx list [--json]' "$fixture_root/help.out"
assert_contains 'trx run HARNESS [PROFILE...] [OPTIONS] [-- ARGS...]' "$fixture_root/help.out"
assert_contains 'trx guide [INTENT]' "$fixture_root/help.out"
assert_contains 'trx guide --review' "$fixture_root/help.out"
assert_contains 'trx guide --preview' "$fixture_root/help.out"
assert_contains 'trx guide --forks [tabs|inline]' "$fixture_root/help.out"
assert_contains 'trx guide --prompts' "$fixture_root/help.out"
assert_contains 'trx inventory HARNESS [PROFILE...] [--no-always] --json' "$fixture_root/help.out"
assert_contains 'trx doctor|setup|repair HARNESS PROFILE' "$fixture_root/help.out"
assert_contains 'trx skill jcode SKILL PROMPT' "$fixture_root/help.out"
assert_contains 'trx skills update [--check | --upgrade-pins]' "$fixture_root/help.out"
assert_contains 'trx admin' "$fixture_root/help.out"
assert_contains 'trx upgrade all [--yes | --dry-run]' "$fixture_root/help.out"
assert_contains 'trx upgrade HARNESS [--all | PROFILE]' "$fixture_root/help.out"
assert_contains 'Bare trx opens the run composer.' "$fixture_root/help.out"

for retired_args in '--profile agency' '--profile=agency'; do
  status=0
  "$fixture_bin/trx" $retired_args >"$fixture_root/retired-route.out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || fail "retired route succeeded: $retired_args"
  assert_contains 'use: trx run HARNESS [PROFILE...] [-- ARGS...]' "$fixture_root/retired-route.out"
done
for retired_harness in cpx; do
  status=0
  "$fixture_bin/trx" run "$retired_harness" default >"$fixture_root/retired-harness.out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || fail "retired harness succeeded: $retired_harness"
  assert_contains "unknown harness: $retired_harness" "$fixture_root/retired-harness.out"
done

"$fixture_bin/trx" guide --help >"$fixture_root/guide-help.out"
assert_contains 'PROFILE_REF is native:<harness>/<profile>[+<profile>...].' \
  "$fixture_root/guide-help.out"
assert_contains 'schemaVersion 2' "$fixture_root/guide-help.out"
assert_contains 'INTENT can contain line breaks and accepts up to 60,000 characters.' \
  "$fixture_root/guide-help.out"
assert_contains 'Interactive prompt viewers: pager, split, focus, bookends, dashboard.' \
  "$fixture_root/guide-help.out"
assert_contains 'trx guide --preview' "$fixture_root/guide-help.out"
assert_contains 'trx guide --prompts' "$fixture_root/guide-help.out"
assert_contains 'Opening the list copies nothing.' "$fixture_root/guide-help.out"
assert_contains 'trx guide --forks' "$fixture_root/guide-help.out"
assert_contains 'trx guide --next-steps' "$fixture_root/guide-help.out"
assert_contains 'trx guide --review' "$fixture_root/guide-help.out"
assert_contains 'It loads no composition catalog' "$fixture_root/guide-help.out"

PATH=/usr/bin:/bin "$fixture_bin/trx" upgrade --help >"$fixture_root/upgrade-help.out"
PATH=/usr/bin:/bin "$fixture_bin/trx" upgrade all --help >"$fixture_root/upgrade-all-help.out"
PATH=/usr/bin:/bin "$fixture_bin/trx" upgrade codex --help >"$fixture_root/upgrade-harness-help.out"
assert_contains 'trx upgrade all [--yes | --dry-run]' "$fixture_root/upgrade-help.out"
assert_contains 'trx upgrade HARNESS [--all | PROFILE]' "$fixture_root/upgrade-harness-help.out"
for invalid_upgrade in \
  '' '--yes' 'native' 'all --yes --dry-run' 'all --yes --yes' \
  'all --dry-run --dry-run' 'all --unknown' 'all --yes=true' \
  'all --' 'all profile' 'all --help --yes'; do
  read -r -a invalid_upgrade_args <<<"$invalid_upgrade"
  status=0
  PATH=/usr/bin:/bin "$fixture_bin/trx" upgrade "${invalid_upgrade_args[@]+"${invalid_upgrade_args[@]}"}" \
    >"$fixture_root/upgrade-invalid.out" 2>"$fixture_root/upgrade-invalid.err" || status=$?
  [[ "$status" == 1 ]] || fail "invalid upgrade arguments exited $status instead of 1"
  assert_contains 'upgrade requires all [--yes | --dry-run]' "$fixture_root/upgrade-invalid.err"
done
cat >"$fixture_bin/nodecode-updater" <<'EOF'
#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
  printf 'nodecode 0.1.0\n'
  exit 0
fi
[ "$#" -eq 1 ] && [ "$1" = update ] || exit 64
if [ -n "${NODECODE_TEST_ARGS:-}" ]; then
  printf '%s\n' "$@" > "$NODECODE_TEST_ARGS"
else
  printf 'nodecode:update\n' >> "${TRX_UPGRADE_LOG:?}"
fi
exit "${NODECODE_TEST_STATUS:-0}"
EOF
chmod +x "$fixture_bin/nodecode-updater"
# Keep aggregate upgrades and inventory away from the real installed binary.
export TRELLAGE_NODECODE_BIN="$fixture_bin/nodecode-updater"
TRELLAGE_NODECODE_BIN="$fixture_bin/nodecode-updater" NODECODE_TEST_ARGS="$fixture_root/nodecode-update.args" \
  "$fixture_bin/trx" upgrade nodecode --all --yes
[[ "$(cat "$fixture_root/nodecode-update.args")" == update ]] || fail 'Nodecode upgrade must invoke native update only'
rm "$fixture_root/nodecode-update.args"
TRELLAGE_NODECODE_BIN="$fixture_bin/nodecode-updater" NODECODE_TEST_ARGS="$fixture_root/nodecode-update.args" \
  "$fixture_bin/trx" upgrade nodecode --dry-run >"$fixture_root/nodecode-update-dry.out"
[[ ! -e "$fixture_root/nodecode-update.args" ]] || fail 'Nodecode dry-run executed updater'
assert_contains '"update"' "$fixture_root/nodecode-update-dry.out"
status=0
TRELLAGE_NODECODE_BIN="$fixture_bin/nodecode-updater" NODECODE_TEST_ARGS="$fixture_root/nodecode-update.args" NODECODE_TEST_STATUS=23 \
  "$fixture_bin/trx" upgrade nodecode || status=$?
[[ "$status" == 23 ]] || fail "Nodecode update failure exited $status instead of 23"

for unmanaged in codex grok headlong pi uji; do
  status=0
  "$fixture_bin/trx" upgrade "$unmanaged" >"$fixture_root/upgrade-unmanaged.out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || fail "unmanaged $unmanaged upgrade exited $status instead of 1"
  assert_contains "$unmanaged is installed and updated outside Trellage" "$fixture_root/upgrade-unmanaged.out"
done

# The fixture-only basket preview must short-circuit before profile loading.
# No legacy command exists on PATH at this point in the run, so the only
# failure allowed here is the missing terminal.
preview_status=0
"$fixture_bin/trx" guide --preview </dev/null >"$fixture_root/preview.out" 2>&1 \
  || preview_status=$?
((preview_status != 0)) || fail 'preview mode ran without a terminal'
assert_contains 'an interactive terminal is required' "$fixture_root/preview.out"
if grep -Fq 'trellage command not found' "$fixture_root/preview.out"; then
  fail 'preview mode loaded a composition catalog'
fi

# The fork preview short-circuits on the same path, so it gets the same guard.
forks_status=0
"$fixture_bin/trx" guide --forks </dev/null >"$fixture_root/forks.out" 2>&1 \
  || forks_status=$?
((forks_status != 0)) || fail 'fork preview ran without a terminal'
assert_contains 'an interactive terminal is required' "$fixture_root/forks.out"
if grep -Fq 'trellage command not found' "$fixture_root/forks.out"; then
  fail 'fork preview loaded a composition catalog'
fi

# Review needs no profile discovery before opening its own UI.
review_status=0
"$fixture_bin/trx" guide --review </dev/null >"$fixture_root/review.out" 2>&1 \
  || review_status=$?
((review_status != 0)) || fail 'review mode ran without a terminal'
if grep -Fq 'trellage command not found' "$fixture_root/review.out"; then
  fail 'review mode loaded a composition catalog'
fi

# Ritual reads no composition catalog and calls no model.
ritual_list_status=0
"$fixture_bin/trx" guide --prompts </dev/null >"$fixture_root/ritual-list.out" 2>&1 \
  || ritual_list_status=$?
((ritual_list_status != 0)) || fail 'prompt library ran without a terminal'
assert_contains 'an interactive terminal is required' "$fixture_root/ritual-list.out"
if grep -Fq 'trellage command not found' "$fixture_root/ritual-list.out"; then
  fail 'prompt library loaded a composition catalog'
fi
if grep -Fq '.dashboard/index.html' "$fixture_root/ritual-list.out"; then
  fail 'prompt library printed a prompt without a terminal'
fi

"$fixture_bin/trx" guide --prompts progress-page --print </dev/null \
  >"$fixture_root/ritual-print.out" 2>"$fixture_root/ritual-print.err" \
  || { cat "$fixture_root/ritual-print.err" >&2; fail 'ritual print failed'; }
assert_contains '.dashboard/index.html' "$fixture_root/ritual-print.out"
if grep -Fq 'trellage command not found' "$fixture_root/ritual-print.err"; then
  fail 'ritual print loaded a composition catalog'
fi
if grep -Fq 'Prompt Master' "$fixture_root/ritual-print.err"; then
  fail 'ritual print prepared Prompt Master'
fi

both_status=0
"$fixture_bin/trx" guide --prompts progress-page --print --copy </dev/null \
  >"$fixture_root/ritual-both.out" 2>"$fixture_root/ritual-both.err" || both_status=$?
[[ "$both_status" != 0 ]] || fail 'ritual accepted --print and --copy together'
assert_contains 'Use --print or --copy, not both' "$fixture_root/ritual-both.err"

missing_status=0
"$fixture_bin/trx" guide --prompts missing-ritual --print </dev/null \
  >"$fixture_root/ritual-missing.out" 2>"$fixture_root/ritual-missing.err" || missing_status=$?
[[ "$missing_status" != 0 ]] || fail 'ritual print accepted a missing id'
assert_contains 'No prompt named missing-ritual.' "$fixture_root/ritual-missing.err"

json_status=0
"$fixture_bin/trx" guide --prompts --json </dev/null \
  >"$fixture_root/ritual-json.out" 2>"$fixture_root/ritual-json.err" || json_status=$?
[[ "$json_status" != 0 ]] || fail 'ritual accepted --json'
assert_contains '--prompts opens the prompt library' "$fixture_root/ritual-json.err"
if grep -Fq 'trellage command not found' "$fixture_root/ritual-json.err"; then
  fail 'ritual JSON validation loaded a composition catalog'
fi
if grep -Fq 'Prompt Master' "$fixture_root/ritual-json.err"; then
  fail 'ritual json rejection prepared Prompt Master'
fi

cp "$fixture_picker" "$fixture_root/review-launcher.tsx"
cat >"$fixture_picker" <<'EOF'
import { writeFileSync } from "node:fs"
writeFileSync(process.env.TRX_REVIEW_INPUT, JSON.stringify({
  args: process.argv.slice(2),
  profileCommand: process.env.TRELLAGE_REVIEW_PROFILE_COMMAND,
}))
EOF
refresh_fixture_source
TRX_REVIEW_INPUT="$fixture_root/review-input.json" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/review-profile.out" '' '' \
  "$fixture_bin/trx" guide --review --base main --intent "Preserve behavior" \
  || { cat "$fixture_root/review-profile.out" >&2; fail 'review setup required an optional implementation profile'; }
jq -e '(.args | index("--review")) != null and (.args | index("Preserve behavior")) != null and
  (.profileCommand | startswith("/")) and (has("catalog") | not)' "$fixture_root/review-input.json" >/dev/null \
  || fail 'review setup did not preserve its arguments'
mv "$fixture_root/review-launcher.tsx" "$fixture_picker"
refresh_fixture_source

mv "$fixture_bin/cpx" "$fixture_root/cpx-link"
"$fixture_bin/trx" skills status >"$fixture_root/skills-status.json" \
  || fail 'skills status failed without an installed launcher'
jq -e '
  .bundles == ["native-common"]
  and .installed == true
  and .skills == ["fixture-personal", "show-me"]
' "$fixture_root/skills-status.json" >/dev/null \
  || fail 'skills status output differs'
mv "$fixture_root/cpx-link" "$fixture_bin/cpx"

rm "$fixture_bin/bun"
cat >"$fixture_bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == --version || "$*" == *workspace-cli.ts* ]]; then
  exec "$TRX_REAL_BUN" "$@"
fi
printf '%s\n' --- "$@" >>"$TRX_NODE_LOG"
EOF
chmod 0755 "$fixture_bin/bun"
: >"$fixture_root/skills-update.argv"
XDG_DATA_HOME="$fixture_root/xdg-data" \
  TRX_REAL_BUN="$real_bun" TRX_NODE_LOG="$fixture_root/skills-update.argv" "$fixture_bin/trx" skills update \
  || fail 'skills update did not delegate to the floating-skills manager'
grep -Fq '/scripts/skills-update.ts' "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the configured source maintenance service'
rm "$fixture_bin/bun"
ln -s "$real_bun" "$fixture_bin/bun"

status=0
"$fixture_bin/trx" skills refresh >"$fixture_root/skills-invalid.out" \
  2>"$fixture_root/skills-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid skills action exited $status instead of 1"
assert_contains 'skills requires status, update, or check --json' "$fixture_root/skills-invalid.err"

"$fixture_bin/trx" list >"$fixture_root/list.out" \
  || fail 'human list failed'
assert_contains 'HARNESS' "$fixture_root/list.out"
assert_contains 'BUILT-IN PRESETS' "$fixture_root/list.out"
assert_contains 'PROFILE' "$fixture_root/list.out"
assert_contains 'APPLIES TO' "$fixture_root/list.out"
assert_contains 'MODE' "$fixture_root/list.out"

"$fixture_bin/trx" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  type == "object"
  and keys == ["harnesses", "profiles", "schemaVersion"]
  and .schemaVersion == 2
  and (.harnesses | type == "array" and length > 0)
  and all(.harnesses[];
    keys == ["canonical", "harness", "presets", "profiles"]
    and (.harness | type == "string" and length > 0)
    and (.canonical | type == "boolean")
    and (.presets | type == "array")
    and (.profiles | type == "array"))
  and ([.harnesses[].harness] | index("fx") != null)
  and ([.harnesses[].harness] | index("headlong") != null)
  and all(.harnesses[] | select(.harness == "fx" or .harness == "headlong"); .canonical == false)
  and (.profiles | type == "array")
  and all(.profiles[];
    keys == ["always", "harnesses", "kind", "label", "name"]
    and (.name | type == "string" and length > 0)
    and (.label | type == "string" and length > 0)
    and (.kind == "config" or .kind == "shared" or .kind == "special")
    and (.always | type == "boolean")
    and (.harnesses == null or (.harnesses | type == "array")))
' "$fixture_root/list.json" >/dev/null \
  || fail 'JSON list schema 2 shape differs'

"$fixture_bin/trx" run list --json >"$fixture_root/run-list.json" \
  || fail 'Native run catalog failed'

# Listing refuses stale dependencies in source mode; preparation is explicit.
mv "$fixture_source/.managed-by-trellage-source" "$fixture_root/source-ownership.saved"
rm "$fixture_source/.trellage-source-ready.json"
status=0
TRELLAGE_TRX_SOURCE_ROOT="$fixture_source/prototypes/trellage-router" \
  TRELLAGE_TRX_GUIDE_ROOT="$runtime_parent/trx/share/profile-guides" \
  "$fixture_source/prototypes/trellage-router/bin/trx" run list --json >"$fixture_root/source-list.json" 2>"$fixture_root/source-list.err" || status=$?
[[ "$status" == 1 && ! -f "$fixture_source/.trellage-source-ready.json" ]] || fail 'listing prepared source dependencies'
refresh_fixture_source
TRELLAGE_TRX_SOURCE_ROOT="$fixture_source/prototypes/trellage-router" \
  TRELLAGE_TRX_GUIDE_ROOT="$runtime_parent/trx/share/profile-guides" \
  "$fixture_source/prototypes/trellage-router/bin/trx" run list --json >"$fixture_root/source-list.json" || fail 'prepared source list failed'
cmp -s "$fixture_root/source-list.json" "$fixture_root/run-list.json" || fail 'source and installed catalog differ'
mv "$fixture_root/source-ownership.saved" "$fixture_source/.managed-by-trellage-source"
refresh_fixture_source



cp "$fixture_picker" "$fixture_root/picker.saved"
cat >"$fixture_picker" <<'EOF'
#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const guide = {
  schemaVersion: 1,
  capabilities: ["fixture-delivery"],
  bestFor: ["Fixture delivery", "Router integration tests"],
  avoidFor: ["Unrelated fixture work", "Production profile selection"],
  prerequisites: [],
  workflows: [
    {
      id: "deliver",
      description: "Deliver fixture work",
      examples: ["Build the fixture", "Test the fixture", "Review the fixture"],
      promptTemplate: "{{intent}}",
    },
  ],
}

if (process.argv[2] === "guide") {
  process.stdout.write(`${JSON.stringify({
    guideRoot: process.argv[3],
    promptMasterSkillDirectory: process.argv[4],
    promptMasterExists: existsSync(`${process.argv[4]}/SKILL.md`),
    routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
    goalSkills: {
      managerPath: process.env.TRELLAGE_GUIDE_SKILLS_MANAGER,
      catalogPath: process.env.TRELLAGE_GUIDE_SKILLS_CATALOG,
      cachePath: process.env.TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE,
    },
    args: process.argv.slice(5),
    jevKey: {
      privateValue: process.env._TRELLAGE_JEV_API_KEY ?? null,
      publicValue: process.env.TYPESAFE_API_KEY ?? null,
    },
  })}\n`)
} else if (process.argv[2] === "admin") {
  process.stdout.write(`${JSON.stringify({
    guideRoot: process.argv[3],
    routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
    args: process.argv.slice(4),
  })}\n`)
} else if (process.argv[2] === "upgrade") {
  process.stdout.write(`${JSON.stringify({
    routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
    args: process.argv.slice(3),
  })}\n`)
  process.exitCode = Number(process.env.TRX_UPGRADE_CLI_EXIT ?? 0)
  if (process.env.TRX_UPGRADE_CANCEL_EARLY === "1") {
    writeFileSync(process.env.TRX_UPGRADE_CHILD_PID_LOG, String(process.pid))
    const keepAlive = setInterval(() => {}, 1000)
    process.once("SIGTERM", () => {
      clearInterval(keepAlive)
      process.exitCode = 130
    })
    process.kill(process.ppid, "SIGTERM")
  }
} else {
  process.exitCode = 64
}
EOF
chmod 0755 "$fixture_picker"
refresh_fixture_source
"$fixture_bin/trx" guide --intent 'fixture intent' --json >"$fixture_root/guide-catalog.json" \
  || fail 'guide mode did not invoke the launcher'
jq -e \
  --arg guideRoot "$runtime_parent/trx/share/profile-guides" \
  --arg goalCache "${XDG_DATA_HOME:-$fixture_home/.local/share}/trellage/common/skills" \
  --arg runtimeParent "$runtime_parent" '
    .guideRoot == $guideRoot
    and (.promptMasterSkillDirectory | endswith("/skills/prompt-master"))
    and .routerCommandPath == ($runtimeParent + "/trx/bin/trx")
    and .goalSkills.managerPath == ($runtimeParent + "/trx/source/scripts/floating-skills.ts")
    and .goalSkills.catalogPath == ($runtimeParent + "/trx/source/config.example.toml")
    and .goalSkills.cachePath == $goalCache
    and .args == ["--intent", "fixture intent", "--json"]
    and (has("catalog") | not)
  ' "$fixture_root/guide-catalog.json" >/dev/null \
  || fail 'guide mode arguments or environment differ'
"$fixture_bin/trx" guide >"$fixture_root/guide-no-args.json" \
  || fail 'guide mode rejected an omitted interactive intent'
jq -e '.args == []' "$fixture_root/guide-no-args.json" >/dev/null \
  || fail 'guide mode added arguments when the interactive intent was omitted'
"$fixture_bin/trx" guide --engagement --intent "What's the next step in this engagement" \
  >"$fixture_root/guide-engagement.json" \
  || fail 'guide engagement mode was not forwarded'
jq -e '.args == ["--engagement", "--intent", "What\u0027s the next step in this engagement"] and .promptMasterExists == false' \
  "$fixture_root/guide-engagement.json" >/dev/null \
  || fail 'engagement opening prepared an unused Prompt Master skill or changed its question'
"$fixture_bin/trx" guide --intent --engagement --json >"$fixture_root/guide-engagement-literal.json" \
  || fail 'guide treated a literal engagement intent as a mode flag'
jq -e '.promptMasterExists == true' "$fixture_root/guide-engagement-literal.json" >/dev/null \
  || fail 'ordinary guide skipped Prompt Master for a literal intent value'
for conflicting_flag in --engagement --engagement=value --review --next-steps --json --profile=native:cpx/hve --ui-variant=pager --preview --forks --prompts; do
  status=0
  "$fixture_bin/trx" guide --engagement "$conflicting_flag" \
    >"$fixture_root/guide-engagement-invalid.out" 2>"$fixture_root/guide-engagement-invalid.err" \
    || status=$?
  [[ "$status" -ne 0 ]] || fail "engagement accepted conflicting flag: $conflicting_flag"
done
review_skills_manager="$fixture_source/scripts/floating-skills.ts"
mv "$review_skills_manager" "$fixture_root/review-floating-skills.saved"
printf '%s\n' 'throw new Error("Review setup must not prepare Prompt Master or call the floating-skills manager.");' \
  >"$review_skills_manager"
refresh_fixture_source
: >"$fixture_root/guide-review-discovery.log"
TRX_DISCOVERY_LOG="$fixture_root/guide-review-discovery.log" \
  "$fixture_bin/trx" guide --review --base main --intent 'keep this original task' \
  >"$fixture_root/guide-review.json" || fail 'guide Review failed during setup'
jq -e '.args == ["--review", "--base", "main", "--intent", "keep this original task"] and (has("catalog") | not)' \
  "$fixture_root/guide-review.json" >/dev/null || fail 'guide Review changed its task'
[[ ! -s "$fixture_root/guide-review-discovery.log" ]] || fail 'review setup discovered an optional Native profile'
TRELLAGE_REVIEW_PROFILES_ONLY=1 "$fixture_bin/trx" guide --review >"$fixture_root/review-handoff-catalog.json" \
  || fail 'review handoff failed'
jq -e '.args == ["--review"] and (has("catalog") | not)' "$fixture_root/review-handoff-catalog.json" >/dev/null \
  || fail 'review handoff used router catalog plumbing'
"$fixture_bin/trx" guide --review >"$fixture_root/guide-review-no-args.json" \
  || fail 'guide Review failed without arguments'
jq -e '.args == ["--review"] and (has("catalog") | not)' "$fixture_root/guide-review-no-args.json" >/dev/null \
  || fail 'guide Review changed its default arguments'
mv "$fixture_root/review-floating-skills.saved" "$review_skills_manager"
refresh_fixture_source
for conflicting_flag in --review --review=value --engagement --json --next-steps --preview --forks --prompts; do
  status=0
  "$fixture_bin/trx" guide --review "$conflicting_flag" \
    >"$fixture_root/guide-review-invalid.out" 2>"$fixture_root/guide-review-invalid.err" \
    || status=$?
  [[ "$status" -ne 0 ]] || fail "guide Review accepted conflicting flag: $conflicting_flag"
  assert_contains '--review' "$fixture_root/guide-review-invalid.err"
done
"$fixture_bin/trx" guide --next-steps --model fixture-model --effort high \
  >"$fixture_root/guide-next-steps.json" \
  || fail 'guide next-steps mode was not forwarded'
jq -e '.args == ["--next-steps", "--model", "fixture-model", "--effort", "high"]' \
  "$fixture_root/guide-next-steps.json" >/dev/null \
  || fail 'guide next-steps arguments changed during router handoff'
"$fixture_bin/trx" guide --intent --next-steps --json >"$fixture_root/guide-next-steps-literal.json" \
  || fail 'guide treated a literal intent value as the next-steps flag'
jq -e '.args == ["--intent", "--next-steps", "--json"]' \
  "$fixture_root/guide-next-steps-literal.json" >/dev/null \
  || fail 'guide changed an ordinary literal intent'
for conflicting_flag in --next-steps --next-steps=value --json --stdin --intent=ordinary --preview --forks --prompts; do
  status=0
  "$fixture_bin/trx" guide --next-steps "$conflicting_flag" \
    >"$fixture_root/guide-next-steps-invalid.out" 2>"$fixture_root/guide-next-steps-invalid.err" \
    || status=$?
  [[ "$status" -ne 0 ]] || fail "guide next-steps accepted conflicting flag: $conflicting_flag"
  assert_contains '--next-steps' "$fixture_root/guide-next-steps-invalid.err"
done

# Optional Jev key: Varlock loads TYPESAFE_API_KEY from the Trellage config
# directory and hands it to the launcher under a private name.
jq -e '.jevKey == {"privateValue": null, "publicValue": null}' \
  "$fixture_root/guide-no-args.json" >/dev/null \
  || fail 'guide loaded a Jev key without a Trellage environment source'
jev_environment="$fixture_home/.config/trellage"
mkdir -p "$jev_environment"
chmod 0700 "$fixture_home/.config" "$jev_environment"
printf '# @sensitive\nOTHER_FIXTURE_KEY=\n' >"$jev_environment/.env.schema"
chmod 0644 "$jev_environment/.env.schema"
printf 'OTHER_FIXTURE_KEY=other\nTYPESAFE_API_KEY=fixture-jev-key\n' >"$jev_environment/.env.local"
chmod 0600 "$jev_environment/.env.local"
"$fixture_bin/trx" guide >"$fixture_root/guide-jev-key.json" 2>"$fixture_root/guide-jev-key.err" \
  || fail 'guide failed with an optional Jev key source'
jq -e '.jevKey == {"privateValue": "fixture-jev-key", "publicValue": null}' \
  "$fixture_root/guide-jev-key.json" >/dev/null \
  || fail 'guide did not hand the Varlock Jev key privately to the launcher'
[[ ! -s "$fixture_root/guide-jev-key.err" ]] || fail 'guide Jev key loading wrote diagnostics'
grep -Fq 'other' "$fixture_root/guide-jev-key.json" \
  && fail 'guide exposed an unrelated Varlock value'
TYPESAFE_API_KEY=ambient-jev-key "$fixture_bin/trx" guide >"$fixture_root/guide-jev-ambient.json" \
  || fail 'guide failed with an ambient Jev key'
jq -e '.jevKey == {"privateValue": null, "publicValue": "ambient-jev-key"}' \
  "$fixture_root/guide-jev-ambient.json" >/dev/null \
  || fail 'guide replaced an ambient Jev key with the Varlock value'
TRELLAGE_ENVIRONMENT=off "$fixture_bin/trx" guide >"$fixture_root/guide-jev-off.json" \
  || fail 'guide failed with the Trellage environment disabled'
jq -e '.jevKey.privateValue == null' "$fixture_root/guide-jev-off.json" >/dev/null \
  || fail 'guide loaded a Jev key with the Trellage environment disabled'
printf 'OTHER_FIXTURE_KEY=other\n' >"$jev_environment/.env.local"
"$fixture_bin/trx" guide >"$fixture_root/guide-jev-absent.json" 2>"$fixture_root/guide-jev-absent.err" \
  || fail 'guide failed without an optional Jev key'
jq -e '.jevKey.privateValue == null' "$fixture_root/guide-jev-absent.json" >/dev/null \
  || fail 'guide invented a missing Jev key'
[[ ! -s "$fixture_root/guide-jev-absent.err" ]] || fail 'guide reported a missing optional Jev key'
printf 'TYPESAFE_API_KEY=unsafe-jev-key\n' >"$jev_environment/.env.local"
chmod 0644 "$jev_environment/.env.local"
"$fixture_bin/trx" guide >"$fixture_root/guide-jev-unsafe.json" 2>"$fixture_root/guide-jev-unsafe.err" \
  || fail 'guide stopped for an unsafe optional Jev key source'
jq -e '.jevKey.privateValue == null' "$fixture_root/guide-jev-unsafe.json" >/dev/null \
  || fail 'guide loaded a Jev key from an unsafe environment file'
assert_contains 'Jev decisions stay off' "$fixture_root/guide-jev-unsafe.err"
rm -f -- "$jev_environment/.env.schema" "$jev_environment/.env.local"

status=0
"$fixture_bin/trx" admin extra-arg >"$fixture_root/admin-invalid.out" \
  2>"$fixture_root/admin-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid admin arguments exited $status instead of 1"
assert_contains 'admin accepts no arguments' "$fixture_root/admin-invalid.err"

status=0
"$fixture_bin/trx" admin >"$fixture_root/admin-non-tty.out" \
  2>"$fixture_root/admin-non-tty.err" || status=$?
[[ "$status" == 1 ]] || fail "non-TTY admin invocation exited $status instead of 1"
assert_contains 'an interactive terminal is required' "$fixture_root/admin-non-tty.err"

TRELLAGE_TRX_COMMAND_PATH=/unrelated/trx \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/admin-catalog.out" \
  '' '' "$fixture_bin/trx" admin \
  || fail 'admin mode exited with a non-zero status'
jq -e \
  --arg guideRoot "$runtime_parent/trx/share/profile-guides" \
  --arg runtimeParent "$runtime_parent" '
    .guideRoot == $guideRoot
    and .args == []
    and .routerCommandPath == ($runtimeParent + "/trx/bin/trx")
    and (has("catalog") | not)
  ' "$fixture_root/admin-catalog.out" >/dev/null \
  || fail 'admin mode arguments or environment differ'

for upgrade_flag in '' '--yes' '--dry-run'; do
  upgrade_cli_args=(all)
  [[ -z "$upgrade_flag" ]] || upgrade_cli_args+=("$upgrade_flag")
  TRELLAGE_TRX_COMMAND_PATH=/unrelated/trx \
    "$fixture_bin/trx" upgrade "${upgrade_cli_args[@]}" >"$fixture_root/upgrade-catalog.json" \
    || fail 'upgrade mode did not invoke the launcher'
  jq -e --arg flag "$upgrade_flag" --arg router "$runtime_parent/trx/bin/trx" '
    .routerCommandPath == $router
    and .args == (if $flag == "" then ["all"] else ["all", $flag] end)
    and (has("catalog") | not)
  ' "$fixture_root/upgrade-catalog.json" >/dev/null \
    || fail 'upgrade mode changed its arguments or environment'
done
for expected_status in 1 2 130; do
  status=0
  TRX_UPGRADE_CLI_EXIT="$expected_status" "$fixture_bin/trx" upgrade all --yes \
    >"$fixture_root/upgrade-status.out" 2>&1 || status=$?
  [[ "$status" == "$expected_status" ]] || fail "upgrade lost child status $expected_status (got $status)"
done



source_upgrade_root="$fixture_root/upgrade-source"
source_upgrade_router="$source_upgrade_root/prototypes/trellage-router"
cp -R "$fixture_source" "$source_upgrade_root"
cp "$prototype_root/bin/trx" "$source_upgrade_router/bin/trx"
cp "$fixture_picker" "$source_upgrade_root/packages/trellage-launcher/src/cli.tsx"
refresh_fixture_source "$source_upgrade_root"
TRELLAGE_TRX_COMMAND_PATH="$fixture_bin/trx" TRELLAGE_TRX_SOURCE_ROOT="$source_upgrade_router" \
  "$source_upgrade_router/bin/trx" upgrade all --dry-run >"$fixture_root/upgrade-source-catalog.json" \
  || fail 'source router upgrade did not preserve its own executable'
jq -e --arg router "$source_upgrade_router/bin/trx" '.routerCommandPath == $router and (has("catalog") | not)' \
  "$fixture_root/upgrade-source-catalog.json" >/dev/null \
  || fail 'source router upgrade selected an unrelated installed router'
TRELLAGE_TRX_COMMAND_PATH="$fixture_bin/trx" TRELLAGE_TRX_SOURCE_ROOT="$source_upgrade_router" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/admin-source-catalog.json" \
    '' '' "$source_upgrade_router/bin/trx" admin || fail 'source Admin router did not retain its own executable'
jq -e --arg router "$source_upgrade_router/bin/trx" '.routerCommandPath == $router' \
  "$fixture_root/admin-source-catalog.json" >/dev/null || fail 'source Admin selected an unrelated installed router'


mv "$fixture_root/picker.saved" "$fixture_picker"
refresh_fixture_source

cp "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" "$fixture_root/bootstrap.saved"
cat >"$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" <<'EOF'
#!/usr/bin/env bash
printf 'unexpected dependency bootstrap\n' >>"$TRX_UPGRADE_LOG"
exit 65
EOF

fixture_skills_manager="$fixture_source/scripts/skills-update.ts"
mv "$fixture_skills_manager" "$fixture_root/floating-skills.saved"
cat >"$fixture_skills_manager" <<'EOF'
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
if (args.length !== 0 || !process.env.TRX_SKILLS_CACHE_LOG) {
  throw new Error("Unexpected floating-skills fixture command; network access is not allowed.")
}
appendFileSync(process.env.TRX_SKILLS_CACHE_LOG, `${JSON.stringify({
  args,
  routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
})}\n`)
if (process.env.TRX_SKILLS_CACHE_FAIL === "1") {
  process.stderr.write("fixture shared skills cache failed\n")
  process.exitCode = 9
}
EOF
chmod 0444 "$fixture_skills_manager"
refresh_fixture_source
export TRX_SKILLS_CACHE_LOG="$skills_cache_log"
export TRX_SKILLS_UPDATE_LOG="$skills_update_log"
reset_upgrade_logs
TRX_UPGRADE_LOG="$upgrade_log" "$fixture_bin/trx" skills update >"$fixture_root/skills-without-bootstrap.out" 2>&1 \
  || fail 'skills update unexpectedly ran the development dependency bootstrap'
[[ "$(wc -l <"$skills_cache_log" | tr -d ' ')" == 1 ]] || fail 'standalone skills update did not dispatch configured maintenance once'
[[ ! -s "$upgrade_log" && ! -s "$skills_update_log" ]] || fail 'standalone cache refresh changed profiles or ran bootstrap'
reset_upgrade_logs
: >"$discovery_log"
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_DISCOVERY_LOG="$discovery_log" \
  "$fixture_bin/trx" upgrade all --dry-run >"$fixture_root/upgrade-dry-run.out" 2>&1 || status=$?
[[ "$status" == 0 ]] || fail "upgrade dry-run failed (got $status): $(<"$fixture_root/upgrade-dry-run.out")"
assert_no_upgrade_mutation 'upgrade dry-run'
[[ ! -s "$discovery_log" ]] || fail 'upgrade dry-run executed a lifecycle backend during catalog loading'
assert_contains '36 catalog compositions' "$fixture_root/upgrade-dry-run.out"
assert_contains 'Scope: 6 Native runtime updates.' "$fixture_root/upgrade-dry-run.out"
assert_contains 'Externally managed codex: installed and updated outside Trellage.' "$fixture_root/upgrade-dry-run.out"
assert_contains 'Externally managed pi: installed and updated outside Trellage.' "$fixture_root/upgrade-dry-run.out"
assert_contains 'Externally managed agency: installed and updated outside Trellage.' "$fixture_root/upgrade-dry-run.out"
assert_contains 'Externally managed headlong: installed and updated outside Trellage.' "$fixture_root/upgrade-dry-run.out"
assert_contains "Refresh: $runtime_parent/trx/bin/trx skills update" "$fixture_root/upgrade-dry-run.out"
assert_contains "$runtime_parent/trx/bin/trx upgrade agency azure --skills-only" "$fixture_root/upgrade-dry-run.out"
assert_contains 'No harness or skill updates or installed-version checks were started' "$fixture_root/upgrade-dry-run.out"

TRX_UPGRADE_LOG="$upgrade_log" python3 - "$fixture_bin/trx" "$fixture_root/upgrade-non-tty.out" <<'PY'
import pathlib
import subprocess
import sys

result = subprocess.run(
    [sys.argv[1], "upgrade", "all"],
    input="yes\n",
    capture_output=True,
    text=True,
    start_new_session=True,
    timeout=20,
)
pathlib.Path(sys.argv[2]).write_text(result.stdout + result.stderr)
if result.returncode != 1:
    raise SystemExit(f"non-interactive upgrade returned {result.returncode}, expected 1")
PY
assert_no_upgrade_mutation 'piped yes without a terminal'
assert_contains 'No approval: an interactive terminal is required' "$fixture_root/upgrade-non-tty.out"

status=0
TRX_UPGRADE_LOG="$upgrade_log" "$fixture_bin/trx" upgrade all --yes \
  >"$fixture_root/upgrade-yes.out" 2>&1 || status=$?
[[ "$status" == 0 ]] || fail "authorized upgrade returned unexpected status $status: $(<"$fixture_root/upgrade-yes.out")"
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 6 ]] \
  || { cat "$fixture_root/upgrade-yes.out" "$upgrade_log" >&2; fail 'authorized upgrade did not run each planned update exactly once'; }
assert_native_skills_refreshed
assert_contains 'cldx:harness-update' "$upgrade_log"
assert_contains 'omp:update copilot' "$upgrade_log"
assert_contains 'nodecode:update' "$upgrade_log"
assert_contains 'Harness summary:' "$fixture_root/upgrade-yes.out"
assert_contains 'shared cache: updated.' "$fixture_root/upgrade-yes.out"
assert_contains 'Updated Native skills native:agency/azure' "$fixture_root/upgrade-yes.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_UPGRADE_FAIL=cldx \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-mixed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'upgrade accepted mixed command and installed-version failures'
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 6 ]] || fail 'an independent failure stopped later upgrade groups'
assert_native_skills_refreshed
assert_contains 'fixture harness update failed: cldx' "$fixture_root/upgrade-mixed.out"
assert_contains 'Updated harness native:prime/default' "$fixture_root/upgrade-mixed.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_UPGRADE_LEGACY_LAUNCHER=cldx \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-legacy.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'upgrade accepted an old launcher without harness-update'
if grep -Fq 'cldx:harness-update' "$upgrade_log"; then
  fail 'upgrade forwarded an unknown harness-update verb into an old launcher'
fi
assert_contains 'does not support harness-update. Refresh the installed Trellage runtime first.' "$fixture_root/upgrade-legacy.out"
assert_contains 'does not support skills-update. Refresh the installed Trellage runtime first.' "$fixture_root/upgrade-legacy.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_SKILLS_CACHE_FAIL=1 \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-skills-cache-failed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'unified update accepted a failed shared skills cache'
[[ "$(wc -l <"$skills_cache_log" | tr -d ' ')" == 1 ]] || fail 'failed shared cache refresh was restarted'
[[ ! -s "$skills_update_log" ]] || fail 'unified update copied stale skills after a cache refresh failure'
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 6 ]] || fail 'skills cache failure prevented independent harness updates'
assert_contains 'Native skills cache failed: fixture shared skills cache failed' "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Native skills not run native:agency/azure: shared cache refresh failed; no stale cache is used.' \
  "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Harness summary:' "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Native skills summary: 0 updated, 0 failed,' "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'not run; shared cache: failed.' "$fixture_root/upgrade-skills-cache-failed.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_SKILLS_UPDATE_FAIL=cpx/hve \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-profile-skills-failed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'unified update accepted a failed profile skills verification'
assert_native_skills_refreshed
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 6 ]] || fail 'profile skill failure prevented independent harness updates'
assert_contains 'Failed Native skills native:copilot/hve: fixture skill verification failed: cpx/hve' \
  "$fixture_root/upgrade-profile-skills-failed.out"
assert_contains 'Updated Native skills native:claude/default' "$fixture_root/upgrade-profile-skills-failed.out"
assert_contains 'Native skills summary:' "$fixture_root/upgrade-profile-skills-failed.out"
assert_contains 'shared cache: updated.' "$fixture_root/upgrade-profile-skills-failed.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_SKILLS_LEGACY_LAUNCHER=agx \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-old-skills-interface.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'unified update accepted an old Native skills interface'
if grep -Fq 'agx:skills-update' "$skills_update_log"; then
  fail 'unified update forwarded an unknown skills-update verb into Agency'
fi
assert_contains 'does not support skills-update. Refresh the installed Trellage runtime first.' \
  "$fixture_root/upgrade-old-skills-interface.out"
assert_contains 'Updated Native skills native:prime/default' "$fixture_root/upgrade-old-skills-interface.out"

for cancel_keys in '\r' '\x03'; do
  reset_upgrade_logs
  status=0
  TRX_UPGRADE_LOG="$upgrade_log" \
    python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/upgrade-cancel.out" \
      "$cancel_keys" '' "$fixture_bin/trx" upgrade all || status=$?
  [[ "$status" == 130 ]] || fail "cancelled upgrade exited $status instead of 130"
  assert_no_upgrade_mutation 'cancelled upgrade'
  assert_contains 'No harness or skill updates were started.' "$fixture_root/upgrade-cancel.out"
done

status=0
TRX_UPGRADE_LOG="$upgrade_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/upgrade-confirm.out" \
    'yes\r' '' "$fixture_bin/trx" upgrade all || status=$?
[[ "$status" == 0 ]] || fail "confirmed upgrade returned $status instead of 0"
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 6 ]] || fail 'terminal confirmation did not start the planned updates'
assert_native_skills_refreshed
assert_contains 'Type yes to update' "$fixture_root/upgrade-confirm.out"
assert_contains 'Harness summary:' "$fixture_root/upgrade-confirm.out"
assert_contains 'shared cache: updated.' "$fixture_root/upgrade-confirm.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_UPGRADE_WAIT=cldx \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/upgrade-signal.out" \
    '' 'Running:' "$fixture_bin/trx" upgrade all --yes || status=$?
[[ "$status" == 130 ]] || fail "interrupted router upgrade exited $status instead of 130"
assert_contains 'Update all cancelled.' "$fixture_root/upgrade-signal.out"
[[ ! -s "$skills_cache_log" && ! -s "$skills_update_log" ]] || fail 'router cancellation started a later Native skills phase'
mv -f "$fixture_root/floating-skills.saved" "$fixture_skills_manager"
refresh_fixture_source
unset TRX_SKILLS_CACHE_LOG TRX_SKILLS_UPDATE_LOG
mv "$fixture_root/bootstrap.saved" "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh"

status=0
"$fixture_bin/trx" list --json-full >"$fixture_root/list-invalid.out" \
  2>"$fixture_root/list-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid list arguments exited $status instead of 1"
assert_contains 'list accepts only --json or HARNESS [--json]' "$fixture_root/list-invalid.err"

status=0
"$fixture_bin/trx" list copilot cpx-p >"$fixture_root/list-pair.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "list harness/profile exited $status instead of 1"
assert_contains 'list accepts only --json or HARNESS [--json]' "$fixture_root/list-pair.out"

status=0
"$fixture_bin/trx" frobnicate >"$fixture_root/unknown-command.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "unknown command exited $status instead of 1"
assert_contains 'unknown command: frobnicate; run trx --help' "$fixture_root/unknown-command.out"
status=0
"$fixture_bin/trx" run bogus >"$fixture_root/unknown-harness.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "unknown harness exited $status instead of 1"
assert_contains 'unknown harness: bogus; harnesses: agency, claude, codex, copilot, empryo, grok, jcode, omp, pi, prime, uji, nodecode (also fx, headlong)' \
  "$fixture_root/unknown-harness.out"
assert_contains 'usage: trx run HARNESS [PROFILE...]' "$fixture_root/unknown-harness.out"


status=0
"$fixture_bin/trx" models omp >"$fixture_root/models-retired.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "retired models command exited $status instead of 1"
assert_contains 'unknown command: models; run trx --help' "$fixture_root/models-retired.out"

status=0
"$fixture_bin/trx" skill codex example prompt >"$fixture_root/skill-invalid.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "unsupported skill harness exited $status instead of 1"
assert_contains 'skill supports only jcode' "$fixture_root/skill-invalid.out"

run_select_cli="$fixture_source/packages/trellage-launcher/src/run-select-cli.tsx"
mv "$run_select_cli" "$fixture_root/run-select-cli.saved"
cat >"$run_select_cli" <<'EOF'
process.stdout.write(`${JSON.stringify({
  args: process.argv.slice(2),
  routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
  transcriptApiKeySet: process.env.TRANSCRIPT_API_KEY !== undefined,
})}\n`)
EOF
refresh_fixture_source
"$fixture_bin/trx" >"$fixture_root/bare-compose.json" || fail 'bare trx did not dispatch the run composer'
"$fixture_bin/trx" run --dry-run >"$fixture_root/run-compose.json" || fail 'trx run did not dispatch the run composer'
TRANSCRIPT_API_KEY=fixture-explicit-key "$fixture_bin/trx" run --dry-run >"$fixture_root/run-compose-key.json" \
  || fail 'trx run did not preserve the explicit transcript key for the composer'
jq -e --arg router "$runtime_parent/trx/bin/trx" \
  '.args == [] and .routerCommandPath == $router and .transcriptApiKeySet == false' \
  "$fixture_root/bare-compose.json" >/dev/null \
  || fail 'bare trx changed composer arguments or omitted its command path'
jq -e --arg router "$runtime_parent/trx/bin/trx" \
  '.args == ["--dry-run"] and .routerCommandPath == $router and .transcriptApiKeySet == false' \
  "$fixture_root/run-compose.json" >/dev/null \
  || fail 'trx run changed composer arguments or omitted its command path'
jq -e '.transcriptApiKeySet == true' "$fixture_root/run-compose-key.json" >/dev/null \
  || fail 'trx run did not restore an explicit transcript key for composer policy'
mv "$fixture_root/run-select-cli.saved" "$run_select_cli"
refresh_fixture_source

inventory_output="$("$fixture_bin/trx" inventory copilot hve --json)" \
  || fail 'trx inventory failed for a known harness/profile'
jq -e '
  .schemaVersion == 2
  and .harness == "copilot"
  and .profiles == ["hve"]
  and (.effectiveProfiles | index("hve") != null)
  and (.readiness == "healthy" or .readiness == "unhealthy" or .readiness == "not-setup" or .readiness == "busy")
' <<<"$inventory_output" >/dev/null \
  || fail 'trx inventory did not return the expected readiness contract'

busy_inventory_output="$(TRX_INVENTORY_READINESS=busy \
  "$fixture_bin/trx" inventory prime default --json)" \
  || fail 'trx inventory rejected a busy harness/profile'
jq -e '
  .harness == "prime"
  and .profiles == ["default"]
  and .readiness == "busy"
' <<<"$busy_inventory_output" >/dev/null \
  || fail 'trx inventory did not preserve busy readiness'

status=0
"$fixture_bin/trx" inventory bogus hve --json >"$fixture_root/inventory-bad-launcher.out" \
  2>"$fixture_root/inventory-bad-launcher.err" || status=$?
[[ "$status" == 1 ]] || fail "trx inventory for an unknown harness exited $status instead of 1"
assert_contains 'unknown harness bogus' "$fixture_root/inventory-bad-launcher.err"

status=0
"$fixture_bin/trx" inventory copilot hve >"$fixture_root/inventory-missing-json.out" \
  2>"$fixture_root/inventory-missing-json.err" || status=$?
[[ "$status" == 1 ]] || fail "trx inventory without --json exited $status instead of 1"
assert_contains 'inventory requires HARNESS [PROFILE...] [--no-always] --json' "$fixture_root/inventory-missing-json.err"
status=0
"$fixture_bin/trx" inventory copilot hve --goal-features >"$fixture_root/inventory-goal-features.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "non-Codex --goal-features exited $status instead of 1"
assert_contains 'inventory requires HARNESS [PROFILE...] [--no-always] --json' "$fixture_root/inventory-goal-features.out"


cat >"$fixture_root/minimal-native-config.toml" <<'EOF'
schema_version = 1

[native.profiles.cldx-p]
label = "Claude fixture"
harnesses = ["claude"]
EOF

for launcher in cpx cldx jcx omp prx agx; do
  mv "$fixture_bin/$launcher" "$fixture_bin/$launcher.absent"
done
cp "$runtime_parent/cpx/catalog.json" "$fixture_root/copilot-isolation.catalog"
printf '{not-json}\n' >"$runtime_parent/cpx/catalog.json"
TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_CONFIG="$fixture_root/minimal-native-config.toml" \
  "$fixture_bin/trx" run claude cldx-p -- 'two words' '' '--literal=*' \
  || fail 'direct Claude launch required a public launcher or unrelated catalog'
python3 - "$argument_log" <<'PY' || fail 'isolated Claude launch changed arguments'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
raise SystemExit(0 if actual[0] == b"claude" and actual[-4:] == [
    b"two words", b"", b"--literal=*", b"",
] else 1)
PY
mv "$fixture_root/copilot-isolation.catalog" "$runtime_parent/cpx/catalog.json"
for launcher in cpx cldx jcx omp prx agx; do
  mv "$fixture_bin/$launcher.absent" "$fixture_bin/$launcher"
done



printf 'unrelated\n' \
  >"$runtime_parent/trx/share/profile-guides/native/copilot/unrelated.txt"
status=0
"$prototype_root/install.sh" >"$fixture_root/unrelated-guide-install.out" \
  2>"$fixture_root/unrelated-guide-install.err" || status=$?
[[ "$status" == 1 ]] || fail "unrelated profile guide install exited $status instead of 1"
assert_contains 'refusing unrelated profile guide path' \
  "$fixture_root/unrelated-guide-install.err"
rm "$runtime_parent/trx/share/profile-guides/native/copilot/unrelated.txt"

ln -s "$fixture_root/unrelated-command" \
  "$runtime_parent/trx/share/profile-guides/native/copilot/redirected.md"
status=0
"$prototype_root/install.sh" >"$fixture_root/symlink-guide-install.out" \
  2>"$fixture_root/symlink-guide-install.err" || status=$?
[[ "$status" == 1 ]] || fail "symlinked profile guide install exited $status instead of 1"
assert_contains 'refusing symlinked profile guide path' \
  "$fixture_root/symlink-guide-install.err"
rm "$runtime_parent/trx/share/profile-guides/native/copilot/redirected.md"

printf 'unrelated\n' >"$fixture_root/unrelated-command"
rm "$fixture_bin/trx"
cp "$fixture_root/unrelated-command" "$fixture_bin/trx"
status=0
"$prototype_root/install.sh" >"$fixture_root/unrelated-install.out" \
  2>"$fixture_root/unrelated-install.err" || status=$?
[[ "$status" == 1 ]] || fail "unrelated command install exited $status instead of 1"
assert_contains 'refusing to replace unrelated command' "$fixture_root/unrelated-install.err"
rm "$fixture_bin/trx"
ln -s "$runtime_parent/trx/bin/trx" "$fixture_bin/trx"

printf 'unrelated\n' \
  >"$runtime_parent/trx/share/profile-guides/native/copilot/unrelated.txt"
status=0
"$prototype_root/uninstall.sh" >"$fixture_root/unrelated-guide-uninstall.out" \
  2>"$fixture_root/unrelated-guide-uninstall.err" || status=$?
[[ "$status" == 1 ]] || fail "unrelated profile guide uninstall exited $status instead of 1"
assert_contains 'refusing unrelated profile guide path' \
  "$fixture_root/unrelated-guide-uninstall.err"
[[ -d "$runtime_parent/trx" ]] || fail 'unsafe guide uninstall removed trx runtime'
rm "$runtime_parent/trx/share/profile-guides/native/copilot/unrelated.txt"

ln -s "$fixture_root/unrelated-command" \
  "$runtime_parent/trx/share/profile-guides/native/copilot/redirected.md"
status=0
"$prototype_root/uninstall.sh" >"$fixture_root/symlink-guide-uninstall.out" \
  2>"$fixture_root/symlink-guide-uninstall.err" || status=$?
[[ "$status" == 1 ]] || fail "symlinked profile guide uninstall exited $status instead of 1"
assert_contains 'refusing symlinked profile guide path' \
  "$fixture_root/symlink-guide-uninstall.err"
[[ -d "$runtime_parent/trx" ]] || fail 'symlinked guide uninstall removed trx runtime'
rm "$runtime_parent/trx/share/profile-guides/native/copilot/redirected.md"

"$prototype_root/uninstall.sh" >"$fixture_root/uninstall.out"
[[ ! -e "$runtime_parent/trx" ]] || fail 'uninstaller left trx runtime'
[[ ! -e "$fixture_bin/trx" && ! -L "$fixture_bin/trx" ]] \
  || fail 'uninstaller left trx command'
[[ -x "$runtime_parent/cpx/bin/cpx" && -x "$runtime_parent/agx/bin/agx" \
  && -x "$runtime_parent/cldx/bin/cldx" \
  && -x "$runtime_parent/jcx/bin/jcx" \
  && -x "$runtime_parent/omp/bin/omp" && -x "$runtime_parent/prx/bin/prx" ]] \
  || fail 'uninstaller changed native launchers'
assert_contains 'Uninstalled trx.' "$fixture_root/uninstall.out"

printf 'trx contract: PASS\n'
