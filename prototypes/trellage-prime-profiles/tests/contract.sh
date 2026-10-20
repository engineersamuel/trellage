#!/usr/bin/env bash

set -u
set -o pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
repository_root="$(CDPATH= cd -- "$root/../.." && pwd)"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
real_bun="$(command -v bun)" || {
  printf 'prx contract failed: Bun 1.4.2 is required\n' >&2
  exit 1
}
launcher="$root/bin/prx"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"

trx_run_prime() {
  TRELLAGE_TRX_SOURCE_ROOT="$repository_root/prototypes/trellage-router" \
  TRELLAGE_TRX_NATIVE_SOURCE=1 \
  TRELLAGE_PRIME_LIFECYCLE_BIN="$command_path" \
    "$repository_root/prototypes/trellage-router/bin/trx" run prime default -- "$@"
}

trx_run_prime_model() {
  local model="$1"
  shift
  TRELLAGE_TRX_SOURCE_ROOT="$repository_root/prototypes/trellage-router" \
  TRELLAGE_TRX_NATIVE_SOURCE=1 \
  TRELLAGE_PRIME_LIFECYCLE_BIN="$command_path" \
    "$repository_root/prototypes/trellage-router/bin/trx" run prime default --model "$model" -- "$@"
}

fail() {
  printf 'prx contract failed: %s\n' "$1" >&2
  exit 1
}

wait_for_file() {
  local path="$1" attempts=0
  while [[ ! -e "$path" ]]; do
    attempts=$((attempts + 1))
    ((attempts < 200)) || fail "timed out waiting for $path"
    sleep 0.05
  done
}

# Portable mode bits. Do not use `stat -f … || stat -c …`: GNU stat -f is
# --file-system, fails nonzero, but still prints filesystem info to stdout and
# poisons command substitution on Linux CI.
file_mode() {
  local value
  case "$(uname -s)" in
    Darwin) value="$(stat -f '%Lp' "$1")" || return 1 ;;
    Linux) value="$(stat -c '%a' "$1")" || return 1 ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$value"
}

fixture_parent="$root/.contract-work"
mkdir -p "$fixture_parent"
fixture_root="$(mktemp -d "$fixture_parent/trellage-prx-contract.XXXXXX")" \
  || fail 'could not create fixture root'
trap 'if [[ "${PRX_TEST_KEEP_FIXTURE:-0}" != 1 ]]; then rm -rf -- "$fixture_root"; rmdir "$fixture_parent" 2>/dev/null || true; else printf "fixture kept: %s\n" "$fixture_root" >&2; fi' EXIT HUP INT TERM

export BUN_INSTALL_CACHE_DIR="${TRELLAGE_TEST_PACKAGE_CACHE:-$fixture_root/bun-cache}"

fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
mkdir -p "$fake_bin" "$home"

cat >"$fake_bin/mise" <<'FAKE_MISE'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_MISE_LOG"
tool='github:PrimeIntellect-ai/prime-agent'
install_name='github-prime-intellect-ai-prime-agent'

case "${1-}" in
  latest)
    [[ "${2-}" == "$tool" ]] || exit 90
    printf '%s\n' "${FAKE_MISE_LATEST:-0.10.0}"
    ;;
  install)
    shift
    spec="${1-}"
    version="${spec##*@}"
    [[ "$spec" == "$tool[asset_pattern=prime-agent-$version.tgz]@$version" ]] || exit 91
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    mkdir -p "$destination"
    jq -n --arg version "$version" '{name:"prime-agent",version:$version}' \
      >"$destination/package.json"
    cp "$FAKE_INSTALL_RUST" "$destination/install-rust.sh"
    chmod 0755 "$destination/install-rust.sh"
    ;;
  where)
    spec="${2-}"
    version="${spec#"$tool"@}"
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    [[ -f "$destination/package.json" ]] || exit 1
    printf '%s\n' "$destination"
    ;;
  *) exit 92 ;;
esac
FAKE_MISE
chmod 0755 "$fake_bin/mise"

# The release's own Rust installer: lays out <prefix>/bin + <prefix>/share/prime-agent
# and the kernel venv the way install-rust.sh does.
cat >"$fixture_root/fake-install-rust.sh" <<'FAKE_INSTALL_RUST'
#!/bin/sh
set -eu

printf '%s %s\n' "$PRIME_AGENT_VERSION" "$PRIME_AGENT_RUST_PREFIX" >>"$FAKE_INSTALL_LOG"
[ "${FAKE_INSTALLER_FAIL-}" != 1 ] || exit 97
[ "${PRIME_AGENT_PRESERVE_NPM_BRIDGE-}" = 1 ] || exit 90
[ "${PRIME_AGENT_DEFER_DAEMON_STOP-}" = 1 ] || exit 91
[ -n "${PRIME_AGENT_KERNEL_VENV-}" ] || exit 92

version="$PRIME_AGENT_VERSION"
payload="$PRIME_AGENT_RUST_PREFIX/share/prime-agent"
mkdir -p "$PRIME_AGENT_RUST_PREFIX/bin" "$payload/prime-agent-runtime"
jq -n --arg version "$version" '{name:"prime-agent",version:$version}' >"$payload/package.json"
printf '[project]\nname = "prime-agent-runtime"\nversion = "0.1.0"\n' \
  >"$payload/prime-agent-runtime/pyproject.toml"
