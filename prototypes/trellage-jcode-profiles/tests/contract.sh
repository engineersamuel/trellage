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

jq -cn \
  --arg home "${JCODE_HOME-}" \
  --arg noTelemetry "${JCODE_NO_TELEMETRY-}" \
  --arg provider "${JCODE_PROVIDER-}" \
  --arg model "${JCODE_MODEL-}" \
  --arg effort "${JCODE_OPENAI_REASONING_EFFORT-}" \
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

"$command_path" run self-heal-before-setup-probe \
  >"$fixture_root/self-heal.out" 2>&1 \
  || fail 'launch before explicit setup did not self-heal'
[[ -f "$profile_root/.managed-by-trellage-jcode-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
[[ "$(<"$runtime_root/version")" == 0.67.1 ]] \
  || fail 'self-healed launch did not pin version'
rm -rf "$profile_root" "$runtime_root/version"
: >"$FAKE_JCODE_LOG"

"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
[[ "$(<"$runtime_root/version")" == 0.67.1 ]] || fail 'setup did not pin version'
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
grep -Fqx 'base_url = "http://127.0.0.1:8080/v1"' "$profile_home/config.toml" \
  || fail 'config does not use copilot-proxy-rs'
grep -Fqx 'auth = "none"' "$profile_home/config.toml" \
  || fail 'config does not use keyless proxy auth'
grep -Fqx 'supports_reasoning_effort = true' "$profile_home/config.toml" \
  || fail 'config does not enable reasoning effort'
! grep -Eiq '^[[:space:]]*(api[_-]?key|token|secret|password)[[:space:]]*=' \
  "$profile_home/config.toml" \
  || fail 'managed config contains credential-shaped data'
jq -e '.launch_count == 6' "$profile_home/setup_hints.json" >/dev/null \
  || fail 'setup did not skip first-run onboarding'

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

"$command_path" default run 'two words' '' '--literal=*' \
  || fail 'explicit launch failed'
jq -e --arg home "$profile_home" '
  .home == $home
  and .noTelemetry == "1"
  and .provider == "trellage-copilot-proxy"
  and .model == "gpt-5.6-sol"
  and .effort == "medium"
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
FAKE_MISE_LATEST=0.68.0 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/version")" == 0.68.0 ]] || fail 'update did not change pin'
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

printf 'jcx contract: PASS\n'
