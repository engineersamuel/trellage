#!/usr/bin/env bash

set -u
set -o pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
launcher="$root/bin/omp"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"
skills_catalog="$root/../../skills.json"
community_skill_names=()
while IFS= read -r skill_name; do
  community_skill_names+=("$skill_name")
done < <(
  jq -r '
    .bundles["omp-community"][] as $source
    | .sources[$source].select[]
  ' "$skills_catalog"
)

fail() {
  printf 'omp contract failed: %s\n' "$1" >&2
  exit 1
}

assert_community_skills() {
  local target="$1" label="$2" skill_name skill_count

  [[ -d "$target" && ! -L "$target" ]] \
    || fail "$label community skill directory is missing"
  skill_count="$(find "$target" -mindepth 1 -maxdepth 1 -type d ! -name '.trellage-*' | wc -l | tr -d ' ')"
  [[ "$skill_count" == 49 ]] \
    || fail "$label community skill count was $skill_count, expected 49"
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
}

for source_file in "$launcher" "$installer" "$uninstaller" "$root/README.md"; do
  [[ -f "$source_file" ]] || fail "missing source file: $source_file"
done
[[ "${#community_skill_names[@]}" -eq 49 ]] \
  || fail "OMP community skill count was ${#community_skill_names[@]}, expected 49"
[[ "$(printf '%s\n' "${community_skill_names[@]}" | LC_ALL=C sort -u | wc -l | tr -d ' ')" == 49 ]] \
  || fail 'OMP community skill catalog contains duplicate names'
jq -e '
  .sources["dsebban-omp"].repository == "https://github.com/dsebban/skills.git"
  and .sources["dsebban-omp"].select == ["orchestrate-omp", "poteto-mode", "pstack-omp"]
  and .sources["cursor-pstack"].repository == "https://github.com/cursor/plugins.git"
  and (.sources["cursor-pstack"].select | length) == 46
  and (.sources["cursor-pstack"].select | index("poteto-mode")) == null
  and .bundles["omp-community"] == ["dsebban-omp", "cursor-pstack"]
' "$skills_catalog" >/dev/null || fail 'OMP community skill catalog differs'

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

if [[ "${FAKE_MISE_BLOCK_WHERE:-}" == 1 && "${1-}" == where ]]; then
  : >"${FAKE_MISE_READY_FILE:?}"
  while [[ ! -e "${FAKE_MISE_RELEASE_FILE:?}" ]]; do
    sleep 0.01
  done
fi

case "${1-}" in
  latest)
    [[ "${2-}" == "$tool" ]] || exit 90
    printf '%s\n' "${FAKE_MISE_LATEST:-18.0.4}"
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
if [[ "${FAKE_OMP_REQUIRE_STDIN-}" == 1 ]]; then
  IFS= read -r stdin_probe || exit 79
  [[ "$stdin_probe" == terminal-response ]] || exit 80
fi

if [[ "$#" -eq 0 ]]; then
  config="$HOME/.omp/profiles/${OMP_PROFILE-}/agent/config.yml"
  if ! grep -Fqx 'setupVersion: 1' "$config" \
    || ! grep -Fqx '  setupWizard: false' "$config"; then
    printf 'Choose your default model\n'
    exit 64
  fi
fi

overlay_path=''
for ((index=1; index <= $#; index += 1)); do
  eval "arg=\${$index}"
  case "$arg" in
    --config)
      next_index=$((index + 1))
      eval "overlay_path=\${$next_index-}"
      break
      ;;
    --config=*)
      overlay_path="${arg#--config=}"
      break
      ;;
  esac
done

if [[ -n "$overlay_path" ]]; then
  config="$HOME/.omp/profiles/${OMP_PROFILE-}/agent/config.yml"
  overlay_matches=false
  if [[ -f "$overlay_path" && ! -L "$overlay_path" ]] \
    && grep -Fqx 'ask:' "$overlay_path" \
    && grep -Fqx '  enabled: false' "$overlay_path" \
    && [[ "$(wc -l <"$overlay_path" | tr -d ' ')" == 2 ]]; then
    overlay_matches=true
  fi
  approval_mode_yolo=false
  grep -Fqx '  approvalMode: yolo' "$config" && approval_mode_yolo=true
  default_model="$(awk '/^  default: / {print substr($0, 12)}' "$config" | head -n 1)"
  jq -cn \
    --arg version '@VERSION@' \
    --arg profile "${OMP_PROFILE-}" \
    --arg path "$overlay_path" \
    --arg defaultModel "$default_model" \
    --argjson overlayMatches "$overlay_matches" \
    --argjson approvalModeYolo "$approval_mode_yolo" '
    {
      version: $version,
      profile: $profile,
      path: $path,
      overlayMatches: $overlayMatches,
      approvalModeYolo: $approvalModeYolo,
      defaultModel: $defaultModel
    }
  ' >>"$FAKE_OMP_OVERLAY_LOG"
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

