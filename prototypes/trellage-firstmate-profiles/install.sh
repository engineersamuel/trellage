#!/usr/bin/env bash

set -euo pipefail

readonly ownership_value='trellage-firstmate-profiles-v1'
readonly install_lock_owner='trellage-firstmate-install-lock-v1'
readonly prerequisite_install_lock_owner='trellage-firstmate-prerequisites-v1'
readonly transaction_marker_name='.managed-by-trellage-firstmate-install-transaction'

refuse() {
  printf 'fmx install: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  (CDPATH= cd -P -- "$1" >/dev/null 2>&1 && pwd -P)
}

source_dir="$(CDPATH= cd -P -- "$(dirname "$0")" && pwd -P)"
repo_root="$(CDPATH= cd -P -- "$source_dir/../.." && pwd -P)"
home="${HOME-}"
[[ "$home" == /* && "$home" != / && -d "$home" && ! -L "$home" ]] \
  || refuse "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")" || refuse "cannot resolve HOME: $home"

local_dir="$canonical_home/.local"
share_dir="$local_dir/share"
runtime_parent="$share_dir/trellage"
install_root="$runtime_parent/fmx"
install_lock="$runtime_parent/.fmx-install.lock"
installed_launcher="$install_root/bin/fmx"
installed_catalog="$install_root/catalog.json"
ownership_marker="$install_root/.managed-by-trellage-firstmate-profiles"
command_dir="$local_dir/bin"
command_path="$command_dir/fmx"

native_claude_source="$repo_root/prototypes/trellage-claude-common/native-claude"
session_bridge_source="$repo_root/scripts/trellage-session-bridge.py"
floating_runtime_installer="$repo_root/scripts/install-floating-skills-runtime.sh"
prerequisite_helper_source="$source_dir/lib/fmx-prerequisites"
prerequisite_lock_source="$source_dir/prerequisites"

require_safe_directory() {
  local path="$1"
  local expected="$2"
  local description="$3"
  local canonical_path

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || refuse "unsafe $description: $path"
    canonical_path="$(canonical_directory "$path")" \
      || refuse "cannot resolve $description: $path"
    [[ "$canonical_path" == "$expected" ]] || refuse "redirected $description: $path"
  fi
}

require_regular_file() {
  local path="$1"
  local description="$2"

  [[ -f "$path" && -r "$path" && ! -L "$path" ]] \
    || refuse "missing $description or it is unsafe: $path"
}

require_runtime_directory() {
  local path="$1"

  [[ -d "$path" && ! -L "$path" ]] \
    || refuse "unsafe managed runtime path: $path"
}

require_runtime_file() {
  local path="$1"

  [[ -f "$path" && ! -L "$path" ]] \
    || refuse "unsafe managed runtime path: $path"
}

ensure_prerequisite_cache_idle() {
  local lock="$install_root/prerequisites/.install-lock"
  local owner=''
  local pid=''
  local path

  [[ ! -e "$lock" && ! -L "$lock" ]] && return 0
  [[ -d "$lock" && ! -L "$lock" ]] \
    || refuse "unowned prerequisite installation lock: $lock"
  if [[ -f "$lock/owner" && ! -L "$lock/owner" ]]; then
    owner="$(<"$lock/owner")"
  fi
  if [[ -f "$lock/pid" && ! -L "$lock/pid" ]]; then
    pid="$(<"$lock/pid")"
  fi
  [[ "$owner" == "$prerequisite_install_lock_owner" ]] \
    || refuse "unowned prerequisite installation lock: $lock"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || refuse "incomplete prerequisite installation lock: $lock"
  if kill -0 "$pid" 2>/dev/null; then
    refuse "prerequisite installation is active with pid $pid"
  fi
  while IFS= read -r path; do
    case "$path" in
      "$lock/owner"|"$lock/pid") ;;
      *) refuse "unowned prerequisite installation lock: $lock" ;;
    esac
  done < <(find "$lock" -mindepth 1 -print)
  rm -- "$lock/owner" "$lock/pid"
  rmdir "$lock"
}

require_owned_runtime_contents() {
  local path relative commit remainder

  require_runtime_directory "$install_root/bin"
  require_runtime_directory "$install_root/lib"
  require_runtime_directory "$install_root/policies"
  require_runtime_directory "$install_root/overlay"
  require_runtime_directory "$install_root/prerequisite-lock"
  require_runtime_directory "$install_root/prerequisite-lock/npm"
  require_runtime_file "$installed_launcher"
  require_runtime_file "$install_root/lib/fmx-worker"
  require_runtime_file "$install_root/lib/fmx-overlay.py"
  require_runtime_file "$install_root/lib/fmx-prerequisites"
  require_runtime_file "$install_root/lib/native-claude"
  require_runtime_file "$install_root/lib/trellage-session-bridge.py"
  require_runtime_file "$installed_catalog"
  require_runtime_file "$install_root/prerequisite-lock/manifest.json"
  require_runtime_file "$install_root/prerequisite-lock/npm/package.json"
  require_runtime_file "$install_root/prerequisite-lock/npm/package-lock.json"

  if [[ -e "$install_root/prerequisites" || -L "$install_root/prerequisites" ]]; then
    require_safe_directory "$install_root/prerequisites" \
      "$canonical_home/.local/share/trellage/fmx/prerequisites" \
      'managed prerequisite cache'
    ensure_prerequisite_cache_idle
  fi

  while IFS= read -r path; do
    case "$path" in
      "$ownership_marker"|\
      "$install_root/bin"|"$installed_launcher"|\
      "$install_root/lib"|\
      "$install_root/lib/fmx-worker"|\
      "$install_root/lib/fmx-overlay.py"|\
      "$install_root/lib/fmx-prerequisites"|\
      "$install_root/lib/native-claude"|\
      "$install_root/lib/trellage-session-bridge.py"|\
      "$installed_catalog"|\
      "$install_root/policies"|\
      "$install_root/overlay"|\
      "$install_root/prerequisite-lock"|\
      "$install_root/prerequisite-lock/manifest.json"|\
      "$install_root/prerequisite-lock/npm"|\
      "$install_root/prerequisite-lock/npm/package.json"|\
      "$install_root/prerequisite-lock/npm/package-lock.json"|\
      "$install_root/prerequisites")
        ;;
      "$install_root/policies/"*)
        relative="${path#"$install_root/policies/"}"
        [[ "$relative" != */* && "$relative" == *.md \
          && -f "$path" && ! -L "$path" ]] \
          || refuse "unsafe managed policy path: $path"
        ;;
      "$install_root/overlay/"*)
        relative="${path#"$install_root/overlay/"}"
        commit="${relative%%/*}"
        [[ "$commit" =~ ^[0-9a-f]{40}$ ]] \
          || refuse "unsafe managed overlay path: $path"
        if [[ "$relative" == "$commit" ]]; then
          [[ -d "$path" && ! -L "$path" ]] \
            || refuse "unsafe managed overlay path: $path"
        else
          remainder="${relative#*/}"
          [[ "$remainder" != */* && -f "$path" && ! -L "$path" ]] \
            || refuse "unsafe managed overlay path: $path"
        fi
        ;;
      "$install_root/prerequisites/"*)
        [[ -d "$path" || -f "$path" || -L "$path" ]] \
          || refuse "unsupported managed prerequisite path: $path"
        ;;
      *)
        refuse "unrelated runtime path: $path"
        ;;
    esac
  done < <(find "$install_root" -mindepth 1 -print)
}

stage_file() {
  local source="$1"
  local destination="$2"
  local mode="$3"

  require_regular_file "$source" 'package file'
  install -m "$mode" "$source" "$destination"
}

copy_prerequisite_cache() {
  local source="$install_root/prerequisites"
  local destination="$staging_root/new-runtime/prerequisites"
  local path name

  mkdir "$destination"
  chmod 0700 "$destination"
  while IFS= read -r path; do
    name="$(basename "$path")"
    if [[ "$name" =~ ^[0-9a-f]{64}$ ]]; then
      [[ -d "$path" && ! -L "$path" ]] \
        || refuse "unsafe managed prerequisite toolchain: $path"
      cp -a "$path" "$destination/$name"
      continue
    fi
    case "$name" in
      .stage.*|.retired.*)
        refuse "interrupted prerequisite installation requires recovery before fmx reinstall; run $install_root/lib/fmx-prerequisites install: $path"
        ;;
      *)
        refuse "unsupported managed prerequisite cache path: $path"
        ;;
    esac
  done < <(find "$source" -mindepth 1 -maxdepth 1 -print | sort)
}

inject_test_point() {
  local point="$1"
  local signal="${FMX_INSTALL_TEST_SIGNAL-TERM}"

  [[ "${FMX_INSTALL_TEST_FAIL_AT-}" != "$point" ]] \
    || refuse "injected failure at $point"
  if [[ "${FMX_INSTALL_TEST_SIGNAL_AT-}" == "$point" ]]; then
    case "$signal" in
      HUP|INT|TERM) kill "-$signal" "$$" ;;
      *) refuse "unsupported injected signal: $signal" ;;
    esac
  fi
  if [[ "${FMX_INSTALL_TEST_CRASH_AT-}" == "$point" ]]; then
    trap - EXIT HUP INT TERM
    exit 137
  fi
}

require_safe_directory "$local_dir" "$canonical_home/.local" 'runtime ancestor'
require_safe_directory "$share_dir" "$canonical_home/.local/share" 'runtime ancestor'
require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

require_regular_file "$source_dir/bin/fmx" 'launcher'
require_regular_file "$source_dir/lib/fmx-worker" 'worker helper'
require_regular_file "$source_dir/lib/fmx-overlay.py" 'overlay helper'
require_regular_file "$prerequisite_helper_source" 'prerequisite helper'
require_regular_file "$source_dir/catalog.json" 'catalog'
require_regular_file "$native_claude_source" 'shared native Claude helper'
require_regular_file "$session_bridge_source" 'session bridge'
require_regular_file "$floating_runtime_installer" 'floating-skills runtime installer'
[[ -x "$floating_runtime_installer" ]] \
  || refuse "floating-skills runtime installer is not executable: $floating_runtime_installer"
[[ -d "$source_dir/policies" && ! -L "$source_dir/policies" ]] \
  || refuse "missing or unsafe policy directory: $source_dir/policies"
[[ -d "$source_dir/overlay" && ! -L "$source_dir/overlay" ]] \
  || refuse "missing or unsafe overlay directory: $source_dir/overlay"
[[ -d "$prerequisite_lock_source" && ! -L "$prerequisite_lock_source" ]] \
  || refuse "missing or unsafe prerequisite lock: $prerequisite_lock_source"
[[ -d "$prerequisite_lock_source/npm" && ! -L "$prerequisite_lock_source/npm" ]] \
  || refuse "missing or unsafe prerequisite npm lock: $prerequisite_lock_source/npm"
require_regular_file "$prerequisite_lock_source/manifest.json" 'prerequisite manifest'
require_regular_file "$prerequisite_lock_source/npm/package.json" 'prerequisite package manifest'
require_regular_file "$prerequisite_lock_source/npm/package-lock.json" 'prerequisite package lock'

overlay_commits=()
while IFS= read -r overlay_path; do
  commit="$(basename "$overlay_path")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ && -d "$overlay_path" && ! -L "$overlay_path" ]] \
    || refuse "unsafe overlay directory: $overlay_path"
  overlay_commits+=("$commit")
done < <(find "$source_dir/overlay" -mindepth 1 -maxdepth 1 -print | sort)
[[ "${#overlay_commits[@]}" -gt 0 ]] || refuse 'no checked-in overlay was found'

while IFS= read -r path; do
  [[ -f "$path" && ! -L "$path" ]] \
    || refuse "unsupported policy package path: $path"
done < <(find "$source_dir/policies" -mindepth 1 -maxdepth 1 -print)
while IFS= read -r path; do
  [[ -f "$path" && ! -L "$path" ]] \
    || refuse "unsupported overlay package path: $path"
done < <(find "$source_dir/overlay" -mindepth 2 -maxdepth 2 -print)

staging_root=''
retired_staging_root=''
command_stage_root=''
publication_active=false
runtime_publish_intent=false
command_publish_intent=false
lock_acquired=false
created_local_dir=false
created_share_dir=false
created_runtime_parent=false
created_command_dir=false

cleanup_staging() {
  if [[ -n "$command_stage_root" && -d "$command_stage_root" ]]; then
    case "$command_stage_root" in
      "$command_dir"/.fmx-command.*) rm -rf -- "$command_stage_root" ;;
    esac
  fi
  if [[ -n "$staging_root" && -d "$staging_root" ]]; then
    case "$staging_root" in
      "$runtime_parent"/.fmx-install.*) rm -rf -- "$staging_root" ;;
    esac
  fi
  if [[ -n "$retired_staging_root" && -d "$retired_staging_root" ]]; then
    case "$retired_staging_root" in
      "$runtime_parent"/.fmx-retired-install.*) rm -rf -- "$retired_staging_root" ;;
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
      refuse "another fmx install is active with pid $pid"
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

  if [[ "$lock_acquired" == false ]]; then
    return 0
  fi
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

runtime_is_owned() {
  local root="$1"
  local marker="$root/.managed-by-trellage-firstmate-profiles"

  [[ -d "$root" && ! -L "$root" \
    && -f "$marker" && ! -L "$marker" \
    && "$(<"$marker")" == "$ownership_value" ]]
}

recover_interrupted_install() {
  local interrupted=()
  local interrupted_root=''
  local had_runtime=''
  local had_command=''
  local runtime_retired=false
  local path

  while IFS= read -r path; do
    [[ "$path" == "$install_lock" ]] || interrupted+=("$path")
  done < <(find "$runtime_parent" -mindepth 1 -maxdepth 1 -name '.fmx-install.*' -print | sort)
  [[ "${#interrupted[@]}" -le 1 ]] \
    || refuse "multiple interrupted fmx installs require manual recovery in: $runtime_parent"
  [[ "${#interrupted[@]}" -eq 1 ]] || return 0

  interrupted_root="${interrupted[0]}"
  [[ -d "$interrupted_root" && ! -L "$interrupted_root" \
    && -f "$interrupted_root/$transaction_marker_name" \
    && ! -L "$interrupted_root/$transaction_marker_name" \
    && "$(<"$interrupted_root/$transaction_marker_name")" == "$install_lock_owner" ]] \
    || refuse "unowned interrupted fmx install: $interrupted_root"
  [[ -f "$interrupted_root/had-runtime" && ! -L "$interrupted_root/had-runtime" ]] \
    || refuse "incomplete interrupted fmx install: $interrupted_root"
  [[ -f "$interrupted_root/had-command" && ! -L "$interrupted_root/had-command" ]] \
    || refuse "incomplete interrupted fmx install: $interrupted_root"
  had_runtime="$(<"$interrupted_root/had-runtime")"
  had_command="$(<"$interrupted_root/had-command")"
  case "$had_runtime:$had_command" in
    yes:yes|yes:no|no:yes|no:no) ;;
    *) refuse "invalid interrupted fmx install state: $interrupted_root" ;;
  esac

  if [[ -f "$interrupted_root/committed" && ! -L "$interrupted_root/committed" ]]; then
    runtime_is_owned "$install_root" \
      || refuse "committed fmx install has no owned runtime: $install_root"
    [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
      || refuse "committed fmx install has no owned command: $command_path"
    rm -rf -- "$interrupted_root"
    return 0
  fi

  if [[ -f "$interrupted_root/runtime-retired" \
    && ! -L "$interrupted_root/runtime-retired" ]]; then
    runtime_retired=true
  elif [[ -d "$interrupted_root/old-runtime" || ! -e "$install_root" ]]; then
    runtime_retired=true
  fi

  if [[ "$had_command" == yes ]]; then
    [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
      || refuse "interrupted fmx install cannot restore the prior command: $command_path"
  elif [[ -e "$command_path" || -L "$command_path" ]]; then
    [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]] \
      || refuse "interrupted fmx install found an unrelated command: $command_path"
  fi

  if [[ "$had_runtime" == yes ]]; then
    if [[ "$runtime_retired" == true ]]; then
      if runtime_is_owned "$interrupted_root/old-runtime"; then
        if [[ -e "$install_root" || -L "$install_root" ]]; then
          runtime_is_owned "$install_root" \
            || refuse "interrupted fmx install found an unrelated runtime: $install_root"
          [[ ! -e "$interrupted_root/interrupted-runtime" \
            && ! -L "$interrupted_root/interrupted-runtime" ]] \
            || refuse "interrupted fmx recovery is ambiguous: $interrupted_root"
          mv "$install_root" "$interrupted_root/interrupted-runtime"
        fi
        mv "$interrupted_root/old-runtime" "$install_root"
      else
        runtime_is_owned "$install_root" \
          || refuse "interrupted fmx install cannot restore its prior runtime: $interrupted_root"
      fi
    else
      runtime_is_owned "$install_root" \
        || refuse "interrupted fmx install lost its prior runtime: $install_root"
    fi
  elif [[ -e "$install_root" || -L "$install_root" ]]; then
    runtime_is_owned "$install_root" \
      || refuse "interrupted fmx install found an unrelated runtime: $install_root"
    mv "$install_root" "$interrupted_root/interrupted-runtime"
  fi

  if [[ "$had_command" == no && ( -e "$command_path" || -L "$command_path" ) ]]; then
    rm -- "$command_path"
  fi
  rm -rf -- "$interrupted_root"
}

cleanup_abandoned_install_artifacts() {
  local path

  while IFS= read -r path; do
    [[ -d "$path" && ! -L "$path" ]] \
      || refuse "unsafe retired fmx install artifact: $path"
    rm -rf -- "$path"
  done < <(find "$runtime_parent" -mindepth 1 -maxdepth 1 \
    -name '.fmx-retired-install.*' -print)
  while IFS= read -r path; do
    [[ -d "$path" && ! -L "$path" ]] \
      || refuse "unsafe fmx command staging artifact: $path"
    rm -rf -- "$path"
  done < <(find "$command_dir" -mindepth 1 -maxdepth 1 \
    -name '.fmx-command.*' -print)
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

rollback() {
  local ok=true

  if [[ "$command_publish_intent" == true ]]; then
    if [[ -L "$command_path" && "$(readlink "$command_path")" == "$installed_launcher" ]]; then
      rm -- "$command_path" || ok=false
    elif [[ -e "$command_path" || -L "$command_path" ]]; then
      ok=false
    fi
  fi

  if [[ "$runtime_publish_intent" == true \
    && ! -d "$staging_root/new-runtime" ]]; then
    if [[ -d "$install_root" && ! -L "$install_root" \
      && -f "$ownership_marker" && ! -L "$ownership_marker" \
      && "$(<"$ownership_marker")" == "$ownership_value" ]]; then
      rm -rf -- "$install_root" || ok=false
    else
      ok=false
    fi
  fi

  if [[ -d "$staging_root/old-runtime" ]]; then
    if [[ ! -e "$install_root" && ! -L "$install_root" ]]; then
      mv "$staging_root/old-runtime" "$install_root" || ok=false
    else
      ok=false
    fi
  fi

  [[ "$ok" == true ]]
}

on_exit() {
  local status=$?
  local rollback_ok=true

  trap - EXIT HUP INT TERM
  if [[ "$publication_active" == true ]]; then
    if rollback; then
      cleanup_staging
    else
      rollback_ok=false
      printf 'fmx install: rollback failed; recovery may be required\n' >&2
    fi
  else
    cleanup_staging
  fi
  if [[ "$rollback_ok" == true ]]; then
    if ! release_install_lock; then
      printf 'fmx install: could not release install lock: %s\n' "$install_lock" >&2
      if [[ "$status" -eq 0 ]]; then
        status=1
      fi
    fi
  else
    status=1
  fi
  if [[ "$status" -ne 0 && "$rollback_ok" == true ]]; then
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

acquire_install_lock
recover_interrupted_install
cleanup_abandoned_install_artifacts
inject_test_point after-recovery
if active_fmx_fleet_or_mutation >/dev/null; then
  refuse 'cannot install fmx while a Firstmate fleet or profile mutation is active or indeterminate'
fi

require_safe_directory "$runtime_parent" "$canonical_home/.local/share/trellage" 'runtime parent'
require_safe_directory "$install_root" "$canonical_home/.local/share/trellage/fmx" 'runtime root'
require_safe_directory "$command_dir" "$canonical_home/.local/bin" 'command directory'

runtime_owned=false
if [[ -e "$install_root" || -L "$install_root" ]]; then
  [[ -f "$ownership_marker" && ! -L "$ownership_marker" ]] \
    || refuse "unowned runtime root: $install_root"
  [[ "$(<"$ownership_marker")" == "$ownership_value" ]] \
    || refuse "unowned runtime root: $install_root"
  require_owned_runtime_contents
  runtime_owned=true
fi

if [[ -e "$command_path" || -L "$command_path" ]]; then
  [[ -L "$command_path" ]] || refuse "unrelated command: $command_path"
  [[ "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
fi

staging_root="$(mktemp -d "$runtime_parent/.fmx-install.XXXXXX")" \
  || refuse "cannot stage fmx runtime in: $runtime_parent"
chmod 0700 "$staging_root"
printf '%s\n' "$install_lock_owner" >"$staging_root/$transaction_marker_name"
if [[ "$runtime_owned" == true ]]; then
  printf 'yes\n' >"$staging_root/had-runtime"
else
  printf 'no\n' >"$staging_root/had-runtime"
fi
if [[ -L "$command_path" ]]; then
  printf 'yes\n' >"$staging_root/had-command"
else
  printf 'no\n' >"$staging_root/had-command"
fi
chmod 0600 \
  "$staging_root/$transaction_marker_name" \
  "$staging_root/had-runtime" \
  "$staging_root/had-command"
mkdir -p \
  "$staging_root/new-runtime/bin" \
  "$staging_root/new-runtime/lib" \
  "$staging_root/new-runtime/policies" \
  "$staging_root/new-runtime/overlay" \
  "$staging_root/new-runtime/prerequisite-lock/npm"
chmod 0755 \
  "$staging_root/new-runtime" \
  "$staging_root/new-runtime/bin" \
  "$staging_root/new-runtime/lib" \
  "$staging_root/new-runtime/policies" \
  "$staging_root/new-runtime/overlay" \
  "$staging_root/new-runtime/prerequisite-lock" \
  "$staging_root/new-runtime/prerequisite-lock/npm"

stage_file "$source_dir/bin/fmx" "$staging_root/new-runtime/bin/fmx" 0755
stage_file "$source_dir/lib/fmx-worker" "$staging_root/new-runtime/lib/fmx-worker" 0755
stage_file "$source_dir/lib/fmx-overlay.py" "$staging_root/new-runtime/lib/fmx-overlay.py" 0755
stage_file "$prerequisite_helper_source" "$staging_root/new-runtime/lib/fmx-prerequisites" 0755
stage_file "$native_claude_source" "$staging_root/new-runtime/lib/native-claude" 0755
stage_file "$session_bridge_source" \
  "$staging_root/new-runtime/lib/trellage-session-bridge.py" 0755
stage_file "$source_dir/catalog.json" "$staging_root/new-runtime/catalog.json" 0644
stage_file "$prerequisite_lock_source/manifest.json" \
  "$staging_root/new-runtime/prerequisite-lock/manifest.json" 0644
stage_file "$prerequisite_lock_source/npm/package.json" \
  "$staging_root/new-runtime/prerequisite-lock/npm/package.json" 0644
stage_file "$prerequisite_lock_source/npm/package-lock.json" \
  "$staging_root/new-runtime/prerequisite-lock/npm/package-lock.json" 0644

while IFS= read -r policy; do
  stage_file "$policy" "$staging_root/new-runtime/policies/$(basename "$policy")" 0644
done < <(find "$source_dir/policies" -mindepth 1 -maxdepth 1 -type f -name '*.md' | sort)

for commit in "${overlay_commits[@]}"; do
  mkdir "$staging_root/new-runtime/overlay/$commit"
  chmod 0755 "$staging_root/new-runtime/overlay/$commit"
  while IFS= read -r overlay_file; do
    stage_file "$overlay_file" \
      "$staging_root/new-runtime/overlay/$commit/$(basename "$overlay_file")" 0644
  done < <(find "$source_dir/overlay/$commit" -mindepth 1 -maxdepth 1 -type f | sort)
done

if [[ "$runtime_owned" == true \
  && ( -e "$install_root/prerequisites" || -L "$install_root/prerequisites" ) ]]; then
  ensure_prerequisite_cache_idle
  copy_prerequisite_cache
fi

printf '%s\n' "$ownership_value" \
  >"$staging_root/new-runtime/.managed-by-trellage-firstmate-profiles"
chmod 0600 "$staging_root/new-runtime/.managed-by-trellage-firstmate-profiles"

[[ -z "$(
  find "$staging_root/new-runtime" \
    -path "$staging_root/new-runtime/prerequisites" -prune -o \
    -type l -print -quit
)" ]] || refuse 'staged fmx runtime contains an unexpected symlink'
inject_test_point after-runtime-staging

publication_active=true
if [[ "$runtime_owned" == true ]]; then
  mv "$install_root" "$staging_root/old-runtime"
  printf 'retired\n' >"$staging_root/runtime-retired"
  chmod 0600 "$staging_root/runtime-retired"
fi
inject_test_point during-runtime-publication
runtime_publish_intent=true
[[ ! -e "$install_root" && ! -L "$install_root" ]] \
  || refuse "fmx runtime changed during publication: $install_root"
mv "$staging_root/new-runtime" "$install_root"
inject_test_point after-runtime-publication

"$floating_runtime_installer"
inject_test_point after-shared-runtime-installation

if [[ ! -L "$command_path" ]]; then
  [[ ! -e "$command_path" ]] || refuse "unrelated command: $command_path"
  command_stage_root="$(mktemp -d "$command_dir/.fmx-command.XXXXXX")" \
    || refuse "cannot stage fmx command in: $command_dir"
  chmod 0700 "$command_stage_root"
  ln -s "$installed_launcher" "$command_stage_root/fmx"
  command_publish_intent=true
  mv "$command_stage_root/fmx" "$command_path"
  rmdir "$command_stage_root"
  command_stage_root=''
else
  [[ "$(readlink "$command_path")" == "$installed_launcher" ]] \
    || refuse "unrelated command: $command_path"
fi
inject_test_point after-command-publication

printf 'committed\n' >"$staging_root/committed"
chmod 0600 "$staging_root/committed"
publication_active=false
retired_staging_root="$runtime_parent/.fmx-retired-install.${staging_root##*.}"
[[ ! -e "$retired_staging_root" && ! -L "$retired_staging_root" ]] \
  || refuse "unsafe retired transaction path: $retired_staging_root"
mv "$staging_root" "$retired_staging_root"
staging_root=''
release_install_lock \
  || refuse "could not release install lock: $install_lock"
cleanup_staging
printf 'Installed fmx at %s\n' "$command_path"
