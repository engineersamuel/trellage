#!/usr/bin/env bash

if [[ "${1-}" != --fixture-body ]]; then
  exec python3 "$(dirname "$0")/run-contract.py"
fi
shift

set -u
set -o pipefail

# A contract started from inside an OMP session inherits that session's profile and overlay list.
unset TRELLAGE_NATIVE_COMPOSITION_HARNESS TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT \
  OMP_PROFILE PI_PROFILE PI_CODING_AGENT_DIR PI_CONFIG_FILES

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
export OMP_FIXTURE_SYNC_HELPER="$root/tests/synchronization.sh"
. "$OMP_FIXTURE_SYNC_HELPER"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
launcher="$root/bin/omp"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"
skills_catalog="$root/../../config.example.toml"
community_skill_names=()
while IFS= read -r skill_name; do
  community_skill_names+=("$skill_name")
done < <(
  bun --no-env-file -e 'const catalog = Bun.TOML.parse(await Bun.file(process.argv[1]).text()).skills; for (const source of catalog.bundles["omp-community"]) for (const name of catalog.sources[source].select) console.log(name)' "$skills_catalog"
)

fail() {
  printf 'omp contract failed: %s\n' "$1" >&2
  exit 1
}

wait_for_file() {
  omp_fixture_wait "$1" "$2" || fail "$2 did not reach its synchronization point"
}

file_identity() {
  local identity
  # GNU stat -f emits filesystem details even when the BSD format fails.
  if ! identity="$(stat -f '%d:%i' "$1" 2>/dev/null)"; then
    identity="$(stat -c '%d:%i' "$1")" || return 1
  fi
  printf '%s\n' "$identity"
}

assert_community_skills() {
  local target="$1" label="$2" skill_name skill_count

  [[ -d "$target" && ! -L "$target" ]] \
    || fail "$label community skill directory is missing"
  skill_count="$(find "$target" -mindepth 1 -maxdepth 1 -type d ! -name '.trellage-*' | wc -l | tr -d ' ')"
  [[ "$skill_count" == 33 ]] \
    || fail "$label community skill count was $skill_count, expected 33"
  for skill_name in "${community_skill_names[@]}"; do
    grep -Fqx "# Fixture $skill_name" "$target/$skill_name/SKILL.md" \
      || fail "$label community skill differs: $skill_name"
  done
}

seed_community_skills_cache() {
  local target="$1" skill_name

  mkdir -p "$target/skills"
  for skill_name in "${community_skill_names[@]}"; do
    mkdir -p "$target/skills/$skill_name"
    printf '# Fixture %s\n' "$skill_name" >"$target/skills/$skill_name/SKILL.md"
  done
  printf '%s\n' "${community_skill_names[@]}" | LC_ALL=C sort >"$target/managed-skills.txt"
  : >"$target/always-on.md"
  seal_floating_skills_cache "$target" "$skills_catalog" omp-community
}

documentation_files=(
  "$root/README.md"
  "$root/../../profile-guides/native/omp/default.md"
  "$root/../../profile-guides/native/omp/local.md"
  "$root/../../README.md"
)

for source_file in "$launcher" "$installer" "$uninstaller" "${documentation_files[@]}"; do
  [[ -f "$source_file" ]] || fail "missing source file: $source_file"
done

assert_documentation_contains() {
  local phrase="$1" file="$2"

  grep -Fq -- "$phrase" "$file" \
    || fail "documentation is missing '$phrase': $file"
}

assert_documentation_absent() {
  local phrase="$1" file

  for file in "${documentation_files[@]}"; do
    ! grep -Fq -- "$phrase" "$file" \
      || fail "documentation retains stale '$phrase': $file"
  done
}

assert_documentation_contains 'host-installed `omp` executable' "${documentation_files[0]}"
assert_documentation_contains 'Trellage does not install or pin a private OMP copy.' "${documentation_files[0]}"
assert_documentation_contains 'Bun, Homebrew, and mise' "${documentation_files[0]}"
assert_documentation_contains "bun update -g --latest @oh-my-pi/pi-coding-agent '@oh-my-pi/pi-natives*'" "${documentation_files[0]}"
assert_documentation_contains 'brew upgrade can1357/tap/omp' "${documentation_files[0]}"
assert_documentation_contains 'mise upgrade github:can1357/oh-my-pi' "${documentation_files[0]}"
assert_documentation_contains 'An existing `PI_CONFIG_FILES` list is preserved, and Trellage appends its overlay last.' "${documentation_files[0]}"
assert_documentation_contains 'Explicit OMP `--config` arguments load later and override the Trellage overlay.' "${documentation_files[0]}"
for policy_line in \
  '  checkUpdate: false' \
  '  setupWizard: false' \
  '  autoUpdate: off' \
  '  approvalMode: yolo' \
  '  gitGuard: true' \
  '  enabled: true' \
  '  cacheWarming: streaming'; do
  assert_documentation_contains "$policy_line" "${documentation_files[0]}"
done
assert_documentation_contains 'config.yml' "${documentation_files[0]}"
assert_documentation_contains 'Copilot `models.yml`' "${documentation_files[0]}"
assert_documentation_contains 'authentication' "${documentation_files[0]}"
assert_documentation_contains 'sessions' "${documentation_files[0]}"
assert_documentation_contains 'remain byte-for-byte unchanged.' "${documentation_files[0]}"
assert_documentation_contains "The local profile's \`models.yml\` is the one Trellage-managed exception" "${documentation_files[0]}"
assert_documentation_contains 'Only OMP 18.8.5 has the verified `--headless-policy no-user-input` contract.' "${documentation_files[0]}"
assert_documentation_contains 'Other versions publish conservative headless metadata and fail closed' "${documentation_files[0]}"
assert_documentation_contains 'host-installed `omp`' "${documentation_files[1]}"
assert_documentation_contains 'host-installed `omp`' "${documentation_files[2]}"
assert_documentation_contains 'host-installed `omp`' "${documentation_files[3]}"
assert_documentation_contains 'Unknown ownership fails update and check; update the binary manually with the mechanism that installed it.' "${documentation_files[0]}"
assert_documentation_contains 'omp reap PROFILE' "${documentation_files[0]}"
assert_documentation_contains 'only removes a validated stale initialization claim' "${documentation_files[0]}"
for stale_phrase in \
  'installed-version' \
  'receipt-selected' \
  'mise-resolved' \
  'setup resolves and pins the eligible OMP release' \
  'installs it into the managed runtime'; do
  assert_documentation_absent "$stale_phrase"
done
[[ "${#community_skill_names[@]}" -eq 33 ]] \
  || fail "OMP community skill count was ${#community_skill_names[@]}, expected 33"
[[ "$(printf '%s\n' "${community_skill_names[@]}" | LC_ALL=C sort -u | wc -l | tr -d ' ')" == 33 ]] \
  || fail 'OMP community skill catalog contains duplicate names'
bun --no-env-file -e 'console.log(JSON.stringify(Bun.TOML.parse(await Bun.file(process.argv[1]).text()).skills))' "$skills_catalog" | jq -e '
  .sources["dsebban-omp"].repository == "https://github.com/dsebban/skills.git"
  and .sources["dsebban-omp"].select == ["orchestrate-omp", "poteto-mode", "pstack-omp"]
  and .sources["pstack-portable"].repository == "https://github.com/ericlitman/open-pstack.git"
  and (.sources["pstack-portable"].select | length) == 30
  and (.sources["pstack-portable"].select | index("poteto-mode")) == null
  and (.sources["pstack-portable"].select | index("setup-pstack")) == null
  and (.sources["pstack-portable"].select | index("setup-benny")) == null
  and .bundles["omp-community"] == ["dsebban-omp", "pstack-portable"]
' >/dev/null || fail 'OMP community skill catalog differs'

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-omp-contract.XXXXXX")" \
  || fail 'could not create fixture root'
case "$fixture_root" in
  "${TMPDIR:-/tmp}"/trellage-omp-contract.*) ;;
  *) fail "unsafe fixture root: $fixture_root" ;;
esac
fixture_root="$(cd -P -- "$fixture_root" && pwd)"
stale_claim_pid=''
cleanup_stale_claim_process() {
  if [[ -n "${stale_claim_pid-}" ]]; then
    kill "$stale_claim_pid" 2>/dev/null || true
    wait "$stale_claim_pid" 2>/dev/null || true
    stale_claim_pid=''
  fi
}
trap 'cleanup_stale_claim_process; rm -rf -- "$fixture_root"' EXIT HUP INT TERM
fixture_registry="$(npm config get registry --workspaces=false)" \
  || fail 'could not discover the host npm registry'
[[ -n "$fixture_registry" ]] || fail 'host npm registry is empty'
export BUN_INSTALL_CACHE_DIR="${TRELLAGE_TEST_PACKAGE_CACHE:-$fixture_root/bun-cache}"
export npm_config_registry="$fixture_registry"


fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
mkdir -p "$fake_bin" "$home"

cat >"$fake_bin/git" <<'FAKE_GIT'
#!/usr/bin/env bash
exit 86
FAKE_GIT
chmod 0755 "$fake_bin/git"

cat >"$fixture_root/fake-omp-template" <<'FAKE_OMP'
#!/usr/bin/env bash
. "${OMP_FIXTURE_SYNC_HELPER:?}"
set -u

if [[ -n "${FAKE_OMP_EXEC_LOG:-}" ]]; then
  printf '%s %s\n' '@IDENTITY@' "$*" >>"$FAKE_OMP_EXEC_LOG"
fi

if [[ "${1-}" == '--version' ]]; then
  if [[ -n "${FAKE_OMP_REMOVE_PATH:-}" && -e "${FAKE_OMP_REMOVE_PATH}" ]]; then
    rm -f -- "$FAKE_OMP_REMOVE_PATH" \
      || { printf 'PATH removal failed\n' >&2; exit 91; }
    [[ ! -e "$FAKE_OMP_REMOVE_PATH" ]] \
      || { printf 'PATH removal was not effective\n' >&2; exit 92; }
    [[ -z "${FAKE_OMP_SWAP_MARKER:-}" ]] \
      || printf 'removed\n' >>"$FAKE_OMP_SWAP_MARKER"
  fi
  if [[ "${FAKE_OMP_BLOCK_VERSION:-}" == 1 ]]; then
    : >"${FAKE_OMP_READY_FILE:?}"
    omp_fixture_wait "${FAKE_OMP_RELEASE_FILE:?}" "version release" || exit $?
  fi
  if [[ '@VERSION@' == not-omp ]]; then
    printf '%s\n' not-omp
  else
    printf 'omp/%s\n' '@VERSION@'
  fi
  exit 0
fi

if [[ "${1-} ${2-}" == 'models github-copilot' ]]; then
  printf '%s\n' "${PI_CONFIG_FILES-}" >>"$FAKE_OMP_MODELS_ENV_LOG"
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
if [[ "${FAKE_OMP_REQUIRE_STDIN-}" == 1 ]]; then
  IFS= read -r stdin_probe || exit 79
  [[ "$stdin_probe" == terminal-response ]] || exit 80
fi

config_files=("$HOME/.omp/profiles/${OMP_PROFILE-}/agent/config.yml")
remaining="${PI_CONFIG_FILES-}"
while [[ -n "$remaining" ]]; do
  config_files+=("${remaining%%:*}")
  [[ "$remaining" == *:* ]] || break
  remaining="${remaining#*:}"
done
overlay_path=''
for ((index=1; index <= $#; index += 1)); do
  eval "arg=\${$index}"
  case "$arg" in
    --config)
      index=$((index + 1))
      eval "overlay_path=\${$index-}"
      config_files+=("$overlay_path")
      ;;
    --config=*)
      overlay_path="${arg#--config=}"
      config_files+=("$overlay_path")
      ;;
  esac
done

effective_value() {
  local section="$1" key="$2" file value='' next
  for file in "${config_files[@]}"; do
    [[ -f "$file" ]] || continue
    next="$(awk -v section="$section" -v key="$key" '
      /^[^ ]/ { in_section = ($0 == section ":") }
      in_section && $1 == key ":" { print $2 }
    ' "$file" | tail -n 1)"
    [[ -z "$next" ]] || value="$next"
  done
  printf '%s\n' "$value"
}

if [[ "$#" -eq 0 && "$(effective_value startup setupWizard)" != false ]]; then
  printf 'Choose your default model\n'
  exit 64
fi

overlay_matches=false
if [[ -n "$overlay_path" && -f "$overlay_path" && ! -L "$overlay_path" ]] \
  && grep -Fqx 'ask:' "$overlay_path" \
  && grep -Fqx '  enabled: false' "$overlay_path" \
  && [[ "$(wc -l <"$overlay_path" | tr -d ' ')" == 2 ]]; then
  overlay_matches=true
fi
approval_mode_yolo=false
[[ "$(effective_value tools approvalMode)" != yolo ]] || approval_mode_yolo=true
jq -cn \
  --arg version '@VERSION@' \
  --arg profile "${OMP_PROFILE-}" \
  --arg path "$overlay_path" \
  --arg configFiles "${PI_CONFIG_FILES-}" \
  --arg defaultModel "$(effective_value modelRoles default)" \
  --arg askEnabled "$(effective_value ask enabled)" \
  --argjson overlayMatches "$overlay_matches" \
  --argjson approvalModeYolo "$approval_mode_yolo" '
  {
    version: $version,
    profile: $profile,
    path: $path,
    configFiles: $configFiles,
    overlayMatches: $overlayMatches,
    approvalModeYolo: $approvalModeYolo,
    defaultModel: $defaultModel,
    askEnabled: $askEnabled
  }
' >>"$FAKE_OMP_OVERLAY_LOG"

jq -cn \
  --arg version '@VERSION@' \
  --arg profile "${OMP_PROFILE-}" \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  '$ARGS.named + {args:$ARGS.positional}' \
  --args -- "$@" >>"$FAKE_OMP_LOG"

if [[ -n "${FAKE_OMP_RUN_READY_FILE-}" ]]; then
  printf '%s\n' "$$" >"$FAKE_OMP_RUN_READY_FILE"
  omp_fixture_wait "$FAKE_OMP_RUN_RELEASE_FILE" "run release" || exit $?
fi

if [[ "${FAKE_OMP_WAIT_FOR_SIGNAL-}" == 1 ]]; then
  trap 'printf "TERM\n" >>"$FAKE_OMP_SIGNAL_LOG"; exit 143' TERM
  printf 'READY\n' >>"$FAKE_OMP_SIGNAL_LOG"
  signal_deadline=$((SECONDS + 30))
  while ((SECONDS < signal_deadline)); do sleep 0.05; done
  printf "OMP fixture timed out waiting for TERM\n" >&2
  exit 124
fi

exit "${FAKE_OMP_EXIT_STATUS:-0}"
FAKE_OMP
chmod 0755 "$fixture_root/fake-omp-template"

publish_host_omp() {
  local directory="$1" version="$2"

  mkdir -p "$directory"
  sed "s/@VERSION@/$version/g" "$fixture_root/fake-omp-template" >"$directory/omp"
  chmod 0755 "$directory/omp"
}

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

install_fixture_node "$fake_bin"
seed_floating_skills_cache "$home"
seed_community_skills_cache "$home/.local/share/trellage/common/omp-community-skills"
fixture_tools_path="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
host_bin="$fixture_root/host-bin"
publish_host_omp "$host_bin" 18.0.11
export PATH="$host_bin:$fixture_tools_path"
export HOME="$home"
export FAKE_MISE_LOG="$fixture_root/mise.log"
export FAKE_CURL_LOG="$fixture_root/curl.log"
export FAKE_OMP_LOG="$fixture_root/omp.log"
export FAKE_OMP_OVERLAY_LOG="$fixture_root/omp-overlay.log"
export FAKE_OMP_MODELS_ENV_LOG="$fixture_root/omp-models-env.log"
export FAKE_OMP_TEMPLATE="$fixture_root/fake-omp-template"
export FAKE_OMP_SIGNAL_LOG="$fixture_root/signal.log"
export FAKE_SECURITY_LOG="$fixture_root/security.log"
export FAKE_GH_LOG="$fixture_root/gh.log"
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
: >"$FAKE_MISE_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_OMP_LOG"
: >"$FAKE_OMP_OVERLAY_LOG"
: >"$FAKE_OMP_MODELS_ENV_LOG"
: >"$FAKE_SECURITY_LOG"
: >"$FAKE_GH_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
runtime_root="$HOME/.local/share/trellage/omp"
command_path="$runtime_root/bin/omp"
installed_catalog="$runtime_root/catalog.json"
installed_ownership="$runtime_root/.managed-by-trellage-omp-profiles"
profile_root="$HOME/.omp/profiles/trellage-qwen-local"
agent_root="$profile_root/agent"
copilot_profile_root="$HOME/.omp/profiles/trellage-copilot-native"
copilot_agent_root="$copilot_profile_root/agent"

