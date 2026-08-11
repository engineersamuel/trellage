#!/usr/bin/env bash

set -u
set -o pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
launcher="$root/bin/omp"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"

fail() {
  printf 'omp contract failed: %s\n' "$1" >&2
  exit 1
}

for source_file in "$launcher" "$installer" "$uninstaller" "$root/README.md"; do
  [[ -f "$source_file" ]] || fail "missing source file: $source_file"
done

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-omp-contract.XXXXXX")" \
  || fail 'could not create fixture root'
case "$fixture_root" in
  "${TMPDIR:-/tmp}"/trellage-omp-contract.*) ;;
  *) fail "unsafe fixture root: $fixture_root" ;;
esac
trap 'rm -rf -- "$fixture_root"' EXIT HUP INT TERM

fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
mkdir -p "$fake_bin" "$home"

cat >"$fake_bin/mise" <<'FAKE_MISE'
#!/usr/bin/env bash
set -u

[[ "${MISE_GLOBAL_CONFIG_FILE-}" == /dev/null ]] || exit 96
[[ "${MISE_IGNORED_CONFIG_PATHS-}" == "$HOME" ]] || exit 97
printf '%s\n' "$*" >>"$FAKE_MISE_LOG"
tool='github:can1357/oh-my-pi'
install_name='github-can1357-oh-my-pi'

case "${1-}" in
  latest)
    [[ "${2-}" == "$tool" ]] || exit 90
    printf '%s\n' "${FAKE_MISE_LATEST:-17.2.6}"
    ;;
  install)
    spec="${2-}"
    version="${spec#"$tool"@}"
    [[ "$spec" == "$tool@$version" && "$version" != "$spec" ]] || exit 91
    [[ "${FAKE_MISE_INSTALL_FAIL_VERSION-}" != "$version" ]] || exit 72
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    mkdir -p "$destination"
    sed "s/@VERSION@/$version/g" "$FAKE_OMP_TEMPLATE" >"$destination/omp"
    chmod 0755 "$destination/omp"
    ;;
  where)
    spec="${2-}"
    version="${spec#"$tool"@}"
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    [[ -x "$destination/omp" ]] || exit 1
    printf '%s\n' "$destination"
    ;;
  *) exit 92 ;;
esac
FAKE_MISE
chmod 0755 "$fake_bin/mise"

cat >"$fixture_root/fake-omp-template" <<'FAKE_OMP'
#!/usr/bin/env bash
set -u

if [[ "${1-}" == '--version' ]]; then
  printf 'omp/%s\n' '@VERSION@'
  exit 0
fi

if [[ "${1-} ${2-}" == 'models github-copilot' ]]; then
  [[ "${FAKE_COPILOT_AUTH:-1}" == 1 \
    && "${COPILOT_GITHUB_TOKEN-}" == host-copilot-token ]] || {
    printf 'GitHub Copilot authentication required\n' >&2
    exit 41
  }
  printf 'github-copilot/gpt-test\n'
  printf 'github-copilot/gpt-5.6-sol\n'
  exit 0
fi

if [[ "${OMP_PROFILE-}" == trellage-copilot-native \
  && "${COPILOT_GITHUB_TOKEN-}" != host-copilot-token ]]; then
  printf 'GitHub Copilot authentication required\n' >&2
  exit 42
fi
if [[ "${OMP_PROFILE-}" == trellage-copilot-native \
  && ( -n "${GH_TOKEN-}" || -n "${GITHUB_TOKEN-}" ) ]]; then
  printf 'alternate GitHub tokens were not scrubbed\n' >&2
  exit 43
fi

if [[ "$#" -eq 0 ]]; then
  config="$HOME/.omp/profiles/${OMP_PROFILE-}/agent/config.yml"
  if ! grep -Fqx 'setupVersion: 1' "$config" \
    || ! grep -Fqx '  setupWizard: false' "$config"; then
    printf 'Choose your default model\n'
    exit 64
  fi
fi

jq -cn \
  --arg version '@VERSION@' \
  --arg profile "${OMP_PROFILE-}" \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  '$ARGS.named + {args:$ARGS.positional}' \
  --args -- "$@" >>"$FAKE_OMP_LOG"

if [[ "${FAKE_OMP_WAIT_FOR_SIGNAL-}" == 1 ]]; then
  trap 'printf "TERM\n" >>"$FAKE_OMP_SIGNAL_LOG"; exit 143' TERM
  printf 'READY\n' >>"$FAKE_OMP_SIGNAL_LOG"
  while :; do sleep 0.05; done
