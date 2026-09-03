#!/usr/bin/env bash

set -u
set -o pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
launcher="$root/bin/jcx"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"

fail() {
  printf 'jcx contract failed: %s\n' "$1" >&2
  exit 1
}

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-jcx-contract.XXXXXX")" \
  || fail 'could not create fixture root'
trap 'rm -rf -- "$fixture_root"' EXIT HUP INT TERM

fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
mkdir -p "$fake_bin" "$home"

cat >"$fake_bin/mise" <<'FAKE_MISE'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_MISE_LOG"
tool='github:1jehuang/jcode'
install_name='github-1jehuang-jcode'

case "${1-}" in
  latest)
    [[ "${2-}" == "$tool" ]] || exit 90
    printf '%s\n' "${FAKE_MISE_LATEST:-0.67.1}"
    ;;
  install)
    spec="${2-}"
    version="${spec#"$tool"@}"
    [[ "$spec" == "$tool@$version" && "$version" != "$spec" ]] || exit 91
    [[ "${FAKE_MISE_INSTALL_FAIL_VERSION-}" != "$version" ]] || exit 93
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    mkdir -p "$destination"
    # Current mise github backends rename the single extracted asset to the
    # plain tool name ("jcode"), not the original release asset name.
    sed "s/@VERSION@/$version/g" "$FAKE_JCODE_TEMPLATE" \
      >"$destination/jcode"
    chmod 0755 "$destination/jcode"
    ;;
  where)
    spec="${2-}"
    version="${spec#"$tool"@}"
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    [[ -x "$destination/jcode" ]] || exit 1
    printf '%s\n' "$destination"
    ;;
  *) exit 92 ;;
esac
FAKE_MISE
chmod 0755 "$fake_bin/mise"

cat >"$fixture_root/fake-jcode-template" <<'FAKE_JCODE'
#!/usr/bin/env bash
set -u

if [[ "${1-}" == --version ]]; then
  printf 'jcode v%s (test)\n' '@VERSION@'
  exit 0
fi

if [[ "$*" == '--no-update provider current --json' ]]; then
  [[ -z "${JCODE_MODEL-}" ]] || exit 94
  [[ "${JCODE_OPENAI_EXTRA_BODY-}" == '{}' ]] || exit 95
  [[ "${JCODE_CROSS_PROVIDER_FAILOVER-}" == manual ]] || exit 96
  grep -Fqx 'value = [' "$JCODE_HOME/config.toml" && exit 1
  printf '%s\n' \
    '{"requested_provider":"auto","requested_model":null,"resolved_provider":"trellage-copilot-proxy","selected_model":"gpt-5.6-sol"}'
  exit 0
fi

jq -cn \
  --arg home "${JCODE_HOME-}" \
  --arg noTelemetry "${JCODE_NO_TELEMETRY-}" \
  --arg provider "${JCODE_PROVIDER-}" \
  --arg model "${JCODE_MODEL-}" \
  --arg effort "${JCODE_OPENAI_REASONING_EFFORT-}" \
  --arg extraBody "${JCODE_OPENAI_EXTRA_BODY-}" \
  --arg maxTokens "${JCODE_OPENROUTER_MAX_TOKENS-}" \
  --arg failover "${JCODE_CROSS_PROVIDER_FAILOVER-}" \
  '$ARGS.named + {args:$ARGS.positional}' \
  --args -- "$@" >>"$FAKE_JCODE_LOG"

if [[ "${FAKE_JCODE_WAIT_FOR_SIGNAL-}" == 1 ]]; then
  trap 'printf "TERM\n" >>"$FAKE_JCODE_SIGNAL_LOG"; exit 143' TERM
  printf 'READY\n' >>"$FAKE_JCODE_SIGNAL_LOG"
  while :; do sleep 0.05; done
fi

exit "${FAKE_JCODE_EXIT_STATUS:-0}"
FAKE_JCODE
chmod 0755 "$fixture_root/fake-jcode-template"

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
url="${!#}"
case "$url" in
  http://127.0.0.1:8080/health)
    [[ "${FAKE_PROXY_HEALTH:-ok}" == ok ]] || exit 22
    printf '{"status":"ok"}\n'
    ;;
  http://127.0.0.1:8080/v1/models)
    if [[ "${FAKE_PROXY_HAS_MODEL:-1}" == 1 ]]; then
      printf '{"data":[{"id":"gpt-5.6-sol"}]}\n'
    else
      printf '{"data":[{"id":"another-model"}]}\n'
    fi
    ;;
  *) exit 93 ;;