local_overlay="$runtime_root/overlays/local.yml"
copilot_overlay="$runtime_root/overlays/copilot.yml"

# Canonical launches must cross the same router boundary users invoke.  Keep
# the private manager available for lifecycle operations and admission, while
# this fixture command supplies the source router with the isolated fixture
# HOME and uses source-mode lifecycle resolution without an admission override.
canonical_omp_command="$fixture_root/trx-run-omp"
cat >"$canonical_omp_command" <<CANONICAL_OMP_COMMAND
#!/usr/bin/env bash
set -euo pipefail
case "\${1-}" in
  local) profile=local; shift ;;
  default|copilot) profile=default; shift ;;
  *) profile=local ;;
esac
exec env \
  TRELLAGE_TRX_SOURCE_ROOT="$root/../trellage-router" \
  TRELLAGE_TRX_NATIVE_SOURCE=1 \
  "$root/../trellage-router/bin/trx" run omp "\$profile" --no-always -- "\$@"
CANONICAL_OMP_COMMAND
chmod 0755 "$canonical_omp_command"

seed_user_state() {
  local profile="$1" label="$2" target
  mkdir -p "$profile/agent" "$profile/sessions" "$profile/agent/cache"
  printf 'tools:\n  approvalMode: ask\nmodelRoles:\n  default: user/%s\nstartup:\n  setupWizard: true\n' "$label" >"$profile/agent/config.yml"
  for target in agent/config.yaml agent/auth.json sessions/session.jsonl agent/cache/state history unrelated-file; do
    printf 'user %s %s\n' "$label" "$target" >"$profile/$target"
  done
}
seed_user_state "$profile_root" local
seed_user_state "$copilot_profile_root" copilot
printf 'providers:\n  user-copilot:\n    baseUrl: https://example.invalid\n' >"$copilot_agent_root/models.yml"
preserved_paths=(
  "$agent_root/config.yml" "$agent_root/config.yaml" "$agent_root/auth.json"
  "$profile_root/sessions/session.jsonl" "$agent_root/cache/state"
  "$profile_root/history" "$profile_root/unrelated-file"
  "$copilot_agent_root/config.yml" "$copilot_agent_root/config.yaml" "$copilot_agent_root/auth.json"
  "$copilot_profile_root/sessions/session.jsonl" "$copilot_agent_root/cache/state"
  "$copilot_profile_root/history" "$copilot_profile_root/unrelated-file"
  "$copilot_agent_root/models.yml"
)
shasum -a 256 "${preserved_paths[@]}" >"$fixture_root/user-state.before"
assert_preserved_state() {
  shasum -a 256 "${preserved_paths[@]}" >"$fixture_root/user-state.after"
  cmp -s "$fixture_root/user-state.before" "$fixture_root/user-state.after" \
    || fail "$1 changed user-owned settings or state"
}

"$command_path" setup --all >"$fixture_root/seeded-setup.out" || fail 'seeded setup failed'
assert_preserved_state setup
for adopted_profile in "$profile_root" "$copilot_profile_root"; do
  grep -Fqx 'trellage-omp-profile-v1' "$adopted_profile/.managed-by-trellage-omp-profiles" \
    || fail 'safe profile adoption did not publish ownership'
done
cat >"$fixture_root/expected-local-models.yml" <<'MODELS'
providers:
  copilot-proxy-rs:
    baseUrl: http://127.0.0.1:8080/v1
    api: openai-responses
    auth: none
    discovery:
      type: openai-models-list
MODELS
cmp -s "$fixture_root/expected-local-models.yml" "$agent_root/models.yml" \
  || fail 'local setup did not publish the exact provider file'

cp "$copilot_overlay" "$fixture_root/inventory-overlay.saved"
printf 'damaged overlay\n' >"$copilot_overlay"
"$command_path" inventory copilot --json >"$fixture_root/unhealthy-overlay-inventory.json" \
  || fail 'unhealthy overlay inventory exited without its JSON response'
jq -se 'length == 1 and .[0].readiness == "unhealthy" and (.[0] | has("harnessVersion") | not)' \
  "$fixture_root/unhealthy-overlay-inventory.json" >/dev/null \
  || fail 'unhealthy overlay inventory did not emit one conservative JSON response'
mv "$fixture_root/inventory-overlay.saved" "$copilot_overlay"
inventory_unhealthy_calls="$fixture_root/inventory-unhealthy-calls"
FAKE_COPILOT_AUTH=0 COPILOT_GITHUB_TOKEN=host-copilot-token \
  FAKE_OMP_EXEC_LOG="$inventory_unhealthy_calls" \
  "$command_path" inventory copilot --json >"$fixture_root/unhealthy-auth-inventory.json" \
  || fail 'unhealthy Copilot authentication inventory exited without its JSON response'
jq -se 'length == 1 and .[0].readiness == "unhealthy" and (.[0] | has("harnessVersion") | not)' \
  "$fixture_root/unhealthy-auth-inventory.json" >/dev/null \
  || fail 'unhealthy authentication inventory did not emit one conservative JSON response'
[[ "$(grep -c -- ' --version$' "$inventory_unhealthy_calls")" == 1 ]] \
  || fail 'unhealthy inventory resolved the host more than once'
[[ "$(grep -c -- ' models github-copilot$' "$inventory_unhealthy_calls")" == 1 ]] \
  || fail 'unhealthy inventory did not use the captured host for its health check'
printf 'OMP unhealthy inventory JSON contract: PASS\n'
if [[ "${OMP_CONTRACT_FINAL_INVENTORY_ONLY:-0}" == 1 ]]; then exit 0; fi

bun --no-env-file "$root/tests/canonical-acceptance.ts" "$fixture_root" "$host_bin/omp" \
  || fail 'literal canonical OMP acceptance failed'
if [[ "${OMP_CONTRACT_FINAL_ACCEPTANCE_ONLY:-0}" == 1 ]]; then exit 0; fi

# Canonical trx runs still exercise the lifecycle manager's initialization
# coordination; mutations below remain private-manager operations.
lock_pause_mv_bin="$fixture_root/lock-pause-mv-bin"
mkdir "$lock_pause_mv_bin"
lock_pause_real_mv="$(command -v mv)"
cat >"$lock_pause_mv_bin/mv" <<'LOCK_PAUSE_MV'
#!/usr/bin/env bash
. "${OMP_FIXTURE_SYNC_HELPER:?}"
set -u
for argument in "$@"; do
  if [[ "$argument" == "$LOCK_PAUSE_DESTINATION" ]]; then
    : >"$LOCK_PAUSE_READY_FILE"
    omp_fixture_wait "$LOCK_PAUSE_RELEASE_FILE" "lock release" || exit $?
  fi
done
exec "$LOCK_PAUSE_REAL_MV" "$@"
LOCK_PAUSE_MV
chmod 0755 "$lock_pause_mv_bin/mv"

printf 'damaged overlay before timezone lock test\n' >"$local_overlay"
timezone_ready="$fixture_root/timezone-lock-ready"
timezone_release="$fixture_root/timezone-lock-release"
timezone_first_signal="$fixture_root/timezone-first-signal"
timezone_second_signal="$fixture_root/timezone-second-signal"
timezone_first_pid=''
timezone_second_pid=''
TZ=UTC PATH="$lock_pause_mv_bin:$host_bin:$fixture_tools_path" \
  LOCK_PAUSE_REAL_MV="$lock_pause_real_mv" LOCK_PAUSE_DESTINATION="$local_overlay" \
  LOCK_PAUSE_READY_FILE="$timezone_ready" LOCK_PAUSE_RELEASE_FILE="$timezone_release" \
  FAKE_OMP_WAIT_FOR_SIGNAL=1 FAKE_OMP_SIGNAL_LOG="$timezone_first_signal" \
  "$canonical_omp_command" local -p timezone-first >"$fixture_root/timezone-first.out" 2>&1 &
timezone_first_pid=$!
wait_for_file "$timezone_ready" 'UTC initializer lock publication'
TZ=America/New_York PATH="$host_bin:$fixture_tools_path" \
  FAKE_OMP_WAIT_FOR_SIGNAL=1 FAKE_OMP_SIGNAL_LOG="$timezone_second_signal" \
  "$canonical_omp_command" local -p timezone-second >"$fixture_root/timezone-second.out" 2>&1 &
timezone_second_pid=$!
sleep 0.2
[[ ! -e "$timezone_second_signal" ]] \
  || fail 'differing-timezone contender stole a live initializer lock'
touch "$timezone_release"
wait_for_file "$timezone_first_signal" 'UTC initializer launch'
wait_for_file "$timezone_second_signal" 'differing-timezone waiter launch'
kill -TERM "$timezone_first_pid" "$timezone_second_pid" 2>/dev/null || true
timezone_first_status=0
timezone_second_status=0
wait "$timezone_first_pid" || timezone_first_status=$?
wait "$timezone_second_pid" || timezone_second_status=$?
[[ "$timezone_first_status" == 143 && "$timezone_second_status" == 143 ]] \
  || fail 'differing-timezone lock test did not cancel both launches cleanly'
"$command_path" repair local >/dev/null || fail 'timezone lock test did not restore the local profile'

lock_pause_rm_bin="$fixture_root/lock-pause-rm-bin"
mkdir "$lock_pause_rm_bin"
lock_pause_real_rm="$(command -v rm)"
cat >"$lock_pause_rm_bin/rm" <<'LOCK_PAUSE_RM'
#!/usr/bin/env bash
. "${OMP_FIXTURE_SYNC_HELPER:?}"
set -u
for argument in "$@"; do
  if [[ "${LOCK_PAUSE_BLOCK:-0}" == 1 && "$argument" == "$LOCK_PAUSE_DESTINATION" ]]; then
    : >"$LOCK_PAUSE_READY_FILE"
    omp_fixture_wait "$LOCK_PAUSE_RELEASE_FILE" "lock release" || exit $?
  fi
done
exec "$LOCK_PAUSE_REAL_RM" "$@"
LOCK_PAUSE_RM
chmod 0755 "$lock_pause_rm_bin/rm"

recovery_lock="$runtime_root/.profile-initialization-local.lock"
recovery_reap="$runtime_root/.profile-initialization-local.reap"
printf '999999 dead 999999-1\n' >"$recovery_lock"
chmod 0600 "$recovery_lock"
printf 'damaged overlay before recovery claim test\n' >"$local_overlay"
recovery_ready="$fixture_root/recovery-claim-ready"
recovery_release="$fixture_root/recovery-claim-release"
recovery_first_signal="$fixture_root/recovery-first-signal"
recovery_second_signal="$fixture_root/recovery-second-signal"
recovery_first_pid=''
recovery_second_pid=''
PATH="$lock_pause_rm_bin:$host_bin:$fixture_tools_path" \
  LOCK_PAUSE_REAL_RM="$lock_pause_real_rm" LOCK_PAUSE_DESTINATION="$recovery_lock" \
  LOCK_PAUSE_READY_FILE="$recovery_ready" LOCK_PAUSE_RELEASE_FILE="$recovery_release" \
  LOCK_PAUSE_BLOCK=1 FAKE_OMP_WAIT_FOR_SIGNAL=1 FAKE_OMP_SIGNAL_LOG="$recovery_first_signal" \
  "$canonical_omp_command" local -p recovery-first >"$fixture_root/recovery-first.out" 2>&1 &
recovery_first_pid=$!
wait_for_file "$recovery_ready" 'first stale-lock claimant'
PATH="$host_bin:$fixture_tools_path" \
  FAKE_OMP_WAIT_FOR_SIGNAL=1 FAKE_OMP_SIGNAL_LOG="$recovery_second_signal" \
  "$canonical_omp_command" local -p recovery-second >"$fixture_root/recovery-second.out" 2>&1 &
recovery_second_pid=$!
sleep 0.2
[[ ! -e "$recovery_second_signal" ]] \
  || fail 'second contender discarded a live stale-lock recovery claim'
[[ -f "$recovery_reap" && ! -L "$recovery_reap" ]] \
  || fail 'stale-lock claimant did not publish its exclusive recovery claim'
touch "$recovery_release"
wait_for_file "$recovery_first_signal" 'first stale-lock recovery launch'
wait_for_file "$recovery_second_signal" 'second stale-lock recovery launch'
kill -TERM "$recovery_first_pid" "$recovery_second_pid" 2>/dev/null || true
recovery_first_status=0
recovery_second_status=0
wait "$recovery_first_pid" || recovery_first_status=$?
wait "$recovery_second_pid" || recovery_second_status=$?
[[ "$recovery_first_status" == 143 && "$recovery_second_status" == 143 ]] \
  || fail 'stale-lock recovery claim test did not cancel both launches cleanly'
[[ ! -e "$recovery_lock" && ! -e "$recovery_reap" ]] \
  || fail 'stale-lock recovery left an initialization lock or claim'
"$command_path" repair local >/dev/null || fail 'stale-lock recovery test did not restore the local profile'

stale_claim_ps_bin="$fixture_root/stale-claim-ps-bin"
mkdir "$stale_claim_ps_bin"
stale_claim_real_ps="$(command -v ps)"
stale_claim_ps_ready="$fixture_root/stale-claim-ps-ready"
stale_claim_ps_release="$fixture_root/stale-claim-ps-release"
stale_claim_process_release="$fixture_root/stale-claim-process-release"
cat >"$stale_claim_ps_bin/ps" <<'STALE_CLAIM_PS'
#!/usr/bin/env bash
. "${OMP_FIXTURE_SYNC_HELPER:?}"
set -u
if [[ "$#" == 4 && "$1" == -p && "$2" == "$STALE_CLAIM_PID" \
  && "$3" == -o && "$4" == lstart= ]]; then
  : >"$STALE_CLAIM_PS_READY"
  omp_fixture_wait "$STALE_CLAIM_PS_RELEASE" "stale claim observation release" || exit $?
fi
exec "$STALE_CLAIM_REAL_PS" "$@"
STALE_CLAIM_PS
chmod 0755 "$stale_claim_ps_bin/ps"

command sleep 30 &
stale_claim_pid=$!
stale_claim_birth="$(TZ=UTC LC_ALL=C ps -p "$stale_claim_pid" -o lstart= | tr -cd '[:alnum:]')"
stale_claim_reap="$runtime_root/.profile-initialization-local.reap"
stale_claim_lock="$runtime_root/.profile-initialization-local.lock"
printf 'damaged overlay before stale recovery claim interleaving test\n' >"$local_overlay"
printf '%s\n' "$stale_claim_pid deadstaleclaim $stale_claim_pid-1" >"$stale_claim_reap"
chmod 0600 "$stale_claim_reap"
printf '999999 deadstalelock 999999-1\n' >"$stale_claim_lock"
chmod 0600 "$stale_claim_lock"
stale_claim_before_log="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
stale_claim_status=0
PATH="$stale_claim_ps_bin:$host_bin:$fixture_tools_path" \
  STALE_CLAIM_PID="$stale_claim_pid" STALE_CLAIM_PS_READY="$stale_claim_ps_ready" \
  STALE_CLAIM_PS_RELEASE="$stale_claim_ps_release" STALE_CLAIM_REAL_PS="$stale_claim_real_ps" \
  "$canonical_omp_command" local -p stale-claim >"$fixture_root/stale-claim.out" 2>&1 &
