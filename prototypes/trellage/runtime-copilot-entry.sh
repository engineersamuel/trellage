#!/usr/bin/env bash
set +x
set -euo pipefail
ulimit -c 0 2>/dev/null || true

unset inherited_copilot_github_token
inherited_copilot_github_token="${COPILOT_GITHUB_TOKEN-}"
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN

fail() {
  printf 'trellage-copilot-entry: %s\n' "$1" >&2
  exit "${2:-1}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required for managed Copilot state"
}

require_regular_file() {
  local candidate="$1"
  local label="$2"
  [[ -f "$candidate" && ! -L "$candidate" ]] \
    || fail "$label must be a regular file: $candidate"
}

path_identity() {
  stat -c '%d:%i:%f:%h' -- "$1"
}

directory_identity() {
  stat -c '%d:%i:%f' -- "$1"
}

directory_is_exact() {
  local candidate="$1"
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(realpath -e -- "$candidate")" == "$candidate" ]] || return 1
}

managed_ancestor_chain_is_safe() {
  local root="$1"
  local relative
  directory_is_exact "$root" || return 1
  for relative in \
    installed-plugins \
    installed-plugins/hve-core \
    installed-plugins/hve-core/hve-core; do
    directory_is_exact "$root/$relative" || return 1
  done
}

runtime_root_is_unchanged() {
  directory_is_exact "$runtime_home" || return 1
  [[ "$(directory_identity "$runtime_home")" == "$runtime_home_identity" ]]
}

plugin_parents_identity() {
  printf '%s|%s\n' \
    "$(directory_identity "$runtime_home/installed-plugins")" \
    "$(directory_identity "$runtime_home/installed-plugins/hve-core")"
}

plugin_parents_are_unchanged() {
  local expected="$1"
  directory_is_exact "$runtime_home/installed-plugins" || return 1
  directory_is_exact "$runtime_home/installed-plugins/hve-core" || return 1
  [[ "$(plugin_parents_identity)" == "$expected" ]]
}

atomic_renameat2() {
  local operation="$1"
  local source="$2"
  local destination="$3"
  python3 - "$operation" "$source" "$destination" <<'PY'
import ctypes
import os
import sys

AT_FDCWD = -100
FLAGS = {"exchange": 2, "noreplace": 1}

operation, source, destination = sys.argv[1:]
try:
    flags = FLAGS[operation]
except KeyError:
    raise SystemExit(f"unsupported renameat2 operation: {operation}")

libc = ctypes.CDLL(None, use_errno=True)
try:
    renameat2 = libc.renameat2
except AttributeError:
    raise SystemExit("libc does not expose renameat2")
renameat2.argtypes = (
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_int,
    ctypes.c_char_p,
    ctypes.c_uint,
)
renameat2.restype = ctypes.c_int
result = renameat2(
    AT_FDCWD,
    os.fsencode(source),
    AT_FDCWD,
    os.fsencode(destination),
    flags,
)
if result != 0:
    error_number = ctypes.get_errno()
    raise OSError(error_number, os.strerror(error_number), destination)
PY
}

acquire_runtime_lock() {
  local lock_path="$runtime_home/.trellage-copilot-sync.lock"
  local expected_identity descriptor_identity
  runtime_root_is_unchanged \
    || fail 'Copilot runtime home changed before lock acquisition'
  if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
    if ! (set -o noclobber; : >"$lock_path") 2>/dev/null; then
      [[ -e "$lock_path" || -L "$lock_path" ]] \
        || fail 'cannot create the Copilot managed-state lock'
    fi
  fi
  [[ -f "$lock_path" && ! -L "$lock_path" \
    && "$(stat -c '%h' -- "$lock_path")" -eq 1 ]] \
    || fail 'Copilot managed-state lock must be a single-link regular file'
  expected_identity="$(path_identity "$lock_path")"
  exec 9<>"$lock_path" \
    || fail 'cannot open the Copilot managed-state lock'
  descriptor_identity="$(stat -Lc '%d:%i:%f:%h' /proc/self/fd/9)"
  [[ "$descriptor_identity" == "$expected_identity" ]] \
    || fail 'Copilot managed-state lock changed while opening it'
  "$flock_command" -x 9 \
    || fail 'cannot acquire the Copilot managed-state lock'
  runtime_root_is_unchanged \
    || fail 'Copilot runtime home changed while acquiring its lock'
  [[ -f "$lock_path" && ! -L "$lock_path" \
    && "$(path_identity "$lock_path")" == "$expected_identity" \
    && "$(stat -Lc '%d:%i:%f:%h' /proc/self/fd/9)" == "$expected_identity" ]] \
    || fail 'Copilot managed-state lock changed after acquisition'
}