fi

exit "${FAKE_OMP_EXIT_STATUS:-0}"
FAKE_OMP
chmod 0755 "$fixture_root/fake-omp-template"

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
      printf '{"data":[{"id":"qwen3.6-35b-a3b-local"}]}\n'
    else
      printf '{"data":[{"id":"another-model"}]}\n'
    fi
    ;;
  *) exit 93 ;;
esac
FAKE_CURL
chmod 0755 "$fake_bin/curl"

cat >"$fake_bin/security" <<'FAKE_SECURITY'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_SECURITY_LOG"
[[ "$*" == 'find-generic-password -s copilot-cli -w' ]] || exit 94
[[ "${FAKE_COPILOT_KEYCHAIN:-1}" == 1 ]] || exit 44
printf 'host-copilot-token\n'
FAKE_SECURITY
chmod 0755 "$fake_bin/security"

cat >"$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_GH_LOG"
[[ "${1-} ${2-} ${3-}" == 'auth token --hostname' && -n "${4-}" ]] || exit 95
[[ -n "${FAKE_GH_TOKEN-}" ]] || exit 1
printf '%s\n' "$FAKE_GH_TOKEN"
FAKE_GH
chmod 0755 "$fake_bin/gh"

export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$home"
export FAKE_MISE_LOG="$fixture_root/mise.log"
export FAKE_CURL_LOG="$fixture_root/curl.log"
export FAKE_OMP_LOG="$fixture_root/omp.log"
export FAKE_OMP_TEMPLATE="$fixture_root/fake-omp-template"
export FAKE_OMP_SIGNAL_LOG="$fixture_root/signal.log"
export FAKE_SECURITY_LOG="$fixture_root/security.log"
export FAKE_GH_LOG="$fixture_root/gh.log"
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
: >"$FAKE_MISE_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_OMP_LOG"
: >"$FAKE_SECURITY_LOG"
: >"$FAKE_GH_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
command_path="$HOME/.local/bin/omp"
runtime_root="$HOME/.local/share/trellage/omp"
installed_catalog="$runtime_root/catalog.json"
profile_root="$HOME/.omp/profiles/trellage-qwen-local"
agent_root="$profile_root/agent"
copilot_profile_root="$HOME/.omp/profiles/trellage-copilot-native"
copilot_agent_root="$copilot_profile_root/agent"

[[ -L "$command_path" ]] || fail 'installer did not publish command symlink'
[[ "$(readlink "$command_path")" == "$runtime_root/bin/omp" ]] \
  || fail 'command symlink target differs'
cmp -s "$installed_catalog" "$root/catalog.json" \
  || fail 'installer did not publish the OMP catalog'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON profile list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "omp"
  and .harness == "oh-my-pi"
  and [.profiles[].name] == ["copilot", "local"]
  and all(.profiles[]; .plugin == null)
  and (.profiles[] | select(.name == "copilot") | .description) == "OMP with native GitHub Copilot authentication and model catalog, default gpt-5.6-sol medium routing, LSP, debugger, browser, eval tools, and typed subagent fan-out."
  and (.profiles[] | select(.name == "local") | .description) == "OMP with one keyless local Qwen 3.6 35B A3B route assigned to every model role, retaining OMP’s full host tool and subagent surface."
' "$fixture_root/list.json" >/dev/null || fail 'JSON profile list differs'

"$command_path" local -p 'Reply exactly OMP_SELF_HEAL_SETUP' \
  >"$fixture_root/self-heal.out" 2>&1 \
  || fail 'launch before explicit setup did not self-heal'
