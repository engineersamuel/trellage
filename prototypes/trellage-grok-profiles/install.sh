#!/usr/bin/env bash
set -euo pipefail

refuse() {
  printf 'grx install: %s\n' "$1" >&2
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

source_dir="$(cd "$(dirname "$0")" && pwd)"
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
runtime_owned=false
staging_root=''
command_staging_root=''
preserve_staging=false
publication_active=false
publication_completed=false
rollback_attempted=false
rollback_succeeded=false

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
if [ -e "$install_root" ] && [ ! -d "$install_root" ]; then
  refuse "refusing unowned runtime root: $install_root"
fi

if [ -e "$install_root" ]; then
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
  runtime_owned=true
fi

if [ "$runtime_owned" = true ]; then
  [ -e "$command_path" ] || [ -L "$command_path" ] \
    || refuse "refusing incomplete owned runtime: $command_path"
  [ -L "$command_path" ] \
    || refuse "refusing to replace unrelated command: $command_path"
  [ "$(readlink "$command_path")" = "$installed_launcher" ] \
    || refuse "refusing to replace unrelated command: $command_path"
elif [ -e "$command_path" ] || [ -L "$command_path" ]; then
  if [ ! -L "$command_path" ]; then
    refuse "refusing to replace unrelated command: $command_path"
  fi
  refuse "refusing to replace unrelated command: $command_path"
fi

create_parent_directory() {
  local path="$1"

  if [ ! -d "$path" ]; then
    mkdir -m 0755 "$path"
  fi
}

create_parent_directory "$local_dir"
create_parent_directory "$share_dir"
create_parent_directory "$runtime_parent"

cleanup_runtime_staging() {
  local cleanup_ok=true
  local staged_file

  [ -n "$staging_root" ] || return 0
  [ "$preserve_staging" != true ] || return 0
  case "$staging_root" in
    "$runtime_parent"/.grx-install.*) ;;
    *) return 1 ;;
  esac

  if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = signal-during-publish-cleanup-failure ]; then
    return 1
  fi

  for staged_file in \
    "$staging_root/new-launcher" \
    "$staging_root/new-catalog" \
    "$staging_root/new-marker" \
    "$staging_root/old-launcher" \
    "$staging_root/old-catalog" \
    "$staging_root/old-marker"; do
    rm -f -- "$staged_file" || cleanup_ok=false
  done
  rmdir "$staging_root" 2>/dev/null || cleanup_ok=false
  [ "$cleanup_ok" = true ]
}

cleanup_command_staging() {
  local cleanup_ok=true
  local staged_file

  [ -n "$command_staging_root" ] || return 0
  [ "$preserve_staging" != true ] || return 0
  case "$command_staging_root" in
    "$command_dir"/.grx-command.*) ;;
    *) return 1 ;;
  esac

  for staged_file in \
    "$command_staging_root/new-command" \
    "$command_staging_root/old-command"; do
    rm -f -- "$staged_file" || cleanup_ok=false
  done
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

cleanup_on_exit() {
  local status=$?

  trap - EXIT INT TERM
  if [ "$publication_active" = true ] \
    && [ "$publication_completed" != true ]; then
    if ! rollback_once; then
      preserve_staging=true
      printf 'grx install: rollback failed during interrupted publication; runtime recovery: %s; command recovery: %s\n' \
        "$staging_root" "$command_staging_root" >&2
    fi
  fi
  if ! cleanup_staging; then
    printf 'grx install: failed to clean installation staging' >&2
    if [ -n "$staging_root" ] && [ -d "$staging_root" ]; then
      printf '; runtime recovery: %s' "$staging_root" >&2
    fi
    if [ -n "$command_staging_root" ] && [ -d "$command_staging_root" ]; then
      printf '; command recovery: %s' "$command_staging_root" >&2
    fi
    printf '\n' >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}

exit_for_signal() {
  local status="$1"

  exit "$status"
}

trap cleanup_on_exit EXIT
trap 'exit_for_signal 130' INT
trap 'exit_for_signal 143' TERM

