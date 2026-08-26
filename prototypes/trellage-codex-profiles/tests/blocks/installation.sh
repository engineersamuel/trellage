#!/usr/bin/env bash

# Block D: install.sh / uninstall.sh behaviour. Independent of the launcher
# fixture and of profile state, so it builds nothing beyond its own fixture root.

set -u
set -o pipefail

blocks_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
. "$blocks_dir/../lib/fixture.sh"

install_script="$root/install.sh"
uninstall_script="$root/uninstall.sh"
[ -f "$install_script" ] || fail 'install.sh is missing'
[ -f "$uninstall_script" ] || fail 'uninstall.sh is missing'

path_mode() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}' || return
  else
    sha256sum "$1" | awk '{print $1}' || return
  fi
}

assert_install_line() {
  grep -Fx -- "$1" "$2" >/dev/null || fail "missing exact line: $1"
}

assert_install_text() {
  grep -F -- "$1" "$2" >/dev/null || fail "missing text: $1"
}

printf 'assertion sentinel\n' >"$fixture_root/install-assertion-self-check"
assert_install_line 'assertion sentinel' "$fixture_root/install-assertion-self-check"
if (assert_install_line 'missing sentinel' \
  "$fixture_root/install-assertion-self-check") 2>/dev/null; then
  fail 'installation assertion helper accepted a missing line'
fi

readme="$root/README.md"
[ -f "$readme" ] || fail 'README.md is missing'
assert_install_text '~/.local/share/trellage/profiles/codex/<profile>/home/' "$readme"
assert_install_text '~/.local/share/trellage/profiles/copilot/<profile>/home/' "$readme"
assert_install_text '~/.local/share/trellage/profiles/grok/<profile>/home/' "$readme"
assert_install_text 'cdx setup --all' "$readme"
assert_install_text 'cdx --native-auth hve exec "Review this repository"' "$readme"
assert_install_text '`--sandbox workspace-write -c' "$readme"
assert_install_text 'MCP servers are profile-local.' "$readme"
assert_install_text 'do not require or copy `~/.codex/auth.json`.' "$readme"
assert_install_text 'only the selected profile' "$readme"
assert_install_text 'Missing or invalid native auth fails without proxy fallback.' "$readme"
assert_install_text 'official whole-repository Git source `https://github.com/microsoft/hve-core.git`' "$readme"
assert_install_text 'with `.github/skills` fallback metadata.' "$readme"
assert_install_text 'HVE update deliberately removes and reinstalls' "$readme"
assert_install_line 'Doctor performs no native marketplace/plugin mutation, but may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.' "$readme"
assert_install_text 'Reload Fish after install' "$readme"
assert_install_text 'It preserves every Codex profile home' "$readme"
assert_install_text 'existing readable, writable, regular' "$readme"
assert_install_text 'non-symlink `~/.config/fish/config.fish`' "$readme"
assert_install_text 'sequential atomic renames with guarded' "$readme"
assert_install_text 'Fish with' "$readme"
assert_install_text '`fish_indent`' "$readme"
assert_install_text 'explicit literal `cdx` alias or function' "$readme"
assert_install_text 'installation preserves' "$readme"
assert_install_text 'records that no line was removed' "$readme"
assert_install_text 'uninstall preserves that state and does not add a line' "$readme"
assert_install_text 'Dynamic or escaped alias/function names' "$readme"
assert_install_text 'Dynamic command names, `eval`, sourced files, and runtime function calls' "$readme"

assert_no_install_staging() {
  fixture_home="$1"
  staging_paths="$(find "$fixture_home" \( -name '.cdx-install.*' -o -name '.cdx-command.*' \
    -o -name '.cdx-fish.*' -o -name '.cdx-uninstall.*' \
    -o -name '.cdx-uninstall-command.*' -o -name '.cdx-uninstall-fish.*' \
    \) -print)" || fail "could not inspect installation staging beneath $fixture_home"
  [ -z "$staging_paths" ] \
    || fail "installation staging debris remains beneath $fixture_home: $staging_paths"
}

write_directory_topology() {
  topology_home="$1"
  topology_output="$2"
  find "$topology_home" -type d -print \
    | sed "s|^$topology_home||" \
    | LC_ALL=C sort >"$topology_output" \
    || fail "could not record directory topology beneath $topology_home"
}

write_owned_runtime_snapshot() {
  snapshot_root="$1"
  snapshot_output="$2"
  (
    CDPATH= cd -- "$snapshot_root"
    find . -print | LC_ALL=C sort | while IFS= read -r entry; do
      if [ -L "$entry" ]; then
        printf 'l\t%s\t%s\t%s\n' \
          "$(path_mode "$entry")" "$entry" "$(readlink "$entry")"
      elif [ -f "$entry" ]; then
        printf 'f\t%s\t%s\t%s\n' \
          "$(path_mode "$entry")" "$entry" "$(sha256_file "$entry")"
      elif [ -d "$entry" ]; then
        printf 'd\t%s\t%s\n' "$(path_mode "$entry")" "$entry"
      else
        fail "unsupported runtime entry in snapshot: $entry"
      fi
    done
  ) >"$snapshot_output" \
    || fail "could not snapshot owned runtime: $snapshot_root"
}

write_legacy_fish() {
  fixture_home="$1"
  mkdir -p "$fixture_home/.config/fish"
  printf '%s\n' \
    '# preserved before' \
    'set -gx TRELLAGE_FISH_SENTINEL "sp ace"' \
    'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
    '# preserved after' >"$fixture_home/.config/fish/config.fish"
  chmod 0640 "$fixture_home/.config/fish/config.fish"
}

write_absent_definition_fish() {
  fixture_home="$1"
  mkdir -p "$fixture_home/.config/fish"
  printf '%s\n' \
    '# preserved without cdx before' \
    'set -gx TRELLAGE_FISH_SENTINEL "no cdx definition"' \
    '# preserved without cdx after' >"$fixture_home/.config/fish/config.fish"
  chmod 0640 "$fixture_home/.config/fish/config.fish"
}