printf '%s\n' "${FAKE_RUNTIME_CONTENT:-runtime-$version}" >"$payload/prime-agent-runtime/content.txt"
sed "s/@VERSION@/$version/g" "$FAKE_PRIME_TEMPLATE" >"$PRIME_AGENT_RUST_PREFIX/bin/prime-agent"
chmod 0755 "$PRIME_AGENT_RUST_PREFIX/bin/prime-agent"
# A kernel failure leaves the freshly published prefix behind, like a real partial install.
[ "${FAKE_INSTALLER_FAIL-}" != kernel ] || exit 85
mkdir -p "$PRIME_AGENT_KERNEL_VENV/bin"
printf '#!/bin/sh\nexit 0\n' >"$PRIME_AGENT_KERNEL_VENV/bin/python"
chmod 0755 "$PRIME_AGENT_KERNEL_VENV/bin/python"
FAKE_INSTALL_RUST
chmod 0755 "$fixture_root/fake-install-rust.sh"

cat >"$fixture_root/fake-prime-template" <<'FAKE_PRIME'
#!/usr/bin/env bash
set -u

if [[ "${1-}" == --version ]]; then
  # Match real prime-agent: version is written to stderr.
  printf '%s\n' '@VERSION@' >&2
  exit 0
fi

jq -cn \
  --arg codingAgentDir "${PRIME_AGENT_CODING_AGENT_DIR-}" \
  --arg kernelPython "${PRIME_AGENT_KERNEL_PYTHON-}" \
  --arg kernelVenv "${PRIME_AGENT_KERNEL_VENV-}" \
  --arg anthropic "${ANTHROPIC_API_KEY-unset}" \
  --arg openai "${OPENAI_API_KEY-unset}" \
  --arg gh "${GH_TOKEN-unset}" \
  --arg github "${GITHUB_TOKEN-unset}" \
  --arg copilot "${COPILOT_GITHUB_TOKEN-unset}" \
  '$ARGS.named + {args:$ARGS.positional}' \
  --args -- "$@" >>"$FAKE_PRIME_LOG"

exit "${FAKE_PRIME_EXIT_STATUS:-0}"
FAKE_PRIME
chmod 0755 "$fixture_root/fake-prime-template"

cat >"$fake_bin/bun" <<'FAKE_BUN'
#!/usr/bin/env bash
set -u
original=("$@")
[[ "${1-}" != --version ]] || exec "$REAL_BUN" "$@"
while [[ "${1-}" == --* ]]; do shift; done
script="${1-}"
shift || true
[[ "${1-}" != -- ]] || shift
if [[ "$script" == */native-tools.ts && "${1-}" == socket-listening ]]; then
  [[ -S "${2-}" && -f "${FAKE_DAEMON_MARKER-}" ]]
  exit
fi
if [[ "$script" == */native-tools.ts && "${1-}" == daemon-shutdown ]]; then
  [[ "${FAKE_DAEMON_STOP_FAIL-}" != 1 ]] || exit 2
  rm -f -- "${2-}"
  [[ -z "${FAKE_DAEMON_MARKER-}" ]] || rm -f -- "$FAKE_DAEMON_MARKER"
  [[ -z "${FAKE_DAEMON_STOP_LOG-}" ]] || printf 'stopped\n' >>"$FAKE_DAEMON_STOP_LOG"
  exit 0
fi
exec "$REAL_BUN" "${original[@]}"
FAKE_BUN
chmod 0755 "$fake_bin/bun"

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
      printf '{"data":[{"id":"claude-opus-5.5"},{"id":"vendor/custom"}]}\n'
    else
      printf '{"data":[{"id":"another-model"}]}\n'
    fi
    ;;
  *) exit 93 ;;
esac
FAKE_CURL
chmod 0755 "$fake_bin/curl"

cat >"$fake_bin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -u

if [[ "${PRX_TEST_FAST_SLEEP-}" == 1 ]]; then
  exec /bin/sleep 0.001
fi
exec /bin/sleep "$@"
FAKE_SLEEP
chmod 0755 "$fake_bin/sleep"

# Real jq from the host.
if ! command -v jq >/dev/null 2>&1; then
  fail 'host jq is required for the contract'
fi
ln -s "$(command -v jq)" "$fake_bin/jq"
seed_floating_skills_cache "$home"
seed_native_skills_fixture "$home"
ln -s "$(command -v ps)" "$fake_bin/ps"

export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$home"
export REAL_BUN="$real_bun"
export FAKE_MISE_LOG="$fixture_root/mise.log"
export FAKE_INSTALL_LOG="$fixture_root/install.log"
export FAKE_INSTALL_RUST="$fixture_root/fake-install-rust.sh"
export FAKE_CURL_LOG="$fixture_root/curl.log"
export FAKE_PRIME_LOG="$fixture_root/prime.log"
export FAKE_PRIME_TEMPLATE="$fixture_root/fake-prime-template"
export FAKE_FIXTURE_ROOT="$fixture_root"
export FAKE_DAEMON_STOP_LOG="$fixture_root/daemon-stop.log"
export FAKE_DAEMON_MARKER="$fixture_root/daemon-running"
export PRX_TEST_DAEMON_MARKER="$FAKE_DAEMON_MARKER"
: >"$FAKE_MISE_LOG"
: >"$FAKE_INSTALL_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_PRIME_LOG"
: >"$FAKE_DAEMON_STOP_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
runtime_root="$HOME/.local/share/trellage/prx"
command_path="$runtime_root/bin/prx"
profile_root="$HOME/.local/share/trellage/profiles/prime/default"
profile_home="$profile_root/home"

