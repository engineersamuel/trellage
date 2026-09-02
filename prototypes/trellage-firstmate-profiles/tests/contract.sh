#!/usr/bin/env bash

# Static, offline contract for the Native Firstmate (fmx) launcher package.
#
# Every external dependency is faked: git, gh, tmux, herdr, claude, and the
# shared native-claude helper. Nothing here reaches the network, and the pinned
# Firstmate source is staged from the checked-in fixture tree.

set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
repo_root="$(CDPATH= cd -- "$root/../.." && pwd)"
launcher="$root/bin/fmx"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"
worker_helper="$root/lib/fmx-worker"
prerequisite_helper="$root/lib/fmx-prerequisites"
overlay_tool="$root/lib/fmx-overlay.py"
readonly pinned_commit='4ad8cbaeafc109a17c1af3911867b7fe9e04e801'
readonly ownership_value='trellage-firstmate-profiles-v1'
readonly install_lock_owner='trellage-firstmate-install-lock-v1'
readonly prerequisite_install_lock_owner='trellage-firstmate-prerequisites-v1'
readonly host_bash="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' \
  "${BASH}")"

fail() {
  printf 'fmx contract failed: %s\n' "$1" >&2
  exit 1
}

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-fmx-contract.XXXXXX")" \
  || fail 'could not create fixture root'
# Canonical, so path assertions match the launcher's own resolved paths.
fixture_root="$(CDPATH= cd -P -- "$fixture_root" && pwd -P)" \
  || fail 'could not resolve fixture root'
busy_pid=''
cleanup() {
  if [[ "$busy_pid" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "$busy_pid" 2>/dev/null || true
    wait "$busy_pid" 2>/dev/null || true
  fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

assert_contains() {
  grep -Fq -- "$1" "$2" || {
    printf 'fmx contract failed: %s did not contain: %s\n' "$2" "$1" >&2
    sed -n 1,40p "$2" >&2
    exit 1
  }
}

assert_not_contains() {
  if grep -Fq -- "$1" "$2"; then
    printf 'fmx contract failed: %s unexpectedly contained: %s\n' "$2" "$1" >&2
    exit 1
  fi
}

fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
logs="$fixture_root/logs"
mirror="$fixture_root/mirror"
mkdir -p "$fake_bin" "$home" "$logs"

real_jq="$(command -v jq)" || fail 'jq is required'
real_python3="$(command -v python3)" || fail 'python3 is required'
real_bash="$(command -v bash)" || fail 'bash is required'

# ---------------------------------------------------------------------------
# Fake host commands.
# ---------------------------------------------------------------------------

real_git="$(command -v git)" || fail 'git is required'

# Real git for every local operation, so status, diff, and mode checks are
# genuine. Only the network fetch, the initial materialization, and the commit
# identity are simulated: a synthetic repository cannot reproduce the upstream
# SHA, so rev-parse HEAD is answered from the fixture instead.
cat >"$fake_bin/git" <<FAKE_GIT
#!/usr/bin/env bash
set -euo pipefail

readonly real_git='$real_git'
printf '%s\n' "\$*" >>"\$FAKE_GIT_LOG"

directory=''
if [[ "\${1-}" == -C ]]; then
  directory="\$2"
  shift 2
fi

run_real() {
  if [[ -n "\$directory" ]]; then
    "\$real_git" -C "\$directory" "\$@"
  else
    "\$real_git" "\$@"
  fi
}

case "\${1-}" in
  fetch)
    if [[ "\${FAKE_GIT_FETCH_STATUS:-0}" != 0 ]]; then
      printf 'fatal: could not fetch\n' >&2
      exit "\$FAKE_GIT_FETCH_STATUS"
    fi
    ;;
  checkout)
    cp -R "\$FAKE_GIT_SOURCE_TREE/." "\$directory/"
    run_real add -A
    run_real -c user.email=contract@example.invalid -c user.name=contract \
      commit -q -m 'pinned firstmate base'
    if [[ -n "\${FAKE_GIT_TAMPER_FILE-}" ]]; then
      printf '# tampered\n' >>"\$directory/\$FAKE_GIT_TAMPER_FILE"
    fi
    # An extra file added AFTER the base commit is invisible to the overlay
    # digests and is caught only by the full checkout report.
    if [[ -n "\${FAKE_GIT_STAGE_EXTRA-}" ]]; then
      printf 'stowaway\n' >"\$directory/\$FAKE_GIT_STAGE_EXTRA"
    fi
    ;;
  rev-parse)
    if [[ "\${2-}" == HEAD ]]; then
      printf '%s\n' "\${FAKE_GIT_HEAD:-4ad8cbaeafc109a17c1af3911867b7fe9e04e801}"
    else
      run_real "\$@"
    fi
    ;;
  *)
    run_real "\$@"
    ;;
esac
FAKE_GIT
chmod 0755 "$fake_bin/git"

cat >"$fake_bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s|GH_TOKEN=%s|GITHUB_TOKEN=%s|COPILOT_GITHUB_TOKEN=%s|COPILOT_PROXY_GITHUB_TOKEN=%s|GH_ENTERPRISE_TOKEN=%s|GITHUB_ENTERPRISE_TOKEN=%s|COPILOT_TOKEN=%s\n' \
  "$*" "${GH_TOKEN-unset}" "${GITHUB_TOKEN-unset}" "${COPILOT_GITHUB_TOKEN-unset}" \
  "${COPILOT_PROXY_GITHUB_TOKEN-unset}" "${GH_ENTERPRISE_TOKEN-unset}" \
  "${GITHUB_ENTERPRISE_TOKEN-unset}" "${COPILOT_TOKEN-unset}" \
  >>"$FAKE_GH_LOG"
exit "${FAKE_GH_STATUS:-0}"
FAKE_GH
chmod 0755 "$fake_bin/gh"

cat >"$fake_bin/tmux" <<'FAKE_TMUX'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_TMUX_LOG"
exit 0
FAKE_TMUX
chmod 0755 "$fake_bin/tmux"

cat >"$fake_bin/herdr" <<'FAKE_HERDR'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_HERDR_LOG"
exit 0
FAKE_HERDR
chmod 0755 "$fake_bin/herdr"

cat >"$fake_bin/claude" <<'FAKE_CLAUDE'
#!/usr/bin/env bash
printf 'CLAUDE_CONFIG_DIR=%s|ANTHROPIC_BASE_URL=%s|GH_TOKEN=%s|HERDR_PANE_ID=%s|args=%s\n' \
  "${CLAUDE_CONFIG_DIR-unset}" "${ANTHROPIC_BASE_URL-unset}" "${GH_TOKEN-unset}" \
  "${HERDR_PANE_ID-unset}" "$*" >>"$FAKE_CLAUDE_LOG"
exit 0
FAKE_CLAUDE
chmod 0755 "$fake_bin/claude"

for tool_version in \
  'no-mistakes:1.60.2' \
  'treehouse:2.0.1' \
  'gh-axi:0.1.35' \
  'chrome-devtools-axi:0.1.33' \
  'lavish-axi:0.1.63' \
  'tasks-axi:0.2.5' \
  'quota-axi:0.1.34'; do
  tool="${tool_version%%:*}"
  version="${tool_version#*:}"
  cat >"$fake_bin/$tool" <<FAKE_PREREQUISITE
#!/usr/bin/env bash
if [[ "\${1-}" == --version ]]; then
  printf '%s %s\\n' '$tool' '$version'
fi
exit 0
FAKE_PREREQUISITE
  chmod 0755 "$fake_bin/$tool"
done

# Stand-in for prototypes/trellage-claude-common/native-claude. It implements
# the published prepare/doctor/launch interface only.
fake_native_claude="$fixture_root/native-claude"
cat >"$fake_native_claude" <<'FAKE_NATIVE_CLAUDE'
#!/usr/bin/env bash
set -euo pipefail

[[ "${TRELLAGE_CLAUDE_LAUNCHER_NAME-}" == fmx ]] \
  || { printf 'native-claude: TRELLAGE_CLAUDE_LAUNCHER_NAME is not fmx\n' >&2; exit 2; }