stale_claim_launcher_pid=$!
wait_for_file "$stale_claim_ps_ready" 'stale recovery claim observation'
printf '%s\n' "$stale_claim_pid $stale_claim_birth $stale_claim_pid-2" >"$stale_claim_reap"
chmod 0600 "$stale_claim_reap"
printf '%s\n' "$stale_claim_pid $stale_claim_birth $stale_claim_pid-3" >"$stale_claim_lock"
chmod 0600 "$stale_claim_lock"
touch "$stale_claim_ps_release"
wait "$stale_claim_launcher_pid" || stale_claim_status=$?
[[ "$stale_claim_status" -ne 0 ]] \
  || fail 'stale recovery claim interleaving unexpectedly succeeded'
grep -Fq 'omp: stale profile initialization recovery: local' "$fixture_root/stale-claim.out" \
  || fail 'stale recovery claim interleaving did not report stale profile initialization recovery'
grep -Fqx "$stale_claim_pid $stale_claim_birth $stale_claim_pid-2" "$stale_claim_reap" \
  || fail 'stale recovery claim interleaving deleted the replacement claim'
grep -Fqx "$stale_claim_pid $stale_claim_birth $stale_claim_pid-3" "$stale_claim_lock" \
  || fail 'stale recovery claim interleaving deleted the replacement lock'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$stale_claim_before_log" ]] \
  || fail 'stale recovery claim interleaving launched OMP after refusing recovery'
rm -f -- "$stale_claim_reap" "$stale_claim_lock"
touch "$stale_claim_process_release"
cleanup_stale_claim_process
"$command_path" repair local >/dev/null || fail 'stale recovery claim test did not restore the local profile'

reap_claim="$runtime_root/.profile-initialization-local.reap"
reap_target="$fixture_root/reap-target"
reap_stale_birth=TueFeb291010102000
printf 'redirected claim must survive\n' >"$reap_target"
printf '99999 %s 99999-1\n' "$reap_stale_birth" >"$reap_claim"
chmod 0600 "$reap_claim"
"$command_path" reap local >"$fixture_root/reap-valid.out" \
  || fail 'reap did not remove a validated stale claim'
[[ ! -e "$reap_claim" ]] || fail 'reap left a validated stale claim'

for reap_extra_bytes in trailing-junk embedded-nul extra-newline; do
  case "$reap_extra_bytes" in
    trailing-junk) printf '99999 %s 99999-1\ntrailing-junk' "$reap_stale_birth" >"$reap_claim" ;;
    embedded-nul) printf '99999 %s 99999-1\0\n' "$reap_stale_birth" >"$reap_claim" ;;
    extra-newline) printf '99999 %s 99999-1\n\n' "$reap_stale_birth" >"$reap_claim" ;;
  esac
  chmod 0600 "$reap_claim"
  cp "$reap_claim" "$fixture_root/reap-$reap_extra_bytes.expected"
  if "$command_path" reap local >"$fixture_root/reap-$reap_extra_bytes.out" 2>&1; then
    fail "reap accepted $reap_extra_bytes in the claim"
  fi
  cmp -s "$fixture_root/reap-$reap_extra_bytes.expected" "$reap_claim" \
    || fail "reap changed a claim with $reap_extra_bytes"
  grep -Fqx 'omp: malformed profile initialization recovery claim: local' \
    "$fixture_root/reap-$reap_extra_bytes.out" \
    || fail "reap $reap_extra_bytes diagnostic differs"
  rm -f -- "$reap_claim"
done

reap_live_pid=""
command sleep 30 &
reap_live_pid=$!
reap_live_birth="$(TZ=UTC LC_ALL=C ps -p "$reap_live_pid" -o lstart= | tr -cd '[:alnum:]')"
printf '%s %s %s-1\n' "$reap_live_pid" "$reap_live_birth" "$reap_live_pid" >"$reap_claim"
chmod 0600 "$reap_claim"
if "$command_path" reap local >"$fixture_root/reap-live.out" 2>&1; then
  fail 'reap removed a live claim'
fi
grep -Fqx 'omp: profile initialization claim is live: local' "$fixture_root/reap-live.out" \
  || fail 'reap live-claim diagnostic differs'
grep -Fqx "$reap_live_pid $reap_live_birth $reap_live_pid-1" "$reap_claim" \
  || fail 'reap changed a live claim'
kill "$reap_live_pid" 2>/dev/null || true
wait "$reap_live_pid" 2>/dev/null || true

for reap_invalid in malformed malformed-birth impossible-birth wrong-mode; do
  case "$reap_invalid" in
    malformed) printf 'not a claim\n' >"$reap_claim"; chmod 0600 "$reap_claim" ;;
    malformed-birth) printf '99999 stalebirth 99999-1\n' >"$reap_claim"; chmod 0600 "$reap_claim" ;;
    impossible-birth) printf '99999 SunFeb301010102000 99999-1\n' >"$reap_claim"; chmod 0600 "$reap_claim" ;;
    wrong-mode)
      printf '%s %s %s-1\n' "$reap_live_pid" "$reap_live_birth" "$reap_live_pid" >"$reap_claim"
      chmod 0644 "$reap_claim"
      ;;
  esac
  if "$command_path" reap local >"$fixture_root/reap-$reap_invalid.out" 2>&1; then
    fail "reap accepted $reap_invalid claim"
  fi
  [[ -e "$reap_claim" ]] || fail "reap removed $reap_invalid claim"
  if [[ "$reap_invalid" == *birth ]]; then
    grep -Fqx 'omp: malformed profile initialization recovery claim: local' \
      "$fixture_root/reap-$reap_invalid.out" || fail "reap $reap_invalid diagnostic differs"
  fi
done

for reap_token_case in token-dashes token-pid-mismatch; do
  case "$reap_token_case" in
    token-dashes) printf '99999 %s ---\n' "$reap_stale_birth" >"$reap_claim" ;;
    token-pid-mismatch) printf '99999 %s 99998-1\n' "$reap_stale_birth" >"$reap_claim" ;;
  esac
  chmod 0600 "$reap_claim"
  if "$command_path" reap local >"$fixture_root/reap-$reap_token_case.out" 2>&1; then
    fail "reap accepted $reap_token_case claim"
  fi
  [[ -e "$reap_claim" ]] || fail "reap removed $reap_token_case claim"
done

reap_uncertain_ps_bin="$fixture_root/reap-uncertain-ps-bin"
mkdir "$reap_uncertain_ps_bin"
reap_uncertain_real_ps="$(command -v ps)"
cat >"$reap_uncertain_ps_bin/ps" <<'REAP_UNCERTAIN_PS'
#!/usr/bin/env bash
set -u
if [[ "$#" == 4 && "$1" == -p && "$2" == 99999 \
  && "$3" == -o && "$4" == lstart= ]]; then
  printf 'permission denied\n' >&2
  exit 77
fi
exec "$REAP_UNCERTAIN_REAL_PS" "$@"
REAP_UNCERTAIN_PS
chmod 0755 "$reap_uncertain_ps_bin/ps"
printf '99999 %s 99999-4\n' "$reap_stale_birth" >"$reap_claim"
chmod 0600 "$reap_claim"
if PATH="$reap_uncertain_ps_bin:$host_bin:$fixture_tools_path" \
  REAP_UNCERTAIN_REAL_PS="$reap_uncertain_real_ps" \
  "$command_path" reap local >"$fixture_root/reap-uncertain.out" 2>&1; then
  fail 'reap treated process inspection failure as stale'
fi
grep -Fqx 'omp: could not verify profile initialization claim identity: local' \
  "$fixture_root/reap-uncertain.out" || fail 'reap inspection-uncertainty diagnostic differs'
[[ -e "$reap_claim" ]] || fail 'reap removed claim after process inspection failure'

reap_silent_ps_bin="$fixture_root/reap-silent-ps-bin"
mkdir "$reap_silent_ps_bin"
cat >"$reap_silent_ps_bin/ps" <<'REAP_SILENT_PS'
#!/usr/bin/env bash
set -u
if [[ "$#" == 4 && "$1" == -p && "$2" == "$REAP_SILENT_PID" \
  && "$3" == -o && "$4" == lstart= ]]; then
  exit "${REAP_SILENT_STATUS:-77}"
fi
exec "$REAP_SILENT_REAL_PS" "$@"
REAP_SILENT_PS
chmod 0755 "$reap_silent_ps_bin/ps"
for reap_silent_status in 77 0; do
  command sleep 30 &
  reap_silent_pid=$!
  reap_silent_birth="$(TZ=UTC LC_ALL=C ps -p "$reap_silent_pid" -o lstart= | tr -cd '[:alnum:]')"
  printf '%s %s %s-6\n' "$reap_silent_pid" "$reap_silent_birth" "$reap_silent_pid" >"$reap_claim"
  chmod 0600 "$reap_claim"
  if PATH="$reap_silent_ps_bin:$host_bin:$fixture_tools_path" \
    REAP_SILENT_PID="$reap_silent_pid" REAP_SILENT_STATUS="$reap_silent_status" \
    REAP_SILENT_REAL_PS="$reap_uncertain_real_ps" \
    "$command_path" reap local >"$fixture_root/reap-silent-$reap_silent_status.out" 2>&1; then
    fail "reap treated silent ps status $reap_silent_status as stale"
  fi
  grep -Fqx 'omp: could not verify profile initialization claim identity: local' \
    "$fixture_root/reap-silent-$reap_silent_status.out" \
    || fail "reap silent ps status $reap_silent_status diagnostic differs"
  grep -Fqx "$reap_silent_pid $reap_silent_birth $reap_silent_pid-6" "$reap_claim" \
    || fail "reap changed live claim after silent ps status $reap_silent_status"
  kill "$reap_silent_pid" 2>/dev/null || true
  wait "$reap_silent_pid" 2>/dev/null || true
done

reap_zero_diag_ps_bin="$fixture_root/reap-zero-diag-ps-bin"
mkdir "$reap_zero_diag_ps_bin"
cat >"$reap_zero_diag_ps_bin/ps" <<'REAP_ZERO_DIAG_PS'
#!/usr/bin/env bash
set -u
if [[ "$#" == 4 && "$1" == -p && "$2" == "$REAP_ZERO_DIAG_PID" \
  && "$3" == -o && "$4" == lstart= ]]; then
  printf 'permission denied\n' >&2
  exit 0
fi
exec "$REAP_ZERO_DIAG_REAL_PS" "$@"
REAP_ZERO_DIAG_PS
chmod 0755 "$reap_zero_diag_ps_bin/ps"
command sleep 30 &
reap_zero_diag_pid=$!
reap_zero_diag_birth="$(TZ=UTC LC_ALL=C ps -p "$reap_zero_diag_pid" -o lstart= | tr -cd '[:alnum:]')"
printf '%s %s %s-7\n' "$reap_zero_diag_pid" "$reap_zero_diag_birth" "$reap_zero_diag_pid" >"$reap_claim"
chmod 0600 "$reap_claim"
if PATH="$reap_zero_diag_ps_bin:$host_bin:$fixture_tools_path" \
  REAP_ZERO_DIAG_PID="$reap_zero_diag_pid" REAP_ZERO_DIAG_REAL_PS="$reap_uncertain_real_ps" \
  "$command_path" reap local >"$fixture_root/reap-zero-diag.out" 2>&1; then
  fail 'reap treated zero-status ps diagnostic as stale'
fi
grep -Fqx 'omp: could not verify profile initialization claim identity: local' \
  "$fixture_root/reap-zero-diag.out" \
  || fail 'reap zero-status ps diagnostic differs'
grep -Fqx "$reap_zero_diag_pid $reap_zero_diag_birth $reap_zero_diag_pid-7" "$reap_claim" \
  || fail 'reap changed live claim after zero-status ps diagnostic'
kill "$reap_zero_diag_pid" 2>/dev/null || true
wait "$reap_zero_diag_pid" 2>/dev/null || true

reap_bad_row_ps_bin="$fixture_root/reap-bad-row-ps-bin"
mkdir "$reap_bad_row_ps_bin"
cat >"$reap_bad_row_ps_bin/ps" <<'REAP_BAD_ROW_PS'
#!/usr/bin/env bash
set -u
if [[ "$#" == 4 && "$1" == -p && "$2" == "$REAP_BAD_ROW_PID" \
  && "$3" == -o && "$4" == lstart= ]]; then
  case "$REAP_BAD_ROW_CASE" in
    split-row) printf 'Sun Oct 10 10:10:10\n2027\n' ;;
    blank-row) printf 'Sun Oct 10 10:10:10 2027\n\n' ;;
    impossible-date) printf 'Sun Feb 30 10:10:10 2027\n' ;;
    impossible-time) printf 'Sat Oct 10 25:61:61 2026\n' ;;
    wrong-weekday) printf 'Sun Oct 10 10:10:10 2026\n' ;;
  esac
  exit 0
fi
exec "$REAP_BAD_ROW_REAL_PS" "$@"
REAP_BAD_ROW_PS
chmod 0755 "$reap_bad_row_ps_bin/ps"
command sleep 30 &
reap_bad_row_pid=$!
reap_bad_row_birth="$(TZ=UTC LC_ALL=C ps -p "$reap_bad_row_pid" -o lstart= | tr -cd '[:alnum:]')"
printf '%s %s %s-8\n' "$reap_bad_row_pid" "$reap_bad_row_birth" "$reap_bad_row_pid" >"$reap_claim"
chmod 0600 "$reap_claim"
cp "$reap_claim" "$fixture_root/reap-bad-row.expected"
for reap_bad_row_case in split-row blank-row impossible-date impossible-time wrong-weekday; do
  if PATH="$reap_bad_row_ps_bin:$host_bin:$fixture_tools_path" \
    REAP_BAD_ROW_PID="$reap_bad_row_pid" REAP_BAD_ROW_CASE="$reap_bad_row_case" \
    REAP_BAD_ROW_REAL_PS="$reap_uncertain_real_ps" \
    "$command_path" reap local >"$fixture_root/reap-bad-row-$reap_bad_row_case.out" 2>&1; then
    fail "reap treated $reap_bad_row_case ps stdout as a stale live claim"
  fi
  grep -Fqx 'omp: could not verify profile initialization claim identity: local' \
    "$fixture_root/reap-bad-row-$reap_bad_row_case.out" \
    || fail "reap $reap_bad_row_case diagnostic differs"
  cmp -s "$fixture_root/reap-bad-row.expected" "$reap_claim" \
    || fail "reap changed live claim after $reap_bad_row_case ps stdout"
done
kill "$reap_bad_row_pid" 2>/dev/null || true
wait "$reap_bad_row_pid" 2>/dev/null || true

reap_collision_mv_bin="$fixture_root/reap-collision-mv-bin"
mkdir "$reap_collision_mv_bin"
reap_collision_real_mv="$(command -v mv)"
cat >"$reap_collision_mv_bin/mv" <<'REAP_COLLISION_MV'
#!/usr/bin/env bash
set -u
destination="${!#}"
if [[ "$destination" == */.profile-initialization-local.reap.*/claim ]]; then
  if [[ "${REAP_STAGE_FAIL:-0}" == 1 ]]; then
    exit 73
  fi
  if [[ "${REAP_COLLISION:-0}" == directory ]]; then
    mkdir "$destination"
  elif [[ "${REAP_COLLISION:-0}" == file ]]; then
    printf 'planted staging collision\n' >"$destination"
  fi
fi
exec "$REAP_COLLISION_REAL_MV" "$@"
REAP_COLLISION_MV
chmod 0755 "$reap_collision_mv_bin/mv"
printf '99999 %s 99999-5\n' "$reap_stale_birth" >"$reap_claim"
chmod 0600 "$reap_claim"
if PATH="$reap_collision_mv_bin:$host_bin:$fixture_tools_path" \
  REAP_STAGE_FAIL=1 REAP_COLLISION_REAL_MV="$reap_collision_real_mv" \
  "$command_path" reap local >"$fixture_root/reap-stage-fail.out" 2>&1; then
  fail 'reap accepted failed staging'
fi
grep -Fqx "99999 $reap_stale_birth 99999-5" "$reap_claim" \
  || fail 'reap changed the claim after failed staging'