release_runtime_lock() {
  "$flock_command" -u 9 \
    || fail 'cannot release the Copilot managed-state lock'
  exec 9>&-
}

validate_seed_home() {
  [[ "$seed_home" == /* ]] || fail 'TRELLAGE_COPILOT_SEED_HOME must be an absolute path'
  [[ "$seed_home" != *'//'* && "$seed_home" != *'/./'* \
    && "$seed_home" != *'/../'* && "$seed_home" != */. \
    && "$seed_home" != */.. ]] \
    || fail 'TRELLAGE_COPILOT_SEED_HOME must be canonical'
  case "$seed_home" in
    /usr/local/share/trellage/*) ;;
    *) fail 'TRELLAGE_COPILOT_SEED_HOME must be under /usr/local/share/trellage' ;;
  esac
  [[ -d "$seed_home" && ! -L "$seed_home" ]] \
    || fail "missing baked Copilot seed: $seed_home"
  [[ "$(realpath -e -- "$seed_home")" == "$seed_home" ]] \
    || fail 'TRELLAGE_COPILOT_SEED_HOME must be canonical and must not traverse symlinks'
}

validate_runtime_home() {
  [[ "$runtime_home" == /* ]] || fail 'TRELLAGE_COPILOT_HOME must be an absolute path'
  [[ "$runtime_home" != *'//'* && "$runtime_home" != *'/./'* \
    && "$runtime_home" != *'/../'* && "$runtime_home" != */. \
    && "$runtime_home" != */.. ]] \
    || fail 'TRELLAGE_COPILOT_HOME must be canonical'
  case "$runtime_home" in
    /home/agent/*) ;;
    *) fail 'TRELLAGE_COPILOT_HOME must be under /home/agent' ;;
  esac
  [[ "$(realpath -m -- "$runtime_home")" == "$runtime_home" ]] \
    || fail 'TRELLAGE_COPILOT_HOME must not traverse symlinks'
  if [[ -e "$runtime_home" || -L "$runtime_home" ]]; then
    [[ -d "$runtime_home" && ! -L "$runtime_home" ]] \
      || fail "Copilot runtime home must be a directory: $runtime_home"
  else
    mkdir -p -- "$runtime_home" \
      || fail "cannot create Copilot runtime home: $runtime_home"
  fi
  [[ "$(realpath -e -- "$runtime_home")" == "$runtime_home" ]] \
    || fail 'Copilot runtime home escaped /home/agent'
}

validate_managed_path() {
  local managed_path="$1"
  [[ -n "$managed_path" && "$managed_path" != /* \
    && "$managed_path" != *'//'* \
    && "$managed_path" != . && "$managed_path" != .. \
    && "$managed_path" != ./* && "$managed_path" != ../* \
    && "$managed_path" != */. && "$managed_path" != */.. \
    && "$managed_path" != *'/./'* && "$managed_path" != *'/../'* \
    && "$managed_path" != *'\'* ]] \
    || fail "unsafe managed seed path: $managed_path"
  case "$managed_path" in
    managed-lock.json|managed-settings.json|installed-plugins/hve-core/hve-core/*) ;;
    *) fail "unexpected managed seed path: $managed_path" ;;
  esac
}

actual_managed_files() {
  local root="$1"
  (
    cd "$root"
    find installed-plugins/hve-core/hve-core -type f -print
    printf '%s\n' managed-lock.json managed-settings.json
  ) | LC_ALL=C sort
}

verify_managed_tree() {
  local root="$1"
  local files="$root/managed-files.txt"
  local hashes="$root/managed.sha256"
  local plugin="$root/installed-plugins/hve-core/hve-core"
  local managed_path

  managed_ancestor_chain_is_safe "$root" || return 1
  [[ -d "$plugin" && ! -L "$plugin" ]] || return 1
  [[ -f "$files" && ! -L "$files" && -f "$hashes" && ! -L "$hashes" ]] \
    || return 1
  [[ -z "$(find "$plugin" -type l -print -quit)" ]] || return 1
  [[ -z "$(find "$plugin" -mindepth 1 ! -type d ! -type f -print -quit)" ]] \
    || return 1
  while IFS= read -r managed_path; do
    validate_managed_path "$managed_path"
    [[ -f "$root/$managed_path" && ! -L "$root/$managed_path" ]] || return 1
  done <"$files"
  cmp -s "$files" <(LC_ALL=C sort -u "$files") || return 1
  cmp -s "$files" <(actual_managed_files "$root") || return 1
  grep -Eq '^[0-9a-f]{64}  .+$' "$hashes" || return 1
  if grep -Evq '^[0-9a-f]{64}  .+$' "$hashes"; then
    return 1
  fi
  cmp -s "$files" <(cut -c67- "$hashes") || return 1
  (cd "$root" && sha256sum --check --strict --status managed.sha256) || return 1
}

verify_seed() {
  local control_file
  for control_file in managed-files.txt managed.sha256 managed-lock.json managed-settings.json; do
    require_regular_file "$seed_home/$control_file" "baked $control_file"
  done
  verify_managed_tree "$seed_home" \
    || fail 'baked Copilot managed-state manifest is invalid'
  jq -e '
    type == "object"
    and (keys | sort) == ["enabledPlugins", "extraKnownMarketplaces"]
    and .extraKnownMarketplaces
      == {"hve-core":{"source":{"source":"github","repo":"microsoft/hve-core"}}}
    and .enabledPlugins == {"hve-core@hve-core":true}
  ' "$seed_home/managed-settings.json" >/dev/null \
    || fail 'baked Copilot managed settings are invalid'
}

runtime_settings_are_current() {
  local settings="$runtime_home/settings.json"
  [[ -f "$settings" && ! -L "$settings" ]] || return 1
  jq -e '
    type == "object"
    and .extraKnownMarketplaces["hve-core"].source
      == {"source":"github","repo":"microsoft/hve-core"}
    and .enabledPlugins["hve-core@hve-core"] == true
  ' "$settings" >/dev/null 2>&1
}

current_state_is_valid() {
  local control_file
  local runtime_marketplace="$runtime_home/installed-plugins/hve-core"
  [[ ! -e "$runtime_marketplace/.hve-core.trellage-stage" \
    && ! -L "$runtime_marketplace/.hve-core.trellage-stage" \
    && ! -e "$runtime_marketplace/.hve-core.trellage-backup" \
    && ! -L "$runtime_marketplace/.hve-core.trellage-backup" ]] \
    || return 1
  for control_file in managed-files.txt managed.sha256 managed-lock.json managed-settings.json; do
    [[ -f "$runtime_home/$control_file" && ! -L "$runtime_home/$control_file" ]] \
      || return 1
    cmp -s "$seed_home/$control_file" "$runtime_home/$control_file" || return 1
  done
  verify_managed_tree "$runtime_home" || return 1
  runtime_settings_are_current || return 1
}

verify_plugin_copy() {
  local candidate="$1"
  local plugin_prefix='installed-plugins/hve-core/hve-core/'
  local expected_files actual_files manifest_line expected_hash managed_path relative_path
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ -z "$(find "$candidate" -type l -print -quit)" ]] || return 1
  [[ -z "$(find "$candidate" -mindepth 1 ! -type d ! -type f -print -quit)" ]] \
    || return 1
  expected_files="$(sed -n "s#^$plugin_prefix##p" "$seed_home/managed-files.txt")"
  actual_files="$(find "$candidate" -type f -printf '%P\n' | LC_ALL=C sort)"
  [[ "$actual_files" == "$expected_files" ]] || return 1
  while IFS= read -r manifest_line; do
    expected_hash="${manifest_line%%  *}"
    managed_path="${manifest_line#*  }"
    case "$managed_path" in
      "$plugin_prefix"*)
        relative_path="${managed_path#"$plugin_prefix"}"
        [[ "$(sha256sum "$candidate/$relative_path" | cut -d ' ' -f 1)" == "$expected_hash" ]] \
          || return 1
        ;;
    esac
  done <"$seed_home/managed.sha256"
}

merge_managed_settings() {
  local settings="$runtime_home/settings.json"
  local temporary settings_existed=0 settings_identity= settings_mode=600
  runtime_root_is_unchanged \
    || fail 'Copilot runtime home changed before settings repair'
  if [[ -e "$settings" || -L "$settings" ]]; then
    [[ -f "$settings" && ! -L "$settings" ]] \
      || fail "Copilot settings must be a regular file: $settings"
    settings_existed=1
    settings_identity="$(path_identity "$settings")"
    settings_mode="$(stat -c '%a' -- "$settings")"
  fi
  temporary="$(mktemp "$runtime_home/.settings.json.trellage.XXXXXX")"
  managed_temporary="$temporary"
  if ! {
    if [[ "$settings_existed" -eq 1 ]]; then
      cat -- "$settings"
    else
      printf '{}\n'
    fi
  } | jq --slurpfile managed "$seed_home/managed-settings.json" '
    if type != "object" then error("settings root must be an object")
    elif ((.extraKnownMarketplaces // {}) | type) != "object" then
      error("extraKnownMarketplaces must be an object")
    elif ((.enabledPlugins // {}) | type) != "object" then
      error("enabledPlugins must be an object")
    else
      .extraKnownMarketplaces = (
        (.extraKnownMarketplaces // {})
        + {"hve-core": $managed[0].extraKnownMarketplaces["hve-core"]}
      )
      | .enabledPlugins = (
        (.enabledPlugins // {})
        + {"hve-core@hve-core": $managed[0].enabledPlugins["hve-core@hve-core"]}
      )
    end
  ' >"$temporary"; then
    discard_managed_temporary \
      || fail 'cannot remove the failed managed settings temporary file'
    fail 'cannot merge managed HVE settings into Copilot settings'
  fi
  chmod "$settings_mode" "$temporary"
  if ! runtime_root_is_unchanged; then
    discard_managed_temporary \
      || fail 'cannot remove the unsafe managed settings temporary file'
    fail 'Copilot runtime home changed while staging settings repair'
  fi
  if [[ "$settings_existed" -eq 1 ]]; then
    if [[ ! -f "$settings" || -L "$settings" \
      || "$(path_identity "$settings")" != "$settings_identity" ]]; then
      discard_managed_temporary \
        || fail 'cannot remove the stale managed settings temporary file'
      fail 'Copilot settings changed while staging managed repair'
    fi
  else
    if [[ -e "$settings" || -L "$settings" ]]; then
      discard_managed_temporary \
        || fail 'cannot remove the conflicting managed settings temporary file'
      fail 'Copilot settings appeared while staging managed repair'
    fi
  fi
  if ! mv -fT -- "$temporary" "$settings"; then
    discard_managed_temporary \
      || fail 'cannot remove the unpublished managed settings temporary file'
    fail 'cannot publish managed Copilot settings'
  fi
  managed_temporary=
}

atomic_copy_control() {
  local name="$1"
  local destination="$runtime_home/$name"
  local temporary destination_existed=0 destination_identity=
  runtime_root_is_unchanged \
    || fail "Copilot runtime home changed before publishing $name"
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] \
      || fail "managed Copilot control destination must be a regular file: $destination"
    destination_existed=1
    destination_identity="$(path_identity "$destination")"
  fi
  temporary="$(mktemp "$runtime_home/.$name.trellage.XXXXXX")"
  managed_temporary="$temporary"
  if ! cp -- "$seed_home/$name" "$temporary"; then
    discard_managed_temporary \
      || fail "cannot remove the failed managed control temporary file: $name"
    fail "cannot stage managed Copilot control file: $name"
  fi
  chmod 600 "$temporary"
  if ! runtime_root_is_unchanged; then
    discard_managed_temporary \
      || fail "cannot remove the unsafe managed control temporary file: $name"
    fail "Copilot runtime home changed while staging $name"
  fi
  if [[ "$destination_existed" -eq 1 ]]; then
    if [[ ! -f "$destination" || -L "$destination" \
      || "$(path_identity "$destination")" != "$destination_identity" ]]; then
      discard_managed_temporary \
        || fail "cannot remove the stale managed control temporary file: $name"
      fail "managed Copilot control destination changed while staging: $name"
    fi
  else
    if [[ -e "$destination" || -L "$destination" ]]; then
      discard_managed_temporary \
        || fail "cannot remove the conflicting managed control temporary file: $name"
      fail "managed Copilot control destination appeared while staging: $name"
    fi
  fi
  if ! mv -fT -- "$temporary" "$destination"; then
    discard_managed_temporary \
      || fail "cannot remove the unpublished managed control temporary file: $name"
    fail "cannot publish managed Copilot control file: $name"
  fi
  managed_temporary=
}

# Boundary: flock serializes cooperating entrypoint processes. Bash does not
# expose openat2(RESOLVE_BENEATH) or renameat2(RENAME_EXCHANGE), so a hostile
# process with the same UID and write access to COPILOT_HOME can still race a
# pathname operation. We capture inode/type identities, revalidate immediately
# before each mutation, and fail closed when a change is detected. COPILOT_HOME
# must not be shared with a hostile same-UID writer.
transaction_active=0
transaction_stage=
transaction_backup=
transaction_target=
transaction_parent_identity=
managed_temporary=

reserved_managed_temp_name_is_valid() {
  local name="$1"
  [[ "$name" =~ ^\.(settings\.json|managed-lock\.json|managed-settings\.json|managed-files\.txt|managed\.sha256)\.trellage\.[A-Za-z0-9]{6}$ ]]
}

remove_reserved_managed_temp() {
  local candidate="$1"
  local name="${candidate##*/}"
  [[ "${candidate%/*}" == "$runtime_home" ]] || return 1
  reserved_managed_temp_name_is_valid "$name" || return 1
  if [[ -L "$candidate" || -f "$candidate" ]]; then
    rm -f -- "$candidate"
    return
  fi
  [[ ! -e "$candidate" ]]
}