[[ "${TRELLAGE_CLAUDE_RUNTIME_ROOT-}" == /* && -d "${TRELLAGE_CLAUDE_RUNTIME_ROOT-}" ]] \
  || { printf 'native-claude: TRELLAGE_CLAUDE_RUNTIME_ROOT is not an installed runtime root\n' >&2; exit 2; }
[[ -f "$TRELLAGE_CLAUDE_RUNTIME_ROOT/lib/trellage-session-bridge.py" ]] \
  || { printf 'native-claude: the session bridge is missing from the runtime root\n' >&2; exit 2; }

mode="${1-}"
shift || true
if [[ "$mode" == exec-clean ]]; then
  clean_interpreter=''
  if [[ "${1-}" == --interpreter ]]; then
    clean_interpreter="$2"
    shift 2
  fi
  [[ "${1-}" == -- ]] || exit 2
  shift
  unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL
  unset ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL
  unset CLAUDE_CODE_USE_FOUNDRY ANTHROPIC_FOUNDRY_API_KEY ANTHROPIC_FOUNDRY_BASE_URL
  unset ANTHROPIC_FOUNDRY_RESOURCE ANTHROPIC_BEDROCK_BASE_URL ANTHROPIC_VERTEX_BASE_URL
  unset CLAUDE_CODE_USE_BEDROCK AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  unset AWS_PROFILE AWS_BEARER_TOKEN_BEDROCK AWS_REGION AWS_DEFAULT_REGION AWS_ROLE_ARN
  unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE
  unset CLAUDE_CODE_USE_VERTEX GOOGLE_APPLICATION_CREDENTIALS ANTHROPIC_VERTEX_PROJECT_ID
  unset CLOUD_ML_REGION GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_QUOTA_PROJECT GOOGLE_CLOUD_REGION
  unset VERTEX_PROJECT VERTEX_REGION
  unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID OPENAI_API_KEY AZURE_API_KEY
  unset AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT OPENAI_BASE_URL
  unset COPILOT_GITHUB_TOKEN COPILOT_PROXY_GITHUB_TOKEN COPILOT_TOKEN
  unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  if [[ -n "$clean_interpreter" ]]; then
    exec "$clean_interpreter" "$@"
  fi
  exec "$@"
fi
config_home=''
marker=''
marker_value=''
bridge=''
profile=default
saw_profile=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --home) config_home="$2"; shift 2 ;;
    --marker) marker="$2"; shift 2 ;;
    --marker-value) marker_value="$2"; shift 2 ;;
    --bridge) bridge="$2"; shift 2 ;;
    --profile) profile="$2"; saw_profile=true; shift 2 ;;
    --require-existing) shift ;;
    --) shift; break ;;
    *) printf 'native-claude: unexpected argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$config_home" == /* ]] || { printf 'native-claude: --home must be absolute\n' >&2; exit 2; }
[[ "$marker" == /* ]] || { printf 'native-claude: --marker must be absolute\n' >&2; exit 2; }
[[ -n "$marker_value" ]] || { printf 'native-claude: --marker-value is required\n' >&2; exit 2; }
case "$bridge" in
  enabled|disabled) ;;
  *) printf 'native-claude: --bridge must be enabled or disabled\n' >&2; exit 2 ;;
esac

printf '%s|home=%s|marker=%s|value=%s|bridge=%s|profile=%s\n' \
  "$mode" "$config_home" "$marker" "$marker_value" "$bridge" "$profile" \
  >>"$NATIVE_CLAUDE_LOG"

case "$mode" in
  prepare)
    if [[ "${NATIVE_CLAUDE_PREPARE_SIGNAL_PARENT-}" == TERM ]]; then
      kill -TERM "$PPID"
    fi
    if [[ -n "${NATIVE_CLAUDE_PREPARE_HOLD-}" ]]; then
      sleep "$NATIVE_CLAUDE_PREPARE_HOLD"
    fi
    mkdir -p "$config_home"
    # The real prepare runs a skills installer that reads standard input. A
    # --all selection must survive that.
    cat >/dev/null 2>/dev/null || true
    exit 0
    ;;
  doctor)
    if [[ -n "${NATIVE_CLAUDE_DOCTOR_HOLD-}" ]]; then
      sleep "$NATIVE_CLAUDE_DOCTOR_HOLD"
    fi
    [[ -d "$config_home" ]] || { printf 'native-claude: home is missing\n' >&2; exit 1; }
    exit "${NATIVE_CLAUDE_DOCTOR_STATUS:-0}"
    ;;
  launch)
    # The shared runtime keys its bridge-hook validation on the profile name,
    # so a caller that omits it silently checks the default profile's hook.
    [[ "$saw_profile" == true ]] \
      || { printf 'native-claude: launch requires --profile\n' >&2; exit 2; }
    herdr_state=none
    for exported in $(compgen -e); do
      case "$exported" in
        HERDR_*) herdr_state="leaked:$exported" ;;
      esac
    done
    printf 'launch|FM_HOME=%s|FM_ROOT_OVERRIDE=%s|FM_BACKEND=%s|FMX_PROFILE=%s|FMX_PROFILE_ROOT=%s|FMX_WORKER_LAUNCHER=%s|FMX_TASK_ID_PREFIX=%s|FMX_WORKER_POLICY_FILE=%s|FMX_CAPTAIN_PANE_ID=%s|FMX_GH_CONFIG_DIR=%s|FMX_WORKER_HOME=%s|FMX_WORKER_PATH=%s|FMX_WORKER_BASH=%s|TASKS_AXI_BACKEND=%s|TASKS_AXI_FILE=%s|HOME=%s|GH_CONFIG_DIR=%s|ANTHROPIC_BASE_URL=%s|GH_TOKEN=%s|GITHUB_TOKEN=%s|COPILOT_GITHUB_TOKEN=%s|CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=%s|CURSOR_AGENT=%s|TRACEPARENT=%s|HERDR=%s|HERDR_PANE_ID=%s|TRELLAGE_GUIDE_HERDR_CONTEXT_JSON=%s|FM_STATE_OVERRIDE=%s|FM_DATA_OVERRIDE=%s|FM_PROJECTS_OVERRIDE=%s|FM_CONFIG_OVERRIDE=%s|FM_PUBLIC_FOLLOWUP_PRIMARY_HOME=%s|FM_TRACE_CONTEXT=%s|FM_SUPERVISION_MODEL=%s|cwd=%s|home=%s|bridge=%s|profile=%s|args=%s\n' \
      "${FM_HOME-unset}" "${FM_ROOT_OVERRIDE-unset}" "${FM_BACKEND-unset}" \
      "${FMX_PROFILE-unset}" "${FMX_PROFILE_ROOT-unset}" "${FMX_WORKER_LAUNCHER-unset}" \
      "${FMX_TASK_ID_PREFIX-unset}" "${FMX_WORKER_POLICY_FILE-unset}" \
      "${FMX_CAPTAIN_PANE_ID-unset}" "${FMX_GH_CONFIG_DIR-unset}" \
      "${FMX_WORKER_HOME-unset}" "${FMX_WORKER_PATH-unset}" \
      "${FMX_WORKER_BASH-unset}" "${TASKS_AXI_BACKEND-unset}" \
      "${TASKS_AXI_FILE-unset}" "${HOME-unset}" \
      "${GH_CONFIG_DIR-unset}" "${ANTHROPIC_BASE_URL-unset}" \
      "${GH_TOKEN-unset}" "${GITHUB_TOKEN-unset}" "${COPILOT_GITHUB_TOKEN-unset}" \
      "${CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION-unset}" "${CURSOR_AGENT-unset}" \
      "${TRACEPARENT-unset}" "$herdr_state" "${HERDR_PANE_ID-unset}" \
      "${TRELLAGE_GUIDE_HERDR_CONTEXT_JSON-unset}" \
      "${FM_STATE_OVERRIDE-unset}" "${FM_DATA_OVERRIDE-unset}" \
      "${FM_PROJECTS_OVERRIDE-unset}" "${FM_CONFIG_OVERRIDE-unset}" \
      "${FM_PUBLIC_FOLLOWUP_PRIMARY_HOME-unset}" "${FM_TRACE_CONTEXT-unset}" \
      "${FM_SUPERVISION_MODEL-unset}" \
      "$(pwd -P)" "$config_home" "$bridge" "$profile" "$*" \
      >>"$NATIVE_CLAUDE_LAUNCH_LOG"
    if [[ -n "${NATIVE_CLAUDE_LAUNCH_HOLD-}" ]]; then
      sleep "$NATIVE_CLAUDE_LAUNCH_HOLD"
    fi
    exit 0
    ;;
  *)
    printf 'native-claude: unsupported mode: %s\n' "$mode" >&2
    exit 2
    ;;
esac
FAKE_NATIVE_CLAUDE
chmod 0755 "$fake_native_claude"

ln -s "$real_jq" "$fake_bin/jq"
ln -s "$real_python3" "$fake_bin/python3"
ln -s "$real_bash" "$fake_bin/bash"
for tool in sh env sed grep find mktemp cat head tail cp mv rm rmdir mkdir chmod ln sort tr wc cmp \
  basename dirname sleep install readlink awk uname date ls touch expr id cut comm diff \
  node npm curl shasum sha256sum; do
  target="$(command -v "$tool" 2>/dev/null || true)"
  if [[ -n "$target" && ! -e "$fake_bin/$tool" ]]; then
    ln -s "$target" "$fake_bin/$tool"
  fi
done

export FAKE_GIT_LOG="$logs/git.log"
export FAKE_GH_LOG="$logs/gh.log"
export FAKE_TMUX_LOG="$logs/tmux.log"
export FAKE_HERDR_LOG="$logs/herdr.log"
export FAKE_CLAUDE_LOG="$logs/claude.log"
export NATIVE_CLAUDE_LOG="$logs/native-claude.log"
export NATIVE_CLAUDE_LAUNCH_LOG="$logs/native-claude-launch.log"
export FAKE_GIT_SOURCE_TREE="$fixture_root/source/$pinned_commit"
: >"$FAKE_GIT_LOG"
: >"$FAKE_GH_LOG"
: >"$NATIVE_CLAUDE_LOG"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"

# Working copy of the pinned upstream fixture, so tamper tests never touch the
# checked-in tree.
mkdir -p "$fixture_root/source"
cp -R "$root/tests/fixtures/firstmate/$pinned_commit" "$FAKE_GIT_SOURCE_TREE"

# Minimal stand-ins for the upstream libraries the two executable fixtures load.
cat >"$FAKE_GIT_SOURCE_TREE/bin/fm-marker-lib.sh" <<'STUB'
FM_FROMFIRST_LABEL='[from-firstmate]'
STUB
cat >"$FAKE_GIT_SOURCE_TREE/bin/fm-classify-lib.sh" <<'STUB'
FM_CLASSIFY_PAUSED_VERB_DEFAULT=paused
STUB
cat >"$FAKE_GIT_SOURCE_TREE/bin/fm-dod-lib.sh" <<'STUB'
fm_dod_block() { printf '# Definition of done\nmode=%s id=%s\n' "$1" "$2"; }
STUB
cat >"$FAKE_GIT_SOURCE_TREE/bin/fm-ff-lib.sh" <<'STUB'
ff_target() { FF_STATUS=up-to-date; FF_INSTR=''; }
STUB
# Upstream Firstmate gitignores its operational directories and local env, so
# the staged fixture must too: an ignored file is exactly what a plain
# --untracked-files=all status would hide.
cat >"$FAKE_GIT_SOURCE_TREE/.gitignore" <<'STUB'
.env
config/
data/
state/
projects/
.no-mistakes/
STUB
cat >"$FAKE_GIT_SOURCE_TREE/bin/fm-guard.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod 0755 "$FAKE_GIT_SOURCE_TREE/bin/fm-guard.sh"
cat >"$FAKE_GIT_SOURCE_TREE/bin/fm-bootstrap.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

tools='node git gh no-mistakes gh-axi chrome-devtools-axi lavish-axi tasks-axi quota-axi'
case "${FM_BACKEND:-tmux}" in
  herdr) tools="herdr jq treehouse $tools" ;;
  tmux) tools="tmux treehouse $tools" ;;
  *) printf 'BACKEND_INVALID: %s (known: tmux herdr)\n' "${FM_BACKEND-}" ;;
esac
for tool in $tools; do
  command -v "$tool" >/dev/null 2>&1 \
    || printf 'MISSING: %s (install: fixture)\n' "$tool"
done
STUB
chmod 0755 "$FAKE_GIT_SOURCE_TREE/bin/fm-bootstrap.sh"

# ---------------------------------------------------------------------------
# Package mirror so install.sh can resolve its shared runtime dependencies.
# ---------------------------------------------------------------------------

mkdir -p "$mirror/prototypes/trellage-claude-common" "$mirror/scripts"
cp -R "$root" "$mirror/prototypes/trellage-firstmate-profiles"
cat >"$mirror/prototypes/trellage-firstmate-profiles/lib/fmx-prerequisites" <<'FAKE_PREREQUISITE_HELPER'
#!/usr/bin/env bash
set -euo pipefail

runtime_root="$(CDPATH= cd -P -- "$(dirname "$0")/.." && pwd)"
identity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
destination="$runtime_root/prerequisites/$identity"

write_tool() {
  local path="$1" name="$2" version="$3"
  cat >"$path" <<FAKE_TOOL
#!/usr/bin/env bash
if [[ "\${1-}" == --version ]]; then
  printf '%s %s\\n' '$name' '$version'
fi
exit 0
FAKE_TOOL
  chmod 0755 "$path"
}

case "${1-}" in
  identity)
    printf '%s\n' "$identity"
    ;;
  destination)
    printf '%s\n' "$destination"
    ;;
  path)
    [[ -f "$destination/.complete" ]] || exit 1
    printf '%s:%s\n' "$destination/bin" "$destination/npm/node_modules/.bin"
    ;;
  verify)
    [[ -f "$destination/.complete" ]] || exit 1
    printf 'Firstmate prerequisites: OK (%s)\n' "$destination"
    ;;
  install)
    printf 'install|GH_TOKEN=%s|GITHUB_TOKEN=%s|COPILOT_GITHUB_TOKEN=%s|COPILOT_PROXY_GITHUB_TOKEN=%s|destination=%s\n' \
      "${GH_TOKEN-unset}" "${GITHUB_TOKEN-unset}" "${COPILOT_GITHUB_TOKEN-unset}" \
      "${COPILOT_PROXY_GITHUB_TOKEN-unset}" "$destination" \
      >>"$FAKE_PREREQUISITE_LOG"
    if [[ -n "${FAKE_EXPECT_LAUNCH_MUTATION_PROFILE-}" ]]; then
      mutation_lock="$HOME/.local/share/trellage/profiles/firstmate/$FAKE_EXPECT_LAUNCH_MUTATION_PROFILE/locks/mutation"
      [[ -d "$mutation_lock" && ! -L "$mutation_lock" \
        && "$(<"$mutation_lock/owner")" == trellage-firstmate-profiles-v1 \
        && "$(<"$mutation_lock/action")" == launch \
        && "$(<"$mutation_lock/pid")" == "$PPID" ]] \
        || { printf 'expected parent-owned launch mutation lock: %s\n' "$mutation_lock" >&2; exit 97; }
    fi
    [[ "${FAKE_PREREQUISITE_INSTALL_STATUS:-0}" == 0 ]] \
      || exit "$FAKE_PREREQUISITE_INSTALL_STATUS"
    mkdir -p "$destination/bin" "$destination/npm/node_modules/.bin"
    write_tool "$destination/bin/no-mistakes" no-mistakes 1.60.2
    write_tool "$destination/bin/treehouse" treehouse 2.0.1
    write_tool "$destination/npm/node_modules/.bin/gh-axi" gh-axi 0.1.35
    write_tool "$destination/npm/node_modules/.bin/chrome-devtools-axi" chrome-devtools-axi 0.1.33
    write_tool "$destination/npm/node_modules/.bin/lavish-axi" lavish-axi 0.1.63
    write_tool "$destination/npm/node_modules/.bin/tasks-axi" tasks-axi 0.2.5
    write_tool "$destination/npm/node_modules/.bin/quota-axi" quota-axi 0.1.34
    printf '%s\n' "$identity" >"$destination/.complete"
    printf 'Installed Firstmate prerequisites at %s\n' "$destination"
    ;;
  *)
    exit 2
    ;;
esac
FAKE_PREREQUISITE_HELPER
chmod 0755 "$mirror/prototypes/trellage-firstmate-profiles/lib/fmx-prerequisites"
cp "$fake_native_claude" "$mirror/prototypes/trellage-claude-common/native-claude"
chmod 0755 "$mirror/prototypes/trellage-claude-common/native-claude"
cp "$repo_root/scripts/trellage-session-bridge.py" "$mirror/scripts/trellage-session-bridge.py"
cp "$repo_root/scripts/install-floating-skills-runtime.sh" "$mirror/scripts/"
cp "$repo_root/scripts/floating-skills.mjs" "$mirror/scripts/"
cp "$repo_root/skills.json" "$mirror/skills.json"
mirror_installer="$mirror/prototypes/trellage-firstmate-profiles/install.sh"
mirror_uninstaller="$mirror/prototypes/trellage-firstmate-profiles/uninstall.sh"
export FAKE_PREREQUISITE_LOG="$logs/prerequisites.log"
: >"$FAKE_PREREQUISITE_LOG"

install_root="$home/.local/share/trellage/fmx"
install_lock="$home/.local/share/trellage/.fmx-install.lock"
command_path="$home/.local/bin/fmx"
profiles_root="$home/.local/share/trellage/profiles/firstmate"

gh_config="$home/.config/gh"
mkdir -p "$gh_config"
cat >"$gh_config/hosts.yml" <<'HOSTS'
github.com:
    user: contract
    oauth_token: fixture
HOSTS

fmx() {
  env -i \
    HOME="$home" \
    PATH="$fake_bin" \
    GH_CONFIG_DIR="$gh_config" \
    TMPDIR="${TMPDIR:-/tmp}" \
    FAKE_GIT_LOG="$FAKE_GIT_LOG" \
    FAKE_GH_LOG="$FAKE_GH_LOG" \
    FAKE_TMUX_LOG="$FAKE_TMUX_LOG" \
    FAKE_HERDR_LOG="$FAKE_HERDR_LOG" \
    FAKE_PREREQUISITE_LOG="$FAKE_PREREQUISITE_LOG" \
    FAKE_PREREQUISITE_INSTALL_STATUS="${FAKE_PREREQUISITE_INSTALL_STATUS:-0}" \
    FAKE_EXPECT_LAUNCH_MUTATION_PROFILE="${FAKE_EXPECT_LAUNCH_MUTATION_PROFILE-}" \
    FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" \
    FAKE_GIT_SOURCE_TREE="$FAKE_GIT_SOURCE_TREE" \
    FAKE_GIT_HEAD="${FAKE_GIT_HEAD-}" \
    FAKE_GIT_FETCH_STATUS="${FAKE_GIT_FETCH_STATUS:-0}" \
    FAKE_GIT_TAMPER_FILE="${FAKE_GIT_TAMPER_FILE-}" \
    FAKE_GIT_STAGE_EXTRA="${FAKE_GIT_STAGE_EXTRA-}" \
    FAKE_GH_STATUS="${FAKE_GH_STATUS:-0}" \
    NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
    NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
    NATIVE_CLAUDE_DOCTOR_STATUS="${NATIVE_CLAUDE_DOCTOR_STATUS:-0}" \
    NATIVE_CLAUDE_DOCTOR_HOLD="${NATIVE_CLAUDE_DOCTOR_HOLD-}" \
    NATIVE_CLAUDE_LAUNCH_HOLD="${NATIVE_CLAUDE_LAUNCH_HOLD-}" \
    NATIVE_CLAUDE_PREPARE_HOLD="${NATIVE_CLAUDE_PREPARE_HOLD-}" \
    NATIVE_CLAUDE_PREPARE_SIGNAL_PARENT="${NATIVE_CLAUDE_PREPARE_SIGNAL_PARENT-}" \
    HERDR_ENV="${TEST_HERDR_ENV-}" \
    HERDR_PANE_ID="${TEST_HERDR_PANE-}" \
    GH_TOKEN=fixture-gh-token \
    GITHUB_TOKEN=fixture-github-token \
    COPILOT_GITHUB_TOKEN=fixture-copilot-token \
    COPILOT_PROXY_GITHUB_TOKEN=fixture-proxy-token \
    GH_ENTERPRISE_TOKEN=fixture-enterprise-token \
    GITHUB_ENTERPRISE_TOKEN=fixture-github-enterprise-token \
    COPILOT_TOKEN=fixture-copilot-only-token \
    "$install_root/bin/fmx" "$@"
}

# ===========================================================================
# 1. Package shape and static validity.
# ===========================================================================

for script in "$launcher" "$installer" "$uninstaller" "$worker_helper" \
  "$prerequisite_helper"; do
  [[ -f "$script" && -x "$script" && ! -L "$script" ]] \
    || fail "package script is missing or not executable: $script"
  bash -n "$script" || fail "package script has a syntax error: $script"
done
assert_contains 'runtime_operation_lock="$runtime_parent/.fmx-install.lock"' \
  "$prerequisite_helper"
assert_contains 'acquire_runtime_operation_lock' "$prerequisite_helper"
assert_contains 'install_lock="$runtime_parent/.fmx-install.lock"' "$uninstaller"
[[ -f "$root/README.md" ]] || fail 'README.md is missing'
[[ -f "$root/catalog.json" ]] || fail 'catalog.json is missing'
[[ -f "$root/policies/pstack-workers.md" ]] || fail 'the pstack worker policy is missing'
[[ -f "$root/prerequisites/manifest.json" ]] \
  || fail 'the prerequisite manifest is missing'
[[ -f "$root/prerequisites/npm/package.json" ]] \
  || fail 'the prerequisite package metadata is missing'
[[ -f "$root/prerequisites/npm/package-lock.json" ]] \
  || fail 'the prerequisite npm lock is missing'
prerequisite_manifest="$root/prerequisites/manifest.json"
prerequisite_package="$root/prerequisites/npm/package.json"
prerequisite_lock="$root/prerequisites/npm/package-lock.json"
jq -e '
  .schemaVersion == 1
  and (.binaries | keys == ["no-mistakes", "treehouse"])
  and .binaries["no-mistakes"].version == "1.60.2"
  and .binaries.treehouse.version == "2.0.1"
  and .npm.minimumNodeMajor == 20
  and .npm.tools == {
    "chrome-devtools-axi": "0.1.33",
    "gh-axi": "0.1.35",
    "lavish-axi": "0.1.63",
    "quota-axi": "0.1.34",
    "tasks-axi": "0.2.5"
  }
  and all(.binaries[].assets[];
    (.archive | test("^[A-Za-z0-9._-]+\\.tar\\.gz$"))
    and (.sha256 | test("^[0-9a-f]{64}$")))
' "$prerequisite_manifest" >/dev/null \
  || fail 'the prerequisite manifest is not the locked supported shape'
jq -e --slurpfile manifest "$prerequisite_manifest" '
  .private == true and .dependencies == $manifest[0].npm.tools
' "$prerequisite_package" >/dev/null \
  || fail 'the prerequisite package metadata differs from the manifest'
jq -e --slurpfile manifest "$prerequisite_manifest" '
  .lockfileVersion == 3
  and .packages[""].dependencies == $manifest[0].npm.tools
' "$prerequisite_lock" >/dev/null \
  || fail 'the prerequisite npm lock differs from the manifest'
assert_not_contains '"resolved":' "$prerequisite_lock"
python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$overlay_tool" \
  || fail 'the overlay tool has a syntax error'

jq -e --arg commit "$pinned_commit" '
  .schemaVersion == 1
  and .source.repository == "https://github.com/kunchenguid/firstmate.git"
  and .source.commit == $commit
  and .source.overlay == $commit
  and (.profiles | keys == ["default", "pstack-workers"])
  and .profiles.default.workerPolicy == null
  and .profiles["pstack-workers"].workerPolicy == "pstack-workers.md"
  and (.profiles.default.taskIdPrefix != .profiles["pstack-workers"].taskIdPrefix)
  and all(.profiles[].headless;
    .prompt == false
    and .outputFormats == ["text"]
    and .resume == false
    and .resumeWithPrompt == false
    and .sessionId == "none"
    and .usage == false
    and .cost == false
    and .modelOverride == false
    and .effortOverride == false
    and .testedHarnessVersion == null)
' "$root/catalog.json" >/dev/null || fail 'the source catalog is not the pinned conservative shape'

manifest="$root/overlay/$pinned_commit/manifest.json"
[[ -f "$manifest" ]] || fail "the pinned overlay manifest is missing: $manifest"
jq -e --arg commit "$pinned_commit" '
  .schemaVersion == 1
  and .commit == $commit
  and (.files | length == 4)
  and ([.files[].path] | sort == [
    ".agents/skills/updatefirstmate/SKILL.md",
    "bin/fm-brief.sh",
    "bin/fm-spawn.sh",
    "bin/fm-update.sh"
  ])
  and all(.files[]; (.base | test("^[0-9a-f]{64}$")) and (.result | test("^[0-9a-f]{64}$")))
' "$manifest" >/dev/null || fail 'the overlay manifest is not the pinned shape'
while IFS= read -r patch_name; do
  [[ -f "$root/overlay/$pinned_commit/$patch_name" ]] \
    || fail "the overlay manifest names a missing patch: $patch_name"
done < <(jq -r '.files[].patch' "$manifest")

# The checked-in fixture must still be the exact pinned upstream source.
while IFS=$'\t' read -r path expected; do
  actual="$(python3 -c '
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
' "$root/tests/fixtures/firstmate/$pinned_commit/$path")"
  [[ "$actual" == "$expected" ]] \
    || fail "the pinned source fixture drifted for $path"
done < <(jq -r '.files[] | [.path, .base] | @tsv' "$manifest")

# The real prerequisite helper must honor both runtime-operation and
# prerequisite-install locks without deleting a competitor's live lock.
helper_runtime_parent="$fixture_root/prerequisite-helper-runtime"
helper_runtime="$helper_runtime_parent/fmx"
helper_operation_lock="$helper_runtime_parent/.fmx-install.lock"
helper_prerequisite_lock="$helper_runtime/prerequisites/.install-lock"
mkdir -p "$helper_runtime/lib" "$helper_runtime/prerequisite-lock/npm" \
  "$helper_runtime/prerequisites"
cp "$prerequisite_helper" "$helper_runtime/lib/fmx-prerequisites"
cp "$root/prerequisites/manifest.json" "$helper_runtime/prerequisite-lock/manifest.json"
cp "$root/prerequisites/npm/package.json" "$helper_runtime/prerequisite-lock/npm/package.json"
cp "$root/prerequisites/npm/package-lock.json" \
  "$helper_runtime/prerequisite-lock/npm/package-lock.json"
printf '%s\n' "$ownership_value" \
  >"$helper_runtime/.managed-by-trellage-firstmate-profiles"
mkdir "$helper_operation_lock"
printf '%s\n' "$install_lock_owner" >"$helper_operation_lock/owner"
printf '%s\n' "$$" >"$helper_operation_lock/pid"
chmod 0600 "$helper_operation_lock/owner" "$helper_operation_lock/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-runtime-lock.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "prerequisite helper with a live runtime lock exited $status instead of 1"
assert_contains "another fmx runtime operation is active with pid $$" \
  "$logs/prerequisite-runtime-lock.err"
[[ "$(<"$helper_operation_lock/owner")" == "$install_lock_owner" \
  && "$(<"$helper_operation_lock/pid")" == "$$" ]] \
  || fail 'prerequisite helper changed a competing runtime lock'
rm "$helper_operation_lock/owner" "$helper_operation_lock/pid"
rmdir "$helper_operation_lock"

mkdir "$helper_prerequisite_lock"
printf '%s\n' "$prerequisite_install_lock_owner" >"$helper_prerequisite_lock/owner"
printf '%s\n' "$$" >"$helper_prerequisite_lock/pid"
chmod 0600 "$helper_prerequisite_lock/owner" "$helper_prerequisite_lock/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-install-lock.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "prerequisite helper with a live install lock exited $status instead of 1"
assert_contains "another prerequisite installation is active with pid $$" \
  "$logs/prerequisite-install-lock.err"
[[ "$(<"$helper_prerequisite_lock/owner")" == "$prerequisite_install_lock_owner" \
  && "$(<"$helper_prerequisite_lock/pid")" == "$$" ]] \
  || fail 'prerequisite helper deleted a competing prerequisite lock'
[[ ! -e "$helper_operation_lock" ]] \
  || fail 'prerequisite helper retained its runtime-operation lock after refusal'
rm "$helper_prerequisite_lock/owner" "$helper_prerequisite_lock/pid"
rmdir "$helper_prerequisite_lock"

mkdir "$helper_prerequisite_lock"
printf '%s\n' "$prerequisite_install_lock_owner" >"$helper_prerequisite_lock/owner"
chmod 0600 "$helper_prerequisite_lock/owner"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-incomplete-lock.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "prerequisite helper with an incomplete lock exited $status instead of 1"
assert_contains 'incomplete prerequisite installation lock' \
  "$logs/prerequisite-incomplete-lock.err"
[[ "$(<"$helper_prerequisite_lock/owner")" == "$prerequisite_install_lock_owner" \
  && ! -e "$helper_prerequisite_lock/pid" ]] \
  || fail 'prerequisite helper changed an incomplete prerequisite lock'
[[ ! -e "$helper_operation_lock" ]] \
  || fail 'incomplete prerequisite lock refusal retained its runtime-operation lock'
rm "$helper_prerequisite_lock/owner"
rmdir "$helper_prerequisite_lock"

status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_PREREQUISITE_TEST_FAIL_AT=after-artifact-recovery \
  "$host_bash" "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-empty-recovery.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "empty prerequisite recovery probe exited $status instead of 1"
assert_contains 'injected failure at after-artifact-recovery' \
  "$logs/prerequisite-empty-recovery.err"
[[ ! -e "$helper_operation_lock" && ! -e "$helper_prerequisite_lock" ]] \
  || fail 'empty prerequisite recovery probe retained a lock'

helper_identity="$(
  env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
    "$host_bash" "$helper_runtime/lib/fmx-prerequisites" identity
)"
[[ "$helper_identity" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'the real prerequisite helper returned an invalid identity'
helper_recovery_identity='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
helper_retired="$helper_runtime/prerequisites/.retired.$helper_recovery_identity.fixture"
helper_stage="$helper_runtime/prerequisites/.stage.$helper_recovery_identity.fixture"
helper_destination="$helper_runtime/prerequisites/$helper_recovery_identity"
mkdir -p "$helper_retired/bin" "$helper_retired/npm/node_modules/.bin" "$helper_stage"
cp "$fake_bin/no-mistakes" "$helper_retired/bin/no-mistakes"
cp "$fake_bin/treehouse" "$helper_retired/bin/treehouse"
for tool in chrome-devtools-axi gh-axi lavish-axi quota-axi tasks-axi; do
  cp "$fake_bin/$tool" "$helper_retired/npm/node_modules/.bin/$tool"
done
chmod 0755 "$helper_retired/bin/no-mistakes" "$helper_retired/bin/treehouse" \
  "$helper_retired/npm/node_modules/.bin/"*
printf '%s\n' "$prerequisite_install_lock_owner" \
  >"$helper_retired/.managed-by-trellage-firstmate-prerequisites"
printf '%s\n' "$helper_recovery_identity" >"$helper_retired/.complete"
printf '{"schemaVersion":1,"identity":"%s"}\n' "$helper_recovery_identity" \
  >"$helper_retired/receipt.json"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_PREREQUISITE_TEST_FAIL_AT=after-artifact-recovery \
  "$host_bash" "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-artifact-recovery.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "prerequisite artifact recovery probe exited $status instead of 1"
assert_contains 'injected failure at after-artifact-recovery' \
  "$logs/prerequisite-artifact-recovery.err"
[[ -d "$helper_destination" \
  && "$(<"$helper_destination/.complete")" == "$helper_recovery_identity" ]] \
  || fail 'prerequisite artifact recovery did not restore the retired toolchain'
[[ ! -e "$helper_retired" && ! -e "$helper_stage" ]] \
  || fail 'prerequisite artifact recovery retained retired or staged state'
[[ ! -e "$helper_operation_lock" && ! -e "$helper_prerequisite_lock" ]] \
  || fail 'prerequisite artifact recovery retained a lock'
rm -rf -- "$helper_destination"
helper_incomplete_profile="$home/.local/share/trellage/profiles/firstmate/helper-incomplete"
mkdir -p "$helper_incomplete_profile/locks/session"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  "$host_bash" "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-incomplete-session.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "prerequisite helper with an incomplete session exited $status instead of 1"
assert_contains 'cannot install shared prerequisites while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/prerequisite-incomplete-session.err"
[[ ! -e "$helper_operation_lock" && ! -e "$helper_prerequisite_lock" ]] \
  || fail 'incomplete-session prerequisite refusal retained a lock'
rm -rf -- "$helper_incomplete_profile"

helper_launch_profile="$home/.local/share/trellage/profiles/firstmate/helper-launch"
helper_launch_lock="$helper_launch_profile/locks/mutation"
mkdir -p "$helper_launch_lock"
printf '%s\n' "$ownership_value" >"$helper_launch_lock/owner"
printf 'launch\n' >"$helper_launch_lock/action"
printf '%s\n' "$$" >"$helper_launch_lock/pid"
chmod 0600 "$helper_launch_lock/owner" "$helper_launch_lock/action" \
  "$helper_launch_lock/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_PREREQUISITE_TEST_FAIL_AT=after-fleet-guard \
  "$host_bash" "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-parent-launch.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "parent-launch prerequisite probe exited $status instead of 1"
assert_contains 'injected failure at after-fleet-guard' \
  "$logs/prerequisite-parent-launch.err"
assert_not_contains 'cannot install shared prerequisites' \
  "$logs/prerequisite-parent-launch.err"
[[ ! -e "$helper_operation_lock" && ! -e "$helper_prerequisite_lock" ]] \
  || fail 'parent-launch prerequisite probe retained a lock'

printf 'setup\n' >"$helper_launch_lock/action"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  "$host_bash" "$helper_runtime/lib/fmx-prerequisites" install \
  >/dev/null 2>"$logs/prerequisite-parent-setup.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "parent-setup prerequisite probe exited $status instead of 1"
assert_contains 'cannot install shared prerequisites while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/prerequisite-parent-setup.err"
[[ ! -e "$helper_operation_lock" && ! -e "$helper_prerequisite_lock" ]] \
  || fail 'parent-setup prerequisite refusal retained a lock'
rm -rf -- "$helper_launch_profile"

# ===========================================================================
# 2. Installation ownership.
# ===========================================================================

status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_INSTALL_TEST_CRASH_AT=during-runtime-publication \
  bash "$mirror_installer" >"$logs/install-crash.out" 2>"$logs/install-crash.err" \
  || status=$?
[[ "$status" == 137 ]] \
  || fail "crashed fresh install exited $status instead of 137"
[[ -d "$install_lock" ]] || fail 'crashed fresh install did not retain its stale lock'
[[ "$(find "$home/.local/share/trellage" -mindepth 1 -maxdepth 1 \
  -name '.fmx-install.*' ! -path "$install_lock" | wc -l | tr -d ' ')" == 1 ]] \
  || fail 'crashed fresh install did not retain one recovery transaction'
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_INSTALL_TEST_FAIL_AT=after-recovery \
  bash "$mirror_installer" >"$logs/install-recovery.out" 2>"$logs/install-recovery.err" \
  || status=$?
[[ "$status" == 1 ]] || fail "fresh install recovery probe exited $status instead of 1"
assert_contains 'injected failure at after-recovery' "$logs/install-recovery.err"
[[ ! -e "$install_root" && ! -L "$install_root" ]] \
  || fail 'fresh crash recovery left a runtime'
[[ ! -e "$command_path" && ! -L "$command_path" ]] \
  || fail 'fresh crash recovery left a command'
[[ ! -e "$install_lock" && ! -L "$install_lock" ]] \
  || fail 'fresh crash recovery left its install lock'
[[ -z "$(find "$home/.local/share/trellage" -mindepth 1 -maxdepth 1 \
  -name '.fmx-install.*' -print -quit 2>/dev/null)" ]] \
  || fail 'fresh crash recovery left a transaction directory'

for signal_spec in HUP:129 INT:130 TERM:143; do
  signal="${signal_spec%%:*}"
  expected_status="${signal_spec#*:}"
  status=0
  env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
    FMX_INSTALL_TEST_SIGNAL_AT=after-runtime-publication \
    FMX_INSTALL_TEST_SIGNAL="$signal" \
    bash "$mirror_installer" \
    >"$logs/install-signal-$signal.out" 2>"$logs/install-signal-$signal.err" \
    || status=$?
  [[ "$status" == "$expected_status" ]] \
    || fail "$signal-interrupted fresh install exited $status instead of $expected_status"
  [[ ! -e "$install_root" && ! -L "$install_root" ]] \
    || fail "$signal-interrupted fresh install published a runtime"
  [[ ! -e "$command_path" && ! -L "$command_path" ]] \
    || fail "$signal-interrupted fresh install published a command"
  [[ ! -e "$install_lock" && ! -L "$install_lock" ]] \
    || fail "$signal-interrupted fresh install left its install lock"
done

command_failure_home="$fixture_root/command-failure-home"
mkdir "$command_failure_home"
status=0
env -i HOME="$command_failure_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_INSTALL_TEST_FAIL_AT=after-command-publication \
  bash "$mirror_installer" \
  >"$logs/install-command-failure.out" 2>"$logs/install-command-failure.err" \
  || status=$?
[[ "$status" == 1 ]] || fail "post-command failure exited $status instead of 1"
assert_contains 'injected failure at after-command-publication' "$logs/install-command-failure.err"
[[ ! -e "$command_failure_home/.local/share/trellage/fmx" \
  && ! -L "$command_failure_home/.local/share/trellage/fmx" ]] \
  || fail 'post-command failure left a fresh runtime'
[[ ! -e "$command_failure_home/.local/bin/fmx" \
  && ! -L "$command_failure_home/.local/bin/fmx" ]] \
  || fail 'post-command failure left a fresh command'
[[ ! -e "$command_failure_home/.local/share/trellage/.fmx-install.lock" ]] \
  || fail 'post-command failure left its install lock'

foreign_command_home="$fixture_root/foreign-command-home"
mkdir -p "$foreign_command_home/.local/bin"
printf 'foreign command\n' >"$foreign_command_home/.local/bin/fmx"
status=0
env -i HOME="$foreign_command_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-foreign-command.err" || status=$?
[[ "$status" == 1 ]] || fail "foreign command install exited $status instead of 1"
assert_contains 'unrelated command' "$logs/install-foreign-command.err"
[[ "$(<"$foreign_command_home/.local/bin/fmx")" == 'foreign command' ]] \
  || fail 'installer changed a foreign command'

canonical_parent="$fixture_root/canonical-home-parent"
linked_parent="$fixture_root/linked-home-parent"
mkdir -p "$canonical_parent/home"
ln -s "$canonical_parent" "$linked_parent"
linked_home="$linked_parent/home"
canonical_linked_home="$canonical_parent/home"
env -i HOME="$linked_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-linked-home.err" \
  || { cat "$logs/install-linked-home.err" >&2; \
       fail 'install through a symlinked HOME ancestor failed'; }
[[ -L "$canonical_linked_home/.local/bin/fmx" \
  && -d "$canonical_linked_home/.local/share/trellage/fmx" ]] \
  || fail 'install through a symlinked HOME ancestor used non-canonical paths'
env -i HOME="$linked_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-linked-home.err" \
  || { cat "$logs/uninstall-linked-home.err" >&2; \
       fail 'uninstall through a symlinked HOME ancestor failed'; }
[[ ! -e "$canonical_linked_home/.local/bin/fmx" \
  && ! -e "$canonical_linked_home/.local/share/trellage/fmx" ]] \
  || fail 'uninstall through a symlinked HOME ancestor left managed paths'

dangling_home="$fixture_root/dangling-command-home"
dangling_runtime="$dangling_home/.local/share/trellage/fmx"
dangling_command="$dangling_home/.local/bin/fmx"
mkdir -p "$dangling_home/.local/bin"
ln -s "$dangling_runtime/bin/fmx" "$dangling_command"
env -i HOME="$dangling_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-dangling-command.err" \
  || { cat "$logs/install-dangling-command.err" >&2; \
       fail 'install did not recover its dangling command symlink'; }
[[ -x "$dangling_runtime/bin/fmx" && -L "$dangling_command" ]] \
  || fail 'install did not make its dangling command usable'
rm -rf -- "$dangling_runtime"
env -i HOME="$dangling_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-dangling-command.err" \
  || { cat "$logs/uninstall-dangling-command.err" >&2; \
       fail 'uninstall did not remove its dangling command symlink'; }
[[ ! -e "$dangling_command" && ! -L "$dangling_command" ]] \
  || fail 'uninstall retained its dangling command symlink'

env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >"$logs/install.out" 2>"$logs/install.err" \
  || { cat "$logs/install.err" >&2; fail 'install failed'; }
assert_contains "Installed fmx at $command_path" "$logs/install.out"
[[ -x "$install_root/bin/fmx" ]] || fail 'the launcher was not installed'
[[ -f "$install_root/catalog.json" ]] || fail 'the catalog was not installed'
[[ -x "$install_root/lib/fmx-worker" ]] || fail 'the worker helper was not installed'
[[ -x "$install_root/lib/fmx-prerequisites" ]] \
  || fail 'the prerequisite helper was not installed'
[[ -x "$install_root/lib/native-claude" ]] || fail 'the shared Claude helper was not installed'
[[ -f "$install_root/lib/trellage-session-bridge.py" ]] \
  || fail 'the session bridge was not installed'
[[ -f "$home/.local/share/trellage/common/floating-skills-runtime/floating-skills.mjs" ]] \
  || fail 'the floating-skills runtime was not installed'
[[ -f "$install_root/overlay/$pinned_commit/manifest.json" ]] \
  || fail 'the pinned overlay was not installed'
[[ -f "$install_root/policies/pstack-workers.md" ]] \
  || fail 'the worker policy was not installed'
[[ -f "$install_root/prerequisite-lock/manifest.json" ]] \
  || fail 'the prerequisite manifest was not installed'
[[ -f "$install_root/prerequisite-lock/npm/package-lock.json" ]] \
  || fail 'the prerequisite npm lock was not installed'
[[ -L "$command_path" && "$(readlink "$command_path")" == "$install_root/bin/fmx" ]] \
  || fail 'the command symlink is wrong'
[[ "$(<"$install_root/.managed-by-trellage-firstmate-profiles")" == "$ownership_value" ]] \
  || fail 'the runtime ownership marker is wrong'
[[ -z "$(find "$home/.local/share/trellage" -mindepth 1 -maxdepth 1 \
  \( -name '.fmx-install.*' -o -name '.fmx-retired-install.*' \) -print -quit)" ]] \
  || fail 'successful install left a runtime transaction artifact'
[[ -z "$(find "$home/.local/bin" -mindepth 1 -maxdepth 1 \
  -name '.fmx-command.*' -print -quit)" ]] \
  || fail 'successful install left a command transaction artifact'

managed_cache="$install_root/prerequisites/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
mkdir -p "$managed_cache/bin" "$managed_cache/npm/node_modules/.bin"
printf 'preserved prerequisite cache\n' >"$managed_cache/bin/tool"
ln -s ../../../bin/tool "$managed_cache/npm/node_modules/.bin/tool"

printf 'foreign runtime path\n' >"$install_root/foreign-path"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-foreign-runtime.err" || status=$?
[[ "$status" == 1 ]] || fail "foreign runtime path install exited $status instead of 1"
assert_contains 'unrelated runtime path' "$logs/install-foreign-runtime.err"
[[ "$(<"$install_root/foreign-path")" == 'foreign runtime path' ]] \
  || fail 'installer changed a foreign runtime path'
rm "$install_root/foreign-path"

active_install_profile="$profiles_root/install-active"
mkdir -p "$active_install_profile/locks/session"
printf '%s\n' "$$" >"$active_install_profile/locks/session/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-active-session.err" || status=$?
[[ "$status" == 1 ]] || fail "active-session install exited $status instead of 1"
assert_contains 'cannot install fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/install-active-session.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'active-session install changed the launcher runtime'
rm -rf -- "$active_install_profile"

incomplete_install_profile="$profiles_root/install-incomplete"
mkdir -p "$incomplete_install_profile/locks/session"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-incomplete-session.err" || status=$?
[[ "$status" == 1 ]] || fail "incomplete-session install exited $status instead of 1"
assert_contains 'cannot install fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/install-incomplete-session.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'incomplete-session install changed the launcher runtime'
rm -rf -- "$incomplete_install_profile"

worker_install_profile="$profiles_root/install-worker-active"
mkdir -p "$worker_install_profile/workers/task"
printf '%s\n' "$$" >"$worker_install_profile/workers/task/.active"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-worker-active.err" || status=$?
[[ "$status" == 1 ]] || fail "active-worker install exited $status instead of 1"
assert_contains 'cannot install fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/install-worker-active.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'active-worker install changed the launcher runtime'
rm -rf -- "$worker_install_profile"

mutation_install_profile="$profiles_root/install-mutation-active"
mkdir -p "$mutation_install_profile/locks/mutation"
printf '%s\n' "$ownership_value" >"$mutation_install_profile/locks/mutation/owner"
printf '%s\n' "$$" >"$mutation_install_profile/locks/mutation/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-mutation-active.err" || status=$?
[[ "$status" == 1 ]] || fail "active-mutation install exited $status instead of 1"
assert_contains 'cannot install fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/install-mutation-active.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'active-mutation install changed the launcher runtime'
rm -rf -- "$mutation_install_profile"

# An active top-level install lock refuses mutation and leaves the old command usable.
mkdir "$install_lock"
printf '%s\n' "$install_lock_owner" >"$install_lock/owner"
printf '%s\n' "$$" >"$install_lock/pid"
chmod 0600 "$install_lock/owner" "$install_lock/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-locked.err" || status=$?
[[ "$status" == 1 ]] || fail "install with an active lock exited $status instead of 1"
assert_contains "another fmx install is active with pid $$" "$logs/install-locked.err"
[[ -x "$install_root/bin/fmx" && -L "$command_path" ]] \
  || fail 'lock refusal changed the installed launcher'
[[ -f "$managed_cache/bin/tool" ]] || fail 'lock refusal changed the prerequisite cache'
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-locked.err" || status=$?
[[ "$status" == 1 ]] || fail "uninstall with an active lock exited $status instead of 1"
assert_contains "another fmx runtime operation is active with pid $$" \
  "$logs/uninstall-locked.err"
[[ -x "$install_root/bin/fmx" && -L "$command_path" ]] \
  || fail 'locked uninstall changed the installed launcher'
rm "$install_lock/owner" "$install_lock/pid"
rmdir "$install_lock"

prerequisite_cache_lock="$install_root/prerequisites/.install-lock"
mkdir "$prerequisite_cache_lock"
printf '%s\n' "$prerequisite_install_lock_owner" >"$prerequisite_cache_lock/owner"
printf '99999999\n' >"$prerequisite_cache_lock/pid"
chmod 0600 "$prerequisite_cache_lock/owner" "$prerequisite_cache_lock/pid"

# A failed replacement restores the complete old runtime and command target.
cat >"$install_root/bin/fmx" <<'LEGACY_FMX'
#!/usr/bin/env bash
printf 'legacy-fmx\n'
LEGACY_FMX
chmod 0755 "$install_root/bin/fmx"
printf 'rollback canary\n' >"$install_root/policies/rollback-canary.md"
[[ "$("$command_path")" == legacy-fmx ]] || fail 'rollback command fixture is not usable'
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_INSTALL_TEST_CRASH_AT=during-runtime-publication \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-existing-crash.err" || status=$?
[[ "$status" == 137 ]] || fail "crashed replacement exited $status instead of 137"
[[ ! -e "$install_root" ]] || fail 'crashed replacement left a live runtime in the retirement window'
[[ -L "$command_path" ]] || fail 'crashed replacement removed the prior command symlink'
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_INSTALL_TEST_FAIL_AT=after-recovery \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-existing-recovery.err" || status=$?
[[ "$status" == 1 ]] || fail "existing recovery probe exited $status instead of 1"
assert_contains 'injected failure at after-recovery' "$logs/install-existing-recovery.err"
[[ "$("$command_path")" == legacy-fmx ]] \
  || fail 'crash recovery did not restore the prior command behavior'
[[ "$(<"$install_root/policies/rollback-canary.md")" == 'rollback canary' ]] \
  || fail 'crash recovery did not restore the prior runtime'
[[ ! -e "$prerequisite_cache_lock" ]] \
  || fail 'reinstall did not reclaim the stale prerequisite lock'
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FMX_INSTALL_TEST_FAIL_AT=after-runtime-publication \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-rollback.err" || status=$?
[[ "$status" == 1 ]] || fail "failed replacement exited $status instead of 1"
assert_contains 'injected failure at after-runtime-publication' "$logs/install-rollback.err"
[[ "$("$command_path")" == legacy-fmx ]] \
  || fail 'failed replacement did not restore the prior command behavior'
[[ "$(<"$install_root/policies/rollback-canary.md")" == 'rollback canary' ]] \
  || fail 'failed replacement did not restore the prior runtime'
[[ -f "$managed_cache/bin/tool" \
  && -L "$managed_cache/npm/node_modules/.bin/tool" \
  && "$(readlink "$managed_cache/npm/node_modules/.bin/tool")" == ../../../bin/tool ]] \
  || fail 'failed replacement did not restore the prerequisite cache'
[[ ! -e "$install_lock" && ! -L "$install_lock" ]] \
  || fail 'failed replacement left its install lock'

# Reinstall over an owned runtime is allowed, removes old managed files, and
# preserves the consent-installed prerequisite cache including npm symlinks.
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>&1 || fail 'reinstall over an owned runtime failed'
[[ ! -e "$install_root/policies/rollback-canary.md" ]] \
  || fail 'successful reinstall retained an obsolete managed policy'
[[ -f "$managed_cache/bin/tool" \
  && -L "$managed_cache/npm/node_modules/.bin/tool" \
  && "$(readlink "$managed_cache/npm/node_modules/.bin/tool")" == ../../../bin/tool ]] \
  || fail 'successful reinstall did not preserve the prerequisite cache'

# A shared-runtime failure rolls back the replacement and keeps the old
# command, runtime, and prerequisite cache usable.
floating_installer="$mirror/scripts/install-floating-skills-runtime.sh"
cp "$floating_installer" "$fixture_root/install-floating-skills-runtime.saved"
cat >"$floating_installer" <<'FAILING_FLOATING_INSTALLER'
#!/usr/bin/env bash
printf 'injected shared-runtime failure\n' >&2
exit 79
FAILING_FLOATING_INSTALLER
chmod 0755 "$floating_installer"
cat >"$install_root/bin/fmx" <<'LEGACY_FMX'
#!/usr/bin/env bash
printf 'shared-failure-fmx\n'
LEGACY_FMX
chmod 0755 "$install_root/bin/fmx"
printf 'shared failure canary\n' >"$install_root/policies/shared-failure-canary.md"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-shared-failure.err" || status=$?
[[ "$status" == 79 ]] || fail "shared-runtime failure exited $status instead of 79"
assert_contains 'injected shared-runtime failure' "$logs/install-shared-failure.err"
[[ "$("$command_path")" == shared-failure-fmx ]] \
  || fail 'shared-runtime failure did not restore the prior command behavior'
[[ "$(<"$install_root/policies/shared-failure-canary.md")" == 'shared failure canary' ]] \
  || fail 'shared-runtime failure did not restore the prior runtime'
[[ -f "$managed_cache/bin/tool" \
  && -L "$managed_cache/npm/node_modules/.bin/tool" ]] \
  || fail 'shared-runtime failure did not restore the prerequisite cache'
[[ ! -e "$install_lock" && ! -L "$install_lock" ]] \
  || fail 'shared-runtime failure left its install lock'
mv "$fixture_root/install-floating-skills-runtime.saved" "$floating_installer"
chmod 0755 "$floating_installer"
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>&1 \
  || fail 'reinstall after the shared-runtime failure failed'
[[ ! -e "$install_root/policies/shared-failure-canary.md" ]] \
  || fail 'reinstall retained the shared-runtime rollback canary'
[[ -f "$managed_cache/bin/tool" \
  && -L "$managed_cache/npm/node_modules/.bin/tool" ]] \
  || fail 'reinstall after shared-runtime failure lost the prerequisite cache'

# An unowned runtime root is refused.
mv "$install_root/.managed-by-trellage-firstmate-profiles" "$install_root/.marker-hidden"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-unowned.err" || status=$?
[[ "$status" == 1 ]] || fail "install into an unowned runtime exited $status instead of 1"
assert_contains 'unowned runtime root' "$logs/install-unowned.err"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-unowned.err" || status=$?
[[ "$status" == 1 ]] || fail "uninstall of an unowned runtime exited $status instead of 1"
assert_contains 'unowned runtime root' "$logs/uninstall-unowned.err"
mv "$install_root/.marker-hidden" "$install_root/.managed-by-trellage-firstmate-profiles"

# The installer refuses when the shared Claude runtime is absent.
mv "$mirror/prototypes/trellage-claude-common/native-claude" "$mirror/native-claude.absent"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>"$logs/install-no-helper.err" || status=$?
[[ "$status" == 1 ]] || fail "install without the shared Claude helper exited $status instead of 1"
assert_contains 'missing shared native Claude helper' "$logs/install-no-helper.err"
mv "$mirror/native-claude.absent" "$mirror/prototypes/trellage-claude-common/native-claude"
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>&1 || fail 'reinstall after the helper returned failed'

# ===========================================================================
# 3. Catalog purity: list --json probes nothing.
# ===========================================================================

pure_bin="$fixture_root/pure-bin"
mkdir -p "$pure_bin"
ln -s "$real_jq" "$pure_bin/jq"
ln -s "$real_bash" "$pure_bin/bash"
# Deliberately absent: git, gh, tmux, herdr, claude, python3, curl.
for tool in env sed grep cat dirname basename; do
  target="$(command -v "$tool" 2>/dev/null || true)"
  if [[ -n "$target" ]]; then
    ln -s "$target" "$pure_bin/$tool"
  fi
done
pure_home="$fixture_root/pure-home"
mkdir -p "$pure_home"
env -i HOME="$pure_home" PATH="$pure_bin" \
  "$install_root/bin/fmx" list --json >"$logs/list.json" 2>"$logs/list.err" \
  || { cat "$logs/list.err" >&2; fail 'list --json failed without host dependencies'; }
jq -e '
  keys == ["harness", "launcher", "profiles", "sandbox", "schemaVersion"]
  and .schemaVersion == 1
  and .launcher == "fmx"
  and .harness == "firstmate"
  and .sandbox == false
  and (.profiles | length == 2)
  and ([.profiles[].name] | sort == ["default", "pstack-workers"])
  and all(.profiles[];
    keys == [
      "description",
      "headless",
      "marketplace",
      "name",
      "plugin",
      "source",
      "standaloneMcps"
    ]
    and .plugin == null
    and .marketplace == null
    and .standaloneMcps == []
    and .source == "kunchenguid/firstmate"
    and .headless.prompt == false
    and .headless.outputFormats == ["text"]
    and .headless.resume == false
    and .headless.resumeWithPrompt == false
    and .headless.sessionId == "none"
    and .headless.usage == false
    and .headless.cost == false
    and .headless.modelOverride == false
    and .headless.effortOverride == false
    and .headless.testedHarnessVersion == null
    and .headless.eventContract == null
    and .headless.trellageEventContract == null)
' "$logs/list.json" >/dev/null || fail 'list --json is not the router generic shape'
# `taskIdPrefix` and `workerPolicy` are source-catalog metadata only.
assert_not_contains 'taskIdPrefix' "$logs/list.json"
assert_not_contains 'workerPolicy' "$logs/list.json"
[[ -z "$(find "$pure_home" -mindepth 1 -print -quit)" ]] \
  || fail 'list --json created state in HOME'
[[ ! -s "$FAKE_GIT_LOG" ]] || fail 'list --json invoked git'
[[ ! -s "$FAKE_GH_LOG" ]] || fail 'list --json invoked gh'

env -i HOME="$pure_home" PATH="$pure_bin" \
  "$install_root/bin/fmx" list >"$logs/list.tsv" 2>&1 || fail 'list failed'
assert_contains 'default' "$logs/list.tsv"
assert_contains 'pstack-workers' "$logs/list.tsv"

# ===========================================================================
# 4. Inventory before setup.
# ===========================================================================

fmx inventory default --json >"$logs/inventory-not-setup.json" \
  || fail 'inventory before setup failed'
jq -e --arg commit "$pinned_commit" '
  .launcher == "fmx"
  and .harness == "firstmate"
  and .profile == "default"
  and .readiness == "not-setup"
  and .source.repository == "https://github.com/kunchenguid/firstmate.git"
  and .source.pinnedCommit == $commit
  and .source.installedCommit == null
  and .source.commitMatchesPin == false
  and .overlay.commit == $commit
  and .overlay.digestAlgorithm == "sha256"
  and (.overlay.manifestDigest | test("^[0-9a-f]{64}$"))
  and (.overlay.contentDigest | test("^[0-9a-f]{64}$"))
  and .overlay.fileCount == 4
  and .overlay.verified == false
  and .session == "none"
  and .workers == []
' "$logs/inventory-not-setup.json" >/dev/null \
  || fail 'inventory did not report not-setup with overlay evidence'

# Inventory during a first setup must report busy, not not-setup: the profile
# is being created, it is not missing.
first_setup_done="$fixture_root/first-setup-done"
rm -f -- "$first_setup_done"
(
  NATIVE_CLAUDE_PREPARE_HOLD=4 fmx setup default >/dev/null 2>&1
  printf 'done\n' >"$first_setup_done"
) &
first_setup_pid=$!
first_mutation_lock="$profiles_root/default/locks/mutation"
for _ in $(seq 1 200); do
  if [[ -f "$first_mutation_lock/pid" ]]; then break; fi
  sleep 0.05
done
[[ -f "$first_mutation_lock/pid" ]] || fail 'the first setup never published a lock'
fmx inventory default --json >"$logs/inventory-first-setup.json" \
  || fail 'inventory failed during a first setup'
jq -e '.readiness == "busy" and .mutation == "active"' \
  "$logs/inventory-first-setup.json" >/dev/null \
  || fail 'inventory during a first setup did not report busy'
wait "$first_setup_pid"
[[ -f "$first_setup_done" ]] || fail 'the first setup did not complete'

# Reset so the fail-closed staging cases below start from a clean profile.
rm -rf -- "$profiles_root/default"
fmx inventory default --json >"$logs/inventory-reset.json" || fail 'inventory failed'
jq -e '.readiness == "not-setup"' "$logs/inventory-reset.json" >/dev/null \
  || fail 'inventory did not report not-setup after a reset'

# ===========================================================================
# 5. Pinned source and overlay integrity are fail-closed.
# ===========================================================================

FAKE_GIT_HEAD='0000000000000000000000000000000000000000'
status=0
fmx setup default >"$logs/setup-wrong-head.out" 2>"$logs/setup-wrong-head.err" || status=$?
[[ "$status" == 1 ]] || fail "setup with a wrong staged HEAD exited $status instead of 1"
assert_contains 'does not match the pinned commit' "$logs/setup-wrong-head.err"
[[ ! -d "$profiles_root/default/runtime" ]] \
  || fail 'a runtime was published despite a source-pin mismatch'
FAKE_GIT_HEAD=''

FAKE_GIT_TAMPER_FILE='bin/fm-brief.sh'
status=0
fmx setup default >"$logs/setup-tampered.out" 2>"$logs/setup-tampered.err" || status=$?
[[ "$status" == 1 ]] || fail "setup with a tampered source exited $status instead of 1"
assert_contains 'pinned source mismatch' "$logs/setup-tampered.err"
[[ ! -d "$profiles_root/default/runtime" ]] \
  || fail 'a runtime was published despite a patch base mismatch'
FAKE_GIT_TAMPER_FILE=''

# A staged checkout that is unclean in a way the digests cannot see must be
# rejected BEFORE it can become the live runtime.
FAKE_GIT_STAGE_EXTRA='bin/fm-stowaway.sh'
status=0
fmx setup default >/dev/null 2>"$logs/setup-dirty-stage.err" || status=$?
[[ "$status" == 1 ]] || fail "setup with an unclean stage exited $status instead of 1"
assert_contains 'staged Firstmate checkout is not clean' "$logs/setup-dirty-stage.err"
[[ ! -d "$profiles_root/default/runtime" ]] \
  || fail 'an unclean staged checkout was published'
FAKE_GIT_STAGE_EXTRA=''

FAKE_GIT_FETCH_STATUS=1
status=0
fmx setup default >/dev/null 2>"$logs/setup-no-commit.err" || status=$?
[[ "$status" == 1 ]] || fail "setup with an unavailable commit exited $status instead of 1"
assert_contains 'is not available from' "$logs/setup-no-commit.err"
FAKE_GIT_FETCH_STATUS=0

# ===========================================================================
# 6. Setup, both profiles.
# ===========================================================================

fmx setup --all >"$logs/setup.out" 2>"$logs/setup.err" \
  || { cat "$logs/setup.err" >&2; fail 'setup --all failed'; }
assert_contains 'fmx setup default: ready' "$logs/setup.out"
assert_contains 'fmx setup pstack-workers: ready' "$logs/setup.out"
[[ "$(grep -c ': ready' "$logs/setup.out")" -eq 2 ]] \
  || fail 'setup --all did not run every selected profile'
for profile in default pstack-workers; do
  [[ ! -e "$profiles_root/$profile/locks/mutation" ]] \
    || fail "setup --all left the $profile mutation lock behind"
done

expected_tasks_config='backend = "markdown"

[markdown]
path = "data/backlog.md"
archive = "data/done-archive.md"
done_keep = 10'

for profile in default pstack-workers; do
  profile_root="$profiles_root/$profile"
  [[ -f "$profile_root/.managed-by-trellage-firstmate-profiles" ]] \
    || fail "the $profile ownership marker is missing"
  [[ -x "$profile_root/runtime/bin/fm-spawn.sh" ]] \
    || fail "the $profile runtime was not published"
  [[ -f "$profile_root/home/.fmx-managed" ]] \
    || fail "the $profile managed-runtime marker is missing"
  [[ -d "$profile_root/home/state" && -d "$profile_root/home/data" ]] \
    || fail "the $profile Firstmate home was not seeded"
  cmp -s "$profile_root/home/.tasks.toml" <(printf '%s\n' "$expected_tasks_config") \
    || fail "the $profile managed tasks-axi config differs from Firstmate"
  [[ -d "$profile_root/captain/claude" ]] \
    || fail "the $profile captain Claude home is missing"
  for name in crew-harness secondmate-harness; do
    [[ -f "$profile_root/home/config/$name" && ! -L "$profile_root/home/config/$name" ]] \
      || fail "the $profile managed $name file is missing"
    [[ "$(cat "$profile_root/home/config/$name")" == 'claude' ]] \
      || fail "the $profile managed $name file is not exactly claude"
    [[ "$(wc -c <"$profile_root/home/config/$name" | tr -d '[:space:]')" == 7 ]] \
      || fail "the $profile managed $name file is not exactly 7 bytes"
  done
  [[ ! -e "$profile_root/home/config/crew-dispatch.json" ]] \
    || fail "the $profile home has a crew dispatch profile"
  [[ ! -e "$profile_root/staging" ]] || fail "the $profile staging area was not cleaned up"
  [[ ! -e "$profile_root/runtime.previous" ]] \
    || fail "the $profile retired runtime was not cleaned up"
  jq -e --arg commit "$pinned_commit" \
    '.commit == $commit and .overlay == $commit
     and .repository == "https://github.com/kunchenguid/firstmate.git"' \
    "$profile_root/receipts/source.json" >/dev/null \
    || fail "the $profile receipt does not record the catalog pin"
done

# The overlay actually landed in the published runtime.
assert_contains 'FMX_WORKER_POLICY_FILE' "$profiles_root/default/runtime/bin/fm-brief.sh"
assert_contains 'FMX_WORKER_LAUNCHER' "$profiles_root/default/runtime/bin/fm-spawn.sh"
assert_contains 'fmx update' "$profiles_root/default/runtime/bin/fm-update.sh"
assert_contains 'Trellage `fmx` runtimes' \
  "$profiles_root/default/runtime/.agents/skills/updatefirstmate/SKILL.md"

# Only the pstack profile carries a worker policy, and the profiles are separate.
[[ -f "$profiles_root/pstack-workers/policy/worker-policy.md" ]] \
  || fail 'the pstack worker policy was not installed into the profile'
[[ ! -e "$profiles_root/default/policy" ]] \
  || fail 'the default profile installed a worker policy'
assert_contains 'smallest logical change' \
  "$profiles_root/pstack-workers/policy/worker-policy.md"
for forbidden in 'poteto' 'Poteto' 'subagent' 'multi-frontier'; do
  assert_not_contains "$forbidden" "$profiles_root/pstack-workers/policy/worker-policy.md"
done

# GitHub tokens never reach gh, even during setup.
assert_contains 'GH_TOKEN=unset|GITHUB_TOKEN=unset|COPILOT_GITHUB_TOKEN=unset|COPILOT_PROXY_GITHUB_TOKEN=unset|GH_ENTERPRISE_TOKEN=unset|GITHUB_ENTERPRISE_TOKEN=unset|COPILOT_TOKEN=unset' \
  "$FAKE_GH_LOG"
# No token value may appear anywhere in what gh actually saw.
for secret in fixture-gh-token fixture-github-token fixture-copilot-token \
  fixture-proxy-token fixture-enterprise-token fixture-github-enterprise-token \
  fixture-copilot-only-token; do
  assert_not_contains "$secret" "$FAKE_GH_LOG"
done

# The captain home is prepared with the bridge enabled, and each profile names
# itself: the shared runtime validates the exact per-profile bridge hook, so a
# missing or wrong --profile would check the default profile's hook instead.
for profile in default pstack-workers; do
  grep -F "prepare|home=$profiles_root/$profile/captain/claude" "$NATIVE_CLAUDE_LOG" \
    | grep -Fq "bridge=enabled|profile=$profile" \
    || fail "the $profile captain home was not prepared with its own profile name"
done
# No captain home is ever prepared under another profile's name.
grep -F "prepare|home=$profiles_root/pstack-workers/captain/claude" "$NATIVE_CLAUDE_LOG" \
  | grep -Fq 'profile=default' \
  && fail 'the pstack-workers captain home was prepared under the default profile'
:

# ===========================================================================
# 7. Doctor, inventory, and update --check.
# ===========================================================================

: >"$NATIVE_CLAUDE_LOG"
fmx doctor default >"$logs/doctor.out" 2>"$logs/doctor.err" \
  || { cat "$logs/doctor.err" >&2; fail 'doctor failed after setup'; }
assert_contains 'fmx doctor default: OK' "$logs/doctor.out"
grep -F "doctor|home=$profiles_root/default/captain/claude" "$NATIVE_CLAUDE_LOG" \
  | grep -Fq 'bridge=enabled|profile=default' \
  || fail 'doctor did not name the default profile to the shared runtime'

: >"$NATIVE_CLAUDE_LOG"
fmx doctor pstack-workers >"$logs/doctor-pstack.out" 2>"$logs/doctor-pstack.err" \
  || { cat "$logs/doctor-pstack.err" >&2; fail 'doctor failed for pstack-workers'; }
assert_contains 'fmx doctor pstack-workers: OK' "$logs/doctor-pstack.out"
grep -F "doctor|home=$profiles_root/pstack-workers/captain/claude" "$NATIVE_CLAUDE_LOG" \
  | grep -Fq 'bridge=enabled|profile=pstack-workers' \
  || fail 'doctor did not name the pstack-workers profile to the shared runtime'
assert_not_contains 'profile=default' "$NATIVE_CLAUDE_LOG"

fmx inventory default --json >"$logs/inventory-healthy.json" || fail 'inventory failed'
jq -e --arg commit "$pinned_commit" '
  .readiness == "healthy"
  and .source.installedCommit == $commit
  and .source.pinnedCommit == $commit
  and .source.commitMatchesPin == true
  and .overlay.commit == $commit
  and .overlay.verified == true
  and .overlay.fileCount == 4
  and .session == "none"
' "$logs/inventory-healthy.json" >/dev/null || fail 'inventory did not report healthy'

# The overlay identity must be reproducible from the checked-in manifest, and
# must be identical for both profiles installed from the same pin.
expected_manifest_digest="$(python3 -c '
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
' "$manifest")"
expected_content_digest="$(jq -r '.files | sort_by(.path)[] | "\(.path):\(.result)"' "$manifest" \
  | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
jq -e --arg manifestDigest "$expected_manifest_digest" \
  --arg contentDigest "$expected_content_digest" '
  .overlay.manifestDigest == $manifestDigest
  and .overlay.contentDigest == $contentDigest
' "$logs/inventory-healthy.json" >/dev/null \
  || fail 'the reported overlay identity is not reproducible from the manifest'
fmx inventory pstack-workers --json >"$logs/inventory-pstack.json" || fail 'inventory failed'
jq -e --arg manifestDigest "$expected_manifest_digest" \
  --arg contentDigest "$expected_content_digest" --arg commit "$pinned_commit" '
  .readiness == "healthy"
  and .overlay.manifestDigest == $manifestDigest
  and .overlay.contentDigest == $contentDigest
  and .overlay.verified == true
  and .source.installedCommit == $commit
' "$logs/inventory-pstack.json" >/dev/null \
  || fail 'the second profile did not report the same overlay identity'

# Inventory verifies that no mutating generation changed across its complete
# snapshot. Force a publication while the first doctor pass is held; inventory
# must discard that pass and retry against the new generation.
: >"$NATIVE_CLAUDE_LOG"
NATIVE_CLAUDE_DOCTOR_HOLD=2 \
  fmx inventory default --json >"$logs/inventory-generation-race.json" \
  2>"$logs/inventory-generation-race.err" &
inventory_race_pid=$!
for _ in $(seq 1 200); do
  grep -Fq "doctor|home=$profiles_root/default/captain/claude" \
    "$NATIVE_CLAUDE_LOG" && break
  sleep 0.01
done
grep -Fq "doctor|home=$profiles_root/default/captain/claude" \
  "$NATIVE_CLAUDE_LOG" \
  || fail 'inventory did not reach the held doctor pass'
jq '.commit = "7777777777777777777777777777777777777777"' \
  "$profiles_root/default/receipts/source.json" >"$fixture_root/receipt.generation-race"
mv "$fixture_root/receipt.generation-race" \
  "$profiles_root/default/receipts/source.json"
fmx update default >/dev/null 2>"$logs/update-generation-race.err" \
  || { cat "$logs/update-generation-race.err" >&2; fail 'race publication failed'; }
wait "$inventory_race_pid" \
  || { cat "$logs/inventory-generation-race.err" >&2; fail 'inventory race probe failed'; }
[[ "$(grep -Fc "doctor|home=$profiles_root/default/captain/claude" \
  "$NATIVE_CLAUDE_LOG")" -ge 2 ]] \
  || fail 'inventory did not retry after the mutation generation changed'
jq -e --arg commit "$pinned_commit" '
  .readiness == "healthy"
  and .source.installedCommit == $commit
  and .source.commitMatchesPin == true
' "$logs/inventory-generation-race.json" >/dev/null \
  || fail 'inventory did not return a coherent post-publication snapshot'

: >"$FAKE_GIT_LOG"
fmx update --check --all >"$logs/update-check.out" 2>&1 || fail 'update --check failed'
[[ ! -s "$FAKE_GIT_LOG" ]] || fail 'update --check touched git at all'
assert_contains 'fmx update: default is current' "$logs/update-check.out"
assert_contains 'fmx update: pstack-workers is current' "$logs/update-check.out"
[[ "$(grep -c '^fmx update:' "$logs/update-check.out")" -eq 2 ]] \
  || fail 'update --check --all did not report every selected profile'
fmx update --all >"$logs/update-all.out" 2>&1 || fail 'update --all failed'
[[ "$(grep -c '^fmx update:' "$logs/update-all.out")" -eq 2 ]] \
  || fail 'update --all did not run every selected profile'
for profile in default pstack-workers; do
  [[ ! -e "$profiles_root/$profile/locks/mutation" ]] \
    || fail "update --all left the $profile mutation lock behind"
done

: >"$FAKE_GIT_LOG"
fmx update default >"$logs/update-current.out" 2>&1 || fail 'update on a current profile failed'
assert_contains 'fmx update: default is current' "$logs/update-current.out"
assert_not_contains 'fetch' "$FAKE_GIT_LOG"
assert_contains 'status --porcelain --untracked-files=all' "$FAKE_GIT_LOG"

# An unclean stage must not replace a healthy live runtime either.
FAKE_GIT_STAGE_EXTRA='bin/fm-stowaway.sh'
cp "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.clean"
jq '.commit = "4444444444444444444444444444444444444444"' \
  "$fixture_root/receipt.clean" >"$profiles_root/default/receipts/source.json"
status=0
fmx update default >/dev/null 2>"$logs/update-dirty-stage.err" || status=$?
[[ "$status" == 1 ]] || fail "update with an unclean stage exited $status instead of 1"
assert_contains 'staged Firstmate checkout is not clean' "$logs/update-dirty-stage.err"
[[ ! -e "$profiles_root/default/runtime/bin/fm-stowaway.sh" ]] \
  || fail 'an unclean staged checkout replaced the live runtime'
[[ -x "$profiles_root/default/runtime/bin/fm-spawn.sh" ]] \
  || fail 'the live runtime was disturbed by an unclean stage'
FAKE_GIT_STAGE_EXTRA=''
cp "$fixture_root/receipt.clean" "$profiles_root/default/receipts/source.json"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after an unclean stage was refused'

# A stale receipt is what makes update act; only the catalog pin is installed.
stale_receipt="$profiles_root/default/receipts/source.json"
jq '.commit = "1111111111111111111111111111111111111111"' "$stale_receipt" \
  >"$stale_receipt.tmp" && mv "$stale_receipt.tmp" "$stale_receipt"
fmx inventory default --json >"$logs/inventory-stale.json" || fail 'inventory failed'
jq -e --arg commit "$pinned_commit" '
  .source.installedCommit == "1111111111111111111111111111111111111111"
  and .source.pinnedCommit == $commit
  and .source.commitMatchesPin == false
  and .overlay.verified == true
' "$logs/inventory-stale.json" >/dev/null \
  || fail 'inventory did not expose a receipt that differs from the pin'
fmx update --check default >"$logs/update-check-stale.out" 2>&1 \
  || fail 'update --check on a stale profile failed'
assert_contains 'is stale (installed 111111111111, catalog pin 4ad8cbaeafc1' \
  "$logs/update-check-stale.out"
fmx update default >"$logs/update-stale.out" 2>&1 || fail 'update on a stale profile failed'
assert_contains "fmx update: default 111111111111 -> 4ad8cbaeafc1 installed" \
  "$logs/update-stale.out"
jq -e --arg commit "$pinned_commit" '.commit == $commit' "$stale_receipt" >/dev/null \
  || fail 'update installed something other than the catalog pin'

# Unhealthy is reported, not repaired silently.
mv "$profiles_root/default/home/.fmx-managed" "$profiles_root/default/home/.fmx-managed.away"
fmx inventory default --json >"$logs/inventory-unhealthy.json" || fail 'inventory failed'
jq -e '.readiness == "unhealthy"' "$logs/inventory-unhealthy.json" >/dev/null \
  || fail 'inventory did not report unhealthy'
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-unhealthy.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor on a broken profile exited $status instead of 1"
assert_contains 'managed-runtime marker is missing' "$logs/doctor-unhealthy.err"
mv "$profiles_root/default/home/.fmx-managed.away" "$profiles_root/default/home/.fmx-managed"

# A runtime edited behind fmx's back is detected by the overlay digests.
printf '# drift\n' >>"$profiles_root/default/runtime/bin/fm-brief.sh"
fmx inventory default --json >"$logs/inventory-drift.json" || fail 'inventory failed'
jq -e '.readiness == "unhealthy" and .overlay.verified == false' \
  "$logs/inventory-drift.json" >/dev/null \
  || fail 'inventory did not expose an unverified overlay after runtime drift'
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-drift.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor on a drifted runtime exited $status instead of 1"
assert_contains 'does not match the pinned overlay' "$logs/doctor-drift.err"
fmx repair default >"$logs/repair.out" 2>"$logs/repair.err" \
  || { cat "$logs/repair.err" >&2; fail 'repair failed'; }
assert_contains 'fmx repair default: restored' "$logs/repair.out"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after repair'

# ===========================================================================
# 7b. v1 Claude-only workers: managed FM_HOME configuration.
# ===========================================================================

# Unrelated FM_HOME content must survive every managed write.
mkdir -p "$profiles_root/default/home/config" "$profiles_root/default/home/projects"
printf 'operator note\n' >"$profiles_root/default/home/config/operator-note"
printf 'herdr\n' >"$profiles_root/default/home/config/backend"
printf 'project state\n' >"$profiles_root/default/home/projects/keep-me"
fmx repair default >/dev/null 2>"$logs/repair-preserve.err" \
  || { cat "$logs/repair-preserve.err" >&2; fail 'repair failed'; }
assert_contains 'operator note' "$profiles_root/default/home/config/operator-note"
assert_contains 'herdr' "$profiles_root/default/home/config/backend"
assert_contains 'project state' "$profiles_root/default/home/projects/keep-me"

# The runtime/home split must retain Firstmate's data/backlog.md contract.
# Repair migrates the one legacy path written by older fmx launches and
# restores the managed tasks-axi configuration.
printf '# Backlog\n\n## Done\n' >"$profiles_root/default/home/backlog.md"
rm -f -- "$profiles_root/default/home/data/backlog.md"
printf 'broken\n' >"$profiles_root/default/home/.tasks.toml"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-tasks-config.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a broken tasks-axi config exited $status instead of 1"
assert_contains 'legacy Firstmate backlog remains' "$logs/doctor-tasks-config.err"
fmx repair default >/dev/null 2>"$logs/repair-tasks-config.err" \
  || { cat "$logs/repair-tasks-config.err" >&2; fail 'repair did not migrate the legacy backlog'; }
[[ ! -e "$profiles_root/default/home/backlog.md" ]] \
  || fail 'repair left the legacy root backlog in place'
assert_contains '# Backlog' "$profiles_root/default/home/data/backlog.md"
cmp -s "$profiles_root/default/home/.tasks.toml" <(printf '%s\n' "$expected_tasks_config") \
  || fail 'repair did not restore the managed tasks-axi config'

# A worker harness that is not exactly claude fails doctor and launch.
for broken in 'codex' 'claude extra' 'claude '; do
  for name in crew-harness secondmate-harness; do
    cp "$profiles_root/default/home/config/$name" "$fixture_root/$name.good"
    printf '%s\n' "$broken" >"$profiles_root/default/home/config/$name"
    status=0
    fmx doctor default >/dev/null 2>"$logs/doctor-harness.err" || status=$?
    [[ "$status" == 1 ]] \
      || fail "doctor with $name='$broken' exited $status instead of 1"
    assert_contains "must contain exactly 'claude'" "$logs/doctor-harness.err"
    rm -rf -- "$profiles_root/default/locks/session"
    status=0
    fmx default >/dev/null 2>"$logs/launch-harness.err" || status=$?
    [[ "$status" == 1 ]] \
      || fail "launch with $name='$broken' exited $status instead of 1"
    assert_contains "must contain exactly 'claude'" "$logs/launch-harness.err"
    cp "$fixture_root/$name.good" "$profiles_root/default/home/config/$name"
  done
done

# A symlinked harness file is refused rather than followed.
mv "$profiles_root/default/home/config/crew-harness" "$fixture_root/crew-harness.real"
ln -s "$fixture_root/crew-harness.real" "$profiles_root/default/home/config/crew-harness"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-harness-link.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a symlinked harness file exited $status instead of 1"
assert_contains 'worker harness file is missing' "$logs/doctor-harness-link.err"
rm -- "$profiles_root/default/home/config/crew-harness"
mv "$fixture_root/crew-harness.real" "$profiles_root/default/home/config/crew-harness"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after restoring the harness file'

# A crew dispatch profile can select a non-Claude worker, so its presence
# fails closed for both a regular file and a symlink.
dispatch="$profiles_root/default/home/config/crew-dispatch.json"
printf '{}\n' >"$dispatch"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-dispatch.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a crew dispatch profile exited $status instead of 1"
assert_contains 'refusing to run with a crew dispatch profile' "$logs/doctor-dispatch.err"
rm -rf -- "$profiles_root/default/locks/session"
status=0
fmx default >/dev/null 2>"$logs/launch-dispatch.err" || status=$?
[[ "$status" == 1 ]] || fail "launch with a crew dispatch profile exited $status instead of 1"
assert_contains 'refusing to run with a crew dispatch profile' "$logs/launch-dispatch.err"
fmx inventory default --json >"$logs/inventory-dispatch.json" || fail 'inventory failed'
jq -e '.readiness == "unhealthy"' "$logs/inventory-dispatch.json" >/dev/null \
  || fail 'inventory did not report unhealthy for a crew dispatch profile'
rm -- "$dispatch"
ln -s /dev/null "$dispatch"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-dispatch-link.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "doctor with a symlinked crew dispatch profile exited $status instead of 1"
assert_contains 'refusing to run with a crew dispatch profile' "$logs/doctor-dispatch-link.err"
rm -- "$dispatch"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after removing the dispatch profile'

# ===========================================================================
# 7c. Full-checkout integrity, offline.
# ===========================================================================

# An unrelated tracked file must not be modifiable behind fmx's back.
printf '# unrelated drift\n' >>"$profiles_root/default/runtime/bin/fm-harness.sh" 2>/dev/null \
  || printf '# unrelated drift\n' >>"$profiles_root/default/runtime/README.md"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-tracked-drift.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with an unrelated tracked change exited $status instead of 1"
assert_contains 'unexpected Git changes' "$logs/doctor-tracked-drift.err"
git -C "$profiles_root/default/runtime" checkout -- . 2>/dev/null || true
fmx repair default >/dev/null 2>&1 || fail 'repair failed after tracked drift'
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after repairing tracked drift'

# An untracked file is drift too.
printf 'stowaway\n' >"$profiles_root/default/runtime/bin/fm-extra.sh"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-untracked.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with an untracked runtime file exited $status instead of 1"
assert_contains 'unexpected Git changes' "$logs/doctor-untracked.err"
rm -- "$profiles_root/default/runtime/bin/fm-extra.sh"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after removing the untracked file'

# An IGNORED file is drift too: --untracked-files=all alone would hide it.
printf 'SECRET=1\n' >"$profiles_root/default/runtime/.env"
git -C "$profiles_root/default/runtime" check-ignore -q .env \
  || fail 'the ignored-file fixture is not actually ignored by the pinned repo'
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-ignored.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with an ignored runtime file exited $status instead of 1"
assert_contains 'unexpected Git changes' "$logs/doctor-ignored.err"
rm -- "$profiles_root/default/runtime/.env"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after removing the ignored file'

# A runtime sitting at a different commit is refused.
FAKE_GIT_HEAD='beefbeefbeefbeefbeefbeefbeefbeefbeefbeef'
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-head.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a foreign runtime HEAD exited $status instead of 1"
assert_contains 'not the pinned commit' "$logs/doctor-head.err"
rm -rf -- "$profiles_root/default/locks/session"
status=0
fmx default >/dev/null 2>"$logs/launch-head.err" || status=$?
[[ "$status" == 1 ]] || fail "launch with a foreign runtime HEAD exited $status instead of 1"
assert_contains 'not the pinned commit' "$logs/launch-head.err"
FAKE_GIT_HEAD=''
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after restoring HEAD'

# ===========================================================================
# 7d. Receipt schema.
# ===========================================================================

cp "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.good"
jq '.repository = "https://example.invalid/other.git"' "$fixture_root/receipt.good" \
  >"$profiles_root/default/receipts/source.json"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-receipt.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a foreign receipt repository exited $status instead of 1"
assert_contains 'does not match the catalog pin schema' "$logs/doctor-receipt.err"
jq '.overlay = "0000000000000000000000000000000000000000"' "$fixture_root/receipt.good" \
  >"$profiles_root/default/receipts/source.json"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-receipt-overlay.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a foreign receipt overlay exited $status instead of 1"
assert_contains 'does not match the catalog pin schema' "$logs/doctor-receipt-overlay.err"
jq '. + {extra: 1}' "$fixture_root/receipt.good" \
  >"$profiles_root/default/receipts/source.json"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-receipt-extra.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with an extended receipt exited $status instead of 1"
assert_contains 'does not match the catalog pin schema' "$logs/doctor-receipt-extra.err"
cp "$fixture_root/receipt.good" "$profiles_root/default/receipts/source.json"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after restoring the receipt'

# ===========================================================================
# 7e. GitHub identity is explicit.
# ===========================================================================

no_host_config="$fixture_root/gh-no-host"
mkdir -p "$no_host_config"
printf 'example.com:\n    user: contract\n' >"$no_host_config/hosts.yml"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  GH_CONFIG_DIR="$no_host_config" \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" FAKE_GIT_LOG="$FAKE_GIT_LOG" \
  FAKE_GH_LOG="$FAKE_GH_LOG" \
  "$install_root/bin/fmx" doctor default >/dev/null 2>"$logs/doctor-gh-host.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor without a github.com host exited $status instead of 1"
assert_contains 'has no github.com entry' "$logs/doctor-gh-host.err"

: >"$FAKE_GH_LOG"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed'
assert_contains 'auth status --hostname github.com' "$FAKE_GH_LOG"
assert_contains 'GH_TOKEN=unset|GITHUB_TOKEN=unset|COPILOT_GITHUB_TOKEN=unset|COPILOT_PROXY_GITHUB_TOKEN=unset|GH_ENTERPRISE_TOKEN=unset|GITHUB_ENTERPRISE_TOKEN=unset|COPILOT_TOKEN=unset' \
  "$FAKE_GH_LOG"
# No token value may appear anywhere in what gh actually saw.
for secret in fixture-gh-token fixture-github-token fixture-copilot-token \
  fixture-proxy-token fixture-enterprise-token fixture-github-enterprise-token \
  fixture-copilot-only-token; do
  assert_not_contains "$secret" "$FAKE_GH_LOG"
done

# gh's own resolution order is honored: GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh,
# then $HOME/.config/gh.
xdg_root="$fixture_root/xdg"
mkdir -p "$xdg_root/gh"
cat >"$xdg_root/gh/hosts.yml" <<'HOSTS'
github.com:
    user: xdg-contract
    oauth_token: xdg-fixture
HOSTS
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
rm -rf -- "$profiles_root/default/locks/session"
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  XDG_CONFIG_HOME="$xdg_root" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" default >/dev/null 2>"$logs/launch-xdg.err" \
  || { cat "$logs/launch-xdg.err" >&2; fail 'launch failed with an XDG gh configuration'; }
assert_contains "GH_CONFIG_DIR=$xdg_root/gh" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "FMX_GH_CONFIG_DIR=$xdg_root/gh" "$NATIVE_CLAUDE_LAUNCH_LOG"

# GH_CONFIG_DIR still wins over XDG_CONFIG_HOME.
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
rm -rf -- "$profiles_root/default/locks/session"
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  XDG_CONFIG_HOME="$xdg_root" GH_CONFIG_DIR="$gh_config" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" default >/dev/null 2>&1 \
  || fail 'launch failed with GH_CONFIG_DIR set alongside XDG_CONFIG_HOME'
assert_contains "GH_CONFIG_DIR=$gh_config" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_not_contains "GH_CONFIG_DIR=$xdg_root/gh" "$NATIVE_CLAUDE_LAUNCH_LOG"
rm -rf -- "$profiles_root/default/locks/session"

# Launch runs the full authenticated check, not only a config-existence test.
: >"$FAKE_GH_LOG"
rm -rf -- "$profiles_root/default/locks/session"
FAKE_GH_STATUS=1
status=0
fmx default >/dev/null 2>"$logs/launch-gh-status.err" || status=$?
[[ "$status" == 1 ]] || fail "launch with an unauthenticated gh exited $status instead of 1"
assert_contains 'gh is not authenticated for github.com' "$logs/launch-gh-status.err"
assert_contains 'auth status --hostname github.com' "$FAKE_GH_LOG"
FAKE_GH_STATUS=0

# ===========================================================================
# 7h. Managed-path safety, marker content, and policy integrity.
# ===========================================================================

# A redirected managed subdirectory must not be traversed, even though the
# profile-root chain itself is intact.
for managed in home receipts; do
  mv "$profiles_root/default/$managed" "$fixture_root/$managed.real"
  ln -s "$fixture_root/$managed.real" "$profiles_root/default/$managed"
  status=0
  fmx doctor default >/dev/null 2>"$logs/doctor-link-$managed.err" || status=$?
  [[ "$status" == 1 ]] || fail "doctor with a symlinked $managed exited $status instead of 1"
  assert_contains 'unsafe managed path (symlink)' "$logs/doctor-link-$managed.err"
  rm -rf -- "$profiles_root/default/locks/session"
  status=0
  fmx default >/dev/null 2>"$logs/launch-link-$managed.err" || status=$?
  [[ "$status" == 1 ]] || fail "launch with a symlinked $managed exited $status instead of 1"
  assert_contains 'unsafe managed path (symlink)' "$logs/launch-link-$managed.err"
  status=0
  fmx inventory default --json >/dev/null 2>"$logs/inventory-link-$managed.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "inventory with a symlinked $managed exited $status instead of 1"
  assert_contains 'unsafe managed path (symlink)' "$logs/inventory-link-$managed.err"
  rm -- "$profiles_root/default/$managed"
  mv "$fixture_root/$managed.real" "$profiles_root/default/$managed"
done
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after restoring managed paths'

# A managed subdirectory that resolves outside the profile root is refused.
mv "$profiles_root/default/policy" "$fixture_root/policy.real" 2>/dev/null || true
if [[ -d "$fixture_root/policy.real" ]]; then
  mv "$fixture_root/policy.real" "$profiles_root/default/policy"
fi

# The managed-runtime marker is verified by exact content, not existence.
printf 'managed-by=%s\n' "$ownership_value" >"$profiles_root/default/home/.fmx-managed"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-marker-short.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a truncated marker exited $status instead of 1"
assert_contains 'managed-runtime marker content differs' "$logs/doctor-marker-short.err"
printf 'managed-by=%s\nprofile=pstack-workers\n' "$ownership_value" \
  >"$profiles_root/default/home/.fmx-managed"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-marker-profile.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a foreign marker profile exited $status instead of 1"
assert_contains 'managed-runtime marker content differs' "$logs/doctor-marker-profile.err"
printf 'managed-by=%s\nprofile=default\n\n' "$ownership_value" \
  >"$profiles_root/default/home/.fmx-managed"
status=0
fmx doctor default >/dev/null 2>"$logs/doctor-marker-trailing.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with trailing marker data exited $status instead of 1"
assert_contains 'managed-runtime marker content differs' "$logs/doctor-marker-trailing.err"
fmx repair default >/dev/null 2>&1 || fail 'repair failed after marker corruption'
[[ "$(cat "$profiles_root/default/home/.fmx-managed")" \
  == "managed-by=$ownership_value
profile=default" ]] || fail 'repair did not restore the exact marker content'

# The installed worker policy must be byte-identical to the Trellage source and
# within the fixed bound.
policy_installed="$profiles_root/pstack-workers/policy/worker-policy.md"
cp "$policy_installed" "$fixture_root/policy.good"
printf '\nsneaky addition\n' >>"$policy_installed"
status=0
fmx doctor pstack-workers >/dev/null 2>"$logs/doctor-policy-modified.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with a modified policy exited $status instead of 1"
assert_contains 'differs from the Trellage-owned source' "$logs/doctor-policy-modified.err"
fmx inventory pstack-workers --json >"$logs/inventory-policy.json" || fail 'inventory failed'
jq -e '.readiness == "unhealthy"' "$logs/inventory-policy.json" >/dev/null \
  || fail 'inventory did not report a modified policy as unhealthy'
rm -rf -- "$profiles_root/pstack-workers/locks/session"
status=0
fmx pstack-workers >/dev/null 2>"$logs/launch-policy-modified.err" || status=$?
[[ "$status" == 1 ]] || fail "launch with a modified policy exited $status instead of 1"
assert_contains 'differs from the Trellage-owned source' "$logs/launch-policy-modified.err"

python3 -c '
import sys
sys.stdout.write("x" * 20000 + "\n")
' >"$policy_installed"
status=0
fmx doctor pstack-workers >/dev/null 2>"$logs/doctor-policy-oversize.err" || status=$?
[[ "$status" == 1 ]] || fail "doctor with an oversized policy exited $status instead of 1"
assert_contains 'must be between 1 and 16384 bytes' "$logs/doctor-policy-oversize.err"
cp "$fixture_root/policy.good" "$policy_installed"
fmx doctor pstack-workers >/dev/null 2>&1 || fail 'doctor failed after restoring the policy'

# ===========================================================================
# 7f. Per-profile mutation lock.
# ===========================================================================

sleep 300 &
busy_pid=$!
mutation_lock="$profiles_root/default/locks/mutation"
mkdir -p "$mutation_lock"
printf '%s\n' "$ownership_value" >"$mutation_lock/owner"
printf '%s\n' "$busy_pid" >"$mutation_lock/pid"
for command_name in setup repair update; do
  status=0
  fmx "$command_name" default >/dev/null 2>"$logs/$command_name-locked.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "$command_name during a live mutation exited $status instead of 1"
  assert_contains 'another fmx mutation is already running' "$logs/$command_name-locked.err"
done
status=0
fmx default >/dev/null 2>"$logs/launch-mutation-locked.err" || status=$?
[[ "$status" == 1 ]] || fail "launch during a live mutation exited $status instead of 1"
assert_contains 'another fmx mutation is already running' "$logs/launch-mutation-locked.err"
fmx inventory default --json >"$logs/inventory-mutating.json" || fail 'inventory failed'
jq -e '.readiness == "busy" and .mutation == "active" and .session == "none"' \
  "$logs/inventory-mutating.json" >/dev/null \
  || fail 'inventory did not report a live mutation as busy'
[[ -x "$profiles_root/default/runtime/bin/fm-spawn.sh" ]] \
  || fail 'a refused mutation disturbed the runtime'
kill -TERM "$busy_pid" 2>/dev/null || true
wait "$busy_pid" 2>/dev/null || true
busy_pid=''

# An INCOMPLETE lock is exactly what a competitor looks like between creating
# the directory and publishing its pid. It must never be auto-reclaimed.
for shape in empty owner-only bad-pid; do
  rm -rf -- "$mutation_lock"
  mkdir -p "$mutation_lock"
  case "$shape" in
    owner-only) printf '%s\n' "$ownership_value" >"$mutation_lock/owner" ;;
    bad-pid)
      printf '%s\n' "$ownership_value" >"$mutation_lock/owner"
      printf 'not-a-pid\n' >"$mutation_lock/pid"
      ;;
  esac
  for command_name in setup repair update; do
    status=0
    fmx "$command_name" default >/dev/null 2>"$logs/$command_name-$shape.err" || status=$?
    [[ "$status" == 1 ]] \
      || fail "$command_name against an $shape lock exited $status instead of 1"
    assert_contains 'incomplete mutation lock' "$logs/$command_name-$shape.err"
  done
  status=0
  fmx default >/dev/null 2>"$logs/launch-mutation-$shape.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "launch against an $shape mutation lock exited $status instead of 1"
  assert_contains 'incomplete mutation lock' "$logs/launch-mutation-$shape.err"
  [[ -d "$mutation_lock" ]] || fail "an $shape lock was auto-reclaimed"
  fmx inventory default --json >"$logs/inventory-$shape.json" || fail 'inventory failed'
  jq -e '.readiness == "busy" and .mutation == "incomplete"' \
    "$logs/inventory-$shape.json" >/dev/null \
    || fail "inventory did not report an $shape lock as busy"
done
rm -rf -- "$mutation_lock"

# A terminating signal releases the lock and stops the operation. It must not
# resume execution after the cleanup trap.
status=0
NATIVE_CLAUDE_PREPARE_SIGNAL_PARENT=TERM \
  fmx repair default >"$logs/repair-signal.out" 2>"$logs/repair-signal.err" \
  || status=$?
[[ "$status" == 143 ]] \
  || fail "a TERM-interrupted repair exited $status instead of 143"
assert_not_contains 'fmx repair default: restored' "$logs/repair-signal.out"
[[ ! -e "$mutation_lock" ]] \
  || fail 'a TERM-interrupted repair did not release its mutation lock'
fmx doctor default >/dev/null 2>&1 \
  || fail 'doctor failed after a TERM-interrupted repair'

# The same rule for the captain session lock.
for shape in empty owner-only bad-pid; do
  rm -rf -- "$profiles_root/default/locks/session"
  mkdir -p "$profiles_root/default/locks/session"
  case "$shape" in
    owner-only)
      printf '%s\n' "$ownership_value" >"$profiles_root/default/locks/session/owner" ;;
    bad-pid)
      printf '%s\n' "$ownership_value" >"$profiles_root/default/locks/session/owner"
      printf '0\n' >"$profiles_root/default/locks/session/pid"
      ;;
  esac
  status=0
  fmx default >/dev/null 2>"$logs/launch-session-$shape.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "launch against an $shape session lock exited $status instead of 1"
  assert_contains 'captain session lock' "$logs/launch-session-$shape.err"
  assert_contains 'incomplete' "$logs/launch-session-$shape.err"
  status=0
  fmx repair default >/dev/null 2>"$logs/repair-session-$shape.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "repair against an $shape session lock exited $status instead of 1"
  assert_contains 'captain session lock' "$logs/repair-session-$shape.err"
  [[ -d "$profiles_root/default/locks/session" ]] \
    || fail "an $shape session lock was auto-reclaimed"
done
rm -rf -- "$profiles_root/default/locks/session"

# Synchronized concurrency: the first process is stalled while it holds a
# complete lock, and no second mutation may enter.
mutation_first="$fixture_root/mutation-first"
rm -f -- "$mutation_first"
(
  NATIVE_CLAUDE_PREPARE_HOLD=4 fmx repair default >/dev/null 2>&1
  printf 'done\n' >"$mutation_first"
) &
first_pid=$!
for _ in $(seq 1 200); do
  if [[ -f "$mutation_lock/owner" && -f "$mutation_lock/pid" ]]; then break; fi
  sleep 0.05
done
[[ -f "$mutation_lock/owner" ]] || fail 'the first mutation never published a lock'
for command_name in setup repair update; do
  status=0
  fmx "$command_name" default >/dev/null 2>"$logs/$command_name-concurrent.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "a concurrent $command_name exited $status instead of 1"
  assert_contains 'another fmx mutation is already running' \
    "$logs/$command_name-concurrent.err"
done
fmx inventory default --json >"$logs/inventory-concurrent.json" || fail 'inventory failed'
jq -e '.readiness == "busy" and .mutation == "active"' \
  "$logs/inventory-concurrent.json" >/dev/null \
  || fail 'inventory did not report a concurrent mutation as busy'
wait "$first_pid"
[[ -f "$mutation_first" ]] || fail 'the first mutation did not complete'
[[ ! -e "$mutation_lock" ]] || fail 'the first mutation did not release its lock'

# A stale owned lock is reclaimed; an unowned one is never touched.
mkdir -p "$mutation_lock"
printf '%s\n' "$ownership_value" >"$mutation_lock/owner"
printf '999999\n' >"$mutation_lock/pid"
fmx inventory default --json >"$logs/inventory-stale-lock.json" || fail 'inventory failed'
jq -e '.mutation == "stale" and .readiness == "healthy"' \
  "$logs/inventory-stale-lock.json" >/dev/null \
  || fail 'inventory did not report a stale mutation lock'
fmx repair default >/dev/null 2>"$logs/repair-stale-lock.err" \
  || { cat "$logs/repair-stale-lock.err" >&2; fail 'repair did not reclaim a stale owned lock'; }
[[ ! -e "$mutation_lock" ]] || fail 'the mutation lock was not released'

mkdir -p "$mutation_lock"
printf 'someone-else\n' >"$mutation_lock/owner"
printf '999999\n' >"$mutation_lock/pid"
status=0
fmx repair default >/dev/null 2>"$logs/repair-foreign-lock.err" || status=$?
[[ "$status" == 1 ]] || fail "repair against an unowned lock exited $status instead of 1"
assert_contains 'an unowned lock directory exists' "$logs/repair-foreign-lock.err"
[[ -f "$mutation_lock/owner" ]] || fail 'an unowned lock directory was removed'
rm -rf -- "$mutation_lock"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after the lock tests'

# ===========================================================================
# 7g. Publication rollback.
# ===========================================================================

publish_bin="$fixture_root/publish-bin"
mkdir -p "$publish_bin"
for entry in "$fake_bin"/*; do
  if [[ "$(basename "$entry")" == mv ]]; then continue; fi
  ln -s "$entry" "$publish_bin/$(basename "$entry")"
done
cat >"$publish_bin/mv" <<FAKE_MV
#!/usr/bin/env bash
real_mv="$(command -v mv)"
for argument in "\$@"; do
  case "\$argument" in
    */staging/firstmate) exit 79 ;;
  esac
done
exec "\$real_mv" "\$@"
FAKE_MV
chmod 0755 "$publish_bin/mv"

printf 'sentinel\n' >"$profiles_root/default/runtime/.fmx-rollback-sentinel"
jq '.commit = "2222222222222222222222222222222222222222"' \
  "$profiles_root/default/receipts/source.json" >"$fixture_root/receipt.stale"
cp "$fixture_root/receipt.stale" "$profiles_root/default/receipts/source.json"
status=0
env -i HOME="$home" PATH="$publish_bin" GH_CONFIG_DIR="$gh_config" \
  TMPDIR="${TMPDIR:-/tmp}" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  FAKE_GIT_SOURCE_TREE="$FAKE_GIT_SOURCE_TREE" FAKE_GIT_FETCH_STATUS=0 \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" update default >/dev/null 2>"$logs/update-rollback.err" || status=$?
[[ "$status" == 1 ]] || fail "a failed publication exited $status instead of 1"
assert_contains 'previously installed runtime and receipt were restored' "$logs/update-rollback.err"
[[ -f "$profiles_root/default/runtime/.fmx-rollback-sentinel" ]] \
  || fail 'the previous runtime was not restored after a failed publication'
[[ ! -e "$profiles_root/default/runtime.previous" ]] \
  || fail 'a retired runtime was left behind after rollback'
rm -- "$profiles_root/default/runtime/.fmx-rollback-sentinel"
fmx update default >/dev/null 2>&1 || fail 'update failed after a rollback'
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after a rollback'

# The receipt is part of the same transaction: a failed receipt publication
# restores both the previous runtime and the previous receipt.
receipt_bin="$fixture_root/receipt-bin"
mkdir -p "$receipt_bin"
for entry in "$fake_bin"/*; do
  if [[ "$(basename "$entry")" == mv ]]; then continue; fi
  ln -s "$entry" "$receipt_bin/$(basename "$entry")"
done
cat >"$receipt_bin/mv" <<FAKE_MV
#!/usr/bin/env bash
real_mv="$(command -v mv)"
# Fail the first PUBLICATION of the receipt only, so the rollback that
# restores the previous receipt is allowed to succeed.
destination="\${@: -1}"
case "\$destination" in
  */receipts/source.json)
    if [[ ! -e "\$FAKE_MV_ONCE" ]]; then
      : >"\$FAKE_MV_ONCE"
      exit 79
    fi
    ;;
