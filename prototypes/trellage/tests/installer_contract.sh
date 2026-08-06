#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-installer-test.XXXXXX")"
test_root="$(cd "$test_root" && pwd -P)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'trellage installer test: FAIL: %s\n' "$1" >&2
  exit 1
}

installed="$test_root/bin/trellage"
legacy_installed="$test_root/bin/harness"
task_project="$test_root/mise project"
mkdir -p "$test_root/bin" "$task_project"
cp "$prototype_dir/trellage" "$prototype_dir/install-trellage.sh" "$prototype_dir/mise.toml" "$task_project/"
export MISE_DATA_DIR="$test_root/mise-data"
export MISE_AUTO_INSTALL=0
mise trust --quiet "$task_project/mise.toml"

(
  cd "$task_project"
  TRELLAGE_INSTALL_DIR="$test_root/bin" mise run install-trellage
)
[[ -L "$installed" ]] || fail 'mise install task did not create a symlink'
[[ "$(readlink "$installed")" == "$task_project/trellage" ]] \
  || fail 'installed Trellage does not resolve to the prototype command'
[[ ! -e "$legacy_installed" && ! -L "$legacy_installed" ]] \
  || fail 'mise install task created a harness compatibility symlink'

if ! dry_run_output="$(
  cd "$task_project"
  TRELLAGE_INSTALL_DIR="$test_root/bin" mise run uninstall-trellage-dry-run
)"; then
  fail 'mise uninstall dry-run task failed for its owned symlink'
fi
[[ "$dry_run_output" == "trellage installer: would remove $installed" ]] \
  || fail 'mise uninstall dry-run task did not report its exact owned symlink'
[[ -L "$installed" ]] || fail 'mise uninstall dry-run task removed its owned symlink'
[[ "$(readlink "$installed")" == "$task_project/trellage" ]] \
  || fail 'mise uninstall dry-run task changed its owned symlink'

(
  cd "$task_project"
  TRELLAGE_INSTALL_DIR="$test_root/bin" mise run install-trellage
  TRELLAGE_INSTALL_DIR="$test_root/bin" mise run uninstall-trellage
)
[[ ! -e "$installed" && ! -L "$installed" ]] || fail 'mise uninstall task did not remove its symlink'

if ! dry_run_output="$(
  cd "$task_project"
  TRELLAGE_INSTALL_DIR="$test_root/bin" mise run uninstall-trellage-dry-run
)"; then
  fail 'mise uninstall dry-run task failed for an absent destination'
fi
[[ "$dry_run_output" == "trellage installer: already absent at $installed" ]] \
  || fail 'mise uninstall dry-run task did not report its absent destination'
[[ ! -e "$installed" && ! -L "$installed" ]] \
  || fail 'mise uninstall dry-run task created an absent destination'

TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" install
profile="$(cd "$prototype_dir/../../profiles/codex-superpowers" && pwd -P)/profile.toml"
if ! validate_output="$("$installed" validate "$profile")"; then
  fail 'installed symlink could not reach the profile compiler'
fi
[[ "$validate_output" == "valid: $profile" ]] \
  || fail 'installed symlink returned unexpected profile validation output'
pi_profile="$(cd "$prototype_dir/../../profiles/pi-oh-my-pi" && pwd -P)/profile.toml"
if ! validate_output="$("$installed" validate "$pi_profile")"; then
  fail 'installed symlink could not validate the bundled Pi profile'
fi
[[ "$validate_output" == "valid: $pi_profile" ]] \
  || fail 'installed symlink returned unexpected Pi profile validation output'
if ! dry_run_output="$(TRELLAGE_INSTALL_DIR="$test_root/bin" \
  "$prototype_dir/install-trellage.sh" uninstall --dry-run)"; then
  fail 'direct uninstall dry-run failed for its owned symlink'
fi
[[ "$dry_run_output" == "trellage installer: would remove $installed" ]] \
  || fail 'direct uninstall dry-run did not report its exact owned symlink'
[[ -L "$installed" ]] || fail 'direct uninstall dry-run removed its owned symlink'
[[ "$(readlink "$installed")" == "$prototype_dir/trellage" ]] \
  || fail 'direct uninstall dry-run changed its owned symlink'
TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" uninstall

dry_run_output="$(TRELLAGE_INSTALL_DIR="$test_root/bin" \
  "$prototype_dir/install-trellage.sh" uninstall --dry-run)"
[[ "$dry_run_output" == "trellage installer: already absent at $installed" ]] \
  || fail 'direct uninstall dry-run did not report its absent destination'
[[ ! -e "$installed" && ! -L "$installed" ]] \
  || fail 'direct uninstall dry-run created an absent destination'

TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" install
race_bin="$test_root/race-bin"
race_replacement="$test_root/race-replacement"
race_error="$test_root/race-error"
real_mv="$(command -v mv)"
mkdir -p -- "$race_bin"
printf 'unrelated race replacement\n' >"$race_replacement"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "$#" -eq 3 && "$1" == -- && "$2" == "$RACE_DESTINATION" ]]; then' \
  '  /bin/rm -- "$RACE_DESTINATION"' \
  '  /bin/cp "$RACE_REPLACEMENT" "$RACE_DESTINATION"' \
  'fi' \
  'exec "$REAL_MV" "$@"' \
  >"$race_bin/mv"
chmod +x "$race_bin/mv"
if PATH="$race_bin:$PATH" \
  REAL_MV="$real_mv" \
  RACE_DESTINATION="$installed" \
  RACE_REPLACEMENT="$race_replacement" \
  TRELLAGE_INSTALL_DIR="$test_root/bin" \
  "$prototype_dir/install-trellage.sh" uninstall 2>"$race_error"; then
  fail 'uninstaller succeeded after an unrelated replacement race'
fi
[[ -f "$installed" && ! -L "$installed" ]] \
  || fail 'replacement race did not preserve the unrelated destination'
grep -Fqx 'unrelated race replacement' "$installed" \
  || fail 'replacement race deleted or changed unrelated destination contents'
grep -Fq 'refusing to remove quarantined unrelated path:' "$race_error" \
  || fail 'replacement race did not report the quarantined unrelated path'
rm -- "$installed"

default_home="$test_root/home"
mkdir -p -- "$default_home"
(
  unset TRELLAGE_INSTALL_DIR XDG_BIN_HOME
  HOME="$default_home" "$prototype_dir/install-trellage.sh" install
)
[[ -L "$default_home/.local/bin/trellage" ]] \
  || fail 'default install did not create ~/.local/bin/trellage'
[[ "$(readlink "$default_home/.local/bin/trellage")" == "$prototype_dir/trellage" ]] \
  || fail 'default installed Trellage does not resolve to the prototype command'
[[ ! -e "$default_home/.local/bin/harness" \
  && ! -L "$default_home/.local/bin/harness" ]] \
  || fail 'default install created ~/.local/bin/harness compatibility symlink'
(
  unset TRELLAGE_INSTALL_DIR XDG_BIN_HOME
  HOME="$default_home" "$prototype_dir/install-trellage.sh" uninstall
)

xdg_home="$test_root/xdg-bin"
fallback_home="$test_root/xdg-fallback-home"
mkdir -p -- "$fallback_home"
(
  unset TRELLAGE_INSTALL_DIR
  XDG_BIN_HOME="$xdg_home" HOME="$fallback_home" \
    "$prototype_dir/install-trellage.sh" install
)
[[ -L "$xdg_home/trellage" ]] \
  || fail 'XDG_BIN_HOME install did not create its Trellage symlink'
[[ ! -e "$fallback_home/.local/bin/trellage" \
  && ! -L "$fallback_home/.local/bin/trellage" ]] \
  || fail 'HOME fallback took precedence over XDG_BIN_HOME'
(
  unset TRELLAGE_INSTALL_DIR
  XDG_BIN_HOME="$xdg_home" HOME="$fallback_home" \
    "$prototype_dir/install-trellage.sh" uninstall
)

unset_error="$test_root/unset-install-dir-error"
if (
  unset TRELLAGE_INSTALL_DIR XDG_BIN_HOME HOME
  "$prototype_dir/install-trellage.sh" uninstall
) 2>"$unset_error"; then
  fail 'installer accepted fully unset install-directory inputs'
fi
grep -Fq 'HOME is unset; set TRELLAGE_INSTALL_DIR explicitly' "$unset_error" \
  || fail 'fully unset install-directory inputs did not report recovery'

(
  cd "$test_root"
  TRELLAGE_INSTALL_DIR='-option-safe-bin' \
    "$prototype_dir/install-trellage.sh" install
  [[ -L '-option-safe-bin/trellage' ]] \
    || fail 'option-like relative install directory was not created safely'
  TRELLAGE_INSTALL_DIR='-option-safe-bin' \
    "$prototype_dir/install-trellage.sh" uninstall
)

printf 'unrelated command\n' >"$installed"
if TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" install; then
  fail 'installer overwrote an unrelated command'
fi
grep -Fqx 'unrelated command' "$installed" || fail 'installer changed unrelated command contents'
if TRELLAGE_INSTALL_DIR="$test_root/bin" \
  "$prototype_dir/install-trellage.sh" uninstall --dry-run; then
  fail 'dry-run uninstaller accepted an unrelated command'
fi
grep -Fqx 'unrelated command' "$installed" \
  || fail 'dry-run uninstaller changed unrelated command contents'
if TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" uninstall; then
  fail 'uninstaller removed an unrelated command'
fi
grep -Fqx 'unrelated command' "$installed" || fail 'uninstaller changed unrelated command contents'
rm "$installed"

unrelated_target="$test_root/unrelated-trellage"
printf 'unrelated symlink target\n' >"$unrelated_target"
ln -s "$unrelated_target" "$installed"
if TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" install; then
  fail 'installer overwrote an unrelated symlink'
fi
[[ -L "$installed" ]] || fail 'installer removed an unrelated symlink'
[[ "$(readlink "$installed")" == "$unrelated_target" ]] \
  || fail 'installer changed an unrelated symlink target'
if TRELLAGE_INSTALL_DIR="$test_root/bin" \
  "$prototype_dir/install-trellage.sh" uninstall --dry-run; then
  fail 'dry-run uninstaller accepted an unrelated symlink'
fi
[[ -L "$installed" ]] || fail 'dry-run uninstaller removed an unrelated symlink'
[[ "$(readlink "$installed")" == "$unrelated_target" ]] \
  || fail 'dry-run uninstaller changed an unrelated symlink'
if TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" uninstall; then
  fail 'uninstaller removed an unrelated symlink'
fi
[[ -L "$installed" ]] || fail 'uninstaller removed an unrelated symlink after refusing it'
[[ "$(readlink "$installed")" == "$unrelated_target" ]] \
  || fail 'uninstaller changed an unrelated symlink after refusing it'
rm "$installed"

usage_error="$test_root/usage-error"
if TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" \
  install --dry-run 2>"$usage_error"; then
  fail 'installer accepted install --dry-run'
fi
grep -Fq 'usage: install-trellage.sh' "$usage_error" \
  || fail 'invalid installer arguments did not report usage'

relocated="$test_root/prototype location"
mkdir -p "$relocated"
cp "$prototype_dir/trellage" "$prototype_dir/install-trellage.sh" "$relocated/"
TRELLAGE_INSTALL_DIR="$test_root/bin" "$relocated/install-trellage.sh" install
[[ "$(readlink "$installed")" == "$relocated/trellage" ]] \
  || fail 'relocated installer did not resolve its prototype command physically'
TRELLAGE_INSTALL_DIR="$test_root/bin" "$relocated/install-trellage.sh" uninstall
[[ ! -L "$installed" ]] || fail 'relocated uninstaller left its owned symlink'

printf 'legacy command\n' >"$legacy_installed"
TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" install
TRELLAGE_INSTALL_DIR="$test_root/bin" "$prototype_dir/install-trellage.sh" uninstall
grep -Fqx 'legacy command' "$legacy_installed" \
  || fail 'normal install or uninstall changed the legacy harness path'

repo_root="$(cd "$prototype_dir/../.." && pwd -P)"
root_mise_config="$repo_root/mise.toml"
[[ -f "$root_mise_config" ]] || fail 'repository root has no mise config for worktree-local Trellage'
mise trust --quiet "$root_mise_config"
root_trellage="$({
  cd "$repo_root"
  mise exec -- bash -c 'command -v trellage'
})"
[[ "$root_trellage" == "$prototype_dir/trellage" ]] \
  || fail 'repository-root mise activation did not select worktree-local Trellage'

dispatch_main="$test_root/dispatch main"
dispatch_worktree="$test_root/dispatch worktree"
dispatch_bin="$test_root/dispatch bin"
dispatch_log="$test_root/worktree-dispatch.log"
dispatch_error="$test_root/worktree-dispatch.error"
mkdir -p "$dispatch_main/prototypes/trellage" "$dispatch_main/packages/trellage-cli" "$dispatch_bin"
cp "$prototype_dir/trellage" "$dispatch_main/prototypes/trellage/trellage"
chmod 0755 "$dispatch_main/prototypes/trellage/trellage"
git init -q "$dispatch_main"
git -C "$dispatch_main" add prototypes/trellage/trellage
git -C "$dispatch_main" \
  -c user.name='Trellage Test' \
  -c user.email='trellage-test@example.invalid' \
  -c commit.gpgSign=false \
  commit -qm 'worktree dispatch fixture'
