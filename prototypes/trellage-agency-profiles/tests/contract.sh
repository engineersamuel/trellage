#!/usr/bin/env bash
set -euo pipefail

prototype_root="$(CDPATH= cd -P -- "$(dirname "$0")/.." && pwd -P)"
repository_root="$(CDPATH= cd -P -- "$prototype_root/../.." && pwd -P)"
. "$repository_root/tests/helpers/floating_skills_fixture.sh"

fail() {
  printf 'agx contract: FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  grep -Fq -- "$1" "$2" || fail "missing '$1' in $2"
}

assert_line() {
  grep -Fxq -- "$1" "$2" || fail "missing exact line '$1' in $2"
}

file_mode() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

fixture_root="$prototype_root/.contract-fixture.$$"
fixture_home="$fixture_root/home"
fixture_bin="$fixture_root/bin"
worktree="$fixture_root/worktree"
agency_log="$fixture_root/agency.jsonl"
agency_command_log="$fixture_root/agency-commands"
main_copilot="$fixture_home/.copilot"
main_sentinel="$main_copilot/sentinel"
real_node="$(command -v node)"
real_jq="$(command -v jq)"

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

mkdir -p "$fixture_home" "$fixture_bin" "$worktree" "$main_copilot"
printf 'main state\n' >"$main_sentinel"
seed_floating_skills_cache "$fixture_home"
ln -s "$real_node" "$fixture_bin/node"
ln -s "$real_jq" "$fixture_bin/jq"
ln -s "$(command -v git)" "$fixture_bin/git"
git -C "$worktree" init -q
cp "$repository_root/agency.toml" "$worktree/agency.toml"

cat >"$fixture_bin/agency" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_AGENCY_COMMAND_LOG"
if [[ "${1-} ${2-} ${3-}" == 'config check --skip-remotes' ]]; then
  [[ "${FAKE_AGENCY_CONFIG_CHECK_FAIL-}" != 1 ]] || exit 65
  exit 0
fi
if [[ "${1-} ${2-} ${3-}" == 'config list --show-source' ]]; then
  [[ "${FAKE_AGENCY_CONFIG_LIST_FAIL-}" != 1 ]] || exit 66
  printf 'profile trellage-azure source %s\n' "$FAKE_AGENCY_CONFIG_PATH"
  exit 0
fi
jq -cn \
  --arg copilotHome "${COPILOT_HOME-}" \
  --arg home "$HOME" \
  --arg cwd "$PWD" \
  --arg auth "${AZURE_TOKEN_CREDENTIALS-}" \
  '$ARGS.named + {args: $ARGS.positional}' \
  --args -- "$@" >>"$FAKE_AGENCY_LOG"
EOF
chmod 0755 "$fixture_bin/agency"

cat >"$fixture_bin/az" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1-} ${2-}" == 'account show' ]] || exit 64
[[ "${FAKE_AZ_READY-}" == 1 ]]
EOF
chmod 0755 "$fixture_bin/az"

for command_name in npm npx; do
  cat >"$fixture_bin/$command_name" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod 0755 "$fixture_bin/$command_name"
done

export HOME="$fixture_home"
export PATH="$fixture_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FAKE_AGENCY_LOG="$agency_log"
export FAKE_AGENCY_COMMAND_LOG="$agency_command_log"
export FAKE_AGENCY_CONFIG_PATH="$worktree/agency.toml"
export FAKE_AZ_READY=1
unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID AZURE_TOKEN_CREDENTIALS
: >"$agency_log"
: >"$agency_command_log"

launcher="$prototype_root/bin/agx"
bash -n "$launcher" "$prototype_root/install.sh" "$prototype_root/uninstall.sh" \
  "$prototype_root/tests/live.sh" \
  || fail 'shell syntax check failed'
jq -e . "$prototype_root/catalog.json" >/dev/null || fail 'catalog is invalid JSON'

if TRELLAGE_AGENCY_LIVE= "$prototype_root/tests/live.sh" \
  >"$fixture_root/live-disabled.out" 2>"$fixture_root/live-disabled.err"; then
  fail 'live proof ran without explicit opt-in'
fi
assert_line \
  'agx live: set TRELLAGE_AGENCY_LIVE=1 to run the paid, authenticated live proof' \
  "$fixture_root/live-disabled.err"