discard_managed_temporary() {
  local candidate="$managed_temporary"
  [[ -n "$candidate" ]] || return 0
  remove_reserved_managed_temp "$candidate" || return 1
  managed_temporary=
}

sweep_reserved_managed_temps() {
  local prefix candidate
  runtime_root_is_unchanged \
    || fail 'Copilot runtime home changed before temporary-file recovery'
  for prefix in \
    settings.json \
    managed-lock.json \
    managed-settings.json \
    managed-files.txt \
    managed.sha256; do
    for candidate in "$runtime_home/.$prefix.trellage."??????; do
      [[ -e "$candidate" || -L "$candidate" ]] || continue
      remove_reserved_managed_temp "$candidate" \
        || fail "unsafe managed temporary-file recovery candidate: $candidate"
    done
  done
  runtime_root_is_unchanged \
    || fail 'Copilot runtime home changed during temporary-file recovery'
}

remove_reserved_transaction_path() {
  local candidate="$1"
  case "$candidate" in
    "$transaction_stage"|"$transaction_backup") ;;
    *) fail "refusing to remove an unknown transaction path: $candidate" ;;
  esac
  if [[ -L "$candidate" || -f "$candidate" ]]; then
    rm -f -- "$candidate"
    return
  fi
  if [[ -d "$candidate" ]]; then
    [[ "$(realpath -e -- "$candidate")" == "$candidate" ]] \
      || fail "transaction directory escaped its parent: $candidate"
    rm -rf -- "$candidate"
    return
  fi
  [[ ! -e "$candidate" ]] \
    || fail "unsupported transaction path type: $candidate"
}

