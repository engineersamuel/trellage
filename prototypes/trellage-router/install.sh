#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -P "$(dirname "$0")" && pwd -P)"
local_dir="$HOME/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/trx"
command_dir="$local_dir/bin"
command_path="$command_dir/trx"
installed_launcher="$install_root/bin/trx"
installed_dependency_bootstrap="$install_root/lib/bootstrap-development-dependencies.sh"
installed_share="$install_root/share"
installed_guides="$installed_share/profile-guides"
legacy_picker="$install_root/lib/terminal-picker.mjs"
ownership_marker="$install_root/.managed-by-trellage-router"
ownership_value='trellage-router-v1'

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

if [[ -e "$install_root" ]]; then
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "refusing unowned runtime root: $install_root"
  require_owned_runtime_contents
fi

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "refusing to replace unrelated command: $command_path"
fi

mkdir -p "$install_root/bin" "$install_root/lib" "$installed_share" "$command_dir"
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/trx" 'runtime root'
require_safe_directory "$install_root/bin" "$canonical_home/.local/share/trellage/trx/bin" 'runtime bin'
require_safe_directory "$install_root/lib" "$canonical_home/.local/share/trellage/trx/lib" 'runtime library'
require_safe_directory "$installed_share" "$canonical_home/.local/share/trellage/trx/share" 'runtime share'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

printf '%s\n' "$ownership_value" >"$ownership_marker"
launcher_bundle="$source_dir/../../packages/trellage-launcher/dist/launcher.mjs"
dependency_bootstrap="$source_dir/../../scripts/bootstrap-development-dependencies.sh"
source_guides="$source_dir/../../profile-guides"
[[ -f "$launcher_bundle" && ! -L "$launcher_bundle" ]] \
  || refuse "Ink launcher bundle is missing; run npm run build in packages/trellage-launcher"
[[ -f "$dependency_bootstrap" && -x "$dependency_bootstrap" && ! -L "$dependency_bootstrap" ]] \
  || refuse "dependency bootstrap is missing or unsafe: $dependency_bootstrap"
[[ -d "$source_guides" && ! -L "$source_guides" ]] \
  || refuse "profile guide registry is missing or unsafe: $source_guides"
while IFS= read -r guide_path; do
  [[ ! -L "$guide_path" ]] || refuse "profile guide registry contains a symlink: $guide_path"
  [[ -d "$guide_path" || (-f "$guide_path" && "$guide_path" == *.md) ]] \
    || refuse "profile guide registry contains an unsupported path: $guide_path"
done < <(find "$source_guides" -mindepth 1 -print)
install -m 0755 "$launcher_bundle" "$install_root/lib/launcher.mjs"
install -m 0755 "$dependency_bootstrap" "$installed_dependency_bootstrap"
install -m 0755 "$source_dir/bin/trx" "$installed_launcher"

guide_stage="$(mktemp -d "$installed_share/.profile-guides.XXXXXX")" \
  || refuse 'cannot stage profile guides'
guide_backup=''
cleanup_guides() {
  [[ ! -d "$guide_stage" ]] || rm -rf -- "$guide_stage"
  [[ -z "$guide_backup" || ! -d "$guide_backup" ]] || rm -rf -- "$guide_backup"
}
trap cleanup_guides EXIT HUP INT TERM
while IFS= read -r guide_path; do
  relative="${guide_path#"$source_guides/"}"
  mkdir -p "$guide_stage/$(dirname "$relative")"
  install -m 0644 "$guide_path" "$guide_stage/$relative"
done < <(find "$source_guides" -type f -name '*.md' -print)
if [[ -e "$installed_guides" ]]; then
  guide_backup="$installed_share/.profile-guides.previous.$$"
  mv "$installed_guides" "$guide_backup"
fi
if ! mv "$guide_stage" "$installed_guides"; then
  [[ -z "$guide_backup" || ! -d "$guide_backup" ]] || mv "$guide_backup" "$installed_guides"
  refuse 'cannot publish profile guides'
fi
[[ -z "$guide_backup" || ! -d "$guide_backup" ]] || rm -rf -- "$guide_backup"
guide_backup=''
trap - EXIT HUP INT TERM
if [[ -e "$legacy_picker" ]]; then
  rm "$legacy_picker"
fi
if [[ ! -L "$command_path" ]]; then
  ln -s "$installed_launcher" "$command_path"
fi

printf 'Installed trx at %s\n' "$command_path"
"$source_dir/../../scripts/install-floating-skills-runtime.sh"