esac
exec "\$real_mv" "\$@"
FAKE_MV
chmod 0755 "$receipt_bin/mv"

printf 'sentinel\n' >"$profiles_root/default/runtime/.fmx-receipt-sentinel"
cp "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.before"
jq '.commit = "3333333333333333333333333333333333333333"' \
  "$fixture_root/receipt.before" >"$profiles_root/default/receipts/source.json"
cp "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.stale-before"
status=0
env -i HOME="$home" PATH="$receipt_bin" GH_CONFIG_DIR="$gh_config" \
  TMPDIR="${TMPDIR:-/tmp}" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  FAKE_GIT_SOURCE_TREE="$FAKE_GIT_SOURCE_TREE" FAKE_GIT_FETCH_STATUS=0 \
  FAKE_MV_ONCE="$fixture_root/receipt-mv-failed" \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" update default >/dev/null 2>"$logs/receipt-rollback.err" || status=$?
[[ "$status" == 1 ]] || fail "a failed receipt publication exited $status instead of 1"
assert_contains 'the staged receipt' "$logs/receipt-rollback.err"
assert_contains 'were restored' "$logs/receipt-rollback.err"
[[ -f "$profiles_root/default/runtime/.fmx-receipt-sentinel" ]] \
  || fail 'the previous runtime was not restored after a failed receipt publication'