assert_install_published() {
  fixture_home="$1"
  installed="$fixture_home/.local/share/trellage/cdx"
  command="$fixture_home/.local/bin/cdx"
  logical_home="$(CDPATH= cd -L -- "$fixture_home" && pwd -L)"
  [ -d "$installed" ] && [ ! -L "$installed" ] || fail 'managed runtime root was not published'
  cmp -s "$installed/.managed-by-trellage-codex-profiles" \
    <(printf 'trellage-codex-profiles-v1\n') || fail 'ownership marker differs'
  cmp -s "$installed/bin/cdx" "$launcher" || fail 'installed launcher bytes differ'
  cmp -s "$installed/catalog.json" "$catalog" || fail 'installed catalog bytes differ'
  cmp -s "$installed/marketplaces/hve-core/.agents/plugins/marketplace.json" \
    "$adapter" || fail 'installed HVE adapter bytes differ'
  [ -L "$command" ] || fail 'managed command is not a symlink'
  [ "$(readlink "$command")" = "$logical_home/.local/share/trellage/cdx/bin/cdx" ] \
    || fail 'managed command target differs'
}

clean_uninstall_home="$fixture_root/clean-uninstall-home"
mkdir -p "$clean_uninstall_home"
write_directory_topology "$clean_uninstall_home" \
  "$fixture_root/clean-uninstall.topology-before"
HOME="$clean_uninstall_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/clean-uninstall.out" \
  || fail 'uninstall rejected a clean HOME'
assert_install_line 'cdx is not installed; Codex profile homes were preserved.' \
  "$fixture_root/clean-uninstall.out"
write_directory_topology "$clean_uninstall_home" \
  "$fixture_root/clean-uninstall.topology-after"
cmp -s "$fixture_root/clean-uninstall.topology-before" \
  "$fixture_root/clean-uninstall.topology-after" \
  || fail 'clean HOME uninstall changed directory topology'

clean_collision_home="$fixture_root/clean-collision-home"
mkdir -p "$clean_collision_home/.local/bin"
printf 'unrelated command\n' >"$clean_collision_home/.local/bin/cdx"
if HOME="$clean_collision_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/clean-collision.out" 2>&1; then
  fail 'uninstall treated an unrelated command collision as not installed'
fi
assert_install_line 'unrelated command' "$clean_collision_home/.local/bin/cdx"

clean_symlink_home="$fixture_root/clean-symlink-home"
mkdir -p "$clean_symlink_home" "$fixture_root/clean-symlink-outside"
ln -s "$fixture_root/clean-symlink-outside" "$clean_symlink_home/.local"
if HOME="$clean_symlink_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/clean-symlink.out" 2>&1; then
  fail 'uninstall treated a symlinked parent collision as not installed'
fi
[ -L "$clean_symlink_home/.local" ] \
  || fail 'uninstall changed a symlinked parent collision'

install_home="$fixture_root/install-home"
mkdir -p "$install_home"
write_legacy_fish "$install_home"
fish_config="$install_home/.config/fish/config.fish"
cp "$fish_config" "$fixture_root/fish-before"
fish_before_hash="$(sha256_file "$fish_config")"
fish_before_mode="$(path_mode "$fish_config")"
HOME="$install_home" /bin/bash "$install_script" >"$fixture_root/install.out" \
  || fail 'fixture install failed'
assert_install_published "$install_home"
HOME="$install_home" "$install_home/.local/bin/cdx" list \
  >"$fixture_root/installed-list.out" 2>"$fixture_root/installed-list.err" \
  || fail "installed cdx list failed: $(cat "$fixture_root/installed-list.err")"
cmp -s "$fixture_root/installed-list.out" <(printf '%s\n' \
  $'hve\thve-core-all@hve-core' \
  $'pstack\tpstack-for-codex@pstack-for-codex-local' \
  $'superpowers\tsuperpowers@superpowers-marketplace') \
  || fail 'installed cdx list output differs'
ln -s cdx "$install_home/.local/bin/cdx-relative"
HOME="$install_home" "$install_home/.local/bin/cdx-relative" list \
  >"$fixture_root/relative-list.out" 2>"$fixture_root/relative-list.err" \
  || fail "relative symlink cdx list failed: $(cat "$fixture_root/relative-list.err")"
cmp -s "$fixture_root/relative-list.out" "$fixture_root/installed-list.out" \
  || fail 'relative symlink cdx list output differs'
rm "$install_home/.local/bin/cdx-relative"
printf '%s\n' \
  '# preserved before' \
  'set -gx TRELLAGE_FISH_SENTINEL "sp ace"' \
  '# preserved after' >"$fixture_root/fish-after-expected"
cmp -s "$fish_config" "$fixture_root/fish-after-expected" \
  || fail 'install changed Fish bytes other than the legacy alias'
[ "$(path_mode "$fish_config")" = "$fish_before_mode" ] || fail 'install changed Fish config mode'
recovery="$install_home/.local/share/trellage/cdx/.fish-recovery"
[ "$(sed -n '1p' "$recovery/original-mode")" = "$fish_before_mode" ] \
  || fail 'Fish recovery did not record original mode'
[ "$(sed -n '1p' "$recovery/sha256-before")" = "$fish_before_hash" ] \
  || fail 'Fish recovery did not record the pre-removal hash'
[ "$(sed -n '1p' "$recovery/sha256-after")" = "$(sha256_file "$fish_config")" ] \
  || fail 'Fish recovery did not record the post-removal hash'
