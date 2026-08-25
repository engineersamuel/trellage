#!/usr/bin/env bash

set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
. "$root/../../tests/helpers/floating_skills_fixture.sh"
launcher="$root/bin/picx"
installer="$root/install.sh"
uninstaller="$root/uninstall.sh"

fail() {
  printf 'picx contract failed: %s\n' "$1" >&2
  exit 1
}

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-picx-contract.XXXXXX")"
trap 'rm -rf -- "$fixture_root"' EXIT HUP INT TERM
fake_bin="$fixture_root/fake-bin"
home="$fixture_root/home"
node_binary="$(node -p 'process.execPath')"
mkdir -p "$fake_bin" "$home/.copilot" "$home/.omp/profiles/trellage-picx-default"
seed_floating_skills_cache "$home"
printf '%s\n' '{"models":[{"id":"gpt-5.6-sol"}]}' >"$home/.copilot/models.json"
printf '%s\n' '{"mcpServers":{"plan":{"url":"https://agent-native.example.test/mcp"}}}' \
  >"$home/.claude.json"
printf 'legacy OMP state\n' >"$home/.omp/profiles/trellage-picx-default/canary"

cat >"$fake_bin/mise" <<'FAKE_MISE'
#!/usr/bin/env bash
set -euo pipefail
tool='npm:@earendil-works/pi-coding-agent'
install_name='npm-earendil-works-pi-coding-agent'
case "${1-}" in
  install)
    version="${2#"$tool"@}"
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    mkdir -p "$destination/bin" "$destination/lib"
    sed "s/@VERSION@/$version/g" "$FAKE_PI_TEMPLATE" >"$destination/lib/pi"
    chmod 0755 "$destination/lib/pi"
    ln -sfn ../lib/pi "$destination/bin/pi"
    ;;
  where)
    version="${2#"$tool"@}"
    destination="$MISE_DATA_DIR/installs/$install_name/$version"
    [[ -x "$destination/bin/pi" ]]
    printf '%s\n' "$destination"
    ;;
  *) exit 92 ;;
esac
FAKE_MISE
chmod 0755 "$fake_bin/mise"

cat >"$fixture_root/fake-pi-template" <<'FAKE_PI'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == --version ]]; then
  printf '%s\n' '@VERSION@'
  exit 0