staging_root="$(mktemp -d "$runtime_parent/.grx-install.XXXXXX")" \
  || refuse "could not create staging directory in: $runtime_parent"
chmod 0700 "$staging_root"
install -m 0755 "$source_dir/bin/grx" "$staging_root/new-launcher"
install -m 0644 "$source_dir/catalog.json" "$staging_root/new-catalog"
printf '%s\n' "$ownership_value" >"$staging_root/new-marker"
chmod 0644 "$staging_root/new-marker"

if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-staging ]; then
  refuse 'injected failure at after-staging'
fi

created_install_root=false
created_runtime_bin=false
created_command_dir=false
old_launcher_staged=false
old_catalog_staged=false
old_marker_staged=false
old_command_staged=false
new_launcher_published=false
new_catalog_published=false
new_marker_published=false
new_command_published=false
install_root_mode=''
runtime_bin_mode=''

file_mode() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) stat -f '%Lp' "$1" ;;
    Linux) stat -c '%a' "$1" ;;
    *) return 1 ;;
  esac
}

if [ -d "$install_root" ]; then
  install_root_mode="$(file_mode "$install_root")"
fi
if [ -d "$runtime_bin" ]; then
  runtime_bin_mode="$(file_mode "$runtime_bin")"
fi
rollback_publish() {
  local rollback_ok=true

  if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = signal-during-publish-rollback-failure ]; then
    rollback_ok=false
  fi

  if [ "$new_command_published" = true ]; then
    if [ -L "$command_path" ] \
      && [ ! -e "$command_staging_root/new-command" ] \
      && [ ! -L "$command_staging_root/new-command" ]; then
      mv "$command_path" "$command_staging_root/new-command" || rollback_ok=false
    elif [ ! -L "$command_staging_root/new-command" ] \
      || [ -e "$command_path" ] || [ -L "$command_path" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$old_command_staged" = true ]; then
    if [ -L "$command_staging_root/old-command" ] \
      && [ ! -e "$command_path" ] && [ ! -L "$command_path" ]; then
      mv "$command_staging_root/old-command" "$command_path" || rollback_ok=false
    elif [ ! -L "$command_path" ] \
      || [ "$(readlink "$command_path")" != "$installed_launcher" ] \
      || [ -e "$command_staging_root/old-command" ] \
      || [ -L "$command_staging_root/old-command" ]; then
      rollback_ok=false
    fi
  fi

  if [ "$new_marker_published" = true ]; then
    if [ -f "$ownership_marker" ] && [ ! -L "$ownership_marker" ] \
      && [ ! -e "$staging_root/new-marker" ] \
      && [ ! -L "$staging_root/new-marker" ]; then
      mv "$ownership_marker" "$staging_root/new-marker" || rollback_ok=false
    elif [ ! -f "$staging_root/new-marker" ] \
      || [ -L "$staging_root/new-marker" ] \
      || [ -e "$ownership_marker" ] || [ -L "$ownership_marker" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$new_catalog_published" = true ]; then
    if [ -f "$installed_catalog" ] && [ ! -L "$installed_catalog" ] \
      && [ ! -e "$staging_root/new-catalog" ] \
      && [ ! -L "$staging_root/new-catalog" ]; then
      mv "$installed_catalog" "$staging_root/new-catalog" || rollback_ok=false
    elif [ ! -f "$staging_root/new-catalog" ] \
      || [ -L "$staging_root/new-catalog" ] \
      || [ -e "$installed_catalog" ] || [ -L "$installed_catalog" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$new_launcher_published" = true ]; then
    if [ -f "$installed_launcher" ] && [ ! -L "$installed_launcher" ] \
      && [ ! -e "$staging_root/new-launcher" ] \
      && [ ! -L "$staging_root/new-launcher" ]; then
      mv "$installed_launcher" "$staging_root/new-launcher" || rollback_ok=false
    elif [ ! -f "$staging_root/new-launcher" ] \
      || [ -L "$staging_root/new-launcher" ] \
      || [ -e "$installed_launcher" ] || [ -L "$installed_launcher" ]; then
      rollback_ok=false
    fi
  fi

  if [ "$old_launcher_staged" = true ]; then
    if [ -f "$staging_root/old-launcher" ] && [ ! -L "$staging_root/old-launcher" ] \
      && [ ! -e "$installed_launcher" ] && [ ! -L "$installed_launcher" ]; then
      mv "$staging_root/old-launcher" "$installed_launcher" || rollback_ok=false
    elif [ ! -f "$installed_launcher" ] || [ -L "$installed_launcher" ] \
      || [ -e "$staging_root/old-launcher" ] \
      || [ -L "$staging_root/old-launcher" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$old_catalog_staged" = true ]; then
    if [ -f "$staging_root/old-catalog" ] && [ ! -L "$staging_root/old-catalog" ] \
      && [ ! -e "$installed_catalog" ] && [ ! -L "$installed_catalog" ]; then
      mv "$staging_root/old-catalog" "$installed_catalog" || rollback_ok=false
    elif [ ! -f "$installed_catalog" ] || [ -L "$installed_catalog" ] \
      || [ -e "$staging_root/old-catalog" ] \
      || [ -L "$staging_root/old-catalog" ]; then
      rollback_ok=false
    fi
  fi
  if [ "$old_marker_staged" = true ]; then
    if [ -f "$staging_root/old-marker" ] && [ ! -L "$staging_root/old-marker" ] \
      && [ ! -e "$ownership_marker" ] && [ ! -L "$ownership_marker" ]; then
      mv "$staging_root/old-marker" "$ownership_marker" || rollback_ok=false
    elif [ ! -f "$ownership_marker" ] || [ -L "$ownership_marker" ] \
      || [ -e "$staging_root/old-marker" ] \
      || [ -L "$staging_root/old-marker" ]; then
      rollback_ok=false
    fi
  fi

  if [ -n "$install_root_mode" ] && [ -d "$install_root" ]; then
    chmod "$install_root_mode" "$install_root" || rollback_ok=false
  fi
  if [ -n "$runtime_bin_mode" ] && [ -d "$runtime_bin" ]; then
    chmod "$runtime_bin_mode" "$runtime_bin" || rollback_ok=false
  fi
  if [ "$rollback_ok" = true ] \
    && [ "${GRX_INSTALL_TEST_FAIL_AT-}" != signal-during-publish-cleanup-failure ]; then
    cleanup_command_staging || rollback_ok=false
  fi
  if [ "$created_runtime_bin" = true ] && [ -d "$runtime_bin" ]; then
    rmdir "$runtime_bin" 2>/dev/null || rollback_ok=false
  fi
  if [ "$created_install_root" = true ] && [ -d "$install_root" ]; then
    rmdir "$install_root" 2>/dev/null || rollback_ok=false
  fi
  if [ "$created_command_dir" = true ] && [ -d "$command_dir" ]; then
    rmdir "$command_dir" 2>/dev/null || rollback_ok=false
  fi

  [ "$rollback_ok" = true ]
}

rollback_once() {
  if [ "$rollback_attempted" = true ]; then
    [ "$rollback_succeeded" = true ]
    return
  fi

  rollback_attempted=true
  if rollback_publish; then
    rollback_succeeded=true
    publication_active=false
    return 0
  fi
  preserve_staging=true
  publication_active=false
  return 1
}

publish_failure() {
  local message="$1"

  if ! rollback_once; then
    refuse "rollback failed after publish error; runtime recovery: $staging_root; command recovery: $command_staging_root: $message"
  fi
  refuse "$message"
}

signal_after_move() {
  local point="$1"

  case "${GRX_INSTALL_TEST_FAIL_AT-}" in
    "interrupt-after-$point") kill -INT "$$" ;;
    "terminate-after-$point") kill -TERM "$$" ;;
  esac
}

publication_active=true

if [ ! -d "$install_root" ]; then
  created_install_root=true
  mkdir -m 0755 "$install_root" \
    || publish_failure "could not create runtime root: $install_root"
  if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = interrupt-after-install-root-create ]; then
    kill -INT "$$"
  fi