recover_plugin_transaction() {
  plugin_parents_are_unchanged "$transaction_parent_identity" \
    || fail 'managed plugin parents changed before transaction recovery'
  if [[ -e "$transaction_backup" || -L "$transaction_backup" ]]; then
    [[ -d "$transaction_backup" || -f "$transaction_backup" \
      || -L "$transaction_backup" ]] \
      || fail 'managed plugin transaction backup has an unsafe type'
    if [[ ! -e "$transaction_target" && ! -L "$transaction_target" ]]; then
      mv -fT -- "$transaction_backup" "$transaction_target" \
        || fail 'cannot restore the managed plugin transaction backup'
    else
      remove_reserved_transaction_path "$transaction_backup"
    fi
  fi
  if [[ -e "$transaction_stage" || -L "$transaction_stage" ]]; then
    [[ -d "$transaction_stage" && ! -L "$transaction_stage" ]] \
      || fail 'managed plugin transaction stage has an unsafe type'
    remove_reserved_transaction_path "$transaction_stage"
  fi
  plugin_parents_are_unchanged "$transaction_parent_identity" \
    || fail 'managed plugin parents changed during transaction recovery'
}

cleanup_active_transaction() {
  [[ "$transaction_active" -eq 1 ]] || return 0
  if ! plugin_parents_are_unchanged "$transaction_parent_identity"; then
    return 1
  fi
  if [[ ! -e "$transaction_target" && ! -L "$transaction_target" \
    && ( -e "$transaction_backup" || -L "$transaction_backup" ) ]]; then
    mv -fT -- "$transaction_backup" "$transaction_target" || return 1
  elif [[ ( -e "$transaction_target" || -L "$transaction_target" ) \
    && ( -e "$transaction_backup" || -L "$transaction_backup" ) ]]; then
    remove_reserved_transaction_path "$transaction_backup" || return 1
  fi
  if [[ -e "$transaction_stage" || -L "$transaction_stage" ]]; then
    remove_reserved_transaction_path "$transaction_stage" || return 1
  fi
  transaction_active=0
}