[[ -z "$(find "$runtime_root" -type d -name '.profile-initialization-local.reap.*' -print -quit)" ]] \
  || fail 'reap left an empty private staging directory after failed staging'
if PATH="$reap_collision_mv_bin:$host_bin:$fixture_tools_path" \
  REAP_COLLISION=file REAP_COLLISION_REAL_MV="$reap_collision_real_mv" \
  "$command_path" reap local >"$fixture_root/reap-collision.out" 2>&1; then
  fail 'reap overwrote a planted staging collision'
fi
grep -Fqx "99999 $reap_stale_birth 99999-5" "$reap_claim" \
  || fail 'reap changed the claim after staging collision'
grep -Fqx 'planted staging collision' \
  <(find "$runtime_root" -path '*/.profile-initialization-local.reap.*/claim' -type f \
    -exec cat {} \; | head -n 1) \
  || fail 'reap removed the planted staging collision'
if PATH="$reap_collision_mv_bin:$host_bin:$fixture_tools_path" \
  REAP_COLLISION=directory REAP_COLLISION_REAL_MV="$reap_collision_real_mv" \
  "$command_path" reap local >"$fixture_root/reap-directory-collision.out" 2>&1; then
  fail 'reap accepted a planted staging directory'
fi
[[ -f "$reap_claim" && ! -L "$reap_claim" ]] \
  || fail 'reap displaced the claim with a planted staging directory'
grep -Fqx "99999 $reap_stale_birth 99999-5" "$reap_claim" \
  || fail 'reap changed the claim after staging directory collision'
reap_nested_claim="$(find "$runtime_root" \
  -path '*/.profile-initialization-local.reap.*/claim/.profile-initialization-local.reap' \
  -type f -print -quit)"
[[ -n "$reap_nested_claim" ]] && cmp -s "$reap_claim" "$reap_nested_claim" \
  || fail 'reap changed the original claim in the planted staging directory'

rm -f -- "$reap_claim"
ln -s "$reap_target" "$reap_claim"
if "$command_path" reap local >"$fixture_root/reap-redirected.out" 2>&1; then
  fail 'reap accepted a redirected claim'
fi
[[ -L "$reap_claim" ]] || fail 'reap removed a redirected claim'
grep -Fqx 'redirected claim must survive' "$reap_target" || fail 'reap changed redirected claim content'
rm -f -- "$reap_claim"

reap_race_ps_bin="$fixture_root/reap-race-ps-bin"
mkdir "$reap_race_ps_bin"
reap_race_real_ps="$(command -v ps)"
reap_race_ps_ready="$fixture_root/reap-race-ps-ready"
reap_race_ps_release="$fixture_root/reap-race-ps-release"
cat >"$reap_race_ps_bin/ps" <<'REAP_RACE_PS'
#!/usr/bin/env bash
. "${OMP_FIXTURE_SYNC_HELPER:?}"
set -u
if [[ "$#" == 4 && "$1" == -p && "$2" == "$REAP_RACE_PID" \
  && "$3" == -o && "$4" == lstart= ]]; then
  : >"$REAP_RACE_PS_READY"
  omp_fixture_wait "$REAP_RACE_PS_RELEASE" "reap race release" || exit $?
fi
exec "$REAP_RACE_REAL_PS" "$@"
REAP_RACE_PS
chmod 0755 "$reap_race_ps_bin/ps"
command sleep 30 &
reap_race_pid=$!
reap_race_birth="$(TZ=UTC LC_ALL=C ps -p "$reap_race_pid" -o lstart= | tr -cd '[:alnum:]')"
printf '%s %s %s-3\n' "$reap_race_pid" "$reap_stale_birth" "$reap_race_pid" >"$reap_claim"
chmod 0600 "$reap_claim"
reap_race_status=0
PATH="$reap_race_ps_bin:$host_bin:$fixture_tools_path" \
  REAP_RACE_PID="$reap_race_pid" REAP_RACE_PS_READY="$reap_race_ps_ready" \
  REAP_RACE_PS_RELEASE="$reap_race_ps_release" REAP_RACE_REAL_PS="$reap_race_real_ps" \
  "$command_path" reap local >"$fixture_root/reap-race.out" 2>&1 &
reap_race_launcher_pid=$!
wait_for_file "$reap_race_ps_ready" 'reap replacement race observation'
printf '%s %s %s-2\n' "$reap_race_pid" "$reap_race_birth" "$reap_race_pid" >"$reap_claim"
chmod 0600 "$reap_claim"
touch "$reap_race_ps_release"
wait "$reap_race_launcher_pid" || reap_race_status=$?
[[ "$reap_race_status" -ne 0 ]] || fail 'reap succeeded after claim replacement race'
grep -Fqx "$reap_race_pid $reap_race_birth $reap_race_pid-2" "$reap_claim" \
  || fail 'reap deleted or changed the replacement claim'
rm -f -- "$reap_race_ps_ready" "$reap_race_ps_release"
printf '%s %s %s-3\n' "$reap_race_pid" "$reap_stale_birth" "$reap_race_pid" >"$reap_claim"
chmod 0600 "$reap_claim"
reap_race_status=0
PATH="$reap_race_ps_bin:$host_bin:$fixture_tools_path" \
  REAP_RACE_PID="$reap_race_pid" REAP_RACE_PS_READY="$reap_race_ps_ready" \
  REAP_RACE_PS_RELEASE="$reap_race_ps_release" REAP_RACE_REAL_PS="$reap_race_real_ps" \
  "$command_path" reap local >"$fixture_root/reap-identical-race.out" 2>&1 &
reap_race_launcher_pid=$!
wait_for_file "$reap_race_ps_ready" 'reap identical replacement race observation'
cp -p "$reap_claim" "$fixture_root/reap-identical-replacement"
mv -f -- "$fixture_root/reap-identical-replacement" "$reap_claim"
reap_replacement_identity="$(file_identity "$reap_claim")" || fail 'could not read replacement claim identity'
touch "$reap_race_ps_release"
wait "$reap_race_launcher_pid" || reap_race_status=$?
[[ "$reap_race_status" -ne 0 ]] || fail 'reap deleted an identical replacement claim'
grep -Fqx "$reap_race_pid $reap_stale_birth $reap_race_pid-3" "$reap_claim" \
  || fail 'reap deleted or changed an identical replacement claim'
[[ "$(file_identity "$reap_claim")" \
  == "$reap_replacement_identity" ]] || fail 'reap replaced an identical replacement claim'
kill "$reap_race_pid" 2>/dev/null || true
wait "$reap_race_pid" 2>/dev/null || true
rm -f -- "$reap_claim"
printf 'OMP stale-claim recovery contract: PASS\n'
[[ "${OMP_CONTRACT_TASK_13_ONLY:-0}" != 1 ]] || exit 0

profile_state_hashes() {
  local path
  while IFS= read -r path; do shasum -a 256 "$path"; done \
    < <(find "$HOME/.omp" -type f | LC_ALL=C sort)
  find "$HOME/.omp" -type l -exec ls -ld {} \;
}


printf 'user changed local provider\n' >"$agent_root/models.yml"
if "$command_path" doctor local >"$fixture_root/local-models-drift.out" 2>&1; then
  fail 'doctor accepted changed local provider'
fi
grep -Fq 'managed models config differs' "$fixture_root/local-models-drift.out" \
  || fail 'doctor did not identify local provider drift'
"$command_path" repair local >"$fixture_root/local-models-repair.out" \
  || fail 'owned local provider repair failed'
cmp -s "$fixture_root/expected-local-models.yml" "$agent_root/models.yml" \
  || fail 'local repair did not restore the exact provider file'
"$command_path" repair copilot >"$fixture_root/copilot-models-repair.out" \
  || fail 'Copilot repair failed with arbitrary provider file'
assert_preserved_state 'provider repair'

printf 'previous local provider\n' >"$agent_root/models.yml"
printf 'previous overlay\n' >"$local_overlay"
transaction_manifest() {
  publication_manifest "$runtime_root" "$profile_root" "$copilot_profile_root"
}
publication_manifest() {
  local directory mode
  find "$@" -type f -exec shasum -a 256 {} + | LC_ALL=C sort
  while IFS= read -r directory; do
    if ! mode="$(stat -f '%Lp' "$directory" 2>/dev/null)"; then
      mode="$(stat -c '%a' "$directory")"
    fi
    printf 'directory %s %s\n' "$mode" "$directory"
  done < <(find "$@" -type d | LC_ALL=C sort)
}
transaction_manifest >"$fixture_root/provider-transaction.before"
fault_bin="$fixture_root/provider-fault-bin"
mkdir "$fault_bin"
real_mv="$(command -v mv)"
cat >"$fault_bin/mv" <<'FAULT_MV'
#!/usr/bin/env bash
for argument in "$@"; do
  if [[ "$argument" == "$FAIL_PROVIDER_DESTINATION" ]]; then
    printf 'injected profile publication failure\n' >&2
    exit 73
  fi
done
exec "$REAL_MV" "$@"
FAULT_MV
chmod +x "$fault_bin/mv"
for operation in setup repair; do
  if PATH="$fault_bin:$PATH" REAL_MV="$real_mv" FAIL_PROVIDER_DESTINATION="$agent_root/models.yml" \
    "$command_path" "$operation" local >"$fixture_root/provider-failure-$operation.out" 2>&1; then
    fail "$operation accepted failed local provider publication"
  fi
  grep -Fq 'injected profile publication failure' "$fixture_root/provider-failure-$operation.out" \
    || fail "$operation did not reach the provider publication fault"
  transaction_manifest >"$fixture_root/provider-transaction.after"
  cmp -s "$fixture_root/provider-transaction.before" "$fixture_root/provider-transaction.after" \
    || fail "$operation provider publication failure changed state or leaked staging files"
done
real_mktemp="$(command -v mktemp)"
cat >"$fault_bin/mktemp" <<'FAULT_MKTEMP'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    */overlays/.local.XXXXXX) stage_kind=overlay ;;
    */.profile-marker.XXXXXX) stage_kind=marker ;;
    *) continue ;;
  esac
  if [[ "$stage_kind" == "${FAIL_PUBLICATION_STAGE:-}" ]]; then
    printf 'injected profile staging failure\n' >&2
    exit 74
  fi
done
exec "$REAL_MKTEMP" "$@"
FAULT_MKTEMP
chmod +x "$fault_bin/mktemp"

for failure_kind in overlay-move marker-move overlay-stage marker-stage; do
  failure_destination=''
  failure_stage=''
  case "$failure_kind" in
    overlay-move) failure_destination="$local_overlay" ;;
    marker-move) failure_destination="$profile_root/.managed-by-trellage-omp-profiles" ;;
    overlay-stage) failure_stage=overlay ;;
    marker-stage) failure_stage=marker ;;
  esac
  chmod 0755 "$profile_root" "$agent_root" "$runtime_root/overlays"
  transaction_manifest >"$fixture_root/later-publication.before"
  if PATH="$fault_bin:$PATH" REAL_MV="$real_mv" REAL_MKTEMP="$real_mktemp" \
    FAIL_PROVIDER_DESTINATION="$failure_destination" FAIL_PUBLICATION_STAGE="$failure_stage" \
    "$command_path" repair local >"$fixture_root/owned-repair-$failure_kind.out" 2>&1; then
    fail "owned repair accepted $failure_kind publication failure"
  fi
  grep -Eq 'injected profile (publication|staging) failure' "$fixture_root/owned-repair-$failure_kind.out" \
    || fail "owned repair did not reach $failure_kind publication fault"
  transaction_manifest >"$fixture_root/later-publication.after"
  cmp -s "$fixture_root/later-publication.before" "$fixture_root/later-publication.after" \
    || fail "owned repair $failure_kind publication failure changed prior files, directories, or modes"
done
"$command_path" repair local >/dev/null || fail 'repair after provider publication fault failed'

for failure_kind in overlay-move marker-move overlay-stage marker-stage; do
  failure_home="$fixture_root/fresh-publication-$failure_kind"
  mkdir "$failure_home"
  seed_floating_skills_cache "$failure_home"
  seed_community_skills_cache "$failure_home/.local/share/trellage/common/omp-community-skills"
  failure_profile="$failure_home/.omp/profiles/trellage-qwen-local"
  failure_destination=''
  failure_stage=''
  case "$failure_kind" in
    overlay-move) failure_destination="$local_overlay" ;;
    marker-move) failure_destination="$failure_profile/.managed-by-trellage-omp-profiles" ;;
    overlay-stage) failure_stage=overlay ;;
    marker-stage) failure_stage=marker ;;
  esac
  publication_manifest "$runtime_root" "$failure_home" >"$fixture_root/fresh-publication.before"
  if HOME="$failure_home" PATH="$fault_bin:$PATH" REAL_MV="$real_mv" REAL_MKTEMP="$real_mktemp" \
    FAIL_PROVIDER_DESTINATION="$failure_destination" FAIL_PUBLICATION_STAGE="$failure_stage" \
    "$command_path" setup local >"$fixture_root/fresh-setup-$failure_kind.out" 2>&1; then
    fail "fresh setup accepted $failure_kind publication failure"
  fi
  grep -Eq 'injected profile (publication|staging) failure' "$fixture_root/fresh-setup-$failure_kind.out" \
    || fail "fresh setup did not reach $failure_kind publication fault"
  publication_manifest "$runtime_root" "$failure_home" >"$fixture_root/fresh-publication.after"
  cmp -s "$fixture_root/fresh-publication.before" "$fixture_root/fresh-publication.after" \
    || fail "fresh setup $failure_kind publication failure changed prior state or leaked directories"
  HOME="$failure_home" "$command_path" setup local >"$fixture_root/fresh-setup-$failure_kind-retry.out" \
    || fail "fresh setup could not retry after $failure_kind publication failure"
  cmp -s "$fixture_root/expected-local-models.yml" "$failure_profile/agent/models.yml" \
    || fail "fresh setup retry did not restore the provider after $failure_kind"
  grep -Fqx 'trellage-omp-profile-v1' "$failure_profile/.managed-by-trellage-omp-profiles" \
    || fail "fresh setup retry did not mark ownership after $failure_kind"
  "$command_path" repair local >/dev/null || fail 'could not restore main profile after fresh setup retry'
done

[[ -x "$command_path" && ! -L "$command_path" ]] \
  || fail 'installer did not publish the owned runtime command'
[[ -f "$installed_ownership" \
  && "$(<"$installed_ownership")" == 'trellage-omp-profiles-v2' ]] \
  || fail 'installer did not publish the current runtime ownership generation'
cmp -s "$installed_catalog" "$root/catalog.json" \
  || fail 'installer did not publish the OMP catalog'

"$command_path" harness-version >"$fixture_root/host-version.json" \
  || fail 'live host version failed before setup'
jq -e '.installed == "18.0.11"' "$fixture_root/host-version.json" >/dev/null \
  || fail 'harness-version did not report the live host before setup'
[[ ! -e "$runtime_root/installed-version" && ! -e "$runtime_root/version" ]] \
  || fail 'harness-version created a receipt'

wrapper_alias="$fixture_root/wrapper-alias"
mkdir -p "$wrapper_alias"
ln -s "$command_path" "$wrapper_alias/omp"
for resolver_path in \
  "${command_path%/*}:$host_bin:$fixture_tools_path" \
  "$wrapper_alias:$host_bin:$fixture_tools_path" \
  "$wrapper_alias:${command_path%/*}:${command_path%/*}:$host_bin:$fixture_tools_path"; do
  PATH="$resolver_path" "$command_path" harness-version \
    >"$fixture_root/resolver-version.json" || fail 'wrapper skipping host resolution failed'
  jq -e '.installed == "18.0.11"' "$fixture_root/resolver-version.json" \
    >/dev/null || fail 'resolver did not select the expected host version'
done

malformed_bin="$fixture_root/malformed-bin"
publish_host_omp "$malformed_bin" not-omp
resolver_calls_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
if PATH="$malformed_bin:$host_bin:$fixture_tools_path" "$command_path" harness-version \
  >"$fixture_root/invalid-host.out" 2>&1; then
  fail 'resolver accepted a malformed first host candidate'