[[ -x "$command_path" && ! -L "$command_path" ]] \
  || fail 'installer did not publish the owned runtime command'
cmp -s "$runtime_root/catalog.json" "$root/catalog.json" \
  || fail 'installer did not publish catalog'
[[ -f "$runtime_root/.managed-by-trellage-prime-profiles" ]] \
  || fail 'installer did not write ownership marker'
[[ "$(<"$runtime_root/.managed-by-trellage-prime-profiles")" == trellage-prime-profiles-v1 ]] \
  || fail 'ownership marker value differs'

status=0
"$command_path" update --check >"$fixture_root/not-setup-update.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'update check accepted an unconfigured runtime'
grep -Fq 'prime-agent installed version receipt is missing; run prx setup' \
  "$fixture_root/not-setup-update.out" \
  || fail 'unconfigured update check diagnostic differs'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "prx"
  and .harness == "prime"
  and [.profiles[].name] == ["default"]
  and .profiles[0].source == "PrimeIntellect-ai/prime-agent"
  and .profiles[0].plugin == null
  and .profiles[0].standaloneMcps == []
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
jq '.profiles.default.headless.outputFormats = ["yaml"]' "$runtime_root/catalog.json" \
  >"$fixture_root/catalog.invalid" || fail 'could not create invalid catalog'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json >"$fixture_root/invalid-list.out" 2>"$fixture_root/invalid-list.err"; then
  fail 'list accepted invalid headless catalog'
fi
grep -Fq 'prx: invalid catalog:' "$fixture_root/invalid-list.err" \
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
grep -Fq 'prx: invalid catalog:' "$fixture_root/invalid-trellage-event-list.err" \
  || fail 'unsupported Trellage event contract diagnostic differs'
mv "$fixture_root/catalog.saved" "$runtime_root/catalog.json"

"$command_path" list >"$fixture_root/list.txt" || fail 'text list failed'
grep -Fq $'default\tPrime Agent for persistent exploratory analysis and multi-turn work through daemon-backed IPython/RLM subagents and managed clarification.' \
  "$fixture_root/list.txt" || fail 'text list differs'

trx_run_prime -p 'self-heal-before-setup-probe' \
  >"$fixture_root/self-heal.out" 2>"$fixture_root/self-heal.err" \
  || fail 'launch before explicit setup did not self-heal'
[[ -f "$runtime_root/installed-version" ]] \
  || fail 'self-healed launch did not record an installed version'