cmp -s "$recovery/removed-line" \
  <(printf 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"\n') \
  || fail 'Fish recovery did not record the exact removed line'
assert_no_install_staging "$install_home"

rm "$install_home/.local/share/trellage/cdx/lib/native-codex"
rmdir "$install_home/.local/share/trellage/cdx/lib"
HOME="$install_home" /bin/bash "$install_script" >"$fixture_root/install-legacy-runtime.out" \
  || fail 'legacy owned runtime upgrade failed'
assert_install_published "$install_home"

mkdir -p "$install_home/.local/share/trellage/profiles/codex/hve/home"
printf 'preserved profile\n' \
  >"$install_home/.local/share/trellage/profiles/codex/hve/home/sentinel"
HOME="$install_home" /bin/bash "$uninstall_script" >"$fixture_root/uninstall.out" \
  || fail 'fixture uninstall failed'
cmp -s "$fish_config" "$fixture_root/fish-before" || fail 'uninstall did not restore exact Fish bytes'
[ "$(path_mode "$fish_config")" = "$fish_before_mode" ] || fail 'uninstall did not restore Fish mode'
[ ! -e "$install_home/.local/share/trellage/cdx" ] || fail 'uninstall left managed runtime'
[ ! -e "$install_home/.local/bin/cdx" ] && [ ! -L "$install_home/.local/bin/cdx" ] \
  || fail 'uninstall left managed command'
assert_install_line 'preserved profile' \
  "$install_home/.local/share/trellage/profiles/codex/hve/home/sentinel"
assert_no_install_staging "$install_home"

absent_definition_home="$fixture_root/absent-definition-home"
mkdir -p "$absent_definition_home"
write_absent_definition_fish "$absent_definition_home"
absent_fish="$absent_definition_home/.config/fish/config.fish"
cp "$absent_fish" "$fixture_root/absent-definition.fish-before"
absent_fish_hash="$(sha256_file "$absent_fish")"
absent_fish_mode="$(path_mode "$absent_fish")"
HOME="$absent_definition_home" /bin/bash "$install_script" \
  >"$fixture_root/absent-definition-install.out" \
  || fail 'absent-definition fixture install failed'
assert_install_published "$absent_definition_home"
cmp -s "$absent_fish" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition install changed Fish bytes'
[ "$(path_mode "$absent_fish")" = "$absent_fish_mode" ] \
  || fail 'absent-definition install changed Fish mode'
absent_recovery="$absent_definition_home/.local/share/trellage/cdx/.fish-recovery"
cmp -s "$absent_recovery/config-before" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition recovery backup differs'
[ "$(sed -n '1p' "$absent_recovery/original-mode")" = "$absent_fish_mode" ] \
  || fail 'absent-definition recovery mode differs'
[ "$(sed -n '1p' "$absent_recovery/sha256-before")" = "$absent_fish_hash" ] \
  || fail 'absent-definition recovery pre-install hash differs'
[ "$(sed -n '1p' "$absent_recovery/sha256-after")" = "$absent_fish_hash" ] \
  || fail 'absent-definition recovery post-install hash differs'
[ ! -s "$absent_recovery/removed-line" ] \
  || fail 'absent-definition recovery recorded a removed Fish line'
assert_no_install_staging "$absent_definition_home"

mkdir "$fixture_root/absent-definition.recovery-before-reinstall"
cp "$absent_recovery/"* "$fixture_root/absent-definition.recovery-before-reinstall/"
HOME="$absent_definition_home" /bin/bash "$install_script" \
  >"$fixture_root/absent-definition-reinstall.out" \
  || fail 'absent-definition fixture reinstall failed'
cmp -s "$absent_fish" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition reinstall changed Fish bytes'
[ "$(path_mode "$absent_fish")" = "$absent_fish_mode" ] \
  || fail 'absent-definition reinstall changed Fish mode'
for name in config-before original-mode sha256-before sha256-after removed-line; do
  cmp -s "$absent_recovery/$name" \
    "$fixture_root/absent-definition.recovery-before-reinstall/$name" \
    || fail "absent-definition reinstall changed recovery $name"
done
assert_install_published "$absent_definition_home"
assert_no_install_staging "$absent_definition_home"

HOME="$absent_definition_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/absent-definition-uninstall.out" \
  || fail 'absent-definition fixture uninstall failed'
cmp -s "$absent_fish" "$fixture_root/absent-definition.fish-before" \
  || fail 'absent-definition uninstall changed Fish bytes'
[ "$(path_mode "$absent_fish")" = "$absent_fish_mode" ] \
  || fail 'absent-definition uninstall changed Fish mode'
[ ! -e "$absent_definition_home/.local/share/trellage/cdx" ] \
  || fail 'absent-definition uninstall left managed runtime'
[ ! -e "$absent_definition_home/.local/bin/cdx" ] \
  && [ ! -L "$absent_definition_home/.local/bin/cdx" ] \
  || fail 'absent-definition uninstall left managed command'
assert_no_install_staging "$absent_definition_home"

absent_origin_home="$fixture_root/absent-origin-owned-reinstall-home"
mkdir -p "$absent_origin_home"
write_absent_definition_fish "$absent_origin_home"
absent_origin_fish="$absent_origin_home/.config/fish/config.fish"
cp "$absent_origin_fish" "$fixture_root/absent-origin.original-fish"
HOME="$absent_origin_home" /bin/bash "$install_script" >/dev/null \
  || fail 'absent-origin fixture install failed'
absent_origin_runtime="$absent_origin_home/.local/share/trellage/cdx"
write_owned_runtime_snapshot "$absent_origin_runtime" \
  "$fixture_root/absent-origin.runtime-before-refused-reinstall"
absent_origin_command_target="$(readlink "$absent_origin_home/.local/bin/cdx")"
printf '%s\n' 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
  >>"$absent_origin_fish"
cp "$absent_origin_fish" "$fixture_root/absent-origin.edited-fish"
if HOME="$absent_origin_home" /bin/bash "$install_script" \
  >"$fixture_root/absent-origin-refused-reinstall.out" 2>&1; then
  fail 'absent-origin owned reinstall accepted a newly added legacy alias'
fi
cmp -s "$absent_origin_fish" "$fixture_root/absent-origin.edited-fish" \
  || fail 'absent-origin refused reinstall changed Fish bytes'
write_owned_runtime_snapshot "$absent_origin_runtime" \
  "$fixture_root/absent-origin.runtime-after-refused-reinstall"
cmp -s "$fixture_root/absent-origin.runtime-before-refused-reinstall" \
  "$fixture_root/absent-origin.runtime-after-refused-reinstall" \
  || fail 'absent-origin refused reinstall changed runtime or recovery state'
[ -L "$absent_origin_home/.local/bin/cdx" ] \
  && [ "$(readlink "$absent_origin_home/.local/bin/cdx")" = \
    "$absent_origin_command_target" ] \
  || fail 'absent-origin refused reinstall changed managed command'
assert_no_install_staging "$absent_origin_home"

cp "$fixture_root/absent-origin.original-fish" "$absent_origin_fish"
chmod 0640 "$absent_origin_fish"
HOME="$absent_origin_home" /bin/bash "$uninstall_script" \
  >"$fixture_root/absent-origin-uninstall.out" \
  || fail 'absent-origin uninstall failed after restoring unchanged Fish state'
cmp -s "$absent_origin_fish" "$fixture_root/absent-origin.original-fish" \
  || fail 'absent-origin uninstall added or restored a Fish definition'
[ ! -e "$absent_origin_home/.local/share/trellage/cdx" ] \
  || fail 'absent-origin uninstall left managed runtime'
[ ! -e "$absent_origin_home/.local/bin/cdx" ] \
  && [ ! -L "$absent_origin_home/.local/bin/cdx" ] \
  || fail 'absent-origin uninstall left managed command'
assert_no_install_staging "$absent_origin_home"

alias_origin_home="$fixture_root/alias-origin-owned-reinstall-home"
mkdir -p "$alias_origin_home"
write_legacy_fish "$alias_origin_home"
cp "$alias_origin_home/.config/fish/config.fish" \
  "$fixture_root/alias-origin.original-fish"
HOME="$alias_origin_home" /bin/bash "$install_script" >/dev/null \
  || fail 'alias-origin fixture install failed'
alias_origin_runtime="$alias_origin_home/.local/share/trellage/cdx"
write_owned_runtime_snapshot "$alias_origin_runtime" \
  "$fixture_root/alias-origin.runtime-before-reinstall"
HOME="$alias_origin_home" /bin/bash "$install_script" >/dev/null \
  || fail 'alias-origin owned reinstall failed'
write_owned_runtime_snapshot "$alias_origin_runtime" \
  "$fixture_root/alias-origin.runtime-after-reinstall"
cmp -s "$fixture_root/alias-origin.runtime-before-reinstall" \
  "$fixture_root/alias-origin.runtime-after-reinstall" \
  || fail 'alias-origin owned reinstall changed runtime or recovery state'
HOME="$alias_origin_home" /bin/bash "$uninstall_script" >/dev/null \
  || fail 'alias-origin uninstall failed after owned reinstall'
cmp -s "$alias_origin_home/.config/fish/config.fish" \
  "$fixture_root/alias-origin.original-fish" \
  || fail 'alias-origin owned reinstall lost legacy alias recovery metadata'
assert_no_install_staging "$alias_origin_home"

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  absent_failure_home="$fixture_root/absent-definition-failure-$failure_point"
  mkdir -p "$absent_failure_home"
  write_absent_definition_fish "$absent_failure_home"
  cp "$absent_failure_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-$failure_point.fish-before"
  absent_failure_mode="$(path_mode "$absent_failure_home/.config/fish/config.fish")"
  write_directory_topology "$absent_failure_home" \
    "$fixture_root/absent-definition-$failure_point.topology-before"
  if HOME="$absent_failure_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" \
    >"$fixture_root/absent-definition-$failure_point.out" 2>&1; then
    fail "absent-definition injected install failure unexpectedly succeeded: $failure_point"
  fi
  assert_install_text "injected failure at $failure_point" \
    "$fixture_root/absent-definition-$failure_point.out"
  cmp -s "$absent_failure_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-$failure_point.fish-before" \
    || fail "absent-definition install rollback changed Fish bytes: $failure_point"
  [ "$(path_mode "$absent_failure_home/.config/fish/config.fish")" = \
    "$absent_failure_mode" ] \
    || fail "absent-definition install rollback changed Fish mode: $failure_point"
  [ ! -e "$absent_failure_home/.local/share/trellage/cdx" ] \
    || fail "absent-definition install rollback left runtime: $failure_point"
  [ ! -e "$absent_failure_home/.local/bin/cdx" ] \
    && [ ! -L "$absent_failure_home/.local/bin/cdx" ] \
    || fail "absent-definition install rollback left command: $failure_point"
  assert_no_install_staging "$absent_failure_home"
  write_directory_topology "$absent_failure_home" \
    "$fixture_root/absent-definition-$failure_point.topology-after"
  cmp -s "$fixture_root/absent-definition-$failure_point.topology-before" \
    "$fixture_root/absent-definition-$failure_point.topology-after" \
    || fail "absent-definition install rollback changed topology: $failure_point"
done

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  absent_reinstall_home="$fixture_root/absent-definition-reinstall-$failure_point"
  mkdir -p "$absent_reinstall_home"
  write_absent_definition_fish "$absent_reinstall_home"
  HOME="$absent_reinstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "absent-definition reinstall rollback fixture install failed: $failure_point"
  cp "$absent_reinstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-reinstall-$failure_point.fish-before"
  mkdir "$fixture_root/absent-definition-reinstall-$failure_point.recovery"
  cp "$absent_reinstall_home/.local/share/trellage/cdx/.fish-recovery/"* \
    "$fixture_root/absent-definition-reinstall-$failure_point.recovery/"
  if HOME="$absent_reinstall_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" \
    >"$fixture_root/absent-definition-reinstall-$failure_point.out" 2>&1; then
    fail "absent-definition injected reinstall failure unexpectedly succeeded: $failure_point"
  fi
  assert_install_text "injected failure at $failure_point" \
    "$fixture_root/absent-definition-reinstall-$failure_point.out"
  cmp -s "$absent_reinstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-reinstall-$failure_point.fish-before" \
    || fail "absent-definition reinstall rollback changed Fish bytes: $failure_point"
  for name in config-before original-mode sha256-before sha256-after removed-line; do
    cmp -s "$absent_reinstall_home/.local/share/trellage/cdx/.fish-recovery/$name" \
      "$fixture_root/absent-definition-reinstall-$failure_point.recovery/$name" \
      || fail "absent-definition reinstall rollback changed recovery $name: $failure_point"
  done
  assert_install_published "$absent_reinstall_home"
  assert_no_install_staging "$absent_reinstall_home"
done

for failure_point in \
  during-fish-publication \
  after-fish-publication \
  after-command-removal \
  after-runtime-removal; do
  absent_uninstall_home="$fixture_root/absent-definition-uninstall-$failure_point"
  mkdir -p "$absent_uninstall_home"
  write_absent_definition_fish "$absent_uninstall_home"
  HOME="$absent_uninstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "absent-definition uninstall rollback fixture install failed: $failure_point"
  cp "$absent_uninstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-uninstall-$failure_point.fish-before"
  absent_uninstall_mode="$(path_mode "$absent_uninstall_home/.config/fish/config.fish")"
  if HOME="$absent_uninstall_home" CDX_UNINSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$uninstall_script" \
    >"$fixture_root/absent-definition-uninstall-$failure_point.out" 2>&1; then
    fail "absent-definition injected uninstall failure unexpectedly succeeded: $failure_point"
  fi
  assert_install_text "injected failure at $failure_point" \
    "$fixture_root/absent-definition-uninstall-$failure_point.out"
  cmp -s "$absent_uninstall_home/.config/fish/config.fish" \
    "$fixture_root/absent-definition-uninstall-$failure_point.fish-before" \
    || fail "absent-definition uninstall rollback changed Fish bytes: $failure_point"
  [ "$(path_mode "$absent_uninstall_home/.config/fish/config.fish")" = \
    "$absent_uninstall_mode" ] \
    || fail "absent-definition uninstall rollback changed Fish mode: $failure_point"
  assert_install_published "$absent_uninstall_home"
  assert_no_install_staging "$absent_uninstall_home"
done

for conflict_kind in \
  alias \
  function \
  hash-in-token \
  continued-alias \
  and-alias \
  or-alias \
  not-alias \
  repeated-prefix-alias \
  andand-alias \
  oror-alias \
  time-alias \
  and-function \
  repeated-prefix-function \
  escaped-alias \
  escaped-hex-alias \
  escaped-function \
  escaped-hex-function; do
  conflict_home="$fixture_root/conflict-$conflict_kind"
  mkdir -p "$conflict_home/.config/fish"
  case "$conflict_kind" in
    alias) printf '%s\n' 'alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    function) printf '%s\n' 'function cdx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    hash-in-token) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'echo foo#bar; alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    continued-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'alias \' \
      'cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    and-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true; and alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    or-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'false; or alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    not-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'not alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    repeated-prefix-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true; and not not alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    andand-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true && alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    oror-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'false || alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    time-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'time alias cdx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    and-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'true; and function cdx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    repeated-prefix-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'false; or not not function cdx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'alias c\dx="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-hex-alias) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'alias c\x64x="codex --ask-for-approval"' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'function c\dx; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
    escaped-hex-function) printf '%s\n' \
      'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
      'function c\x64x; codex $argv; end' \
      >"$conflict_home/.config/fish/config.fish" ;;
  esac
  cp "$conflict_home/.config/fish/config.fish" "$fixture_root/conflict-$conflict_kind.before"
  if HOME="$conflict_home" /bin/bash "$install_script" \
    >"$fixture_root/conflict-$conflict_kind.out" 2>&1; then
    fail "install accepted a different cdx $conflict_kind"
  fi
  cmp -s "$conflict_home/.config/fish/config.fish" \
    "$fixture_root/conflict-$conflict_kind.before" || fail "rejected $conflict_kind was changed"
  [ ! -e "$conflict_home/.local/share/trellage/cdx" ] \
    || fail "rejected $conflict_kind published runtime"
  assert_no_install_staging "$conflict_home"