[[ ! -s "$fixture_root/live-disabled.out" ]] || fail 'disabled live proof wrote stdout'

"$launcher" list >"$fixture_root/list"
assert_line $'trellage-azure\ttrellage-azure' "$fixture_root/list"
"$launcher" list --json >"$fixture_root/list.json"
jq -e '
  .schemaVersion == 1
  and .launcher == "agx"
  and .harness == "agency"
  and .sandbox == false
  and (.profiles | length) == 1
  and .profiles[0].name == "trellage-azure"
  and .profiles[0].headless.prompt == false
  and .profiles[0].plugin == null
  and .profiles[0].standaloneMcps == [
    {"name":"msft-learn","transport":"built-in"},
    {"name":"azure","transport":"stdio"}
  ]
' "$fixture_root/list.json" >/dev/null || fail 'list JSON differs'

(
  cd "$worktree"
  "$launcher" inventory trellage-azure --json
) >"$fixture_root/not-setup.json"
jq -e '
  .readiness == "not-setup"
  and .agencyExecutable == null
  and .configFile == null
  and (.copilotHome | endswith("/profiles/agency/trellage-azure/home"))
' "$fixture_root/not-setup.json" >/dev/null || fail 'not-setup inventory differs'

(
  cd "$worktree"
  "$launcher" setup trellage-azure
) >"$fixture_root/setup.out"
assert_contains 'trellage-azure: healthy' "$fixture_root/setup.out"
expected_home="$fixture_home/.local/share/trellage/profiles/agency/trellage-azure/home"
[[ -d "$expected_home" && ! -L "$expected_home" ]] || fail 'profile home was not created safely'
[[ "$(file_mode "$expected_home")" == 700 ]] \
  || fail 'profile home mode differs'
assert_line 'trellage-agency-profile-v1' \
  "$fixture_home/.local/share/trellage/profiles/agency/trellage-azure/.managed-by-trellage-agency-profiles"

