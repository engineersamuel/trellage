#!/usr/bin/env bash
set -euo pipefail

refuse() {
  printf 'grx uninstall: %s\n' "$1" >&2
  exit 1
}

home="${HOME-}"
[ -n "$home" ] || refuse 'refusing unsafe HOME: HOME is empty'
case "$home" in
  /*) ;;
  *) refuse "refusing unsafe HOME: HOME is not absolute: $home" ;;
esac
[ -d "$home" ] && [ ! -L "$home" ] \
  || refuse "refusing unsafe HOME: HOME is not a real directory: $home"
home="$(cd -L "$home" >/dev/null 2>&1 && pwd -L)" \
  || refuse "refusing unsafe HOME: HOME is not a real directory: $home"
[ "$home" != / ] || refuse 'refusing unsafe HOME: HOME resolves to /'

local_dir="$home/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/grx"
runtime_bin="$install_root/bin"
installed_launcher="$runtime_bin/grx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-grok-profiles"
ownership_value='trellage-grok-profiles-v1'
command_dir="$local_dir/bin"
command_path="$command_dir/grx"

validate_managed_directory() {
  local path="$1"

  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
    refuse "refusing unsafe managed path: $path"
  fi
}

for path in "$local_dir" "$share_dir" "$runtime_parent" "$command_dir"; do
  validate_managed_directory "$path"
done

if [ -L "$install_root" ]; then
  refuse "refusing unsafe symlinked runtime root: $install_root"
fi

if [ ! -e "$install_root" ]; then
  if [ -e "$command_path" ] || [ -L "$command_path" ]; then
    refuse "refusing unowned runtime root: $install_root"
  fi
  printf 'grx is not installed; profile homes were preserved.\n'
  exit 0
fi

[ -d "$install_root" ] \
  || refuse "refusing unowned runtime root: $install_root"
[ -r "$install_root" ] && [ -x "$install_root" ] \
  || refuse "refusing unreadable owned runtime directory: $install_root"
[ -f "$ownership_marker" ] && [ ! -L "$ownership_marker" ] \
  || refuse "refusing unowned runtime root: $install_root"
[ -r "$ownership_marker" ] \
  || refuse "refusing unreadable owned runtime file: $ownership_marker"
cmp -s "$ownership_marker" <(printf '%s\n' "$ownership_value") \
  || refuse "refusing unowned runtime root: $install_root"
[ -e "$runtime_bin" ] || [ -L "$runtime_bin" ] \
  || refuse "refusing incomplete owned runtime: $runtime_bin"
[ ! -L "$runtime_bin" ] && [ -d "$runtime_bin" ] \
  || refuse "refusing unsafe managed runtime path: $runtime_bin"
[ -r "$runtime_bin" ] && [ -x "$runtime_bin" ] \
  || refuse "refusing unreadable owned runtime directory: $runtime_bin"
[ -e "$installed_launcher" ] || [ -L "$installed_launcher" ] \
  || refuse "refusing incomplete owned runtime: $installed_launcher"
[ ! -L "$installed_launcher" ] && [ -f "$installed_launcher" ] \
  || refuse "refusing unsafe managed runtime path: $installed_launcher"
[ -r "$installed_launcher" ] \
  || refuse "refusing unreadable owned runtime file: $installed_launcher"
[ -e "$installed_catalog" ] || [ -L "$installed_catalog" ] \
  || refuse "refusing incomplete owned runtime: $installed_catalog"
[ ! -L "$installed_catalog" ] && [ -f "$installed_catalog" ] \
  || refuse "refusing unsafe managed runtime path: $installed_catalog"
[ -r "$installed_catalog" ] \
  || refuse "refusing unreadable owned runtime file: $installed_catalog"

for entry in \
  "$install_root"/.[!.]* \
  "$install_root"/..?* \
  "$install_root"/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  case "$entry" in
    "$runtime_bin"|"$installed_catalog"|"$ownership_marker") ;;
    *) refuse "refusing unexpected content in owned runtime: $entry" ;;
  esac
done

for entry in \
  "$runtime_bin"/.[!.]* \
  "$runtime_bin"/..?* \
  "$runtime_bin"/*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  case "$entry" in
    "$installed_launcher") ;;
    *) refuse "refusing unexpected content in owned runtime: $entry" ;;
  esac
done

[ -e "$command_path" ] || [ -L "$command_path" ] \
  || refuse "refusing incomplete owned runtime: $command_path"
[ -L "$command_path" ] \
  || refuse "refusing to remove unrelated command: $command_path"
[ "$(readlink "$command_path")" = "$installed_launcher" ] \
  || refuse "refusing to remove unrelated command: $command_path"
[ -d "$command_dir" ] && [ ! -L "$command_dir" ] \
  || refuse "refusing unsafe managed path: $command_dir"
[ -w "$command_dir" ] && [ -x "$command_dir" ] \
  || refuse "refusing non-writable or non-searchable managed command directory: $command_dir"
[ -w "$runtime_parent" ] && [ -x "$runtime_parent" ] \
  || refuse "refusing non-writable or non-searchable managed runtime parent: $runtime_parent"
[ -w "$install_root" ] && [ -x "$install_root" ] \
  || refuse "refusing non-writable or non-searchable owned runtime directory: $install_root"
[ -w "$runtime_bin" ] && [ -x "$runtime_bin" ] \
  || refuse "refusing non-writable or non-searchable owned runtime directory: $runtime_bin"

file_mode() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

install_root_mode="$(file_mode "$install_root")"
runtime_bin_mode="$(file_mode "$runtime_bin")"
command_dir_mode="$(file_mode "$command_dir")"
staging_root=''
command_staging_root=''
preserve_staging=false
transaction_active=false
transaction_completed=false
rollback_attempted=false
rollback_succeeded=false
launcher_staged=false
catalog_staged=false
marker_staged=false
runtime_bin_removed=false
install_root_removed=false
command_staged=false

cleanup_runtime_staging() {
  local cleanup_ok=true
  local staged_file

  [ -n "$staging_root" ] || return 0
  [ "$preserve_staging" != true ] || return 0
  case "$staging_root" in
    "$runtime_parent"/.grx-uninstall.*) ;;
    *) return 1 ;;
  esac
  if [ "${GRX_UNINSTALL_TEST_FAIL_AT-}" = cleanup-failure ]; then
    return 1
  fi
  for staged_file in \
    "$staging_root/launcher" \
    "$staging_root/catalog" \
    "$staging_root/marker"; do
    rm -f -- "$staged_file" || cleanup_ok=false
  done
  rmdir "$staging_root" 2>/dev/null || cleanup_ok=false
  if [ "$cleanup_ok" = true ]; then
    staging_root=''
  fi
  [ "$cleanup_ok" = true ]
}

cleanup_command_staging() {
  local cleanup_ok=true

  [ -n "$command_staging_root" ] || return 0
  [ "$preserve_staging" != true ] || return 0
  case "$command_staging_root" in
    "$command_dir"/.grx-uninstall-command.*) ;;
    *) return 1 ;;
  esac
  if [ "${GRX_UNINSTALL_TEST_FAIL_AT-}" = cleanup-failure ]; then
    return 1
  fi
  rm -f -- "$command_staging_root/command" || cleanup_ok=false
  rmdir "$command_staging_root" 2>/dev/null || cleanup_ok=false
  if [ "$cleanup_ok" = true ]; then
    command_staging_root=''
  fi
  [ "$cleanup_ok" = true ]
}

cleanup_staging() {
  if ! cleanup_runtime_staging; then
    preserve_staging=true
    return 1
  fi
  if ! cleanup_command_staging; then
    preserve_staging=true
    return 1
  fi
}

rollback_transaction() {
  local rollback_ok=true

  if [ "${GRX_UNINSTALL_TEST_FAIL_AT-}" = before-bin-remove-rollback-failure ]; then
    return 1
  fi
  if [ "$command_staged" = true ]; then
    if [ -L "$command_staging_root/command" ]; then
      if [ ! -e "$command_path" ] && [ ! -L "$command_path" ]; then
        mv "$command_staging_root/command" "$command_path" || rollback_ok=false
      else
        rollback_ok=false
      fi
    elif [ ! -L "$command_path" ] \
      || [ "$(readlink "$command_path")" != "$installed_launcher" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$install_root_removed" = true ] && [ ! -d "$install_root" ]; then
    if [ -e "$install_root" ] || [ -L "$install_root" ]; then
      rollback_ok=false
    else
      mkdir -m "$install_root_mode" "$install_root" || rollback_ok=false
    fi
  fi
  if [ "$runtime_bin_removed" = true ] && [ ! -d "$runtime_bin" ]; then
    if [ -e "$runtime_bin" ] || [ -L "$runtime_bin" ]; then
      rollback_ok=false
    else
      mkdir -m "$runtime_bin_mode" "$runtime_bin" || rollback_ok=false
    fi
  fi
  if [ "$marker_staged" = true ]; then
    if [ -f "$staging_root/marker" ] && [ ! -L "$staging_root/marker" ]; then
      if [ ! -e "$ownership_marker" ] && [ ! -L "$ownership_marker" ]; then
        mv "$staging_root/marker" "$ownership_marker" || rollback_ok=false
      else
        rollback_ok=false
      fi
    elif [ ! -f "$ownership_marker" ] || [ -L "$ownership_marker" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$catalog_staged" = true ]; then
    if [ -f "$staging_root/catalog" ] && [ ! -L "$staging_root/catalog" ]; then
      if [ ! -e "$installed_catalog" ] && [ ! -L "$installed_catalog" ]; then
        mv "$staging_root/catalog" "$installed_catalog" || rollback_ok=false
      else
        rollback_ok=false
      fi
    elif [ ! -f "$installed_catalog" ] || [ -L "$installed_catalog" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$launcher_staged" = true ]; then
    if [ -f "$staging_root/launcher" ] && [ ! -L "$staging_root/launcher" ]; then
      if [ ! -e "$installed_launcher" ] && [ ! -L "$installed_launcher" ]; then
        mv "$staging_root/launcher" "$installed_launcher" || rollback_ok=false
      else
        rollback_ok=false
      fi
    elif [ ! -f "$installed_launcher" ] || [ -L "$installed_launcher" ]; then
      rollback_ok=false
    fi
  fi
  if [ -d "$install_root" ]; then
    chmod "$install_root_mode" "$install_root" || rollback_ok=false
  fi
  if [ -d "$runtime_bin" ]; then
    chmod "$runtime_bin_mode" "$runtime_bin" || rollback_ok=false
  fi
  chmod "$command_dir_mode" "$command_dir" || rollback_ok=false
  if [ "$rollback_ok" = true ]; then
    cleanup_staging || rollback_ok=false
  fi
  [ "$rollback_ok" = true ]
}

rollback_once() {
  if [ "$rollback_attempted" = true ]; then
    [ "$rollback_succeeded" = true ]
    return
  fi
  rollback_attempted=true
  if rollback_transaction; then
    rollback_succeeded=true
    transaction_active=false
    return 0
  fi
  preserve_staging=true
  transaction_active=false
  return 1
}

transaction_failure() {
  local message="$1"

  if ! rollback_once; then
    refuse "rollback failed; runtime recovery: $staging_root; command recovery: $command_staging_root: $message"
  fi
  refuse "$message"
}

inject_failure_at() {
  local point="$1"

  case "${GRX_UNINSTALL_TEST_FAIL_AT-}" in
    "$point"|"$point-rollback-failure")
      transaction_failure "injected failure at $point"
      ;;
  esac
}

cleanup_on_exit() {
  local status=$?

  trap - EXIT INT TERM
  if [ "$transaction_active" = true ] \
    && [ "$transaction_completed" != true ]; then
    if ! rollback_once; then
      preserve_staging=true
      printf 'grx uninstall: rollback failed during interrupted removal; runtime recovery: %s; command recovery: %s\n' \
        "$staging_root" "$command_staging_root" >&2
    fi
  fi
  if ! cleanup_staging; then
    printf 'grx uninstall: failed to clean uninstall staging; runtime recovery: %s; command recovery: %s\n' \
      "$staging_root" "$command_staging_root" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}

trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

staging_root="$(mktemp -d "$runtime_parent/.grx-uninstall.XXXXXX")" \
  || refuse "could not create uninstall staging directory in: $runtime_parent"
chmod 0700 "$staging_root" \
  || refuse "could not protect uninstall staging directory: $staging_root"
command_staging_root="$(mktemp -d "$command_dir/.grx-uninstall-command.XXXXXX")" \
  || refuse "could not create uninstall command staging directory in: $command_dir"
chmod 0700 "$command_staging_root" \
  || refuse "could not protect uninstall command staging directory: $command_staging_root"

transaction_active=true
launcher_staged=true
mv "$installed_launcher" "$staging_root/launcher" \
  || transaction_failure "could not stage installed launcher: $installed_launcher"
if [ "${GRX_UNINSTALL_TEST_FAIL_AT-}" = interrupt-after-launcher-remove ]; then
  kill -INT "$$"
fi
inject_failure_at after-launcher-remove
catalog_staged=true
mv "$installed_catalog" "$staging_root/catalog" \
  || transaction_failure "could not stage installed catalog: $installed_catalog"
inject_failure_at after-catalog-remove
marker_staged=true
mv "$ownership_marker" "$staging_root/marker" \
  || transaction_failure "could not stage ownership marker: $ownership_marker"
inject_failure_at after-marker-remove
inject_failure_at before-bin-remove
runtime_bin_removed=true
rmdir "$runtime_bin" 2>/dev/null \
  || transaction_failure "could not remove owned runtime bin: $runtime_bin"
inject_failure_at after-bin-remove
inject_failure_at before-root-remove
install_root_removed=true
rmdir "$install_root" 2>/dev/null \
  || transaction_failure "could not remove owned runtime root: $install_root"
inject_failure_at after-root-remove
inject_failure_at before-command-remove
command_staged=true
mv "$command_path" "$command_staging_root/command" \
  || transaction_failure "could not stage managed command: $command_path"
inject_failure_at after-command-remove

transaction_completed=true
transaction_active=false
if ! cleanup_staging; then
  printf 'grx uninstall: failed to clean uninstall staging; runtime recovery: %s; command recovery: %s\n' \
    "$staging_root" "$command_staging_root" >&2
  exit 1
fi
printf 'Uninstalled grx; profile homes were preserved.\n'