[[ -f "$profile_root/.managed-by-trellage-omp-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
[[ -f "$runtime_root/version" ]] \
  || fail 'self-healed launch did not pin a version'
rm -rf "$profile_root" "$runtime_root/version"

"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
[[ "$(<"$runtime_root/version")" == '17.2.6' ]] || fail 'setup did not pin resolved version'
[[ -f "$agent_root/config.yml" && ! -L "$agent_root/config.yml" ]] \
  || fail 'setup did not materialize config.yml'
[[ -f "$agent_root/models.yml" && ! -L "$agent_root/models.yml" ]] \
  || fail 'setup did not materialize models.yml'
[[ -f "$profile_root/.managed-by-trellage-omp-profiles" ]] \
  || fail 'setup did not mark profile ownership'

model='copilot-proxy-rs/qwen3.6-35b-a3b-local'
for role in default smol slow vision plan designer commit tiny task advisor; do
  grep -Fqx "  $role: $model" "$agent_root/config.yml" \
    || fail "config does not map role: $role"
done
grep -Fqx '  - copilot-proxy-rs/qwen3.6-35b-a3b-local' "$agent_root/config.yml" \
  || fail 'config does not exclusively enable local Qwen'
[[ "$(grep -Fc '  - ' "$agent_root/config.yml")" -eq 1 ]] \
  || fail 'config enabled more than one model'
grep -Fqx '  approvalMode: yolo' "$agent_root/config.yml" \
  || fail 'config does not set explicit yolo approval mode'
grep -Fqx 'setupVersion: 1' "$agent_root/config.yml" \
  || fail 'config does not mark setup complete'
grep -Fqx '  setupWizard: false' "$agent_root/config.yml" \
  || fail 'config does not disable startup setup wizard'
grep -Fqx '  copilot-proxy-rs:' "$agent_root/models.yml" \
  || fail 'models config omitted provider'
grep -Fqx '    baseUrl: http://127.0.0.1:8080/v1' "$agent_root/models.yml" \
  || fail 'models config has wrong base URL'
grep -Fqx '    api: openai-responses' "$agent_root/models.yml" \
  || fail 'models config has wrong API'
grep -Fqx '    auth: none' "$agent_root/models.yml" \
  || fail 'models config requires auth'
grep -Fqx '      type: openai-models-list' "$agent_root/models.yml" \
  || fail 'models config omitted /v1/models discovery'
! grep -Eiq 'api[_-]?key|token|secret|password' "$agent_root/config.yml" "$agent_root/models.yml" \
  || fail 'managed config contains credential-shaped data'

"$command_path" setup copilot >"$fixture_root/setup-copilot.out" \
  || fail 'Copilot setup failed'
[[ -f "$copilot_agent_root/config.yml" && ! -L "$copilot_agent_root/config.yml" ]] \
  || fail 'Copilot setup did not materialize config.yml'
[[ -f "$copilot_agent_root/models.yml" && ! -L "$copilot_agent_root/models.yml" ]] \
  || fail 'Copilot setup did not materialize models.yml'
grep -Fqx 'providers: {}' "$copilot_agent_root/models.yml" \
  || fail 'Copilot profile added a custom provider'
! grep -Fq 'enabledModels:' "$copilot_agent_root/config.yml" \
  || fail 'Copilot profile pinned discovered models'
grep -Fqx '  default: github-copilot/gpt-5.6-sol:medium' \
  "$copilot_agent_root/config.yml" \
  || fail 'Copilot profile did not default to GPT-5.6 Sol medium'
! grep -Fq 'copilot-proxy-rs' "$copilot_agent_root/config.yml" "$copilot_agent_root/models.yml" \
  || fail 'Copilot profile depends on the local proxy'

"$command_path" >"$fixture_root/bare-launch.out" 2>&1 \
  || fail 'bare launch opened the model-selection wizard'
! grep -Fq 'Choose your default model' "$fixture_root/bare-launch.out" \
  || fail 'bare launch displayed the model-selection wizard'

config_hash="$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')"
models_hash="$(shasum -a 256 "$agent_root/models.yml" | awk '{print $1}')"
"$command_path" setup >"$fixture_root/setup-again.out" || fail 'idempotent setup failed'
[[ "$config_hash" == "$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')" ]] \
  || fail 'idempotent setup changed config'
[[ "$models_hash" == "$(shasum -a 256 "$agent_root/models.yml" | awk '{print $1}')" ]] \
  || fail 'idempotent setup changed models config'

printf 'profile session canary\n' >"$profile_root/reinstall-canary"
"$installer" >"$fixture_root/reinstall.out" || fail 'idempotent reinstall failed'
grep -Fqx 'profile session canary' "$profile_root/reinstall-canary" \
  || fail 'reinstall changed profile state'
[[ "$(<"$runtime_root/version")" == '17.2.6' ]] || fail 'reinstall changed pinned version'

worktree="$fixture_root/worktree with spaces"
mkdir -p "$worktree"
worktree="$(CDPATH= cd -P -- "$worktree" && pwd -P)"
(
  cd "$worktree" || exit 1
  "$command_path" -p 'Reply exactly OMP_LOCAL_OK' -- '--literal value'
) || fail 'argument forwarding failed'
expected_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"17.2.6",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--approval-mode","yolo","-p","Reply exactly OMP_LOCAL_OK","--","--literal value"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_launch" ]] \
  || fail 'launch did not preserve profile, cwd, HOME, or exact arguments'