install_fixture_node "$fake_bin"
seed_floating_skills_cache "$home"
seed_community_skills_cache "$home/.local/share/trellage/common/omp-community-skills"
export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$home"
export FAKE_MISE_LOG="$fixture_root/mise.log"
export FAKE_CURL_LOG="$fixture_root/curl.log"
export FAKE_OMP_LOG="$fixture_root/omp.log"
export FAKE_OMP_OVERLAY_LOG="$fixture_root/omp-overlay.log"
export FAKE_OMP_TEMPLATE="$fixture_root/fake-omp-template"
export FAKE_OMP_SIGNAL_LOG="$fixture_root/signal.log"
export FAKE_SECURITY_LOG="$fixture_root/security.log"
export FAKE_GH_LOG="$fixture_root/gh.log"
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
: >"$FAKE_MISE_LOG"
: >"$FAKE_CURL_LOG"
: >"$FAKE_OMP_LOG"
: >"$FAKE_OMP_OVERLAY_LOG"
: >"$FAKE_SECURITY_LOG"
: >"$FAKE_GH_LOG"

"$installer" >"$fixture_root/install.out" || fail 'install failed'
command_path="$HOME/.local/bin/omp"
runtime_root="$HOME/.local/share/trellage/omp"
installed_catalog="$runtime_root/catalog.json"
installed_ownership="$runtime_root/.managed-by-trellage-omp-profiles"
profile_root="$HOME/.omp/profiles/trellage-qwen-local"
agent_root="$profile_root/agent"
copilot_profile_root="$HOME/.omp/profiles/trellage-copilot-native"
copilot_agent_root="$copilot_profile_root/agent"

[[ -L "$command_path" ]] || fail 'installer did not publish command symlink'
[[ "$(readlink "$command_path")" == "$runtime_root/bin/omp" ]] \
  || fail 'command symlink target differs'
[[ -f "$installed_ownership" \
  && "$(<"$installed_ownership")" == 'trellage-omp-profiles-v2' ]] \
  || fail 'installer did not publish the current runtime ownership generation'
cmp -s "$installed_catalog" "$root/catalog.json" \
  || fail 'installer did not publish the OMP catalog'

"$command_path" list --json >"$fixture_root/list.json" || fail 'JSON profile list failed'
jq -e '
  .schemaVersion == 1
  and .launcher == "omp"
  and .harness == "oh-my-pi"
  and .sandbox == false
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
  and (.profiles[] | select(.name == "copilot") | .description) == "OMP with native GitHub Copilot authentication and model catalog, default gpt-5.6-sol medium routing, LSP, debugger, browser, eval tools, and typed subagent fan-out."
  and (.profiles[] | select(.name == "local") | .description) == "OMP with one keyless local Qwen 3.6 35B A3B route assigned to every model role, retaining OMP’s full host tool and subagent surface."
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

"$command_path" local -p 'Reply exactly OMP_SELF_HEAL_SETUP' \
  >"$fixture_root/self-heal.out" 2>&1 \
  || fail 'launch before explicit setup did not self-heal'
[[ -f "$profile_root/.managed-by-trellage-omp-profiles" ]] \
  || fail 'self-healed launch did not mark profile ownership'
[[ -f "$runtime_root/version" ]] \
  || fail 'self-healed launch did not pin a version'
rm -rf "$profile_root" "$runtime_root/version"

"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
[[ "$(<"$runtime_root/version")" == '18.0.4' ]] || fail 'setup did not pin resolved version'
[[ -f "$agent_root/config.yml" && ! -L "$agent_root/config.yml" ]] \
  || fail 'setup did not materialize config.yml'
[[ -f "$agent_root/models.yml" && ! -L "$agent_root/models.yml" ]] \
  || fail 'setup did not materialize models.yml'
[[ -f "$profile_root/.managed-by-trellage-omp-profiles" ]] \
  || fail 'setup did not mark profile ownership'
grep -Fqx "    - \"$agent_root/community-skills\"" "$agent_root/config.yml" \
  || fail 'local profile does not discover managed community skills'
assert_community_skills "$agent_root/community-skills" 'local profile'

model='copilot-proxy-rs/qwen3.6-35b-a3b-local'
for role in default smol slow vision plan designer commit tiny task advisor; do
  grep -Fqx "  $role: $model" "$agent_root/config.yml" \
    || fail "config does not map role: $role"
