#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -P "$(dirname "$0")" && pwd -P)"
local_dir="$HOME/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/trx"
install_lock="$runtime_parent/.trx-install.lock"
command_dir="$local_dir/bin"
command_path="$command_dir/trx"
installed_launcher="$install_root/bin/trx"
installed_dependency_bootstrap="$install_root/lib/bootstrap-development-dependencies.sh"
installed_share="$install_root/share"
installed_guides="$installed_share/profile-guides"
legacy_picker="$install_root/lib/terminal-picker.mjs"
ownership_marker="$install_root/.managed-by-trellage-router"
# v2 prevents an older router installer from replacing newer guide/catalog
# support. This installer can migrate a validated v1 runtime once.
ownership_value='trellage-router-v2'
legacy_ownership_value='trellage-router-v1'

refuse() {
  printf 'trx install: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  (CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P)
}

require_safe_directory() {
  local path="$1"
  local expected="$2"
  local description="$3"
  local resolved

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "refusing unsafe $description: $path"
    resolved="$(canonical_directory "$path")" || refuse "cannot resolve $description: $path"
    [[ "$resolved" == "$expected" ]] || refuse "refusing redirected $description: $path"
  fi
}

require_owned_runtime_contents() {
  local path

  [[ -e "$install_root/bin" ]] \
    && [[ -d "$install_root/bin" && ! -L "$install_root/bin" ]] \
    || [[ ! -e "$install_root/bin" && ! -L "$install_root/bin" ]] \
    || refuse "refusing unsafe managed runtime path: $install_root/bin"
  [[ -e "$install_root/lib" ]] \
    && [[ -d "$install_root/lib" && ! -L "$install_root/lib" ]] \
    || [[ ! -e "$install_root/lib" && ! -L "$install_root/lib" ]] \
    || refuse "refusing unsafe managed runtime path: $install_root/lib"
  [[ -e "$installed_share" ]] \
    && [[ -d "$installed_share" && ! -L "$installed_share" ]] \
    || [[ ! -e "$installed_share" && ! -L "$installed_share" ]] \
    || refuse "refusing unsafe managed runtime path: $installed_share"

  for path in \
    "$installed_launcher" \
    "$install_root/lib/launcher.mjs" \
    "$installed_dependency_bootstrap" \
    "$legacy_picker"; do
    [[ ! -e "$path" && ! -L "$path" ]] || {
      [[ -f "$path" && ! -L "$path" ]] \
        || refuse "refusing unsafe managed runtime path: $path"
    }
  done

  while IFS= read -r path; do
    case "$path" in
      "$ownership_marker"|"$install_root/bin"|"$installed_launcher"|\
      "$install_root/lib"|"$install_root/lib/launcher.mjs"|\
      "$installed_dependency_bootstrap"|"$legacy_picker"|\
      "$installed_share"|"$installed_guides") ;;
      "$installed_guides"/*)
        [[ ! -L "$path" ]] || refuse "refusing symlinked profile guide path: $path"
        if [[ -d "$path" ]]; then
          :
        elif [[ -f "$path" && "$path" == *.md ]]; then
          :
        else
          refuse "refusing unrelated profile guide path: $path"
        fi
        ;;
      *) refuse "refusing unrelated runtime path: $path" ;;
    esac
  done < <(find "$install_root" -mindepth 1 -print)
}

case "$HOME" in
  /*) ;;
  *) refuse "HOME must be an absolute path: $HOME" ;;
esac
[[ -d "$HOME" && ! -L "$HOME" ]] || refuse "refusing unsafe HOME: $HOME"
canonical_home="$(canonical_directory "$HOME")" || refuse "cannot resolve HOME: $HOME"
[[ "$canonical_home" != / ]] || refuse 'HOME must not be /'

require_safe_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/trx" 'runtime root'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

launcher_bundle="$source_dir/../../packages/trellage-launcher/dist/launcher.mjs"
dependency_bootstrap="$source_dir/../../scripts/bootstrap-development-dependencies.sh"
source_guides="$source_dir/../../profile-guides"
floating_runtime_installer="$source_dir/../../scripts/install-floating-skills-runtime.sh"
[[ -f "$launcher_bundle" && ! -L "$launcher_bundle" ]] \
  || refuse "Ink launcher bundle is missing; run npm run build in packages/trellage-launcher"
[[ -f "$dependency_bootstrap" && -x "$dependency_bootstrap" && ! -L "$dependency_bootstrap" ]] \
  || refuse "dependency bootstrap is missing or unsafe: $dependency_bootstrap"
[[ -d "$source_guides" && ! -L "$source_guides" ]] \
  || refuse "profile guide registry is missing or unsafe: $source_guides"
[[ -f "$floating_runtime_installer" && -x "$floating_runtime_installer" \
  && ! -L "$floating_runtime_installer" ]] \
  || refuse "floating-skills runtime installer is missing or unsafe: $floating_runtime_installer"
while IFS= read -r guide_path; do
  [[ ! -L "$guide_path" ]] || refuse "profile guide registry contains a symlink: $guide_path"
  [[ -d "$guide_path" || (-f "$guide_path" && "$guide_path" == *.md) ]] \
    || refuse "profile guide registry contains an unsupported path: $guide_path"
done < <(find "$source_guides" -mindepth 1 -print)

staging_root=''
publication_active=false
runtime_old_intent=false
runtime_publish_intent=false
command_publish_intent=false
lock_acquired=false
created_local_dir=false
created_share_dir=false
created_runtime_parent=false
created_command_dir=false

cleanup_staging() {
  if [[ -n "$staging_root" && -d "$staging_root" ]]; then
    case "$staging_root" in
      "$runtime_parent"/.trx-install.*) rm -rf -- "$staging_root" ;;
    esac
  fi
}

cleanup_created_parents() {
  if [[ "$created_command_dir" == true && -d "$command_dir" && ! -L "$command_dir" ]]; then
    rmdir "$command_dir" 2>/dev/null || :
  fi
  if [[ "$created_runtime_parent" == true && -d "$runtime_parent" \
    && ! -L "$runtime_parent" ]]; then
    rmdir "$runtime_parent" 2>/dev/null || :
  fi
  if [[ "$created_share_dir" == true && -d "$share_dir" && ! -L "$share_dir" ]]; then
    rmdir "$share_dir" 2>/dev/null || :
  fi
  if [[ "$created_local_dir" == true && -d "$local_dir" && ! -L "$local_dir" ]]; then
    rmdir "$local_dir" 2>/dev/null || :
  fi
}

release_install_lock() {
  if [[ "$lock_acquired" == false ]]; then
    return 0
  fi
  [[ -d "$install_lock" && ! -L "$install_lock" ]] \
    && rmdir "$install_lock" \
    || return 1
  lock_acquired=false
}

rollback() {
  local ok=true

  if [[ "$command_publish_intent" == true ]]; then
    if [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]]; then
      rm -f -- "$command_path" || ok=false
    elif [[ -e "$command_path" || -L "$command_path" ]]; then
      ok=false
    fi
  fi

  if [[ "$runtime_publish_intent" == true \
    && ! -d "$staging_root/new-runtime" ]]; then
    if [[ -d "$install_root" && ! -L "$install_root" \
      && -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
      && cmp -s "$ownership_marker" <(printf '%s\n' "$ownership_value"); then
      rm -rf -- "$install_root" || ok=false
    else
      ok=false
    fi
  fi

  if [[ -d "$staging_root/old-runtime" ]]; then
    [[ ! -e "$install_root" && ! -L "$install_root" ]] \
      && mv "$staging_root/old-runtime" "$install_root" || ok=false
  fi

  [[ "$ok" == true ]]
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$publication_active" == true ]]; then
    if rollback; then
      cleanup_staging
    else
      printf 'trx install: rollback failed; recovery may be required\n' >&2
    fi
  else
    cleanup_staging
  fi
  if ! release_install_lock; then
    printf 'trx install: could not release install lock: %s\n' "$install_lock" >&2
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    cleanup_created_parents
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -d "$local_dir" ]]; then
  mkdir -m 0755 "$local_dir"
  created_local_dir=true
fi
if [[ ! -d "$share_dir" ]]; then
  mkdir -m 0755 "$share_dir"
  created_share_dir=true
fi
if [[ ! -d "$runtime_parent" ]]; then
  mkdir -m 0755 "$runtime_parent"
  created_runtime_parent=true
fi
if [[ ! -d "$command_dir" ]]; then
  mkdir -m 0755 "$command_dir"
  created_command_dir=true
fi

require_safe_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

if ! mkdir -m 0700 "$install_lock" 2>/dev/null; then
  refuse "another router install is in progress: $install_lock"
fi
lock_acquired=true

require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/trx" 'runtime root'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

if [[ -e "$install_root" ]]; then
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  if [[ "$(<"$ownership_marker")" != "$ownership_value" ]] \
    && [[ "$(<"$ownership_marker")" != "$legacy_ownership_value" ]]; then
    refuse "refusing unowned runtime root: $install_root"
  fi
  require_owned_runtime_contents
fi

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "refusing to replace unrelated command: $command_path"
fi

staging_root="$(mktemp -d "$runtime_parent/.trx-install.XXXXXX")" \
  || refuse "cannot stage router runtime in: $runtime_parent"
chmod 0700 "$staging_root"
mkdir -p \
  "$staging_root/new-runtime/bin" \
  "$staging_root/new-runtime/lib" \
  "$staging_root/new-runtime/share/profile-guides"
chmod 0755 \
  "$staging_root/new-runtime" \
  "$staging_root/new-runtime/bin" \
  "$staging_root/new-runtime/lib" \
  "$staging_root/new-runtime/share" \
  "$staging_root/new-runtime/share/profile-guides"
install -m 0755 "$launcher_bundle" "$staging_root/new-runtime/lib/launcher.mjs"
install -m 0755 "$dependency_bootstrap" \
  "$staging_root/new-runtime/lib/bootstrap-development-dependencies.sh"
install -m 0755 "$source_dir/bin/trx" "$staging_root/new-runtime/bin/trx"
printf '%s\n' "$ownership_value" \
  >"$staging_root/new-runtime/.managed-by-trellage-router"
chmod 0644 "$staging_root/new-runtime/.managed-by-trellage-router"
while IFS= read -r guide_path; do
  relative="${guide_path#"$source_guides/"}"
  mkdir -p "$staging_root/new-runtime/share/profile-guides/$(dirname "$relative")"
  install -m 0644 "$guide_path" \
    "$staging_root/new-runtime/share/profile-guides/$relative"
done < <(find "$source_guides" -type f -name '*.md' -print)
[[ -z "$(find "$staging_root/new-runtime" -type l -print -quit)" ]] \
  || refuse 'staged router runtime contains a symlink'
[[ "${TRX_INSTALL_TEST_FAIL_AT-}" != after-runtime-staging ]] \
  || refuse 'injected failure at after-runtime-staging'

publication_active=true
if [[ -d "$install_root" ]]; then
  runtime_old_intent=true
  mv "$install_root" "$staging_root/old-runtime"
fi
[[ "${TRX_INSTALL_TEST_FAIL_AT-}" != during-runtime-publication ]] \
  || refuse 'injected failure at during-runtime-publication'
runtime_publish_intent=true
[[ ! -e "$install_root" && ! -L "$install_root" ]] \
  || refuse "router runtime changed during publication: $install_root"
mv "$staging_root/new-runtime" "$install_root"
[[ ! -e "$install_root/new-runtime" && ! -L "$install_root/new-runtime" ]] \
  || refuse "router runtime changed during publication: $install_root"
[[ "${TRX_INSTALL_TEST_FAIL_AT-}" != after-runtime-publication ]] \
  || refuse 'injected failure at after-runtime-publication'

if [[ ! -L "$command_path" ]]; then
  command_publish_intent=true
  ln -s "$installed_launcher" "$command_path"
fi
[[ "${TRX_INSTALL_TEST_FAIL_AT-}" != after-command-publication ]] \
  || refuse 'injected failure at after-command-publication'

"$floating_runtime_installer"
publication_active=false
cleanup_staging
release_install_lock \
  || refuse "could not release install lock: $install_lock"
printf 'Installed trx at %s\n' "$command_path"
