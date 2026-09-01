#!/usr/bin/env bash
set +x
set -euo pipefail
ulimit -c 0 2>/dev/null || true
umask 077

fail() {
  printf 'trellage-claude-entry: %s\n' "$1" >&2
  exit "${2:-1}"
}

seed_home="${TRELLAGE_CLAUDE_SEED_HOME:-/usr/local/share/trellage/claude-seed}"
runtime_home="${TRELLAGE_CLAUDE_HOME:-${CLAUDE_CONFIG_DIR:-/home/agent/.claude}}"
auth_mode="${TRELLAGE_CLAUDE_AUTH_MODE:-proxy}"
claude_mode="${TRELLAGE_CLAUDE_MODE:-hyperresearch}"
runtime_mode="${TRELLAGE_CLAUDE_RUNTIME_MODE:-$claude_mode}"
codex_reviewer_config="${TRELLAGE_CODEX_REVIEWER_CONFIG-}"
resume_profile="${TRELLAGE_RESUME_PROFILE-}"
resume_session_id="${TRELLAGE_RESUME_SESSION_ID-}"
output_format="${TRELLAGE_OUTPUT_FORMAT-}"
unset TRELLAGE_RESUME_PROFILE TRELLAGE_RESUME_SESSION_ID TRELLAGE_OUTPUT_FORMAT
if [[ -n "$resume_session_id" \
  && ! "$resume_session_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
  fail 'resume session ID must be a UUID'
fi
if [[ -n "$output_format" && "$output_format" != text && "$output_format" != jsonl ]]; then
  fail "unsupported output format: $output_format"
fi

valid_session_id() {
  [[ "$1" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]
}

session_id_for_worktree() {
  local session_file="$1"
  local expected_cwd="$2"
  jq -er --arg cwd "$expected_cwd" \
    'select(.cwd == $cwd and (.sessionId | type == "string")) | .sessionId' \
    "$session_file" 2>/dev/null | head -n 1
}

find_newest_session() {
  local expected_cwd="$1"
  local session_file session_id newest_file= newest_id=
  while IFS= read -r -d '' session_file; do
    [[ -f "$session_file" && ! -L "$session_file" ]] || continue
    session_id="$(session_id_for_worktree "$session_file" "$expected_cwd" || true)"
    valid_session_id "$session_id" || continue
    if [[ -z "$newest_file" || "$session_file" -nt "$newest_file" \
      || ( ! "$newest_file" -nt "$session_file" && "$session_file" > "$newest_file" ) ]]; then
      newest_file="$session_file"
      newest_id="$session_id"
    fi
  done < <(find "$runtime_home/projects" -type f -name '*.jsonl' -print0 2>/dev/null)
  [[ -n "$newest_id" ]] || return 1
  printf '%s\n' "$newest_id"
}

print_resume_hint() {
  local session_id="$1"
  [[ "$output_format" != jsonl ]] || return 0
  [[ -n "$resume_profile" ]] || return 0
  printf '\nResume this conversation:\n'
  printf 'trellage resume --profile %q %q\n' "$resume_profile" "$session_id"
}
[[ "$seed_home" == /* && "$runtime_home" == /* ]] || fail 'Claude homes must be absolute paths'
[[ "$runtime_mode" == core || "$runtime_mode" == hyperresearch || "$runtime_mode" == native-plugin ]] \
  || fail "unsupported Claude runtime mode: $runtime_mode"
[[ -d "$seed_home" && ! -L "$seed_home" ]] || fail "missing baked Claude seed: $seed_home"
if [[ -n "$codex_reviewer_config" ]]; then
  [[ "$codex_reviewer_config" == /* && -f "$codex_reviewer_config" && ! -L "$codex_reviewer_config" ]] \
    || fail 'Codex reviewer config must be an absolute regular file'
  codex_home="${CODEX_HOME:-/home/agent/.codex}"
  [[ "$codex_home" == /* && ! -L "$codex_home" ]] || fail 'Codex reviewer home must be an absolute directory'
  mkdir -p "$codex_home"
  [[ -d "$codex_home" && ! -L "$codex_home" ]] || fail 'Codex reviewer home must be a directory'
  codex_config="$codex_home/config.toml"
  codex_config_tmp="$codex_home/.config.toml.trellage.$$"
  cp -- "$codex_reviewer_config" "$codex_config_tmp"
  chmod 600 "$codex_config_tmp"
  mv -f -- "$codex_config_tmp" "$codex_config"
fi
if [[ "$runtime_mode" != core ]]; then
  [[ -f "$seed_home/managed-paths.txt" && ! -L "$seed_home/managed-paths.txt" ]] \
    || fail 'baked Claude managed-path manifest is missing or unsafe'
fi
default_settings="$seed_home/default-settings.json"
[[ -f "$default_settings" && ! -L "$default_settings" ]] \
  || fail 'baked Claude default settings are missing or unsafe'
default_user_settings="$seed_home/default-user-settings.json"
[[ -f "$default_user_settings" && ! -L "$default_user_settings" ]] \
  || fail 'baked Claude default user settings are missing or unsafe'
default_onboarding="$seed_home/default-onboarding.json"
[[ -f "$default_onboarding" && ! -L "$default_onboarding" ]] \
  || fail 'baked Claude onboarding defaults are missing or unsafe'
jq -e '
  .permissions.defaultMode == "bypassPermissions"
  and .permissions.deny == [
    "EnterPlanMode", "ExitPlanMode", "NotebookEdit", "SendMessage",
    "PushNotification", "RemoteTrigger", "ReportFindings", "ScheduleWakeup",
    "CronCreate", "CronDelete", "CronList"
  ]
  and .skipDangerousModePermissionPrompt == true
  and .disableRemoteControl == true
  and .disableClaudeAiConnectors == true
  and .disableArtifact == true
' "$default_settings" >/dev/null || fail 'baked Claude default settings are invalid'
jq -e '
  type == "object"
  and keys == ["outputStyle"]
  and .outputStyle == "Rundown"
' "$default_user_settings" >/dev/null || fail 'baked Claude default user settings are invalid'
jq -e '
  type == "object"
  and keys == [
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "shiftEnterKeyBindingInstalled",
    "theme"
  ]
  and .hasCompletedOnboarding == true
  and (.lastOnboardingVersion | type == "string")
  and (.lastOnboardingVersion | test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))
  and .shiftEnterKeyBindingInstalled == true
  and .theme == "dark"
' "$default_onboarding" >/dev/null || fail 'baked Claude onboarding defaults are invalid'
mkdir -p "$runtime_home"
[[ -d "$runtime_home" && ! -L "$runtime_home" ]] || fail 'Claude runtime home must be a directory'
global_state="$runtime_home/.claude.json"
workspace="$(pwd -P)"
[[ "$workspace" == /* ]] || fail 'Claude workspace must be an absolute path'

record_published_identity() {
  local source="$1"
  local relative_path="$2"
  local records="$3"
  node - "$source" "$relative_path" "$records" <<'NODE'
const fs = require('node:fs')

const [source, relativePath, records] = process.argv.slice(2)
const stat = fs.lstatSync(source, { bigint: true })
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error(`unsafe publication source: ${relativePath}`)
}
fs.appendFileSync(
  records,
  `${JSON.stringify({
    path: relativePath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    mode: stat.mode.toString(),
  })}\n`,
  { encoding: 'utf8', mode: 0o600 },
)
NODE
}

sync_filesystem() {
  local candidate="$1"
  python3 - "$candidate" <<'PY'
import ctypes
import os
import sys

candidate = sys.argv[1]
descriptor = os.open(candidate, os.O_RDONLY)
try:
    libc = ctypes.CDLL(None, use_errno=True)
    if hasattr(libc, "syncfs"):
        syncfs = libc.syncfs
        syncfs.argtypes = (ctypes.c_int,)
        syncfs.restype = ctypes.c_int
        if syncfs(descriptor) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number), candidate)
    else:
        os.sync()
finally:
    os.close(descriptor)
PY
}

render_default_user_settings() {
  local settings="$1"
  local settings_tmp="$2"
  [[ -f "$settings" && ! -L "$settings" ]] || fail 'Claude settings must be a regular file'
  if ! jq -S -s --slurpfile defaults "$default_user_settings" '
    if length != 1 or (.[0] | type) != "object"
    then error("settings must contain exactly one object")
    else .[0]
    end
    | .outputStyle = (.outputStyle // $defaults[0].outputStyle)
  ' "$settings" >"$settings_tmp"; then
    rm -f -- "$settings_tmp"
    fail 'Claude settings are invalid'
  fi
  chmod 600 "$settings_tmp"
}

merge_default_user_settings() {
  local settings="$1"
  local settings_tmp="$runtime_home/.settings.json.trellage.$$"
  render_default_user_settings "$settings" "$settings_tmp"
  mv -f -- "$settings_tmp" "$settings"
}

backup_runtime_state_file() {
  local relative_path="$1"
  local backup_path="$2"
  local expected_path="$3"
  local source="$runtime_home/$relative_path"
  local identity_after="$transaction/identity-after.json"
  python3 - "$source" "$relative_path" <<'PY'
import os
import stat
import sys

source, relative_path = sys.argv[1:]
value = os.lstat(source)
if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
    raise SystemExit(f"Claude state must be a single-link regular file: {relative_path}")
PY
  mkdir -p "$(dirname "$backup_path")"
  : >"$expected_path"
  record_published_identity "$source" "$relative_path" "$expected_path"
  cp -- "$source" "$backup_path"
  : >"$identity_after"
  record_published_identity "$source" "$relative_path" "$identity_after"
  cmp -s "$expected_path" "$identity_after" \
    || fail "Claude state changed while being backed up: $relative_path"
  rm -f -- "$identity_after"
  printf '%s\n' "$relative_path" >>"$state_restore"
  sync_filesystem "$transaction"
}

publish_state_file() {
  local staged="$1"
  local destination="$2"
  local relative_path="$3"
  local expected_path="$4"
  local published_records="$5"
  local exchange_records="$6"
  python3 - "$staged" "$destination" "$relative_path" "$expected_path" \
    "$published_records" "$exchange_records" <<'PY'
import ctypes
import json
import os
import stat
import sys

staged, destination, relative_path, expected_path, published_records, exchange_records = sys.argv[1:]
allowed_paths = {
    ".claude.json",
    ".trellage-claude-managed",
    "plugins/known_marketplaces.json",
    "settings.json",
}


def identity(candidate):
    value = os.lstat(candidate)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise RuntimeError(f"unsafe state publication file: {relative_path}")
    return {
        "path": relative_path,
        "dev": str(value.st_dev),
        "ino": str(value.st_ino),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "mode": str(value.st_mode),
    }


def matches(actual, expected):
    return all(actual[key] == expected[key] for key in ("dev", "ino", "size", "mtimeNs", "mode"))


def append_record(destination_path, record):
    with open(destination_path, "a", encoding="utf-8") as destination_file:
        destination_file.write(json.dumps(record, separators=(",", ":")) + "\n")
        destination_file.flush()
        os.fsync(destination_file.fileno())


def fsync_file(candidate):
    descriptor = os.open(candidate, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(candidate):
    descriptor = os.open(candidate, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError:
            if sys.platform != "darwin":
                raise
            os.sync()
    finally:
        os.close(descriptor)


def atomic_exchange(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if hasattr(libc, "renameat2"):
        operation = libc.renameat2
        operation.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        operation.restype = ctypes.c_int
        result = operation(-100, os.fsencode(source), -100, os.fsencode(target), 2)
    elif hasattr(libc, "renamex_np"):
        operation = libc.renamex_np
        operation.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        operation.restype = ctypes.c_int
        result = operation(os.fsencode(source), os.fsencode(target), 2)
    else:
        raise RuntimeError("atomic file exchange is unavailable")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), target)


try:
    if relative_path not in allowed_paths:
        raise RuntimeError(f"unsafe state publication path: {relative_path}")
    transaction = os.path.realpath(os.path.dirname(exchange_records))
    if os.path.realpath(os.path.dirname(staged)) != transaction:
        raise RuntimeError(f"state publication escaped its transaction: {relative_path}")
    staged_identity = identity(staged)
    fsync_file(staged)
    fsync_directory(transaction)
    expected_text = open(expected_path, encoding="utf-8").read().strip()
    append_record(published_records, staged_identity)
    if expected_text == "absent":
        os.link(staged, destination, follow_symlinks=False)
        os.unlink(staged)
        fsync_directory(os.path.dirname(destination))
        fsync_directory(transaction)
    else:
        expected = json.loads(expected_text)
        exchange_record = {
            "path": relative_path,
            "staged": os.path.basename(staged),
            "new": staged_identity,
            "expected": expected,
        }
        append_record(exchange_records, exchange_record)
        atomic_exchange(staged, destination)
        fsync_directory(os.path.dirname(destination))
        fsync_directory(transaction)
        displaced_identity = identity(staged)
        if not matches(displaced_identity, expected):
            if not matches(identity(destination), staged_identity):
                raise RuntimeError(
                    f"Claude state exchange needs recovery: {relative_path}"
                )
            atomic_exchange(staged, destination)
            fsync_directory(os.path.dirname(destination))
            fsync_directory(transaction)
            if not matches(identity(destination), displaced_identity) or not matches(
                identity(staged), staged_identity
            ):
                raise RuntimeError(
                    f"Claude state exchange could not be restored: {relative_path}"
                )
            raise RuntimeError(
                f"Claude state changed during publication: {relative_path}"
            )
except Exception as error:
    print(f"trellage-claude-entry: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

if [[ "$runtime_mode" == core && ! -s "$seed_home/managed-paths.txt" ]]; then
  settings="$runtime_home/settings.json"
  if [[ ! -e "$settings" && ! -L "$settings" ]]; then
    settings_tmp="$runtime_home/.settings.json.trellage.$$"
    cp -- "$default_settings" "$settings_tmp"
    chmod 600 "$settings_tmp"
    mv -n -- "$settings_tmp" "$settings"
    rm -f -- "$settings_tmp"
  fi
  merge_default_user_settings "$settings"
fi

if [[ "$runtime_mode" != core || -s "$seed_home/managed-paths.txt" ]]; then
validate_managed_path() {
  local candidate="$1"
  [[ -n "$candidate" && "$candidate" != /* && "$candidate" != *'//'*
    && "$candidate" != . && "$candidate" != .. && "$candidate" != ./* && "$candidate" != ../*
    && "$candidate" != */. && "$candidate" != */.. && "$candidate" != *'/./'* && "$candidate" != *'/../'*
    && "$candidate" != *'\'* ]] || return 1
  case "$candidate" in
    CLAUDE.md|skills/hyperresearch|skills/hyperresearch/*|agents/hyperresearch-*.md|plugins/installed_plugins.json) ;;
    skills/*)
      [[ "$candidate" =~ ^skills/[A-Za-z0-9][A-Za-z0-9._-]*/.+$ ]] || return 1
      ;;
    output-styles/*)
      [[ "$candidate" =~ ^output-styles/[A-Za-z0-9][A-Za-z0-9._-]*\.md$ ]] || return 1
      ;;
    plugins/cache/*)
      [[ "$candidate" =~ ^plugins/cache/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9.+-]*/.+$ ]] \
        || return 1
      ;;
    *) return 1 ;;
  esac
}