[[ -f "$profile_root/.managed-by-trellage-prime-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
rm -rf "$profile_root" "$runtime_root/installed-version"

"$command_path" setup >"$fixture_root/setup.out" 2>"$fixture_root/setup.err" \
  || fail 'setup failed'
[[ "$(<"$runtime_root/installed-version")" == 0.10.0 ]] \
  || fail 'setup did not record installed version'
[[ ! -e "$runtime_root/version" ]] || fail 'setup retained legacy version state'
jq -e '
  .schemaVersion == 1
  and .primeVersion == "0.10.0"
  and .runtimeHashAlgorithm == "sha256"
  and (.runtimeHash | test("^[0-9a-f]{64}$"))
  and .kernelSpecVersion == 1
' "$runtime_root/runtime-identity.json" >/dev/null \
  || fail 'setup runtime identity differs'
cmp -s "$runtime_root/runtime-identity.json" \
  "$profile_home/kernel-runtime-identity.json" \
  || fail 'setup kernel identity does not match runtime identity'
[[ -f "$profile_root/.managed-by-trellage-prime-profiles" ]] \
  || fail 'setup did not mark profile ownership'
[[ "$(<"$profile_root/.managed-by-trellage-prime-profiles")" == trellage-prime-profile-v1 ]] \
  || fail 'profile ownership marker value differs'
[[ -d "$profile_home" && ! -L "$profile_home" ]] || fail 'profile home is unsafe'
[[ -f "$profile_home/models.json" && ! -L "$profile_home/models.json" ]] \
  || fail 'setup did not materialize models.json'
[[ -f "$runtime_root/assets/extensions/ask-user.ts" && ! -L "$runtime_root/assets/extensions/ask-user.ts" ]] \
  || fail 'installer did not publish managed ask-user extension asset'
cmp -s "$runtime_root/assets/extensions/ask-user.ts" "$root/assets/extensions/ask-user.ts" \
  || fail 'installer published a divergent ask-user extension asset'
[[ -f "$profile_home/extensions/ask-user.ts" && ! -L "$profile_home/extensions/ask-user.ts" ]] \
  || fail 'setup did not materialize ask-user extension'
cmp -s "$profile_home/extensions/ask-user.ts" "$root/assets/extensions/ask-user.ts" \
  || fail 'setup ask-user extension differs from managed asset'
[[ -f "$profile_home/.trellage-managed-extensions" && ! -L "$profile_home/.trellage-managed-extensions" ]] \
  || fail 'setup did not write managed extension manifest'
grep -Fqx 'ask-user' "$profile_home/.trellage-managed-extensions" \
  || fail 'managed extension manifest does not list ask-user'
[[ -x "$profile_home/kernel-venv/bin/python" ]] \
  || fail 'setup did not bootstrap kernel-venv'
grep -Fq "0.10.0 $runtime_root/rust-prefix" "$FAKE_INSTALL_LOG" \
  || fail 'setup did not run the release installer into the owned prefix'
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080"
  and .providers["copilot-proxy-rs"].api == "anthropic-messages"
  and .providers["copilot-proxy-rs"].apiKey == "trellage-local-proxy"
  and .providers["copilot-proxy-rs"].compat.supportsEagerToolInputStreaming == false
  and [.providers["copilot-proxy-rs"].models[].id] == ["claude-opus-5.5"]
' "$profile_home/models.json" >/dev/null || fail 'models.json seed differs'
[[ "$(file_mode "$profile_home/models.json")" == 600 ]] \
  || fail 'models.json mode is not 0600'
grep -Fq 'prx setup: ready (0.10.0, claude-opus-5.5)' "$fixture_root/setup.out" \
  || fail 'setup output differs'
[[ -x "$runtime_root/rust-prefix/bin/prime-agent" ]] \
  || fail 'setup did not install prime-agent launcher'
grep -Fq 'install github:PrimeIntellect-ai/prime-agent[asset_pattern=prime-agent-0.10.0.tgz]@0.10.0' "$FAKE_MISE_LOG" \
  || fail 'setup did not ask mise to install the receipt-selected release'

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
grep -Fq 'prx doctor: OK (0.10.0, claude-opus-5.5)' "$fixture_root/doctor.out" \
  || fail 'doctor output differs'

# Seed poison credentials; launch must unset them.
export ANTHROPIC_API_KEY=poison-anthropic
export OPENAI_API_KEY=poison-openai
export GH_TOKEN=poison-gh
export GITHUB_TOKEN=poison-github
export COPILOT_GITHUB_TOKEN=poison-copilot
: >"$FAKE_PRIME_LOG"
latest_calls_before="$(grep -c '^latest ' "$FAKE_MISE_LOG" || :)"
trx_run_prime -p 'two words' '' '--literal=*' \
  || fail 'explicit launch failed'
[[ "$(grep -c '^latest ' "$FAKE_MISE_LOG" || :)" == "$latest_calls_before" ]] \
  || fail 'ordinary launch resolved latest instead of reusing the receipt'
jq -e --arg kernelPython "$profile_home/kernel-venv/bin/python" \
  --arg kernelVenv "$profile_home/kernel-venv" \
  --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  (.codingAgentDir | contains("/native-run/compositions/prime-") and contains("/generations/"))
  and .kernelPython == $kernelPython
  and .kernelVenv == $kernelVenv
  and .anthropic == "unset"
  and .openai == "unset"
  and .gh == "unset"
  and .github == "unset"
  and .copilot == "unset"
  and .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5.5",
    "--offline",
    "--autonomous",
    "--daemon-socket", $daemonSocket,
    "-p", "two words", "", "--literal=*"
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'launch environment or arguments differ'
[[ -f "$profile_root/daemon/kernel-env.stamp" && ! -L "$profile_root/daemon/kernel-env.stamp" ]] \
  || fail 'launch did not write daemon kernel env stamp'
jq -e --arg python "$profile_home/kernel-venv/bin/python" \
  --arg venv "$profile_home/kernel-venv" '
  .schemaVersion == 1
  and .runtimeIdentity.primeVersion == "0.10.0"
  and .runtimeIdentity.kernelSpecVersion == 1
  and .kernelPython == $python
  and .kernelVenv == $venv
' "$profile_root/daemon/kernel-env.stamp" >/dev/null \
  || fail 'daemon identity stamp differs'
[[ -d "$profile_root/daemon" && ! -L "$profile_root/daemon" ]] \
  || fail 'launch did not create profile daemon directory'
unset ANTHROPIC_API_KEY OPENAI_API_KEY GH_TOKEN GITHUB_TOKEN COPILOT_GITHUB_TOKEN

: >"$FAKE_DAEMON_MARKER"
kernel_rebuild_stops_before="$(wc -l <"$FAKE_DAEMON_STOP_LOG" | tr -d ' ')"
kernel_rebuild_installs_before="$(wc -l <"$FAKE_INSTALL_LOG" | tr -d ' ')"
rm -f "$profile_home/kernel-venv/bin/python"
trx_run_prime -p kernel-rebuild-probe >/dev/null \
  || fail 'launch did not repair a stale kernel'
[[ "$(wc -l <"$FAKE_DAEMON_STOP_LOG" | tr -d ' ')" -gt "$kernel_rebuild_stops_before" ]] \
  || fail 'stale kernel repair did not stop the old profile daemon'
[[ "$(wc -l <"$FAKE_INSTALL_LOG" | tr -d ' ')" -gt "$kernel_rebuild_installs_before" ]] \
  || fail 'stale kernel repair did not rerun the release installer'
[[ ! -e "$FAKE_DAEMON_MARKER" ]] \
  || fail 'stale kernel repair left the old profile daemon running'
jq -e '.runtimeIdentity.primeVersion == "0.10.0"' \
  "$profile_root/daemon/kernel-env.stamp" >/dev/null \
  || fail 'stale kernel repair did not republish the daemon identity stamp'

# Explicit single-turn launches omit only the managed autonomous flag.
: >"$FAKE_PRIME_LOG"
trx_run_prime --single-turn -p 'one turn' \
  || fail 'single-turn launch failed'
jq -e --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5.5",
    "--offline",
    "--daemon-socket", $daemonSocket,
    "-p", "one turn"
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'single-turn launch arguments differ'
if trx_run_prime --single-turn --single-turn -p duplicate \
  >"$fixture_root/single-turn-duplicate.out" 2>"$fixture_root/single-turn-duplicate.err"; then
  fail 'duplicate single-turn option unexpectedly succeeded'
fi
grep -Fqx 'trx run: --single-turn may be specified only once' \
  "$fixture_root/single-turn-duplicate.err" \
  || fail 'duplicate single-turn diagnostic differs'

# Bare launch is equivalent to default.
: >"$FAKE_PRIME_LOG"
trx_run_prime -p 'bare' || fail 'bare launch failed'
jq -e --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5.5",
    "--offline",
    "--autonomous",
    "--daemon-socket", $daemonSocket,
    "-p", "bare"
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'bare launch arguments differ'

# An argument-free launch must work under macOS Bash 3.2 with `set -u`.
: >"$FAKE_PRIME_LOG"
trx_run_prime || fail 'argument-free launch failed'
jq -e --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5.5",
    "--offline",
    "--autonomous",
    "--daemon-socket", $daemonSocket
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'argument-free launch arguments differ'

# shutdown is a managed command (no live socket in the fixture).
"$command_path" shutdown >"$fixture_root/shutdown.out" || fail 'shutdown failed'
grep -Fq 'prx shutdown: no profile daemon socket' "$fixture_root/shutdown.out" \
  || fail 'shutdown output differs'
[[ ! -e "$profile_root/daemon/kernel-env.stamp" ]] \
  || fail 'shutdown did not clear daemon kernel env stamp'

: >"$FAKE_PRIME_LOG"
trx_run_prime_model vendor/custom -p custom-model || fail 'custom model launch failed'
custom_model_home="$(jq -r '.codingAgentDir' "$FAKE_PRIME_LOG")"
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080"
  and [.providers["copilot-proxy-rs"].models[].id] == ["vendor/custom"]
' "$custom_model_home/models.json" >/dev/null \
  || fail 'custom model was not materialized in native Prime configuration'
python3 - "$FAKE_PRIME_LOG" "$profile_root/daemon/daemon.sock" <<'PY' || fail 'custom Prime model arguments differ'
import json
import pathlib
import sys

actual = json.loads(pathlib.Path(sys.argv[1]).read_text())["args"]
expected = [
    "--provider", "copilot-proxy-rs",
    "--model", "vendor/custom",
    "--offline",
    "--autonomous",
    "--daemon-socket", sys.argv[2],
    "-p", "custom-model"
]
raise SystemExit(0 if actual == expected else 1)
PY
"$command_path" doctor >/dev/null || fail 'doctor rejected managed custom model state'

# Launch restores drifted models.json and managed ask-user extension.
printf '{"providers":{}}\n' >"$profile_home/models.json"
printf 'stale-extension\n' >"$profile_home/extensions/ask-user.ts"
: >"$FAKE_PRIME_LOG"
trx_run_prime -p restore-probe || fail 'launch after drift failed'
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080"
  and [.providers["copilot-proxy-rs"].models[].id] == ["claude-opus-5.5"]
' "$profile_home/models.json" >/dev/null \
  || fail 'launch did not restore managed models.json'
cmp -s "$profile_home/extensions/ask-user.ts" "$root/assets/extensions/ask-user.ts" \
  || fail 'launch did not restore managed ask-user extension'

printf 'drift\n' >>"$profile_home/models.json"
status=0
"$command_path" doctor >"$fixture_root/drift.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted modified managed models config'
grep -Fq 'managed models config differs; run prx repair' "$fixture_root/drift.out" \
  || fail 'managed models config drift error differs'
"$command_path" repair >"$fixture_root/repair-config.out" \
  || fail 'repair did not restore managed models config'
jq -e '
  .providers["copilot-proxy-rs"].api == "anthropic-messages"
' "$profile_home/models.json" >/dev/null || fail 'repair did not rewrite models.json'

printf 'runtime-drift\n' \
  >>"$runtime_root/rust-prefix/share/prime-agent/prime-agent-runtime/content.txt"
status=0
"$command_path" doctor >"$fixture_root/runtime-drift.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted bundled runtime content drift'
grep -Fq 'Prime runtime content differs from its identity; run prx repair' \
  "$fixture_root/runtime-drift.out" || fail 'runtime drift diagnostic differs'
"$command_path" repair >/dev/null || fail 'repair did not restore runtime content identity'

printf '{malformed\n' >"$profile_home/kernel-runtime-identity.json"
status=0
"$command_path" doctor >"$fixture_root/kernel-stamp-malformed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted malformed kernel identity stamp'
grep -Fq 'Prime kernel identity differs; run prx repair' \
  "$fixture_root/kernel-stamp-malformed.out" \
  || fail 'malformed kernel identity diagnostic differs'
"$command_path" repair >/dev/null || fail 'repair did not restore malformed kernel stamp'

cp "$profile_home/kernel-runtime-identity.json" \
  "$fixture_root/outside-kernel-identity.json"
rm -f "$profile_home/kernel-runtime-identity.json"
ln -s "$fixture_root/outside-kernel-identity.json" \
  "$profile_home/kernel-runtime-identity.json"
status=0
"$command_path" repair >"$fixture_root/kernel-stamp-symlink.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'repair accepted symlinked kernel identity stamp'
jq -e '.primeVersion == "0.10.0"' \
  "$fixture_root/outside-kernel-identity.json" >/dev/null \
  || fail 'symlinked kernel identity target was modified'
rm -f "$profile_home/kernel-runtime-identity.json"
"$command_path" repair >/dev/null || fail 'repair after kernel identity symlink failed'

cp "$runtime_root/runtime-identity.json" "$fixture_root/outside-runtime-identity.json"
rm -f "$runtime_root/runtime-identity.json"
ln -s "$fixture_root/outside-runtime-identity.json" "$runtime_root/runtime-identity.json"
status=0
"$command_path" repair >"$fixture_root/runtime-stamp-symlink.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'repair accepted symlinked runtime identity'
cmp -s "$fixture_root/outside-runtime-identity.json" \
  "$profile_home/kernel-runtime-identity.json" \
  || fail 'symlinked runtime identity target was modified'
rm -f "$runtime_root/runtime-identity.json"
"$command_path" repair >/dev/null || fail 'repair after runtime identity symlink failed'

trx_run_prime -p daemon-stamp-seed >/dev/null || fail 'could not seed daemon identity stamp'
printf '{malformed\n' >"$profile_root/daemon/kernel-env.stamp"
status=0
"$command_path" doctor >"$fixture_root/daemon-stamp-malformed.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted malformed daemon identity stamp'
grep -Fq 'Prime daemon identity stamp differs; run prx shutdown' \
  "$fixture_root/daemon-stamp-malformed.out" \
  || fail 'malformed daemon identity diagnostic differs'
trx_run_prime -p daemon-stamp-repair >/dev/null \
  || fail 'launch did not repair malformed daemon identity stamp'
jq -e '.runtimeIdentity.primeVersion == "0.10.0"' \
  "$profile_root/daemon/kernel-env.stamp" >/dev/null \
  || fail 'launch did not republish daemon identity stamp'

: >"$FAKE_DAEMON_MARKER"
rm -f "$profile_root/daemon/kernel-env.stamp"
status=0
"$command_path" doctor >"$fixture_root/daemon-stamp-missing.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'doctor accepted a running daemon without an identity stamp'
grep -Fq 'Prime daemon identity stamp differs; run prx shutdown' \
  "$fixture_root/daemon-stamp-missing.out" \
  || fail 'missing daemon identity stamp diagnostic differs'
trx_run_prime -p daemon-stamp-missing-repair >/dev/null \
  || fail 'launch did not repair a missing daemon identity stamp'
[[ ! -e "$FAKE_DAEMON_MARKER" ]] \
  || fail 'missing daemon identity repair left the old daemon running'

: >"$FAKE_DAEMON_MARKER"
status=0
FAKE_DAEMON_STOP_FAIL=1 "$command_path" shutdown \
  >"$fixture_root/shutdown-refused.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'shutdown accepted a daemon that remained running'
grep -Fq 'profile daemon did not stop; identity stamp was preserved' \
  "$fixture_root/shutdown-refused.out" \
  || fail 'refused daemon shutdown diagnostic differs'
[[ -e "$FAKE_DAEMON_MARKER" && -f "$profile_root/daemon/kernel-env.stamp" ]] \
  || fail 'refused daemon shutdown removed live daemon state'
"$command_path" shutdown >/dev/null || fail 'shutdown after refusal failed'

status=0
FAKE_PRIME_EXIT_STATUS=37 trx_run_prime -p probe || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status"

FAKE_PROXY_HAS_MODEL=0 "$command_path" doctor >"$fixture_root/model.out" 2>&1 \
  && fail 'doctor accepted missing model'
grep -Fq 'copilot-proxy-rs model is missing: claude-opus-5.5' "$fixture_root/model.out" \
  || fail 'missing model error differs'

FAKE_MISE_LATEST=0.11.0 "$command_path" update --check \
  >"$fixture_root/update-check.out" || fail 'update check failed'
grep -Fq '0.10.0 -> 0.11.0 available' "$fixture_root/update-check.out" \
  || fail 'update check output differs'
if FAKE_MISE_LATEST=0.11.0 FAKE_INSTALLER_FAIL=1 \
  "$command_path" update >"$fixture_root/update-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when the installer failed'
fi
[[ "$(<"$runtime_root/installed-version")" == 0.10.0 ]] \
  || fail 'failed update replaced installed version receipt'
old_runtime_version="$("$runtime_root/rust-prefix/bin/prime-agent" --version 2>&1)"
[[ "$old_runtime_version" == 0.10.0 ]] \
  || fail 'failed update replaced the last good Prime runtime'
cp "$runtime_root/runtime-identity.json" "$fixture_root/pre-update-runtime-identity.json"
cp "$profile_home/kernel-runtime-identity.json" \
  "$fixture_root/pre-update-kernel-identity.json"
cp "$profile_root/daemon/kernel-env.stamp" \
  "$fixture_root/pre-update-daemon-stamp.json"
printf 'old-kernel\n' >"$profile_home/kernel-venv/rollback-marker"
if FAKE_MISE_LATEST=0.11.0 FAKE_INSTALLER_FAIL=kernel \
  "$command_path" update >"$fixture_root/update-kernel-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when kernel installation failed'
fi
[[ "$(<"$runtime_root/installed-version")" == 0.10.0 \
  && "$(<"$profile_home/kernel-venv/rollback-marker")" == old-kernel ]] \
  || fail 'kernel installation failure did not restore old runtime state'
cmp -s "$profile_root/daemon/kernel-env.stamp" \
  "$fixture_root/pre-update-daemon-stamp.json" \
  || fail 'kernel installation failure did not restore daemon stamp'
for fail_point in after-daemon-stop after-state-backup after-kernel-build \
  before-receipt-publication after-rust-publication after-state-publication; do
  if [[ "$fail_point" == after-daemon-stop ]]; then
    : >"$FAKE_DAEMON_MARKER"
  fi
  if FAKE_MISE_LATEST=0.11.0 PRX_TEST_FAIL_AT="$fail_point" \
    "$command_path" update >"$fixture_root/update-$fail_point.out" 2>&1; then
    fail "update unexpectedly succeeded at rollback boundary $fail_point"
  fi
  [[ "$(<"$runtime_root/installed-version")" == 0.10.0 ]] \
    || fail "rollback boundary $fail_point replaced installed version receipt"
  old_runtime_version="$("$runtime_root/rust-prefix/bin/prime-agent" --version 2>&1)"
  [[ "$old_runtime_version" == 0.10.0 ]] \
    || fail "rollback boundary $fail_point replaced the last good runtime"
  cmp -s "$runtime_root/runtime-identity.json" \
    "$fixture_root/pre-update-runtime-identity.json" \
    || fail "rollback boundary $fail_point changed runtime identity"
  cmp -s "$profile_home/kernel-runtime-identity.json" \
    "$fixture_root/pre-update-kernel-identity.json" \
    || fail "rollback boundary $fail_point changed kernel identity"
  cmp -s "$profile_root/daemon/kernel-env.stamp" \
    "$fixture_root/pre-update-daemon-stamp.json" \
    || fail "rollback boundary $fail_point changed daemon identity stamp"
  [[ "$(<"$profile_home/kernel-venv/rollback-marker")" == old-kernel ]] \
    || fail "rollback boundary $fail_point did not restore old kernel venv"
  [[ ! -e "$FAKE_DAEMON_MARKER" ]] \
    || fail "rollback boundary $fail_point left a mismatched daemon running"
done
[[ -z "$(find "$runtime_root" "$profile_home" -maxdepth 1 \
  \( -name '*-backup.*' -o -name '.rust-install.*' \
  -o -name '.installed-version.*' -o -name '.runtime-identity.*' \) -print -quit)" ]] \
  || fail 'failed update left staged or backup runtime state'

mkdir -p "$profile_root/daemon"
rm -f "$profile_root/daemon/daemon.sock"
: >"$FAKE_DAEMON_MARKER"
update_installs_before="$(wc -l <"$FAKE_INSTALL_LOG" | tr -d ' ')"
FAKE_MISE_LATEST=0.11.0 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/installed-version")" == 0.11.0 ]] \
  || fail 'update did not change installed version receipt'