git -C "$dispatch_main" worktree add -q -b worktree-dispatch "$dispatch_worktree"
cat >"$dispatch_worktree/prototypes/trellage/trellage" <<'WORKTREE_COMMAND'
#!/usr/bin/env bash
set -euo pipefail
[[ "${COPILOT_GITHUB_TOKEN-}" == dispatch-copilot-token ]]
[[ "${GH_TOKEN-}" == dispatch-gh-token ]]
[[ "${GITHUB_TOKEN-}" == dispatch-github-token ]]
[[ "${CLAUDE_CODE_OAUTH_TOKEN-}" == dispatch-claude-token ]]
[[ "${ANTHROPIC_API_KEY-}" == dispatch-anthropic-token ]]
[[ "${PLAYWRIGHT_MCP_EXTENSION_TOKEN-}" == dispatch-playwright-token ]]
[[ "${APIFY_API_TOKEN-}" == dispatch-apify-token ]]
[[ "${GOOGLE_AI_API_KEY-}" == dispatch-google-token ]]
printf 'CALL\n' >>"$WORKTREE_DISPATCH_LOG"
printf 'ARG\t%s\n' "$@" >>"$WORKTREE_DISPATCH_LOG"
printf 'worktree-local\n'
WORKTREE_COMMAND
chmod 0755 "$dispatch_worktree/prototypes/trellage/trellage"
ln -s "$dispatch_main/prototypes/trellage/trellage" "$dispatch_bin/trellage"
dispatch_git_bin="$test_root/dispatch git bin"
dispatch_git_log="$test_root/dispatch-git-env.log"
real_git="$(command -v git)"
mkdir -p "$dispatch_git_bin"
cat >"$dispatch_git_bin/git" <<'DISPATCH_GIT'
#!/usr/bin/env bash
set -euo pipefail
for name in COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
  ANTHROPIC_API_KEY PLAYWRIGHT_MCP_EXTENSION_TOKEN APIFY_API_TOKEN GOOGLE_AI_API_KEY; do
  [[ -z "${!name-}" ]] || printf 'LEAK\t%s\n' "$name" >>"$GIT_ENV_LOG"
done
exec "$REAL_GIT" "$@"
DISPATCH_GIT
chmod 0755 "$dispatch_git_bin/git"
mkdir -p "$dispatch_worktree/nested directory"
if ! dispatch_output="$({
  cd "$dispatch_worktree/nested directory"
  PATH="$dispatch_git_bin:$PATH" \
    REAL_GIT="$real_git" \
    GIT_ENV_LOG="$dispatch_git_log" \
    COPILOT_GITHUB_TOKEN=dispatch-copilot-token \
    GH_TOKEN=dispatch-gh-token \
    GITHUB_TOKEN=dispatch-github-token \
    CLAUDE_CODE_OAUTH_TOKEN=dispatch-claude-token \
    ANTHROPIC_API_KEY=dispatch-anthropic-token \
    PLAYWRIGHT_MCP_EXTENSION_TOKEN=dispatch-playwright-token \
    APIFY_API_TOKEN=dispatch-apify-token \
    GOOGLE_AI_API_KEY=dispatch-google-token \
    WORKTREE_DISPATCH_LOG="$dispatch_log" \
    "$dispatch_bin/trellage" validate 'profile with spaces'
} 2>"$dispatch_error")"; then
  fail 'installed Trellage did not delegate to the active linked worktree'
fi
[[ "$dispatch_output" == worktree-local ]] \
  || fail 'worktree-local Trellage returned unexpected output'
[[ "$(cat "$dispatch_log")" == $'CALL\nARG\tvalidate\nARG\tprofile with spaces' ]] \
  || fail 'worktree-local Trellage did not preserve exact arguments'
[[ ! -s "$dispatch_git_log" ]] \
  || fail 'worktree discovery exposed ambient credentials to Git'
grep -Fqx \
  "trellage: using current worktree command: $dispatch_worktree/prototypes/trellage/trellage" \
  "$dispatch_error" \
  || fail 'installed Trellage did not report its worktree command override'

unrelated_repo="$test_root/unrelated repository"
unrelated_log="$test_root/unrelated-dispatch.log"
unrelated_error="$test_root/unrelated-dispatch.error"
mkdir -p "$unrelated_repo/prototypes/trellage" "$unrelated_repo/nested directory"
git init -q "$unrelated_repo"
cat >"$unrelated_repo/prototypes/trellage/trellage" <<'UNRELATED_COMMAND'
#!/usr/bin/env bash
set -euo pipefail
printf 'unexpected\n' >>"$WORKTREE_DISPATCH_LOG"
UNRELATED_COMMAND
chmod 0755 "$unrelated_repo/prototypes/trellage/trellage"
if (
  cd "$unrelated_repo/nested directory"
  WORKTREE_DISPATCH_LOG="$unrelated_log" "$dispatch_bin/trellage" validate
) >"$test_root/unrelated-dispatch.out" 2>"$unrelated_error"; then
  fail 'installed Trellage unexpectedly succeeded in an unrelated repository'
fi
[[ ! -s "$unrelated_log" ]] \
  || fail 'installed Trellage executed a lookalike command from an unrelated repository'
! grep -Fq 'using current worktree command:' "$unrelated_error" \
  || fail 'installed Trellage reported a worktree override in an unrelated repository'

printf 'trellage installer test: PASS\n'