fi
grep -Fq "$malformed_bin/omp" "$fixture_root/invalid-host.out" \
  || fail 'malformed host diagnostic omitted its path'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$resolver_calls_before" ]] \
  || fail 'resolver launched a later valid candidate after malformed host'

if PATH="${command_path%/*}:$wrapper_alias:$fixture_tools_path" "$command_path" harness-version \
  >"$fixture_root/missing-host.out" 2>&1; then
  fail 'resolver accepted a missing host binary'
fi
for guidance in Bun Homebrew mise; do
  grep -Fq "$guidance" "$fixture_root/missing-host.out" \
    || fail "missing host diagnostic omitted $guidance installation guidance"
done
PATH="${command_path%/*}:$fixture_tools_path" "$command_path" inventory local --json \
  >"$fixture_root/missing-host-inventory.json" || fail 'missing host inventory failed'
jq -e '.readiness != "healthy" and (has("harnessVersion") | not)' \
  "$fixture_root/missing-host-inventory.json" >/dev/null \
  || fail 'missing host inventory invented a harness version'

publish_host_omp "$host_bin" 18.0.12
"$command_path" harness-version >"$fixture_root/refreshed-host.json" \
  || fail 'resolver did not resolve a replaced host binary'
jq -e '.installed == "18.0.12"' "$fixture_root/refreshed-host.json" >/dev/null \
  || fail 'resolver reused an old host version'
"$command_path" inventory local --json >"$fixture_root/host-inventory.json" \
  || fail 'healthy host inventory failed'
jq -e '.readiness == "healthy" and .harnessVersion == "18.0.12"' \
  "$fixture_root/host-inventory.json" >/dev/null || fail 'inventory did not report the live host version'
publish_host_omp "$host_bin" 18.0.11

toctou_old_bin="$fixture_root/toctou-old-bin"
toctou_new_bin="$fixture_root/toctou-new-bin"
toctou_path_one="$fixture_root/toctou-path-one"
toctou_path_two="$fixture_root/toctou-path-two"
publish_host_omp "$toctou_old_bin" 18.0.11
publish_host_omp "$toctou_new_bin" 18.8.4
sed -i.bak 's/@IDENTITY@/A/g' "$toctou_old_bin/omp"
rm -f -- "$toctou_old_bin/omp.bak"
sed -i.bak 's/@IDENTITY@/B/g' "$toctou_new_bin/omp"
rm -f -- "$toctou_new_bin/omp.bak"
mkdir "$toctou_path_one" "$toctou_path_two"
ln -s "$toctou_old_bin/omp" "$toctou_path_one/omp"
ln -s "$toctou_new_bin/omp" "$toctou_path_two/omp"
toctou_swap_marker="$fixture_root/toctou-swap-marker"
toctou_exec_log="$fixture_root/toctou-exec-log"
COPILOT_GITHUB_TOKEN=host-copilot-token \
FAKE_OMP_REMOVE_PATH="$toctou_path_one/omp" \
FAKE_OMP_SWAP_MARKER="$toctou_swap_marker" FAKE_OMP_EXEC_LOG="$toctou_exec_log" \
  PATH="$toctou_path_one:$toctou_path_two:$fixture_tools_path" \
  "$command_path" inventory copilot --json >"$fixture_root/toctou-inventory.json" \
  || fail 'inventory failed during host executable replacement'
jq -e '.readiness == "healthy" and .profile == "copilot" and .harnessVersion == "18.0.11"' \
  "$fixture_root/toctou-inventory.json" >/dev/null \
  || fail 'inventory did not retain its captured host executable/version'
grep -Fqx removed "$toctou_swap_marker" \
  || fail 'PATH executable removal was not observed'
[[ "$(tail -n 1 "$toctou_exec_log")" == 'A models github-copilot' ]] \
  || fail 'Copilot doctor did not invoke the captured host executable'
printf 'OMP host resolver and live version contract: PASS\n'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON profile list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "omp"
  and .harness == "oh-my-pi"
  and [.profiles[].name] == ["copilot", "local"]
  and all(.profiles[]; .plugin == null)
  and all(.profiles[]; .headless == {
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
  })
  and (.profiles[] | select(.name == "copilot") | .description) == "OMP for tool-rich, typed-subagent engineering with native GitHub Copilot authentication and its discovered model catalog."
  and (.profiles[] | select(.name == "local") | .description) == "OMP for keyless local-model engineering: one Qwen route serves every model role while retaining OMP tools and typed subagents."
' "$fixture_root/list.json" >/dev/null || fail 'JSON profile list differs'

cp "$runtime_root/catalog.json" "$fixture_root/catalog.saved" || fail 'could not save catalog'
jq '.profiles.local.headless.questionToolControl = "invalid"' "$runtime_root/catalog.json" \
  >"$fixture_root/catalog.invalid" || fail 'could not create invalid catalog'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json >"$fixture_root/invalid-list.out" 2>"$fixture_root/invalid-list.err"; then
  fail 'list accepted invalid headless catalog'
fi
grep -Fq 'omp: invalid catalog:' "$fixture_root/invalid-list.err" \
  || fail 'invalid headless catalog diagnostic differs'
jq '.profiles.local.headless.trellageEventContract = "unsupported-trellage-events-v1"' \
  "$fixture_root/catalog.saved" >"$fixture_root/catalog.invalid" \
  || fail 'could not create invalid Trellage event contract'
mv "$fixture_root/catalog.invalid" "$runtime_root/catalog.json"
if "$command_path" list --json \
  >"$fixture_root/invalid-trellage-event-list.out" \
  2>"$fixture_root/invalid-trellage-event-list.err"; then
  fail 'list accepted unsupported Trellage event contract'
fi
grep -Fq 'omp: invalid catalog:' "$fixture_root/invalid-trellage-event-list.err" \
  || fail 'unsupported Trellage event contract diagnostic differs'
mv "$fixture_root/catalog.saved" "$runtime_root/catalog.json"

pre_setup_profile_state="$fixture_root/pre-setup-profile-state"
pre_setup_omp_calls="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
find "$profile_root" "$runtime_root" -type f -exec shasum -a 256 {} + | sort >"$pre_setup_profile_state"
if "$command_path" local -p 'Reply exactly OMP_REFUSED' \
  >"$fixture_root/pre-setup-launch.out" 2>"$fixture_root/pre-setup-launch.err"; then
  fail 'private profile manager launched OMP before setup'
fi
grep -Fqx 'omp: this private profile manager cannot launch agents; use trx run omp local' \
  "$fixture_root/pre-setup-launch.err" || fail 'pre-setup launch refusal diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$pre_setup_omp_calls" ]] \
  || fail 'pre-setup launch refusal invoked OMP'
find "$profile_root" "$runtime_root" -type f -exec shasum -a 256 {} + | sort >"$fixture_root/pre-setup-profile-state.after"
cmp -s "$pre_setup_profile_state" "$fixture_root/pre-setup-profile-state.after" \
  || fail 'pre-setup launch refusal changed profile state'
[[ ! -e "$runtime_root/installed-version" ]] \
  || fail 'pre-setup launch refusal installed OMP'

"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
grep -Fq '18.0.11' "$fixture_root/setup.out" \
  || fail 'setup did not report the live host version'
[[ -f "$local_overlay" && ! -L "$local_overlay" ]] \
  || fail 'setup did not materialize managed overlay'
[[ -f "$agent_root/models.yml" && ! -L "$agent_root/models.yml" ]] \
  || fail 'setup did not materialize models.yml'
[[ -f "$profile_root/.managed-by-trellage-omp-profiles" ]] \
  || fail 'setup did not mark profile ownership'
grep -Fqx "    - \"$agent_root/community-skills\"" "$local_overlay" \
  || fail 'local profile does not discover managed community skills'
assert_community_skills "$agent_root/community-skills" 'local profile'

model='copilot-proxy-rs/qwen3.6-35b-a3b-local'
for role in default smol slow vision plan commit tiny task advisor; do
  grep -Fqx "  $role: $model" "$local_overlay" \
    || fail "config does not map role: $role"
done
grep -Fqx '  - copilot-proxy-rs/qwen3.6-35b-a3b-local' "$local_overlay" \
  || fail 'config does not exclusively enable local Qwen'
[[ "$(awk '
  /^enabledModels:/ { in_models = 1; next }
  in_models && /^[^ ]/ { in_models = 0 }
  in_models && /^  - / { count += 1 }
  END { print count + 0 }
' "$local_overlay")" -eq 1 ]] \
  || fail 'config enabled more than one model'
grep -Fqx '  approvalMode: yolo' "$local_overlay" \
  || fail 'config does not set explicit yolo approval mode'
grep -Fqx 'setupVersion: 1' "$local_overlay" \
  || fail 'config does not mark setup complete'
grep -Fqx '  setupWizard: false' "$local_overlay" \
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
! grep -Eiq 'api[_-]?key|token|password' "$local_overlay" "$agent_root/models.yml" \
  || fail 'managed config contains credential-shaped data'

"$command_path" setup copilot >"$fixture_root/setup-copilot.out" \
  || fail 'Copilot setup failed'
[[ -f "$copilot_overlay" && ! -L "$copilot_overlay" ]] \
  || fail 'Copilot setup did not materialize managed overlay'
assert_preserved_state 'Copilot setup'
! grep -Fq 'enabledModels:' "$copilot_overlay" \
  || fail 'Copilot profile pinned discovered models'
grep -Fqx '  default: github-copilot/gpt-5.6-sol:medium' \
  "$copilot_overlay" \
  || fail 'Copilot profile did not default to GPT-5.6 Sol medium'
! grep -Fq 'copilot-proxy-rs' "$copilot_overlay" "$copilot_agent_root/models.yml" \
  || fail 'Copilot profile depends on the local proxy'
grep -Fqx "    - \"$copilot_agent_root/community-skills\"" "$copilot_overlay" \
  || fail 'Copilot profile does not discover managed community skills'
assert_community_skills "$copilot_agent_root/community-skills" 'Copilot profile'

for overlay in "$local_overlay" "$copilot_overlay"; do
  if ! overlay_mode="$(stat -f '%Lp' "$overlay" 2>/dev/null)"; then
    overlay_mode="$(stat -c '%a' "$overlay")" || fail 'could not read overlay permissions'
  fi
  [[ "$overlay_mode" == 600 ]] \
    || fail 'managed overlay permissions differ'
  for setting in '  checkUpdate: false' '  setupWizard: false' '  autoUpdate: off' \
    '  approvalMode: yolo' '  gitGuard: true' '  enabled: true' '  cacheWarming: streaming'; do
    grep -Fqx "$setting" "$overlay" || fail "overlay omitted common setting: $setting"
  done
  ! grep -Fq '  designer:' "$overlay" || fail 'overlay contains retired designer role'
done
for role_effort in default:medium smol:low slow:high vision:medium plan:high commit:low tiny:low task:medium advisor:high; do
  role="${role_effort%:*}"
  effort="${role_effort#*:}"
  grep -Fqx "  $role: github-copilot/gpt-5.6-sol:$effort" "$copilot_overlay" \
    || fail "Copilot overlay omitted role: $role"
done
first_overlay="$fixture_root/first-user.yml"
second_overlay="$fixture_root/second-user.yml"
printf 'modelRoles:\n  default: user/first\n' >"$first_overlay"
printf 'modelRoles:\n  default: user/second\n' >"$second_overlay"
PI_CONFIG_FILES="$first_overlay:$second_overlay" "$command_path" doctor copilot \
  >"$fixture_root/doctor-composed.out" || fail 'composed doctor failed'
[[ "$(tail -n 1 "$FAKE_OMP_MODELS_ENV_LOG")" == "$first_overlay:$second_overlay:$copilot_overlay" ]] \
  || fail 'Copilot model discovery did not receive composed overlays'
assert_preserved_state 'overlay precedence launch'

publish_host_omp "$host_bin" 18.8.5
"$command_path" setup >"$fixture_root/setup-verified.out" \
  || fail 'verified setup failed'
"$command_path" setup copilot \
  >"$fixture_root/setup-copilot-verified.out" || fail 'verified Copilot setup failed'
grep -Fqx "    - \"$agent_root/community-skills\"" "$local_overlay" \
  || fail 'verified local profile lost community skill discovery'
grep -Fqx "    - \"$copilot_agent_root/community-skills\"" "$copilot_overlay" \
  || fail 'verified Copilot profile lost community skill discovery'
assert_community_skills "$agent_root/community-skills" 'verified local profile'
assert_community_skills "$copilot_agent_root/community-skills" 'verified Copilot profile'

"$command_path" doctor >"$fixture_root/host-doctor.out" \
  || fail 'doctor failed without a version receipt'
grep -Fq '18.8.5' "$fixture_root/host-doctor.out" \
  || fail 'doctor did not report the live host version'

"$command_path" list --json >"$fixture_root/list-verified.json" || fail 'verified JSON profile list failed'
jq -e '
  (.profiles[] | select(.name == "copilot") | .headless) == {
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
    "testedHarnessVersion": "18.8.5"
  }
  and (.profiles[] | select(.name == "local") | .headless) == {
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
' "$fixture_root/list-verified.json" >/dev/null || fail 'verified JSON profile list differs'

launch_refusal_omp_calls="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
if "$command_path" -p 'Reply exactly OMP_REFUSED' \
  >"$fixture_root/bare-launch.out" 2>"$fixture_root/bare-launch.err"; then
  fail 'private profile manager accepted a bare launch'
fi
grep -Fqx 'omp: this private profile manager cannot launch agents; use trx run omp PROFILE' \
  "$fixture_root/bare-launch.err" || fail 'bare launch refusal diagnostic differs'

if "$command_path" local -p 'Reply exactly OMP_REFUSED' \
  >"$fixture_root/local-launch.out" 2>"$fixture_root/local-launch.err"; then
  fail 'private profile manager accepted a local launch'
fi
grep -Fqx 'omp: this private profile manager cannot launch agents; use trx run omp local' \
  "$fixture_root/local-launch.err" || fail 'local launch refusal diagnostic differs'

if "$command_path" copilot -p 'Reply exactly OMP_REFUSED' \
  >"$fixture_root/copilot-launch.out" 2>"$fixture_root/copilot-launch.err"; then
  fail 'private profile manager accepted a Copilot launch'
fi
grep -Fqx 'omp: this private profile manager cannot launch agents; use trx run omp default' \
  "$fixture_root/copilot-launch.err" || fail 'Copilot launch refusal diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$launch_refusal_omp_calls" ]] \
  || fail 'launch refusal invoked OMP'

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
"$command_path" harness-version | jq -e '.installed == "18.8.5"' >/dev/null \
  || fail 'reinstall changed the selected host version'

# Canonical launch coverage enters through the public trx router. The private
# manager refusal checks immediately above remain intentionally direct.
worktree="$fixture_root/worktree with spaces"
mkdir -p "$worktree"
worktree="$(CDPATH= cd -P -- "$worktree" && pwd -P)"
(
  cd "$worktree" || exit 1
  "$canonical_omp_command" -p 'Reply exactly OMP_LOCAL_OK' -- '--literal value'
) || fail 'argument forwarding failed'
expected_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"18.8.5",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--thinking","medium","-p","Reply exactly OMP_LOCAL_OK","--","--literal value"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_launch" ]] \
  || fail 'launch did not preserve profile, cwd, HOME, or exact arguments'

(
  cd "$worktree" || exit 1
  "$canonical_omp_command" local -p 'Reply exactly OMP_LOCAL_EXPLICIT'
) || fail 'explicit local launch failed'
expected_local_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"18.8.5",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--thinking","medium","-p","Reply exactly OMP_LOCAL_EXPLICIT"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_local_launch" ]] \
  || fail 'explicit local launch did not select the local profile'