[[ "$(wc -l <"$FAKE_INSTALL_LOG" | tr -d ' ')" -gt "$update_installs_before" ]] \
  || fail 'update did not run the release installer'
[[ "$(wc -l <"$FAKE_DAEMON_STOP_LOG" | tr -d ' ')" -ge 1 ]] \
  || fail 'update did not stop the old profile daemon'
[[ ! -e "$FAKE_DAEMON_MARKER" && ! -e "$profile_root/daemon/daemon.sock" ]] \
  || fail 'update left the old profile daemon running'
[[ ! -e "$profile_root/daemon/kernel-env.stamp" ]] \
  || fail 'update published a daemon stamp before lazy restart'
jq -e '.primeVersion == "0.11.0"' "$runtime_root/runtime-identity.json" >/dev/null \
  || fail 'update did not publish the new runtime identity'
cmp -s "$runtime_root/runtime-identity.json" \
  "$profile_home/kernel-runtime-identity.json" \
  || fail 'update published mismatched runtime and kernel identities'

noop_install_calls_before="$(wc -l <"$FAKE_INSTALL_LOG" | tr -d ' ')"
FAKE_MISE_LATEST=0.11.0 "$command_path" update >"$fixture_root/update-noop.out" \
  || fail 'current update no-op failed'
grep -Fq 'prx update: 0.11.0 is current' "$fixture_root/update-noop.out" \
  || fail 'current update no-op output differs'