done

incompatible_fish_home="$fixture_root/incompatible-fish-home"
incompatible_fish_bin="$fixture_root/incompatible-fish-bin"
mkdir -p "$incompatible_fish_home" "$incompatible_fish_bin"
write_legacy_fish "$incompatible_fish_home"
cat >"$incompatible_fish_bin/fish_indent" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '<not-fish-indent-html>'
EOF
chmod +x "$incompatible_fish_bin/fish_indent"
if PATH="$incompatible_fish_bin:$PATH" HOME="$incompatible_fish_home" \
  /bin/bash "$install_script" >"$fixture_root/incompatible-fish.out" 2>&1; then
  fail 'install accepted incompatible fish_indent semantic output'
fi
cmp -s "$incompatible_fish_home/.config/fish/config.fish" \
  "$fixture_root/fish-before" \
  || fail 'incompatible fish_indent changed Fish config'
assert_no_install_staging "$incompatible_fish_home"

analysis_signal_home="$fixture_root/analysis-signal-home"
analysis_signal_bin="$fixture_root/analysis-signal-bin"
analysis_signal_tmp="$fixture_root/analysis-signal-tmp"
mkdir -p "$analysis_signal_home" "$analysis_signal_bin" "$analysis_signal_tmp"
write_legacy_fish "$analysis_signal_home"
cat >"$analysis_signal_bin/fish_indent" <<'EOF'
#!/usr/bin/env bash
kill -HUP "$PPID"
exit 129
EOF
chmod +x "$analysis_signal_bin/fish_indent"
if TMPDIR="$analysis_signal_tmp" PATH="$analysis_signal_bin:$PATH" \
  HOME="$analysis_signal_home" \
  /bin/bash "$install_script" >"$fixture_root/analysis-signal.out" 2>&1; then
  fail 'analysis-signal install unexpectedly succeeded'