(
  cd "$worktree" || exit 1
  "$canonical_omp_command" copilot -p 'Reply exactly OMP_COPILOT_OK'
) || fail 'Copilot launch failed'
expected_copilot_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"18.8.5",profile:"trellage-copilot-native",home:$home,cwd:$cwd,args:["--model","github-copilot/gpt-5.6-sol","--thinking","medium","-p","Reply exactly OMP_COPILOT_OK"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_copilot_launch" ]] \
  || fail 'Copilot launch did not select the native Copilot profile'
grep -Fqx 'find-generic-password -s copilot-cli -w' "$FAKE_SECURITY_LOG" \
  || fail 'Copilot launch did not inherit the host Copilot credential'

printf 'terminal-response\n' \
  | FAKE_OMP_REQUIRE_STDIN=1 "$canonical_omp_command" copilot -p stdin-probe \
  || fail 'Copilot launch did not preserve standard input'

GH_TOKEN=host-copilot-token GITHUB_TOKEN=poison-github \
  FAKE_COPILOT_KEYCHAIN=0 "$canonical_omp_command" copilot -p gh-env-auth \
  || fail 'Copilot launch did not accept GH_TOKEN'
FAKE_GH_TOKEN=host-copilot-token FAKE_COPILOT_KEYCHAIN=0 \
  "$canonical_omp_command" copilot -p gh-cli-auth \
  || fail 'Copilot launch did not accept gh auth token'
grep -Fqx 'auth token --hostname github.com' "$FAKE_GH_LOG" \
  || fail 'Copilot launch did not use the container-compatible gh auth fallback'

(
  cd "$worktree" || exit 1
  "$canonical_omp_command" --headless-policy no-user-input -p 'Reply exactly OMP_HEADLESS_LOCAL'
) || fail 'local headless-policy launch failed'
local_overlay_record="$(tail -n 1 "$FAKE_OMP_OVERLAY_LOG")"
local_overlay_path="$(printf '%s\n' "$local_overlay_record" | jq -r '.path')"
expected_headless_local_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  --arg path "$local_overlay_path" \
  '{version:"18.8.5",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--thinking","medium","--config",$path,"-p","Reply exactly OMP_HEADLESS_LOCAL"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_headless_local_launch" ]] \
  || fail 'local headless-policy launch arguments differ'
printf '%s\n' "$local_overlay_record" | jq -e --arg managed "$local_overlay" '
  .profile == "trellage-qwen-local"
  and .overlayMatches == true
  and .askEnabled == "false"
  and .configFiles == $managed
  and .approvalModeYolo == true
  and .defaultModel == "copilot-proxy-rs/qwen3.6-35b-a3b-local"
' >/dev/null || fail 'local headless-policy overlay contents differ'
[[ ! -e "$local_overlay_path" ]] || fail 'local headless-policy overlay was not removed'

GH_TOKEN=host-copilot-token GITHUB_TOKEN=poison-github \
  FAKE_COPILOT_KEYCHAIN=0 "$canonical_omp_command" copilot --headless-policy no-user-input \
  -p 'Reply exactly OMP_HEADLESS_COPILOT' \
  || fail 'copilot headless-policy launch failed'
copilot_overlay_record="$(tail -n 1 "$FAKE_OMP_OVERLAY_LOG")"
copilot_overlay_path="$(printf '%s\n' "$copilot_overlay_record" | jq -r '.path')"
expected_headless_copilot_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  --arg path "$copilot_overlay_path" \
  '{version:"18.8.5",profile:"trellage-copilot-native",home:$home,cwd:$cwd,args:["--model","github-copilot/gpt-5.6-sol","--thinking","medium","--config",$path,"-p","Reply exactly OMP_HEADLESS_COPILOT"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_headless_copilot_launch" ]] \
  || fail 'copilot headless-policy launch arguments differ'
printf '%s\n' "$copilot_overlay_record" | jq -e --arg managed "$copilot_overlay" '
  .profile == "trellage-copilot-native"
  and .overlayMatches == true
  and .askEnabled == "false"
  and .configFiles == $managed
  and .approvalModeYolo == true
  and .defaultModel == "github-copilot/gpt-5.6-sol:medium"
' >/dev/null || fail 'copilot headless-policy overlay contents differ'
[[ ! -e "$copilot_overlay_path" ]] || fail 'copilot headless-policy overlay was not removed'

duplicate_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
overlay_before="$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')"
if "$canonical_omp_command" --headless-policy no-user-input --headless-policy no-user-input \
  -p duplicate >"$fixture_root/headless-duplicate.out" 2>"$fixture_root/headless-duplicate.err"; then
  fail 'duplicate headless policy unexpectedly succeeded'
fi
grep -Fqx 'trx run: --headless-policy may be specified only once' \
  "$fixture_root/headless-duplicate.err" || fail 'duplicate headless policy diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$duplicate_before" ]] \
  || fail 'duplicate headless policy invoked OMP'
[[ "$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')" == "$overlay_before" ]] \
  || fail 'duplicate headless policy created an overlay'

missing_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
if "$canonical_omp_command" --headless-policy >"$fixture_root/headless-missing.out" 2>"$fixture_root/headless-missing.err"; then
  fail 'missing headless policy value unexpectedly succeeded'
fi
grep -Fqx 'trx run: --headless-policy requires a value' \
  "$fixture_root/headless-missing.err" || fail 'missing headless policy diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$missing_before" ]] \
  || fail 'missing headless policy invoked OMP'

unknown_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
if "$canonical_omp_command" --headless-policy unsupported -p unknown \
  >"$fixture_root/headless-unknown.out" 2>"$fixture_root/headless-unknown.err"; then
  fail 'unknown headless policy unexpectedly succeeded'
fi
grep -Fqx 'trx run: unknown --headless-policy: unsupported' \
  "$fixture_root/headless-unknown.err" || fail 'unknown headless policy diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$unknown_before" ]] \
  || fail 'unknown headless policy invoked OMP'

if FAKE_OMP_EXIT_STATUS=37 "$canonical_omp_command" local --help >/dev/null 2>&1; then
  fail 'launcher swallowed upstream failure'
else
  status=$?
  [[ "$status" -eq 37 ]] || fail "launcher exit was $status, expected 37"
fi

if FAKE_OMP_EXIT_STATUS=38 "$canonical_omp_command" -h >/dev/null 2>&1; then
  fail 'launcher intercepted upstream short help'
else
  status=$?
  [[ "$status" -eq 38 ]] || fail "short-help exit was $status, expected 38"
fi

prelaunch_signal_ready="$fixture_root/prelaunch-signal.ready"
prelaunch_signal_release="$fixture_root/prelaunch-signal.release"
prelaunch_signal_calls="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
prelaunch_signal_overlays="$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')"
rm -f "$prelaunch_signal_ready" "$prelaunch_signal_release"
FAKE_OMP_BLOCK_VERSION=1 \
FAKE_OMP_READY_FILE="$prelaunch_signal_ready" \
FAKE_OMP_RELEASE_FILE="$prelaunch_signal_release" \
  "$canonical_omp_command" --headless-policy no-user-input -p cancel-before-child &
prelaunch_signal_pid=$!
for _ in {1..100}; do
  [[ -e "$prelaunch_signal_ready" ]] && break
  sleep 0.02
done
[[ -e "$prelaunch_signal_ready" ]] || fail 'prelaunch signal fixture did not become ready'
kill -TERM "$prelaunch_signal_pid"
: >"$prelaunch_signal_release"
if wait "$prelaunch_signal_pid"; then
  fail 'prelaunch cancellation unexpectedly succeeded'
else
  status=$?
  [[ "$status" -eq 143 ]] || fail "prelaunch cancellation exit was $status, expected 143"
fi
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$prelaunch_signal_calls" ]] \
  || fail 'prelaunch cancellation invoked OMP'
[[ "$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')" == "$prelaunch_signal_overlays" ]] \
  || fail 'prelaunch cancellation created an overlay'

FAKE_OMP_WAIT_FOR_SIGNAL=1 "$canonical_omp_command" -p wait-for-signal &
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

: >"$FAKE_OMP_SIGNAL_LOG"
FAKE_OMP_WAIT_FOR_SIGNAL=1 "$canonical_omp_command" --headless-policy no-user-input -p wait-for-signal &
headless_signal_pid=$!
for _ in {1..100}; do
  grep -Fqx READY "$FAKE_OMP_SIGNAL_LOG" 2>/dev/null && break
  sleep 0.02
done
grep -Fqx READY "$FAKE_OMP_SIGNAL_LOG" 2>/dev/null || fail 'headless signal fixture did not become ready'
kill -TERM "$headless_signal_pid"
if wait "$headless_signal_pid"; then
  fail 'signaled headless launcher unexpectedly succeeded'
else
  status=$?
  [[ "$status" -eq 143 ]] || fail "signaled headless launcher exit was $status, expected 143"
fi
grep -Fqx TERM "$FAKE_OMP_SIGNAL_LOG" || fail 'headless launcher did not preserve TERM delivery'
headless_signal_overlay_path="$(tail -n 1 "$FAKE_OMP_OVERLAY_LOG" | jq -r '.path')"
[[ ! -e "$headless_signal_overlay_path" ]] || fail 'headless signal overlay was not removed'

state_before="$fixture_root/doctor.before"
state_after="$fixture_root/doctor.after"
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_before"
"$command_path" doctor >"$fixture_root/doctor.out" || fail 'doctor failed for healthy setup'
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_after"
cmp -s "$state_before" "$state_after" || fail 'doctor mutated managed state'
grep -Fqx 'omp doctor: OK (18.8.5, qwen3.6-35b-a3b-local)' "$fixture_root/doctor.out" \
  || fail 'doctor success output differs'

proxy_calls_before="$(wc -l <"$FAKE_CURL_LOG" | tr -d ' ')"
"$command_path" doctor copilot >"$fixture_root/doctor-copilot.out" \
  || fail 'Copilot doctor failed for authenticated profile'
grep -Fqx 'omp doctor copilot: OK (18.8.5, github-copilot)' \
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

if FAKE_PROXY_HAS_MODEL=0 "$command_path" doctor >"$fixture_root/doctor-missing.out" 2>&1; then
  fail 'doctor accepted missing local model'
fi
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_after"
cmp -s "$state_before" "$state_after" || fail 'failed doctor mutated managed state'

for update_args in '--check' '' '--check copilot' 'copilot'; do
  if "$command_path" update $update_args >"$fixture_root/update.out" 2>&1; then
    fail 'unknown-owner update unexpectedly succeeded'
  fi
  grep -Fq 'package manager' "$fixture_root/update.out" || fail 'update omitted package-manager guidance'
  grep -Fq "$host_bin/omp" "$fixture_root/update.out" || fail 'unknown-owner update omitted the binary path'
  grep -Fq '18.8.5' "$fixture_root/update.out" || fail 'unknown-owner update omitted the live version'
  assert_preserved_state update
done

owner_bin="$fixture_root/owner-bin"
mkdir -p "$owner_bin"
export FAKE_OWNER_LOG="$fixture_root/owner.log"
export FAKE_OWNER_ROOT="$fixture_root/owners"
export FAKE_REAL_BUN="$(command -v bun)"
mkdir -p "$FAKE_OWNER_ROOT/bun/bin" "$FAKE_OWNER_ROOT/brew/Cellar/omp" "$FAKE_OWNER_ROOT/mise"
cat >"$owner_bin/manager" <<'FAKE_MANAGER'
#!/usr/bin/env bash
set -eu
manager="${0##*/}"
if [[ "$manager" == bun && "${1-}" != pm && "${1-}" != outdated && "${1-}" != update ]]; then
  exec "$FAKE_REAL_BUN" "$@"
fi
printf '%s %s\n' "$manager" "$*" >>"$FAKE_OWNER_LOG"
latest="${FAKE_LATEST:-18.8.5}"
[[ "$manager" == "${FAKE_OWNER-}" ]] || latest=99.0.0
package_version=18.0.10
[[ ! -f "$FAKE_OWNER_ROOT/$manager/package-version" ]] \
  || package_version="$(<"$FAKE_OWNER_ROOT/$manager/package-version")"
case "$manager:$*" in
  'bun:pm bin -g') printf '%s\n' "$FAKE_OWNER_ROOT/bun/bin" ;;
  'bun:pm ls -g')
    printf '%s node_modules (1 installed)\n' "$FAKE_OWNER_ROOT/bun/global"
    printf '└── @oh-my-pi/pi-coding-agent@%s\n' "${FAKE_BUN_VERSION:-$package_version}"
    ;;
  'brew:list --formula --versions can1357/tap/omp') printf 'omp %s\n' "${FAKE_BREW_VERSION:-$package_version}" ;;
  'brew:--cellar can1357/tap/omp') printf '%s\n' "$FAKE_OWNER_ROOT/brew/Cellar/omp" ;;
  'brew:--prefix can1357/tap/omp') printf '%s\n' "$FAKE_OWNER_ROOT/brew/opt/omp" ;;
  'mise:which omp') printf '%s\n' "$FAKE_OWNER_ROOT/mise/omp" ;;
  'mise:ls --json github:can1357/oh-my-pi')
    jq -cn --arg version "${FAKE_MISE_VERSION:-$package_version}" --arg path "$FAKE_OWNER_ROOT/mise" \
      '[{version:$version,install_path:$path,installed:true,active:true}]'
    ;;
  'bun:outdated -g @oh-my-pi/pi-coding-agent --no-progress')
    [[ "${FAKE_LATEST_FAIL:-0}" == 0 ]] || exit 31
    [[ "${FAKE_UP_TO_DATE:-0}" == 0 ]] || exit 0
    printf '| Package | Current | Update | Latest |\n'
    printf '| @oh-my-pi/pi-coding-agent | 18.0.10 | %s | %s |\n' "$latest" "$latest"
    ;;
  'brew:outdated --formula --json=v2 can1357/tap/omp')
    [[ "${FAKE_LATEST_FAIL:-0}" == 0 ]] || exit 31
    if [[ "${FAKE_UP_TO_DATE:-0}" == 1 ]]; then
      printf '{"formulae":[],"casks":[]}\n'
      exit "${FAKE_BREW_OUTDATED_STATUS:-0}"
    fi
    jq -cn --arg version "$latest" --arg name "${FAKE_BREW_FORMULA_NAME:-can1357/tap/omp}" \
      '{formulae:[{name:$name,installed_versions:["18.0.10"],current_version:$version,pinned:false,pinned_version:null}],casks:[]}'
    exit "${FAKE_BREW_OUTDATED_STATUS:-1}"
    ;;
  'brew:info --formula --json=v2 can1357/tap/omp')
    [[ "${FAKE_LATEST_FAIL:-0}" == 0 ]] || exit 31
    jq -cn --arg version "$latest" \
      '{formulae:[{name:"omp",full_name:"can1357/tap/omp",versions:{stable:$version,head:null,bottle:true}}],casks:[]}'
    ;;
  'mise:latest github:can1357/oh-my-pi')
    [[ "${FAKE_LATEST_FAIL:-0}" == 0 ]] || exit 31
    printf '%s\n' "$latest"
    ;;
  'bun:update -g --latest @oh-my-pi/pi-coding-agent @oh-my-pi/pi-natives*'|'brew:upgrade can1357/tap/omp'|'mise:upgrade github:can1357/oh-my-pi')
    [[ "$manager" == "$FAKE_OWNER" ]] || exit 91
    [[ "${FAKE_UPDATE_FAIL:-0}" != 1 ]] || exit 32
    destination="$FAKE_OWNER_DESTINATION"
    if [[ "${FAKE_UPDATE_RESULT:-replace}" == missing ]]; then
      rm -f -- "$FAKE_OWNER_LINK"
      exit 0
    fi
    mkdir -p "${destination%/*}"
    version="${FAKE_AFTER_VERSION:-18.8.5}"
    [[ "${FAKE_UPDATE_RESULT:-replace}" != malformed ]] || version=not-omp
    sed "s/@VERSION@/$version/g" "$FAKE_OMP_TEMPLATE" >"$destination"
    chmod 0755 "$destination"
    ln -sf "$destination" "$FAKE_OWNER_LINK"
    printf '%s\n' "$version" >"$FAKE_OWNER_ROOT/$manager/package-version"
    [[ "${FAKE_UPDATE_FAIL:-0}" != after-replace ]] || exit 32
    ;;
  *) exit 92 ;;
esac
FAKE_MANAGER
chmod 0755 "$owner_bin/manager"
for owner in bun brew mise; do ln -s manager "$owner_bin/$owner"; done