ensure_runtime_parent() {
  local candidate="$1"
  local parent="${candidate%/*}"
  local current="$runtime_home"
  local segment
  [[ "$parent" != "$candidate" ]] || return 0
  IFS=/ read -r -a parent_segments <<<"$parent"
  for segment in "${parent_segments[@]}"; do
    current="$current/$segment"
    [[ ! -L "$current" ]] || return 1
    if [[ -e "$current" ]]; then
      [[ -d "$current" ]] || return 1
    else
      mkdir "$current" || return 1
      [[ -d "$current" && ! -L "$current" ]] || return 1
    fi
  done
}

copy_managed_files() {
  local source_root="$1"
  local destination_root="$2"
  local paths="$3"
  local published_records="${4:-}"
  local preserve_existing="${5:-false}"
  local staging_prefix=.managed-copy
  local staging
  [[ -s "$paths" ]] || return 0
  if [[ "$destination_root" == "$runtime_home" ]]; then
    staging_prefix=.managed-runtime-copy
  fi
  staging="$(mktemp -d "$transaction/$staging_prefix.XXXXXX")" || {
    printf 'trellage-claude-entry: cannot create managed-file staging directory\n' >&2
    return 1
  }
  if ! tar -C "$source_root" -cf - -T "$paths" |
    tar -C "$staging" -xf -; then
    rm -rf -- "$staging"
    printf 'trellage-claude-entry: cannot stage managed Claude files\n' >&2
    return 1
  fi
  if ! sync_filesystem "$staging"; then
    rm -rf -- "$staging"
    printf 'trellage-claude-entry: cannot flush staged Claude files\n' >&2
    return 1
  fi
  if ! node - "$staging" "$destination_root" "$paths" "$published_records" "$preserve_existing" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [stagingRoot, destinationRoot, pathsFile, publishedRecords, preserveExisting] = process.argv.slice(2)
const stagingPrefix = `${path.resolve(stagingRoot)}${path.sep}`
const destinationPrefix = `${path.resolve(destinationRoot)}${path.sep}`

const fileIdentity = (candidate, managedPath) => {
  const stat = fs.lstatSync(candidate, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`unsafe staged file: ${managedPath}`)
  }
  return {
    path: managedPath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    mode: stat.mode.toString(),
  }
}