cmp -s "$fixture_root/receipt.stale-before" "$profiles_root/default/receipts/source.json" \
  || fail 'the previous receipt was not restored after a failed receipt publication'
[[ ! -e "$profiles_root/default/receipts.previous.json" ]] \
  || fail 'a retired receipt was left behind after rollback'
rm -- "$profiles_root/default/runtime/.fmx-receipt-sentinel"
fmx update default >/dev/null 2>&1 || fail 'update failed after a receipt rollback'
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after a receipt rollback'

# Retiring the old receipt happens before the live runtime moves. If receipt
# retirement fails, both live paths must remain unchanged.
retire_receipt_bin="$fixture_root/retire-receipt-bin"
mkdir -p "$retire_receipt_bin"
for entry in "$fake_bin"/*; do
  if [[ "$(basename "$entry")" == mv ]]; then continue; fi
  ln -s "$entry" "$retire_receipt_bin/$(basename "$entry")"
done
cat >"$retire_receipt_bin/mv" <<FAKE_MV
#!/usr/bin/env bash
real_mv="$(command -v mv)"
destination="\${@: -1}"
case "\$destination" in
  */receipts.previous.json) exit 79 ;;
esac
exec "\$real_mv" "\$@"
FAKE_MV
chmod 0755 "$retire_receipt_bin/mv"