(
  cd "$worktree" || exit 1
  "$command_path" local -p 'Reply exactly OMP_LOCAL_EXPLICIT'
) || fail 'explicit local launch failed'
expected_local_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"17.2.6",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--approval-mode","yolo","-p","Reply exactly OMP_LOCAL_EXPLICIT"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_local_launch" ]] \
  || fail 'explicit local launch did not select the local profile'

(
  cd "$worktree" || exit 1
  "$command_path" copilot -p 'Reply exactly OMP_COPILOT_OK'
) || fail 'Copilot launch failed'
expected_copilot_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"17.2.6",profile:"trellage-copilot-native",home:$home,cwd:$cwd,args:["--approval-mode","yolo","-p","Reply exactly OMP_COPILOT_OK"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_copilot_launch" ]] \
  || fail 'Copilot launch did not select the native Copilot profile'
grep -Fqx 'find-generic-password -s copilot-cli -w' "$FAKE_SECURITY_LOG" \
  || fail 'Copilot launch did not inherit the host Copilot credential'

GH_TOKEN=host-copilot-token GITHUB_TOKEN=poison-github \
  FAKE_COPILOT_KEYCHAIN=0 "$command_path" copilot -p gh-env-auth \
  || fail 'Copilot launch did not accept GH_TOKEN'
FAKE_GH_TOKEN=host-copilot-token FAKE_COPILOT_KEYCHAIN=0 \
  "$command_path" copilot -p gh-cli-auth \
  || fail 'Copilot launch did not accept gh auth token'
grep -Fqx 'auth token --hostname github.com' "$FAKE_GH_LOG" \
  || fail 'Copilot launch did not use the container-compatible gh auth fallback'

if FAKE_OMP_EXIT_STATUS=37 "$command_path" --help >/dev/null 2>&1; then
  fail 'launcher swallowed upstream failure'
else
  status=$?
  [[ "$status" -eq 37 ]] || fail "launcher exit was $status, expected 37"
fi

if FAKE_OMP_EXIT_STATUS=38 "$command_path" -h >/dev/null 2>&1; then
  fail 'launcher intercepted upstream short help'
else
  status=$?
  [[ "$status" -eq 38 ]] || fail "short-help exit was $status, expected 38"
fi

FAKE_OMP_WAIT_FOR_SIGNAL=1 "$command_path" -p wait-for-signal &
signal_pid=$!
for _ in {1..100}; do
  grep -Fqx READY "$FAKE_OMP_SIGNAL_LOG" 2>/dev/null && break
  sleep 0.02
done
grep -Fqx READY "$FAKE_OMP_SIGNAL_LOG" 2>/dev/null || fail 'signal fixture did not become ready'
kill -TERM "$signal_pid"
if wait "$signal_pid"; then
  fail 'signaled launcher unexpectedly succeeded'
else
  status=$?
  [[ "$status" -eq 143 ]] || fail "signaled launcher exit was $status, expected 143"
fi
grep -Fqx TERM "$FAKE_OMP_SIGNAL_LOG" || fail 'launcher did not preserve TERM delivery'

state_before="$fixture_root/doctor.before"
state_after="$fixture_root/doctor.after"
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_before"
"$command_path" doctor >"$fixture_root/doctor.out" || fail 'doctor failed for healthy setup'
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_after"
cmp -s "$state_before" "$state_after" || fail 'doctor mutated managed state'
grep -Fqx 'omp doctor: OK (17.2.6, qwen3.6-35b-a3b-local)' "$fixture_root/doctor.out" \
  || fail 'doctor success output differs'

proxy_calls_before="$(wc -l <"$FAKE_CURL_LOG" | tr -d ' ')"
"$command_path" doctor copilot >"$fixture_root/doctor-copilot.out" \
  || fail 'Copilot doctor failed for authenticated profile'
grep -Fqx 'omp doctor copilot: OK (17.2.6, github-copilot)' \
  "$fixture_root/doctor-copilot.out" || fail 'Copilot doctor success output differs'
[[ "$(wc -l <"$FAKE_CURL_LOG" | tr -d ' ')" == "$proxy_calls_before" ]] \
  || fail 'Copilot doctor contacted the local proxy'

if FAKE_COPILOT_AUTH=0 "$command_path" doctor copilot \
  >"$fixture_root/doctor-copilot-auth.out" 2>&1; then
  fail 'Copilot doctor accepted missing authentication'
fi
grep -Fq 'run omp copilot auth-broker login github-copilot' \
  "$fixture_root/doctor-copilot-auth.out" \
  || fail 'Copilot doctor omitted authentication remediation'

if FAKE_COPILOT_KEYCHAIN=0 "$command_path" copilot -p auth-required \
  >"$fixture_root/launch-copilot-auth.out" 2>&1; then
  fail 'Copilot launch accepted missing host authentication'
fi

if FAKE_PROXY_HAS_MODEL=0 "$command_path" doctor >"$fixture_root/doctor-missing.out" 2>&1; then
  fail 'doctor accepted missing local model'
fi
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_after"
cmp -s "$state_before" "$state_after" || fail 'failed doctor mutated managed state'

FAKE_MISE_LATEST=17.2.7 "$command_path" update --check >"$fixture_root/check.out" \
  || fail 'update check failed'
grep -Fqx 'omp update: 17.2.6 -> 17.2.7 available' "$fixture_root/check.out" \
  || fail 'update check output differs'
[[ "$(<"$runtime_root/version")" == '17.2.6' ]] || fail 'update check changed pinned version'

if FAKE_MISE_LATEST=17.2.7 FAKE_MISE_INSTALL_FAIL_VERSION=17.2.7 \
  "$command_path" update >"$fixture_root/update-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when mise failed'
fi
[[ "$(<"$runtime_root/version")" == '17.2.6' ]] || fail 'failed update replaced pinned version'

FAKE_MISE_LATEST=17.2.7 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/version")" == '17.2.7' ]] || fail 'update did not publish new exact version'