const ensureDirectory = (root, relativeDirectory) => {
  let current = root
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`unsafe destination directory: ${current}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
  }
}

let failed = false

try {
  const destinationStat = fs.lstatSync(destinationRoot)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error(`unsafe destination root: ${destinationRoot}`)
  }
  const managedPaths = fs
    .readFileSync(pathsFile, 'utf8')
    .split('\n')
    .filter((managedPath) => managedPath.length > 0)
  for (const managedPath of managedPaths) {
    try {
      const staged = path.resolve(stagingRoot, managedPath)
      const destination = path.resolve(destinationRoot, managedPath)
      if (!staged.startsWith(stagingPrefix) || !destination.startsWith(destinationPrefix)) {
        throw new Error(`unsafe managed path: ${managedPath}`)
      }
      try {
        fs.lstatSync(destination)
        if (preserveExisting === 'true') continue
        throw new Error(`managed destination already exists: ${managedPath}`)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const identity = fileIdentity(staged, managedPath)
      ensureDirectory(destinationRoot, path.dirname(managedPath))
      if (publishedRecords) {
        const descriptor = fs.openSync(publishedRecords, 'a', 0o600)
        try {
          fs.writeSync(descriptor, `${JSON.stringify(identity)}\n`)
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
      }
      fs.linkSync(staged, destination)
      fs.unlinkSync(staged)
    } catch (error) {
      failed = true
      process.stderr.write(
        `trellage-claude-entry: atomic publication failed for ${managedPath}: ${error.message}\n`,
      )
    }
  }
} catch (error) {
  failed = true
  process.stderr.write(`trellage-claude-entry: atomic publication failed: ${error.message}\n`)
}
if (failed) process.exitCode = 1
NODE
  then
    rm -rf -- "$staging"
    return 1
  fi
  if ! sync_filesystem "$destination_root"; then
    rm -rf -- "$staging"
    printf 'trellage-claude-entry: cannot flush published Claude files\n' >&2
    return 1
  fi
  rm -rf -- "$staging"
}

remove_published_files() {
  local root="$1"
  local records="$2"
  [[ -s "$records" ]] || return 0
  node - "$root" "$records" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [root, recordsPath] = process.argv.slice(2)
const resolvedRoot = path.resolve(root)
const rootPrefix = `${resolvedRoot}${path.sep}`
const statePaths = new Set([
  '.claude.json',
  '.trellage-claude-managed',
  'plugins/known_marketplaces.json',
  'settings.json',
])
let failed = false

const isManagedPath = (candidate) => {
  if (
    !candidate ||
    candidate.includes('\\') ||
    path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate
  ) {
    return false
  }
  if (
    candidate === 'CLAUDE.md' ||
    candidate === 'skills/hyperresearch' ||
    candidate.startsWith('skills/hyperresearch/') ||
    /^agents\/hyperresearch-[A-Za-z0-9._-]+\.md$/.test(candidate) ||
    candidate === 'plugins/installed_plugins.json'
  ) {
    return true
  }
  return (
    /^skills\/[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/.test(candidate) ||
    /^output-styles\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(candidate) ||
    /^plugins\/cache\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*\/.+$/.test(
      candidate,
    )
  )
}

const ensureSafeParent = (candidate) => {
  let current = resolvedRoot
  for (const segment of path.dirname(candidate).split('/').filter(Boolean)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe published parent: ${candidate}`)
    }
  }
}

