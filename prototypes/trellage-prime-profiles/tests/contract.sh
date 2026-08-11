#!/usr/bin/env bash

set -u
set -o pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
launcher="$root/bin/prx"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"

fail() {
  printf 'prx contract failed: %s\n' "$1" >&2
  exit 1
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

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-prx-contract.XXXXXX")" \
  || fail 'could not create fixture root'
trap 'rm -rf -- "$fixture_root"' EXIT HUP INT TERM

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
    printf '%s\n' "${FAKE_MISE_LATEST:-0.7.0}"
    ;;
  install)
    spec="${2-}"
    version="${spec#"$tool"@}"
    [[ "$spec" == "$tool@$version" && "$version" != "$spec" ]] || exit 91
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    mkdir -p "$destination"
    jq -n --arg version "$version" '{name:"prime-agent",version:$version}' \
      >"$destination/package.json"
    # Marker file so tests can assert mise install ran.
    printf 'extracted\n' >"$destination/.mise-extracted"
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

cat >"$fake_bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_NPM_LOG"

if [[ "${1-}" == pack ]]; then
  pack_dest=''
  shift
  while (($# > 0)); do
    case "$1" in
      --pack-destination)
        shift
        pack_dest="${1-}"
        ;;
      --pack-destination=*)
        pack_dest="${1#--pack-destination=}"
        ;;
      --loglevel=error|--ignore-scripts) ;;
      *) ;;
    esac
    shift || true
  done
  [[ -n "$pack_dest" && -d "$pack_dest" ]] || exit 88
  [[ -f ./package.json ]] || exit 89
  version="$(jq -r .version ./package.json)" || exit 90
  # Minimal tarball npm install can consume in the fake installer below.
  tar -czf "$pack_dest/prime-agent-$version.tgz" package.json
  exit 0
fi

prefix=''
package=''
while (($# > 0)); do
  case "$1" in
    --prefix)
      shift
      prefix="${1-}"
      ;;
    --prefix=*)
      prefix="${1#--prefix=}"
      ;;
    --global|--no-fund|--no-audit|--progress=false|--loglevel=error) ;;
    -*)
      ;;
    *)
      package="$1"
      ;;
  esac
  shift || true
done

[[ -n "$prefix" && -n "$package" ]] || exit 94
if [[ -f "$package" && "$package" == *.tgz ]]; then
  extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/fake-npm-extract.XXXXXX")" || exit 98
  tar -xzf "$package" -C "$extract_dir" || exit 99
  if [[ -f "$extract_dir/package.json" ]]; then
    version="$(jq -r .version "$extract_dir/package.json")" || exit 96
  else
    version="$(jq -r .version "$extract_dir/package/package.json")" || exit 96
  fi
  rm -rf -- "$extract_dir"
elif [[ -f "$package/package.json" ]]; then
  # Real npm would symlink a directory path; refuse so the launcher must pack.
  exit 95
else
  exit 95
fi

package_root="$prefix/lib/node_modules/prime-agent"
rm -rf -- "$package_root"
cli_dir="$package_root/dist/bundle"
runtime_dir="$package_root/dist/prime-agent-runtime"
mkdir -p "$cli_dir" "$runtime_dir" "$package_root/node_modules/zeromq"
jq -n --arg version "$version" '{name:"prime-agent",version:$version}' \
  >"$package_root/package.json"
printf 'fake\n' >"$package_root/node_modules/zeromq/package.json"
# Bundled kernel runtime source (real package ships this under dist/).
printf '[project]\nname = "prime-agent-runtime"\nversion = "0.1.0"\n' \
  >"$runtime_dir/pyproject.toml"
sed "s/@VERSION@/$version/g" "$FAKE_PRIME_TEMPLATE" >"$cli_dir/cli.js"
chmod 0755 "$cli_dir/cli.js"
FAKE_NPM
chmod 0755 "$fake_bin/npm"

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