[[ "$(wc -l <"$FAKE_INSTALL_LOG" | tr -d ' ')" == "$noop_install_calls_before" ]] \
  || fail 'current update no-op reran the release installer'

lock_marker="$fixture_root/mutation-lock-held"
PRX_TEST_LOCK_HELD_MARKER="$lock_marker" "$command_path" doctor \
  >"$fixture_root/lock-owner.out" 2>"$fixture_root/lock-owner.err" &
lock_owner_pid=$!
wait_for_file "$lock_marker"
busy_inventory="$("$command_path" inventory default --json)" \
  || fail 'inventory failed while the profile mutation lock was held'
jq -e '.readiness == "busy"' <<<"$busy_inventory" >/dev/null \
  || fail 'inventory did not report a held profile mutation lock as busy'
PRX_TEST_FAST_SLEEP=1 "$command_path" doctor >"$fixture_root/lock-waiter.out" \
  2>"$fixture_root/lock-waiter.err" &
lock_waiter_pid=$!
sleep 0.2
kill -0 "$lock_waiter_pid" 2>/dev/null \
  || fail 'profile mutation lock did not serialize a concurrent doctor'
: >"$lock_marker.continue"
wait "$lock_owner_pid" || { cat "$fixture_root/lock-owner.err" >&2; fail 'profile mutation lock owner failed'; }
wait "$lock_waiter_pid" || { cat "$fixture_root/lock-waiter.err" >&2; fail 'profile mutation lock waiter failed'; }