const rootStat = fs.lstatSync(resolvedRoot)
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error(`unsafe publication root: ${root}`)
}

for (const line of fs.readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean)) {
  try {
    const record = JSON.parse(line)
    if (
      typeof record?.path !== 'string' ||
      !['dev', 'ino', 'size', 'mtimeNs', 'mode'].every((key) => typeof record?.[key] === 'string')
    ) {
      throw new Error('invalid publication record')
    }
    if (!statePaths.has(record.path) && !isManagedPath(record.path)) {
      throw new Error(`unsafe published path: ${record.path}`)
    }
    const destination = path.resolve(root, record.path)
    if (!destination.startsWith(rootPrefix)) {
      throw new Error(`unsafe published path: ${record.path}`)
    }
    ensureSafeParent(record.path)
    let stat
    try {
      stat = fs.lstatSync(destination, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const unchanged =
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev.toString() === record.dev &&
      stat.ino.toString() === record.ino &&
      stat.size.toString() === record.size &&
      stat.mtimeNs.toString() === record.mtimeNs &&
      stat.mode.toString() === record.mode
    if (unchanged) {
      fs.unlinkSync(destination)
    }
  } catch (error) {
    failed = true
    process.stderr.write(`trellage-claude-entry: cannot roll back published file: ${error.message}\n`)
  }
}
if (failed) process.exitCode = 1
NODE
}

remove_managed_files() {
  local root="$1"
  local paths="$2"
  [[ -s "$paths" ]] || return 0
  (
    cd "$root"
    while IFS= read -r managed_path; do
      [[ -n "$managed_path" ]] || continue
      printf '%s\0' "$managed_path"
    done <"$paths" | xargs -0 rm -f --
  )
}

recover_state_exchanges() {
  local recovery_transaction="$1"
  local recovery_records="$2"
  [[ -s "$recovery_records" ]] || return 0
  python3 - "$recovery_transaction" "$runtime_home" "$recovery_records" <<'PY'
import ctypes
import json
import os
import stat
import sys

transaction, runtime_home, records_path = sys.argv[1:]
staged_names = {
    ".claude.json": "global-state.publish.json",
    ".trellage-claude-managed": "managed-manifest.publish",
    "plugins/known_marketplaces.json": "known-marketplaces.publish.json",
    "settings.json": "settings.publish.json",
}


def identity(candidate, relative_path):
    try:
        value = os.lstat(candidate)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise RuntimeError(f"unsafe exchanged Claude state: {relative_path}")
    return {
        "path": relative_path,
        "dev": str(value.st_dev),
        "ino": str(value.st_ino),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "mode": str(value.st_mode),
    }


def matches(actual, expected):
    return actual is not None and all(
        actual[key] == expected[key]
        for key in ("dev", "ino", "size", "mtimeNs", "mode")
    )


def valid_identity(candidate, relative_path):
    return (
        isinstance(candidate, dict)
        and candidate.get("path") == relative_path
        and all(
            isinstance(candidate.get(key), str)
            for key in ("dev", "ino", "size", "mtimeNs", "mode")
        )
    )


def fsync_directory(candidate):
    descriptor = os.open(candidate, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError:
            if sys.platform != "darwin":
                raise
            os.sync()
    finally:
        os.close(descriptor)


def atomic_exchange(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if hasattr(libc, "renameat2"):
        operation = libc.renameat2
        operation.argtypes = (
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        )
        operation.restype = ctypes.c_int
        result = operation(-100, os.fsencode(source), -100, os.fsencode(target), 2)
    elif hasattr(libc, "renamex_np"):
        operation = libc.renamex_np
        operation.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        operation.restype = ctypes.c_int
        result = operation(os.fsencode(source), os.fsencode(target), 2)
    else:
        raise RuntimeError("atomic file exchange is unavailable")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), target)


try:
    resolved_transaction = os.path.realpath(transaction)
    resolved_runtime = os.path.realpath(runtime_home)
    with open(records_path, encoding="utf-8") as records:
        for line in records:
            if not line.strip():
                continue
            record = json.loads(line)
            relative_path = record.get("path")
            if (
                relative_path not in staged_names
                or record.get("staged") != staged_names[relative_path]
                or not valid_identity(record.get("new"), relative_path)
                or not valid_identity(record.get("expected"), relative_path)
            ):
                raise RuntimeError("unsafe Claude state exchange record")
            staged = os.path.realpath(
                os.path.join(resolved_transaction, record["staged"])
            )
            destination = os.path.realpath(
                os.path.join(resolved_runtime, relative_path)
            )
            if (
                os.path.dirname(staged) != resolved_transaction
                or not destination.startswith(resolved_runtime + os.sep)
            ):
                raise RuntimeError("Claude state exchange escaped its transaction")
            staged_identity = identity(staged, relative_path)
            destination_identity = identity(destination, relative_path)
            if matches(staged_identity, record["new"]):
                continue
            if matches(staged_identity, record["expected"]):
                if matches(destination_identity, record["new"]):
                    try:
                        atomic_exchange(staged, destination)
                    except FileNotFoundError:
                        if identity(destination, relative_path) is None:
                            continue
                        raise
                    fsync_directory(os.path.dirname(destination))
                    fsync_directory(resolved_transaction)
                    restored_identity = identity(destination, relative_path)
                    returned_identity = identity(staged, relative_path)
                    if matches(restored_identity, record["expected"]) and matches(
                        returned_identity, record["new"]
                    ):
                        continue
                    if matches(restored_identity, record["expected"]) and returned_identity is not None:
                        atomic_exchange(staged, destination)
                        fsync_directory(os.path.dirname(destination))
                        fsync_directory(resolved_transaction)
                        if not matches(
                            identity(destination, relative_path), returned_identity
                        ) or not matches(
                            identity(staged, relative_path), record["expected"]
                        ):
                            raise RuntimeError(
                                f"Claude state exchange could not preserve a concurrent update: {relative_path}"
                            )
                        continue
                    raise RuntimeError(
                        f"Claude state exchange could not restore prior state: {relative_path}"
                    )
                continue
            if destination_identity is None:
                continue
            if matches(destination_identity, record["new"]) and staged_identity is not None:
                displaced_identity = staged_identity
                atomic_exchange(staged, destination)
                fsync_directory(os.path.dirname(destination))
                fsync_directory(resolved_transaction)
                if not matches(identity(destination, relative_path), displaced_identity) or not matches(
                    identity(staged, relative_path), record["new"]
                ):
                    raise RuntimeError(
                        f"Claude state exchange could not be recovered: {relative_path}"
                    )
                continue
            raise RuntimeError(
                f"Claude state exchange needs manual recovery: {relative_path}"
            )
except Exception as error:
    print(f"trellage-claude-entry: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
}

recover_stale_transaction() {
  local stale_transaction="$1"
  local previous_transaction="${transaction-}"
  local recovery_list recovery_path
  local stale_backup="$stale_transaction/backup"
  local stale_committed="$stale_transaction/committed"
  local stale_exchanges="$stale_transaction/exchanges.jsonl"
  local stale_prior_backup_ready="$stale_transaction/prior-backup-ready"
  local stale_prior_present="$stale_transaction/prior-present"
  local stale_published="$stale_transaction/published.jsonl"
  local stale_state_restore="$stale_transaction/state-restore"
  if [[ -e "$stale_committed" || -L "$stale_committed" ]]; then
    [[ -f "$stale_committed" && ! -L "$stale_committed" ]] \
      || fail "unsafe committed Claude transaction: $stale_transaction"
    rm -rf -- "$stale_transaction"
    sync_filesystem "$runtime_home"
    return
  fi
  if [[ -e "$stale_transaction/placed" || -L "$stale_transaction/placed" ]]; then
    fail "legacy Claude transaction requires manual recovery: $stale_transaction"
  fi
  for recovery_list in \
    "$stale_exchanges" "$stale_prior_present" "$stale_published" "$stale_state_restore"; do
    if [[ -e "$recovery_list" || -L "$recovery_list" ]]; then
      [[ -f "$recovery_list" && ! -L "$recovery_list" ]] \
        || fail "unsafe Claude transaction journal: $recovery_list"
    fi
  done
  if [[ -s "$stale_prior_present" ]]; then
    while IFS= read -r recovery_path; do
      validate_managed_path "$recovery_path" \
        || fail "unsafe managed path in Claude transaction: $recovery_path"
    done <"$stale_prior_present"
  fi
  if [[ -s "$stale_state_restore" ]]; then
    while IFS= read -r recovery_path; do
      case "$recovery_path" in
        .claude.json|.trellage-claude-managed|plugins/known_marketplaces.json|settings.json) ;;
        *) fail "unsafe state path in Claude transaction: $recovery_path" ;;
      esac
    done <"$stale_state_restore"
  fi
  if [[ -s "$stale_state_restore" \
    || (-e "$stale_prior_backup_ready" && -s "$stale_prior_present") ]]; then
    [[ -d "$stale_backup" && ! -L "$stale_backup" ]] \
      || fail "missing Claude transaction backup: $stale_transaction"
  fi
  transaction="$stale_transaction"
  if [[ -s "$stale_exchanges" ]]; then
    recover_state_exchanges "$stale_transaction" "$stale_exchanges" \
      || fail "cannot recover interrupted Claude state exchanges: $stale_transaction"
  fi
  if [[ -s "$stale_published" ]]; then
    remove_published_files "$runtime_home" "$stale_published" \
      || fail "cannot remove interrupted Claude publications: $stale_transaction"
  fi
  if [[ -e "$stale_prior_backup_ready" || -L "$stale_prior_backup_ready" ]]; then
    [[ -f "$stale_prior_backup_ready" && ! -L "$stale_prior_backup_ready" ]] \
      || fail "unsafe Claude prior-backup marker: $stale_transaction"
  fi
  if [[ -f "$stale_prior_backup_ready" && -s "$stale_prior_present" ]]; then
    copy_managed_files "$stale_backup" "$runtime_home" "$stale_prior_present" "" true \
      || fail "cannot restore interrupted managed Claude files: $stale_transaction"
  fi
  rm -rf -- "$stale_transaction"
  sync_filesystem "$runtime_home"
  transaction="$previous_transaction"
}