done
grep -Fqx '  - copilot-proxy-rs/qwen3.6-35b-a3b-local' "$agent_root/config.yml" \
  || fail 'config does not exclusively enable local Qwen'
[[ "$(awk '
  /^enabledModels:/ { in_models = 1; next }
  in_models && /^[^ ]/ { in_models = 0 }
  in_models && /^  - / { count += 1 }
  END { print count + 0 }
' "$agent_root/config.yml")" -eq 1 ]] \
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
grep -Fqx "    - \"$copilot_agent_root/community-skills\"" "$copilot_agent_root/config.yml" \
  || fail 'Copilot profile does not discover managed community skills'
assert_community_skills "$copilot_agent_root/community-skills" 'Copilot profile'

rm -f -- "$runtime_root/version"
FAKE_MISE_LATEST=17.2.12 "$command_path" setup >"$fixture_root/setup-legacy.out" \
  || fail 'legacy setup failed'
FAKE_MISE_LATEST=17.2.12 "$command_path" setup copilot \
  >"$fixture_root/setup-copilot-legacy.out" || fail 'legacy Copilot setup failed'
! grep -Fq 'community-skills' "$agent_root/config.yml" "$copilot_agent_root/config.yml" \
  || fail 'unsupported OMP version enabled community skill discovery'

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
    "testedHarnessVersion": "17.2.12"
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
[[ "$(<"$runtime_root/version")" == '17.2.12' ]] || fail 'reinstall changed pinned version'

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
  '{version:"17.2.12",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--approval-mode","yolo","-p","Reply exactly OMP_LOCAL_OK","--","--literal value"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_launch" ]] \
  || fail 'launch did not preserve profile, cwd, HOME, or exact arguments'

(
  cd "$worktree" || exit 1
  "$command_path" local -p 'Reply exactly OMP_LOCAL_EXPLICIT'
) || fail 'explicit local launch failed'
expected_local_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"17.2.12",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--approval-mode","yolo","-p","Reply exactly OMP_LOCAL_EXPLICIT"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_local_launch" ]] \
  || fail 'explicit local launch did not select the local profile'

(
  cd "$worktree" || exit 1
  "$command_path" copilot -p 'Reply exactly OMP_COPILOT_OK'
) || fail 'Copilot launch failed'
expected_copilot_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  '{version:"17.2.12",profile:"trellage-copilot-native",home:$home,cwd:$cwd,args:["--approval-mode","yolo","-p","Reply exactly OMP_COPILOT_OK"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_copilot_launch" ]] \
  || fail 'Copilot launch did not select the native Copilot profile'
grep -Fqx 'find-generic-password -s copilot-cli -w' "$FAKE_SECURITY_LOG" \
  || fail 'Copilot launch did not inherit the host Copilot credential'

printf 'terminal-response\n' \
  | FAKE_OMP_REQUIRE_STDIN=1 "$command_path" copilot -p stdin-probe \
  || fail 'Copilot launch did not preserve standard input'

GH_TOKEN=host-copilot-token GITHUB_TOKEN=poison-github \
  FAKE_COPILOT_KEYCHAIN=0 "$command_path" copilot -p gh-env-auth \
  || fail 'Copilot launch did not accept GH_TOKEN'
FAKE_GH_TOKEN=host-copilot-token FAKE_COPILOT_KEYCHAIN=0 \
  "$command_path" copilot -p gh-cli-auth \
  || fail 'Copilot launch did not accept gh auth token'
grep -Fqx 'auth token --hostname github.com' "$FAKE_GH_LOG" \
  || fail 'Copilot launch did not use the container-compatible gh auth fallback'

(
  cd "$worktree" || exit 1
  "$command_path" --headless-policy no-user-input -p 'Reply exactly OMP_HEADLESS_LOCAL'
) || fail 'local headless-policy launch failed'
local_overlay_record="$(tail -n 1 "$FAKE_OMP_OVERLAY_LOG")"
local_overlay_path="$(printf '%s\n' "$local_overlay_record" | jq -r '.path')"
expected_headless_local_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$worktree" \
  --arg path "$local_overlay_path" \
  '{version:"17.2.12",profile:"trellage-qwen-local",home:$home,cwd:$cwd,args:["--approval-mode","yolo","--config",$path,"-p","Reply exactly OMP_HEADLESS_LOCAL"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_headless_local_launch" ]] \
  || fail 'local headless-policy launch arguments differ'