printf 'sentinel\n' >"$profiles_root/default/runtime/.fmx-retire-receipt-sentinel"
cp "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.retire-before"
jq '.commit = "4444444444444444444444444444444444444444"' \
  "$fixture_root/receipt.retire-before" >"$profiles_root/default/receipts/source.json"
cp "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.retire-stale"
status=0
env -i HOME="$home" PATH="$retire_receipt_bin" GH_CONFIG_DIR="$gh_config" \
  TMPDIR="${TMPDIR:-/tmp}" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  FAKE_GIT_SOURCE_TREE="$FAKE_GIT_SOURCE_TREE" FAKE_GIT_FETCH_STATUS=0 \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" update default \
  >/dev/null 2>"$logs/receipt-retirement.err" || status=$?
[[ "$status" == 1 ]] || fail "a failed receipt retirement exited $status instead of 1"
assert_contains 'runtime and receipt were left unchanged' "$logs/receipt-retirement.err"
[[ -f "$profiles_root/default/runtime/.fmx-retire-receipt-sentinel" ]] \
  || fail 'receipt retirement failure moved the live runtime'
cmp -s "$fixture_root/receipt.retire-stale" \
  "$profiles_root/default/receipts/source.json" \
  || fail 'receipt retirement failure changed the live receipt'
[[ ! -e "$profiles_root/default/runtime.previous" ]] \
  || fail 'receipt retirement failure left a retired runtime'
rm -- "$profiles_root/default/runtime/.fmx-retire-receipt-sentinel"
fmx update default >/dev/null 2>&1 || fail 'update failed after a receipt retirement failure'
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after a receipt retirement failure'

# Lifecycle-gated readers recover the crash window after receipt retirement.
mv "$profiles_root/default/receipts/source.json" \
  "$profiles_root/default/receipts.previous.json"
fmx doctor default >/dev/null 2>"$logs/doctor-recover-receipt.err" \
  || { cat "$logs/doctor-recover-receipt.err" >&2; fail 'doctor did not recover a retired receipt'; }
[[ -f "$profiles_root/default/receipts/source.json" ]] \
  || fail 'doctor did not restore the retired receipt'
[[ ! -e "$profiles_root/default/receipts.previous.json" ]] \
  || fail 'doctor left the recovered receipt retired'

# The later crash window has a newly published live runtime and both old items
# preserved. Recovery discards the incomplete new pair and restores the old one.
mv "$profiles_root/default/runtime" "$profiles_root/default/runtime.previous"
cp -R "$profiles_root/default/runtime.previous" "$profiles_root/default/runtime"
printf 'incomplete\n' >"$profiles_root/default/runtime/.fmx-incomplete-publication"
mv "$profiles_root/default/receipts/source.json" \
  "$profiles_root/default/receipts.previous.json"
fmx doctor default >/dev/null 2>"$logs/doctor-recover-pair.err" \
  || { cat "$logs/doctor-recover-pair.err" >&2; fail 'doctor did not recover an incomplete live pair'; }
[[ ! -e "$profiles_root/default/runtime/.fmx-incomplete-publication" ]] \
  || fail 'doctor kept the incompletely published runtime'
[[ ! -e "$profiles_root/default/runtime.previous" ]] \
  || fail 'doctor left the recovered runtime retired'
[[ ! -e "$profiles_root/default/receipts.previous.json" ]] \
  || fail 'doctor left the recovered receipt retired'

# A singleton preserved runtime is restored to its live path, after which
# repair can replace the still-incomplete profile normally.
mv "$profiles_root/default/runtime" "$profiles_root/default/runtime.previous"
mv "$profiles_root/default/receipts/source.json" \
  "$fixture_root/receipt.singleton-runtime-away"
fmx repair default >/dev/null 2>"$logs/repair-singleton-runtime.err" \
  || { cat "$logs/repair-singleton-runtime.err" >&2; fail 'repair did not recover a singleton runtime'; }
[[ ! -e "$profiles_root/default/runtime.previous" ]] \
  || fail 'repair left the singleton runtime retired'
fmx doctor default >/dev/null 2>&1 \
  || fail 'doctor failed after singleton runtime recovery'

# The symmetric singleton receipt state is also recoverable.
mv "$profiles_root/default/runtime" "$fixture_root/runtime.singleton-receipt-away"
mv "$profiles_root/default/receipts/source.json" \
  "$profiles_root/default/receipts.previous.json"
fmx repair default >/dev/null 2>"$logs/repair-singleton-receipt.err" \
  || { cat "$logs/repair-singleton-receipt.err" >&2; fail 'repair did not recover a singleton receipt'; }
[[ ! -e "$profiles_root/default/receipts.previous.json" ]] \
  || fail 'repair left the singleton receipt retired'
fmx doctor default >/dev/null 2>&1 \
  || fail 'doctor failed after singleton receipt recovery'

# A preserved previous runtime is restored, never discarded, when the live
# runtime is absent. Publication is then made to fail, so the preserved copy is
# the only thing that can save the profile: it must still be there afterwards.
mv "$profiles_root/default/runtime" "$profiles_root/default/runtime.previous"
printf 'preserved\n' >"$profiles_root/default/runtime.previous/.fmx-preserved-sentinel"
jq '.commit = "5555555555555555555555555555555555555555"' \
  "$profiles_root/default/receipts/source.json" >"$fixture_root/receipt.preserve"
cp "$fixture_root/receipt.preserve" "$profiles_root/default/receipts/source.json"
status=0
env -i HOME="$home" PATH="$publish_bin" GH_CONFIG_DIR="$gh_config" \
  TMPDIR="${TMPDIR:-/tmp}" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  FAKE_GIT_SOURCE_TREE="$FAKE_GIT_SOURCE_TREE" FAKE_GIT_FETCH_STATUS=0 \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" update default \
  >/dev/null 2>"$logs/update-preserved.err" || status=$?
[[ "$status" == 1 ]] || fail "a failed publication over a preserved runtime exited $status"
[[ -f "$profiles_root/default/runtime/.fmx-preserved-sentinel" ]] \
  || fail 'the only preserved runtime was discarded instead of restored'
rm -- "$profiles_root/default/runtime/.fmx-preserved-sentinel"
fmx repair default >/dev/null 2>"$logs/repair-preserved.err" \
  || { cat "$logs/repair-preserved.err" >&2; fail 'repair could not recover after preservation'; }
[[ ! -e "$profiles_root/default/runtime.previous" ]] \
  || fail 'a preserved runtime was left behind after recovery'
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after preserved-runtime recovery'

# ===========================================================================
# 8. Launch: offline, isolated, token-free.
# ===========================================================================

: >"$FAKE_GIT_LOG"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
fmx default --resume-nothing >"$logs/launch1.out" 2>"$logs/launch1.err" \
  || { cat "$logs/launch1.err" >&2; fail 'launch failed'; }
rm -rf -- "$profiles_root/default/locks/session"
fmx default >"$logs/launch2.out" 2>"$logs/launch2.err" \
  || { cat "$logs/launch2.err" >&2; fail 'repeat launch failed'; }
assert_not_contains 'fetch' "$FAKE_GIT_LOG"
assert_contains 'rev-parse HEAD' "$FAKE_GIT_LOG"
[[ "$(wc -l <"$NATIVE_CLAUDE_LAUNCH_LOG")" -eq 2 ]] || fail 'launch did not run twice'

assert_contains "FM_HOME=$profiles_root/default/home" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "FM_ROOT_OVERRIDE=$profiles_root/default/runtime" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FM_BACKEND=tmux' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "FMX_WORKER_LAUNCHER=$install_root/lib/fmx-worker" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_TASK_ID_PREFIX=fmd' "$NATIVE_CLAUDE_LAUNCH_LOG"
# The captain publishes its validated HOME, PATH, and absolute Bash interpreter
# for every worker pane.
assert_contains "FMX_WORKER_HOME=$home" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "FMX_WORKER_PATH=$fake_bin" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "FMX_WORKER_BASH=$host_bash" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'TASKS_AXI_BACKEND=markdown' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "TASKS_AXI_FILE=$profiles_root/default/home/data/backlog.md" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'ANTHROPIC_BASE_URL=http://127.0.0.1:8080' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'GH_TOKEN=unset|GITHUB_TOKEN=unset|COPILOT_GITHUB_TOKEN=unset' \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "cwd=$profiles_root/default/runtime" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "home=$profiles_root/default/captain/claude|bridge=enabled|profile=default" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'args=--resume-nothing' "$NATIVE_CLAUDE_LAUNCH_LOG"