fi
if find "$analysis_signal_tmp" -mindepth 1 -print -quit | grep -q .; then
  fail 'Fish analysis signal left temporary state'
fi
cmp -s "$analysis_signal_home/.config/fish/config.fish" \
  "$fixture_root/fish-before" \
  || fail 'Fish analysis signal changed Fish config'
assert_no_install_staging "$analysis_signal_home"

for conflict_kind in alias-save alias-short-save alias-wraps function-description function-wraps; do
  conflict_home="$fixture_root/option-conflict-$conflict_kind"
  mkdir -p "$conflict_home/.config/fish"
  {
    printf '%s\n' 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"'
    case "$conflict_kind" in
      alias-save) printf '%s\n' 'alias --save cdx="codex --ask-for-approval"' ;;
      alias-short-save) printf '%s\n' 'alias -s cdx="codex --ask-for-approval"' ;;
      alias-wraps) printf '%s\n' 'alias --wraps codex cdx="codex --ask-for-approval"' ;;
      function-description) printf '%s\n' 'function cdx --description custom; codex $argv; end' ;;
      function-wraps) printf '%s\n' 'function cdx --wraps codex; codex $argv; end' ;;
    esac
  } >"$conflict_home/.config/fish/config.fish"
  cp "$conflict_home/.config/fish/config.fish" \
    "$fixture_root/option-conflict-$conflict_kind.before"
  write_directory_topology "$conflict_home" \
    "$fixture_root/option-conflict-$conflict_kind.topology"
  if HOME="$conflict_home" /bin/bash "$install_script" \
    >"$fixture_root/option-conflict-$conflict_kind.out" 2>&1; then
    fail "install accepted option-bearing cdx definition: $conflict_kind"
  fi
  cmp -s "$conflict_home/.config/fish/config.fish" \
    "$fixture_root/option-conflict-$conflict_kind.before" \
    || fail "rejected option-bearing definition changed Fish: $conflict_kind"
  write_directory_topology "$conflict_home" \
    "$fixture_root/option-conflict-$conflict_kind.after-topology"
  cmp -s "$fixture_root/option-conflict-$conflict_kind.topology" \
    "$fixture_root/option-conflict-$conflict_kind.after-topology" \
    || fail "rejected option-bearing definition changed topology: $conflict_kind"