printf 'damaged managed config\n' >"$agent_root/config.yml"
damaged_hash="$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')"
if OMP_TEST_FAIL_AT=after-config "$command_path" repair >"$fixture_root/repair-rollback.out" 2>&1; then
  fail 'injected repair publication failure unexpectedly succeeded'
fi
[[ "$damaged_hash" == "$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')" ]] \
  || fail 'failed repair did not roll back config publication'
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
grep -Fqx '  approvalMode: yolo' "$agent_root/config.yml" || fail 'repair did not restore config'
[[ "$(<"$runtime_root/version")" == '17.2.7' ]] || fail 'repair changed pinned version'

printf 'drifted managed config\n' >"$agent_root/config.yml"
"$command_path" -p 'Reply exactly OMP_SELF_HEAL' >"$fixture_root/self-heal.out" 2>&1 \
  || fail 'launch did not self-heal drifted managed config'
grep -Fq 'omp: managed config restored' "$fixture_root/self-heal.out" \
  || fail 'launch did not report managed config restoration'
grep -Fqx '  approvalMode: yolo' "$agent_root/config.yml" \
  || fail 'launch did not republish managed config'

printf 'drifted managed models\n' >"$agent_root/models.yml"
"$command_path" -p 'Reply exactly OMP_SELF_HEAL_MODELS' >"$fixture_root/self-heal-models.out" 2>&1 \
  || fail 'launch did not self-heal drifted managed models config'
grep -Fqx 'providers:' "$agent_root/models.yml" \
  || fail 'launch did not republish managed models config'

"$command_path" -p 'Reply exactly OMP_NO_REPAIR' >"$fixture_root/clean-launch.out" 2>&1 \
  || fail 'clean launch failed'
! grep -Fq 'managed config restored' "$fixture_root/clean-launch.out" \
  || fail 'clean launch republished managed config'

printf 'drifted managed config\n' >"$agent_root/config.yml"
if "$command_path" doctor >"$fixture_root/doctor-drift.out" 2>&1; then
  fail 'doctor accepted drifted managed config'
fi
grep -Fq 'managed config differs; run omp repair local' "$fixture_root/doctor-drift.out" \
  || fail 'doctor did not report managed config drift'

mv "$profile_root/.managed-by-trellage-omp-profiles" "$fixture_root/marker-away" \
  || fail 'could not stage ownership marker'
if "$command_path" -p 'Reply exactly OMP_UNOWNED' >"$fixture_root/unowned-launch.out" 2>&1; then
  fail 'launch self-healed an unmanaged profile'
fi
grep -Fq 'profile is not managed; run omp setup local' "$fixture_root/unowned-launch.out" \
  || fail 'launch did not report unmanaged profile'
