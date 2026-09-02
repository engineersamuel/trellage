#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-firstmate-profiles-v1'
readonly install_lock_owner='trellage-firstmate-install-lock-v1'

refuse() {
  printf 'fmx uninstall: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P
}

home="${HOME-}"
[[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"
local_dir="$canonical_home/.local"
runtime_parent="$local_dir/share/trellage"
install_root="$runtime_parent/fmx"
install_lock="$runtime_parent/.fmx-install.lock"
installed_launcher="$install_root/bin/fmx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-firstmate-profiles"
command_dir="$local_dir/bin"
command_path="$command_dir/fmx"
lock_acquired=false

acquire_install_lock() {
  local owner=''
  local pid=''
  local path

  if ! mkdir -m 0700 "$install_lock" 2>/dev/null; then
    [[ -d "$install_lock" && ! -L "$install_lock" ]] \
      || refuse "unowned fmx install lock: $install_lock"
    if [[ -f "$install_lock/owner" && ! -L "$install_lock/owner" ]]; then
      owner="$(<"$install_lock/owner")"
    fi
    if [[ -f "$install_lock/pid" && ! -L "$install_lock/pid" ]]; then
      pid="$(<"$install_lock/pid")"
    fi
    [[ "$owner" == "$install_lock_owner" ]] \
      || refuse "unowned fmx install lock: $install_lock"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
      || refuse "incomplete fmx install lock: $install_lock"
    if kill -0 "$pid" 2>/dev/null; then
      refuse "another fmx runtime operation is active with pid $pid"
    fi
    while IFS= read -r path; do
      case "$path" in
        "$install_lock/owner"|"$install_lock/pid") ;;
        *) refuse "unowned fmx install lock: $install_lock" ;;
      esac
    done < <(find "$install_lock" -mindepth 1 -print)
    rm -- "$install_lock/owner" "$install_lock/pid"
    rmdir "$install_lock"
    mkdir -m 0700 "$install_lock" \
      || refuse "could not reclaim stale fmx install lock: $install_lock"
  fi
  printf '%s\n' "$install_lock_owner" >"$install_lock/owner"
  printf '%s\n' "$$" >"$install_lock/pid"
  chmod 0600 "$install_lock/owner" "$install_lock/pid"
  lock_acquired=true
}

release_install_lock() {
  local path

  [[ "$lock_acquired" == true ]] || return 0
  [[ -d "$install_lock" && ! -L "$install_lock" \
    && -f "$install_lock/owner" && ! -L "$install_lock/owner" \
    && "$(<"$install_lock/owner")" == "$install_lock_owner" \
    && -f "$install_lock/pid" && ! -L "$install_lock/pid" \
    && "$(<"$install_lock/pid")" == "$$" ]] \
    || return 1
  while IFS= read -r path; do
    case "$path" in
      "$install_lock/owner"|"$install_lock/pid") ;;
      *) return 1 ;;
    esac
  done < <(find "$install_lock" -mindepth 1 -print)
  rm -- "$install_lock/owner" "$install_lock/pid" || return 1
  rmdir "$install_lock" || return 1
  lock_acquired=false
}

on_exit() {
  local status=$?

  trap - EXIT HUP INT TERM
  if ! release_install_lock; then
    printf 'fmx uninstall: could not release runtime operation lock: %s\n' \
      "$install_lock" >&2
    status=1
  fi
  exit "$status"
}

cleanup_abandoned_install_artifacts() {
  local path

  while IFS= read -r path; do
    [[ -d "$path" && ! -L "$path" ]] \
      || refuse "unsafe retired fmx install artifact: $path"
    rm -rf -- "$path"
  done < <(find "$runtime_parent" -mindepth 1 -maxdepth 1 \
    -name '.fmx-retired-install.*' -print)
  if [[ -d "$command_dir" && ! -L "$command_dir" ]]; then
    while IFS= read -r path; do
      [[ -d "$path" && ! -L "$path" ]] \
        || refuse "unsafe fmx command staging artifact: $path"
      rm -rf -- "$path"
    done < <(find "$command_dir" -mindepth 1 -maxdepth 1 \
      -name '.fmx-command.*' -print)
  fi
}