# Bundled runtime tree required by ensure_kernel_runtime (shipped inside prime-agent).
mkdir -p "$fixture_root/fake-runtime-src"
printf '[project]\nname = "prime-agent-runtime"\nversion = "0.1.0"\n' \
  >"$fixture_root/fake-runtime-src/pyproject.toml"

cat >"$fake_bin/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -u

if [[ "${1-}" == -p ]]; then
  # version probe used by require_node / major check
  printf '24\n'
  exit 0
fi

cli="${1-}"
shift || true
[[ -n "$cli" && -f "$cli" ]] || exit 97
# Execute the fake CLI script directly (it is a bash stub, not JS).
exec bash "$cli" "$@"
FAKE_NODE
chmod 0755 "$fake_bin/node"

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
      printf '{"data":[{"id":"claude-opus-5"},{"id":"vendor/custom"}]}\n'
    else
      printf '{"data":[{"id":"another-model"}]}\n'
    fi
    ;;
  https://files.pythonhosted.org|https://files.pythonhosted.org/)
    # Default: public CDN blocked so launcher exercises the mirror path.
    [[ "${FAKE_PYPI_CDN:-blocked}" == ok ]] || exit 7
    ;;
  *) exit 93 ;;
esac
FAKE_CURL
chmod 0755 "$fake_bin/curl"

cat >"$fake_bin/uv" <<'FAKE_UV'
#!/usr/bin/env bash
set -u

printf '%s\n' "$*" >>"$FAKE_UV_LOG"

case "${1-}" in
  python)
    [[ "${2-}" == install && "${3-}" == 3.11 ]] || exit 80
    exit 0
    ;;
  venv)
    dest="${2-}"
    [[ -n "$dest" ]] || exit 81
    mkdir -p "$dest/bin"
    # Fake venv python that satisfies kernel_runtime_ready import checks.
    cat >"$dest/bin/python" <<'PY'
#!/usr/bin/env bash
set -u
# Accept any -c import probe used by kernel_runtime_ready.
if [[ "${1-}" == -c ]]; then
  exit 0
fi
exit 0
PY
    chmod 0755 "$dest/bin/python"
    exit 0
    ;;
  pip)
    [[ "${2-}" == install && "${3-}" == --python ]] || exit 82
    exit 0
    ;;
  *) exit 83 ;;
esac
FAKE_UV
chmod 0755 "$fake_bin/uv"

# Real jq from the host.
if ! command -v jq >/dev/null 2>&1; then
  fail 'host jq is required for the contract'
fi
ln -s "$(command -v jq)" "$fake_bin/jq"

export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$home"
export FAKE_MISE_LOG="$fixture_root/mise.log"
export FAKE_NPM_LOG="$fixture_root/npm.log"
export FAKE_CURL_LOG="$fixture_root/curl.log"
export FAKE_UV_LOG="$fixture_root/uv.log"
export FAKE_PRIME_LOG="$fixture_root/prime.log"
export FAKE_PRIME_TEMPLATE="$fixture_root/fake-prime-template"
: >"$FAKE_MISE_LOG"
: >"$FAKE_NPM_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_UV_LOG"
: >"$FAKE_PRIME_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
command_path="$HOME/.local/bin/prx"
runtime_root="$HOME/.local/share/trellage/prx"
profile_root="$HOME/.local/share/trellage/profiles/prime/default"
profile_home="$profile_root/home"

[[ -L "$command_path" ]] || fail 'installer did not publish command symlink'
[[ "$(readlink "$command_path")" == "$runtime_root/bin/prx" ]] \
  || fail 'command symlink target differs'
cmp -s "$runtime_root/catalog.json" "$root/catalog.json" \
  || fail 'installer did not publish catalog'
[[ -f "$runtime_root/.managed-by-trellage-prime-profiles" ]] \
  || fail 'installer did not write ownership marker'
[[ "$(<"$runtime_root/.managed-by-trellage-prime-profiles")" == trellage-prime-profiles-v1 ]] \
  || fail 'ownership marker value differs'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "prx"
  and .harness == "prime"
  and [.profiles[].name] == ["default"]
  and .profiles[0].source == "PrimeIntellect-ai/prime-agent"
  and .profiles[0].plugin == null
  and .profiles[0].standaloneMcps == []