fi
if [[ "${1-}" == install ]]; then
  [[ "$#" == 2 ]] || exit 71
  spec="$2"
  printf '%s\n' "$spec" >>"$FAKE_EXTENSION_LOG"
  case "$spec" in
    git:github.com/DietrichGebert/ponytail)
      package='@dietrichgebert/ponytail'
      package_root="$PI_CODING_AGENT_DIR/git/github.com/DietrichGebert/ponytail"
      version='1.0.0'
      ;;
    npm:*)
      package="${spec#npm:}"
      if [[ "$package" =~ ^(.+)@([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
        package="${BASH_REMATCH[1]}"
        version="${BASH_REMATCH[2]}"
      else
        version='1.0.0'
      fi
      package_root="$PI_CODING_AGENT_DIR/npm/node_modules/$package"
      ;;
    *) exit 72 ;;
  esac
  mkdir -p "$package_root"
  printf '{"name":"%s","version":"%s"}\n' "$package" "$version" >"$package_root/package.json"
  if [[ "$package" == '@ff-labs/pi-fff' ]]; then
    for dependency in fff-bun fff-node; do
      dependency_root="$PI_CODING_AGENT_DIR/npm/node_modules/@ff-labs/$dependency"
      mkdir -p "$dependency_root"
      printf '{"name":"@ff-labs/%s","version":"0.10.5"}\n' "$dependency" \
        >"$dependency_root/package.json"
    done
  fi
  exit 0
fi

jq -e '
  .settings.hostConfigDiscovery == "off"
  and (.imports // []) == []
  and .mcpServers == {}
' "$PI_CODING_AGENT_DIR/mcp.json" >/dev/null || {
  printf '%s\n' 'MCP finished with failures. Failed: plan [config: ~/.claude.json]: HTTP 401' >&2
  exit 73
}
printf '%s\n' \
  "${PI_CODING_AGENT_DIR-}|${COPILOT_MODELS_PATH-}|copilot=${COPILOT_GITHUB_TOKEN+x}|gh=${GH_TOKEN+x}|github=${GITHUB_TOKEN+x}|openai=${OPENAI_API_KEY+x}|openai_base=${OPENAI_BASE_URL+x}|azure=${AZURE_OPENAI_API_KEY+x}|$*" \
  >>"$FAKE_LAUNCH_LOG"
if [[ "$*" == *'what extensions are installed'* ]]; then
  printf '%s\n' \
    'Ponytail' \
    'pi-web-access' \
    'pi-subagents' \
    'pi-fff' \
    'pi-context-view' \
    'pi-mcp-adapter' \
    'pi-btw' \
    'Plannotator' \
    'pi-goal' \
    'pi-dynamic-workflows'
fi
FAKE_PI
chmod 0755 "$fixture_root/fake-pi-template"

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_PROXY_LOG"
case "${!#}" in
  http://127.0.0.1:8080/health)
    printf '%s\n' '{"status":"ok"}'
    ;;
  http://127.0.0.1:8080/v1/models)
    printf '%s\n' '{"data":[{"id":"gpt-5.6-sol"}]}'
    ;;
  *)
    exit 22
    ;;
esac
FAKE_CURL
chmod 0755 "$fake_bin/curl"
ln -s "$node_binary" "$fake_bin/node"

export HOME="$home"
export PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FAKE_PI_TEMPLATE="$fixture_root/fake-pi-template"
export FAKE_EXTENSION_LOG="$fixture_root/extensions.log"
export FAKE_LAUNCH_LOG="$fixture_root/launch.log"
export FAKE_PROXY_LOG="$fixture_root/proxy.log"
: >"$FAKE_EXTENSION_LOG"
: >"$FAKE_LAUNCH_LOG"
: >"$FAKE_PROXY_LOG"

"$installer" >/dev/null
command_path="$HOME/.local/bin/picx"
runtime_root="$HOME/.local/share/trellage/picx"
profile_root="$HOME/.local/share/trellage/profiles/pi/picx-default"
agent_root="$profile_root/agent"

[[ -L "$command_path" ]] || fail 'installer did not publish picx'
[[ "$(readlink "$command_path")" == "$runtime_root/bin/picx" ]] \
  || fail 'picx command target differs'
[[ "$(<"$runtime_root/version")" == '0.84.2' ]] \
  || fail 'installer did not publish the Pi version pin'

"$command_path" list --json >"$fixture_root/list.json"
jq -e '
  .launcher == "picx"
  and .harness == "pi"
  and .sandbox == false
  and [.profiles[].name] == ["default"]
  and .profiles[0].headless.prompt == false
  and .profiles[0].headless.testedHarnessVersion == null
  and [.profiles[0].extensions[].name] == [
    "Ponytail",
    "pi-web-access",
    "pi-subagents",
    "pi-fff",
    "pi-context-view",
    "pi-mcp-adapter",
    "pi-btw",
    "Plannotator",
    "pi-goal",
    "pi-dynamic-workflows"
  ]
' "$fixture_root/list.json" >/dev/null || fail 'catalog order or shape differs'

"$command_path" inventory default --json >"$fixture_root/not-setup.json"
jq -e '
  .launcher == "picx"
  and .harness == "pi"
  and .profile == "default"
  and .readiness == "not-setup"
  and (.extensions | length) == 0
' "$fixture_root/not-setup.json" >/dev/null || fail 'not-setup inventory differs'

"$command_path" setup >/dev/null
"$command_path" list --json >"$fixture_root/setup-list.json"
jq -e '
  .profiles[0].headless.prompt == true
  and .profiles[0].headless.questionToolControl == "prompt-only"
  and .profiles[0].headless.testedHarnessVersion == "0.84.2"
' "$fixture_root/setup-list.json" >/dev/null \
  || fail 'setup catalog did not expose verified headless support'
grep -Fqx 'legacy OMP state' "$HOME/.omp/profiles/trellage-picx-default/canary" \
  || fail 'setup altered the legacy OMP profile'

jq -e '
  .defaultProvider == "copilot-proxy-rs"
  and .defaultModel == "gpt-5.6-sol"
  and .defaultThinkingLevel == "medium"
  and .defaultProjectTrust == "never"
  and .enableInstallTelemetry == false
  and (.packages | length) == 10
' "$agent_root/settings.json" >/dev/null || fail 'managed Pi settings differ'
jq -e '
  .providers["copilot-proxy-rs"].baseUrl == "http://127.0.0.1:8080/v1"
  and .providers["copilot-proxy-rs"].api == "openai-responses"
  and .providers["copilot-proxy-rs"].apiKey == "none"
  and .providers["copilot-proxy-rs"].authHeader == false
  and .providers["copilot-proxy-rs"].models[0].id == "gpt-5.6-sol"
' "$agent_root/models.json" >/dev/null || fail 'managed proxy model differs'
jq -e '
  .settings.hostConfigDiscovery == "off"
  and (.imports // []) == []
  and .mcpServers == {}
' "$agent_root/mcp.json" >/dev/null || fail 'managed MCP isolation differs'
grep -Fqx '# Fixture show-me skill' "$agent_root/skills/show-me/SKILL.md" \
  || fail 'show-me was not installed from the shared floating cache'
grep -Fqx '# Fixture personal skill' "$agent_root/skills/fixture-personal/SKILL.md" \
  || fail 'personal skills were not installed from the shared floating cache'
[[ "$(<"$agent_root/skills/.trellage-managed-skills")" == $'fixture-personal\nshow-me' ]] \
  || fail 'floating skill manifest differs'
cmp -s "$HOME/.copilot/models.json" "$profile_root/.copilot-models.json" \
  || fail 'Copilot model catalog snapshot differs'

cat >"$fixture_root/expected-extensions" <<'EXPECTED'
git:github.com/DietrichGebert/ponytail
npm:pi-web-access
npm:pi-subagents@0.34.0
npm:@ff-labs/pi-fff@0.10.5
npm:pi-context-view
npm:pi-mcp-adapter
npm:@narumitw/pi-btw@0.11.0
npm:@plannotator/pi-extension@0.20.3
npm:@narumitw/pi-goal@0.48.0
npm:@quintinshaw/pi-dynamic-workflows@2.14.1
EXPECTED
cmp -s "$fixture_root/expected-extensions" "$FAKE_EXTENSION_LOG" \
  || fail 'Pi extension install order differs'
jq -r '.[].installSpec' "$profile_root/extensions.json" \
  >"$fixture_root/installed-extension-order"
cmp -s "$fixture_root/expected-extensions" "$fixture_root/installed-extension-order" \
  || fail 'managed extension manifest order differs'

[[ -f "$agent_root/npm/node_modules/@ff-labs/fff-bun/package.json" ]] \
  || fail 'FFF Bun dependency is missing'
[[ -f "$agent_root/npm/node_modules/@ff-labs/fff-node/package.json" ]] \
  || fail 'FFF Node dependency is missing'
[[ -f "$agent_root/git/github.com/DietrichGebert/ponytail/package.json" ]] \
  || fail 'Ponytail git package is missing'

rm -- "$agent_root/npm/node_modules/@ff-labs/fff-bun/package.json"
status=0
"$command_path" doctor >"$fixture_root/missing-fff.out" \
  2>"$fixture_root/missing-fff.err" || status=$?
[[ "$status" == 1 ]] || fail "missing FFF dependency exited $status instead of 1"
grep -Fq 'managed pi-fff dependency is missing: @ff-labs/fff-bun' \
  "$fixture_root/missing-fff.err" \
  || fail 'missing FFF dependency did not report a clear error'
: >"$FAKE_EXTENSION_LOG"
"$command_path" repair >/dev/null
[[ -f "$agent_root/npm/node_modules/@ff-labs/fff-bun/package.json" ]] \
  || fail 'repair did not restore the FFF dependency'
cmp -s "$fixture_root/expected-extensions" "$FAKE_EXTENSION_LOG" \
  || fail 'repair did not reinstall the exact extension order'

cp "$agent_root/settings.json" "$fixture_root/settings.before"
status=0
PI_TEST_FAIL_AT=after-models "$command_path" repair \
  >"$fixture_root/rollback.out" 2>"$fixture_root/rollback.err" || status=$?
[[ "$status" == 1 ]] || fail "injected publication failure exited $status instead of 1"
cmp -s "$fixture_root/settings.before" "$agent_root/settings.json" \
  || fail 'publication rollback did not restore settings'
"$command_path" repair >/dev/null

"$command_path" doctor >/dev/null
"$command_path" inventory default --json >"$fixture_root/inventory.json"
jq -e '
  .readiness == "healthy"
  and .harness == "pi"
  and .harnessVersion == "0.84.2"
  and .model == "copilot-proxy-rs/gpt-5.6-sol:medium"
  and (.extensions | length) == 10
' "$fixture_root/inventory.json" >/dev/null || fail 'ready inventory differs'
grep -Fqx -- '-fsS --max-time 5 http://127.0.0.1:8080/health' \
  "$FAKE_PROXY_LOG" || fail 'doctor omitted proxy health check'
grep -Fqx -- '-fsS --max-time 5 http://127.0.0.1:8080/v1/models' \
  "$FAKE_PROXY_LOG" || fail 'doctor omitted proxy model discovery'

COPILOT_GITHUB_TOKEN='do-not-forward' \
GH_TOKEN='do-not-forward' \
GITHUB_TOKEN='do-not-forward' \
OPENAI_API_KEY='do-not-forward' \
OPENAI_BASE_URL='https://invalid.example.test/v1' \
AZURE_OPENAI_API_KEY='do-not-forward' \
"$command_path" -p 'what extensions are installed' >"$fixture_root/live.out" \
  2>"$fixture_root/live.err"
cmp -s <(jq -r '.[].name' "$profile_root/extensions.json") "$fixture_root/live.out" \
  || fail 'non-interactive extension report differs'
grep -Fq "$agent_root|$profile_root/.copilot-models.json|copilot=|gh=|github=|openai=|openai_base=|azure=|" \
  "$FAKE_LAUNCH_LOG" || fail 'launch isolation environment differs'
grep -Fq -- '--provider copilot-proxy-rs --model gpt-5.6-sol --thinking medium' \
  "$FAKE_LAUNCH_LOG" || fail 'launch model selection differs'
grep -Fq 'This picx profile has exactly these Pi extensions installed, in order:' \
  "$FAKE_LAUNCH_LOG" || fail 'launch omitted extension inventory context'
if grep -Eq 'plan.*HTTP 401|MCP finished with failures.*plan' \
  "$fixture_root/live.out" "$fixture_root/live.err"; then
  fail 'launch inherited the host Claude plan MCP'
fi

"$command_path" --headless-policy no-user-input -p 'headless probe' >/dev/null
grep -Fq -- '--exclude-tools ask_question' "$FAKE_LAUNCH_LOG" \
  || fail 'headless policy did not exclude ask_question'
"$command_path" update --check >"$fixture_root/update-check.out"
grep -Fqx 'picx update: 0.84.2 is current' "$fixture_root/update-check.out" \
  || fail 'update check differs'

"$uninstaller" >/dev/null
[[ ! -e "$command_path" && ! -e "$runtime_root" ]] || fail 'uninstall left runtime'
[[ -f "$profile_root/extensions.json" ]] || fail 'uninstall removed Pi profile state'
grep -Fqx 'legacy OMP state' "$HOME/.omp/profiles/trellage-picx-default/canary" \
  || fail 'uninstall altered the legacy OMP profile'

bash -n "$launcher" "$installer" "$uninstaller" "$0"
printf 'PICX native launcher contract: PASS\n'