stale_owner="$profile_root/.mutation.lock-owned.stale"
mkdir "$stale_owner"
printf '.mutation.lock-owned.stale\n' >"$stale_owner/token"
printf '999999999\n' >"$stale_owner/pid"
ln "$stale_owner/token" "$profile_root/.mutation.lock"
stale_recovery_retry="$fixture_root/stale-recovery-retry"
PRX_TEST_STALE_RECOVERY_FAIL_ONCE="$stale_recovery_retry" \
  "$command_path" doctor >"$fixture_root/stale-lock.out" \
  || fail 'doctor did not recover stale profile mutation lock'
[[ -f "$stale_recovery_retry" ]] \
  || fail 'stale profile mutation lock recovery did not exercise its retry path'
[[ ! -e "$profile_root/.mutation.lock" && ! -e "$stale_owner" ]] \
  || fail 'stale profile mutation lock was not removed'

"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
grep -Fq 'prx repair: restored (0.11.0, claude-opus-5.5)' "$fixture_root/repair.out" \
  || fail 'repair output differs after update'

mkdir -p "$fixture_root/unrelated-home/.local/share/trellage/profiles/prime/default"
printf 'unrelated\n' \
  >"$fixture_root/unrelated-home/.local/share/trellage/profiles/prime/default/data"