esac
FAKE_CURL
chmod 0755 "$fake_bin/curl"

install_fixture_node "$fake_bin"
seed_floating_skills_cache "$home"
export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$home"
export FAKE_MISE_LOG="$fixture_root/mise.log"
export FAKE_CURL_LOG="$fixture_root/curl.log"
export FAKE_JCODE_LOG="$fixture_root/jcode.log"
export FAKE_JCODE_TEMPLATE="$fixture_root/fake-jcode-template"
export FAKE_JCODE_SIGNAL_LOG="$fixture_root/signal.log"
: >"$FAKE_MISE_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_JCODE_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
command_path="$HOME/.local/bin/jcx"
runtime_root="$HOME/.local/share/trellage/jcx"
profile_root="$HOME/.local/share/trellage/profiles/jcode/default"
profile_home="$profile_root/home"

[[ -L "$command_path" ]] || fail 'installer did not publish command symlink'
[[ "$(readlink "$command_path")" == "$runtime_root/bin/jcx" ]] \
  || fail 'command symlink target differs'
cmp -s "$runtime_root/catalog.json" "$root/catalog.json" \
  || fail 'installer did not publish catalog'
cmp -s "$runtime_root/config-manager.mjs" "$root/config-manager.mjs" \
  || fail 'installer did not publish config manager'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "jcx"
  and .harness == "jcode"
  and .sandbox == false
  and [.profiles[].name] == ["default"]
  and .profiles[0].source == "1jehuang/jcode"
  and .profiles[0].description == "jcode for memory-backed, browser-driven, and coordinated-swarm work, with persistent sessions and keyless gpt-5.6-sol routing."
  and .profiles[0].headless == {
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
  }
' "$fixture_root/list.json" >/dev/null || fail 'JSON list differs'

cp "$runtime_root/catalog.json" "$fixture_root/catalog.saved" || fail 'could not save catalog'
jq '.profiles.default.headless.sessionId = "bogus"' "$runtime_root/catalog.json" \
  >"$fixture_root/catalog.invalid" || fail 'could not create invalid catalog'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json >"$fixture_root/invalid-list.out" 2>"$fixture_root/invalid-list.err"; then
  fail 'list accepted invalid headless catalog'
fi
grep -Fq 'jcx: invalid catalog:' "$fixture_root/invalid-list.err" \
  || fail 'invalid headless catalog diagnostic differs'
jq '.profiles.default.headless.trellageEventContract = "unsupported-trellage-events-v1"' \
  "$fixture_root/catalog.saved" >"$fixture_root/catalog.invalid" \
  || fail 'could not create invalid Trellage event contract'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json \
  >"$fixture_root/invalid-trellage-event-list.out" \
  2>"$fixture_root/invalid-trellage-event-list.err"; then
  fail 'list accepted unsupported Trellage event contract'
fi
grep -Fq 'jcx: invalid catalog:' "$fixture_root/invalid-trellage-event-list.err" \
  || fail 'unsupported Trellage event contract diagnostic differs'
mv "$fixture_root/catalog.saved" "$runtime_root/catalog.json"

if ! "$command_path" run self-heal-before-setup-probe \
  >"$fixture_root/self-heal.out" 2>&1; then
  cat "$fixture_root/self-heal.out" >&2
  fail 'launch before explicit setup did not self-heal'