command -v tar >/dev/null 2>&1 || fail 'tar is required to synchronize Claude managed files'
command -v xargs >/dev/null 2>&1 || fail 'xargs is required to synchronize Claude managed files'
command -v node >/dev/null 2>&1 || fail 'node is required to synchronize Claude managed files'
command -v mktemp >/dev/null 2>&1 || fail 'mktemp is required to synchronize Claude managed files'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required to synchronize Claude managed files'
flock_command="${TRELLAGE_FLOCK:-}"
if [[ -z "$flock_command" ]]; then
  flock_command="$(command -v flock 2>/dev/null)" || fail 'flock is required to synchronize Claude managed files'
fi
[[ -x "$flock_command" ]] || fail "flock is unavailable: $flock_command"

manifest="$runtime_home/.trellage-claude-managed"
legacy_manifest="$runtime_home/.trellage-hyperresearch-managed"
lock_path="$runtime_home/.trellage-claude.lock"
lock_active=false
transaction_active=false
if [[ -d "$lock_path" && ! -L "$lock_path" ]]; then
  fail "legacy Claude lock directory requires manual removal: $lock_path"
fi
if [[ ! -e "$lock_path" && ! -L "$lock_path" ]]; then
  if ! (set -o noclobber; : >"$lock_path") 2>/dev/null; then
    [[ -e "$lock_path" || -L "$lock_path" ]] \
      || fail 'cannot create Claude managed-state lock'
  fi
fi
[[ -f "$lock_path" && ! -L "$lock_path" ]] \
  || fail 'Claude managed-state lock must be a regular file'
exec 9<>"$lock_path" || fail 'cannot open Claude managed-state lock'
"$flock_command" -x 9 || fail 'cannot acquire Claude managed-state lock'
lock_active=true

cleanup_lock_on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$lock_active" == true ]]; then
    "$flock_command" -u 9 2>/dev/null || true
    exec 9>&-
  fi
  exit "$status"
}
trap cleanup_lock_on_exit EXIT HUP INT TERM

node - "$lock_path" <<'NODE'
const fs = require('node:fs')