status=0
HOME="$fixture_root/unrelated-home" "$runtime_root/bin/prx" setup \
  >"$fixture_root/unrelated.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'setup accepted unrelated profile files'
grep -Fq 'refusing unrelated existing profile files' "$fixture_root/unrelated.out" \
  || fail 'unrelated profile error differs'

# Symlinked models.json must be refused by repair/publish.
rm -f "$profile_home/models.json"
printf 'outside\n' >"$fixture_root/outside-models.json"
ln -s "$fixture_root/outside-models.json" "$profile_home/models.json"
status=0
"$command_path" repair >"$fixture_root/symlink.out" 2>&1 || status=$?
[[ "$status" == 1 ]] || fail 'repair accepted symlinked models.json'
[[ "$(cat "$fixture_root/outside-models.json")" == outside ]] \
  || fail 'symlink target was modified'
rm -f "$profile_home/models.json"
"$command_path" repair >"$fixture_root/repair-after-symlink.out" \
  || fail 'repair after removing symlink failed'

# A daemon started by a different runtime_root (another worktree, or the
# canonical installed copy) still listens on the shared $HOME-based socket; any
# prx copy stops it through the daemon protocol client, not a per-copy module.
other_runtime="$HOME/.local/share/trellage/other-worktree-prx"
cp -R "$runtime_root" "$other_runtime"
: >"$FAKE_DAEMON_MARKER"
shared_stops_before="$(wc -l <"$FAKE_DAEMON_STOP_LOG" | tr -d ' ')"
"$other_runtime/bin/prx" repair >"$fixture_root/shared-daemon.out" 2>&1 \
  || fail 'repair from a second runtime copy failed'
[[ "$(wc -l <"$FAKE_DAEMON_STOP_LOG" | tr -d ' ')" -gt "$shared_stops_before" ]] \
  || fail 'second runtime copy did not stop the shared profile daemon'
[[ ! -e "$FAKE_DAEMON_MARKER" ]] \
  || fail 'second runtime copy left the shared profile daemon marker in place'
rm -rf "$other_runtime"

"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
[[ ! -e "$runtime_root" ]] || fail 'uninstaller left runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstaller left command'
[[ -d "$profile_home" ]] || fail 'uninstaller removed profile state'
[[ -f "$profile_home/models.json" ]] || fail 'uninstaller removed models.json'
grep -Fq 'Prime profile state and sessions were preserved' "$fixture_root/uninstall.out" \
  || fail 'uninstall message differs'

printf 'prx contract: PASS\n'