on_exit() {
  local original_status=$?
  local cleanup_failed=0
  trap - EXIT TERM INT HUP
  if ! discard_managed_temporary; then
    printf 'trellage-copilot-entry: managed temporary-file cleanup failed\n' >&2
    cleanup_failed=1
  fi
  if ! cleanup_active_transaction; then
    printf 'trellage-copilot-entry: managed plugin transaction cleanup failed\n' >&2
    cleanup_failed=1
  fi
  if [[ "$cleanup_failed" -eq 1 && "$original_status" -eq 0 ]]; then
    original_status=74
  fi
  exit "$original_status"
}

trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

sync_managed_state() {
  local seed_plugin="$seed_home/installed-plugins/hve-core/hve-core"
  local runtime_plugins="$runtime_home/installed-plugins"
  local runtime_marketplace="$runtime_home/installed-plugins/hve-core"
  local runtime_plugin="$runtime_marketplace/hve-core"
  local destination_existed=0 destination_identity= stage_identity=

  if [[ -e "$runtime_plugins" || -L "$runtime_plugins" ]]; then
    [[ -d "$runtime_plugins" && ! -L "$runtime_plugins" ]] \
      || fail 'Copilot installed-plugins path must be a directory without symlinks'
  else
    mkdir -- "$runtime_plugins"
  fi
  [[ "$(realpath -e -- "$runtime_plugins")" == "$runtime_plugins" ]] \
    || fail 'Copilot installed-plugins path escaped the runtime home'
  if [[ -e "$runtime_marketplace" || -L "$runtime_marketplace" ]]; then
    [[ -d "$runtime_marketplace" && ! -L "$runtime_marketplace" ]] \
      || fail 'Copilot managed marketplace must be a directory without symlinks'
  else
    mkdir -- "$runtime_marketplace"
  fi
  [[ "$(realpath -e -- "$runtime_marketplace")" == "$runtime_marketplace" ]] \
    || fail 'Copilot managed plugin parent escaped the runtime home'

  transaction_stage="$runtime_marketplace/.hve-core.trellage-stage"
  transaction_backup="$runtime_marketplace/.hve-core.trellage-backup"
  transaction_target="$runtime_plugin"
  transaction_parent_identity="$(plugin_parents_identity)"
  if [[ -e "$runtime_plugin" || -L "$runtime_plugin" ]]; then
    [[ -d "$runtime_plugin" || -f "$runtime_plugin" || -L "$runtime_plugin" ]] \
      || fail 'managed plugin target has an unsupported file type'
  fi
  recover_plugin_transaction
  if [[ -e "$runtime_plugin" || -L "$runtime_plugin" ]]; then
    [[ -d "$runtime_plugin" || -f "$runtime_plugin" || -L "$runtime_plugin" ]] \
      || fail 'recovered managed plugin target has an unsupported file type'
  fi
  mkdir -- "$transaction_stage" \
    || fail 'cannot create the runtime HVE plugin transaction stage'
  transaction_active=1
  if ! cp -R -- "$seed_plugin/." "$transaction_stage/"; then
    remove_reserved_transaction_path "$transaction_stage"
    transaction_active=0
    fail 'cannot copy the baked HVE plugin into runtime staging'
  fi
  if ! verify_plugin_copy "$transaction_stage"; then
    remove_reserved_transaction_path "$transaction_stage"
    transaction_active=0
    fail 'runtime HVE plugin staging verification failed'
  fi

  if [[ -e "$runtime_plugin" || -L "$runtime_plugin" ]]; then
    destination_existed=1
    destination_identity="$(path_identity "$runtime_plugin")"
  fi
  stage_identity="$(path_identity "$transaction_stage")"
  plugin_parents_are_unchanged "$transaction_parent_identity" \
    || fail 'managed plugin parents changed while staging the plugin'
  [[ ! -e "$transaction_backup" && ! -L "$transaction_backup" ]] \
    || fail 'managed plugin transaction backup reappeared while staging'
  if [[ "$destination_existed" -eq 1 ]]; then
    [[ ( -e "$runtime_plugin" || -L "$runtime_plugin" ) \
      && "$(path_identity "$runtime_plugin")" == "$destination_identity" ]] \
      || fail 'managed plugin destination changed while staging'
    if ! atomic_renameat2 exchange "$transaction_stage" "$runtime_plugin"; then
      fail 'cannot atomically exchange the staged runtime HVE plugin'
    fi
    [[ "$(path_identity "$runtime_plugin")" == "$stage_identity" \
      && "$(path_identity "$transaction_stage")" == "$destination_identity" ]] \
      || fail 'managed plugin exchange identities were not preserved'
  else
    [[ ! -e "$runtime_plugin" && ! -L "$runtime_plugin" ]] \
      || fail 'managed plugin destination appeared while staging'
    if ! atomic_renameat2 noreplace "$transaction_stage" "$runtime_plugin"; then
      fail 'cannot atomically install the staged runtime HVE plugin'
    fi
    [[ ! -e "$transaction_stage" && ! -L "$transaction_stage" \
      && "$(path_identity "$runtime_plugin")" == "$stage_identity" ]] \
      || fail 'managed plugin install identities were not preserved'
  fi
  plugin_parents_are_unchanged "$transaction_parent_identity" \
    || fail 'managed plugin parents changed during plugin publish'
  if [[ -e "$transaction_stage" || -L "$transaction_stage" ]]; then
    remove_reserved_transaction_path "$transaction_stage"
  fi
  transaction_active=0

  merge_managed_settings
  atomic_copy_control managed-lock.json
  atomic_copy_control managed-settings.json
  atomic_copy_control managed-files.txt
  atomic_copy_control managed.sha256
  current_state_is_valid || fail 'managed Copilot state failed post-sync verification'
}