done

non_definition_home="$fixture_root/non-definition-cdx-text"
mkdir -p "$non_definition_home/.config/fish"
printf '%s\n' \
  '# alias --save cdx="not a definition"' \
  'set -g cdx_note '\''alias --save cdx="not a definition"'\''' \
  'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
  >"$non_definition_home/.config/fish/config.fish"
HOME="$non_definition_home" /bin/bash "$install_script" >/dev/null \
  || fail 'install treated comment or quoted cdx text as a definition'
assert_install_published "$non_definition_home"

non_cdx_definition_home="$fixture_root/non-cdx-definitions"
mkdir -p "$non_cdx_definition_home/.config/fish"
printf '%s\n' \
  'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
  'alias foo cdx' \
  'alias --wraps cdx foo="codex --ask-for-approval"' \
  'alias --wraps=cdx bar="codex --ask-for-approval"' \
  'alias --help cdx' \
  'alias -h cdx' \
  'alias -sh cdx' \
  'alias -hs cdx' \
  'function --help cdx' \
  'function -h cdx' \
  'function foo --description cdx; echo harmless; end' \
  'function bar --description=cdx; echo harmless; end' \
  'function baz --wraps cdx; echo harmless; end' \
  'alias escaped-body="echo c\dx"' \
  'function escaped-body; echo c\dx; end' \
  'echo and alias cdx="not a command"' \
  'not echo alias cdx="not a command"' \
  'true; and echo alias cdx="not a command"' \
  'echo harmless\; alias cdx="not a command"' \
  'echo '\''harmless; alias cdx="not a command"'\''' \
  >"$non_cdx_definition_home/.config/fish/config.fish"
HOME="$non_cdx_definition_home" /bin/bash "$install_script" >/dev/null \
  || fail 'install treated an option value or alias body as the cdx definition name'
assert_install_published "$non_cdx_definition_home"

for separator_kind in alias function alias-after-double-dash; do
  separator_home="$fixture_root/separator-conflict-$separator_kind"
  mkdir -p "$separator_home/.config/fish"
  case "$separator_kind" in
    alias)
      printf '%s\n' \
        'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
        'echo harmless; alias --save cdx="codex --ask-for-approval"' \
        >"$separator_home/.config/fish/config.fish"
      ;;
    function)
      printf '%s\n' \
        'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
        'echo harmless; function cdx --wraps codex; codex $argv; end' \
        >"$separator_home/.config/fish/config.fish"
      ;;
    alias-after-double-dash)
      printf '%s\n' \
        'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"' \
        'echo harmless; alias --save -- cdx="codex --ask-for-approval"' \
        >"$separator_home/.config/fish/config.fish"
      ;;
  esac
  cp "$separator_home/.config/fish/config.fish" \
    "$fixture_root/separator-conflict-$separator_kind.before"
  if HOME="$separator_home" /bin/bash "$install_script" \
    >"$fixture_root/separator-conflict-$separator_kind.out" 2>&1; then
    fail "install accepted cdx definition after command separator: $separator_kind"
  fi
  cmp -s "$separator_home/.config/fish/config.fish" \
    "$fixture_root/separator-conflict-$separator_kind.before" \
    || fail "separator conflict changed Fish bytes: $separator_kind"
done

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  failure_home="$fixture_root/failure-$failure_point"
  mkdir -p "$failure_home"
  write_legacy_fish "$failure_home"
  write_directory_topology "$failure_home" "$fixture_root/$failure_point.topology-before"
  cp "$failure_home/.config/fish/config.fish" "$fixture_root/$failure_point.fish-before"
  failure_mode="$(path_mode "$failure_home/.config/fish/config.fish")"
  if HOME="$failure_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" >"$fixture_root/$failure_point.out" 2>&1; then
    fail "injected install failure unexpectedly succeeded: $failure_point"
  fi
  cmp -s "$failure_home/.config/fish/config.fish" "$fixture_root/$failure_point.fish-before" \
    || fail "Fish bytes changed after injected failure: $failure_point"
  [ "$(path_mode "$failure_home/.config/fish/config.fish")" = "$failure_mode" ] \
    || fail "Fish mode changed after injected failure: $failure_point"
  [ ! -e "$failure_home/.local/share/trellage/cdx" ] \
    || fail "runtime remained after injected failure: $failure_point"
  [ ! -e "$failure_home/.local/bin/cdx" ] && [ ! -L "$failure_home/.local/bin/cdx" ] \
    || fail "command remained after injected failure: $failure_point"
  assert_no_install_staging "$failure_home"
  write_directory_topology "$failure_home" "$fixture_root/$failure_point.topology-after"
  cmp -s "$fixture_root/$failure_point.topology-before" \
    "$fixture_root/$failure_point.topology-after" \
    || fail "directory topology changed after injected failure: $failure_point"
done

preexisting_parent_home="$fixture_root/preexisting-parent-home"
write_legacy_fish "$preexisting_parent_home"
mkdir -p "$preexisting_parent_home/.local/bin" \
  "$preexisting_parent_home/.local/share/trellage"
printf 'keep bin\n' >"$preexisting_parent_home/.local/bin/keep"
printf 'keep runtime parent\n' >"$preexisting_parent_home/.local/share/trellage/keep"
write_directory_topology "$preexisting_parent_home" \
  "$fixture_root/preexisting-parent.topology-before"
if HOME="$preexisting_parent_home" CDX_INSTALL_TEST_FAIL_AT=after-fish-staging \
  /bin/bash "$install_script" >"$fixture_root/preexisting-parent.out" 2>&1; then
  fail 'pre-existing parent failure injection unexpectedly succeeded'
fi
write_directory_topology "$preexisting_parent_home" \
  "$fixture_root/preexisting-parent.topology-after"
cmp -s "$fixture_root/preexisting-parent.topology-before" \
  "$fixture_root/preexisting-parent.topology-after" \
  || fail 'failed install changed pre-existing parent topology'
assert_install_line 'keep bin' "$preexisting_parent_home/.local/bin/keep"
assert_install_line 'keep runtime parent' \
  "$preexisting_parent_home/.local/share/trellage/keep"

