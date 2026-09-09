#!/usr/bin/env bash
set -euo pipefail

unset TRELLAGE_TRX_SOURCE_ROOT

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
real_jq="$(command -v jq)"

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
    length == 4 and all(.[]; .args[0] == "update" and .routerCommandPath == $router)
  ' "$skills_cache_log" >/dev/null || fail 'unified update did not refresh all four caches once through its own router'
  jq -r '.catalog.native[] | .launcher + ":skills-update " + .name' \
    "$fixture_root/guide-catalog.json" | sort >"$fixture_root/expected-skills-update.log"
  sort "$skills_update_log" >"$fixture_root/actual-skills-update.log"
  cmp -s "$fixture_root/expected-skills-update.log" "$fixture_root/actual-skills-update.log" \
    || fail 'unified update did not copy every Native profile exactly once'
}

mkdir -p "$fixture_home" "$fixture_bin"
export TMPDIR="$fixture_root"
seed_floating_skills_cache "$fixture_home"
ln -s "$real_node" "$fixture_bin/node"
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
  fi

  if [[ "$launcher" == cpx ]]; then
    printf -v description '%1200s' ''
    description="${description// /x}$description_suffix"
    standalone_mcps='["docs", {"name":"files","transport":"stdio"}]'
  fi

  local sandbox=false
  if [[ "$launcher" == grx ]]; then
    sandbox=true
  fi

  mkdir -p "$runtime/bin"
  printf '%s\n' "$marker_value" >"$runtime/$marker"
  if [[ "$launcher" == omp ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "omp",
  "harness": "oh-my-pi",
  "sandbox": false,
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
  elif [[ "$launcher" == picx ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "picx",
  "harness": "pi",
  "sandbox": false,
  "profiles": [
    {
      "name": "default",
      "description": "Ordered Pi extension profile",
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
        "testedHarnessVersion": "0.84.2"
      },
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": [],
      "extensions": [
        {"name":"Ponytail","package":"@dietrichgebert/ponytail","installSpec":"git:github.com/DietrichGebert/ponytail"}
      ]
    }
  ]
}
EOF
  elif [[ "$launcher" == fmx ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "fmx",
  "harness": "firstmate",
  "sandbox": false,
  "profiles": [
    {
      "name": "default",
      "description": "Firstmate fleet orchestration",
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
    },
    {
      "name": "pstack-workers",
      "description": "Firstmate with a lean pstack worker policy",
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
  "sandbox": $sandbox,
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
    }'
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
create_native_launcher cdx codex .managed-by-trellage-codex-profiles trellage-codex-profiles-v2
catalog_stage="$fixture_root/cdx-catalog.json"
"$real_jq" '.profiles += [
  {
    name:"pstack",
    description:"Aqua-123 pstack for Codex",
    headless:.profiles[0].headless,
    plugin:"pstack-for-codex@pstack-for-codex-local",
    source:null,
    marketplace:null,
    standaloneMcps:[]
  },
  {
    name:"youtube",
    description:"YouTube transcript research with youtube-full",
    headless:.profiles[0].headless,
    plugin:null,
    source:"ZeroPointRepo/youtube-skills",
    kind:"skills",
    skillBundles:["native-common","youtube"],
    managedSkills:["youtube-full"],
    requiredEnvironment:["TRANSCRIPT_API_KEY"],
    marketplace:null,
    standaloneMcps:[]
  }
]' "$runtime_parent/cdx/catalog.json" >"$catalog_stage"
mv "$catalog_stage" "$runtime_parent/cdx/catalog.json"
create_native_launcher cldx claude .managed-by-trellage-claude-profiles trellage-claude-profiles-v1
create_native_launcher fmx firstmate .managed-by-trellage-firstmate-profiles trellage-firstmate-profiles-v1
create_native_launcher grx grok .managed-by-trellage-grok-profiles trellage-grok-profiles-v1
create_native_launcher jcx jcode .managed-by-trellage-jcode-profiles trellage-jcode-profiles-v1
create_native_launcher omp oh-my-pi .managed-by-trellage-omp-profiles trellage-omp-profiles-v2
create_native_launcher picx pi .managed-by-trellage-picx-profiles trellage-picx-profiles-v1
create_native_launcher prx prime .managed-by-trellage-prime-profiles trellage-prime-profiles-v1
create_native_launcher agx agency .managed-by-trellage-agency-profiles trellage-agency-profiles-v1

write_fixture_guide() {
  local launcher="$1"
  local profile="$2"
  local destination="$runtime_parent/trx/share/profile-guides/native/$launcher/$profile.md"

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

"$prototype_root/install.sh" >"$fixture_root/install.out"
[[ -L "$fixture_bin/trx" ]] || fail 'installer did not publish trx command symlink'
[[ "$(readlink "$fixture_bin/trx")" == "$runtime_parent/trx/bin/trx" ]] \
  || fail 'installer published the wrong trx command target'
cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v2\n') \
  || fail 'installer ownership marker differs'
if cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v1\n'); then
  fail 'current router ownership marker does not block a legacy installer'
fi
assert_contains 'Installed trx' "$fixture_root/install.out"

printf 'trellage-router-v1\n' \
  >"$runtime_parent/trx/.managed-by-trellage-router"
mv "$runtime_parent/trx/lib/launcher.mjs" \
  "$runtime_parent/trx/lib/terminal-picker.mjs"
cat >"$runtime_parent/trx/bin/trx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
launcher="$0"
if [[ -L "$launcher" ]]; then
  launcher="$(readlink "$launcher")"
fi
runtime="$(cd -P "$(dirname "$launcher")/.." && pwd -P)"
[[ "$(<"$runtime/.managed-by-trellage-router")" == trellage-router-v1 ]] \
  || exit 1
printf 'trx-v1-fixture\n'
EOF
chmod 0755 "$runtime_parent/trx/bin/trx"
[[ "$("$fixture_bin/trx" --version)" == trx-v1-fixture ]] \
  || fail 'legacy router fixture was not usable before migration'
mkdir "$runtime_parent/.trx-install.lock"
if "$prototype_root/install.sh" >"$fixture_root/reinstall-lock.out" 2>&1; then
  fail 'router install unexpectedly ignored an active install lock'
fi
assert_contains \
  'another router install is in progress' \
  "$fixture_root/reinstall-lock.out"
[[ "$("$fixture_bin/trx" --version)" == trx-v1-fixture ]] \
  || fail 'lock refusal changed the usable legacy router'
rmdir "$runtime_parent/.trx-install.lock"
if TRX_INSTALL_TEST_FAIL_AT=after-runtime-publication \
  "$prototype_root/install.sh" >"$fixture_root/reinstall-failure.out" 2>&1; then
  fail 'injected router publication failure unexpectedly succeeded'
fi
assert_contains \
  'injected failure at after-runtime-publication' \
  "$fixture_root/reinstall-failure.out"
cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v1\n') \
  || fail 'failed migration did not restore the legacy ownership marker'
[[ "$("$fixture_bin/trx" --version)" == trx-v1-fixture ]] \
  || fail 'failed migration did not restore the usable legacy router'
[[ ! -e "$runtime_parent/trx/lib/launcher.mjs" ]] \
  || fail 'failed migration left a v2 launcher bundle in the legacy runtime'
[[ -x "$runtime_parent/trx/lib/terminal-picker.mjs" ]] \
  || fail 'failed migration did not restore the legacy terminal picker'
[[ ! -e "$runtime_parent/.trx-install.lock" ]] \
  || fail 'failed migration left the router install lock behind'
"$prototype_root/install.sh" >"$fixture_root/reinstall.out"
cmp -s "$runtime_parent/trx/.managed-by-trellage-router" \
  <(printf 'trellage-router-v2\n') \
  || fail 'installer did not migrate the legacy router ownership marker'
[[ -x "$runtime_parent/trx/bin/trx" ]] || fail 'repeat install removed launcher'
[[ -x "$runtime_parent/trx/lib/launcher.mjs" ]] \
  || fail 'upgrade did not install the Ink launcher'
[[ -x "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" ]] \
  || fail 'upgrade did not install the dependency bootstrap'
[[ ! -e "$runtime_parent/trx/lib/terminal-picker.mjs" ]] \
  || fail 'upgrade left the legacy terminal picker'
[[ -f "$runtime_parent/trx/share/profile-guides/native/cpx/awesome.md" ]] \
  || fail 'installer did not publish profile guides'

rm -rf -- "$runtime_parent/trx/share/profile-guides"
for pair in \
  cpx:cpx-p \
  cdx:cdx-p \
  cdx:pstack \
  cdx:youtube \
  cldx:cldx-p \
  fmx:default \
  fmx:pstack-workers \
  grx:grx-p \
  jcx:jcx-p \
  omp:copilot \
  omp:local \
  picx:default \
  prx:prx-p \
  agx:trellage-azure; do
  write_fixture_guide "${pair%%:*}" "${pair#*:}"
done
export TRELLAGE_TRX_GUIDE_ROOT="$runtime_parent/trx/share/profile-guides"

"$fixture_bin/trx" --help >"$fixture_root/help.out"
assert_contains 'trx list [--json]' "$fixture_root/help.out"
assert_contains 'trx run LAUNCHER PROFILE [-- ARGS...]' "$fixture_root/help.out"
assert_contains 'trx --profile agency [COPILOT_ARGS...]' "$fixture_root/help.out"
assert_contains 'trx guide [INTENT]' "$fixture_root/help.out"
assert_contains 'trx guide --preview' "$fixture_root/help.out"
assert_contains 'trx skills status' "$fixture_root/help.out"
assert_contains 'trx skills update' "$fixture_root/help.out"
assert_contains 'trx admin' "$fixture_root/help.out"
assert_contains 'trx upgrade all [--yes | --dry-run]' "$fixture_root/help.out"
assert_contains 'Bare trx opens the launcher.' "$fixture_root/help.out"
assert_contains 'trx run cpx tufte-vdqi' "$fixture_root/help.out"

status=0
"$fixture_bin/trx" --profile cpx-p >"$fixture_root/profile-option.out" \
  2>"$fixture_root/profile-option.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid router --profile option exited $status instead of 1"
assert_contains \
  'unknown profile alias: cpx-p; use: trx run LAUNCHER PROFILE' \
  "$fixture_root/profile-option.err"

: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" \
  "$fixture_bin/trx" --profile agency 'space value' '' '*' \
  || fail 'direct Agency profile launch failed'
python3 - "$argument_log" <<'PY' || fail 'direct Agency profile arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"agx", b"trellage-azure", b"space value", b"", b"*", b""]
raise SystemExit(0 if actual == expected else 1)
PY

: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" \
  "$fixture_bin/trx" --profile=agency --model gpt-5.6-sol \
  || fail 'equals-form Agency profile launch failed'
python3 - "$argument_log" <<'PY' || fail 'equals-form Agency arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"agx", b"trellage-azure", b"--model", b"gpt-5.6-sol", b""]
raise SystemExit(0 if actual == expected else 1)
PY

status=0
"$fixture_bin/trx" --profile unknown >"$fixture_root/profile-unknown.out" \
  2>"$fixture_root/profile-unknown.err" || status=$?
[[ "$status" == 1 ]] || fail "unknown profile alias exited $status instead of 1"
assert_contains 'unknown profile alias: unknown' "$fixture_root/profile-unknown.err"

"$fixture_bin/trx" guide --help >"$fixture_root/guide-help.out"
assert_contains 'native:<launcher>/<profile> or sandbox:<profile>' \
  "$fixture_root/guide-help.out"
assert_contains 'schemaVersion 1' "$fixture_root/guide-help.out"
assert_contains 'INTENT can contain line breaks and accepts up to 60,000 characters.' \
  "$fixture_root/guide-help.out"
assert_contains 'Interactive prompt viewers: pager, split, focus, bookends, dashboard.' \
  "$fixture_root/guide-help.out"
assert_contains 'trx guide --preview' "$fixture_root/guide-help.out"
assert_contains 'trx guide --forks' "$fixture_root/guide-help.out"
assert_contains 'It reads' "$fixture_root/guide-help.out"

PATH=/usr/bin:/bin "$fixture_bin/trx" upgrade --help >"$fixture_root/upgrade-help.out"
PATH=/usr/bin:/bin "$fixture_bin/trx" upgrade all --help >"$fixture_root/upgrade-all-help.out"
assert_contains 'trx upgrade all [--yes | --dry-run]' "$fixture_root/upgrade-help.out"
assert_contains 'trellage upgrade all remains Container-only.' "$fixture_root/upgrade-all-help.out"
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

# The fixture-only basket preview must short-circuit before the Sandbox catalog.
# No `trellage` command exists on PATH at this point in the run, so the only
# failure allowed here is the missing terminal.
preview_status=0
"$fixture_bin/trx" guide --preview </dev/null >"$fixture_root/preview.out" 2>&1 \
  || preview_status=$?
((preview_status != 0)) || fail 'preview mode ran without a terminal'
assert_contains 'an interactive terminal is required' "$fixture_root/preview.out"
if grep -Fq 'trellage command not found' "$fixture_root/preview.out"; then
  fail 'preview mode required the Sandbox catalog'
fi

# The fork preview short-circuits on the same path, so it gets the same guard.
forks_status=0
"$fixture_bin/trx" guide --forks </dev/null >"$fixture_root/forks.out" 2>&1 \
  || forks_status=$?
((forks_status != 0)) || fail 'fork preview ran without a terminal'
assert_contains 'an interactive terminal is required' "$fixture_root/forks.out"
if grep -Fq 'trellage command not found' "$fixture_root/forks.out"; then
  fail 'fork preview required the Sandbox catalog'
fi

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

rm "$fixture_bin/node"
cat >"$fixture_bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' --- "$@" >>"$TRX_NODE_LOG"
EOF
chmod 0755 "$fixture_bin/node"
: >"$fixture_root/skills-update.argv"
XDG_DATA_HOME="$fixture_root/xdg-data" \
  TRX_NODE_LOG="$fixture_root/skills-update.argv" "$fixture_bin/trx" skills update \
  || fail 'skills update did not delegate to the floating-skills manager'
grep -Fxq native-common "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the native bundle'
grep -Fxq youtube "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the native YouTube bundle'
grep -Fxq "$fixture_root/xdg-data/trellage/common/cdx-youtube-skills" \
  "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the native YouTube cache'
grep -Fxq omp-community "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the OMP community bundle'
grep -Fxq "$fixture_home/.local/share/trellage/common/omp-community-skills" \
  "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the OMP community cache'
grep -Fxq guide-prompt-master "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the guide Prompt Master bundle'
grep -Fxq "$fixture_home/.local/share/trellage/common/guide-prompt-master-skills" \
  "$fixture_root/skills-update.argv" \
  || fail 'skills update omitted the guide Prompt Master cache'
[[ "$(grep -Fxc update "$fixture_root/skills-update.argv")" == 4 ]] \
  || fail 'skills update did not invoke all bundle updates'
rm "$fixture_bin/node"
ln -s "$real_node" "$fixture_bin/node"

status=0
"$fixture_bin/trx" skills refresh >"$fixture_root/skills-invalid.out" \
  2>"$fixture_root/skills-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid skills action exited $status instead of 1"
assert_contains 'skills requires status, update, or check --json' "$fixture_root/skills-invalid.err"

"$fixture_bin/trx" list >"$fixture_root/list.out" \
  || fail 'human list failed'
assert_contains $'cpx/cpx-p\t' "$fixture_root/list.out"
assert_contains $'cdx/cdx-p\tcdx' "$fixture_root/list.out"
assert_contains $'cldx/cldx-p\tcldx' "$fixture_root/list.out"
assert_contains $'fmx/default\tFirstmate fleet orchestration' "$fixture_root/list.out"
assert_contains $'fmx/pstack-workers\tFirstmate with a lean pstack worker policy' \
  "$fixture_root/list.out"
assert_contains $'grx/grx-p\tgrx' "$fixture_root/list.out"
assert_contains $'jcx/jcx-p\tjcx' "$fixture_root/list.out"
assert_contains $'omp/copilot\tNative GitHub Copilot' "$fixture_root/list.out"
assert_contains $'omp/local\tLocal Qwen' "$fixture_root/list.out"
assert_contains $'picx/default\tOrdered Pi extension profile' "$fixture_root/list.out"
assert_contains $'cdx/pstack\tAqua-123 pstack for Codex' "$fixture_root/list.out"
assert_contains $'cdx/youtube\tYouTube transcript research with youtube-full' "$fixture_root/list.out"
assert_contains $'prx/prx-p\tprx' "$fixture_root/list.out"
assert_contains $'agx/trellage-azure\tagx' "$fixture_root/list.out"

"$fixture_bin/trx" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  type == "object"
  and keys == ["profiles", "schemaVersion"]
  and .schemaVersion == 1
  and ([.profiles[] | keys] | all(. == ["description", "guide", "harness", "headless", "herdrCompatibility", "launcher", "name", "sandbox"]))
  and all(.profiles[];
    .guide.schemaVersion == 1
    and .guide.capabilities == ["fixture-delivery"]
    and .guide.workflows[0].id == "deliver")
  and [.profiles[] | .launcher + "/" + .name] == [
    "cpx/cpx-p",
    "cdx/cdx-p",
    "cdx/pstack",
    "cdx/youtube",
    "cldx/cldx-p",
    "fmx/default",
    "fmx/pstack-workers",
    "grx/grx-p",
    "jcx/jcx-p",
    "omp/copilot",
    "omp/local",
    "picx/default",
    "prx/prx-p",
    "agx/trellage-azure"
  ]
  and [.profiles[] | .harness] == [
    "copilot",
    "codex",
    "codex",
    "codex",
    "claude",
    "firstmate",
    "firstmate",
    "grok",
    "jcode",
    "oh-my-pi",
    "oh-my-pi",
    "pi",
    "prime",
    "agency"
  ]
  and [.profiles[] | .sandbox] == [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    false
  ]
  and all(.profiles[]; .herdrCompatibility.status | . == "untested" or . == "verified" or . == "known-issue")
  and (.profiles[] | select(.launcher == "omp" and .name == "copilot") | .herdrCompatibility) == { status: "verified" }
  and (.profiles[] | select(.launcher == "omp" and .name == "local") | .herdrCompatibility.status) == "known-issue"
  and (.profiles[] | select(.launcher == "picx" and .name == "default") | .herdrCompatibility.status) == "untested"
  and (.profiles[] | select(.launcher == "cdx" and .name == "pstack") | .herdrCompatibility.status) == "untested"
  and (.profiles[] | select(.launcher == "cdx" and .name == "youtube") | .herdrCompatibility.status) == "verified"
  and (.profiles[] | select(.launcher == "fmx" and .name == "default") | .herdrCompatibility.status) == "verified"
  and (.profiles[] | select(.launcher == "fmx" and .name == "pstack-workers") | .herdrCompatibility.status) == "untested"
  and (.profiles[] | select(.launcher == "agx" and .name == "trellage-azure") | .herdrCompatibility.status) == "untested"
  and all(.profiles[] | select(.launcher == "fmx"); .headless.prompt == false and .headless.modelOverride == false)
  and (.profiles[] | select(.launcher == "cpx") | .herdrCompatibility) == { status: "untested" }
  and (.profiles[] | select(.launcher == "omp" and .name == "copilot") | .headless.questionToolControl) == "prompt-only"
  and (.profiles[] | select(.launcher == "cdx") | .headless.testedHarnessVersion) == "1.2.3"
  and all(.profiles[]; .description | type == "string" and length > 0)
' "$fixture_root/list.json" >/dev/null \
  || fail 'JSON list shape or ordering differs'

TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  "$prototype_root/bin/trx" list --json >"$fixture_root/source-list.json" \
  || fail 'worktree source JSON list failed'
cmp -s "$fixture_root/source-list.json" "$fixture_root/list.json" \
  || fail 'worktree source list differs from installed router list'

# --- TRELLAGE_TRX_NATIVE_SOURCE: opt-in dev-mode native launcher delegation.
# Uses a self-contained fixture (a copy of trx plus fixture sibling
# trellage-*-profiles packages) so it never depends on the real, slower
# native launcher binaries or mutates the real repository tree. Plain `list`
# (not `--json`) is used here because `--json` additionally shells out to the
# real Ink picker/guide catalog, which this isolated fixture does not stage.
"$fixture_bin/trx" list >"$fixture_root/list.txt" \
  || fail 'installed router plain list failed'

dev_router_root="$fixture_root/dev-router"
mkdir -p "$dev_router_root/bin"
cp "$prototype_root/bin/trx" "$dev_router_root/bin/trx"
chmod 0755 "$dev_router_root/bin/trx"

create_native_launcher cpx copilot .managed-by-trellage-profiles trellage-profiles-v1 \
  "$fixture_root/trellage-copilot-profiles"
create_native_launcher cdx codex .managed-by-trellage-codex-profiles trellage-codex-profiles-v2 \
  "$fixture_root/trellage-codex-profiles" ' (dev-source)'
create_native_launcher cldx claude .managed-by-trellage-claude-profiles trellage-claude-profiles-v1 \
  "$fixture_root/trellage-claude-profiles"
create_native_launcher fmx firstmate .managed-by-trellage-firstmate-profiles trellage-firstmate-profiles-v1 \
  "$fixture_root/trellage-firstmate-profiles"
create_native_launcher grx grok .managed-by-trellage-grok-profiles trellage-grok-profiles-v1 \
  "$fixture_root/trellage-grok-profiles"
create_native_launcher jcx jcode .managed-by-trellage-jcode-profiles trellage-jcode-profiles-v1 \
  "$fixture_root/trellage-jcode-profiles"
create_native_launcher omp oh-my-pi .managed-by-trellage-omp-profiles trellage-omp-profiles-v2 \
  "$fixture_root/trellage-omp-profiles"
create_native_launcher picx pi .managed-by-trellage-picx-profiles trellage-picx-profiles-v1 \
  "$fixture_root/trellage-picx-profiles"
create_native_launcher prx prime .managed-by-trellage-prime-profiles trellage-prime-profiles-v1 \
  "$fixture_root/trellage-prime-profiles"
create_native_launcher agx agency .managed-by-trellage-agency-profiles trellage-agency-profiles-v1 \
  "$fixture_root/trellage-agency-profiles"

TRELLAGE_TRX_SOURCE_ROOT="$dev_router_root" TRELLAGE_TRX_NATIVE_SOURCE=1 \
  HOME="$fixture_home" PATH="$fixture_bin:$PATH" \
  "$dev_router_root/bin/trx" list >"$fixture_root/dev-native-list.txt" \
  || fail 'dev-native-source list failed'
assert_contains '(dev-source)' "$fixture_root/dev-native-list.txt"
cmp -s "$fixture_root/dev-native-list.txt" "$fixture_root/list.txt" \
  && fail 'dev-native-source list unexpectedly matched the installed launcher list'

# TRELLAGE_TRX_SOURCE_ROOT alone (no TRELLAGE_TRX_NATIVE_SOURCE) must keep
# resolving native launchers from the installed/PATH runtime, unchanged.
TRELLAGE_TRX_SOURCE_ROOT="$dev_router_root" \
  HOME="$fixture_home" PATH="$fixture_bin:$PATH" \
  "$dev_router_root/bin/trx" list >"$fixture_root/router-only-list.txt" \
  || fail 'router-only dev mode list failed'
cmp -s "$fixture_root/router-only-list.txt" "$fixture_root/list.txt" \
  || fail 'router-only dev mode unexpectedly used dev-source native launchers'

chmod -x "$fixture_root/trellage-codex-profiles/bin/cdx"
if TRELLAGE_TRX_SOURCE_ROOT="$dev_router_root" TRELLAGE_TRX_NATIVE_SOURCE=1 \
  HOME="$fixture_home" PATH="$fixture_bin:$PATH" \
  "$dev_router_root/bin/trx" list >"$fixture_root/dev-native-error.out" 2>&1; then
  fail 'dev-native-source list unexpectedly succeeded with a non-executable sibling launcher'
fi
assert_contains \
  'development launcher is not an executable regular file: cdx' \
  "$fixture_root/dev-native-error.out"
chmod 0755 "$fixture_root/trellage-codex-profiles/bin/cdx"

mv "$fixture_root/trellage-codex-profiles/bin/cdx" \
  "$fixture_root/trellage-codex-profiles/bin/cdx.real"
ln -s "$fixture_root/trellage-codex-profiles/bin/cdx.real" \
  "$fixture_root/trellage-codex-profiles/bin/cdx"
if TRELLAGE_TRX_SOURCE_ROOT="$dev_router_root" TRELLAGE_TRX_NATIVE_SOURCE=1 \
  HOME="$fixture_home" PATH="$fixture_bin:$PATH" \
  "$dev_router_root/bin/trx" list >"$fixture_root/dev-native-symlink.out" 2>&1; then
  fail 'dev-native-source list unexpectedly followed a symlinked sibling launcher'
fi
assert_contains \
  'unsafe development launcher: cdx' \
  "$fixture_root/dev-native-symlink.out"
rm -f "$fixture_root/trellage-codex-profiles/bin/cdx"
mv "$fixture_root/trellage-codex-profiles/bin/cdx.real" \
  "$fixture_root/trellage-codex-profiles/bin/cdx"

cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"

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

if (process.argv[2] === "enrich-native-list") {
  const input = JSON.parse(readFileSync(0, "utf8"))
  process.stdout.write(`${JSON.stringify({
    ...input,
    profiles: input.profiles.map((profile) => ({ ...profile, guide })),
  })}\n`)
} else if (process.argv[2] === "guide") {
  process.stdout.write(`${JSON.stringify({
    guideRoot: process.argv[3],
    promptMasterSkillDirectory: process.argv[4],
    args: process.argv.slice(5),
    catalog: JSON.parse(readFileSync(3, "utf8")),
  })}\n`)
} else if (process.argv[2] === "admin") {
  process.stdout.write(`${JSON.stringify({
    guideRoot: process.argv[3],
    routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
    args: process.argv.slice(4),
    catalog: JSON.parse(readFileSync(3, "utf8")),
  })}\n`)
} else if (process.argv[2] === "upgrade") {
  process.stdout.write(`${JSON.stringify({
    routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH,
    args: process.argv.slice(3),
    catalog: JSON.parse(readFileSync(0, "utf8")),
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
chmod 0755 "$runtime_parent/trx/lib/launcher.mjs"
cat >"$fixture_bin/trellage" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == upgrade ]]; then
  [[ "$#" -eq 3 && "$2" == sandbox-fixture && "$3" == --strict-harness ]] || exit 64
  [[ -n "${TRX_UPGRADE_LOG-}" ]] || exit 64
  printf 'trellage:%s\n' "$*" >>"$TRX_UPGRADE_LOG"
  if [[ "${TRX_UPGRADE_FALLBACK-}" == 1 ]]; then
    printf 'upgrade fallback: harness codex retained version 2.1.0\n'
  fi
  exit 0
fi
if [[ "${1-}" == harness-version ]]; then
  [[ "$#" -eq 2 && "$2" == sandbox-fixture ]] || exit 64
  printf '{"schemaVersion":1,"installed":"3.0.0","latestKnown":true,"latest":"3.0.0"}\n'
  exit 0
fi
[[ "$#" -eq 2 && "$1" == list && "$2" == --json-full ]] || exit 64
if [[ -n "${TRX_DISCOVERY_LOG-}" ]]; then
  printf 'trellage\n' >>"$TRX_DISCOVERY_LOG"
fi
case "${TRX_SANDBOX_CATALOG_MODE-}" in
  empty) printf '{"schemaVersion":2,"profiles":[]}\n'; exit 0 ;;
  malformed) printf '{"schemaVersion":2,"profiles":null}\n'; exit 0 ;;
  invalid-schema) printf '{"schemaVersion":1,"profiles":[{}]}\n'; exit 0 ;;
  multiple) printf '{"schemaVersion":2,"profiles":[{}]}\n{"schemaVersion":2,"profiles":[{}]}\n'; exit 0 ;;
  failed) printf 'fixture Sandbox catalog failed\n' >&2; exit 9 ;;
esac
cat <<'JSON'
{"schemaVersion":2,"profiles":[{"name":"sandbox-fixture","description":"Sandbox fixture","guide":{"schemaVersion":1,"capabilities":["fixture-delivery"],"bestFor":["Fixture delivery","Fixture updates"],"avoidFor":["Unrelated fixture work","Live updates"],"prerequisites":[],"workflows":[{"id":"deliver","description":"Deliver fixture work","examples":["Build the fixture","Test the fixture","Review the fixture"],"promptTemplate":"{{intent}}"}]},"path":"/fixture/profiles/sandbox-fixture/profile.toml","supportedPlatforms":["linux/arm64"],"harness":{"kind":"codex","version":"2.1.0","model":"gpt-5.6-sol"},"resolutionPolicy":"floating","locallyResolved":true,"releaseLockAvailable":true,"skillBundles":["sandbox-common"],"skillsMode":"floating","finalDigestLocked":false,"skills":[],"plugins":[],"mcps":[],"sandbox":true,"headless":{"schemaVersion":1,"prompt":true,"outputFormats":["text"],"eventContract":null,"trellageEventContract":null,"sessionId":"none","resume":false,"resumeWithPrompt":false,"questionToolControl":"hard-deny","changedFiles":"none","usage":false,"cost":false,"modelOverride":true,"effortOverride":false,"testedHarnessVersion":"1.0.0"},"locked":true,"herdrCompatibility":{"status":"untested"}}]}
JSON
EOF
chmod 0755 "$fixture_bin/trellage"
"$fixture_bin/trx" guide --intent 'fixture intent' --json \
  >"$fixture_root/guide-catalog.json" \
  || fail 'guide mode did not aggregate native and Sandbox catalogs'
jq -e \
  --arg guideRoot "$runtime_parent/trx/share/profile-guides" \
  --arg sandboxCommandPath "$fixture_bin/trellage" \
  --arg runtimeParent "$runtime_parent" '
    .guideRoot == $guideRoot
    and (.promptMasterSkillDirectory | endswith("/skills/prompt-master"))
    and .args == ["--intent", "fixture intent", "--json"]
    and .catalog.schemaVersion == 1
    and .catalog.sandboxCommandPath == $sandboxCommandPath
    and .catalog.sandbox[0].name == "sandbox-fixture"
    and (.catalog.native | length == 14)
    and all(.catalog.native[];
      (.commandPath | startswith($runtimeParent + "/"))
      and (.harness | type == "string" and length > 0)
      and .guide.schemaVersion == 1)
  ' "$fixture_root/guide-catalog.json" >/dev/null \
  || fail 'guide mode combined catalog or arguments differ'
"$fixture_bin/trx" guide >"$fixture_root/guide-no-args.json" \
  || fail 'guide mode rejected an omitted interactive intent'
jq -e '.args == []' "$fixture_root/guide-no-args.json" >/dev/null \
  || fail 'guide mode added arguments when the interactive intent was omitted'

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
  --arg sandboxCommandPath "$fixture_bin/trellage" \
  --arg runtimeParent "$runtime_parent" '
    .guideRoot == $guideRoot
    and .args == []
    and .routerCommandPath == ($runtimeParent + "/trx/bin/trx")
    and .catalog.schemaVersion == 1
    and .catalog.sandboxCommandPath == $sandboxCommandPath
    and .catalog.sandbox[0].name == "sandbox-fixture"
    and (.catalog.native | length == 14)
    and all(.catalog.native[];
      (.commandPath | startswith($runtimeParent + "/"))
      and (.harness | type == "string" and length > 0)
      and .guide.schemaVersion == 1)
  ' "$fixture_root/admin-catalog.out" >/dev/null \
  || fail 'admin mode combined catalog differs from guide mode'

for upgrade_flag in '' '--yes' '--dry-run'; do
  upgrade_cli_args=(all)
  [[ -z "$upgrade_flag" ]] || upgrade_cli_args+=("$upgrade_flag")
  TRELLAGE_TRX_COMMAND_PATH=/unrelated/trx \
    "$fixture_bin/trx" upgrade "${upgrade_cli_args[@]}" >"$fixture_root/upgrade-catalog.json" \
    || fail 'upgrade mode did not route the combined catalog'
  jq -e --slurpfile guide "$fixture_root/guide-catalog.json" --arg flag "$upgrade_flag" \
    --arg router "$runtime_parent/trx/bin/trx" '
    .catalog == $guide[0].catalog
    and .routerCommandPath == $router
    and .args == (if $flag == "" then ["all"] else ["all", $flag] end)
  ' "$fixture_root/upgrade-catalog.json" >/dev/null \
    || fail 'upgrade mode changed its arguments or used a separate catalog'
done
for expected_status in 1 2 130; do
  status=0
  TRX_UPGRADE_CLI_EXIT="$expected_status" "$fixture_bin/trx" upgrade all --yes \
    >"$fixture_root/upgrade-status.out" 2>&1 || status=$?
  [[ "$status" == "$expected_status" ]] || fail "upgrade lost child status $expected_status (got $status)"
done

: >"$upgrade_log"
for broken_catalog in empty malformed invalid-schema multiple failed; do
  status=0
  TRX_UPGRADE_LOG="$upgrade_log" TRX_SANDBOX_CATALOG_MODE="$broken_catalog" \
    "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-discovery.out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || fail "upgrade accepted $broken_catalog Sandbox catalog"
  [[ ! -s "$upgrade_log" ]] || fail 'invalid Sandbox discovery started a harness update'
done

cp "$runtime_parent/cdx/catalog.json" "$fixture_root/upgrade-native-catalog.saved"
printf '{"schemaVersion":1,"profiles":[]}\n' >"$runtime_parent/cdx/catalog.json"
status=0
TRX_UPGRADE_LOG="$upgrade_log" "$fixture_bin/trx" upgrade all --yes \
  >"$fixture_root/upgrade-invalid-native.out" 2>&1 || status=$?
mv "$fixture_root/upgrade-native-catalog.saved" "$runtime_parent/cdx/catalog.json"
[[ "$status" == 1 ]] || fail 'upgrade accepted an invalid Native catalog'
assert_contains 'catalog discovery failed' "$fixture_root/upgrade-invalid-native.out"
[[ ! -s "$upgrade_log" ]] || fail 'invalid Native catalog discovery started an update'

mv "$fixture_bin/cdx" "$fixture_bin/cdx.saved"
status=0
TRX_UPGRADE_LOG="$upgrade_log" "$fixture_bin/trx" upgrade all --yes \
  >"$fixture_root/upgrade-missing-native.out" 2>&1 || status=$?
mv "$fixture_bin/cdx.saved" "$fixture_bin/cdx"
[[ "$status" == 1 ]] || fail 'upgrade accepted missing Native launcher discovery'
assert_contains 'required launcher not found on PATH: cdx' "$fixture_root/upgrade-missing-native.out"
[[ ! -s "$upgrade_log" ]] || fail 'missing Native launcher discovery started an update'

mv "$fixture_bin/trellage" "$fixture_bin/trellage.saved"
status=0
TRX_UPGRADE_LOG="$upgrade_log" "$fixture_bin/trx" upgrade all --yes \
  >"$fixture_root/upgrade-missing-sandbox.out" 2>&1 || status=$?
mv "$fixture_bin/trellage.saved" "$fixture_bin/trellage"
[[ "$status" == 1 ]] || fail 'upgrade accepted missing Sandbox catalog discovery'
assert_contains 'this mode requires the Sandbox catalog' "$fixture_root/upgrade-missing-sandbox.out"
[[ ! -s "$upgrade_log" ]] || fail 'missing Sandbox discovery started an update'

source_upgrade_root="$fixture_root/upgrade-source"
source_upgrade_router="$source_upgrade_root/prototypes/trellage-router"
mkdir -p "$source_upgrade_router/bin" "$source_upgrade_root/packages/trellage-launcher/dist" "$source_upgrade_root/prototypes/trellage"
cp "$prototype_root/bin/trx" "$source_upgrade_router/bin/trx"
cp "$runtime_parent/trx/lib/launcher.mjs" "$source_upgrade_root/packages/trellage-launcher/dist/launcher.mjs"
cp "$fixture_bin/trellage" "$source_upgrade_root/prototypes/trellage/trellage"
TRELLAGE_TRX_COMMAND_PATH="$fixture_bin/trx" TRELLAGE_TRX_SOURCE_ROOT="$source_upgrade_router" \
  "$source_upgrade_router/bin/trx" upgrade all --dry-run >"$fixture_root/upgrade-source-catalog.json" \
  || fail 'source router upgrade did not preserve its own executable'
jq -e --arg router "$source_upgrade_router/bin/trx" \
  --arg sandbox "$source_upgrade_root/prototypes/trellage/trellage" '
    .routerCommandPath == $router and .catalog.sandboxCommandPath == $sandbox
  ' "$fixture_root/upgrade-source-catalog.json" >/dev/null \
  || fail 'source router upgrade selected an unrelated installed router'
TRELLAGE_TRX_COMMAND_PATH="$fixture_bin/trx" TRELLAGE_TRX_SOURCE_ROOT="$source_upgrade_router" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/admin-source-catalog.json" \
    '' '' "$source_upgrade_router/bin/trx" admin || fail 'source Admin router did not retain its own executable'
jq -e --arg router "$source_upgrade_router/bin/trx" '.routerCommandPath == $router' \
  "$fixture_root/admin-source-catalog.json" >/dev/null || fail 'source Admin selected an unrelated installed router'

status=0
TRX_UPGRADE_CANCEL_EARLY=1 TRX_UPGRADE_CHILD_PID_LOG="$fixture_root/upgrade-child.pid" \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-early-cancel.out" 2>&1 || status=$?
[[ "$status" == 130 ]] || fail "early upgrade cancellation exited $status instead of 130"
upgrade_child_pid="$(<"$fixture_root/upgrade-child.pid")"
if kill -0 "$upgrade_child_pid" 2>/dev/null; then
  fail 'early router cancellation left its Node child running'
fi

mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"

cp "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" "$fixture_root/bootstrap.saved"
cat >"$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" <<'EOF'
#!/usr/bin/env bash
printf 'unexpected dependency bootstrap\n' >>"$TRX_UPGRADE_LOG"
exit 65
EOF

fixture_skills_manager="$runtime_parent/common/floating-skills-runtime/floating-skills.mjs"
mv "$fixture_skills_manager" "$fixture_root/floating-skills.saved"
cat >"$fixture_skills_manager" <<'EOF'
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
if (args[0] !== "update" || !process.env.TRX_SKILLS_CACHE_LOG) {
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
export TRX_SKILLS_CACHE_LOG="$skills_cache_log"
export TRX_SKILLS_UPDATE_LOG="$skills_update_log"
reset_upgrade_logs
TRX_UPGRADE_LOG="$upgrade_log" "$fixture_bin/trx" skills update >"$fixture_root/skills-without-bootstrap.out" 2>&1 \
  || fail 'skills update unexpectedly ran the development dependency bootstrap'
[[ "$(wc -l <"$skills_cache_log" | tr -d ' ')" == 4 ]] || fail 'standalone skills update did not refresh the four caches'
[[ ! -s "$upgrade_log" && ! -s "$skills_update_log" ]] || fail 'standalone cache refresh changed profiles or ran bootstrap'
reset_upgrade_logs
: >"$discovery_log"
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_DISCOVERY_LOG="$discovery_log" \
  "$fixture_bin/trx" upgrade all --dry-run >"$fixture_root/upgrade-dry-run.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail "upgrade dry-run did not report unsupported Agency (got $status)"
assert_no_upgrade_mutation 'upgrade dry-run'
[[ "$(sort -u "$discovery_log" | wc -l | tr -d ' ')" == 11 ]] \
  || fail 'upgrade dry-run did not use every Native catalog and the Sandbox catalog'
assert_contains '15 catalog profiles' "$fixture_root/upgrade-dry-run.out"
assert_contains '10 Native runtime/profile updates; 1 Container image updates' "$fixture_root/upgrade-dry-run.out"
assert_contains 'Unsupported harness native:agx/trellage-azure' "$fixture_root/upgrade-dry-run.out"
assert_contains "Refresh: $runtime_parent/trx/bin/trx skills update" "$fixture_root/upgrade-dry-run.out"
assert_contains "$runtime_parent/agx/bin/agx skills-update trellage-azure" "$fixture_root/upgrade-dry-run.out"
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
[[ "$status" == 1 ]] || fail "authorized upgrade hid unsupported Agency (got $status)"
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 11 ]] || fail 'authorized upgrade did not run each planned update exactly once'
assert_native_skills_refreshed
assert_contains 'cldx:harness-update' "$upgrade_log"
assert_contains 'fmx:update default' "$upgrade_log"
assert_contains 'fmx:update pstack-workers' "$upgrade_log"
assert_contains 'omp:update copilot' "$upgrade_log"
assert_contains 'picx:update default' "$upgrade_log"
assert_contains 'trellage:upgrade sandbox-fixture --strict-harness' "$upgrade_log"
assert_contains 'Installed sandbox:sandbox-fixture: 3.0.0' "$fixture_root/upgrade-yes.out"
assert_contains 'Harness summary: 14 updated, 0 failed, 1 unsupported' "$fixture_root/upgrade-yes.out"
assert_contains 'Native skills summary: 14 updated, 0 failed, 0 not run; shared cache: updated.' "$fixture_root/upgrade-yes.out"
assert_contains 'Updated Native skills native:agx/trellage-azure' "$fixture_root/upgrade-yes.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_UPGRADE_FAIL=cldx TRX_UPGRADE_FALLBACK=1 TRX_UPGRADE_VERSION_FAIL=cdx \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-mixed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'upgrade accepted mixed command, fallback, and installed-version failures'
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 11 ]] || fail 'an independent failure stopped later upgrade groups'
assert_native_skills_refreshed
assert_contains 'Failed harness native:cldx/cldx-p: fixture harness update failed: cldx' "$fixture_root/upgrade-mixed.out"
assert_contains 'Installed-version refresh failed for Native codex' "$fixture_root/upgrade-mixed.out"
assert_contains 'Harness was not updated: upgrade fallback: harness codex' "$fixture_root/upgrade-mixed.out"
assert_contains 'Updated harness native:prx/prx-p' "$fixture_root/upgrade-mixed.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_UPGRADE_LEGACY_LAUNCHER=cldx \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-legacy.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'upgrade accepted an old launcher without harness-update'
if grep -Fq 'cldx:harness-update' "$upgrade_log"; then
  fail 'upgrade forwarded an unknown harness-update verb into an old launcher'
fi
assert_contains 'does not support harness-update. Refresh the installed Trellage launcher first.' "$fixture_root/upgrade-legacy.out"
assert_contains 'does not support skills-update. Refresh the installed Trellage launcher first.' "$fixture_root/upgrade-legacy.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_SKILLS_CACHE_FAIL=1 \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-skills-cache-failed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'unified update accepted a failed shared skills cache'
[[ "$(wc -l <"$skills_cache_log" | tr -d ' ')" == 1 ]] || fail 'failed shared cache refresh was restarted'
[[ ! -s "$skills_update_log" ]] || fail 'unified update copied stale skills after a cache refresh failure'
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 11 ]] || fail 'skills cache failure prevented independent harness updates'
assert_contains 'Native skills cache failed: fixture shared skills cache failed' "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Native skills not run native:agx/trellage-azure: shared cache refresh failed; no stale cache is used.' \
  "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Harness summary: 14 updated, 0 failed, 1 unsupported' "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Native skills summary: 0 updated, 0 failed, 14 not run; shared cache: failed.' "$fixture_root/upgrade-skills-cache-failed.out"
assert_contains 'Updated harness sandbox:sandbox-fixture' "$fixture_root/upgrade-skills-cache-failed.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_SKILLS_UPDATE_FAIL=cdx/pstack \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-profile-skills-failed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'unified update accepted a failed profile skills verification'
assert_native_skills_refreshed
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 11 ]] || fail 'profile skill failure prevented independent harness updates'
assert_contains 'Failed Native skills native:cdx/pstack: fixture skill verification failed: cdx/pstack' \
  "$fixture_root/upgrade-profile-skills-failed.out"
assert_contains 'Updated Native skills native:cdx/youtube' "$fixture_root/upgrade-profile-skills-failed.out"
assert_contains 'Updated harness sandbox:sandbox-fixture' "$fixture_root/upgrade-profile-skills-failed.out"
assert_contains 'Native skills summary: 13 updated, 1 failed, 0 not run; shared cache: updated.' "$fixture_root/upgrade-profile-skills-failed.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_SKILLS_LEGACY_LAUNCHER=agx \
  "$fixture_bin/trx" upgrade all --yes >"$fixture_root/upgrade-old-skills-interface.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'unified update accepted an old Native skills interface'
if grep -Fq 'agx:skills-update' "$skills_update_log"; then
  fail 'unified update forwarded an unknown skills-update verb into Agency'
fi
assert_contains 'does not support skills-update. Refresh the installed Trellage launcher first.' \
  "$fixture_root/upgrade-old-skills-interface.out"
assert_contains 'Updated Native skills native:prx/prx-p' "$fixture_root/upgrade-old-skills-interface.out"

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
[[ "$status" == 1 ]] || fail "confirmed upgrade hid unsupported profiles (got $status)"
[[ "$(wc -l <"$upgrade_log" | tr -d ' ')" == 11 ]] || fail 'terminal confirmation did not start the planned updates'
assert_native_skills_refreshed
assert_contains 'Type yes to update' "$fixture_root/upgrade-confirm.out"
assert_contains 'Harness summary: 14 updated, 0 failed, 1 unsupported' "$fixture_root/upgrade-confirm.out"
assert_contains 'Native skills summary: 14 updated, 0 failed, 0 not run; shared cache: updated.' "$fixture_root/upgrade-confirm.out"

reset_upgrade_logs
status=0
TRX_UPGRADE_LOG="$upgrade_log" TRX_UPGRADE_WAIT=cdx \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/upgrade-signal.out" \
    '' 'Running:' "$fixture_bin/trx" upgrade all --yes || status=$?
[[ "$status" == 130 ]] || fail "interrupted router upgrade exited $status instead of 130"
assert_contains 'Update all cancelled.' "$fixture_root/upgrade-signal.out"
if grep -Fq 'trellage:upgrade' "$upgrade_log"; then
  fail 'router cancellation started a later Container update'
fi
[[ ! -s "$skills_cache_log" && ! -s "$skills_update_log" ]] || fail 'router cancellation started a later Native skills phase'
mv -f "$fixture_root/floating-skills.saved" "$fixture_skills_manager"
unset TRX_SKILLS_CACHE_LOG TRX_SKILLS_UPDATE_LOG
mv "$fixture_root/bootstrap.saved" "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh"

TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/source-select.out" \
  'codex\x1e\r' '' "$prototype_root/bin/trx" '--source-mode' \
  || fail 'worktree source type-to-filter selection failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source arguments were not forwarded'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cdx", b"cdx-p", b"--source-mode", b""]
raise SystemExit(0 if actual == expected else 1)
PY

TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/source-slash-select.out" \
  '/codex\x1e\r' '' "$prototype_root/bin/trx" '--source-mode' \
  || fail 'worktree source leading-slash selection failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source leading-slash arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cdx", b"cdx-p", b"--source-mode", b""]
raise SystemExit(0 if actual == expected else 1)
PY

TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/source-backspace-select.out" \
  'codex\x1e\x7f\x1e\x7f\x1e\x7f\x1e\x7f\x1e\x7f\x1ecopilot\x1e\r' \
  '' "$prototype_root/bin/trx" '--source-mode' \
  || fail 'worktree source Backspace filtering failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source Backspace selection launched the wrong profile'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"--source-mode", b""]
if actual != expected:
    print(f"expected {expected!r}, got {actual!r}", file=sys.stderr)
    raise SystemExit(1)
PY

status=0
"$fixture_bin/trx" list --json-full >"$fixture_root/list-invalid.out" \
  2>"$fixture_root/list-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid list arguments exited $status instead of 1"
assert_contains 'list accepts only --json' "$fixture_root/list-invalid.err"

status=0
"$fixture_bin/trx" >"$fixture_root/non-tty.out" 2>"$fixture_root/non-tty.err" \
  || status=$?
[[ "$status" == 1 ]] || fail "non-TTY invocation exited $status instead of 1"
assert_contains 'an interactive terminal is required' "$fixture_root/non-tty.err"

cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs"

writeFileSync(process.env.TRX_PICKER_INPUT, readFileSync(process.argv[2]))
writeFileSync(process.argv[3], '{"id":"cpx:cpx-p","target":"current"}\n')
EOF
selection_started="$(python3 -c 'import time; print(time.monotonic_ns())')"
TRX_ARGUMENT_LOG="$argument_log" \
  TRX_INVENTORY_DELAY=4 \
  TRX_INVENTORY_LOG="$inventory_log" \
  TRX_PICKER_INPUT="$fixture_root/picker-input.json" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/select.out" \
  '\r' '' "$fixture_bin/trx" \
  'two words' '' '--literal=*' \
  || fail 'interactive selection failed'
selection_finished="$(python3 -c 'import time; print(time.monotonic_ns())')"
selection_milliseconds="$(((selection_finished - selection_started) / 1000000))"
((selection_milliseconds < 4000)) \
  || fail "selected profile launch was delayed ${selection_milliseconds}ms by inventory"
jq --arg commandPath "$runtime_parent/cpx/bin/cpx" -e '
  .description == "Direct launch: trx run LAUNCHER PROFILE. The selected row shows its exact command below. Trellage Native runs coding-agent launchers and Firstmate fleet orchestration directly on the host with isolated state. Codex (cdx) uses Full Access without a native sandbox. Grok (grx) enables its native sandbox; other native profiles are not security boundaries."
  and (.choices[0]
    | .label == "copilot / cpx-p"
      and (.description | length == 1200)
      and .commandAlias == "cpx"
      and .commandPath == $commandPath
      and .profileArgument == "cpx-p"
      and .passthroughArgs == ["two words", "", "--literal=*"]
      and .defaultModel == "gpt-6-astra"
      and .models == ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]
      and .plugins == ["cpx-plug"]
      and .skills == []
      and .mcps == ["docs", "files"]
      and .sandbox == false
      and (.details == "The selected launcher checks readiness before starting.")
      and ([.label,.description,.details,.plugins[],.mcps[]] | all(test("[[:cntrl:]]") | not)))
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choice omitted complete catalog metadata or launch readiness status'
jq -e '
  ([.choices[] | select(.id == "cldx:cldx-p")]
    | length == 1
      and .[0].label == "claude / cldx-p"
      and .[0].harness == "claude"
      and .[0].profile == "cldx-p")
  and ([.choices[] | select(.id == "fmx:default")]
    | length == 1
      and .[0].label == "firstmate / default"
      and .[0].harness == "firstmate"
      and .[0].profile == "default"
      and .[0].commandAlias == "fmx"
      and .[0].models == []
      and .[0].modelOverrideSupported == false)
  and ([.choices[] | select(.id == "fmx:pstack-workers")]
    | length == 1
      and .[0].label == "firstmate / pstack-workers"
      and .[0].profile == "pstack-workers"
      and .[0].modelOverrideSupported == false)
  and ([.choices[] | select(.id == "omp:copilot")]
    | length == 1
      and .[0].label == "pi / oh-my-pi"
      and .[0].harness == "pi"
      and .[0].profile == "oh-my-pi")
  and ([.choices[] | select(.id == "omp:local")]
    | length == 1
      and .[0].label == "pi / local"
      and .[0].harness == "pi"
      and .[0].profile == "local")
  and ([.choices[] | select(.id == "picx:default")]
    | length == 1
      and .[0].label == "pi / default"
      and .[0].harness == "pi"
      and .[0].profile == "default"
      and .[0].defaultModel == "copilot-proxy-rs/gpt-5.6-sol:medium"
      and .[0].models == ["copilot-proxy-rs/gpt-5.6-sol:medium"]
      and .[0].modelOverrideSupported == false)
  and ([.choices[] | select(.id == "cdx:pstack")]
    | length == 1
      and .[0].label == "codex / pstack"
      and .[0].harness == "codex"
      and .[0].profile == "pstack"
      and .[0].commandAlias == "cdx"
      and .[0].defaultModel == "gpt-6-astra"
      and .[0].modelOverrideSupported == true)
  and ([.choices[] | select(.id == "cdx:youtube")]
    | length == 1
      and .[0].label == "codex / youtube"
      and .[0].harness == "codex"
      and .[0].profile == "youtube"
      and .[0].commandAlias == "cdx"
      and .[0].defaultModel == "gpt-6-astra"
      and .[0].skills == ["youtube-full"]
      and .[0].modelOverrideSupported == true)
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices did not expose launcher harness/profile identities'
jq -e '
  [.choices[] | select(.label == "jcode / jcx-p")]
  | length == 1
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices omitted jcode profile'
jq -e '
  [.choices[] | select(.label == "prime / prx-p")]
  | length == 1
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices omitted prime profile'
jq -e '
  [.choices[] | select(.label == "agency / trellage-azure")]
  | length == 1
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices omitted Agency profile'
jq -e '
  ([.choices[] | select(.id == "omp:local" or .id == "picx:default" or .commandAlias == "fmx" or .id == "agx:trellage-azure") | .modelOverrideSupported] | all(. == false))
  and ([.choices[] | select(.id != "omp:local" and .id != "picx:default" and .commandAlias != "fmx" and .id != "agx:trellage-azure") | .modelOverrideSupported] | all)
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router did not enable model overrides for every launcher except local Qwen'
jq -e '
  ([.choices[] | select(.id == "cdx:cdx-p") | .sandbox] == [false])
  and ([.choices[] | select(.id == "grx:grx-p") | .sandbox] == [true])
  and ([.choices[] | select(.id == "cdx:pstack") | .sandbox] == [false])
  and ([.choices[] | select(.id == "cdx:youtube") | .sandbox] == [false])
  and ([.choices[] | select(.commandAlias == "agx" or .commandAlias == "cldx" or .commandAlias == "fmx" or .commandAlias == "jcx" or .commandAlias == "omp" or .commandAlias == "picx" or .commandAlias == "prx") | .sandbox] | all(. == false))
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router did not expose accurate per-choice sandbox status'
[[ ! -e "$inventory_log" ]] \
  || fail 'router read diagnostic inventory before launching the selected profile'

inventory_output="$("$fixture_bin/trx" inventory cpx cpx-p --json)" \
  || fail 'trx inventory failed for a known launcher/profile'
jq -e '
  .schemaVersion == 1
  and .launcher == "cpx"
  and .profile == "cpx-p"
  and .readiness == "healthy"
' <<<"$inventory_output" >/dev/null \
  || fail 'trx inventory did not return the expected readiness contract'

busy_inventory_output="$(TRX_INVENTORY_READINESS=busy \
  "$fixture_bin/trx" inventory prx prx-p --json)" \
  || fail 'trx inventory rejected a busy launcher/profile'
jq -e '
  .launcher == "prx"
  and .profile == "prx-p"
  and .readiness == "busy"
' <<<"$busy_inventory_output" >/dev/null \
  || fail 'trx inventory did not preserve busy readiness'

firstmate_inventory_output="$("$fixture_bin/trx" inventory fmx default --json)" \
  || fail 'trx inventory failed for Firstmate'
jq -e '
  .launcher == "fmx"
  and .harness == "firstmate"
  and .profile == "default"
  and .readiness == "healthy"
' <<<"$firstmate_inventory_output" >/dev/null \
  || fail 'trx inventory did not route to Firstmate'

status=0
"$fixture_bin/trx" inventory bogus cpx-p --json >"$fixture_root/inventory-bad-launcher.out" \
  2>"$fixture_root/inventory-bad-launcher.err" || status=$?
[[ "$status" == 1 ]] || fail "trx inventory for an unknown launcher exited $status instead of 1"
assert_contains 'unknown launcher: bogus' "$fixture_root/inventory-bad-launcher.err"

status=0
"$fixture_bin/trx" inventory cpx cpx-p >"$fixture_root/inventory-missing-json.out" \
  2>"$fixture_root/inventory-missing-json.err" || status=$?
[[ "$status" == 1 ]] || fail "trx inventory without --json exited $status instead of 1"
assert_contains 'inventory requires LAUNCHER PROFILE --json' "$fixture_root/inventory-missing-json.err"

mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
python3 - "$argument_log" <<'PY' || fail 'arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"two words", b"", b"--literal=*", b""]
raise SystemExit(0 if actual == expected else 1)
PY

# Selecting Prime without passthrough arguments must invoke PRX with only its
# profile argument. This composes with the PRX argument-free launch contract.
cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"prx:prx-p","target":"current"}\n')
EOF
: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/prx-select.out" \
  '\r' '' "$fixture_bin/trx" \
  || fail 'argument-free Prime selection failed'
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
python3 - "$argument_log" <<'PY' || fail 'argument-free Prime selection arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
# The final empty field is the split after the profile's NUL terminator.
expected = [b"prx", b"prx-p", b""]
if actual != expected:
    print(f"actual={actual!r} expected={expected!r}", file=sys.stderr)
    raise SystemExit(1)
PY

herdr_log="$fixture_root/herdr.log"
cat >"$fixture_bin/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TRX_HERDR_LOG"
if [[ "${1-} ${2-}" == 'pane split' ]]; then
  printf '%s\n' '{"result":{"pane":{"pane_id":"w1:p2"}}}'
fi
EOF
chmod 0755 "$fixture_bin/herdr"
cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"cdx:cdx-p","target":"herdr","model":"gpt-5.6-terra"}\n')
EOF
HERDR_ENV=1 HERDR_PANE_ID=w1:p1 TRX_HERDR_LOG="$herdr_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/herdr-select.out" \
  'l' '' "$fixture_bin/trx" '--literal=herdr' \
  || fail 'Herdr profile launch failed'
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
assert_contains 'pane split --current --direction right --cwd ' "$herdr_log"
assert_contains 'pane run w1:p2 ' "$herdr_log"
assert_contains '--model gpt-5.6-terra --literal=herdr' "$herdr_log"

cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"cdx:youtube","target":"herdr"}\n')
EOF
: >"$herdr_log"
herdr_youtube_status=0
TRANSCRIPT_API_KEY='router-herdr-contract-secret' \
  HERDR_ENV=1 HERDR_PANE_ID=w1:p1 TRX_HERDR_LOG="$herdr_log" \
  python3 "$prototype_root/tests/pty_driver.py" \
    "$fixture_root/herdr-youtube-select.out" '\r' '' "$fixture_bin/trx" \
  || herdr_youtube_status=$?
[[ "$herdr_youtube_status" == 1 ]] \
  || fail "explicit-key Herdr launch exited $herdr_youtube_status instead of 1"
assert_contains \
  'explicit TRANSCRIPT_API_KEY cannot be forwarded securely to Herdr' \
  "$fixture_root/herdr-youtube-select.out"
[[ ! -s "$herdr_log" ]] || fail 'rejected explicit-key Herdr launch invoked Herdr'
if grep -F 'router-herdr-contract-secret' \
  "$fixture_root/herdr-youtube-select.out" "$herdr_log" >/dev/null; then
  fail 'rejected explicit-key Herdr launch disclosed the key'
fi
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
rm "$fixture_bin/herdr"

cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"omp:copilot","target":"current"}\n')
EOF
TRX_ARGUMENT_LOG="$argument_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/omp-select.out" \
  '\r' '' "$fixture_bin/trx" '--native-copilot' \
  || fail 'OMP interactive selection failed'
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
python3 - "$argument_log" <<'PY' || fail 'OMP arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"omp", b"copilot", b"--native-copilot", b""]
raise SystemExit(0 if actual == expected else 1)
PY

: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" \
  "$fixture_bin/trx" run cpx cpx-p -- --prompt 'Reply exactly OK' --flag ''
python3 - "$argument_log" <<'PY' || fail 'trx run arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [
    b"cpx",
    b"cpx-p",
    b"--prompt",
    b"Reply exactly OK",
    b"--flag",
    b"",
    b"",
]
raise SystemExit(0 if actual == expected else 1)
PY

: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" "$fixture_bin/trx" run cpx cpx-p
python3 - "$argument_log" <<'PY' || fail 'argument-free trx run launch differs'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b""]
raise SystemExit(0 if actual == expected else 1)
PY

: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" "$fixture_bin/trx" run fmx pstack-workers
python3 - "$argument_log" <<'PY' || fail 'trx run did not route to Firstmate'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"fmx", b"pstack-workers", b""]
raise SystemExit(0 if actual == expected else 1)
PY

: >"$argument_log"
: >"$fixture_root/router-environment.log"
TRANSCRIPT_API_KEY='router-contract-secret' \
  TRX_ARGUMENT_LOG="$argument_log" \
  TRX_ENV_LOG="$fixture_root/router-environment.log" \
  bash -a "$fixture_bin/trx" run cdx youtube
python3 - "$argument_log" <<'PY' || fail 'trx run YouTube arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cdx", b"youtube", b""]
raise SystemExit(0 if actual == expected else 1)
PY
[[ "$(grep -Fxc 'cdx:true' "$fixture_root/router-environment.log")" == 1 ]] \
  || fail 'trx did not restore the YouTube key only for the selected cdx child'
if grep -F ':true' "$fixture_root/router-environment.log" \
  | grep -Fvx 'cdx:true' >/dev/null; then
  fail 'trx exposed the YouTube key to a catalog helper'
fi

status=0
"$fixture_bin/trx" run cpx missing >"$fixture_root/run-missing.out" \
  2>"$fixture_root/run-missing.err" || status=$?
[[ "$status" == 1 ]] || fail "unknown trx run profile exited $status instead of 1"
assert_contains 'unknown profile for cpx: missing' "$fixture_root/run-missing.err"

status=0
"$fixture_bin/trx" run invalid cpx-p >"$fixture_root/run-launcher.out" \
  2>"$fixture_root/run-launcher.err" || status=$?
[[ "$status" == 1 ]] || fail "unknown trx run launcher exited $status instead of 1"
assert_contains 'unknown launcher: invalid' "$fixture_root/run-launcher.err"

status=0
"$fixture_bin/trx" run cpx cpx-p --prompt OK >"$fixture_root/run-delimiter.out" \
  2>"$fixture_root/run-delimiter.err" || status=$?
[[ "$status" == 1 ]] || fail "trx run accepted arguments without --"
assert_contains 'run arguments must follow --' "$fixture_root/run-delimiter.err"

status=0
TRX_ARGUMENT_LOG="$argument_log" \
  TRX_CHILD_EXIT=37 \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/child-exit.out" \
  'co\x1e\x1b[B\x1e\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status instead of 37"
python3 - "$argument_log" <<'PY' || fail 'filtered arrow selection did not launch the next profile'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cdx", b"pstack", b""]
if actual != expected:
    print(f"expected {expected!r}, got {actual!r}", file=sys.stderr)
    raise SystemExit(1)
PY

status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/cancel.out" \
  '\x03' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 130 ]] || fail "cancellation exited $status instead of 130"

status=0
TRX_WAIT=1 \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/signal.out" \
  '\r' 'CHILD_READY' "$fixture_bin/trx" || status=$?
[[ "$status" == 143 ]] || fail "terminated child exited $status instead of 143"

mv "$fixture_bin/grx" "$fixture_bin/grx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing.out" \
  2>"$fixture_root/list-missing.err" || status=$?
[[ "$status" == 1 ]] || fail "missing launcher list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: grx' "$fixture_root/list-missing.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: grx' "$fixture_root/missing.out"
mv "$fixture_bin/grx.absent" "$fixture_bin/grx"

mv "$fixture_bin/cldx" "$fixture_bin/cldx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing-cldx.out" \
  2>"$fixture_root/list-missing-cldx.err" || status=$?
[[ "$status" == 1 ]] || fail "missing cldx list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: cldx' \
  "$fixture_root/list-missing-cldx.err"
mv "$fixture_bin/cldx.absent" "$fixture_bin/cldx"

mv "$fixture_bin/fmx" "$fixture_bin/fmx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing-fmx.out" \
  2>"$fixture_root/list-missing-fmx.err" || status=$?
[[ "$status" == 1 ]] || fail "missing fmx list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: fmx' \
  "$fixture_root/list-missing-fmx.err"
mv "$fixture_bin/fmx.absent" "$fixture_bin/fmx"

mv "$fixture_bin/omp" "$fixture_bin/omp.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-omp.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing OMP launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: omp' "$fixture_root/missing-omp.out"
mv "$fixture_bin/omp.absent" "$fixture_bin/omp"

mv "$fixture_bin/picx" "$fixture_bin/picx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing-picx.out" \
  2>"$fixture_root/list-missing-picx.err" || status=$?
[[ "$status" == 1 ]] || fail "missing picx list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: picx' \
  "$fixture_root/list-missing-picx.err"
mv "$fixture_bin/picx.absent" "$fixture_bin/picx"


mv "$fixture_bin/jcx" "$fixture_bin/jcx.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-jcx.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing jcx launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: jcx' "$fixture_root/missing-jcx.out"
mv "$fixture_bin/jcx.absent" "$fixture_bin/jcx"

mv "$fixture_bin/prx" "$fixture_bin/prx.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-prx.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing prx launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: prx' "$fixture_root/missing-prx.out"
mv "$fixture_bin/prx.absent" "$fixture_bin/prx"

mv "$fixture_bin/agx" "$fixture_bin/agx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing-agx.out" \
  2>"$fixture_root/list-missing-agx.err" || status=$?
[[ "$status" == 1 ]] || fail "missing agx list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: agx' \
  "$fixture_root/list-missing-agx.err"
mv "$fixture_bin/agx.absent" "$fixture_bin/agx"

cp "$runtime_parent/cdx/catalog.json" "$fixture_root/cdx.catalog"
printf '{not-json}\n' >"$runtime_parent/cdx/catalog.json"
status=0
"$fixture_bin/trx" list --json >"$fixture_root/list-invalid-catalog.out" \
  2>"$fixture_root/list-invalid-catalog.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid catalog list exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/list-invalid-catalog.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/invalid.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "invalid catalog exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/invalid.out"
mv "$fixture_root/cdx.catalog" "$runtime_parent/cdx/catalog.json"

cp "$runtime_parent/cdx/catalog.json" "$fixture_root/cdx.headless.catalog"
python3 - "$runtime_parent/cdx/catalog.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
data["profiles"][0]["headless"]["questionToolControl"] = "invalid"
path.write_text(json.dumps(data, indent=2) + "\n")
PY
status=0
"$fixture_bin/trx" list --json >"$fixture_root/list-invalid-headless.out" \
  2>"$fixture_root/list-invalid-headless.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid headless catalog list exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/list-invalid-headless.err"
python3 - "$fixture_root/cdx.headless.catalog" "$runtime_parent/cdx/catalog.json" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
data = json.loads(source.read_text())
data["profiles"][0]["headless"]["trellageEventContract"] = "unsupported-trellage-events-v1"
destination.write_text(json.dumps(data, indent=2) + "\n")
PY
status=0
"$fixture_bin/trx" list --json >"$fixture_root/list-invalid-trellage-event.out" \
  2>"$fixture_root/list-invalid-trellage-event.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "unsupported Trellage event contract list exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/list-invalid-trellage-event.err"
mv "$fixture_root/cdx.headless.catalog" "$runtime_parent/cdx/catalog.json"

rm "$fixture_bin/cpx"
cp "$runtime_parent/cpx/bin/cpx" "$fixture_root/unrelated-cpx"
ln -s "$fixture_root/unrelated-cpx" "$fixture_bin/cpx"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-redirected.out" \
  2>"$fixture_root/list-redirected.err" || status=$?
[[ "$status" == 1 ]] || fail "redirected launcher list exited $status instead of 1"
assert_contains 'launcher is not the owned Trellage runtime: cpx' \
  "$fixture_root/list-redirected.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/redirected.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "redirected launcher exited $status instead of 1"
assert_contains 'launcher is not the owned Trellage runtime: cpx' "$fixture_root/redirected.out"
rm "$fixture_bin/cpx"
ln -s "$runtime_parent/cpx/bin/cpx" "$fixture_bin/cpx"

printf 'unrelated\n' \
  >"$runtime_parent/trx/share/profile-guides/native/cpx/unrelated.txt"
status=0
"$prototype_root/install.sh" >"$fixture_root/unrelated-guide-install.out" \
  2>"$fixture_root/unrelated-guide-install.err" || status=$?
[[ "$status" == 1 ]] || fail "unrelated profile guide install exited $status instead of 1"
assert_contains 'refusing unrelated profile guide path' \
  "$fixture_root/unrelated-guide-install.err"
rm "$runtime_parent/trx/share/profile-guides/native/cpx/unrelated.txt"

ln -s "$fixture_root/unrelated-command" \
  "$runtime_parent/trx/share/profile-guides/native/cpx/redirected.md"
status=0
"$prototype_root/install.sh" >"$fixture_root/symlink-guide-install.out" \
  2>"$fixture_root/symlink-guide-install.err" || status=$?
[[ "$status" == 1 ]] || fail "symlinked profile guide install exited $status instead of 1"
assert_contains 'refusing symlinked profile guide path' \
  "$fixture_root/symlink-guide-install.err"
rm "$runtime_parent/trx/share/profile-guides/native/cpx/redirected.md"

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
  >"$runtime_parent/trx/share/profile-guides/native/cpx/unrelated.txt"
status=0
"$prototype_root/uninstall.sh" >"$fixture_root/unrelated-guide-uninstall.out" \
  2>"$fixture_root/unrelated-guide-uninstall.err" || status=$?
[[ "$status" == 1 ]] || fail "unrelated profile guide uninstall exited $status instead of 1"
assert_contains 'refusing unrelated profile guide path' \
  "$fixture_root/unrelated-guide-uninstall.err"
[[ -d "$runtime_parent/trx" ]] || fail 'unsafe guide uninstall removed trx runtime'
rm "$runtime_parent/trx/share/profile-guides/native/cpx/unrelated.txt"

ln -s "$fixture_root/unrelated-command" \
  "$runtime_parent/trx/share/profile-guides/native/cpx/redirected.md"
status=0
"$prototype_root/uninstall.sh" >"$fixture_root/symlink-guide-uninstall.out" \
  2>"$fixture_root/symlink-guide-uninstall.err" || status=$?
[[ "$status" == 1 ]] || fail "symlinked profile guide uninstall exited $status instead of 1"
assert_contains 'refusing symlinked profile guide path' \
  "$fixture_root/symlink-guide-uninstall.err"
[[ -d "$runtime_parent/trx" ]] || fail 'symlinked guide uninstall removed trx runtime'
rm "$runtime_parent/trx/share/profile-guides/native/cpx/redirected.md"

mv "$runtime_parent/trx/lib/launcher.mjs" \
  "$runtime_parent/trx/lib/terminal-picker.mjs"
"$prototype_root/uninstall.sh" >"$fixture_root/uninstall.out"
[[ ! -e "$runtime_parent/trx" ]] || fail 'uninstaller left trx runtime'
[[ ! -e "$fixture_bin/trx" && ! -L "$fixture_bin/trx" ]] \
  || fail 'uninstaller left trx command'
[[ -x "$runtime_parent/cpx/bin/cpx" && -x "$runtime_parent/cdx/bin/cdx" \
  && -x "$runtime_parent/agx/bin/agx" \
  && -x "$runtime_parent/cldx/bin/cldx" && -x "$runtime_parent/fmx/bin/fmx" \
  && -x "$runtime_parent/grx/bin/grx" \
  && -x "$runtime_parent/jcx/bin/jcx" \
  && -x "$runtime_parent/omp/bin/omp" && -x "$runtime_parent/picx/bin/picx" \
  && -x "$runtime_parent/prx/bin/prx" ]] \
  || fail 'uninstaller changed native launchers'
assert_contains 'Uninstalled trx.' "$fixture_root/uninstall.out"

printf 'trx contract: PASS\n'