profile_lock_blocks_runtime_change() {
  local lock="$1"
  local pid

  [[ -e "$lock" || -L "$lock" ]] || return 1
  [[ -d "$lock" && ! -L "$lock" \
    && -f "$lock/owner" && ! -L "$lock/owner" \
    && "$(<"$lock/owner")" == "$ownership_value" \
    && -f "$lock/pid" && ! -L "$lock/pid" ]] \
    || return 0
  pid="$(<"$lock/pid")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  kill -0 "$pid" 2>/dev/null
}

active_fmx_fleet_or_mutation() {
  local profile_root worker_root worker marker pid

  for profile_root in "$canonical_home/.local/share/trellage/profiles/firstmate"/*; do
    [[ -d "$profile_root" && ! -L "$profile_root" ]] || continue
    if profile_lock_blocks_runtime_change "$profile_root/locks/session" \
      || profile_lock_blocks_runtime_change "$profile_root/locks/mutation"; then
      printf '%s\n' "$profile_root"
      return 0
    fi
    worker_root="$profile_root/workers"
    if [[ -e "$worker_root" || -L "$worker_root" ]]; then
      [[ -d "$worker_root" && ! -L "$worker_root" ]] || {
        printf '%s\n' "$profile_root"
        return 0
      }
      for worker in "$worker_root"/*; do
        [[ -d "$worker" && ! -L "$worker" ]] || continue
        marker="$worker/.active"
        [[ -e "$marker" || -L "$marker" ]] || continue
        if [[ ! -f "$marker" || -L "$marker" ]]; then
          printf '%s\n' "$profile_root"
          return 0
        fi
        pid="$(<"$marker")"
        if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || kill -0 "$pid" 2>/dev/null; then
          printf '%s\n' "$profile_root"
          return 0
        fi
      done
    fi
  done
  return 1
}

if [[ -e "$runtime_parent" || -L "$runtime_parent" ]]; then
  [[ -d "$runtime_parent" && ! -L "$runtime_parent" ]] \
    || refuse "unsafe runtime parent: $runtime_parent"
  [[ "$(canonical_directory "$runtime_parent")" == "$canonical_home/.local/share/trellage" ]] \
    || refuse "redirected runtime parent: $runtime_parent"
  trap on_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  acquire_install_lock
  if find "$runtime_parent" -mindepth 1 -maxdepth 1 -name '.fmx-install.*' \
    ! -path "$install_lock" -print -quit | grep -q .; then
    refuse "interrupted fmx install exists; rerun install.sh before uninstalling"
  fi
  cleanup_abandoned_install_artifacts
fi

if [[ ! -e "$install_root" && ! -L "$install_root" ]]; then
  if [[ -e "$command_path" || -L "$command_path" ]]; then
    [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
      || refuse "unowned command remains: $command_path"
    rm -- "$command_path"
  fi
  printf 'fmx is not installed; Firstmate profile state was preserved.\n'
  exit 0
fi

[[ -d "$install_root" && ! -L "$install_root" ]] \
  || refuse "unsafe runtime root: $install_root"
[[ "$(canonical_directory "$install_root")" == "$canonical_home/.local/share/trellage/fmx" ]] \
  || refuse "redirected runtime root: $install_root"
[[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
  || refuse "unowned runtime root: $install_root"
[[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
  || refuse "unowned runtime root: $install_root"
[[ -f "$installed_launcher" && ! -L "$installed_launcher" ]] \
  || refuse "unsafe managed launcher: $installed_launcher"
[[ -f "$installed_catalog" && ! -L "$installed_catalog" ]] \
  || refuse "unsafe managed catalog: $installed_catalog"
if active_fmx_fleet_or_mutation >/dev/null; then
  refuse 'cannot uninstall fmx while a Firstmate fleet or profile mutation is active or indeterminate'
fi

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
  rm -- "$command_path"
fi

# Only the launcher runtime, its managed prerequisite toolchains, and its
# command symlink are removed. Profile roots under
# ~/.local/share/trellage/profiles/firstmate hold Firstmate homes, project
# clones, task records, worker state, and the pinned runtime, so they are never
# touched here.
rm -rf -- "$install_root"
release_install_lock \
  || refuse "could not release runtime operation lock: $install_lock"
printf 'Uninstalled fmx and its managed prerequisites; Firstmate profile roots, homes, and worker state were preserved.\n'