printf '%s\n' "$local_overlay_record" | jq -e '
  .profile == "trellage-qwen-local"
  and .overlayMatches == true
  and .approvalModeYolo == true
  and .defaultModel == "copilot-proxy-rs/qwen3.6-35b-a3b-local"
' >/dev/null || fail 'local headless-policy overlay contents differ'
[[ ! -e "$local_overlay_path" ]] || fail 'local headless-policy overlay was not removed'

GH_TOKEN=host-copilot-token GITHUB_TOKEN=poison-github \
  FAKE_COPILOT_KEYCHAIN=0 "$command_path" copilot --headless-policy no-user-input \
  -p 'Reply exactly OMP_HEADLESS_COPILOT' \
  || fail 'copilot headless-policy launch failed'
copilot_overlay_record="$(tail -n 1 "$FAKE_OMP_OVERLAY_LOG")"
copilot_overlay_path="$(printf '%s\n' "$copilot_overlay_record" | jq -r '.path')"
expected_headless_copilot_launch="$(jq -cn \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  --arg path "$copilot_overlay_path" \
  '{version:"17.2.12",profile:"trellage-copilot-native",home:$home,cwd:$cwd,args:["--approval-mode","yolo","--config",$path,"-p","Reply exactly OMP_HEADLESS_COPILOT"]}')"
[[ "$(tail -n 1 "$FAKE_OMP_LOG")" == "$expected_headless_copilot_launch" ]] \
  || fail 'copilot headless-policy launch arguments differ'
printf '%s\n' "$copilot_overlay_record" | jq -e '
  .profile == "trellage-copilot-native"
  and .overlayMatches == true
  and .approvalModeYolo == true
  and .defaultModel == "github-copilot/gpt-5.6-sol:medium"
' >/dev/null || fail 'copilot headless-policy overlay contents differ'
[[ ! -e "$copilot_overlay_path" ]] || fail 'copilot headless-policy overlay was not removed'

duplicate_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
overlay_before="$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')"
if "$command_path" --headless-policy no-user-input --headless-policy no-user-input \
  -p duplicate >"$fixture_root/headless-duplicate.out" 2>"$fixture_root/headless-duplicate.err"; then
  fail 'duplicate headless policy unexpectedly succeeded'
fi
grep -Fqx 'omp: --headless-policy may be specified only once' \
  "$fixture_root/headless-duplicate.err" || fail 'duplicate headless policy diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$duplicate_before" ]] \
  || fail 'duplicate headless policy invoked OMP'
[[ "$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')" == "$overlay_before" ]] \
  || fail 'duplicate headless policy created an overlay'

missing_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
if "$command_path" --headless-policy >"$fixture_root/headless-missing.out" 2>"$fixture_root/headless-missing.err"; then
  fail 'missing headless policy value unexpectedly succeeded'
fi
grep -Fqx 'omp: --headless-policy requires a value' \
  "$fixture_root/headless-missing.err" || fail 'missing headless policy diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$missing_before" ]] \
  || fail 'missing headless policy invoked OMP'

unknown_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
if "$command_path" --headless-policy unsupported -p unknown \
  >"$fixture_root/headless-unknown.out" 2>"$fixture_root/headless-unknown.err"; then
  fail 'unknown headless policy unexpectedly succeeded'
fi
grep -Fqx 'omp: unknown --headless-policy: unsupported' \
  "$fixture_root/headless-unknown.err" || fail 'unknown headless policy diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$unknown_before" ]] \
  || fail 'unknown headless policy invoked OMP'

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

prelaunch_signal_ready="$fixture_root/prelaunch-signal.ready"
prelaunch_signal_release="$fixture_root/prelaunch-signal.release"
prelaunch_signal_calls="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
prelaunch_signal_overlays="$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')"
rm -f "$prelaunch_signal_ready" "$prelaunch_signal_release"
FAKE_MISE_BLOCK_WHERE=1 \
FAKE_MISE_READY_FILE="$prelaunch_signal_ready" \
FAKE_MISE_RELEASE_FILE="$prelaunch_signal_release" \
  "$command_path" --headless-policy no-user-input -p cancel-before-child &
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

: >"$FAKE_OMP_SIGNAL_LOG"
FAKE_OMP_WAIT_FOR_SIGNAL=1 "$command_path" --headless-policy no-user-input -p wait-for-signal &
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
grep -Fqx 'omp doctor: OK (17.2.12, qwen3.6-35b-a3b-local)' "$fixture_root/doctor.out" \
  || fail 'doctor success output differs'

proxy_calls_before="$(wc -l <"$FAKE_CURL_LOG" | tr -d ' ')"
"$command_path" doctor copilot >"$fixture_root/doctor-copilot.out" \
  || fail 'Copilot doctor failed for authenticated profile'
