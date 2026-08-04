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

printf 'trellage installer test: PASS\n'