for failure_point in \
  after-runtime-staging \
  after-fish-staging \
  during-fish-publication \
  after-fish-publication \
  after-runtime-publication \
  after-command-publication; do
  reinstall_home="$fixture_root/reinstall-$failure_point"
  mkdir -p "$reinstall_home"
  write_legacy_fish "$reinstall_home"
  HOME="$reinstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "reinstall rollback fixture install failed: $failure_point"
  write_directory_topology "$reinstall_home" \
    "$fixture_root/reinstall-$failure_point.topology-before"
  cp "$reinstall_home/.config/fish/config.fish" \
    "$fixture_root/reinstall-$failure_point.fish-before"
  mkdir "$fixture_root/reinstall-$failure_point.recovery"
  cp "$reinstall_home/.local/share/trellage/cdx/.fish-recovery/"* \
    "$fixture_root/reinstall-$failure_point.recovery/"
  if HOME="$reinstall_home" CDX_INSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$install_script" >"$fixture_root/reinstall-$failure_point.out" 2>&1; then
    fail "injected reinstall failure unexpectedly succeeded: $failure_point"
  fi
  cmp -s "$reinstall_home/.config/fish/config.fish" \
    "$fixture_root/reinstall-$failure_point.fish-before" \
    || fail "reinstall rollback changed Fish bytes: $failure_point"
  for name in config-before original-mode sha256-before sha256-after removed-line; do
    cmp -s "$reinstall_home/.local/share/trellage/cdx/.fish-recovery/$name" \
      "$fixture_root/reinstall-$failure_point.recovery/$name" \
      || fail "reinstall rollback changed recovery $name: $failure_point"
  done
  assert_install_published "$reinstall_home"
  assert_no_install_staging "$reinstall_home"
  write_directory_topology "$reinstall_home" \
    "$fixture_root/reinstall-$failure_point.topology-after"
  cmp -s "$fixture_root/reinstall-$failure_point.topology-before" \
    "$fixture_root/reinstall-$failure_point.topology-after" \
    || fail "reinstall rollback changed directory topology: $failure_point"
done

signal_mv_bin="$fixture_root/signal-mv-bin"
mkdir "$signal_mv_bin"
real_mv="$(command -v mv)" || fail 'could not resolve real mv for signal rollback tests'
cat >"$signal_mv_bin/mv" <<'EOF'
#!/usr/bin/env bash
set -u

source_path="$1"
destination_path="$2"
"$CDX_TEST_REAL_MV" "$@" || exit $?

case "$CDX_TEST_SIGNAL_MV:$source_path:$destination_path" in
  install-fish-old:*/.config/fish/config.fish:*/.config/fish/.cdx-fish.*|\
  install-fish-new:*/.config/fish/.cdx-fish.*:*/.config/fish/config.fish|\
  install-runtime-old:*/.local/share/trellage/cdx:*/.cdx-install.*/old-runtime|\
  install-runtime-new:*/.cdx-install.*/new-runtime:*/.local/share/trellage/cdx|\
  install-command-old:*/.local/bin/cdx:*/.cdx-command.*/old-command|\
  install-command-new:*/.cdx-command.*/new-command:*/.local/bin/cdx|\
  uninstall-fish-old:*/.config/fish/config.fish:*/.config/fish/.cdx-uninstall-fish.*|\
  uninstall-fish-new:*/.config/fish/.cdx-uninstall-fish.*:*/.config/fish/config.fish|\
  uninstall-command:*/.local/bin/cdx:*/.cdx-uninstall-command.*/command|\
  uninstall-runtime:*/.local/share/trellage/cdx:*/.cdx-uninstall.*/runtime)
    if [ ! -e "$CDX_TEST_SIGNAL_ONCE" ]; then
      : >"$CDX_TEST_SIGNAL_ONCE"
      kill -s "$CDX_TEST_SIGNAL_NAME" "$PPID"
    fi
    ;;
esac
EOF
chmod +x "$signal_mv_bin/mv"

for signal_name in TERM INT HUP; do
for signal_boundary in \
  install-fish-old \
  install-fish-new \
  install-runtime-old \
  install-runtime-new \
  install-command-old \
  install-command-new; do
  signal_home="$fixture_root/signal-$signal_name-$signal_boundary"
  mkdir -p "$signal_home"
  write_legacy_fish "$signal_home"
  case "$signal_boundary" in
    install-runtime-old|install-command-old)
      HOME="$signal_home" /bin/bash "$install_script" >/dev/null \
        || fail "could not prepare reinstall signal fixture: $signal_boundary"
      ;;
  esac
  cp "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-before"
  if PATH="$signal_mv_bin:$PATH" CDX_TEST_REAL_MV="$real_mv" \
    CDX_TEST_SIGNAL_MV="$signal_boundary" \
    CDX_TEST_SIGNAL_NAME="$signal_name" \
    CDX_TEST_SIGNAL_ONCE="$fixture_root/$signal_name-$signal_boundary.signaled" \
    HOME="$signal_home" \
    /bin/bash "$install_script" >"$fixture_root/$signal_boundary.out" 2>&1; then
    fail "signal-boundary install unexpectedly succeeded: $signal_boundary"
  else
    signal_status=$?
  fi
  case "$signal_name:$signal_status" in
    HUP:129|INT:130|TERM:143) ;;
    *) fail "signal-boundary install exit differed: $signal_name/$signal_status" ;;
  esac
  cmp -s "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before" \
    || fail "signal-boundary install lost Fish config: $signal_boundary"
  case "$signal_boundary" in
    install-runtime-old|install-command-old)
      assert_install_published "$signal_home"
      ;;
    *)
      [ ! -e "$signal_home/.local/share/trellage/cdx" ] \
        || fail "signal-boundary install left runtime: $signal_boundary"
      [ ! -e "$signal_home/.local/bin/cdx" ] && [ ! -L "$signal_home/.local/bin/cdx" ] \
        || fail "signal-boundary install left command: $signal_boundary"
      ;;
  esac
  assert_no_install_staging "$signal_home"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-after"
  cmp -s "$fixture_root/$signal_boundary.topology-before" \
    "$fixture_root/$signal_boundary.topology-after" \
    || fail "signal-boundary install changed topology: $signal_boundary"
done