fi
if [ ! -d "$runtime_bin" ]; then
  created_runtime_bin=true
  mkdir -m 0755 "$runtime_bin" \
    || publish_failure "could not create runtime bin: $runtime_bin"
fi
if [ ! -d "$command_dir" ]; then
  created_command_dir=true
  mkdir -m 0755 "$command_dir" \
    || publish_failure "could not create command directory: $command_dir"
fi

command_staging_root="$(mktemp -d "$command_dir/.grx-command.XXXXXX")" \
  || publish_failure "could not create command staging directory in: $command_dir"
chmod 0700 "$command_staging_root" \
  || publish_failure "could not protect command staging directory: $command_staging_root"
ln -s "$installed_launcher" "$command_staging_root/new-command" \
  || publish_failure "could not stage command: $command_path"

if [ -f "$installed_launcher" ]; then
  old_launcher_staged=true
  mv "$installed_launcher" "$staging_root/old-launcher" \
    || publish_failure "could not stage prior launcher: $installed_launcher"
  signal_after_move old-launcher-stage
fi
if [ -f "$installed_catalog" ]; then
  old_catalog_staged=true
  mv "$installed_catalog" "$staging_root/old-catalog" \
    || publish_failure "could not stage prior catalog: $installed_catalog"
  signal_after_move old-catalog-stage