' "$fixture_root/list.json" >/dev/null || fail 'JSON list differs'

"$command_path" list >"$fixture_root/list.txt" || fail 'text list failed'
grep -Fq $'default\tPrime Agent with proxy-backed Claude Opus 5, persistent IPython/RLM subagents and daemon sessions, plus the managed ask_user extension.' \
  "$fixture_root/list.txt" || fail 'text list differs'

"$command_path" default -p 'self-heal-before-setup-probe' \
  >"$fixture_root/self-heal.out" 2>"$fixture_root/self-heal.err" \
  || fail 'launch before explicit setup did not self-heal'
[[ -f "$runtime_root/version" ]] \
  || fail 'self-healed launch did not pin a version'
[[ -f "$profile_root/.managed-by-trellage-prime-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
rm -rf "$profile_root" "$runtime_root/version"

"$command_path" setup >"$fixture_root/setup.out" 2>"$fixture_root/setup.err" \
  || fail 'setup failed'
[[ "$(<"$runtime_root/version")" == 0.7.0 ]] || fail 'setup did not pin version'
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
grep -Fq 'venv' "$FAKE_UV_LOG" || fail 'setup did not invoke uv venv'
grep -Fq 'pip install' "$FAKE_UV_LOG" || fail 'setup did not install kernel packages'
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080"
  and .providers["copilot-proxy-rs"].api == "anthropic-messages"
  and .providers["copilot-proxy-rs"].apiKey == "trellage-local-proxy"
  and .providers["copilot-proxy-rs"].compat.supportsEagerToolInputStreaming == false
  and [.providers["copilot-proxy-rs"].models[].id] == ["claude-opus-5"]
' "$profile_home/models.json" >/dev/null || fail 'models.json seed differs'
[[ "$(file_mode "$profile_home/models.json")" == 600 ]] \
  || fail 'models.json mode is not 0600'
grep -Fq 'prx setup: ready (0.7.0, claude-opus-5)' "$fixture_root/setup.out" \
  || fail 'setup output differs'
[[ -f "$runtime_root/npm-prefix/lib/node_modules/prime-agent/dist/bundle/cli.js" ]] \
  || fail 'setup did not install prime-agent CLI'
grep -Fq 'install github:PrimeIntellect-ai/prime-agent@0.7.0' "$FAKE_MISE_LOG" \
  || fail 'setup did not ask mise to install the pinned release'

"$command_path" doctor >"$fixture_root/doctor.out" || fail 'doctor failed'
grep -Fq 'prx doctor: OK (0.7.0, claude-opus-5)' "$fixture_root/doctor.out" \
  || fail 'doctor output differs'

# Seed poison credentials; launch must unset them.
export ANTHROPIC_API_KEY=poison-anthropic
export OPENAI_API_KEY=poison-openai
export GH_TOKEN=poison-gh
export GITHUB_TOKEN=poison-github
export COPILOT_GITHUB_TOKEN=poison-copilot
: >"$FAKE_PRIME_LOG"
"$command_path" default -p 'two words' '' '--literal=*' \
  || fail 'explicit launch failed'
jq -e --arg home "$profile_home" \
  --arg kernelPython "$profile_home/kernel-venv/bin/python" \
  --arg kernelVenv "$profile_home/kernel-venv" \
  --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  .codingAgentDir == $home
  and .kernelPython == $kernelPython
  and .kernelVenv == $kernelVenv
  and .anthropic == "unset"
  and .openai == "unset"
  and .gh == "unset"
  and .github == "unset"
  and .copilot == "unset"
  and .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5",
    "--offline",
    "--autonomous",
    "--daemon-socket", $daemonSocket,
    "-p", "two words", "", "--literal=*"
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'launch environment or arguments differ'
[[ -f "$profile_root/daemon/kernel-env.stamp" && ! -L "$profile_root/daemon/kernel-env.stamp" ]] \
  || fail 'launch did not write daemon kernel env stamp'
[[ -d "$profile_root/daemon" && ! -L "$profile_root/daemon" ]] \
  || fail 'launch did not create profile daemon directory'
unset ANTHROPIC_API_KEY OPENAI_API_KEY GH_TOKEN GITHUB_TOKEN COPILOT_GITHUB_TOKEN

# Bare launch is equivalent to default.
: >"$FAKE_PRIME_LOG"
"$command_path" -p 'bare' || fail 'bare launch failed'
jq -e --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5",
    "--offline",
    "--autonomous",
    "--daemon-socket", $daemonSocket,
    "-p", "bare"
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'bare launch arguments differ'

# An argument-free launch must work under macOS Bash 3.2 with `set -u`.
: >"$FAKE_PRIME_LOG"
"$command_path" default || fail 'argument-free launch failed'
jq -e --arg daemonSocket "$profile_root/daemon/daemon.sock" '
  .args == [
    "--provider", "copilot-proxy-rs",
    "--model", "claude-opus-5",
    "--offline",
    "--autonomous",
    "--daemon-socket", $daemonSocket
  ]
' "$FAKE_PRIME_LOG" >/dev/null || fail 'argument-free launch arguments differ'

# shutdown is a managed command (no live socket in the fixture).
# Publish a minimal daemon-launch module so stop_profile_daemon_socket can import.
mkdir -p "$runtime_root/npm-prefix/lib/node_modules/prime-agent/dist/cli"
cat >"$runtime_root/npm-prefix/lib/node_modules/prime-agent/dist/cli/daemon-launch.js" <<'FAKE_LAUNCH'
export async function shutdownDaemonAndWait() {
  return false;
}
FAKE_LAUNCH
"$command_path" shutdown >"$fixture_root/shutdown.out" || fail 'shutdown failed'
grep -Fq 'prx shutdown: no profile daemon socket' "$fixture_root/shutdown.out" \
  || fail 'shutdown output differs'
[[ ! -e "$profile_root/daemon/kernel-env.stamp" ]] \
  || fail 'shutdown did not clear daemon kernel env stamp'

: >"$FAKE_PRIME_LOG"
"$command_path" --model vendor/custom -p custom-model || fail 'custom model launch failed'
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080"
  and [.providers["copilot-proxy-rs"].models[].id] == ["vendor/custom"]
' "$profile_home/models.json" >/dev/null \
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
"$command_path" -p restore-probe || fail 'launch after drift failed'
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080"
  and [.providers["copilot-proxy-rs"].models[].id] == ["claude-opus-5"]
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

status=0
FAKE_PRIME_EXIT_STATUS=37 "$command_path" -p probe || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status"

FAKE_PROXY_HAS_MODEL=0 "$command_path" doctor >"$fixture_root/model.out" 2>&1 \
  && fail 'doctor accepted missing model'
grep -Fq 'copilot-proxy-rs model is missing: claude-opus-5' "$fixture_root/model.out" \
  || fail 'missing model error differs'

FAKE_MISE_LATEST=0.8.0 "$command_path" update --check \
  >"$fixture_root/update-check.out" || fail 'update check failed'
grep -Fq '0.7.0 -> 0.8.0 available' "$fixture_root/update-check.out" \
  || fail 'update check output differs'
FAKE_MISE_LATEST=0.8.0 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/version")" == 0.8.0 ]] || fail 'update did not change pin'
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
grep -Fq 'prx repair: restored (0.8.0, claude-opus-5)' "$fixture_root/repair.out" \
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

"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
[[ ! -e "$runtime_root" ]] || fail 'uninstaller left runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstaller left command'
[[ -d "$profile_home" ]] || fail 'uninstaller removed profile state'
[[ -f "$profile_home/models.json" ]] || fail 'uninstaller removed models.json'
grep -Fq 'Prime profile state and sessions were preserved' "$fixture_root/uninstall.out" \
  || fail 'uninstall message differs'

printf 'prx contract: PASS\n'
