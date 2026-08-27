#!/usr/bin/env bash
set -euo pipefail

refuse() {
  printf 'cdx uninstall: %s\n' "$1" >&2
  exit 1
}

home="${HOME-}"
[ -n "$home" ] || refuse 'refusing unsafe HOME: HOME is empty'
case "$home" in /*) ;; *) refuse "refusing unsafe HOME: HOME is not absolute: $home" ;; esac
[ -d "$home" ] && [ ! -L "$home" ] || refuse "refusing unsafe HOME: HOME is not a real directory: $home"
home="$(cd -L "$home" >/dev/null 2>&1 && pwd -L)" || refuse "refusing unsafe HOME: HOME is not a real directory: $home"
[ "$home" != / ] || refuse 'refusing unsafe HOME: HOME resolves to /'

runtime_parent="$home/.local/share/trellage"
install_root="$runtime_parent/cdx"
installed_launcher="$install_root/bin/cdx"
marker="$install_root/.managed-by-trellage-codex-profiles"
marker_value='trellage-codex-profiles-v1'
command_dir="$home/.local/bin"
command_path="$command_dir/cdx"
fish_dir="$home/.config/fish"
fish_config="$fish_dir/config.fish"
recovery="$install_root/.fish-recovery"
local_dir="$home/.local"
share_dir="$local_dir/share"
config_dir="$home/.config"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}' || return
  else sha256sum "$1" | awk '{print $1}' || return; fi
}

for path in "$local_dir" "$share_dir" "$runtime_parent" "$command_dir" "$config_dir" "$fish_dir"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -d "$path" ] && [ ! -L "$path" ] || refuse "refusing unsafe managed path: $path"
  fi
done
if [ ! -e "$install_root" ] && [ ! -L "$install_root" ]; then
  [ ! -e "$command_path" ] && [ ! -L "$command_path" ] \
    || refuse "refusing unrelated command without managed runtime: $command_path"
  printf 'cdx is not installed; Codex profile homes were preserved.\n'
  exit 0
fi
for path in "$local_dir" "$share_dir" "$runtime_parent" "$command_dir" "$config_dir" "$fish_dir"; do
  [ -d "$path" ] && [ ! -L "$path" ] || refuse "refusing unsafe managed path: $path"
done
[ -d "$install_root" ] && [ ! -L "$install_root" ] || refuse "refusing unowned runtime root: $install_root"
[ -f "$marker" ] && [ ! -L "$marker" ] && cmp -s "$marker" <(printf '%s\n' "$marker_value") \
  || refuse "refusing unowned runtime root: $install_root"
actual_entries="$(CDPATH= cd -- "$install_root" && find . -print | LC_ALL=C sort)"
expected_entries="$(printf '%s\n' \
  '.' \
  './.fish-recovery' \
  './.fish-recovery/config-before' \
  './.fish-recovery/original-mode' \
  './.fish-recovery/removed-line' \
  './.fish-recovery/sha256-after' \
  './.fish-recovery/sha256-before' \
  './.managed-by-trellage-codex-profiles' \
  './bin' \
  './bin/cdx' \
  './catalog.json' \
  './lib' \
  './lib/native-codex')"
[ "$actual_entries" = "$expected_entries" ] \
  || refuse "refusing unexpected content in owned runtime: $install_root"
[ -z "$(find "$install_root" -type l -print -quit)" ] \
  || refuse "refusing symlinked content in owned runtime: $install_root"
[ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$installed_launcher" ] \
  || refuse "refusing to remove unrelated command: $command_path"
[ -f "$fish_config" ] && [ ! -L "$fish_config" ] && [ -w "$fish_config" ] \
  || refuse "Fish config must be a writable regular non-symlink file: $fish_config"
for name in config-before original-mode sha256-before sha256-after removed-line; do
  [ -f "$recovery/$name" ] && [ ! -L "$recovery/$name" ] && [ -r "$recovery/$name" ] \
    || refuse "missing or unsafe Fish recovery data: $recovery/$name"
done
for path in "$installed_launcher" "$install_root/lib/native-codex" \
  "$install_root/catalog.json"; do
  [ -f "$path" ] && [ ! -L "$path" ] || refuse "unsafe managed runtime file: $path"
done
expected_after="$(sed -n '1p' "$recovery/sha256-after")"
[ "$(wc -l <"$recovery/original-mode" | tr -d ' ')" -eq 1 ] \
  || refuse 'invalid Fish recovery mode'
original_mode="$(sed -n '1p' "$recovery/original-mode")"
case "$original_mode" in [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;; *) refuse 'invalid Fish recovery mode' ;; esac
for name in sha256-before sha256-after; do
  value="$(sed -n '1p' "$recovery/$name")"
  [ "$(wc -l <"$recovery/$name" | tr -d ' ')" -eq 1 ] \
    || refuse "invalid Fish recovery hash: $name"
  case "$value" in *[!0-9a-f]*|'') refuse "invalid Fish recovery hash: $name" ;; esac
  [ "${#value}" -eq 64 ] || refuse "invalid Fish recovery hash: $name"
done
removed_legacy_alias=false
if [ -s "$recovery/removed-line" ]; then
  cmp -s "$recovery/removed-line" \
    <(printf 'alias cdx="codex --dangerously-bypass-approvals-and-sandbox"\n') \
    || refuse 'invalid Fish recovery alias'
  removed_legacy_alias=true
fi
[ "$(sha256_file "$fish_config")" = "$expected_after" ] \
  || refuse 'Fish config changed after installation; runtime and recovery data were preserved'
[ "$(sha256_file "$recovery/config-before")" = "$(sed -n '1p' "$recovery/sha256-before")" ] \
  || refuse 'Fish recovery backup hash differs'

staging_root=''
command_staging=''
fish_new=''
fish_old=''
fish_staged_hash=''
active=false
fish_original_intent=false
fish_publish_intent=false
command_remove_intent=false
runtime_remove_intent=false

cleanup() {
  [ -z "$fish_new" ] || rm -f -- "$fish_new"
  [ -z "$fish_old" ] || rm -f -- "$fish_old"
  if [ -n "$command_staging" ] && [ -d "$command_staging" ]; then
    rm -f -- "$command_staging/command"
    rmdir "$command_staging" 2>/dev/null || :
  fi
  if [ -n "$staging_root" ] && [ -d "$staging_root" ]; then
    case "$staging_root" in "$runtime_parent"/.cdx-uninstall.*) rm -rf -- "$staging_root" ;; esac
  fi
}

rollback() {
  local ok=true
  if [ "$runtime_remove_intent" = true ] && [ -d "$staging_root/runtime" ]; then
    [ ! -e "$install_root" ] && [ ! -L "$install_root" ] \
      && mv "$staging_root/runtime" "$install_root" || ok=false
  fi
  if [ "$command_remove_intent" = true ] && [ -L "$command_staging/command" ]; then
    [ ! -e "$command_path" ] && [ ! -L "$command_path" ] \
      && mv "$command_staging/command" "$command_path" || ok=false
  fi
  if [ "$fish_original_intent" = true ] && [ -n "$fish_old" ] && [ -f "$fish_old" ]; then
    if [ -e "$fish_config" ] || [ -L "$fish_config" ]; then
      if [ "$fish_publish_intent" = true ] \
        && [ -f "$fish_config" ] && [ ! -L "$fish_config" ] \
        && [ "$(sha256_file "$fish_config")" = "$fish_staged_hash" ]; then
        rm -f -- "$fish_config" || ok=false
      else
        ok=false
      fi
    fi
    if [ ! -e "$fish_config" ] && [ ! -L "$fish_config" ]; then
      mv "$fish_old" "$fish_config" || ok=false
      [ -e "$fish_old" ] || fish_old=''
    else
      ok=false
    fi
  fi
  [ "$ok" = true ]
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$active" = true ]; then
    if rollback; then
      cleanup
    else
      printf 'cdx uninstall: rollback failed; recovery may be required\n' >&2
    fi
  else
    cleanup
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

staging_root="$(mktemp -d "$runtime_parent/.cdx-uninstall.XXXXXX")" \
  || refuse 'could not create uninstall staging'
chmod 0700 "$staging_root"
command_staging="$(mktemp -d "$command_dir/.cdx-uninstall-command.XXXXXX")" \
  || refuse 'could not create command staging'
chmod 0700 "$command_staging"
fish_new="$(mktemp "$fish_dir/.cdx-uninstall-fish.XXXXXX")" \
  || refuse 'could not stage restored Fish config'
cp "$recovery/config-before" "$fish_new"
chmod "$original_mode" "$fish_new"
fish_staged_hash="$(sha256_file "$fish_new")"

active=true
fish_old="$(mktemp "$fish_dir/.cdx-uninstall-fish.XXXXXX")" || refuse 'could not stage current Fish config'
rm -f -- "$fish_old"
fish_original_intent=true
mv "$fish_config" "$fish_old"
[ "${CDX_UNINSTALL_TEST_FAIL_AT-}" != during-fish-publication ] \
  || refuse 'injected failure at during-fish-publication'
fish_publish_intent=true
mv "$fish_new" "$fish_config"
fish_new=''
[ "${CDX_UNINSTALL_TEST_FAIL_AT-}" != after-fish-publication ] \
  || refuse 'injected failure at after-fish-publication'

command_remove_intent=true
mv "$command_path" "$command_staging/command"
[ "${CDX_UNINSTALL_TEST_FAIL_AT-}" != after-command-removal ] \
  || refuse 'injected failure at after-command-removal'

runtime_remove_intent=true
mv "$install_root" "$staging_root/runtime"
[ "${CDX_UNINSTALL_TEST_FAIL_AT-}" != after-runtime-removal ] \
  || refuse 'injected failure at after-runtime-removal'

active=false
cleanup
if [ "$removed_legacy_alias" = true ]; then
  printf 'Uninstalled cdx; Codex profile homes were preserved. Reload Fish to restore the legacy alias in existing shells.\n'
else
  printf 'Uninstalled cdx; Codex profile homes were preserved. Fish config had no cdx definition to restore.\n'
fi
