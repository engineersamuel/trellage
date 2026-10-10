#!/usr/bin/env bash

set -u
set -o pipefail

unset TRELLAGE_NATIVE_COMPOSITION_HARNESS TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
launcher="$root/bin/omp"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"
skills_catalog="$root/../../config.toml"
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

assert_community_skills() {
  local target="$1" label="$2" skill_name skill_count

  [[ -d "$target" && ! -L "$target" ]] \
    || fail "$label community skill directory is missing"
  skill_count="$(find "$target" -mindepth 1 -maxdepth 1 -type d ! -name '.trellage-*' | wc -l | tr -d ' ')"
  [[ "$skill_count" == 34 ]] \
    || fail "$label community skill count was $skill_count, expected 34"
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

for source_file in "$launcher" "$installer" "$uninstaller" "$root/README.md"; do
  [[ -f "$source_file" ]] || fail "missing source file: $source_file"
done
[[ "${#community_skill_names[@]}" -eq 34 ]] \
  || fail "OMP community skill count was ${#community_skill_names[@]}, expected 34"
[[ "$(printf '%s\n' "${community_skill_names[@]}" | LC_ALL=C sort -u | wc -l | tr -d ' ')" == 34 ]] \
  || fail 'OMP community skill catalog contains duplicate names'
bun --no-env-file -e 'console.log(JSON.stringify(Bun.TOML.parse(await Bun.file(process.argv[1]).text()).skills))' "$skills_catalog" | jq -e '
  .sources["dsebban-omp"].repository == "https://github.com/dsebban/skills.git"
  and .sources["dsebban-omp"].select == ["orchestrate-omp", "poteto-mode", "pstack-omp"]
  and .sources["pstack-portable"].repository == "https://github.com/Aqua-123/pstack-for-codex.git"
  and (.sources["pstack-portable"].select | length) == 31
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
trap 'rm -rf -- "$fixture_root"' EXIT HUP INT TERM
fixture_registry="$(npm config get registry --workspaces=false)" \
  || fail 'could not discover the host npm registry'
[[ -n "$fixture_registry" ]] || fail 'host npm registry is empty'
export BUN_INSTALL_CACHE_DIR="$fixture_root/bun-cache"
export npm_config_registry="$fixture_registry"


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
    printf '%s\n' "${FAKE_MISE_LATEST:-18.0.11}"
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
command_path="$HOME/.local/share/trellage/.native-commands/omp"
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

if "$command_path" local -p 'Reply exactly OMP_REFUSED' \
  >"$fixture_root/pre-setup-launch.out" 2>"$fixture_root/pre-setup-launch.err"; then
  fail 'private profile manager launched OMP before setup'
fi
grep -Fqx 'omp: this private profile manager cannot launch agents; use trx run omp local' \
  "$fixture_root/pre-setup-launch.err" || fail 'pre-setup launch refusal diagnostic differs'
[[ ! -s "$FAKE_OMP_LOG" ]] || fail 'pre-setup launch refusal invoked OMP'
[[ ! -e "$profile_root" ]] || fail 'pre-setup launch refusal created profile state'
[[ ! -e "$runtime_root/installed-version" ]] \
  || fail 'pre-setup launch refusal installed OMP'

"$command_path" setup >"$fixture_root/setup.out" || fail 'setup failed'
[[ "$(<"$runtime_root/installed-version")" == '18.0.11' ]] \
  || fail 'setup did not record resolved installed version'
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

rm -f -- "$runtime_root/installed-version"
FAKE_MISE_LATEST=18.0.10 "$command_path" setup >"$fixture_root/setup-verified.out" \
  || fail 'verified setup failed'
FAKE_MISE_LATEST=18.0.10 "$command_path" setup copilot \
  >"$fixture_root/setup-copilot-verified.out" || fail 'verified Copilot setup failed'
grep -Fqx "    - \"$agent_root/community-skills\"" "$agent_root/config.yml" \
  || fail 'verified local profile lost community skill discovery'
grep -Fqx "    - \"$copilot_agent_root/community-skills\"" "$copilot_agent_root/config.yml" \
  || fail 'verified Copilot profile lost community skill discovery'
assert_community_skills "$agent_root/community-skills" 'verified local profile'
assert_community_skills "$copilot_agent_root/community-skills" 'verified Copilot profile'

mv "$runtime_root/installed-version" "$runtime_root/version"
"$command_path" doctor >"$fixture_root/legacy-receipt-doctor.out" \
  || fail 'doctor did not migrate the legacy version receipt'
[[ "$(<"$runtime_root/installed-version")" == 18.0.10 && ! -e "$runtime_root/version" ]] \
  || fail 'legacy version receipt migration differs'

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
    "testedHarnessVersion": "18.0.10"
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
[[ ! -s "$FAKE_OMP_LOG" ]] || fail 'launch refusal invoked OMP'

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
[[ "$(<"$runtime_root/installed-version")" == '18.0.10' ]] \
  || fail 'reinstall changed installed version receipt'

state_before="$fixture_root/doctor.before"
state_after="$fixture_root/doctor.after"
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_before"
"$command_path" doctor >"$fixture_root/doctor.out" || fail 'doctor failed for healthy setup'
find "$runtime_root" "$profile_root" -type f -exec shasum -a 256 {} + | sort >"$state_after"
cmp -s "$state_before" "$state_after" || fail 'doctor mutated managed state'
grep -Fqx 'omp doctor: OK (18.0.10, qwen3.6-35b-a3b-local)' "$fixture_root/doctor.out" \
  || fail 'doctor success output differs'

proxy_calls_before="$(wc -l <"$FAKE_CURL_LOG" | tr -d ' ')"
"$command_path" doctor copilot >"$fixture_root/doctor-copilot.out" \
  || fail 'Copilot doctor failed for authenticated profile'
grep -Fqx 'omp doctor copilot: OK (18.0.10, github-copilot)' \
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

FAKE_MISE_LATEST=18.0.11 "$command_path" update --check >"$fixture_root/check.out" \
  || fail 'update check failed'
grep -Fqx 'omp update: 18.0.10 -> 18.0.11 available' "$fixture_root/check.out" \
  || fail 'update check output differs'
[[ "$(<"$runtime_root/installed-version")" == '18.0.10' ]] \
  || fail 'update check changed installed version receipt'

if FAKE_MISE_LATEST=18.0.11 FAKE_MISE_INSTALL_FAIL_VERSION=18.0.11 \
  "$command_path" update >"$fixture_root/update-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when mise failed'
fi
[[ "$(<"$runtime_root/installed-version")" == '18.0.10' ]] \
  || fail 'failed update replaced installed version receipt'

find "$agent_root" "$profile_root/.managed-by-trellage-omp-profiles" \
  -type f -exec shasum -a 256 {} + | sort >"$fixture_root/update-state.before"
if FAKE_MISE_LATEST=18.0.11 OMP_TEST_FAIL_AT=before-receipt-publication \
  "$command_path" update >"$fixture_root/update-publication-fail.out" 2>&1; then
  fail 'update unexpectedly succeeded when receipt publication failed'
fi
grep -Fq 'injected failure before installed version receipt publication' \
  "$fixture_root/update-publication-fail.out" \
  || fail 'receipt publication failure diagnostic differs'
[[ "$(<"$runtime_root/installed-version")" == '18.0.10' ]] \
  || fail 'receipt publication failure replaced installed version receipt'
find "$agent_root" "$profile_root/.managed-by-trellage-omp-profiles" \
  -type f -exec shasum -a 256 {} + | sort >"$fixture_root/update-state.after"
cmp -s "$fixture_root/update-state.before" "$fixture_root/update-state.after" \
  || fail 'receipt publication failure did not restore the prior OMP profile state'

rm -rf -- "$agent_root/community-skills/bro"
FAKE_MISE_LATEST=18.0.11 "$command_path" update >"$fixture_root/update.out" \
  || fail 'update failed'
[[ "$(<"$runtime_root/installed-version")" == '18.0.11' ]] \
  || fail 'update did not publish new installed version receipt'
[[ -f "$agent_root/community-skills/bro/SKILL.md" ]] \
  || fail 'update did not restore managed community skills'
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

printf 'damaged managed config\n' >"$agent_root/config.yml"
damaged_hash="$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')"
if OMP_TEST_FAIL_AT=after-config "$command_path" repair >"$fixture_root/repair-rollback.out" 2>&1; then
  fail 'injected repair publication failure unexpectedly succeeded'
fi
[[ "$damaged_hash" == "$(shasum -a 256 "$agent_root/config.yml" | awk '{print $1}')" ]] \
  || fail 'failed repair did not roll back config publication'
"$command_path" repair >"$fixture_root/repair.out" || fail 'repair failed'
grep -Fqx '  approvalMode: yolo' "$agent_root/config.yml" || fail 'repair did not restore config'
[[ "$(<"$runtime_root/installed-version")" == '18.0.11' ]] \
  || fail 'repair changed installed version receipt'

printf 'drifted managed config\n' >"$agent_root/config.yml"
if "$command_path" doctor >"$fixture_root/doctor-drift.out" 2>&1; then
  fail 'doctor accepted drifted managed config'
fi
grep -Fq 'managed config differs; run omp repair local' "$fixture_root/doctor-drift.out" \
  || fail 'doctor did not report managed config drift'
"$command_path" repair >/dev/null || fail 'repair after drift checks failed'

unsafe_home="$fixture_root/unsafe-home"
mkdir -p "$unsafe_home/.omp/profiles/trellage-qwen-local/agent"
printf 'user-owned\n' >"$unsafe_home/.omp/profiles/trellage-qwen-local/agent/config.yml"
if HOME="$unsafe_home" "$installer" >/dev/null \
  && HOME="$unsafe_home" PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    FAKE_MISE_LOG="$FAKE_MISE_LOG" FAKE_OMP_TEMPLATE="$FAKE_OMP_TEMPLATE" \
    "$unsafe_home/.local/share/trellage/.native-commands/omp" setup >"$fixture_root/unsafe.out" 2>&1; then
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
  "$symlink_home/.local/share/trellage/.native-commands/omp" setup >"$fixture_root/symlink.out" 2>&1; then
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
mkdir -p "$unowned_home/.local/share/trellage/.native-commands"
printf 'unrelated\n' >"$unowned_home/.local/share/trellage/.native-commands/omp"
if HOME="$unowned_home" "$installer" >"$fixture_root/unowned.out" 2>&1; then
  fail 'installer replaced unrelated command'
fi
grep -Fqx 'unrelated' "$unowned_home/.local/share/trellage/.native-commands/omp" || fail 'installer changed unrelated command'

bash -n "$launcher" "$installer" "$uninstaller" "$0" || fail 'bash syntax check failed'
printf 'OMP native launcher contract: PASS\n'