const lockPath = process.argv[2]
const pathStat = fs.lstatSync(lockPath, { bigint: true })
const descriptorStat = fs.fstatSync(9, { bigint: true })
if (
  !pathStat.isFile() ||
  pathStat.isSymbolicLink() ||
  pathStat.nlink !== 1n ||
  !descriptorStat.isFile() ||
  descriptorStat.nlink !== 1n ||
  pathStat.dev !== descriptorStat.dev ||
  pathStat.ino !== descriptorStat.ino
) {
  throw new Error('Claude managed-state lock changed during acquisition')
}
NODE

while IFS= read -r -d '' stale_transaction; do
  [[ "$stale_transaction" == "$runtime_home"/.trellage-claude-transaction.* \
    && -d "$stale_transaction" && ! -L "$stale_transaction" ]] \
    || fail "unsafe stale Claude transaction: $stale_transaction"
  recover_stale_transaction "$stale_transaction"
done < <(
  find "$runtime_home" -mindepth 1 -maxdepth 1 \
    -name '.trellage-claude-transaction.*' -print0
)

new_manifest="$seed_home/managed-paths.txt"
cmp -s "$new_manifest" <(LC_ALL=C sort -u "$new_manifest") \
  || fail 'baked Claude managed-path manifest is not sorted and unique'
managed_file_count=0
while IFS= read -r managed_path; do
  validate_managed_path "$managed_path" || fail "unsafe managed Claude seed path: $managed_path"
  [[ -f "$seed_home/$managed_path" && ! -L "$seed_home/$managed_path" ]] \
    || fail "missing managed Claude seed file: $managed_path"
  ((managed_file_count += 1))
done <"$new_manifest"
sync_progress=false
if (( managed_file_count >= 1000 )); then
  printf 'trellage-claude-entry: synchronizing %d managed Claude files...\n' \
    "$managed_file_count" >&2
  sync_progress=true
fi

transaction="$(mktemp -d "$runtime_home/.trellage-claude-transaction.XXXXXX")" \
  || fail 'cannot create Claude managed-state transaction'
backup="$transaction/backup"
exchanges="$transaction/exchanges.jsonl"
published="$transaction/published.jsonl"
prior_backup_ready="$transaction/prior-backup-ready"
prior_present="$transaction/prior-present"
state_restore="$transaction/state-restore"
mkdir -p "$backup"
: >"$exchanges"
: >"$published"
: >"$prior_present"
: >"$state_restore"
sync_filesystem "$transaction"
transaction_active=true