for required_command in realpath jq sha256sum find sort sed cut cmp grep mktemp cp mv stat chmod cat mkdir python3 rm; do
  require_command "$required_command"
done
flock_command="${TRELLAGE_FLOCK:-/usr/bin/flock}"
[[ -x "$flock_command" ]] \
  || fail "flock is unavailable: $flock_command"

seed_home="${TRELLAGE_COPILOT_SEED_HOME:-/usr/local/share/trellage/copilot-seed}"
runtime_home="${TRELLAGE_COPILOT_HOME:-${COPILOT_HOME:-/home/agent/.copilot}}"
umask 077
validate_seed_home
validate_runtime_home
runtime_home_identity="$(directory_identity "$runtime_home")"
export COPILOT_HOME="$runtime_home"
verify_seed

[[ "$#" -gt 0 ]] || fail 'a mode is required'
mode="$1"
shift
harness_args=()
while (( $# > 0 )) && [[ "$1" != -- ]]; do
  harness_args+=("$1")
  shift
done
prompt=
if (( $# > 0 )); then
  shift
  [[ "$mode" == new ]] || fail "$mode does not accept a prompt"
  [[ "$#" -eq 1 ]] || fail 'new mode requires exactly one prompt after --'
  prompt="$1"
fi

read_only_probe=false
if [[ "$mode" == new && "$#" -eq 0 ]]; then
  if [[ "${#harness_args[@]}" -eq 1 && "${harness_args[0]}" == --version ]]; then
    read_only_probe=true
  elif [[ "${#harness_args[@]}" -eq 2 \
    && "${harness_args[0]}" == plugin && "${harness_args[1]}" == list ]]; then
    read_only_probe=true
  fi
fi

acquire_runtime_lock
sweep_reserved_managed_temps
if ! current_state_is_valid; then
  sync_managed_state
fi
release_runtime_lock

case "$mode" in
  new)
    if [[ "$read_only_probe" != true && -n "$inherited_copilot_github_token" ]]; then
      export COPILOT_GITHUB_TOKEN="$inherited_copilot_github_token"
    fi
    if (( $# > 0 )); then exec copilot "${harness_args[@]}" -i "$prompt"; fi
    exec copilot "${harness_args[@]}"
    ;;
  resume)
    if [[ -n "$inherited_copilot_github_token" ]]; then
      export COPILOT_GITHUB_TOKEN="$inherited_copilot_github_token"
    fi
    exec copilot "${harness_args[@]}" --continue
    ;;
  *) fail "unsupported mode: $mode" ;;
esac