prepare_owner() {
  local owner="$1" version="${2:-18.0.10}"
  export FAKE_OWNER="$owner"
  export FAKE_AFTER_VERSION=18.8.5
  printf '%s\n' "$version" >"$FAKE_OWNER_ROOT/$owner/package-version"
  case "$owner" in
    bun)
      publish_host_omp "$FAKE_OWNER_ROOT/bun/global/old" "$version"
      export FAKE_OWNER_LINK="$FAKE_OWNER_ROOT/bun/bin/omp"
      export FAKE_OWNER_DESTINATION="$FAKE_OWNER_ROOT/bun/global/new/omp"
      ln -sf ../global/old/omp "$FAKE_OWNER_LINK"
      export PATH="$FAKE_OWNER_ROOT/bun/bin:$owner_bin:$fixture_tools_path"
      ;;
    brew)
      publish_host_omp "$FAKE_OWNER_ROOT/brew/Cellar/omp/old/bin" "$version"
      mkdir -p "$FAKE_OWNER_ROOT/brew/bin" "$FAKE_OWNER_ROOT/brew/opt"
      ln -sf "$FAKE_OWNER_ROOT/brew/Cellar/omp/old" "$FAKE_OWNER_ROOT/brew/opt/omp"
      export FAKE_OWNER_LINK="$FAKE_OWNER_ROOT/brew/bin/omp"
      export FAKE_OWNER_DESTINATION="$FAKE_OWNER_ROOT/brew/Cellar/omp/new/bin/omp"
      ln -sf "$FAKE_OWNER_ROOT/brew/Cellar/omp/old/bin/omp" "$FAKE_OWNER_LINK"
      export PATH="$FAKE_OWNER_ROOT/brew/bin:$owner_bin:$fixture_tools_path"
      ;;
    mise)
      publish_host_omp "$FAKE_OWNER_ROOT/mise/old" "$version"
      export FAKE_OWNER_LINK="$FAKE_OWNER_ROOT/mise/omp"
      export FAKE_OWNER_DESTINATION="$FAKE_OWNER_ROOT/mise/new/omp"
      ln -sf "$FAKE_OWNER_ROOT/mise/old/omp" "$FAKE_OWNER_LINK"
      export PATH="$FAKE_OWNER_ROOT/mise:$owner_bin:$fixture_tools_path"
      ;;
  esac
  : >"$FAKE_OWNER_LOG"
}

for owner in bun brew mise; do
  prepare_owner "$owner"
  FAKE_BUN_VERSION=18.0.10 FAKE_BREW_VERSION=18.0.10 FAKE_MISE_VERSION=18.0.10 \
    "$command_path" update --check copilot >"$fixture_root/owner-check-$owner.out" 2>&1 \
    || fail "$owner ownership check failed"
  grep -Fq "$owner" "$fixture_root/owner-check-$owner.out" || fail "$owner check omitted the owner"
  grep -Fq '18.0.10' "$fixture_root/owner-check-$owner.out" || fail "$owner check omitted current version"
  grep -Fq '18.8.5' "$fixture_root/owner-check-$owner.out" || fail "$owner check omitted latest version"
  if grep -Eq '^(bun update|brew upgrade|mise upgrade) ' "$FAKE_OWNER_LOG"; then fail "$owner check invoked an update"; fi
  "$command_path" harness-version | jq -e '.installed == "18.0.10" and .latest == "18.8.5" and .latestKnown == true' >/dev/null \
    || fail "$owner version report used the wrong channel"
  for latest_failure in failed malformed; do
    if [[ "$latest_failure" == failed ]]; then
      FAKE_LATEST_FAIL=1 "$command_path" harness-version >"$fixture_root/owner-latest-failure.json"
    else
      FAKE_LATEST=18.8.5-preview "$command_path" harness-version >"$fixture_root/owner-latest-failure.json"
    fi
    jq -e '.installed == "18.0.10" and .latest == null and .latestKnown == false and (.latestDiagnostic | length > 0)' \
      "$fixture_root/owner-latest-failure.json" >/dev/null || fail "$owner latest $latest_failure made the installation unhealthy or trusted a malformed version"
  done
  transaction_manifest >"$fixture_root/owner-failure.before"
  if FAKE_UPDATE_FAIL=1 "$command_path" update copilot >"$fixture_root/owner-failure-$owner.out" 2>&1; then
    fail "$owner update failure was accepted"
  fi
  grep -Fq '18.0.10' "$fixture_root/owner-failure-$owner.out" || fail "$owner failure omitted the still-observed version"
  transaction_manifest >"$fixture_root/owner-failure.after"
  cmp -s "$fixture_root/owner-failure.before" "$fixture_root/owner-failure.after" || fail "$owner failed update changed profile state"
  "$command_path" update copilot >"$fixture_root/owner-update-$owner.out" 2>&1 || fail "$owner update failed"
  case "$owner" in
    bun) expected_update='bun update -g --latest @oh-my-pi/pi-coding-agent @oh-my-pi/pi-natives*' ;;
    brew) expected_update='brew upgrade can1357/tap/omp' ;;
    mise) expected_update='mise upgrade github:can1357/oh-my-pi' ;;
  esac
  [[ "$(grep -Fxc "$expected_update" "$FAKE_OWNER_LOG")" == 2 ]] || fail "$owner did not issue the exact owner update command"
  grep -Fq '18.0.10' "$fixture_root/owner-update-$owner.out" || fail "$owner update omitted its before version"
  grep -Fq '18.8.5' "$fixture_root/owner-update-$owner.out" || fail "$owner update did not inspect the replaced executable"
  "$command_path" harness-version | jq -e '.installed == "18.8.5" and .latest == "18.8.5" and .latestKnown == true' >/dev/null \
    || fail "$owner version report did not resolve ownership after replacement"
  assert_preserved_state "$owner update"
  prepare_owner "$owner"
  transaction_manifest >"$fixture_root/owner-partial-failure.before"
  if FAKE_UPDATE_FAIL=after-replace "$command_path" update >"$fixture_root/owner-partial-failure-$owner.out" 2>&1; then
    fail "$owner partial update failure was accepted"
  fi
  grep -Fq 'still observed host OMP 18.8.5' "$fixture_root/owner-partial-failure-$owner.out" \
    || fail "$owner partial failure reported the cached version rather than the live replacement"
  transaction_manifest >"$fixture_root/owner-partial-failure.after"
  cmp -s "$fixture_root/owner-partial-failure.before" "$fixture_root/owner-partial-failure.after" \
    || fail "$owner partial update failure changed profile state"
  for result in missing malformed; do
    prepare_owner "$owner"
    transaction_manifest >"$fixture_root/owner-invalid.before"
    if FAKE_UPDATE_RESULT="$result" "$command_path" update >"$fixture_root/owner-invalid-$owner-$result.out" 2>&1; then
      fail "$owner update accepted a $result resulting binary"
    fi
    transaction_manifest >"$fixture_root/owner-invalid.after"
    cmp -s "$fixture_root/owner-invalid.before" "$fixture_root/owner-invalid.after" || fail "$owner $result result changed profile state"
  done
done

prepare_owner brew
for brew_query_case in short-name qualified-name; do
  case "$brew_query_case" in
    short-name) brew_formula_name=omp; brew_outdated_status=1 ;;
    qualified-name) brew_formula_name=can1357/tap/omp; brew_outdated_status=0 ;;
  esac
  FAKE_BREW_FORMULA_NAME="$brew_formula_name" FAKE_BREW_OUTDATED_STATUS="$brew_outdated_status" \
    "$command_path" update --check >"$fixture_root/brew-query-$brew_query_case.out" 2>&1 \
    || fail "Homebrew $brew_query_case outdated query failed"
  grep -Fq 'latest=18.8.5' "$fixture_root/brew-query-$brew_query_case.out" \
    || fail "Homebrew $brew_query_case outdated query omitted the latest version"
done
for brew_query_failure in valid-output empty-output; do
  case "$brew_query_failure" in
    valid-output) brew_outdated_status=31; brew_up_to_date=0 ;;
    empty-output) brew_outdated_status=1; brew_up_to_date=1 ;;
  esac
  FAKE_BREW_OUTDATED_STATUS="$brew_outdated_status" FAKE_UP_TO_DATE="$brew_up_to_date" \
    "$command_path" harness-version >"$fixture_root/brew-query-$brew_query_failure.json"
  jq -e '.installed == "18.0.10" and .latest == null and .latestKnown == false and (.latestDiagnostic | length > 0)' \
    "$fixture_root/brew-query-$brew_query_failure.json" >/dev/null \
    || fail "Homebrew $brew_query_failure query error was accepted as latest-version evidence"
done

for owner in bun brew; do
  prepare_owner "$owner"
  FAKE_UP_TO_DATE=1 FAKE_LATEST=18.0.10 "$command_path" update --check >"$fixture_root/owner-current-$owner.out" 2>&1 \
    || fail "$owner up-to-date query failed"
  grep -Fq '18.0.10' "$fixture_root/owner-current-$owner.out" || fail "$owner up-to-date query omitted the current version"
done

prepare_owner bun
FAKE_BUN_VERSION=0.0.1 "$command_path" harness-version | jq -e '.latestKnown == false' >/dev/null \
  || fail 'Bun package version mismatch authorized ownership'
prepare_owner brew
FAKE_BREW_VERSION=0.0.1 "$command_path" harness-version | jq -e '.latestKnown == false' >/dev/null \
  || fail 'Homebrew package version mismatch authorized ownership'
prepare_owner mise
FAKE_MISE_VERSION=0.0.1 "$command_path" harness-version | jq -e '.latestKnown == false' >/dev/null \
  || fail 'mise package version mismatch authorized ownership'
for mismatch in bun:FAKE_BUN_VERSION brew:FAKE_BREW_VERSION mise:FAKE_MISE_VERSION; do
  prepare_owner "${mismatch%:*}"
  if env "${mismatch#*:}=0.0.1" "$command_path" update >"$fixture_root/owner-mismatch.out" 2>&1; then
    fail "${mismatch%:*} version mismatch authorized an update"
  fi
  if grep -Eq '^(bun update|brew upgrade|mise upgrade) ' "$FAKE_OWNER_LOG"; then
    fail "${mismatch%:*} version mismatch mutated a package"
  fi
done
PATH="$host_bin:$owner_bin:$fixture_tools_path" "$command_path" harness-version | jq -e '.latestKnown == false' >/dev/null \
  || fail 'installed package managers claimed an unrelated binary'
if PATH="$host_bin:$owner_bin:$fixture_tools_path" "$command_path" update >"$fixture_root/owner-unrelated.out" 2>&1; then
  fail 'installed package managers updated an unrelated binary'
fi

prepare_owner mise
FAKE_AFTER_VERSION=18.0.10 "$command_path" update >"$fixture_root/owner-no-op.out" 2>&1 \
  || fail 'manager success with the same version was rejected'
grep -Fq 'before=18.0.10 after=18.0.10' "$fixture_root/owner-no-op.out" \
  || fail 'no-op update did not report the actual before/after versions'

prepare_owner bun 17.3.4
FAKE_BUN_VERSION=17.3.4 "$command_path" setup --all >/dev/null || fail 'old host setup failed before update'
for overlay in "$local_overlay" "$copilot_overlay"; do
  if grep -Fq 'community-skills' "$overlay"; then fail 'old version enabled community skills'; fi
done
mv "$agent_root/community-skills/bro" "$fixture_root/update-local-bro"
mv "$copilot_agent_root/community-skills/bro" "$fixture_root/update-copilot-bro"
FAKE_BUN_VERSION=17.3.4 "$command_path" update copilot >"$fixture_root/update-capabilities.out" 2>&1 \
  || fail 'version-dependent capability update failed'
for overlay in "$local_overlay" "$copilot_overlay"; do
  grep -Fq 'community-skills' "$overlay" || fail 'update did not refresh both version-dependent overlays'
done
assert_community_skills "$agent_root/community-skills" 'updated local profile'
assert_community_skills "$copilot_agent_root/community-skills" 'updated Copilot profile'
assert_preserved_state 'capability update'
export PATH="$host_bin:$fixture_tools_path"
publish_host_omp "$host_bin" 18.0.11
"$command_path" repair >"$fixture_root/repair-version.out" || fail 'repair for replaced host failed'
assert_preserved_state repair
mv "$agent_root/community-skills/bro" "$fixture_root/bro.missing"
if "$command_path" doctor >"$fixture_root/doctor-community-missing.out" 2>&1; then
  fail 'doctor accepted a missing managed community skill'
fi
grep -Fq 'failed to validate OMP community skills: local' \
  "$fixture_root/doctor-community-missing.out" \
  || fail 'doctor community skill diagnostic differs'
mv "$fixture_root/bro.missing" "$agent_root/community-skills/bro"
"$command_path" doctor >"$fixture_root/doctor-community-restored.out" \
  || fail 'doctor rejected restored local community skills'
grep -Fqx 'omp doctor: OK (18.0.11, qwen3.6-35b-a3b-local)' \
  "$fixture_root/doctor-community-restored.out" \
  || fail 'restored local community skill doctor output differs'

"$command_path" setup copilot >"$fixture_root/setup-copilot-community.out" \
  || fail 'Copilot setup failed after community skill update'
assert_community_skills "$copilot_agent_root/community-skills" 'updated Copilot profile'
"$command_path" doctor copilot >"$fixture_root/doctor-copilot-community.out" \
  || fail 'doctor rejected restored Copilot community skills'
grep -Fqx 'omp doctor copilot: OK (18.0.11, github-copilot)' \
  "$fixture_root/doctor-copilot-community.out" \
  || fail 'restored Copilot community skill doctor output differs'

"$command_path" list --json >"$fixture_root/list-updated.json" || fail 'updated JSON profile list failed'
jq -e '
  all(.profiles[]; .headless == {
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
  })
' "$fixture_root/list-updated.json" >/dev/null || fail 'updated JSON profile list did not fall closed'

printf 'damaged managed overlay\n' >"$local_overlay"
if "$command_path" doctor >"$fixture_root/doctor-drift.out" 2>&1; then
  fail 'doctor accepted drifted managed overlay'
fi
grep -Fq 'managed overlay differs; run omp repair local' "$fixture_root/doctor-drift.out" \
  || fail 'doctor did not report managed overlay drift'
assert_preserved_state 'failed doctor'
"$command_path" repair local >"$fixture_root/repair.out" || fail 'repair failed'
grep -Fqx '  approvalMode: yolo' "$local_overlay" || fail 'repair did not restore overlay'
assert_preserved_state repair
unsafe_home="$fixture_root/unsafe-home"
mkdir -p "$unsafe_home/.omp/profiles/trellage-qwen-local/agent"
unsafe_agent="$unsafe_home/.omp/profiles/trellage-qwen-local/agent"
printf 'user-owned provider\n' >"$unsafe_agent/models.yml"
printf 'user-owned legacy settings\n' >"$unsafe_agent/config.yaml"
HOME="$unsafe_home" "$installer" >/dev/null || fail 'unsafe provider fixture install failed'
unsafe_command="$unsafe_home/.local/share/trellage/omp/bin/omp"
for operation in setup repair; do
  if HOME="$unsafe_home" "$unsafe_command" "$operation" local >"$fixture_root/unsafe-$operation.out" 2>&1; then
    fail "$operation replaced unrelated local provider"
  fi
  grep -Fqx 'user-owned provider' "$unsafe_agent/models.yml" \
    || fail "$operation changed unrelated local provider"
  grep -Fqx 'user-owned legacy settings' "$unsafe_agent/config.yaml" \
    || fail "$operation changed unrelated legacy settings"
  [[ ! -e "$unsafe_agent/../.managed-by-trellage-omp-profiles" \
    && ! -e "$unsafe_home/.local/share/trellage/omp/overlays/local.yml" ]] \
    || fail "$operation published managed state for an unrelated local provider"
done
mv "$unsafe_agent/models.yml" "$fixture_root/unrelated-models.saved"
if HOME="$unsafe_home" "$unsafe_command" repair local >"$fixture_root/unowned-repair.out" 2>&1; then
  fail 'repair adopted a local profile without ownership'