grep -Fqx 'drifted managed config' "$agent_root/config.yml" \
  || fail 'launch overwrote config for an unmanaged profile'
mv "$fixture_root/marker-away" "$profile_root/.managed-by-trellage-omp-profiles" \
  || fail 'could not restore ownership marker'
"$command_path" repair >/dev/null || fail 'repair after drift checks failed'

installed_omp="$runtime_root/mise/installs/github-can1357-oh-my-pi/17.2.7/omp"
rm "$installed_omp" || fail 'could not remove pinned install for launch recovery test'
"$command_path" -p 'Reply exactly OMP_INSTALL_RECOVERY' \
  >"$fixture_root/install-recovery.out" 2>&1 \
  || fail 'launch did not recover a missing pinned install'
grep -Fq 'omp: OMP 17.2.7 is not installed; installing' \
  "$fixture_root/install-recovery.out" \
  || fail 'launch did not report missing pinned install recovery'
[[ -x "$installed_omp" ]] || fail 'launch did not reinstall the missing pinned executable'

unsafe_home="$fixture_root/unsafe-home"
mkdir -p "$unsafe_home/.omp/profiles/trellage-qwen-local/agent"
printf 'user-owned\n' >"$unsafe_home/.omp/profiles/trellage-qwen-local/agent/config.yml"
if HOME="$unsafe_home" "$installer" >/dev/null \
  && HOME="$unsafe_home" PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    FAKE_MISE_LOG="$FAKE_MISE_LOG" FAKE_OMP_TEMPLATE="$FAKE_OMP_TEMPLATE" \
    "$unsafe_home/.local/bin/omp" setup >"$fixture_root/unsafe.out" 2>&1; then
  fail 'setup replaced unrelated profile config'
fi
grep -Fqx 'user-owned' "$unsafe_home/.omp/profiles/trellage-qwen-local/agent/config.yml" \
  || fail 'setup changed unrelated profile config'

symlink_home="$fixture_root/symlink-home"
mkdir -p "$symlink_home/.omp/profiles" "$fixture_root/symlink-target"
ln -s "$fixture_root/symlink-target" "$symlink_home/.omp/profiles/trellage-qwen-local"
HOME="$symlink_home" "$installer" >/dev/null || fail 'symlink fixture install failed'
if HOME="$symlink_home" PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_MISE_LOG="$FAKE_MISE_LOG" FAKE_OMP_TEMPLATE="$FAKE_OMP_TEMPLATE" \
  "$symlink_home/.local/bin/omp" setup >"$fixture_root/symlink.out" 2>&1; then
  fail 'setup accepted symlinked profile path'
fi
[[ ! -e "$fixture_root/symlink-target/agent/config.yml" ]] \
  || fail 'setup wrote through symlinked profile path'

runtime_symlink_home="$fixture_root/runtime-symlink-home"
mkdir -p "$runtime_symlink_home/.local/share/trellage" "$fixture_root/runtime-symlink-target"
ln -s "$fixture_root/runtime-symlink-target" "$runtime_symlink_home/.local/share/trellage/omp"
if HOME="$runtime_symlink_home" "$installer" >"$fixture_root/runtime-symlink.out" 2>&1; then
  fail 'installer accepted symlinked runtime root'
fi
[[ -z "$(find "$fixture_root/runtime-symlink-target" -mindepth 1 -print -quit)" ]] \
  || fail 'installer wrote through symlinked runtime root'

printf 'session state\n' >"$profile_root/session-canary"
printf 'copilot session state\n' >"$copilot_profile_root/session-canary"
"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstall left command'
[[ ! -e "$runtime_root" && ! -L "$runtime_root" ]] || fail 'uninstall left runtime'
grep -Fqx 'session state' "$profile_root/session-canary" || fail 'uninstall removed profile state'
grep -Fqx 'copilot session state' "$copilot_profile_root/session-canary" \
  || fail 'uninstall removed Copilot profile state'

unowned_home="$fixture_root/unowned-home"
mkdir -p "$unowned_home/.local/bin"
printf 'unrelated\n' >"$unowned_home/.local/bin/omp"
if HOME="$unowned_home" "$installer" >"$fixture_root/unowned.out" 2>&1; then
  fail 'installer replaced unrelated command'
fi
grep -Fqx 'unrelated' "$unowned_home/.local/bin/omp" || fail 'installer changed unrelated command'

bash -n "$launcher" "$installer" "$uninstaller" "$0" || fail 'bash syntax check failed'
printf 'OMP native launcher contract: PASS\n'