# A first launch with missing Firstmate-specific tools names the exact managed
# destination and changes nothing until the user gives explicit consent.
managed_tool_backup="$fixture_root/managed-tool-backup"
mkdir -p "$managed_tool_backup"
for tool in no-mistakes treehouse gh-axi chrome-devtools-axi lavish-axi \
  tasks-axi quota-axi; do
  mv "$fake_bin/$tool" "$managed_tool_backup/$tool"
done
managed_identity='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
managed_destination="$install_root/prerequisites/$managed_identity"
rm -rf -- "$install_root/prerequisites"
rm -rf -- "$profiles_root/default/locks/session"
: >"$FAKE_PREREQUISITE_LOG"
fmx doctor default >"$logs/prerequisite-doctor.out" \
  2>"$logs/prerequisite-doctor.err" \
  || fail 'doctor failed instead of reporting missing fleet prerequisites'
assert_contains 'fmx doctor default: OK' "$logs/prerequisite-doctor.out"
assert_contains 'fleet prerequisites incomplete' "$logs/prerequisite-doctor.err"
assert_contains 'managed by fmx after consent:' "$logs/prerequisite-doctor.err"
assert_contains 'no-mistakes' "$logs/prerequisite-doctor.err"
[[ ! -s "$FAKE_PREREQUISITE_LOG" ]] \
  || fail 'doctor attempted to install prerequisites'
status=0
printf 'n\n' | fmx default >"$logs/prerequisite-decline.out" \
  2>"$logs/prerequisite-decline.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "declined prerequisite installation exited $status instead of 1"
assert_contains 'Firstmate needs managed tools' "$logs/prerequisite-decline.err"
assert_contains "$managed_destination" "$logs/prerequisite-decline.err"
assert_contains 'no global npm packages or global agent hooks will be installed' \
  "$logs/prerequisite-decline.err"
assert_contains 'prerequisite installation declined' "$logs/prerequisite-decline.err"
[[ ! -s "$FAKE_PREREQUISITE_LOG" ]] \
  || fail 'declining prerequisite installation still invoked the installer'
[[ ! -e "$managed_destination" ]] \
  || fail 'declining prerequisite installation created the toolchain'
[[ ! -e "$profiles_root/default/locks/mutation" ]] \
  || fail 'declining prerequisite installation left the mutation lock'
[[ ! -e "$profiles_root/default/locks/session" ]] \
  || fail 'declining prerequisite installation acquired a session lock'

# Consent runs the installer once, scrubs provider credentials, re-runs the
# source-of-truth bootstrap check, and forwards the managed PATH to the fleet.
rm -rf -- "$profiles_root/default/locks/session"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
printf 'yes\n' | FAKE_EXPECT_LAUNCH_MUTATION_PROFILE=default \
  fmx default >"$logs/prerequisite-install.out" \
  2>"$logs/prerequisite-install.err" \
  || { cat "$logs/prerequisite-install.err" >&2; fail 'consented prerequisite installation failed'; }
assert_contains 'Installed Firstmate prerequisites' "$logs/prerequisite-install.out"
assert_contains "destination=$managed_destination" "$FAKE_PREREQUISITE_LOG"
assert_contains 'GH_TOKEN=unset|GITHUB_TOKEN=unset|COPILOT_GITHUB_TOKEN=unset|COPILOT_PROXY_GITHUB_TOKEN=unset' \
  "$FAKE_PREREQUISITE_LOG"
assert_contains "FMX_WORKER_PATH=$managed_destination/bin:$managed_destination/npm/node_modules/.bin:$fake_bin" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
[[ -f "$managed_destination/.complete" ]] \
  || fail 'the consented prerequisite install did not publish its completion marker'

# The next launch detects the managed toolchain and neither prompts nor installs
# again.
rm -rf -- "$profiles_root/default/locks/session"
install_count_before="$(wc -l <"$FAKE_PREREQUISITE_LOG" | tr -d '[:space:]')"
fmx default </dev/null >"$logs/prerequisite-repeat.out" \
  2>"$logs/prerequisite-repeat.err" \
  || { cat "$logs/prerequisite-repeat.err" >&2; fail 'repeat launch with managed prerequisites failed'; }
install_count_after="$(wc -l <"$FAKE_PREREQUISITE_LOG" | tr -d '[:space:]')"
[[ "$install_count_after" == "$install_count_before" ]] \
  || fail 'repeat launch reinstalled an already-ready prerequisite toolchain'
assert_not_contains 'Install these prerequisites now?' "$logs/prerequisite-repeat.err"

rm -rf -- "$profiles_root/default/locks/session"
rm -rf -- "$install_root/prerequisites"
for tool in no-mistakes treehouse gh-axi chrome-devtools-axi lavish-axi \
  tasks-axi quota-axi; do
  mv "$managed_tool_backup/$tool" "$fake_bin/$tool"
done

# A shell can remain attached to a retired profile runtime after an atomic
# repair or update. The launcher must recover before Node-based prerequisite
# probes or the Claude helper observe the deleted working directory.
deleted_cwd_parent="$fixture_root/deleted-cwd"
deleted_cwd="$deleted_cwd_parent/gone"
mkdir -p "$deleted_cwd"
rm -rf -- "$profiles_root/pstack-workers/locks/session"
(
  cd "$deleted_cwd"
  rmdir "$deleted_cwd"
  fmx pstack-workers >"$logs/deleted-cwd-launch.out" \
    2>"$logs/deleted-cwd-launch.err"
) || {
  cat "$logs/deleted-cwd-launch.err" >&2
  fail 'launch from a deleted working directory failed'
}
assert_contains "current working directory no longer exists; continuing from $home" \
  "$logs/deleted-cwd-launch.err"
assert_not_contains 'Firstmate needs managed tools' "$logs/deleted-cwd-launch.err"
rm -rf -- "$profiles_root/pstack-workers/locks/session"
rmdir "$deleted_cwd_parent"

# The two profiles never share a captain home, a Firstmate home, or a task
# namespace.
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
rm -rf -- "$profiles_root/pstack-workers/locks/session"
fmx pstack-workers >/dev/null 2>"$logs/launch-pstack.err" \
  || { cat "$logs/launch-pstack.err" >&2; fail 'pstack-workers launch failed'; }
assert_contains "FM_HOME=$profiles_root/pstack-workers/home" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "home=$profiles_root/pstack-workers/captain/claude|bridge=enabled|profile=pstack-workers" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
# The pstack-workers captain must never be launched under the default profile's
# bridge-hook identity.
assert_not_contains 'profile=default' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_TASK_ID_PREFIX=fmp' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "FMX_WORKER_POLICY_FILE=$profiles_root/pstack-workers/policy/worker-policy.md" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"

# Herdr is chosen only from a real pane identity.
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
rm -rf -- "$profiles_root/default/locks/session"
TEST_HERDR_ENV=1 TEST_HERDR_PANE=pane-captain fmx default >/dev/null 2>&1 \
  || fail 'launch inside a Herdr pane failed'
assert_contains 'FM_BACKEND=herdr' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_CAPTAIN_PANE_ID=pane-captain' "$NATIVE_CLAUDE_LAUNCH_LOG"

: >"$NATIVE_CLAUDE_LAUNCH_LOG"
rm -rf -- "$profiles_root/default/locks/session"
TEST_HERDR_ENV=1 TEST_HERDR_PANE='' fmx default >/dev/null 2>&1 \
  || fail 'launch with an empty Herdr pane id failed'
assert_contains 'FM_BACKEND=tmux' "$NATIVE_CLAUDE_LAUNCH_LOG"

# Without tmux and without a Herdr pane there is no backend at all.
no_tmux_bin="$fixture_root/no-tmux-bin"
mkdir -p "$no_tmux_bin"
for entry in "$fake_bin"/*; do
  if [[ "$(basename "$entry")" == tmux ]]; then continue; fi
  ln -s "$entry" "$no_tmux_bin/$(basename "$entry")"
done
rm -rf -- "$profiles_root/default/locks/session"
status=0
env -i HOME="$home" PATH="$no_tmux_bin" GH_CONFIG_DIR="$gh_config" \
  TMPDIR="${TMPDIR:-/tmp}" NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  "$install_root/bin/fmx" default >/dev/null 2>"$logs/launch-no-backend.err" || status=$?
[[ "$status" == 1 ]] || fail "launch without a backend exited $status instead of 1"
assert_contains 'MISSING: tmux' "$logs/launch-no-backend.err"
assert_contains 'Firstmate cannot dispatch workers' "$logs/launch-no-backend.err"

# A launch never repairs a profile that is not set up.
status=0
fmx not-a-profile >/dev/null 2>"$logs/launch-unknown.err" || status=$?
[[ "$status" == 1 ]] || fail "launch of an unknown profile exited $status instead of 1"
assert_contains 'unknown profile: not-a-profile' "$logs/launch-unknown.err"

# ===========================================================================
# 8b. Captain session acquisition is atomic.
# ===========================================================================

# Two concurrent launches must not both reach the shared runtime.
rm -rf -- "$profiles_root/default/locks/session"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
concurrent_status="$fixture_root/concurrent-status"
rm -rf -- "$concurrent_status"
mkdir -p "$concurrent_status"
# The winner holds the session open, exactly as a real captain would; without
# that the losers would legitimately reclaim an already-finished session.
concurrent_gate="$fixture_root/concurrent-gate"
rm -f -- "$concurrent_gate"
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  (
    # Spin on a gate so every attempt reaches acquisition at once, which is
    # what makes a check-then-act or mkdir-then-write claim visibly fail.
    while [[ ! -e "$concurrent_gate" ]]; do :; done
    status=0
    NATIVE_CLAUDE_LAUNCH_HOLD=3 fmx default \
      >/dev/null 2>"$logs/concurrent-$attempt.err" || status=$?
    printf '%s\n' "$status" >"$concurrent_status/$attempt"
  ) &
done
sleep 0.5
: >"$concurrent_gate"
wait
launched="$(grep -c '^launch|' "$NATIVE_CLAUDE_LAUNCH_LOG" || true)"
[[ "$launched" -eq 1 ]] \
  || fail "concurrent launches reached the shared runtime $launched times instead of once"
succeeded=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if [[ "$(cat "$concurrent_status/$attempt")" == 0 ]]; then
    succeeded=$((succeeded + 1))
  else
    grep -Eq 'fmx mutation|mutation lock|captain session' \
      "$logs/concurrent-$attempt.err" \
      || fail "concurrent launch $attempt did not fail at a lifecycle lock"
  fi
done
[[ "$succeeded" -eq 1 ]] \
  || fail "$succeeded concurrent launches reported success instead of one"

# Concurrency is timing-dependent, so the structural guarantee is asserted
# directly too: a lock directory must never be published empty and then filled.
installed_launcher="$install_root/bin/fmx"
# mkdir is the exclusive-creation arbiter and never replaces anything;
# rename(2) is reserved for reclaiming an unambiguously stale lock, because it
# WOULD replace an empty competitor directory.
assert_contains 'mkdir "$session_lock" 2>/dev/null' "$installed_launcher"
assert_contains 'mkdir "$mutation_lock" 2>/dev/null' "$installed_launcher"
assert_not_contains 'atomic_rename "$stage" "$session_lock"' "$installed_launcher"
assert_not_contains 'atomic_rename "$stage" "$mutation_lock"' "$installed_launcher"
assert_contains 'os.rename(sys.argv[1], sys.argv[2])' "$installed_launcher"
for required in owner backend pid; do
  assert_contains "\"$required=" "$installed_launcher"
done

# A stale owned session lock is reclaimed; an unowned one is refused.
rm -rf -- "$profiles_root/default/locks/session"
mkdir -p "$profiles_root/default/locks/session"
printf '%s\n' "$ownership_value" >"$profiles_root/default/locks/session/owner"
printf '999999\n' >"$profiles_root/default/locks/session/pid"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
fmx default >/dev/null 2>"$logs/launch-stale-session.err" \
  || { cat "$logs/launch-stale-session.err" >&2; fail 'launch did not reclaim a stale session lock'; }
[[ "$(grep -c '^launch|' "$NATIVE_CLAUDE_LAUNCH_LOG")" -eq 1 ]] \
  || fail 'a reclaimed stale session lock did not launch exactly once'

rm -rf -- "$profiles_root/default/locks/session"
mkdir -p "$profiles_root/default/locks/session"
printf 'someone-else\n' >"$profiles_root/default/locks/session/owner"
printf '999999\n' >"$profiles_root/default/locks/session/pid"
fmx inventory default --json >"$logs/inventory-foreign-session.json" \
  || fail 'inventory failed for an unowned session lock'
jq -e '.readiness == "busy" and .session == "unowned"' \
  "$logs/inventory-foreign-session.json" >/dev/null \
  || fail 'inventory did not fail closed for an unowned session lock'
status=0
fmx repair default >/dev/null 2>"$logs/repair-foreign-session.err" || status=$?
[[ "$status" == 1 ]] || fail "repair against an unowned session lock exited $status instead of 1"
assert_contains 'captain session lock' "$logs/repair-foreign-session.err"
status=0
fmx default >/dev/null 2>"$logs/launch-foreign-session.err" || status=$?
[[ "$status" == 1 ]] || fail "launch against an unowned session lock exited $status instead of 1"
assert_contains 'captain session lock' "$logs/launch-foreign-session.err"
assert_contains 'unowned' "$logs/launch-foreign-session.err"
[[ -f "$profiles_root/default/locks/session/owner" ]] \
  || fail 'an unowned session lock was removed'
rm -rf -- "$profiles_root/default/locks/session"

# ===========================================================================
# 8c. Profile iteration is fail-fast.
# ===========================================================================

# A failing profile must stop the selection, not continue and report success.
mv "$profiles_root/default/home/.fmx-managed" "$fixture_root/marker.away"
printf 'broken\n' >"$profiles_root/default/home/.fmx-managed"
status=0
fmx repair --all >"$logs/repair-all-broken.out" 2>"$logs/repair-all-broken.err" || status=$?
mv -f "$fixture_root/marker.away" "$profiles_root/default/home/.fmx-managed"
[[ "$status" != 0 ]] || fail 'repair --all reported success despite a failing profile'
fmx repair default >/dev/null 2>&1 || fail 'repair failed while restoring after fail-fast'

# errexit must stay active inside the profile loop: a BARE failing command
# (one with no explicit || die) must abort rather than continue to success.
marker_bin="$fixture_root/marker-bin"
mkdir -p "$marker_bin"
for entry in "$fake_bin"/*; do
  if [[ "$(basename "$entry")" == mv ]]; then continue; fi
  ln -s "$entry" "$marker_bin/$(basename "$entry")"
done
cat >"$marker_bin/mv" <<FAKE_MV
#!/usr/bin/env bash
real_mv="$(command -v mv)"
destination="\${@: -1}"
case "\$destination" in
  */.fmx-managed) exit 79 ;;
esac
exec "\$real_mv" "\$@"
FAKE_MV
chmod 0755 "$marker_bin/mv"
status=0
env -i HOME="$home" PATH="$marker_bin" GH_CONFIG_DIR="$gh_config" \
  TMPDIR="${TMPDIR:-/tmp}" \
  FAKE_GIT_LOG="$FAKE_GIT_LOG" FAKE_GH_LOG="$FAKE_GH_LOG" \
  FAKE_GIT_SOURCE_TREE="$FAKE_GIT_SOURCE_TREE" FAKE_GIT_FETCH_STATUS=0 \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
  "$install_root/bin/fmx" setup default \
  >"$logs/setup-bare-failure.out" 2>"$logs/setup-bare-failure.err" || status=$?
[[ "$status" != 0 ]] \
  || fail 'a bare failing command inside a profile operation was swallowed'
assert_not_contains 'fmx setup default: ready' "$logs/setup-bare-failure.out"
fmx repair default >/dev/null 2>&1 || fail 'repair failed after the bare-failure check'

# ===========================================================================
# 9. Active-fleet refusal and busy inventory.
# ===========================================================================

sleep 300 &
busy_pid=$!
session_lock="$profiles_root/default/locks/session"
mkdir -p "$session_lock"
printf '%s\n' "$ownership_value" >"$session_lock/owner"
printf '%s\n' "$busy_pid" >"$session_lock/pid"
printf 'tmux\n' >"$session_lock/backend"

fmx inventory default --json >"$logs/inventory-busy.json" || fail 'inventory failed'
jq -e '.readiness == "busy" and .session == "active"' "$logs/inventory-busy.json" >/dev/null \
  || fail 'inventory did not report busy'
for command_name in update repair; do
  status=0
  fmx "$command_name" default >/dev/null 2>"$logs/$command_name-busy.err" || status=$?
  [[ "$status" == 1 ]] || fail "$command_name on an active fleet exited $status instead of 1"
  assert_contains "$command_name refused" "$logs/$command_name-busy.err"
done
status=0
fmx default >/dev/null 2>"$logs/launch-busy.err" || status=$?
[[ "$status" == 1 ]] || fail "a second captain launch exited $status instead of 1"
assert_contains 'launch refused' "$logs/launch-busy.err"
assert_contains 'fleet is active' "$logs/launch-busy.err"

# An active worker also blocks update, and a dead worker is reported as stale
# rather than deleted.
kill -TERM "$busy_pid" 2>/dev/null || true
wait "$busy_pid" 2>/dev/null || true
busy_pid=''
rm -rf -- "$session_lock"
sleep 300 &
busy_pid=$!
mkdir -p "$profiles_root/default/workers/fmd-live"
printf '%s\n' "$busy_pid" >"$profiles_root/default/workers/fmd-live/.active"
mkdir -p "$profiles_root/default/workers/fmd-dead"
printf '999999\n' >"$profiles_root/default/workers/fmd-dead/.active"
mkdir -p "$profiles_root/default/workers/fmd-orphan"

fmx inventory default --json >"$logs/inventory-workers.json" || fail 'inventory failed'
jq -e '
  .readiness == "busy"
  and ([.workers[] | select(.task == "fmd-live") | .state] == ["active"])
  and ([.workers[] | select(.task == "fmd-dead") | .state] == ["stale"])
  and ([.workers[] | select(.task == "fmd-orphan") | .state] == ["orphaned"])
' "$logs/inventory-workers.json" >/dev/null \
  || fail 'inventory did not classify worker state'
status=0
fmx update default >/dev/null 2>"$logs/update-workers.err" || status=$?
[[ "$status" == 1 ]] || fail "update with an active worker exited $status instead of 1"
assert_contains 'update refused' "$logs/update-workers.err"

kill -TERM "$busy_pid" 2>/dev/null || true
wait "$busy_pid" 2>/dev/null || true
busy_pid=''
[[ -d "$profiles_root/default/workers/fmd-orphan" ]] \
  || fail 'an orphaned worker home was deleted'
rm -rf -- "$profiles_root/default/workers/fmd-live" \
  "$profiles_root/default/workers/fmd-dead" \
  "$profiles_root/default/workers/fmd-orphan"

# setup checks the fleet unconditionally: a missing receipt must not be a
# licence to replace a runtime under a live captain.
sleep 300 &
busy_pid=$!
active_session="$profiles_root/default/locks/session"
rm -rf -- "$active_session"
mkdir -p "$active_session"
printf '%s\n' "$ownership_value" >"$active_session/owner"
printf 'tmux\n' >"$active_session/backend"
printf '%s\n' "$busy_pid" >"$active_session/pid"
mv "$profiles_root/default/receipts/source.json" "$fixture_root/receipt.hidden"
status=0
fmx setup default >/dev/null 2>"$logs/setup-active-no-receipt.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "setup with no receipt under an active captain exited $status instead of 1"
assert_contains 'setup refused' "$logs/setup-active-no-receipt.err"
[[ -x "$profiles_root/default/runtime/bin/fm-spawn.sh" ]] \
  || fail 'setup replaced a runtime under an active captain'
mv "$fixture_root/receipt.hidden" "$profiles_root/default/receipts/source.json"
kill -TERM "$busy_pid" 2>/dev/null || true
wait "$busy_pid" 2>/dev/null || true
busy_pid=''
rm -rf -- "$active_session"
fmx doctor default >/dev/null 2>&1 || fail 'doctor failed after the setup refusal check'

# ===========================================================================
# 10. Overlay behavior: worker policy insertion.
# ===========================================================================

brief_env() {
  local profile="$1"
  shift
  local profile_root="$profiles_root/$profile"
  local policy=''

  [[ -f "$profile_root/policy/worker-policy.md" ]] \
    && policy="$profile_root/policy/worker-policy.md"
  env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
    FM_HOME="$profile_root/home" \
    FM_ROOT_OVERRIDE="$profile_root/runtime" \
    FMX_WORKER_POLICY_FILE="$policy" \
    FMX_TASK_ID_PREFIX="$(jq -r --arg p "$profile" '.profiles[$p].taskIdPrefix' \
      "$root/catalog.json")" \
    bash "$profile_root/runtime/bin/fm-brief.sh" "$@"
}

brief_env pstack-workers fmp-ship demo/repo --mode direct-PR >/dev/null \
  || fail 'the patched fm-brief.sh could not scaffold a ship brief'
ship_brief="$profiles_root/pstack-workers/home/data/fmp-ship/brief.md"
assert_contains 'smallest logical change' "$ship_brief"
assert_contains '# Worker inner loop' "$ship_brief"
[[ "$(grep -Fxc '# Worker inner loop' "$ship_brief")" == 1 ]] \
  || fail 'the worker policy heading is not present exactly once in a ship brief'
assert_contains '# Project memory' "$ship_brief"

brief_env pstack-workers fmp-scout demo/repo --scout >/dev/null \
  || fail 'the patched fm-brief.sh could not scaffold a scout brief'
scout_brief="$profiles_root/pstack-workers/home/data/fmp-scout/brief.md"
assert_contains '# Worker inner loop' "$scout_brief"
[[ "$(grep -Fxc '# Worker inner loop' "$scout_brief")" == 1 ]] \
  || fail 'the worker policy heading is not present exactly once in a scout brief'

FM_SECONDMATE_CHARTER='own the docs domain' \
  brief_env pstack-workers fmp-second --secondmate demo/repo >/dev/null \
  || fail 'the patched fm-brief.sh could not scaffold a secondmate charter'
charter="$profiles_root/pstack-workers/home/data/fmp-second/brief.md"
assert_contains '# Charter' "$charter"
assert_not_contains '# Worker inner loop' "$charter"

# The default profile leaves the policy unset.
brief_env default fmd-ship demo/repo --mode local-only >/dev/null \
  || fail 'the default profile could not scaffold a ship brief'
default_brief="$profiles_root/default/home/data/fmd-ship/brief.md"
assert_not_contains '# Worker inner loop' "$default_brief"
assert_contains '# Project memory' "$default_brief"

# With no FMX_* variables at all, the overlaid scripts behave like upstream.
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FM_HOME="$profiles_root/default/home" \
  FM_ROOT_OVERRIDE="$profiles_root/default/runtime" \
  bash "$profiles_root/default/runtime/bin/fm-brief.sh" \
  any-unprefixed-id demo/repo --mode direct-PR >/dev/null \
  || fail 'the overlaid fm-brief.sh changed upstream behavior without FMX variables'
assert_not_contains '# Worker inner loop' \
  "$profiles_root/default/home/data/any-unprefixed-id/brief.md"

# Both overlaid shell scripts must still be valid bash, and the fm-spawn.sh
# worker boundary must be inert without FMX_WORKER_LAUNCHER.
bash -n "$profiles_root/default/runtime/bin/fm-spawn.sh" \
  || fail 'the overlaid fm-spawn.sh is not valid bash'
bash -n "$profiles_root/default/runtime/bin/fm-brief.sh" \
  || fail 'the overlaid fm-brief.sh is not valid bash'
bash -n "$profiles_root/default/runtime/bin/fm-update.sh" \
  || fail 'the overlaid fm-update.sh is not valid bash'
assert_contains 'if [ -n "${FMX_WORKER_LAUNCHER:-}" ]; then' \
  "$profiles_root/default/runtime/bin/fm-spawn.sh"
assert_contains '&& [ -z "${FMX_WORKER_LAUNCHER:-}" ]; then' \
  "$profiles_root/default/runtime/bin/fm-spawn.sh"

# Task-id namespaces cannot collide across profiles.
status=0
brief_env pstack-workers fmd-ship demo/repo --mode direct-PR \
  >/dev/null 2>"$logs/brief-prefix.err" || status=$?