fi
if [ -f "$ownership_marker" ]; then
  old_marker_staged=true
  mv "$ownership_marker" "$staging_root/old-marker" \
    || publish_failure "could not stage prior ownership marker: $ownership_marker"
  signal_after_move old-marker-stage
fi

if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = during-publish ]; then
  publish_failure 'injected failure at during-publish'
fi
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = exit-during-publish ]; then
  exit 71
fi
case "${GRX_INSTALL_TEST_FAIL_AT-}" in
  signal-during-publish|signal-during-publish-rollback-failure|signal-during-publish-cleanup-failure)
    kill -TERM "$$"
    ;;
  interrupt-during-publish)
    kill -INT "$$"
    ;;
esac

new_launcher_published=true
mv "$staging_root/new-launcher" "$installed_launcher" \
  || publish_failure "could not publish launcher: $installed_launcher"
signal_after_move new-launcher-publish
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-launcher-publish ]; then
  publish_failure 'injected failure at after-launcher-publish'
fi
new_catalog_published=true
mv "$staging_root/new-catalog" "$installed_catalog" \
  || publish_failure "could not publish catalog: $installed_catalog"
signal_after_move new-catalog-publish
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-catalog-publish ]; then
  publish_failure 'injected failure at after-catalog-publish'
fi
new_marker_published=true
mv "$staging_root/new-marker" "$ownership_marker" \
  || publish_failure "could not publish ownership marker: $ownership_marker"
signal_after_move new-marker-publish
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-marker-publish ]; then
  publish_failure 'injected failure at after-marker-publish'
fi

if [ -L "$command_path" ]; then
  old_command_staged=true
  mv "$command_path" "$command_staging_root/old-command" \
    || publish_failure "could not stage prior command: $command_path"
  signal_after_move old-command-stage
fi
new_command_published=true
mv "$command_staging_root/new-command" "$command_path" \
  || publish_failure "could not publish command: $command_path"
signal_after_move new-command-publish
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-command-publish ]; then
  publish_failure 'injected failure at after-command-publish'
fi

chmod 0755 "$install_root" \
  || publish_failure "could not set runtime root permissions: $install_root"
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-runtime-root-mode ]; then
  publish_failure 'injected failure at after-runtime-root-mode'
fi
chmod 0755 "$runtime_bin" \
  || publish_failure "could not set runtime bin permissions: $runtime_bin"
if [ "${GRX_INSTALL_TEST_FAIL_AT-}" = after-runtime-bin-mode ]; then
  publish_failure 'injected failure at after-runtime-bin-mode'
fi

publication_completed=true
publication_active=false
printf 'Installed grx at %s\n' "$command_path"
"$source_dir/../../scripts/install-floating-skills-runtime.sh"