fi
[[ -f "$profile_root/.managed-by-trellage-jcode-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
[[ "$(<"$runtime_root/installed-version")" == 0.67.1 ]] \
  || fail 'self-healed launch did not record installed version'
rm -rf "$profile_root" "$runtime_root/installed-version"
: >"$FAKE_JCODE_LOG"

"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
[[ "$(<"$runtime_root/installed-version")" == 0.67.1 ]] \
  || fail 'setup did not record installed version'
[[ ! -e "$runtime_root/version" ]] || fail 'setup retained legacy version state'
[[ -f "$profile_root/.managed-by-trellage-jcode-profiles" ]] \
  || fail 'setup did not mark profile ownership'
[[ -d "$profile_home" && ! -L "$profile_home" ]] || fail 'profile home is unsafe'
[[ -f "$profile_home/config.toml" && ! -L "$profile_home/config.toml" ]] \
  || fail 'setup did not materialize config.toml'
grep -Fqx 'default_provider = "trellage-copilot-proxy"' "$profile_home/config.toml" \
  || fail 'config does not default to managed provider'
grep -Fqx 'default_model = "gpt-5.6-sol"' "$profile_home/config.toml" \
  || fail 'config does not default to GPT-5.6 Sol'
grep -Fqx 'openai_reasoning_effort = "medium"' "$profile_home/config.toml" \
  || fail 'config does not default to medium reasoning'
grep -Fqx 'cross_provider_failover = "manual"' "$profile_home/config.toml" \
  || fail 'config enables automatic cross-provider failover'
grep -Fqx 'base_url = "http://127.0.0.1:8080/v1"' "$profile_home/config.toml" \
  || fail 'config does not use copilot-proxy-rs'
grep -Fqx 'auth = "none"' "$profile_home/config.toml" \
  || fail 'config does not use keyless proxy auth'
grep -Fqx 'provider_routing = false' "$profile_home/config.toml" \
  || fail 'config enables provider routing'
grep -Fqx 'allow_provider_pinning = false' "$profile_home/config.toml" \
  || fail 'config enables provider pinning'
grep -Fqx 'supports_reasoning_effort = true' "$profile_home/config.toml" \
  || fail 'config does not enable reasoning effort'
! grep -Eiq '^[[:space:]]*(api[_-]?key|token|secret|password)[[:space:]]*=' \
  "$profile_home/config.toml" \
  || fail 'managed config contains credential-shaped data'
jq -e '.launch_count == 6' "$profile_home/setup_hints.json" >/dev/null \
  || fail 'setup did not skip first-run onboarding'

mv "$runtime_root/installed-version" "$runtime_root/version"
"$command_path" doctor >"$fixture_root/legacy-receipt-doctor.out" \
  || fail 'doctor did not migrate the legacy version receipt'
[[ "$(<"$runtime_root/installed-version")" == 0.67.1 && ! -e "$runtime_root/version" ]] \
  || fail 'legacy version receipt migration differs'

"$command_path" list --json >"$fixture_root/list-verified.json" || fail 'verified JSON list failed'
jq -e '
  .profiles[0].headless == {
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
  }
' "$fixture_root/list-verified.json" >/dev/null || fail 'verified JSON list differs'

"$command_path" doctor >"$fixture_root/doctor.out" || fail 'doctor failed'
grep -Fq 'jcx doctor: OK (0.67.1, gpt-5.6-sol, medium)' "$fixture_root/doctor.out" \
  || fail 'doctor output differs'

cat >"$profile_home/config.toml" <<'NORMALIZED_CONFIG'
[keybindings]
scroll_up = "ctrl+shift+k"

[display]
diff_mode = "inline"
disabled_animations = [
  "fade",
  "spin",
]

[provider]
default_model = "gpt-5.6-sol"
default_provider = "trellage-copilot-proxy"
openai_reasoning_effort = "medium"
cross_provider_failover = "manual"
openai_service_tier = "priority"

[providers.trellage-copilot-proxy]
type = "open-ai-compatible"
base_url = "http://127.0.0.1:8080/v1"
auth = "none"
default_model = "gpt-5.6-sol"
requires_api_key = false
provider_routing = false
model_catalog = true
allow_provider_pinning = false
supports_reasoning_effort = true

[[providers.trellage-copilot-proxy.models]]
id = "gpt-5.6-sol"

[agents] # JCode-owned state
swarm_spawn_mode = "inline"

[ambient]
provider = "ambient-provider"
NORMALIZED_CONFIG
chmod 0600 "$profile_home/config.toml"
cp "$profile_home/config.toml" "$fixture_root/runtime-normalized-config"
"$command_path" doctor >"$fixture_root/normalized-doctor.out" \
  || fail 'doctor rejected runtime-normalized config'
JCODE_MODEL=ambient-wrong-model \
  JCODE_OPENAI_EXTRA_BODY='{"model":"ambient-wrong-model"}' \
  JCODE_CROSS_PROVIDER_FAILOVER=countdown \
  "$command_path" doctor >"$fixture_root/ambient-doctor.out" \
  || fail 'ambient JCode overrides affected doctor'
"$command_path" run runtime-normalized-probe \
  || fail 'launch rejected runtime-normalized config'
cmp -s "$profile_home/config.toml" "$fixture_root/runtime-normalized-config" \
  || fail 'launch replaced JCode-owned normalized config'

while IFS='|' read -r label old new; do
  cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
  awk -v old="$old" -v new="$new" '
    !changed && $0 == old { print new; changed = 1; next }
    { print }
    END { if (!changed) exit 1 }
  ' "$profile_home/config.toml" >"$fixture_root/config.mutated" \
    || fail "could not create $label drift fixture"
  mv "$fixture_root/config.mutated" "$profile_home/config.toml"
  status=0
  "$command_path" doctor >"$fixture_root/$label-drift.out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || fail "doctor accepted $label drift"
  grep -Fq 'managed config differs; run jcx repair' \
    "$fixture_root/$label-drift.out" \
    || fail "$label drift diagnostic differs"
done <<'MANAGED_DRIFT_CASES'
provider|default_provider = "trellage-copilot-proxy"|default_provider = "other"
model|default_model = "gpt-5.6-sol"|default_model = "other"
reasoning|openai_reasoning_effort = "medium"|openai_reasoning_effort = "low"
failover|cross_provider_failover = "manual"|cross_provider_failover = "countdown"
provider-type|type = "open-ai-compatible"|type = "other"
proxy-url|base_url = "http://127.0.0.1:8080/v1"|base_url = "http://127.0.0.1:9999/v1"
auth|auth = "none"|auth = "bearer"
api-key-requirement|requires_api_key = false|requires_api_key = true
provider-routing|provider_routing = false|provider_routing = true
model-catalog|model_catalog = true|model_catalog = false
provider-pinning|allow_provider_pinning = false|allow_provider_pinning = true
reasoning-support|supports_reasoning_effort = true|supports_reasoning_effort = false
model-id|id = "gpt-5.6-sol"|id = "other"
MANAGED_DRIFT_CASES

while IFS='|' read -r label anchor addition; do
  cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
  awk -v anchor="$anchor" -v addition="$addition" '
    { print }
    !added && $0 == anchor { print addition; added = 1 }
    END { if (!added) exit 1 }
  ' "$profile_home/config.toml" >"$fixture_root/config.mutated" \
    || fail "could not create $label override fixture"
  mv "$fixture_root/config.mutated" "$profile_home/config.toml"
  status=0
  "$command_path" doctor >"$fixture_root/$label-override.out" 2>&1 || status=$?
  [[ "$status" == 1 ]] || fail "doctor accepted $label override"
  grep -Fq 'managed config differs; run jcx repair' \
    "$fixture_root/$label-override.out" \
    || fail "$label override diagnostic differs"
done <<'MANAGED_OVERRIDE_CASES'
auth-header|auth = "none"|auth_header = "Authorization"
quoted-api-key|auth = "none"|"api_key" = ""
model-reasoning|id = "gpt-5.6-sol"|reasoning_effort = "low"
MANAGED_OVERRIDE_CASES

cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
cat >>"$profile_home/config.toml" <<'HEADER_OVERRIDE'

[providers.trellage-copilot-proxy.headers]
Authorization = ""
HEADER_OVERRIDE
status=0
"$command_path" doctor >"$fixture_root/header-override.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted managed provider headers'
grep -Fq 'managed config differs; run jcx repair' \
  "$fixture_root/header-override.out" \
  || fail 'managed provider header diagnostic differs'

cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
cat >>"$profile_home/config.toml" <<'QUOTED_OVERRIDE'

[providers."trellage-copilot-proxy".extra_body]
model = "other"
QUOTED_OVERRIDE
status=0
"$command_path" doctor >"$fixture_root/quoted-override.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted quoted managed provider override'
grep -Fq 'managed config differs; run jcx repair' \
  "$fixture_root/quoted-override.out" \
  || fail 'quoted managed provider override diagnostic differs'

cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
cat >>"$profile_home/config.toml" <<'SPACED_OVERRIDE'

[ providers . "trellage-copilot-proxy" . headers ]
Authorization = ""
SPACED_OVERRIDE
status=0
"$command_path" doctor >"$fixture_root/spaced-override.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted spaced managed provider override'
grep -Fq 'managed config differs; run jcx repair' \
  "$fixture_root/spaced-override.out" \
  || fail 'spaced managed provider override diagnostic differs'

cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
cat >>"$profile_home/config.toml" <<'COMMENTED_OVERRIDE'

[providers.trellage-copilot-proxy.extra_body] # = hidden override
model = "other"
COMMENTED_OVERRIDE
status=0
"$command_path" doctor >"$fixture_root/commented-override.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted commented managed provider override'
grep -Fq 'managed config differs; run jcx repair' \
  "$fixture_root/commented-override.out" \
  || fail 'commented managed provider override diagnostic differs'
"$command_path" run commented-override-repair-probe \
  || fail 'launch did not repair commented managed provider override'
! grep -Fq '[providers.trellage-copilot-proxy.extra_body]' \
  "$profile_home/config.toml" \
  || fail 'repair preserved commented managed provider override'
grep -Fqx 'swarm_spawn_mode = "inline"' "$profile_home/config.toml" \
  || fail 'commented override repair removed JCode-owned state'

cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
printf '\nvalue = [\n' >>"$profile_home/config.toml"
status=0
"$command_path" doctor >"$fixture_root/malformed-toml.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted malformed TOML'
grep -Fq 'managed config differs; run jcx repair' \
  "$fixture_root/malformed-toml.out" \
  || fail 'malformed TOML diagnostic differs'

cp "$fixture_root/runtime-normalized-config" "$profile_home/config.toml"
"$command_path" repair >"$fixture_root/normalized-repair.out" \
  || fail 'repair rejected runtime-normalized config'
grep -Fqx 'scroll_up = "ctrl+shift+k"' "$profile_home/config.toml" \
  || fail 'repair removed JCode-owned keybindings'
grep -Fqx 'diff_mode = "inline"' "$profile_home/config.toml" \
  || fail 'repair removed JCode-owned display settings'
grep -Fqx 'swarm_spawn_mode = "inline"' "$profile_home/config.toml" \
  || fail 'repair removed JCode-owned agent settings'
grep -Fqx 'provider = "ambient-provider"' "$profile_home/config.toml" \
  || fail 'repair removed JCode-owned ambient provider settings'
grep -Fqx 'disabled_animations = [ "fade", "spin" ]' "$profile_home/config.toml" \
  || fail 'repair removed valid multiline JCode settings'
"$command_path" doctor >"$fixture_root/doctor-after-normalized-repair.out" \
  || fail 'doctor rejected repaired runtime-normalized config'

awk '
  $0 == "base_url = \"http://127.0.0.1:8080/v1\"" {
    print "base_url = \"http://127.0.0.1:9999/v1\""
    next
  }
  { print }
' "$profile_home/config.toml" >"$fixture_root/config.mutated"
mv "$fixture_root/config.mutated" "$profile_home/config.toml"
"$command_path" run semantic-drift-repair-probe \
  || fail 'launch did not repair managed drift'
grep -Fqx 'base_url = "http://127.0.0.1:8080/v1"' "$profile_home/config.toml" \
  || fail 'launch did not restore the managed proxy URL'
grep -Fqx 'scroll_up = "ctrl+shift+k"' "$profile_home/config.toml" \
  || fail 'managed drift repair removed JCode-owned keybindings'
grep -Fqx 'diff_mode = "inline"' "$profile_home/config.toml" \
  || fail 'managed drift repair removed JCode-owned display settings'
grep -Fqx 'swarm_spawn_mode = "inline"' "$profile_home/config.toml" \
  || fail 'managed drift repair removed JCode-owned agent settings'
grep -Fqx 'provider = "ambient-provider"' "$profile_home/config.toml" \
  || fail 'managed drift repair removed JCode-owned ambient settings'

latest_calls_before="$(grep -c '^latest ' "$FAKE_MISE_LOG" || :)"
JCODE_MODEL=ambient-wrong-model \
  JCODE_OPENAI_EXTRA_BODY='{"model":"ambient-wrong-model"}' \
  JCODE_OPENROUTER_MAX_TOKENS=1 \
  JCODE_CROSS_PROVIDER_FAILOVER=countdown \
  "$command_path" default run 'two words' '' '--literal=*' \
  || fail 'explicit launch failed'
[[ "$(grep -c '^latest ' "$FAKE_MISE_LOG" || :)" == "$latest_calls_before" ]] \
  || fail 'ordinary launch resolved latest instead of reusing the receipt'
jq -e --arg home "$profile_home" '
  .home == $home
  and .noTelemetry == "1"
  and .provider == "trellage-copilot-proxy"
  and .model == "gpt-5.6-sol"
  and .effort == "medium"
  and .extraBody == "{}"
  and .maxTokens == ""
  and .failover == "manual"
  and .args == ["--no-update", "run", "two words", "", "--literal=*"]
' "$FAKE_JCODE_LOG" >/dev/null || fail 'launch environment or arguments differ'

printf '{"launch_count":1,"hotkey_dismissed":true}\n' \
  >"$profile_home/setup_hints.json"
"$command_path" run onboarding-probe || fail 'onboarding repair launch failed'
jq -e '.launch_count == 6 and .hotkey_dismissed == true' \
  "$profile_home/setup_hints.json" >/dev/null \
  || fail 'launch did not skip onboarding while preserving setup state'

printf 'drift\n' >>"$profile_home/config.toml"
status=0
"$command_path" doctor >"$fixture_root/drift.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted modified managed config'
grep -Fq 'managed config differs; run jcx repair' "$fixture_root/drift.out" \
  || fail 'managed config drift error differs'
"$command_path" run drift-repair-probe \
  || fail 'launch did not self-heal managed config'
"$command_path" doctor >"$fixture_root/doctor-after-drift.out" \
  || fail 'doctor rejected launch-repaired managed config'
grep -Fq 'jcx doctor: OK (0.67.1, gpt-5.6-sol, medium)' \
  "$fixture_root/doctor-after-drift.out" \
  || fail 'doctor output differs after launch repair'

rm "$profile_home/config.toml"
"$command_path" run missing-config-repair-probe \
  || fail 'launch did not restore missing managed config'
[[ -f "$profile_home/config.toml" && ! -L "$profile_home/config.toml" ]] \
  || fail 'launch did not materialize missing managed config safely'

printf 'outside\n' >"$fixture_root/outside-config"
rm "$profile_home/config.toml"
ln -s "$fixture_root/outside-config" "$profile_home/config.toml"
status=0
"$command_path" run unsafe-config-probe >"$fixture_root/unsafe-config.out" 2>&1 \
  || status=$?
[[ "$status" == 1 ]] || fail 'launch accepted symlinked managed config'
grep -Fq "unsafe managed config: $profile_home/config.toml" \
  "$fixture_root/unsafe-config.out" \
  || fail 'unsafe managed config error differs'
[[ "$(<"$fixture_root/outside-config")" == outside ]] \
  || fail 'launch changed symlinked managed config target'
rm "$profile_home/config.toml"
"$command_path" run symlink-recovery-probe \
  || fail 'launch did not recover after unsafe managed config removal'

status=0
FAKE_JCODE_EXIT_STATUS=37 "$command_path" run probe || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status"

FAKE_PROXY_HAS_MODEL=0 "$command_path" doctor >"$fixture_root/model.out" 2>&1 \
  && fail 'doctor accepted missing model'
grep -Fq 'copilot-proxy-rs model is missing: gpt-5.6-sol' "$fixture_root/model.out" \
  || fail 'missing model error differs'

FAKE_MISE_LATEST=0.68.0 "$command_path" update --check \
  >"$fixture_root/update-check.out" || fail 'update check failed'
grep -Fq '0.67.1 -> 0.68.0 available' "$fixture_root/update-check.out" \
  || fail 'update check output differs'
if FAKE_MISE_LATEST=0.68.0 FAKE_MISE_INSTALL_FAIL_VERSION=0.68.0 \
  "$command_path" update >"$fixture_root/update-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when mise failed'
fi
[[ "$(<"$runtime_root/installed-version")" == 0.67.1 ]] \
  || fail 'failed update replaced installed version receipt'
FAKE_MISE_LATEST=0.68.0 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/installed-version")" == 0.68.0 ]] \
  || fail 'update did not change installed version receipt'
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'

mkdir -p "$fixture_root/unrelated-home/.local/share/trellage/profiles/jcode/default"
printf 'unrelated\n' \
  >"$fixture_root/unrelated-home/.local/share/trellage/profiles/jcode/default/data"
status=0
HOME="$fixture_root/unrelated-home" "$runtime_root/bin/jcx" setup \
  >"$fixture_root/unrelated.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'setup accepted unrelated profile files'

"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
[[ ! -e "$runtime_root" ]] || fail 'uninstaller left runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstaller left command'
[[ -d "$profile_home" ]] || fail 'uninstaller removed profile state'

"$installer" >"$fixture_root/legacy-layout-install.out" \
  || fail 'legacy-layout reinstall failed'
rm "$runtime_root/config-manager.mjs"
"$uninstaller" >"$fixture_root/legacy-layout-uninstall.out" \
  || fail 'uninstaller rejected a legacy owned runtime'
[[ ! -e "$runtime_root" ]] || fail 'legacy-layout uninstall left runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] \
  || fail 'legacy-layout uninstall left command'
[[ -d "$profile_home" ]] || fail 'legacy-layout uninstall removed profile state'

printf 'jcx contract: PASS\n'