grep -Fqx 'omp doctor copilot: OK (17.2.12, github-copilot)' \
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

FAKE_MISE_LATEST=17.2.13 "$command_path" update --check >"$fixture_root/check.out" \
  || fail 'update check failed'
grep -Fqx 'omp update: 17.2.12 -> 17.2.13 available' "$fixture_root/check.out" \
  || fail 'update check output differs'
[[ "$(<"$runtime_root/version")" == '17.2.12' ]] || fail 'update check changed pinned version'

if FAKE_MISE_LATEST=17.2.13 FAKE_MISE_INSTALL_FAIL_VERSION=17.2.13 \
  "$command_path" update >"$fixture_root/update-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when mise failed'
fi
[[ "$(<"$runtime_root/version")" == '17.2.12' ]] || fail 'failed update replaced pinned version'

rm -rf -- "$agent_root/community-skills/architect"
FAKE_MISE_LATEST=18.0.4 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/version")" == '18.0.4' ]] || fail 'update did not publish new exact version'
[[ -f "$agent_root/community-skills/architect/SKILL.md" ]] \
  || fail 'update did not restore managed community skills'
mv "$agent_root/community-skills/architect" "$fixture_root/architect.missing"
if "$command_path" doctor >"$fixture_root/doctor-community-missing.out" 2>&1; then
  fail 'doctor accepted a missing managed community skill'
fi
grep -Fq 'failed to validate OMP community skills: local' \
  "$fixture_root/doctor-community-missing.out" \
  || fail 'doctor community skill diagnostic differs'
mv "$fixture_root/architect.missing" "$agent_root/community-skills/architect"
"$command_path" doctor >"$fixture_root/doctor-community-restored.out" \
  || fail 'doctor rejected restored local community skills'
grep -Fqx 'omp doctor: OK (18.0.4, qwen3.6-35b-a3b-local)' \
  "$fixture_root/doctor-community-restored.out" \
  || fail 'restored local community skill doctor output differs'

"$command_path" setup copilot >"$fixture_root/setup-copilot-community.out" \
  || fail 'Copilot setup failed after community skill update'
assert_community_skills "$copilot_agent_root/community-skills" 'updated Copilot profile'
"$command_path" doctor copilot >"$fixture_root/doctor-copilot-community.out" \
  || fail 'doctor rejected restored Copilot community skills'
grep -Fqx 'omp doctor copilot: OK (18.0.4, github-copilot)' \
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

fail_closed_before="$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')"
fail_closed_overlay_before="$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')"
if "$command_path" --headless-policy no-user-input -p headless-version-mismatch \
  >"$fixture_root/headless-version-mismatch.out" 2>"$fixture_root/headless-version-mismatch.err"; then
  fail 'headless policy unexpectedly succeeded on an unverified OMP version'
fi
grep -Fqx 'omp: --headless-policy no-user-input is verified only for OMP 17.2.12; pinned version is 18.0.4' \
  "$fixture_root/headless-version-mismatch.err" \
  || fail 'unverified OMP version diagnostic differs'
[[ "$(wc -l <"$FAKE_OMP_LOG" | tr -d ' ')" == "$fail_closed_before" ]] \
  || fail 'unverified OMP version invoked OMP'
[[ "$(wc -l <"$FAKE_OMP_OVERLAY_LOG" | tr -d ' ')" == "$fail_closed_overlay_before" ]] \
  || fail 'unverified OMP version created an overlay'

printf 'damaged managed config\n' >"$agent_root/config.yml"
damaged_hash="$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')"
if OMP_TEST_FAIL_AT=after-config "$command_path" repair >"$fixture_root/repair-rollback.out" 2>&1; then
  fail 'injected repair publication failure unexpectedly succeeded'
fi
[[ "$damaged_hash" == "$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')" ]] \
  || fail 'failed repair did not roll back config publication'
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
grep -Fqx '  approvalMode: yolo' "$agent_root/config.yml" || fail 'repair did not restore config'
[[ "$(<"$runtime_root/version")" == '18.0.4' ]] || fail 'repair changed pinned version'

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

installed_omp="$runtime_root/mise/installs/github-can1357-oh-my-pi/18.0.4/omp"
rm "$installed_omp" || fail 'could not remove pinned install for launch recovery test'
"$command_path" -p 'Reply exactly OMP_INSTALL_RECOVERY' \
  >"$fixture_root/install-recovery.out" 2>&1 \
  || fail 'launch did not recover a missing pinned install'
grep -Fq 'omp: OMP 18.0.4 is not installed; installing' \
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