(
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/doctor.out"
assert_line \
  'trellage-azure: healthy (Agency profile trellage-azure, Azure MCP 2.0.5, auth AzureCliCredential)' \
  "$fixture_root/doctor.out"

export FAKE_AGENCY_CONFIG_PATH="$fixture_root/unrelated-agency.toml"
if (
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/config-source.out" 2>"$fixture_root/config-source.err"; then
  fail 'doctor accepted an Agency profile sourced from another config'
fi
assert_contains 'Agency profile is not sourced from the repository config' \
  "$fixture_root/config-source.err"
export FAKE_AGENCY_CONFIG_PATH="$worktree/agency.toml"

export FAKE_AGENCY_CONFIG_CHECK_FAIL=1
if (
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/config-check.out" 2>"$fixture_root/config-check.err"; then
  fail 'doctor accepted an invalid Agency config'
fi
assert_contains 'Agency config validation failed' "$fixture_root/config-check.err"
unset FAKE_AGENCY_CONFIG_CHECK_FAIL

(
  cd "$worktree"
  "$launcher" inventory trellage-azure --json
) >"$fixture_root/inventory.json"
jq -e \
  --arg agency "$fixture_bin/agency" \
  --arg config "$worktree/agency.toml" \
  --arg home "$expected_home" '
  .schemaVersion == 1
  and .launcher == "agx"
  and .harness == "agency"
  and .profile == "trellage-azure"
  and .readiness == "healthy"
  and .agencyProfile == "trellage-azure"
  and .agencyExecutable == $agency
  and .configFile == $config
  and .copilotHome == $home
  and .azureMcpVersion == "2.0.5"
  and .authenticationMethod == "AzureCliCredential"
  and .mcps == ["msft-learn","azure"]
  and (.tools | length) == 11
  and (.tools | index("subscription_list") != null)
  and (.tools | index("resourcehealth_health-events_list") != null)
' "$fixture_root/inventory.json" >/dev/null || fail 'healthy inventory differs'

checks_before_launch="$(grep -Fxc 'config check --skip-remotes' "$agency_command_log")"
sources_before_launch="$(grep -Fxc 'config list --show-source' "$agency_command_log")"
(
  cd "$worktree"
  "$launcher" trellage-azure 'space value' '' '*' --model gpt-5.6-sol
)
jq -e \
  --arg home "$expected_home" \
  --arg realHome "$fixture_home" \
  --arg cwd "$worktree" '
  .copilotHome == $home
  and .home == $realHome
  and .cwd == $cwd
  and .auth == "AzureCliCredential"
  and .args == [
    "copilot",
    "--profile-only",
    "trellage-azure",
    "--",
    "space value",
    "",
    "*",
    "--model",
    "gpt-5.6-sol"
  ]
' "$agency_log" >/dev/null || fail 'launch environment or argument forwarding differs'
[[ "$(grep -Fxc 'config check --skip-remotes' "$agency_command_log")" \
  -eq $((checks_before_launch + 1)) ]] \
  || fail 'launch repeated Agency config validation'
[[ "$(grep -Fxc 'config list --show-source' "$agency_command_log")" \
  -eq $((sources_before_launch + 1)) ]] \
  || fail 'launch repeated Agency config source inspection'
[[ "$(<"$main_sentinel")" == 'main state' ]] || fail 'main Copilot state changed'
[[ "$(find "$main_copilot" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" == 1 ]] \
  || fail 'launcher wrote into the main Copilot home'

standard_agency="$fixture_home/.config/agency/CurrentVersion/agency"
mkdir -p "$(dirname "$standard_agency")"
mv "$fixture_bin/agency" "$standard_agency"
(
  cd "$worktree"
  "$launcher" inventory trellage-azure --json
) >"$fixture_root/standard-agency.json"
jq -e --arg agency "$standard_agency" '
  .readiness == "healthy"
  and .agencyExecutable == $agency
' "$fixture_root/standard-agency.json" >/dev/null \
  || fail 'standard Agency install path was not detected'
mv "$standard_agency" "$fixture_bin/agency"
rmdir "$fixture_home/.config/agency/CurrentVersion" \
  "$fixture_home/.config/agency" "$fixture_home/.config"

mv "$fixture_bin/agency" "$fixture_bin/agency.absent"
if (
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/missing-agency.out" 2>"$fixture_root/missing-agency.err"; then
  fail 'doctor accepted a missing Agency installation'
fi
assert_line \
  'agx: Agency is not installed; run: curl -sSfL https://aka.ms/InstallTool.sh | sh -s agency' \
  "$fixture_root/missing-agency.err"
mv "$fixture_bin/agency.absent" "$fixture_bin/agency"

export FAKE_AZ_READY=0
export AZURE_CLIENT_ID='fixture-client'
export AZURE_CLIENT_SECRET='FIXTURE_SECRET_MUST_NOT_PRINT'
export AZURE_TENANT_ID='fixture-tenant'
(
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/environment-auth.out"
assert_contains 'auth EnvironmentCredential' "$fixture_root/environment-auth.out"
if grep -Fq 'FIXTURE_SECRET_MUST_NOT_PRINT' "$fixture_root/environment-auth.out"; then
  fail 'doctor printed a credential value'
fi
unset AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
if (
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/no-auth.out" 2>"$fixture_root/no-auth.err"; then
  fail 'doctor accepted unavailable Azure authentication'
fi
assert_line \
  'agx: Azure authentication is unavailable; set environment credentials or run az login' \
  "$fixture_root/no-auth.err"
export FAKE_AZ_READY=1

mv "$worktree/agency.toml" "$worktree/agency.toml.real"
ln -s "$worktree/agency.toml.real" "$worktree/agency.toml"
if (
  cd "$worktree"
  "$launcher" doctor trellage-azure
) >"$fixture_root/config-symlink.out" 2>"$fixture_root/config-symlink.err"; then
  fail 'doctor accepted a symlinked repository Agency config'
fi
assert_contains 'repository Agency config is missing or unsafe' "$fixture_root/config-symlink.err"
rm "$worktree/agency.toml"
mv "$worktree/agency.toml.real" "$worktree/agency.toml"

profile_root="$fixture_home/.local/share/trellage/profiles/agency/trellage-azure"
rm -rf -- "$profile_root"
mv "$fixture_home/.local/share/trellage/profiles/agency" \
  "$fixture_home/.local/share/trellage/profiles/agency.real"
ln -s "$fixture_home/.local/share/trellage/profiles/agency.real" \
  "$fixture_home/.local/share/trellage/profiles/agency"
if (
  cd "$worktree"
  "$launcher" setup trellage-azure
) >"$fixture_root/profile-symlink.out" 2>"$fixture_root/profile-symlink.err"; then
  fail 'setup accepted a symlinked profile ancestor'
fi
assert_contains 'unsafe profile home path' "$fixture_root/profile-symlink.err"
rm "$fixture_home/.local/share/trellage/profiles/agency"
mv "$fixture_home/.local/share/trellage/profiles/agency.real" \
  "$fixture_home/.local/share/trellage/profiles/agency"

agency_config="$repository_root/agency.toml"
grep -Fq '@azure/mcp@2.0.5' "$agency_config" \
  || fail 'Agency config does not pin Azure MCP 2.0.5'
grep -Fq '"--read-only"' "$agency_config" \
  || fail 'Agency config does not enforce Azure MCP read-only mode'
if grep -Eq '@azure/mcp@(latest|next|beta)|tools[[:space:]]*=[[:space:]]*\\[[[:space:]]*"\\*"' \
  "$agency_config"; then
  fail 'Agency config contains a floating package or wildcard tools'
fi
if grep -Eiq '(client_secret|access_token|refresh_token|password|bearer[[:space:]]+[A-Za-z0-9])' \
  "$agency_config"; then
  fail 'Agency config contains secret-shaped material'
fi
for forbidden_tool in create delete update upload send deploy; do
  if grep -Eq "\"[^\"]*${forbidden_tool}[^\"]*\"" "$agency_config"; then
    fail "Agency config exposes a write-capable tool: $forbidden_tool"
  fi
done

install_home="$fixture_root/install-home"
mkdir -p "$install_home"
(
  export HOME="$install_home"
  "$prototype_root/install.sh"
) >"$fixture_root/install.out"
assert_contains 'Installed agx at ' "$fixture_root/install.out"
installed_root="$install_home/.local/share/trellage/agx"
installed_command="$install_home/.local/bin/agx"
[[ -x "$installed_root/bin/agx" && -f "$installed_root/catalog.json" ]] \
  || fail 'installer did not publish runtime files'
[[ -L "$installed_command" && "$(readlink "$installed_command")" == "$installed_root/bin/agx" ]] \
  || fail 'installer did not publish the exact command symlink'
assert_line 'trellage-agency-profiles-v1' \
  "$installed_root/.managed-by-trellage-agency-profiles"

(
  export HOME="$install_home"
  "$prototype_root/install.sh"
) >"$fixture_root/reinstall.out"
assert_contains 'Installed agx at ' "$fixture_root/reinstall.out"

preserved_profile="$install_home/.local/share/trellage/profiles/agency/trellage-azure/home"
mkdir -p "$preserved_profile"
printf 'preserve\n' >"$preserved_profile/session"
(
  export HOME="$install_home"
  "$prototype_root/uninstall.sh"
) >"$fixture_root/uninstall.out"
assert_line 'Uninstalled agx; profile homes were preserved.' "$fixture_root/uninstall.out"
[[ ! -e "$installed_root" && ! -L "$installed_command" ]] \
  || fail 'uninstaller left managed launcher files'
assert_line 'preserve' "$preserved_profile/session"

collision_home="$fixture_root/collision-home"
mkdir -p "$collision_home/.local/bin"
printf '#!/usr/bin/env bash\nprintf unrelated\n' >"$collision_home/.local/bin/agx"
chmod 0755 "$collision_home/.local/bin/agx"
if (
  export HOME="$collision_home"
  "$prototype_root/install.sh"
) >"$fixture_root/collision.out" 2>"$fixture_root/collision.err"; then
  fail 'installer replaced an unrelated agx command'
fi
assert_contains 'refusing to replace unrelated command' "$fixture_root/collision.err"
assert_contains 'printf unrelated' "$collision_home/.local/bin/agx"

if grep -Fq 'npx ' "$agency_command_log"; then
  fail 'static launcher commands invoked the Azure MCP executable'
fi
if grep -Eiq 'login|browser' "$agency_command_log"; then
  fail 'static launcher commands attempted authentication'
fi

printf 'agx contract: PASS\n'