rollback_sync() {
  local rollback_failed=false
  if [[ -f "$exchanges" && ! -L "$exchanges" && -s "$exchanges" ]] \
    && ! recover_state_exchanges "$transaction" "$exchanges"; then
    printf 'trellage-claude-entry: rollback incomplete; transaction retained: %s\n' \
      "$transaction" >&2
    return 1
  fi
  if [[ -f "$published" && ! -L "$published" ]]; then
    remove_published_files "$runtime_home" "$published" \
      || rollback_failed=true
  fi
  if [[ -f "$prior_backup_ready" && ! -L "$prior_backup_ready" \
    && -f "$prior_present" && ! -L "$prior_present" && -s "$prior_present" ]]; then
    copy_managed_files "$backup" "$runtime_home" "$prior_present" "" true \
      || rollback_failed=true
  fi
  if [[ "$rollback_failed" == true ]]; then
    printf 'trellage-claude-entry: rollback incomplete; transaction retained: %s\n' \
      "$transaction" >&2
    return 1
  fi
  rm -rf -- "$transaction"
  sync_filesystem "$runtime_home"
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$transaction_active" == true ]] && ! rollback_sync; then
    [[ "$status" -ne 0 ]] || status=1
  fi
  if [[ "$lock_active" == true ]]; then
    "$flock_command" -u 9 2>/dev/null || true
    exec 9>&-
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT HUP INT TERM

prior_manifest="$manifest"
if [[ ! -e "$prior_manifest" && ! -L "$prior_manifest" && -f "$legacy_manifest" && ! -L "$legacy_manifest" ]]; then
  prior_manifest="$legacy_manifest"
fi
manifest_expected="$transaction/managed-manifest.expected"
if [[ "$prior_manifest" == "$manifest" && -f "$manifest" && ! -L "$manifest" ]]; then
  backup_runtime_state_file \
    .trellage-claude-managed "$backup/.trellage-claude-managed" "$manifest_expected"
else
  printf 'absent\n' >"$manifest_expected"
fi
if [[ -f "$prior_manifest" && ! -L "$prior_manifest" ]]; then
  while IFS= read -r managed_path; do
    validate_managed_path "$managed_path" || fail "unsafe prior managed Claude path: $managed_path"
    ensure_runtime_parent "$managed_path" \
      || fail "managed Claude destination parent is unsafe: $managed_path"
    if [[ -e "$runtime_home/$managed_path" || -L "$runtime_home/$managed_path" ]]; then
      [[ -f "$runtime_home/$managed_path" && ! -L "$runtime_home/$managed_path" ]] \
        || fail "managed Claude destination is unsafe: $managed_path"
      printf '%s\n' "$managed_path" >>"$prior_present"
    fi
  done <"$prior_manifest"
elif [[ -e "$prior_manifest" || -L "$prior_manifest" ]]; then
  fail 'Claude managed-path manifest is unsafe'
fi

copy_managed_files "$runtime_home" "$backup" "$prior_present"
while IFS= read -r managed_path; do
  [[ -f "$backup/$managed_path" && ! -L "$backup/$managed_path" ]] \
    || fail "failed to back up managed Claude file: $managed_path"
done <"$prior_present"
: >"$prior_backup_ready"
sync_filesystem "$transaction"
remove_managed_files "$runtime_home" "$prior_present"

while IFS= read -r managed_path; do
  destination="$runtime_home/$managed_path"
  ensure_runtime_parent "$managed_path" \
    || fail "managed Claude destination parent is unsafe: $managed_path"
  [[ ! -e "$destination" && ! -L "$destination" ]] \
    || fail "managed Claude destination collides with an unmanaged path: $managed_path"
done <"$new_manifest"
copy_managed_files "$seed_home" "$runtime_home" "$new_manifest" "$published"
while IFS= read -r managed_path; do
  [[ -f "$runtime_home/$managed_path" && ! -L "$runtime_home/$managed_path" ]] \
    || fail "failed to install managed Claude file: $managed_path"
done <"$new_manifest"
settings="$runtime_home/settings.json"
settings_expected="$transaction/settings.expected"
settings_base="$default_settings"
if [[ -e "$settings" || -L "$settings" ]]; then
  [[ -f "$settings" && ! -L "$settings" ]] || fail 'Claude settings must be a regular file'
  backup_runtime_state_file settings.json "$backup/settings.json" "$settings_expected"
  settings_base="$backup/settings.json"
else
  printf 'absent\n' >"$settings_expected"
fi
settings_tmp="$transaction/settings.publish.json"
render_default_user_settings "$settings_base" "$settings_tmp"
plugin_settings="$seed_home/plugin-settings.json"
if [[ -e "$plugin_settings" || -L "$plugin_settings" ]]; then
  [[ -f "$plugin_settings" && ! -L "$plugin_settings" ]] \
    || fail 'baked Claude plugin settings are unsafe'
  jq -e '
    type == "object"
    and ((keys == ["enabledPlugins"]) or (keys == ["enabledPlugins", "pluginConfigs"]))
    and (.enabledPlugins | type == "object")
    and ([.enabledPlugins[]] | all(. == true))
    and ([.enabledPlugins | keys[]] | all(test("^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$")))
    and (
      (.pluginConfigs // {}) | type == "object"
      and ([to_entries[] |
        (.key | test("^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$"))
        and (.value | type == "object" and keys == ["options"])
        and (.value.options | type == "object" and length > 0)
        and ([.value.options | to_entries[] |
          (.key | test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))
          and ((.value | type) as $kind | $kind == "string" or $kind == "boolean" or $kind == "number")
        ] | all)
      ] | all)
    )
  ' "$plugin_settings" >/dev/null || fail 'baked Claude plugin settings are invalid'
  jq -e 'type == "object"' "$settings_tmp" >/dev/null || fail 'Claude settings are invalid'
  plugin_settings_tmp="$transaction/settings.plugin.publish.json"
  jq -S --slurpfile plugin "$plugin_settings" \
    '.enabledPlugins = ((.enabledPlugins // {}) + $plugin[0].enabledPlugins)
    | if $plugin[0].pluginConfigs == null
      then .
      else .pluginConfigs = ((.pluginConfigs // {}) + $plugin[0].pluginConfigs)
      end' \
    "$settings_tmp" >"$plugin_settings_tmp"
  chmod 600 "$plugin_settings_tmp"
  mv -f -- "$plugin_settings_tmp" "$settings_tmp"
fi
publish_state_file "$settings_tmp" "$settings" settings.json \
  "$settings_expected" "$published" "$exchanges"
plugin_marketplaces="$seed_home/plugin-marketplaces.json"
if [[ -e "$plugin_marketplaces" || -L "$plugin_marketplaces" ]]; then
  [[ -f "$plugin_marketplaces" && ! -L "$plugin_marketplaces" ]] \
    || fail 'baked Claude plugin marketplaces are unsafe'
  jq -e '
    type == "object"
    and length > 0
    and ([to_entries[] |
      (.key | test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))
      and (.value | type == "object" and keys == ["installLocation", "source"])
      and (.value.source | type == "object" and keys == ["path", "source"])
      and .value.source.source == "directory"
      and (.value.source.path | type == "string" and startswith("/home/agent/.claude/plugins/cache/"))
      and .value.installLocation == .value.source.path
    ] | all)
  ' "$plugin_marketplaces" >/dev/null || fail 'baked Claude plugin marketplaces are invalid'
  ensure_runtime_parent "plugins/known_marketplaces.json" \
    || fail 'Claude marketplace destination parent is unsafe'
  marketplace_registry="$runtime_home/plugins/known_marketplaces.json"
  marketplace_base="$transaction/known-marketplaces.base.json"
  marketplace_expected="$transaction/known-marketplaces.expected"
  if [[ -e "$marketplace_registry" || -L "$marketplace_registry" ]]; then
    [[ -f "$marketplace_registry" && ! -L "$marketplace_registry" ]] \
      || fail 'Claude marketplace registry must be a regular file'
    jq -e 'type == "object"' "$marketplace_registry" >/dev/null \
      || fail 'Claude marketplace registry is invalid'
    backup_runtime_state_file plugins/known_marketplaces.json \
      "$backup/plugins/known_marketplaces.json" "$marketplace_expected"
    marketplace_base="$backup/plugins/known_marketplaces.json"
  else
    printf '{}\n' >"$marketplace_base"
    printf 'absent\n' >"$marketplace_expected"
  fi
  marketplaces_tmp="$transaction/known-marketplaces.publish.json"
  jq -S --slurpfile managed "$plugin_marketplaces" \
    '. + $managed[0]' "$marketplace_base" >"$marketplaces_tmp"
  chmod 600 "$marketplaces_tmp"
  publish_state_file "$marketplaces_tmp" "$marketplace_registry" \
    plugins/known_marketplaces.json "$marketplace_expected" "$published" "$exchanges"
fi
global_state_expected="$transaction/global-state.expected"
if [[ -e "$global_state" || -L "$global_state" ]]; then
  [[ -f "$global_state" && ! -L "$global_state" ]] \
    || fail 'Claude global state must be a regular file'
  jq -e 'type == "object"' "$global_state" >/dev/null || fail 'Claude global state is invalid'
  backup_runtime_state_file .claude.json "$backup/.claude.json" "$global_state_expected"
  global_state_tmp="$transaction/global-state.publish.json"
  jq -S --arg workspace "$workspace" --slurpfile defaults "$default_onboarding" '
    $defaults[0] + .
    | .projects = (
        (.projects // {})
        | .[$workspace] = ((.[$workspace] // {}) + {"hasTrustDialogAccepted": true})
      )
  ' "$backup/.claude.json" >"$global_state_tmp"
else
  printf 'absent\n' >"$global_state_expected"
  global_state_tmp="$transaction/global-state.publish.json"
  jq -S --arg workspace "$workspace" '
    .projects = {($workspace): {"hasTrustDialogAccepted": true}}
  ' "$default_onboarding" >"$global_state_tmp"
fi
chmod 600 "$global_state_tmp"
publish_state_file "$global_state_tmp" "$global_state" .claude.json \
  "$global_state_expected" "$published" "$exchanges"
manifest_tmp="$transaction/managed-manifest.publish"
cp -- "$new_manifest" "$manifest_tmp"
publish_state_file "$manifest_tmp" "$manifest" .trellage-claude-managed \
  "$manifest_expected" "$published" "$exchanges"
sync_filesystem "$runtime_home"
: >"$transaction/committed"
sync_filesystem "$transaction"
transaction_active=false
rm -f -- "$legacy_manifest"
rm -rf -- "$transaction"
sync_filesystem "$runtime_home"
"$flock_command" -u 9 || fail 'cannot release Claude managed-state lock'
exec 9>&-
lock_active=false
trap - EXIT HUP INT TERM
if [[ "$sync_progress" == true ]]; then
  printf 'trellage-claude-entry: managed Claude files are ready\n' >&2
fi
fi

install_session_bridge_hook() {
  local bridge=/usr/local/bin/trellage-session-bridge
  local profile="${TRELLAGE_PROFILE_NAME-}"
  local agent="${TRELLAGE_AGENT-}"
  if [[ -z "$profile" && -z "$agent" ]]; then
    return
  fi
  [[ "$agent" == claude ]] || fail 'TRELLAGE_AGENT must identify the Claude sandbox'
  [[ "$profile" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
    || fail 'TRELLAGE_PROFILE_NAME is invalid'
  [[ -f "$bridge" && ! -L "$bridge" && -x "$bridge" ]] \
    || fail "missing immutable session bridge: $bridge"
  "$bridge" install-hook \
    --mode sandbox \
    --agent claude \
    --profile "$profile" \
    --config-dir "$runtime_home" \
    --hook-path "$bridge"
  local settings="$runtime_home/settings.json"
  local command="$bridge sandbox-hook --agent claude --profile $profile"
  [[ -f "$settings" && ! -L "$settings" ]] \
    || fail 'Claude SessionStart hook settings were not installed'
  jq -e --arg command "$command" '
    any(.hooks.SessionStart[]?.hooks[]?;
      .type == "command" and .command == $command
    )
  ' "$settings" >/dev/null \
    || fail 'Claude SessionStart hook settings are invalid'
}

install_session_bridge_hook

[[ "$#" -ge 2 ]] || fail 'mode and Claude command are required'
mode="$1"
shift
claude_command="$1"
shift
case "$mode" in
  new) claude_args=("$@") ;;
  prompt)
    claude_args=()
    while (( $# > 0 )) && [[ "$1" != -- ]]; do
      claude_args+=("$1")
      shift
    done
    [[ "$#" -eq 2 && "$1" == -- && -n "$2" ]] \
      || fail 'prompt mode requires exactly one prompt after --'
    claude_args+=(-p "$2")
    ;;
  resume)
    if [[ -n "$resume_session_id" ]]; then
      claude_args=(--resume "$resume_session_id" "$@")
    else
      claude_args=(--continue "$@")
    fi
    ;;
  resume-prompt)
    [[ -n "$resume_session_id" ]] || fail 'resume-prompt requires a session ID'
    claude_args=(--resume "$resume_session_id")
    while (( $# > 0 )) && [[ "$1" != -- ]]; do
      claude_args+=("$1")
      shift
    done
    [[ "$#" -eq 2 && "$1" == -- && -n "$2" ]] \
      || fail 'resume-prompt mode requires exactly one prompt after --'
    claude_args+=(-p "$2")
    ;;
  passthrough) exec "$claude_command" "$@" ;;
  *) fail "unsupported Claude launch mode: $mode" ;;
esac

browser_token="${PLAYWRIGHT_MCP_EXTENSION_TOKEN-}"
[[ "$runtime_mode" == hyperresearch ]] || browser_token=
oauth_token="${CLAUDE_CODE_OAUTH_TOKEN-}"
api_key="${ANTHROPIC_API_KEY-}"
proxy_token="${ANTHROPIC_AUTH_TOKEN-}"
proxy_base="${ANTHROPIC_BASE_URL-}"
opus_model="${ANTHROPIC_DEFAULT_OPUS_MODEL-}"
sonnet_model="${ANTHROPIC_DEFAULT_SONNET_MODEL-}"
haiku_model="${ANTHROPIC_DEFAULT_HAIKU_MODEL-}"
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL \
  ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL \
  CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  AWS_SESSION_TOKEN AWS_PROFILE GOOGLE_APPLICATION_CREDENTIALS ANTHROPIC_VERTEX_PROJECT_ID \
  CLOUD_ML_REGION AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
case "$auth_mode" in
  proxy)
    export ANTHROPIC_AUTH_TOKEN="$proxy_token" ANTHROPIC_BASE_URL="$proxy_base"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$opus_model" ANTHROPIC_DEFAULT_SONNET_MODEL="$sonnet_model"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$haiku_model"
    ;;
  native) [[ -z "$oauth_token" ]] || export CLAUDE_CODE_OAUTH_TOKEN="$oauth_token" ;;
  api-key) [[ -n "$api_key" ]] || fail 'ANTHROPIC_API_KEY is required for api-key auth'; export ANTHROPIC_API_KEY="$api_key" ;;
  *) fail "unsupported Claude auth mode: $auth_mode" ;;
esac
if [[ -n "$browser_token" ]]; then
  export PLAYWRIGHT_MCP_EXTENSION_TOKEN="$browser_token"
else
  unset PLAYWRIGHT_MCP_EXTENSION_TOKEN
fi

export CLAUDE_CONFIG_DIR="$runtime_home"
managed_args=(--dangerously-skip-permissions --settings "$default_settings")
if [[ "$output_format" == jsonl ]]; then
  managed_args+=(--output-format stream-json --verbose)
fi
if [[ "$runtime_mode" == hyperresearch ]]; then
  mcp_config="$(mktemp "${TMPDIR:-/tmp}/trellage-claude-mcp.XXXXXX.json")"
  cleanup_mcp() { rm -f -- "$mcp_config"; }
  trap cleanup_mcp EXIT HUP INT TERM
  if [[ -n "$browser_token" ]]; then
    printf '%s\n' '{"mcpServers":{"playwright":{"command":"playwright-mcp","args":["--extension"]},"obscura":{"command":"obscura","args":["mcp","--stealth"]}}}' >"$mcp_config"
  else
    printf 'trellage-claude-entry: Playwright extension token is absent; exposing Obscura only\n' >&2
    printf '%s\n' '{"mcpServers":{"obscura":{"command":"obscura","args":["mcp","--stealth"]}}}' >"$mcp_config"
  fi
  managed_args+=(--mcp-config "$mcp_config" --strict-mcp-config)
elif [[ -f /usr/local/share/trellage/claude-mcp.json ]]; then
  managed_args+=(--mcp-config /usr/local/share/trellage/claude-mcp.json)
fi
set +e
"$claude_command" "${managed_args[@]}" "${claude_args[@]}"
claude_status=$?
set -e
if [[ "$runtime_mode" == hyperresearch ]]; then
  cleanup_mcp
  trap - EXIT HUP INT TERM
fi
if [[ -n "$resume_profile" ]]; then
  if [[ -n "$resume_session_id" ]]; then
    completed_session_id="$resume_session_id"
  else
    completed_session_id="$(find_newest_session "$(pwd -P)" || true)"
  fi
  if [[ -n "$completed_session_id" ]]; then
    print_resume_hint "$completed_session_id"
  fi
fi
exit "$claude_status"