fi
[[ ! -e "$unsafe_agent/models.yml" \
  && ! -e "$unsafe_agent/../.managed-by-trellage-omp-profiles" \
  && ! -e "$unsafe_home/.local/share/trellage/omp/overlays/local.yml" ]] \
  || fail 'unowned local repair published profile state'
mv "$fixture_root/unrelated-models.saved" "$unsafe_agent/models.yml"

mv "$agent_root/models.yml" "$fixture_root/local-models.saved"
printf 'provider symlink target\n' >"$fixture_root/provider-link-target"
ln -s "$fixture_root/provider-link-target" "$agent_root/models.yml"
for operation in setup repair doctor; do
  operation_args=("$operation" local)
  if "$command_path" "${operation_args[@]}" >"$fixture_root/local-provider-symlink-$operation.out" 2>&1; then
    fail "$operation accepted symlinked local provider"
  fi
  [[ -L "$agent_root/models.yml" \
    && "$(readlink "$agent_root/models.yml")" == "$fixture_root/provider-link-target" ]] \
    || fail "$operation replaced the local provider symlink"
  grep -Fqx 'provider symlink target' "$fixture_root/provider-link-target" \
    || fail "$operation wrote through the local provider symlink"
done
rm "$agent_root/models.yml"
mv "$fixture_root/local-models.saved" "$agent_root/models.yml"

fresh_home="$fixture_root/fresh-profile-home"
mkdir "$fresh_home"
seed_floating_skills_cache "$fresh_home"
seed_community_skills_cache "$fresh_home/.local/share/trellage/common/omp-community-skills"
HOME="$fresh_home" "$installer" >/dev/null || fail 'fresh profile fixture install failed'
fresh_command="$fresh_home/.local/share/trellage/omp/bin/omp"
HOME="$fresh_home" "$fresh_command" setup local >"$fixture_root/fresh-local-setup.out" \
  || fail 'independent fresh local setup failed'
cmp -s "$fixture_root/expected-local-models.yml" "$fresh_home/.omp/profiles/trellage-qwen-local/agent/models.yml" \
  || fail 'fresh local setup did not publish its provider'
HOME="$fresh_home" "$fresh_command" setup copilot >"$fixture_root/fresh-copilot-setup.out" \
  || fail 'independent fresh Copilot setup failed'
fresh_copilot_agent="$fresh_home/.omp/profiles/trellage-copilot-native/agent"
[[ ! -e "$fresh_copilot_agent/models.yml" && ! -L "$fresh_copilot_agent/models.yml" ]] \
  || fail 'fresh Copilot setup created a provider file'

# Fresh-launch concurrency belongs to trx's lifecycle guard. The private
# manager now owns setup publication only and refuses direct agent launches.
concurrent_home="$fixture_root/concurrent-fresh-home"
mkdir "$concurrent_home"
seed_floating_skills_cache "$concurrent_home"
seed_community_skills_cache "$concurrent_home/.local/share/trellage/common/omp-community-skills"
HOME="$concurrent_home" "$installer" >/dev/null || fail 'concurrent fresh fixture install failed'
concurrent_command="$canonical_omp_command"
concurrent_host_one="$fixture_root/concurrent-host-one"
concurrent_host_two="$fixture_root/concurrent-host-two"
publish_host_omp "$concurrent_host_one" 18.0.11
publish_host_omp "$concurrent_host_two" 18.0.11
concurrent_release="$fixture_root/concurrent-version-release"
concurrent_ready_one="$fixture_root/concurrent-version-ready-one"
concurrent_ready_two="$fixture_root/concurrent-version-ready-two"
concurrent_pid_one=''
concurrent_pid_two=''
HOME="$concurrent_home" PATH="$concurrent_host_one:$fixture_tools_path" \
  FAKE_OMP_BLOCK_VERSION=1 FAKE_OMP_READY_FILE="$concurrent_ready_one" \
  FAKE_OMP_RELEASE_FILE="$concurrent_release" \
  "$concurrent_command" local -p concurrent-one >"$fixture_root/concurrent-one.out" 2>&1 &
concurrent_pid_one=$!
wait_for_file "$concurrent_ready_one" 'first concurrent fresh launch'
HOME="$concurrent_home" PATH="$concurrent_host_two:$fixture_tools_path" \
  FAKE_OMP_BLOCK_VERSION=1 FAKE_OMP_READY_FILE="$concurrent_ready_two" \
  FAKE_OMP_RELEASE_FILE="$concurrent_release" \
  "$concurrent_command" local -p concurrent-two >"$fixture_root/concurrent-two.out" 2>&1 &
concurrent_pid_two=$!
wait_for_file "$concurrent_ready_two" 'second concurrent fresh launch'
touch "$concurrent_release"
wait "$concurrent_pid_one" || fail 'first concurrent fresh launch failed'
wait "$concurrent_pid_two" || fail 'second concurrent fresh launch failed'
cmp -s "$fixture_root/expected-local-models.yml" \
  "$concurrent_home/.omp/profiles/trellage-qwen-local/agent/models.yml" \
  || fail 'concurrent fresh launch did not publish its provider'
grep -Fqx 'trellage-omp-profile-v1' \
  "$concurrent_home/.omp/profiles/trellage-qwen-local/.managed-by-trellage-omp-profiles" \
  || fail 'concurrent fresh launch did not publish its ownership marker'

isolated_home="$fixture_root/isolated-fresh-home"
mkdir "$isolated_home"
seed_floating_skills_cache "$isolated_home"
seed_community_skills_cache "$isolated_home/.local/share/trellage/common/omp-community-skills"
HOME="$isolated_home" "$installer" >/dev/null || fail 'isolated fresh fixture install failed'
isolated_command="$canonical_omp_command"
isolated_fault_bin="$fixture_root/isolated-fault-bin"
mkdir "$isolated_fault_bin"
cat >"$isolated_fault_bin/mv" <<'ISOLATED_FAULT_MV'
#!/usr/bin/env bash
. "${OMP_FIXTURE_SYNC_HELPER:?}"
for argument in "$@"; do
  if [[ "$argument" == "$FAIL_PROVIDER_DESTINATION" ]]; then
    : >"$FAIL_PUBLICATION_READY_FILE"
    omp_fixture_wait "$FAIL_PUBLICATION_RELEASE_FILE" "publication release" || exit $?
    printf 'injected concurrent profile publication failure\n' >&2
    exit 73
  fi
done
exec "$REAL_MV" "$@"
ISOLATED_FAULT_MV
chmod 0755 "$isolated_fault_bin/mv"
isolated_profile="$isolated_home/.omp/profiles/trellage-qwen-local"
isolated_failure_ready="$fixture_root/isolated-failure-ready"
isolated_failure_release="$fixture_root/isolated-failure-release"
HOME="$isolated_home" PATH="$isolated_fault_bin:$host_bin:$fixture_tools_path" \
  REAL_MV="$real_mv" FAIL_PROVIDER_DESTINATION="$isolated_profile/.managed-by-trellage-omp-profiles" \
  FAIL_PUBLICATION_READY_FILE="$isolated_failure_ready" \
  FAIL_PUBLICATION_RELEASE_FILE="$isolated_failure_release" \
  "$isolated_command" local -p isolated-failure >"$fixture_root/isolated-failure.out" 2>&1 &
isolated_failure_pid=$!
wait_for_file "$isolated_failure_ready" 'failing isolated fresh launch'
HOME="$isolated_home" PATH="$host_bin:$fixture_tools_path" \
  "$isolated_command" local -p isolated-success >"$fixture_root/isolated-success.out" 2>&1 &
isolated_success_pid=$!
sleep 0.2
kill -0 "$isolated_success_pid" 2>/dev/null \
  || fail 'successful isolated fresh launch did not wait for the failing initializer'
touch "$isolated_failure_release"
if wait "$isolated_failure_pid"; then
  fail 'failing isolated fresh launch unexpectedly succeeded'
fi
if ! wait "$isolated_success_pid"; then
  cat "$fixture_root/isolated-failure.out" "$fixture_root/isolated-success.out" >&2
  fail 'successful isolated fresh launch failed after rollback'
fi
cmp -s "$fixture_root/expected-local-models.yml" \
  "$isolated_profile/agent/models.yml" \
  || fail 'successful isolated fresh launch lost its provider after rollback'
grep -Fqx 'trellage-omp-profile-v1' \
  "$isolated_profile/.managed-by-trellage-omp-profiles" \
  || fail 'successful isolated fresh launch lost its ownership marker after rollback'
[[ -z "$(find "$isolated_home/.local/share/trellage/omp" "$isolated_profile" \
  -name '.profile-transaction.*' -print -quit)" ]] \
  || fail 'isolated fresh launch leaked a publication transaction'

ln -s "$fixture_root/provider-link-target" "$fresh_copilot_agent/models.yml"
for operation in setup repair doctor update; do
  operation_args=("$operation" copilot)
  if HOME="$fresh_home" "$fresh_command" "${operation_args[@]}" >"$fixture_root/copilot-provider-symlink-$operation.out" 2>&1; then
    [[ "$operation" != update ]] || fail 'unknown-owner Copilot update unexpectedly succeeded'
  else
    [[ "$operation" == update ]] || fail "$operation rejected an unmanaged Copilot provider symlink"
  fi
  [[ -L "$fresh_copilot_agent/models.yml" \
    && "$(readlink "$fresh_copilot_agent/models.yml")" == "$fixture_root/provider-link-target" ]] \
    || fail "$operation replaced the Copilot provider symlink"
  grep -Fqx 'provider symlink target' "$fixture_root/provider-link-target" \
    || fail "$operation wrote through the Copilot provider symlink"
done
HOME="$fresh_home" "$uninstaller" >/dev/null || fail 'fresh fixture uninstall failed'
[[ -L "$fresh_copilot_agent/models.yml" \
  && "$(readlink "$fresh_copilot_agent/models.yml")" == "$fixture_root/provider-link-target" ]] \
  || fail 'uninstall removed the Copilot provider symlink'
grep -Fqx 'provider symlink target' "$fixture_root/provider-link-target" \
  || fail 'uninstall changed the Copilot provider symlink target'

symlink_home="$fixture_root/symlink-home"
mkdir -p "$symlink_home/.omp/profiles" "$fixture_root/symlink-target"
ln -s "$fixture_root/symlink-target" "$symlink_home/.omp/profiles/trellage-qwen-local"
HOME="$symlink_home" "$installer" >/dev/null || fail 'symlink fixture install failed'
if HOME="$symlink_home" PATH="$host_bin:$fixture_tools_path" \
  FAKE_MISE_LOG="$FAKE_MISE_LOG" FAKE_OMP_TEMPLATE="$FAKE_OMP_TEMPLATE" \
  "$symlink_home/.local/share/trellage/omp/bin/omp" setup >"$fixture_root/symlink.out" 2>&1; then
  fail 'setup accepted symlinked profile path'
fi
[[ ! -e "$fixture_root/symlink-target/agent/models.yml" \
  && ! -e "$symlink_home/.local/share/trellage/omp/overlays/local.yml" ]] \
  || fail 'setup wrote an overlay or provider for symlinked profile path'

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
assert_preserved_state 'setup, repair, and doctor'
profile_state_hashes >"$fixture_root/uninstall-state.before"
host_omp_hash="$(shasum -a 256 "$host_bin/omp")"
"$uninstaller" >"$fixture_root/uninstall.out" || fail 'uninstall failed'
assert_preserved_state uninstall
profile_state_hashes >"$fixture_root/uninstall-state.after"
cmp -s "$fixture_root/uninstall-state.before" "$fixture_root/uninstall-state.after" \
  || fail 'uninstall changed any profile state, including the local provider'
[[ "$(shasum -a 256 "$host_bin/omp")" == "$host_omp_hash" ]] || fail 'uninstall changed host OMP'
[[ ! -e "$command_path" && ! -L "$command_path" ]] || fail 'uninstall left command'
[[ ! -e "$runtime_root" && ! -L "$runtime_root" ]] || fail 'uninstall left runtime'
grep -Fqx 'session state' "$profile_root/session-canary" || fail 'uninstall removed profile state'
grep -Fqx 'copilot session state' "$copilot_profile_root/session-canary" \
  || fail 'uninstall removed Copilot profile state'


for unsafe_case in missing-marker unowned-root marker-link runtime-link ancestor-link; do
  unsafe_home="$fixture_root/unsafe-runtime-$unsafe_case"
  unsafe_runtime="$unsafe_home/.local/share/trellage/omp"
  unsafe_target="$fixture_root/unsafe-target-$unsafe_case"
  mkdir -p "$unsafe_runtime/bin" "$unsafe_target"
  printf 'protected\n' >"$unsafe_target/canary"
  printf 'trellage-omp-profiles-v2\n' >"$unsafe_runtime/.managed-by-trellage-omp-profiles"
  install -m 0755 "$launcher" "$unsafe_runtime/bin/omp"
  install -m 0644 "$root/catalog.json" "$unsafe_runtime/catalog.json"
  printf 'retired receipt\n' >"$unsafe_runtime/installed-version"
  case "$unsafe_case" in
    missing-marker) rm "$unsafe_runtime/.managed-by-trellage-omp-profiles" ;;
    unowned-root) printf 'unrelated\n' >"$unsafe_runtime/.managed-by-trellage-omp-profiles" ;;
    marker-link)
      mv "$unsafe_runtime/.managed-by-trellage-omp-profiles" "$unsafe_target/marker"
      ln -s "$unsafe_target/marker" "$unsafe_runtime/.managed-by-trellage-omp-profiles"
      ;;
    runtime-link)
      mv "$unsafe_runtime" "$unsafe_target/runtime"
      ln -s "$unsafe_target/runtime" "$unsafe_runtime"
      ;;
    ancestor-link)
      mv "$unsafe_home/.local" "$unsafe_target/local"
      ln -s "$unsafe_target/local" "$unsafe_home/.local"
      ;;
  esac
  if HOME="$unsafe_home" TRELLAGE_TRX_OMP_ADAPTER=1 "$launcher" _trx-admit default \
    >"$fixture_root/unsafe-source-$unsafe_case.out" 2>&1; then
    fail "source admission accepted $unsafe_case"
  fi
  grep -Eq '^omp: (unsafe runtime path|unowned runtime root):' \
    "$fixture_root/unsafe-source-$unsafe_case.out" \
    || fail "source admission did not reject runtime ownership for $unsafe_case"
  [[ ! -e "$unsafe_runtime/overlays" && ! -e "$unsafe_home/.omp" ]] \
    || fail "source admission changed state before refusing $unsafe_case"
  for operation in "$installer" "$uninstaller"; do
    if HOME="$unsafe_home" "$operation" >"$fixture_root/unsafe-runtime-$unsafe_case.out" 2>&1; then
      fail "${operation##*/} accepted $unsafe_case"
    fi
    grep -Fqx protected "$unsafe_target/canary" || fail "${operation##*/} changed redirected content"
    [[ -f "$unsafe_runtime/installed-version" ]] || fail "${operation##*/} cleaned $unsafe_case before refusal"
  done
done

opaque_home="$fixture_root/opaque-profile-home"
mkdir -p "$opaque_home/.local/share/trellage/omp/bin" "$opaque_home/.omp"
printf 'trellage-omp-profiles-v2\n' >"$opaque_home/.local/share/trellage/omp/.managed-by-trellage-omp-profiles"
install -m 0755 "$launcher" "$opaque_home/.local/share/trellage/omp/bin/omp"
install -m 0644 "$root/catalog.json" "$opaque_home/.local/share/trellage/omp/catalog.json"
chmod 000 "$opaque_home/.omp"
HOME="$opaque_home" "$uninstaller" >/dev/null || fail 'uninstall inspected inaccessible profile state'
chmod 0700 "$opaque_home/.omp"
[[ -d "$opaque_home/.omp" ]] || fail 'uninstall removed inaccessible profile state'

bash -n "$launcher" "$installer" "$uninstaller" "$0" || fail 'bash syntax check failed'
printf 'OMP native launcher contract: PASS\n'