[[ "$status" == 1 ]] || fail "a foreign task id exited $status instead of 1"
assert_contains "task ids to start with 'fmp-'" "$logs/brief-prefix.err"

# The byte bound is fixed by the overlay: ambient environment cannot raise it.
oversize_policy="$fixture_root/oversize-policy.md"
python3 -c '
import sys
sys.stdout.write("# Worker inner loop\n" + "x" * 17000 + "\n")
' >"$oversize_policy"
[[ "$(wc -c <"$oversize_policy" | tr -d '[:space:]')" -gt 16384 ]] \
  || fail 'the oversize policy fixture is not larger than the bound'
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FM_HOME="$profiles_root/default/home" \
  FM_ROOT_OVERRIDE="$profiles_root/default/runtime" \
  FMX_WORKER_POLICY_FILE="$oversize_policy" \
  FMX_WORKER_POLICY_MAX_BYTES=100000000 \
  bash "$profiles_root/default/runtime/bin/fm-brief.sh" \
  fmd-oversize demo/repo --mode direct-PR \
  >/dev/null 2>"$logs/brief-oversize.err" || status=$?
[[ "$status" == 1 ]] || fail "an oversize worker policy exited $status instead of 1"
assert_contains 'must be between 1 and 16384 bytes' "$logs/brief-oversize.err"
[[ ! -e "$profiles_root/default/home/data/fmd-oversize/brief.md" ]] \
  || fail 'an oversize worker policy still produced a brief'

# A policy file that is not a bounded regular file fails closed.
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FM_HOME="$profiles_root/default/home" \
  FM_ROOT_OVERRIDE="$profiles_root/default/runtime" \
  FMX_WORKER_POLICY_FILE='relative/policy.md' \
  bash "$profiles_root/default/runtime/bin/fm-brief.sh" fmd-bad demo/repo --mode direct-PR \
  >/dev/null 2>"$logs/brief-bad-policy.err" || status=$?
[[ "$status" == 1 ]] || fail "a relative policy path exited $status instead of 1"
assert_contains 'must be an absolute path' "$logs/brief-bad-policy.err"

# ===========================================================================
# 11. Overlay behavior: the self-update guard.
# ===========================================================================

status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FM_HOME="$profiles_root/default/home" \
  FM_ROOT_OVERRIDE="$profiles_root/default/runtime" \
  bash "$profiles_root/default/runtime/bin/fm-update.sh" \
  >/dev/null 2>"$logs/fm-update.err" || status=$?
[[ "$status" == 1 ]] || fail "the managed self-update exited $status instead of 1"
assert_contains 'self-update is disabled' "$logs/fm-update.err"
assert_contains "fmx update <profile>" "$logs/fm-update.err"

# An unmanaged clone keeps upstream behavior.
unmanaged_home="$fixture_root/unmanaged-home"
mkdir -p "$unmanaged_home"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  FM_HOME="$unmanaged_home" \
  FM_ROOT_OVERRIDE="$fixture_root/unmanaged-root" \
  bash "$profiles_root/default/runtime/bin/fm-update.sh" \
  >"$logs/fm-update-unmanaged.out" 2>"$logs/fm-update-unmanaged.err" || status=$?
assert_not_contains 'self-update is disabled' "$logs/fm-update-unmanaged.err"

# ===========================================================================
# 12. Worker boundary: the shared runtime performs every worker launch.
# ===========================================================================

# A Firstmate-shaped operational-input helper and a task worktree.
opinput="$fixture_root/fm-operational-input.sh"
cat >"$opinput" <<'OPINPUT'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1-}" == encode && "${2-}" == launch-brief ]] || exit 2
if [[ -n "${OPINPUT_ENV_LOG-}" ]]; then
  printf 'ANTHROPIC_API_KEY=%s|ANTHROPIC_AUTH_TOKEN=%s|ANTHROPIC_CUSTOM_HEADERS=%s|CLAUDE_CODE_OAUTH_TOKEN=%s|AWS_ACCESS_KEY_ID=%s|AWS_SHARED_CREDENTIALS_FILE=%s|AWS_CONFIG_FILE=%s|GOOGLE_APPLICATION_CREDENTIALS=%s|AZURE_CLIENT_SECRET=%s|AZURE_API_KEY=%s|OPENAI_API_KEY=%s|GH_TOKEN=%s|COPILOT_GITHUB_TOKEN=%s|COPILOT_PROXY_GITHUB_TOKEN=%s\n' \
    "${ANTHROPIC_API_KEY-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" \
    "${ANTHROPIC_CUSTOM_HEADERS-unset}" "${CLAUDE_CODE_OAUTH_TOKEN-unset}" \
    "${AWS_ACCESS_KEY_ID-unset}" "${AWS_SHARED_CREDENTIALS_FILE-unset}" \
    "${AWS_CONFIG_FILE-unset}" "${GOOGLE_APPLICATION_CREDENTIALS-unset}" \
    "${AZURE_CLIENT_SECRET-unset}" "${AZURE_API_KEY-unset}" \
    "${OPENAI_API_KEY-unset}" "${GH_TOKEN-unset}" \
    "${COPILOT_GITHUB_TOKEN-unset}" "${COPILOT_PROXY_GITHUB_TOKEN-unset}" \
    >>"$OPINPUT_ENV_LOG"
fi
printf '<<launch-brief>>'
cat
OPINPUT
chmod 0755 "$opinput"
worker_worktree="$fixture_root/worktree-alpha"
mkdir -p "$worker_worktree/.claude"
printf '{"hooks":{}}\n' >"$worker_worktree/.claude/settings.local.json"
worker_brief="$profiles_root/default/home/data/fmd-ship/brief.md"
[[ -f "$worker_brief" ]] || fail 'the worker brief fixture is missing'

run_worker() {
  env -i HOME="${WORKER_AMBIENT_HOME:-$home}" PATH="${WORKER_PATH:-$fake_bin}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
    NATIVE_CLAUDE_LAUNCH_LOG="$NATIVE_CLAUDE_LAUNCH_LOG" \
    FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" \
    FAKE_CLAUDE_DECOY_LOG="$logs/claude-decoy.log" \
    FAKE_CURL_LOG="$logs/curl.log" \
    OPINPUT_ENV_LOG="$logs/opinput-env.log" \
    FMX_PROFILE=default \
    FMX_PROFILE_ROOT="$profiles_root/default" \
    FMX_CAPTAIN_PANE_ID="${WORKER_CAPTAIN_PANE-}" \
    FMX_GH_CONFIG_DIR="${WORKER_GH_CONFIG_DIR:-$gh_config}" \
    FMX_TASK_ID_PREFIX=fmd \
    FMX_WORKER_HOME="${WORKER_CARRIER_HOME-$home}" \
    FMX_WORKER_PATH="${WORKER_CARRIER_PATH-$fake_bin}" \
    FMX_WORKER_BASH="${WORKER_CARRIER_BASH-$host_bash}" \
    HERDR_ENV="${WORKER_HERDR_ENV-}" \
    HERDR_PANE_ID="${WORKER_PANE-}" \
    HERDR_SOCKET_PATH=/captain/socket \
    HERDR_SESSION=captain-session \
    HERDR_WORKSPACE_ID=captain-workspace \
    HERDR_TAB_ID=captain-tab \
    HERDR_EXPERIMENTAL_EXTRA=captain-extra \
    TRELLAGE_GUIDE_HERDR_CONTEXT_JSON='{"pane":"captain"}' \
    TRACEPARENT="${WORKER_TRACEPARENT:-00-aaaa-bbbb-01}" \
    CURSOR_AGENT=1 CURSOR_INVOKED_AS=cursor \
    FM_HOME=/captain/home FM_ROOT_OVERRIDE=/captain/runtime \
    FM_STATE_OVERRIDE=/captain/state FM_DATA_OVERRIDE=/captain/data \
    FM_PROJECTS_OVERRIDE=/captain/projects FM_CONFIG_OVERRIDE=/captain/config \
    FM_PUBLIC_FOLLOWUP_PRIMARY_HOME=/captain/home \
    FM_TRACE_CONTEXT=on FM_SUPERVISION_MODEL=autoarm FM_BACKEND=herdr \
    TASKS_AXI_BACKEND=wrong TASKS_AXI_FILE=/daemon/backlog.md \
    GH_TOKEN=leaked-gh GITHUB_TOKEN=leaked-github \
    COPILOT_GITHUB_TOKEN=leaked-copilot \
    COPILOT_PROXY_GITHUB_TOKEN=leaked-proxy \
    ANTHROPIC_API_KEY=leaked-anthropic ANTHROPIC_AUTH_TOKEN=leaked-auth \
    CLAUDE_CODE_OAUTH_TOKEN=leaked-oauth \
    OPENAI_API_KEY=leaked-openai \
    CLAUDE_CODE_USE_BEDROCK=1 CLAUDE_CODE_USE_VERTEX=1 \
    AWS_ACCESS_KEY_ID=leaked-aws AWS_SECRET_ACCESS_KEY=leaked-aws-secret \
    AWS_SESSION_TOKEN=leaked-aws-session AWS_PROFILE=leaked-aws-profile \
    AWS_SHARED_CREDENTIALS_FILE=/leaked/aws-credentials \
    AWS_CONFIG_FILE=/leaked/aws-config \
    ANTHROPIC_CUSTOM_HEADERS='Authorization: leaked' \
    GOOGLE_APPLICATION_CREDENTIALS=/leaked/google.json \
    ANTHROPIC_VERTEX_PROJECT_ID=leaked-vertex CLOUD_ML_REGION=leaked-region \
    AZURE_CLIENT_ID=leaked-azure AZURE_CLIENT_SECRET=leaked-azure-secret \
    AZURE_API_KEY=leaked-azure-api \
    AZURE_TENANT_ID=leaked-azure-tenant \
    FMX_WORKER_LAUNCHER="$install_root/lib/fmx-worker" \
    FMX_WORKER_POLICY_FILE="$profiles_root/pstack-workers/policy/worker-policy.md" \
    "${WORKER_START_BASH:-$host_bash}" \
    "${WORKER_HELPER:-$install_root/lib/fmx-worker}" "$@"
}

export FAKE_CLAUDE_DECOY_LOG="$logs/claude-decoy.log"
: >"$FAKE_CLAUDE_LOG"
: >"$FAKE_CLAUDE_DECOY_LOG"
: >"$NATIVE_CLAUDE_LOG"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
: >"$logs/opinput-env.log"

run_worker --task fmd-alpha --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  2>"$logs/worker-alpha.err" \
  || { cat "$logs/worker-alpha.err" >&2; fail 'the tmux worker boundary failed'; }
run_worker --task fmd-beta --kind scout --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model claude-sonnet-5 --effort high \
  --traceparent unset \
  || fail 'the second tmux worker boundary failed'
for scrubbed in \
  'ANTHROPIC_API_KEY=unset' 'ANTHROPIC_AUTH_TOKEN=unset' \
  'ANTHROPIC_CUSTOM_HEADERS=unset' 'CLAUDE_CODE_OAUTH_TOKEN=unset' \
  'AWS_ACCESS_KEY_ID=unset' 'AWS_SHARED_CREDENTIALS_FILE=unset' \
  'AWS_CONFIG_FILE=unset' 'GOOGLE_APPLICATION_CREDENTIALS=unset' \
  'AZURE_CLIENT_SECRET=unset' 'AZURE_API_KEY=unset' \
  'OPENAI_API_KEY=unset' 'GH_TOKEN=unset' \
  'COPILOT_GITHUB_TOKEN=unset' 'COPILOT_PROXY_GITHUB_TOKEN=unset'; do
  assert_contains "$scrubbed" "$logs/opinput-env.log"
done

[[ -d "$profiles_root/default/workers/fmd-alpha/claude" ]] \
  || fail 'the first worker Claude home is missing'
[[ -d "$profiles_root/default/workers/fmd-beta/claude" ]] \
  || fail 'the second worker Claude home is missing'
grep -F "prepare|home=$profiles_root/default/workers/fmd-alpha/claude" "$NATIVE_CLAUDE_LOG" \
  | grep -Fq 'bridge=disabled|profile=default' \
  || fail 'the worker Claude home was not prepared with the bridge disabled and its profile'
# prepare and launch must name the same fmx profile even with the bridge
# disabled, so the shared runtime's hook accounting stays consistent.
assert_contains "home=$profiles_root/default/workers/fmd-alpha/claude|bridge=disabled|profile=default" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
jq -e '.harness == "claude" and .backend == "tmux" and .kind == "ship"' \
  "$profiles_root/default/workers/fmd-alpha/worker.json" >/dev/null \
  || fail 'the worker record does not keep harness=claude'
jq -e '.model == "claude-sonnet-5" and .effort == "high"' \
  "$profiles_root/default/workers/fmd-beta/worker.json" >/dev/null \
  || fail 'the worker record does not preserve the model and effort selection'

# A quote-bearing model or effort must not be able to break the record's JSON.
hostile_model='ev"il","injected":true,"x":"'
run_worker --task fmd-hostile --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model "$hostile_model" --effort 'lo"w' \
  --traceparent keep \
  || fail 'the worker boundary failed with quote-bearing model and effort input'
jq -e --arg model "$hostile_model" '
  type == "object" and .model == $model and (has("injected") | not)
' "$profiles_root/default/workers/fmd-hostile/worker.json" >/dev/null \
  || fail 'a quote-bearing model broke the worker record JSON'

# The task-id namespace is enforced inside the worker helper too.
status=0
run_worker --task other-prefixed --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-prefix.err" || status=$?
[[ "$status" == 1 ]] || fail "a foreign task id exited $status instead of 1"
assert_contains "outside this profile's namespace" "$logs/worker-prefix.err"
[[ ! -e "$profiles_root/default/workers/other-prefixed" ]] \
  || fail 'a foreign task id still created a worker home'

# Every worker launch goes through the shared runtime with the bridge disabled
# and a per-task home, and carries Firstmate's encoded launch brief.
[[ "$(grep -c '^launch|' "$NATIVE_CLAUDE_LAUNCH_LOG")" -eq 3 ]] \
  || fail 'the shared runtime did not perform every worker launch'
assert_contains "home=$profiles_root/default/workers/fmd-alpha/claude|bridge=disabled" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "home=$profiles_root/default/workers/fmd-beta/claude|bridge=disabled" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_not_contains "home=$profiles_root/default/captain/claude|bridge=disabled" \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains '<<launch-brief>>' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'You are a crewmate' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'args=--model claude-sonnet-5 --effort high <<launch-brief>>' \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
# No model or effort means no flag, exactly as upstream.
assert_contains 'args=<<launch-brief>>' "$NATIVE_CLAUDE_LAUNCH_LOG"

# The worker environment reaching the shared runtime carries the explicit
# GitHub configuration, no FMX carrier, and no Herdr context.
assert_contains "GH_CONFIG_DIR=$gh_config" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_PROFILE=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_WORKER_LAUNCHER=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_GH_CONFIG_DIR=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'CURSOR_AGENT=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'HERDR=none' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'TRELLAGE_GUIDE_HERDR_CONTEXT_JSON=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains "cwd=$worker_worktree" "$NATIVE_CLAUDE_LAUNCH_LOG"
# No inherited Firstmate captain control reaches the worker.
for control in 'FM_HOME=unset' 'FM_ROOT_OVERRIDE=unset' 'FM_BACKEND=unset' \
  'FM_STATE_OVERRIDE=unset' 'FM_DATA_OVERRIDE=unset' 'FM_PROJECTS_OVERRIDE=unset' \
  'FM_CONFIG_OVERRIDE=unset' 'FM_PUBLIC_FOLLOWUP_PRIMARY_HOME=unset' \
  'FM_TRACE_CONTEXT=unset' 'FM_SUPERVISION_MODEL=unset'; do
  assert_contains "$control" "$NATIVE_CLAUDE_LAUNCH_LOG"
done
assert_not_contains '/captain/home' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_TASK_ID_PREFIX=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_WORKER_HOME=unset|FMX_WORKER_PATH=unset|FMX_WORKER_BASH=unset' \
  "$NATIVE_CLAUDE_LAUNCH_LOG"
# The carrier decided the effective HOME, not the ambient pane environment.
assert_contains "HOME=$home" "$NATIVE_CLAUDE_LAUNCH_LOG"
# Firstmate's project-local turn-end hooks in the worktree are untouched.
[[ -f "$worker_worktree/.claude/settings.local.json" ]] \
  || fail 'the project-local Claude hook settings were removed'

# The trace-context decision is carried through.
[[ "$(grep -c 'TRACEPARENT=00-aaaa-bbbb-01' "$NATIVE_CLAUDE_LAUNCH_LOG")" -eq 2 ]] \
  || fail 'the keep trace-context decision was not honored'
[[ "$(grep -c 'TRACEPARENT=unset' "$NATIVE_CLAUDE_LAUNCH_LOG")" -eq 1 ]] \
  || fail 'the unset trace-context decision was not honored'

# A secondmate or any non-crewmate shape is refused before an invocation exists.
status=0
run_worker --task fmd-second --kind secondmate --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-secondmate.err" || status=$?
[[ "$status" == 1 ]] || fail "a secondmate worker exited $status instead of 1"
assert_contains 'does not manage secondmate homes' "$logs/worker-secondmate.err"

# A missing or unusable operational-input helper fails closed.
status=0
run_worker --task fmd-noopinput --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$fixture_root/absent-opinput.sh" --model '' --effort '' \
  --traceparent keep >/dev/null 2>"$logs/worker-opinput.err" || status=$?
[[ "$status" == 1 ]] || fail "a missing operational-input helper exited $status instead of 1"
assert_contains 'operational-input helper is not an executable file' \
  "$logs/worker-opinput.err"

# A Herdr worker must have its own pane and must refuse the captain pane.
status=0
WORKER_CAPTAIN_PANE=pane-captain WORKER_PANE=pane-captain \
  run_worker --task fmd-gamma --kind ship --backend herdr \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-captain-pane.err" || status=$?
[[ "$status" == 1 ]] || fail "a Herdr worker in the captain pane exited $status instead of 1"
assert_contains 'must not run in the captain pane' "$logs/worker-captain-pane.err"

status=0
WORKER_CAPTAIN_PANE=pane-captain WORKER_PANE='' \
  run_worker --task fmd-delta --kind ship --backend herdr \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-no-pane.err" || status=$?
[[ "$status" == 1 ]] || fail "a Herdr worker without a pane exited $status instead of 1"
assert_contains 'requires its own HERDR_PANE_ID' "$logs/worker-no-pane.err"

: >"$NATIVE_CLAUDE_LAUNCH_LOG"
WORKER_CAPTAIN_PANE=pane-captain WORKER_PANE=pane-worker WORKER_HERDR_ENV=1 \
  run_worker --task fmd-epsilon --kind ship --backend herdr \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  || fail 'a Herdr worker with its own pane failed'
assert_contains 'HERDR_PANE_ID=pane-worker' "$NATIVE_CLAUDE_LAUNCH_LOG"
# Even on the Herdr backend the captain's guide context snapshot is dropped.
assert_contains 'TRELLAGE_GUIDE_HERDR_CONTEXT_JSON=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"

# A non-default GitHub CLI configuration directory is carried explicitly and
# reaches the worker, because a pane daemon inherits nothing.
custom_gh_config="$fixture_root/gh-custom"
mkdir -p "$custom_gh_config"
cat >"$custom_gh_config/hosts.yml" <<'HOSTS'
github.com:
    user: custom-contract
    oauth_token: custom-fixture
HOSTS
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
WORKER_GH_CONFIG_DIR="$custom_gh_config" \
  run_worker --task fmd-ghcustom --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  || fail 'the worker boundary failed with a custom GitHub CLI configuration'
assert_contains "GH_CONFIG_DIR=$custom_gh_config" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_contains 'FMX_GH_CONFIG_DIR=unset' "$NATIVE_CLAUDE_LAUNCH_LOG"

status=0
WORKER_GH_CONFIG_DIR="$fixture_root/gh-absent" \
  run_worker --task fmd-ghmissing --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-gh-missing.err" || status=$?
[[ "$status" == 1 ]] || fail "a worker without a gh carrier exited $status instead of 1"
assert_contains 'FMX_GH_CONFIG_DIR must be an existing absolute directory' \
  "$logs/worker-gh-missing.err"
status=0
WORKER_GH_CONFIG_DIR="$no_host_config" \
  run_worker --task fmd-ghhostless --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-gh-hostless.err" || status=$?
[[ "$status" == 1 ]] || fail "a worker with a hostless gh carrier exited $status instead of 1"
assert_contains 'has no github.com entry' "$logs/worker-gh-hostless.err"

# The worker boundary refuses a profile root it does not own.
foreign_root="$fixture_root/foreign-profile"
mkdir -p "$foreign_root"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  NATIVE_CLAUDE_LOG="$NATIVE_CLAUDE_LOG" \
  FMX_PROFILE=default FMX_PROFILE_ROOT="$foreign_root" \
  FMX_GH_CONFIG_DIR="$gh_config" FMX_TASK_ID_PREFIX=fmd \
  FMX_WORKER_HOME="$home" FMX_WORKER_PATH="$fake_bin" \
  FMX_WORKER_BASH="$host_bash" \
  "$host_bash" "$install_root/lib/fmx-worker" \
  --task fmd-zeta --kind ship --backend tmux \
  --brief "$worker_brief" --worktree "$worker_worktree" \
  --operational-input "$opinput" --model '' --effort '' --traceparent keep \
  >/dev/null 2>"$logs/worker-foreign.err" || status=$?
[[ "$status" == 1 ]] || fail "a foreign profile root exited $status instead of 1"
assert_contains 'is not an fmx profile' "$logs/worker-foreign.err"

# The pinned fm-spawn.sh overlay must hand over structured inputs only, never a
# shell command, and must enforce Claude-only crewmates before building one.
spawn_runtime="$profiles_root/default/runtime/bin/fm-spawn.sh"
assert_not_contains '--launch-command' "$spawn_runtime"
assert_contains '--operational-input $sq_opinput' "$spawn_runtime"
assert_contains 'FMX_TASK_ID_PREFIX=$(shell_quote "${FMX_TASK_ID_PREFIX:-}")' "$spawn_runtime"
assert_contains 'FMX_WORKER_BASH=$(shell_quote "${FMX_WORKER_BASH:-}")' "$spawn_runtime"
assert_contains 'FMX_TREEHOUSE_BIN=$(PATH="$FMX_WORKER_PATH" type -P treehouse' "$spawn_runtime"
assert_contains 'spawn_send_text_line "$WT_TARGET" "$(shell_quote "$FMX_TREEHOUSE_BIN") get"' "$spawn_runtime"
assert_contains "spawn_send_text_line \"\$WT_TARGET\" 'treehouse get'" "$spawn_runtime"
assert_contains 'would start outside the fmx worker boundary' "$spawn_runtime"
assert_contains 'does not manage secondmate homes' "$spawn_runtime"
assert_not_contains 'sh -c' "$install_root/lib/fmx-worker"

# ===========================================================================
# 12b. The real shared Claude runtime performs the worker launch.
# ===========================================================================
#
# The fake helper above proves the fmx side of the boundary. This block proves
# the other half: that routing through `native-claude launch` really does pick
# one verified executable, apply the shared flag contract, and scrub every
# provider variable. Only prepare is stubbed, because the real prepare needs
# network access for floating skills.

if [[ -f "$repo_root/prototypes/trellage-claude-common/native-claude" ]]; then
  real_runtime="$fixture_root/real-runtime"
  cp -R "$install_root" "$real_runtime"
  real_runtime="$(CDPATH= cd -P -- "$real_runtime" && pwd -P)"
  cat >"$real_runtime/lib/native-claude" <<REAL_SHIM
#!/usr/bin/env bash
set -euo pipefail
case "\${1-}" in
  launch | exec-clean)
    exec "$repo_root/prototypes/trellage-claude-common/native-claude" "\$@"
    ;;
esac
config_home=''
while [[ "\$#" -gt 0 ]]; do
  case "\$1" in
    --home) config_home="\$2"; shift 2 ;;
    --marker|--marker-value|--bridge|--profile) shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "\$config_home"
printf '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.233","shiftEnterKeyBindingInstalled":true,"theme":"dark"}\\n' \
  >"\$config_home/.claude.json"