for signal_boundary in \
  uninstall-fish-old \
  uninstall-fish-new \
  uninstall-command \
  uninstall-runtime; do
  signal_home="$fixture_root/signal-$signal_name-$signal_boundary"
  mkdir -p "$signal_home"
  write_legacy_fish "$signal_home"
  HOME="$signal_home" /bin/bash "$install_script" >/dev/null \
    || fail "could not prepare uninstall signal fixture: $signal_boundary"
  cp "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-before"
  if PATH="$signal_mv_bin:$PATH" CDX_TEST_REAL_MV="$real_mv" \
    CDX_TEST_SIGNAL_MV="$signal_boundary" \
    CDX_TEST_SIGNAL_NAME="$signal_name" \
    CDX_TEST_SIGNAL_ONCE="$fixture_root/$signal_name-$signal_boundary.signaled" \
    HOME="$signal_home" \
    /bin/bash "$uninstall_script" >"$fixture_root/$signal_boundary.out" 2>&1; then
    fail "signal-boundary uninstall unexpectedly succeeded: $signal_boundary"
  else
    signal_status=$?
  fi
  case "$signal_name:$signal_status" in
    HUP:129|INT:130|TERM:143) ;;
    *) fail "signal-boundary uninstall exit differed: $signal_name/$signal_status" ;;
  esac
  cmp -s "$signal_home/.config/fish/config.fish" \
    "$fixture_root/$signal_boundary.fish-before" \
    || fail "signal-boundary uninstall lost Fish config: $signal_boundary"
  assert_install_published "$signal_home"
  assert_no_install_staging "$signal_home"
  write_directory_topology "$signal_home" \
    "$fixture_root/$signal_boundary.topology-after"
  cmp -s "$fixture_root/$signal_boundary.topology-before" \
    "$fixture_root/$signal_boundary.topology-after" \
    || fail "signal-boundary uninstall changed topology: $signal_boundary"
done
done

edited_home="$fixture_root/edited-home"
mkdir -p "$edited_home"
write_legacy_fish "$edited_home"
HOME="$edited_home" /bin/bash "$install_script" >/dev/null || fail 'edited fixture install failed'
printf '# user edit\n' >>"$edited_home/.config/fish/config.fish"
cp "$edited_home/.config/fish/config.fish" "$fixture_root/edited-fish-before"
mkdir "$fixture_root/edited-recovery-before-reinstall"
cp "$edited_home/.local/share/trellage/cdx/.fish-recovery/"* \
  "$fixture_root/edited-recovery-before-reinstall/"
HOME="$edited_home" /bin/bash "$install_script" \
  >"$fixture_root/edited-reinstall.out" \
  || fail 'reinstall rejected an unrelated Fish config edit'
cmp -s "$edited_home/.config/fish/config.fish" "$fixture_root/edited-fish-before" \
  || fail 'reinstall changed unrelated Fish config edits'
for name in config-before original-mode sha256-before sha256-after removed-line; do
  cmp -s "$edited_home/.local/share/trellage/cdx/.fish-recovery/$name" \
    "$fixture_root/edited-recovery-before-reinstall/$name" \
    || fail "reinstall changed Fish recovery metadata after unrelated edit: $name"
done
if HOME="$edited_home" /bin/bash "$uninstall_script" >"$fixture_root/edited-uninstall.out" 2>&1; then
  fail 'uninstall overwrote Fish config after a user edit'
fi
cmp -s "$edited_home/.config/fish/config.fish" "$fixture_root/edited-fish-before" \
  || fail 'refused uninstall changed edited Fish config'
assert_install_published "$edited_home"

for failure_point in \
  during-fish-publication \
  after-fish-publication \
  after-command-removal \
  after-runtime-removal; do
  uninstall_home="$fixture_root/uninstall-failure-$failure_point"
  mkdir -p "$uninstall_home"
  write_legacy_fish "$uninstall_home"
  cp "$uninstall_home/.config/fish/config.fish" \
    "$fixture_root/uninstall-$failure_point.original"
  HOME="$uninstall_home" /bin/bash "$install_script" >/dev/null \
    || fail "uninstall rollback fixture install failed: $failure_point"
  cp "$uninstall_home/.config/fish/config.fish" \
    "$fixture_root/uninstall-$failure_point.post-install"
  post_mode="$(path_mode "$uninstall_home/.config/fish/config.fish")"
  if HOME="$uninstall_home" CDX_UNINSTALL_TEST_FAIL_AT="$failure_point" \
    /bin/bash "$uninstall_script" >"$fixture_root/uninstall-$failure_point.out" 2>&1; then
    fail "injected uninstall failure unexpectedly succeeded: $failure_point"
  fi
  cmp -s "$uninstall_home/.config/fish/config.fish" \
    "$fixture_root/uninstall-$failure_point.post-install" \
    || fail "uninstall rollback changed Fish bytes: $failure_point"
  [ "$(path_mode "$uninstall_home/.config/fish/config.fish")" = "$post_mode" ] \
    || fail "uninstall rollback changed Fish mode: $failure_point"
  assert_install_published "$uninstall_home"
  assert_no_install_staging "$uninstall_home"
done

unrelated_command_home="$fixture_root/unrelated-command-home"
mkdir -p "$unrelated_command_home/.local/bin"
write_legacy_fish "$unrelated_command_home"
printf 'unrelated command\n' >"$unrelated_command_home/.local/bin/cdx"
if HOME="$unrelated_command_home" /bin/bash "$install_script" \
  >"$fixture_root/unrelated-command.out" 2>&1; then
  fail 'install replaced an unrelated cdx command'
fi
assert_install_line 'unrelated command' "$unrelated_command_home/.local/bin/cdx"

symlink_runtime_home="$fixture_root/symlink-runtime-home"
mkdir -p "$symlink_runtime_home/.local/share/trellage" "$symlink_runtime_home/outside"
write_legacy_fish "$symlink_runtime_home"
ln -s "$symlink_runtime_home/outside" \
  "$symlink_runtime_home/.local/share/trellage/cdx"
if HOME="$symlink_runtime_home" /bin/bash "$install_script" \
  >"$fixture_root/symlink-runtime.out" 2>&1; then
  fail 'install followed a symlinked runtime root'
fi
[ -L "$symlink_runtime_home/.local/share/trellage/cdx" ] \
  || fail 'rejected symlinked runtime was changed'

printf 'trellage Codex installation contract: PASS\n'