chmod 0600 "\$config_home/.claude.json"
# ensure_settings runs unconditionally in the real prepare, so the stub must
# leave the same well-formed settings.json behind.
printf '{"outputStyle":"Rundown"}\\n' >"\$config_home/settings.json"
chmod 0600 "\$config_home/settings.json"
REAL_SHIM
  chmod 0755 "$real_runtime/lib/native-claude"

  real_bin="$fixture_root/real-bin"
  early_bin="$fixture_root/early-bin"
  mkdir -p "$real_bin" "$early_bin"
  for entry in "$fake_bin"/*; do
    case "$(basename "$entry")" in
      claude | curl) continue ;;
    esac
    ln -s "$entry" "$real_bin/$(basename "$entry")"
  done

  # The verified executable: first `claude` on PATH.
  cat >"$early_bin/claude" <<'VERIFIED_CLAUDE'
#!/usr/bin/env bash
if [[ "${1-}" == --version ]]; then
  printf '2.1.233 (Claude Code)
'
  exit 0
fi
printf 'selected=%s|HOME=%s|PATH=%s|args=%s
' "$0" "${HOME-unset}" "${PATH-unset}" "$*" >>"$FAKE_CLAUDE_LOG"
printf 'CLAUDE_CONFIG_DIR=%s|ANTHROPIC_BASE_URL=%s|ANTHROPIC_AUTH_TOKEN=%s|ANTHROPIC_API_KEY=%s|CLAUDE_CODE_OAUTH_TOKEN=%s|OPENAI_API_KEY=%s|CLAUDE_CODE_USE_BEDROCK=%s|CLAUDE_CODE_USE_VERTEX=%s|AWS_ACCESS_KEY_ID=%s|AWS_SECRET_ACCESS_KEY=%s|AWS_SESSION_TOKEN=%s|AWS_PROFILE=%s|GOOGLE_APPLICATION_CREDENTIALS=%s|ANTHROPIC_VERTEX_PROJECT_ID=%s|CLOUD_ML_REGION=%s|AZURE_CLIENT_ID=%s|AZURE_CLIENT_SECRET=%s|AZURE_TENANT_ID=%s|GH_TOKEN=%s|GITHUB_TOKEN=%s|COPILOT_GITHUB_TOKEN=%s|GH_CONFIG_DIR=%s|TASKS_AXI_BACKEND=%s|TASKS_AXI_FILE=%s|CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=%s|cwd=%s
' \
  "${CLAUDE_CONFIG_DIR-unset}" "${ANTHROPIC_BASE_URL-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" \
  "${ANTHROPIC_API_KEY-unset}" "${CLAUDE_CODE_OAUTH_TOKEN-unset}" "${OPENAI_API_KEY-unset}" \
  "${CLAUDE_CODE_USE_BEDROCK-unset}" "${CLAUDE_CODE_USE_VERTEX-unset}" \
  "${AWS_ACCESS_KEY_ID-unset}" "${AWS_SECRET_ACCESS_KEY-unset}" \
  "${AWS_SESSION_TOKEN-unset}" "${AWS_PROFILE-unset}" \
  "${GOOGLE_APPLICATION_CREDENTIALS-unset}" "${ANTHROPIC_VERTEX_PROJECT_ID-unset}" \
  "${CLOUD_ML_REGION-unset}" "${AZURE_CLIENT_ID-unset}" "${AZURE_CLIENT_SECRET-unset}" \
  "${AZURE_TENANT_ID-unset}" "${GH_TOKEN-unset}" "${GITHUB_TOKEN-unset}" \
  "${COPILOT_GITHUB_TOKEN-unset}" "${GH_CONFIG_DIR-unset}" \
  "${TASKS_AXI_BACKEND-unset}" "${TASKS_AXI_FILE-unset}" \
  "${CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION-unset}" "$(pwd -P)" \
  >>"$FAKE_CLAUDE_LOG"
herdr_state=none
for exported in $(compgen -e); do
  case "$exported" in
    HERDR_*) herdr_state="leaked:$exported" ;;
  esac
done
printf 'HERDR=%s|TRELLAGE_GUIDE_HERDR_CONTEXT_JSON=%s
' \
  "$herdr_state" "${TRELLAGE_GUIDE_HERDR_CONTEXT_JSON-unset}" >>"$FAKE_CLAUDE_LOG"
VERIFIED_CLAUDE
  chmod 0755 "$early_bin/claude"

  # A decoy later on PATH. A late re-resolution would find it; a verified
  # single resolution never does.
  cat >"$real_bin/claude" <<'DECOY_CLAUDE'
#!/usr/bin/env bash
printf 'decoy invoked: %s
' "$*" >>"$FAKE_CLAUDE_DECOY_LOG"
exit 0
DECOY_CLAUDE
  chmod 0755 "$real_bin/claude"

  cat >"$real_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    */health) printf '{"status":"ok"}
'; exit 0 ;;
    */v1/models) printf '{"data":[{"id":"claude-opus-5"}]}
'; exit 0 ;;
  esac
done
exit 1
FAKE_CURL
  chmod 0755 "$real_bin/curl"

  : >"$FAKE_CLAUDE_LOG"
  : >"$logs/claude-decoy.log"
  : >"$logs/opinput-env.log"
  WORKER_PATH="$early_bin:$real_bin" \
    WORKER_CARRIER_PATH="$early_bin:$real_bin" \
    WORKER_HELPER="$real_runtime/lib/fmx-worker" \
    run_worker --task fmd-real --kind ship --backend tmux \
    --brief "$worker_brief" --worktree "$worker_worktree" \
    --operational-input "$opinput" --model '' --effort '' --traceparent keep \
    >"$logs/worker-real.out" 2>"$logs/worker-real.err" \
    || { cat "$logs/worker-real.err" >&2; fail 'the real shared runtime worker launch failed'; }
  for scrubbed in \
    'ANTHROPIC_CUSTOM_HEADERS=unset' \
    'AWS_SHARED_CREDENTIALS_FILE=unset' \
    'AWS_CONFIG_FILE=unset' \
    'AZURE_API_KEY=unset'; do
    assert_contains "$scrubbed" "$logs/opinput-env.log"
  done

  # One verified executable, resolved once and exec'd by absolute path.
  assert_contains "selected=$early_bin/claude" "$FAKE_CLAUDE_LOG"
  [[ ! -s "$logs/claude-decoy.log" ]] \
    || fail 'a later claude on PATH was invoked instead of the verified executable'

  # The shared launch flag contract, which the previous sh -c pattern missed.
  assert_contains '--dangerously-skip-permissions' "$FAKE_CLAUDE_LOG"
  assert_contains '--permission-mode bypassPermissions' "$FAKE_CLAUDE_LOG"
  assert_contains '--disallowedTools AskUserQuestion' "$FAKE_CLAUDE_LOG"
  assert_contains '--model claude-opus-5' "$FAKE_CLAUDE_LOG"
  assert_contains '<<launch-brief>>' "$FAKE_CLAUDE_LOG"

  # The complete provider scrub, including everything the old partial scrub
  # missed, plus the proxy routing the shared runtime owns.
  for leaked in \
    'ANTHROPIC_API_KEY=unset' 'CLAUDE_CODE_OAUTH_TOKEN=unset' 'OPENAI_API_KEY=unset' \
    'CLAUDE_CODE_USE_BEDROCK=unset' 'CLAUDE_CODE_USE_VERTEX=unset' \
    'AWS_ACCESS_KEY_ID=unset' 'AWS_SECRET_ACCESS_KEY=unset' 'AWS_SESSION_TOKEN=unset' \
    'AWS_PROFILE=unset' 'GOOGLE_APPLICATION_CREDENTIALS=unset' \
    'ANTHROPIC_VERTEX_PROJECT_ID=unset' 'CLOUD_ML_REGION=unset' \
    'AZURE_CLIENT_ID=unset' 'AZURE_CLIENT_SECRET=unset' 'AZURE_TENANT_ID=unset' \
    'GH_TOKEN=unset' 'GITHUB_TOKEN=unset' 'COPILOT_GITHUB_TOKEN=unset'; do
    assert_contains "$leaked" "$FAKE_CLAUDE_LOG"
  done
  assert_contains 'ANTHROPIC_BASE_URL=http://127.0.0.1:8080' "$FAKE_CLAUDE_LOG"
  assert_contains "CLAUDE_CONFIG_DIR=$profiles_root/default/workers/fmd-real/claude" \
    "$FAKE_CLAUDE_LOG"
  assert_contains 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false' "$FAKE_CLAUDE_LOG"
  assert_contains "GH_CONFIG_DIR=$gh_config" "$FAKE_CLAUDE_LOG"
  assert_contains 'TASKS_AXI_BACKEND=markdown' "$FAKE_CLAUDE_LOG"
  assert_contains "TASKS_AXI_FILE=$profiles_root/default/home/data/backlog.md" \
    "$FAKE_CLAUDE_LOG"
  assert_contains "cwd=$worker_worktree" "$FAKE_CLAUDE_LOG"

  # A tmux worker reaches the harness with no Herdr context whatsoever.
  assert_contains 'HERDR=none|TRELLAGE_GUIDE_HERDR_CONTEXT_JSON=unset' "$FAKE_CLAUDE_LOG"

  # The daemon's HOME and PATH must not decide anything. Here the ambient pane
  # environment is deliberately wrong - a foreign HOME and a PATH whose only
  # claude is a decoy - and the explicit carriers must still select the
  # captain's home and the intended executable.
  wrong_home="$fixture_root/wrong-home"
  wrong_bin="$fixture_root/wrong-bin"
  mkdir -p "$wrong_home" "$wrong_bin"
  for entry in "$real_bin"/*; do
    if [[ "$(basename "$entry")" == claude ]]; then continue; fi
    ln -s "$entry" "$wrong_bin/$(basename "$entry")"
  done
  cp "$real_bin/claude" "$wrong_bin/claude"
  : >"$FAKE_CLAUDE_LOG"
  : >"$logs/claude-decoy.log"
  WORKER_PATH="$wrong_bin" \
    WORKER_CARRIER_PATH="$early_bin:$real_bin" \
    WORKER_CARRIER_HOME="$home" \
    WORKER_AMBIENT_HOME="$wrong_home" \
    WORKER_HELPER="$real_runtime/lib/fmx-worker" \
    run_worker --task fmd-carrier --kind ship --backend tmux \
    --brief "$worker_brief" --worktree "$worker_worktree" \
    --operational-input "$opinput" --model '' --effort '' --traceparent keep \
    >"$logs/worker-carrier.out" 2>"$logs/worker-carrier.err" \
    || { cat "$logs/worker-carrier.err" >&2; \
         fail 'the worker boundary failed with a wrong ambient HOME and PATH'; }
  # The intended executable ran, not the decoy the ambient PATH offered.
  assert_contains "selected=$early_bin/claude" "$FAKE_CLAUDE_LOG"
  [[ ! -s "$logs/claude-decoy.log" ]] \
    || fail 'the ambient PATH decoy claude was invoked'
  assert_contains "HOME=$home" "$FAKE_CLAUDE_LOG"
  assert_not_contains "HOME=$wrong_home" "$FAKE_CLAUDE_LOG"
  assert_contains "CLAUDE_CONFIG_DIR=$profiles_root/default/workers/fmd-carrier/claude" \
    "$FAKE_CLAUDE_LOG"
  [[ -d "$profiles_root/default/workers/fmd-carrier/claude" ]] \
    || fail 'the worker home was not created under the captain HOME'
  [[ ! -d "$wrong_home/.local" ]] \
    || fail 'the worker created state under the ambient pane HOME'
  # The carriers themselves never reach the harness.
  assert_not_contains 'FMX_WORKER_HOME' "$FAKE_CLAUDE_LOG"
  assert_not_contains 'FMX_WORKER_PATH' "$FAKE_CLAUDE_LOG"

  # Even an ambient PATH with no bash or utilities cannot affect startup: the
  # pane invokes the captain's absolute Bash and the worker applies the
  # explicit carrier PATH before the shared scrub needs any utility.
  empty_ambient_bin="$fixture_root/empty-ambient-bin"
  mkdir -p "$empty_ambient_bin"
  WORKER_PATH="$empty_ambient_bin" \
    WORKER_CARRIER_PATH="$early_bin:$real_bin" \
    WORKER_CARRIER_HOME="$home" \
    WORKER_HELPER="$real_runtime/lib/fmx-worker" \
    run_worker --task fmd-empty-ambient --kind ship --backend tmux \
    --brief "$worker_brief" --worktree "$worker_worktree" \
    --operational-input "$opinput" --model '' --effort '' --traceparent keep \
    >/dev/null 2>"$logs/worker-empty-ambient.err" \
    || { cat "$logs/worker-empty-ambient.err" >&2; \
         fail 'the worker startup depended on the ambient PATH'; }

  # A missing or unusable carrier fails closed rather than falling back.
  for bad in '' 'relative/home' "$fixture_root/absent-home"; do
    status=0
    WORKER_CARRIER_HOME="$bad" \
      run_worker --task fmd-badhome --kind ship --backend tmux \
      --brief "$worker_brief" --worktree "$worker_worktree" \
      --operational-input "$opinput" --model '' --effort '' --traceparent keep \
      >/dev/null 2>"$logs/worker-bad-home.err" || status=$?
    [[ "$status" == 1 ]] || fail "an invalid FMX_WORKER_HOME exited $status instead of 1"
    assert_contains 'FMX_WORKER_HOME' "$logs/worker-bad-home.err"
  done
  status=0
  WORKER_CARRIER_PATH='' \
    run_worker --task fmd-badpath --kind ship --backend tmux \
    --brief "$worker_brief" --worktree "$worker_worktree" \
    --operational-input "$opinput" --model '' --effort '' --traceparent keep \
    >/dev/null 2>"$logs/worker-bad-path.err" || status=$?
  [[ "$status" == 1 ]] || fail "an empty FMX_WORKER_PATH exited $status instead of 1"
  assert_contains 'FMX_WORKER_PATH is required' "$logs/worker-bad-path.err"
  for bad_path in \
    "relative/bin" \
    "$fake_bin:relative/bin" \
    "$fake_bin::/bin" \
    ":$fake_bin" \
    "$fake_bin:"; do
    status=0
    WORKER_CARRIER_PATH="$bad_path" \
      run_worker --task fmd-badpath --kind ship --backend tmux \
      --brief "$worker_brief" --worktree "$worker_worktree" \
      --operational-input "$opinput" --model '' --effort '' --traceparent keep \
      >/dev/null 2>"$logs/worker-bad-path-entry.err" || status=$?
    [[ "$status" == 1 ]] \
      || fail "an unsafe FMX_WORKER_PATH entry exited $status instead of 1"
    assert_contains 'every FMX_WORKER_PATH entry' "$logs/worker-bad-path-entry.err"
  done
  for bad_bash in '' 'relative/bash' "$fixture_root/absent-bash"; do
    status=0
    WORKER_CARRIER_BASH="$bad_bash" \
      run_worker --task fmd-badbash --kind ship --backend tmux \
      --brief "$worker_brief" --worktree "$worker_worktree" \
      --operational-input "$opinput" --model '' --effort '' --traceparent keep \
      >/dev/null 2>"$logs/worker-bad-bash.err" || status=$?
    [[ "$status" == 1 ]] \
      || fail "an invalid FMX_WORKER_BASH exited $status instead of 1"
    assert_contains 'FMX_WORKER_BASH' "$logs/worker-bad-bash.err"
  done

  # The pane command uses leading assignments and the captain's absolute Bash,
  # so it never depends on the daemon PATH to find an interpreter or helper.
  assert_contains 'LAUNCH="FMX_PROFILE=$(shell_quote "${FMX_PROFILE:-}")' "$spawn_runtime"
  assert_contains 'FMX_WORKER_HOME=$(shell_quote "${FMX_WORKER_HOME:-}")' "$spawn_runtime"
  assert_contains 'FMX_WORKER_PATH=$(shell_quote "${FMX_WORKER_PATH:-}")' "$spawn_runtime"
  assert_contains 'FMX_WORKER_BASH=$(shell_quote "${FMX_WORKER_BASH:-}")' "$spawn_runtime"
  assert_contains '$(shell_quote "${FMX_WORKER_BASH:-}")' "$spawn_runtime"
  assert_not_contains 'LAUNCH="env FMX_PROFILE' "$spawn_runtime"

  # The captain runs with the bridge ENABLED, and the shared runtime validates
  # the exact per-profile hook. Prove directly against the real runtime that a
  # pstack-workers captain launched under the default profile name is rejected,
  # which is exactly what an omitted or wrong --profile would produce.
  bridge_home_root="$home/bridge-captain"
  bridge_home="$bridge_home_root/claude"
  bridge_marker="$bridge_home_root/$(basename "$install_root/.managed-by-trellage-firstmate-profiles")"
  mkdir -p "$bridge_home/.trellage"
  printf '%s\n' "$ownership_value" >"$bridge_marker"
  printf '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.233","shiftEnterKeyBindingInstalled":true,"theme":"dark"}\n' \
    >"$bridge_home/.claude.json"
  printf '{"outputStyle":"Rundown"}\n' >"$bridge_home/settings.json"
  cp "$install_root/lib/trellage-session-bridge.py" "$bridge_home/.trellage/trellage-session-bridge.py"
  chmod 0700 "$bridge_home/.trellage/trellage-session-bridge.py"
  env -i HOME="$home" PATH="$real_bin" TMPDIR="${TMPDIR:-/tmp}" \
    "$bridge_home/.trellage/trellage-session-bridge.py" install-hook \
    --mode native --agent claude --profile pstack-workers \
    --config-dir "$bridge_home" \
    --hook-path "$bridge_home/.trellage/trellage-session-bridge.py" \
    || fail 'could not install a pstack-workers bridge hook fixture'

  real_native_claude="$repo_root/prototypes/trellage-claude-common/native-claude"
  : >"$FAKE_CLAUDE_LOG"
  env -i HOME="$home" PATH="$early_bin:$real_bin" TMPDIR="${TMPDIR:-/tmp}" \
    FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" FAKE_CLAUDE_DECOY_LOG="$logs/claude-decoy.log" \
    TRELLAGE_CLAUDE_LAUNCHER_NAME=fmx \
    TRELLAGE_CLAUDE_RUNTIME_ROOT="$real_runtime" \
    "$real_native_claude" launch --home "$bridge_home" --marker "$bridge_marker" \
    --marker-value "$ownership_value" --bridge enabled --profile pstack-workers \
    -- 'brief' >/dev/null 2>"$logs/bridge-right-profile.err" \
    || { cat "$logs/bridge-right-profile.err" >&2; \
         fail 'the shared runtime rejected a correctly named pstack-workers captain'; }
  assert_contains "selected=$early_bin/claude" "$FAKE_CLAUDE_LOG"

  status=0
  env -i HOME="$home" PATH="$early_bin:$real_bin" TMPDIR="${TMPDIR:-/tmp}" \
    FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" FAKE_CLAUDE_DECOY_LOG="$logs/claude-decoy.log" \
    TRELLAGE_CLAUDE_LAUNCHER_NAME=fmx \
    TRELLAGE_CLAUDE_RUNTIME_ROOT="$real_runtime" \
    "$real_native_claude" launch --home "$bridge_home" --marker "$bridge_marker" \
    --marker-value "$ownership_value" --bridge enabled --profile default \
    -- 'brief' >/dev/null 2>"$logs/bridge-wrong-profile.err" || status=$?
  [[ "$status" == 1 ]] \
    || fail "the shared runtime accepted a pstack-workers captain launched as default (exit $status)"
  assert_contains 'session bridge hook is missing' "$logs/bridge-wrong-profile.err"
else
  printf 'fmx contract: skipping the real shared Claude runtime block (helper absent)\n'
fi

# ===========================================================================
# 13. Uninstall preserves every profile root.
# ===========================================================================

canary="$profiles_root/default/home/data/fmd-ship/brief.md"
[[ -f "$canary" ]] || fail 'the profile canary is missing before uninstall'
active_uninstall_profile="$profiles_root/uninstall-active"
mkdir -p "$active_uninstall_profile/locks/session"
printf '%s\n' "$$" >"$active_uninstall_profile/locks/session/pid"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-active.err" || status=$?
[[ "$status" == 1 ]] || fail "active-session uninstall exited $status instead of 1"
assert_contains 'cannot uninstall fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/uninstall-active.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'active-session uninstall changed the launcher runtime'
rm -rf -- "$active_uninstall_profile"

incomplete_uninstall_profile="$profiles_root/uninstall-incomplete"
mkdir -p "$incomplete_uninstall_profile/locks/session"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-incomplete.err" || status=$?
[[ "$status" == 1 ]] || fail "incomplete-session uninstall exited $status instead of 1"
assert_contains 'cannot uninstall fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/uninstall-incomplete.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'incomplete-session uninstall changed the launcher runtime'
rm -rf -- "$incomplete_uninstall_profile"

worker_uninstall_profile="$profiles_root/uninstall-worker-active"
mkdir -p "$worker_uninstall_profile/workers/task"
printf '%s\n' "$$" >"$worker_uninstall_profile/workers/task/.active"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-worker-active.err" || status=$?
[[ "$status" == 1 ]] || fail "active-worker uninstall exited $status instead of 1"
assert_contains 'cannot uninstall fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/uninstall-worker-active.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'active-worker uninstall changed the launcher runtime'
rm -rf -- "$worker_uninstall_profile"

mutation_uninstall_profile="$profiles_root/uninstall-mutation-incomplete"
mkdir -p "$mutation_uninstall_profile/locks/mutation"
status=0
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >/dev/null 2>"$logs/uninstall-mutation-incomplete.err" || status=$?
[[ "$status" == 1 ]] || fail "incomplete-mutation uninstall exited $status instead of 1"
assert_contains 'cannot uninstall fmx while a Firstmate fleet or profile mutation is active or indeterminate' \
  "$logs/uninstall-mutation-incomplete.err"
[[ -d "$install_root" && -L "$command_path" ]] \
  || fail 'incomplete-mutation uninstall changed the launcher runtime'
rm -rf -- "$mutation_uninstall_profile"

mkdir "$home/.local/share/trellage/.fmx-retired-install.uninstall-test"
printf 'retired install artifact\n' \
  >"$home/.local/share/trellage/.fmx-retired-install.uninstall-test/canary"
mkdir "$home/.local/bin/.fmx-command.uninstall-test"
ln -s "$install_root/bin/fmx" "$home/.local/bin/.fmx-command.uninstall-test/fmx"
env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >"$logs/uninstall.out" 2>"$logs/uninstall.err" \
  || { cat "$logs/uninstall.err" >&2; fail 'uninstall failed'; }
assert_contains 'profile roots, homes, and worker state were preserved' "$logs/uninstall.out"
[[ ! -e "$install_root" ]] || fail 'the launcher runtime was not removed'
[[ ! -e "$command_path" ]] || fail 'the command symlink was not removed'
[[ ! -e "$home/.local/share/trellage/.fmx-retired-install.uninstall-test" ]] \
  || fail 'uninstall retained a retired transaction artifact'
[[ ! -e "$home/.local/bin/.fmx-command.uninstall-test" ]] \
  || fail 'uninstall retained a command transaction artifact'
[[ -f "$canary" ]] || fail 'uninstall removed profile state'
[[ -x "$profiles_root/default/runtime/bin/fm-spawn.sh" ]] \
  || fail 'uninstall removed the pinned profile runtime'
[[ -d "$profiles_root/default/captain/claude" ]] \
  || fail 'uninstall removed the captain Claude home'
[[ -d "$profiles_root/default/workers/fmd-alpha/claude" ]] \
  || fail 'uninstall removed worker state'

env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_uninstaller" >"$logs/uninstall-again.out" 2>&1 \
  || fail 'a repeated uninstall failed'
assert_contains 'fmx is not installed' "$logs/uninstall-again.out"

env -i HOME="$home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
  bash "$mirror_installer" >/dev/null 2>&1 || fail 'reinstall after uninstall failed'
fmx inventory default --json >"$logs/inventory-reinstalled.json" \
  || fail 'inventory after reinstall failed'
jq -e '.readiness == "healthy"' "$logs/inventory-reinstalled.json" >/dev/null \
  || fail 'the preserved profile was not healthy after reinstall'

# ===========================================================================
# 14. The real shared Claude runtime, when it is present in this repository.
# ===========================================================================

if [[ -f "$repo_root/prototypes/trellage-claude-common/native-claude" ]]; then
  real_home="$fixture_root/real-home"
  mkdir -p "$real_home"
  env -i HOME="$real_home" PATH="$fake_bin" TMPDIR="${TMPDIR:-/tmp}" \
    bash "$installer" >"$logs/install-real.out" 2>"$logs/install-real.err" \
    || { cat "$logs/install-real.err" >&2; fail 'install from the repository failed'; }
  [[ -x "$real_home/.local/share/trellage/fmx/lib/native-claude" ]] \
    || fail 'the repository install did not stage the shared Claude helper'
fi

printf 'fmx contract: PASS\n'
