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

merge_default_user_settings() {
  local settings="$1" settings_tmp

  [[ -f "$settings" && ! -L "$settings" ]] || fail 'Claude settings must be a regular file'
  settings_tmp="$runtime_home/.settings.json.trellage.$$"
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
  mv -f -- "$settings_tmp" "$settings"
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
  local ownership_root="${4:-}"
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
  if ! node - "$staging" "$destination_root" "$paths" "$ownership_root" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [stagingRoot, destinationRoot, pathsFile, ownershipRoot] = process.argv.slice(2)
const stagingPrefix = `${path.resolve(stagingRoot)}${path.sep}`
const destinationPrefix = `${path.resolve(destinationRoot)}${path.sep}`
const ownershipPrefix = ownershipRoot ? `${path.resolve(ownershipRoot)}${path.sep}` : undefined

const syncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
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
      syncDirectory(path.dirname(current))
    }
  }
}

let failed = false

try {
  const destinationStat = fs.lstatSync(destinationRoot)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new Error(`unsafe destination root: ${destinationRoot}`)
  }
  if (ownershipRoot) {
    const ownershipStat = fs.lstatSync(ownershipRoot)
    if (!ownershipStat.isDirectory() || ownershipStat.isSymbolicLink()) {
      throw new Error(`unsafe ownership root: ${ownershipRoot}`)
    }
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
      const stagedStat = fs.lstatSync(staged)
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
        throw new Error(`unsafe staged file: ${managedPath}`)
      }
      if (ownershipRoot) {
        const ownership = path.resolve(ownershipRoot, managedPath)
        if (!ownership.startsWith(ownershipPrefix)) {
          throw new Error(`unsafe ownership path: ${managedPath}`)
        }
        ensureDirectory(ownershipRoot, path.dirname(managedPath))
        fs.linkSync(staged, ownership)
      }
      ensureDirectory(destinationRoot, path.dirname(managedPath))
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
  rm -rf -- "$staging"
}

remove_owned_files() {
  local destination_root="$1"
  local ownership_root="$2"
  local quarantine_root="$3"
  local recovery_root="$4"
  local retain_marker="$5"
  local paths="$6"
  local strict_ownership="${7:-false}"
  local expected_metadata="${8:-}"
  [[ -s "$paths" ]] || return 0
  node - \
    "$destination_root" "$ownership_root" "$quarantine_root" "$recovery_root" \
    "$retain_marker" "$paths" "$strict_ownership" "$expected_metadata" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const [
  destinationRoot,
  ownershipRoot,
  quarantineRoot,
  recoveryRoot,
  retainMarker,
  pathsFile,
  strictOwnershipValue,
  expectedMetadataPath,
] = process.argv.slice(2)
const strictOwnership = strictOwnershipValue === 'true'
const destinationPrefix = `${path.resolve(destinationRoot)}${path.sep}`
const ownershipPrefix = `${path.resolve(ownershipRoot)}${path.sep}`
const quarantinePrefix = `${path.resolve(quarantineRoot)}${path.sep}`
const recoveryPrefix = `${path.resolve(recoveryRoot)}${path.sep}`
const expectedMetadata =
  strictOwnership && expectedMetadataPath
    ? new Map(
        JSON.parse(fs.readFileSync(expectedMetadataPath, 'utf8')).map((record) => [
          record.path,
          record,
        ]),
      )
    : new Map()

const syncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

const ensureDirectory = (root, relativeDirectory) => {
  let current = root
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`unsafe rollback directory: ${current}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
      syncDirectory(path.dirname(current))
    }
  }
}

const isOwnedRegularFile = (candidateStat, ownershipStat) =>
  candidateStat.isFile() &&
  !candidateStat.isSymbolicLink() &&
  ownershipStat.isFile() &&
  !ownershipStat.isSymbolicLink() &&
  candidateStat.dev === ownershipStat.dev &&
  candidateStat.ino === ownershipStat.ino

const digest = (candidate) =>
  crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')

const matchesExpectedMetadata = (
  candidateStat,
  candidate,
  managedPath,
  includeChangeTime,
) => {
  if (!strictOwnership) return true
  const expected = expectedMetadata.get(managedPath)
  return (
    expected !== undefined &&
    candidateStat.size.toString() === expected.size &&
    candidateStat.mtimeNs.toString() === expected.mtimeNs &&
    (!includeChangeTime || candidateStat.ctimeNs.toString() === expected.ctimeNs) &&
    digest(candidate) === expected.sha256
  )
}

const retainTransaction = (managedPath) => {
  const descriptor = fs.openSync(retainMarker, 'a', 0o600)
  try {
    fs.writeFileSync(descriptor, `${managedPath}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  syncDirectory(path.dirname(retainMarker))
}

const preserveUnexpectedFile = (quarantined, destination, recovered, managedPath) => {
  let restored = false
  try {
    fs.linkSync(quarantined, destination)
    restored = true
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      process.stderr.write(
        `trellage-claude-entry: could not restore concurrent path ${managedPath}: ${error.message}\n`,
      )
    }
  }
  try {
    let recoveryStat
    try {
      recoveryStat = fs.lstatSync(recoveryRoot)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(recoveryRoot, { mode: 0o700 })
      syncDirectory(path.dirname(recoveryRoot))
      recoveryStat = fs.lstatSync(recoveryRoot)
    }
    if (!recoveryStat.isDirectory() || recoveryStat.isSymbolicLink()) {
      throw new Error(`unsafe recovery root: ${recoveryRoot}`)
    }
    ensureDirectory(recoveryRoot, path.dirname(managedPath))
    fs.renameSync(quarantined, recovered)
    const recoveredStat = fs.lstatSync(recovered)
    if (recoveredStat.isFile() && !recoveredStat.isSymbolicLink()) {
      const descriptor = fs.openSync(recovered, 'r')
      try {
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
    }
    syncDirectory(path.dirname(recovered))
    if (restored) syncDirectory(path.dirname(destination))
    process.stderr.write(
      `trellage-claude-entry: preserved concurrent path ${managedPath} at ${recovered}\n`,
    )
  } catch (error) {
    retainTransaction(managedPath)
    throw new Error(`cannot preserve concurrent path ${managedPath}: ${error.message}`)
  }
}

let failed = false

for (const managedPath of fs.readFileSync(pathsFile, 'utf8').split('\n').filter(Boolean)) {
  let quarantined
  try {
    const destination = path.resolve(destinationRoot, managedPath)
    const ownership = path.resolve(ownershipRoot, managedPath)
    quarantined = path.resolve(quarantineRoot, managedPath)
    const recovered = path.resolve(recoveryRoot, managedPath)
    if (
      !destination.startsWith(destinationPrefix) ||
      !ownership.startsWith(ownershipPrefix) ||
      !quarantined.startsWith(quarantinePrefix) ||
      !recovered.startsWith(recoveryPrefix)
    ) {
      throw new Error(`unsafe managed path: ${managedPath}`)
    }
    const destinationStat = fs.lstatSync(destination, { bigint: true })
    const ownershipStat = fs.lstatSync(ownership, { bigint: true })
    if (
      !isOwnedRegularFile(destinationStat, ownershipStat) ||
      !matchesExpectedMetadata(destinationStat, destination, managedPath, true)
    ) {
      if (!strictOwnership) continue
      retainTransaction(managedPath)
      throw new Error(`managed path ownership changed: ${managedPath}`)
    }

    ensureDirectory(quarantineRoot, path.dirname(managedPath))
    fs.renameSync(destination, quarantined)
    syncDirectory(path.dirname(destination))
    syncDirectory(path.dirname(quarantined))
    const quarantinedStat = fs.lstatSync(quarantined, { bigint: true })
    if (
      !isOwnedRegularFile(quarantinedStat, ownershipStat) ||
      !matchesExpectedMetadata(quarantinedStat, quarantined, managedPath, false)
    ) {
      preserveUnexpectedFile(quarantined, destination, recovered, managedPath)
      if (strictOwnership) {
        retainTransaction(managedPath)
        failed = true
      }
    }
  } catch (error) {
    if (error?.code === 'ENOENT' && !strictOwnership) continue
    if (quarantined && fs.existsSync(quarantined)) {
      try {
        retainTransaction(managedPath)
      } catch {}
    } else if (strictOwnership) {
      try {
        retainTransaction(managedPath)
      } catch {}
    }
    failed = true
    process.stderr.write(
      `trellage-claude-entry: managed rollback failed for ${managedPath}: ${error.message}\n`,
    )
  }
}
if (failed) process.exitCode = 1
NODE
}

create_transaction_journal() {
  local destination_root="$1"
  local transaction_root="$2"
  local journal_marker="$3"
  node - "$destination_root" "$transaction_root" "$journal_marker" <<'NODE'
const fs = require('node:fs')

const [destinationRoot, transactionRoot, journalMarker] = process.argv.slice(2)
const syncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

let journalDescriptor
try {
  syncDirectory(destinationRoot)
  journalDescriptor = fs.openSync(journalMarker, 'wx', 0o600)
  fs.writeFileSync(journalDescriptor, 'managed-state transaction is active\n')
  fs.fsyncSync(journalDescriptor)
  syncDirectory(transactionRoot)
} catch (error) {
  process.stderr.write(
    `trellage-claude-entry: cannot create transaction journal: ${error.message}\n`,
  )
  process.exitCode = 1
} finally {
  if (journalDescriptor !== undefined) fs.closeSync(journalDescriptor)
}
NODE
}

sync_regular_file() {
  local candidate="$1"
  node - "$candidate" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const candidate = process.argv[2]
const candidateStat = fs.lstatSync(candidate)
if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
  throw new Error(`unsafe synchronization file: ${candidate}`)
}
let descriptor = fs.openSync(candidate, 'r')
try {
  fs.fsyncSync(descriptor)
} finally {
  fs.closeSync(descriptor)
}
descriptor = fs.openSync(path.dirname(candidate), 'r')
try {
  fs.fsyncSync(descriptor)
} finally {
  fs.closeSync(descriptor)
}
NODE
}

sync_directory() {
  local candidate="$1"
  node - "$candidate" <<'NODE'
const fs = require('node:fs')

const candidate = process.argv[2]
const candidateStat = fs.lstatSync(candidate)
if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
  throw new Error(`unsafe synchronization directory: ${candidate}`)
}
const descriptor = fs.openSync(candidate, 'r')
try {
  fs.fsyncSync(descriptor)
} finally {
  fs.closeSync(descriptor)
}
NODE
}

sync_filesystem() {
  local candidate="$1"
  if sync -f "$candidate" 2>/dev/null; then
    return 0
  fi
  sync
}

snapshot_managed_files() {
  local source_root="$1"
  local ownership_root="$2"
  local backup_root="$3"
  local paths="$4"
  local metadata="$5"
  node - \
    "$source_root" "$ownership_root" "$backup_root" "$paths" "$metadata" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const [sourceRoot, ownershipRoot, backupRoot, pathsFile, metadata] =
  process.argv.slice(2)
const sourcePrefix = `${path.resolve(sourceRoot)}${path.sep}`
const ownershipPrefix = `${path.resolve(ownershipRoot)}${path.sep}`
const backupPrefix = `${path.resolve(backupRoot)}${path.sep}`
const syncedDirectories = new Set()
const records = []
let failed = false

const syncDirectory = (directory) => {
  if (syncedDirectories.has(directory)) return
  const descriptor = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(descriptor)
    syncedDirectories.add(directory)
  } finally {
    fs.closeSync(descriptor)
  }
}

const ensureDirectory = (root, relativeDirectory) => {
  let current = root
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`unsafe snapshot directory: ${current}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
      syncDirectory(path.dirname(current))
    }
  }
}

const digest = (candidate) =>
  crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')

for (const managedPath of fs.readFileSync(pathsFile, 'utf8').split('\n').filter(Boolean)) {
  try {
    const source = path.resolve(sourceRoot, managedPath)
    const ownership = path.resolve(ownershipRoot, managedPath)
    const backup = path.resolve(backupRoot, managedPath)
    if (
      !source.startsWith(sourcePrefix) ||
      !ownership.startsWith(ownershipPrefix) ||
      !backup.startsWith(backupPrefix)
    ) {
      throw new Error(`unsafe managed path: ${managedPath}`)
    }
    const sourceStat = fs.lstatSync(source, { bigint: true })
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`unsafe managed source: ${managedPath}`)
    }
    ensureDirectory(ownershipRoot, path.dirname(managedPath))
    ensureDirectory(backupRoot, path.dirname(managedPath))
    fs.linkSync(source, ownership)
    const ownershipStat = fs.lstatSync(ownership, { bigint: true })
    const linkedSourceStat = fs.lstatSync(source, { bigint: true })
    if (
      ownershipStat.dev !== sourceStat.dev ||
      ownershipStat.ino !== sourceStat.ino ||
      linkedSourceStat.dev !== sourceStat.dev ||
      linkedSourceStat.ino !== sourceStat.ino
    ) {
      throw new Error(`managed source changed before snapshotting: ${managedPath}`)
    }
    fs.copyFileSync(ownership, backup, fs.constants.COPYFILE_FICLONE)
    fs.chmodSync(backup, Number(ownershipStat.mode & 0o777n))
    const currentSourceStat = fs.lstatSync(source, { bigint: true })
    const sourceDigest = digest(ownership)
    const backupDigest = digest(backup)
    if (
      currentSourceStat.dev !== ownershipStat.dev ||
      currentSourceStat.ino !== ownershipStat.ino ||
      currentSourceStat.size !== ownershipStat.size ||
      currentSourceStat.mtimeNs !== ownershipStat.mtimeNs ||
      currentSourceStat.ctimeNs !== ownershipStat.ctimeNs ||
      backupDigest !== sourceDigest
    ) {
      throw new Error(`managed source changed while snapshotting: ${managedPath}`)
    }
    syncDirectory(path.dirname(ownership))
    syncDirectory(path.dirname(backup))
    records.push({
      path: managedPath,
      size: currentSourceStat.size.toString(),
      mtimeNs: currentSourceStat.mtimeNs.toString(),
      ctimeNs: currentSourceStat.ctimeNs.toString(),
      sha256: sourceDigest,
    })
  } catch (error) {
    failed = true
    process.stderr.write(
      `trellage-claude-entry: managed snapshot failed for ${managedPath}: ${error.message}\n`,
    )
  }
}
if (!failed) {
  const descriptor = fs.openSync(metadata, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(records)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  syncDirectory(path.dirname(metadata))
} else {
  process.exitCode = 1
}
NODE
}

validate_managed_files() {
  local root="$1"
  local paths="$2"
  [[ -s "$paths" ]] || return 0
  node - "$root" "$paths" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [root, pathsFile] = process.argv.slice(2)
const rootPrefix = `${path.resolve(root)}${path.sep}`
let failed = false

for (const managedPath of fs.readFileSync(pathsFile, 'utf8').split('\n').filter(Boolean)) {
  try {
    const candidate = path.resolve(root, managedPath)
    if (!candidate.startsWith(rootPrefix)) {
      throw new Error(`unsafe managed path: ${managedPath}`)
    }
    const candidateStat = fs.lstatSync(candidate)
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
      throw new Error(`unsafe managed file: ${managedPath}`)
    }
  } catch (error) {
    failed = true
    process.stderr.write(
      `trellage-claude-entry: managed file validation failed for ${managedPath}: ${error.message}\n`,
    )
  }
}
if (failed) process.exitCode = 1
NODE
}

verify_owned_files() {
  local destination_root="$1"
  local ownership_root="$2"
  local paths="$3"
  [[ -s "$paths" ]] || return 0
  node - "$destination_root" "$ownership_root" "$paths" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [destinationRoot, ownershipRoot, pathsFile] = process.argv.slice(2)
const destinationPrefix = `${path.resolve(destinationRoot)}${path.sep}`
const ownershipPrefix = `${path.resolve(ownershipRoot)}${path.sep}`
let failed = false

for (const managedPath of fs.readFileSync(pathsFile, 'utf8').split('\n').filter(Boolean)) {
  try {
    const destination = path.resolve(destinationRoot, managedPath)
    const ownership = path.resolve(ownershipRoot, managedPath)
    if (!destination.startsWith(destinationPrefix) || !ownership.startsWith(ownershipPrefix)) {
      throw new Error(`unsafe managed path: ${managedPath}`)
    }
    const destinationStat = fs.lstatSync(destination)
    const ownershipStat = fs.lstatSync(ownership)
    if (
      !destinationStat.isFile() ||
      destinationStat.isSymbolicLink() ||
      !ownershipStat.isFile() ||
      ownershipStat.isSymbolicLink() ||
      destinationStat.dev !== ownershipStat.dev ||
      destinationStat.ino !== ownershipStat.ino
    ) {
      throw new Error(`restored file ownership does not match: ${managedPath}`)
    }
  } catch (error) {
    failed = true
    process.stderr.write(
      `trellage-claude-entry: managed restore verification failed for ${managedPath}: ${error.message}\n`,
    )
  }
}
if (failed) process.exitCode = 1
NODE
}

command -v tar >/dev/null 2>&1 || fail 'tar is required to synchronize Claude managed files'
command -v node >/dev/null 2>&1 || fail 'node is required to synchronize Claude managed files'
command -v mktemp >/dev/null 2>&1 || fail 'mktemp is required to synchronize Claude managed files'
command -v sync >/dev/null 2>&1 || fail 'sync is required to synchronize Claude managed files'

manifest="$runtime_home/.trellage-claude-managed"
legacy_manifest="$runtime_home/.trellage-hyperresearch-managed"
lock_dir="$runtime_home/.trellage-claude.lock"
lock_active=false
for _attempt in {1..200}; do
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    lock_active=true
    break
  fi
  if [[ -f "$lock_dir/pid" ]]; then
    lock_pid="$(sed -n '1p' "$lock_dir/pid")"
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -rf -- "$lock_dir"
      continue
    fi
  fi
  sleep 0.05
done
[[ "$lock_active" == true ]] || fail 'cannot acquire Claude managed-state lock'

while IFS= read -r -d '' stale_transaction; do
  [[ "$stale_transaction" == "$runtime_home"/.trellage-claude-transaction.* \
    && -d "$stale_transaction" && ! -L "$stale_transaction" ]] \
    || fail "unsafe stale Claude transaction: $stale_transaction"
  if [[ -e "$stale_transaction/transaction-journal" \
    || -L "$stale_transaction/transaction-journal" \
    || -e "$stale_transaction/rollback-journal" \
    || -L "$stale_transaction/rollback-journal" \
    || -e "$stale_transaction/rollback-retain" \
    || -L "$stale_transaction/rollback-retain" ]]; then
    rm -rf -- "$lock_dir"
    lock_active=false
    fail "incomplete Claude rollback requires manual recovery: $stale_transaction"
  fi
  rm -rf -- "$stale_transaction"
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
managed_backup="$transaction/managed-backup"
prior_metadata="$transaction/prior-metadata.json"
prior_ownership="$transaction/prior-ownership"
published="$transaction/published"
restored="$transaction/restored"
prior_removed_root="$transaction/prior-removed"
rollback_removed="$transaction/rollback-removed"
transaction_journal="$transaction/transaction-journal"
rollback_retain="$transaction/rollback-retain"
prior_recovery="$runtime_home/.trellage-claude-recovery.${transaction##*.}.prior"
rollback_recovery="$runtime_home/.trellage-claude-recovery.${transaction##*.}.rollback"
prior_present="$transaction/prior-present"
mkdir -p \
  "$backup" "$managed_backup" "$prior_ownership" "$published" "$restored" \
  "$prior_removed_root" "$rollback_removed"
: >"$prior_present"
transaction_active=true
prior_removed=false
settings_created=false
settings_replaced=false
marketplaces_created=false
marketplaces_replaced=false
global_state_created=false
global_state_replaced=false
manifest_created=false
manifest_replaced=false

rollback_sync() {
  local managed_path retain_transaction=false rollback_restore
  if [[ "$manifest_created" == true ]]; then
    rm -f -- "$manifest"
    sync_directory "$runtime_home" 2>/dev/null || retain_transaction=true
  elif [[ "$manifest_replaced" == true \
    && -f "$backup/.trellage-claude-managed" ]]; then
    mv -f -- "$backup/.trellage-claude-managed" "$manifest" 2>/dev/null \
      || retain_transaction=true
    sync_regular_file "$manifest" 2>/dev/null || retain_transaction=true
  fi
  if [[ "$global_state_created" == true ]]; then
    rm -f -- "$global_state"
    sync_directory "$(dirname "$global_state")" 2>/dev/null \
      || retain_transaction=true
  elif [[ "$global_state_replaced" == true && -f "$backup/.claude.json" ]]; then
    mv -f -- "$backup/.claude.json" "$global_state" 2>/dev/null \
      || retain_transaction=true
    sync_regular_file "$global_state" 2>/dev/null || retain_transaction=true
  fi
  if [[ "$settings_created" == true ]]; then
    rm -f -- "$runtime_home/settings.json"
    sync_directory "$runtime_home" 2>/dev/null || retain_transaction=true
  elif [[ "$settings_replaced" == true && -f "$backup/settings.json" ]]; then
    mv -f -- "$backup/settings.json" "$runtime_home/settings.json" 2>/dev/null \
      || retain_transaction=true
    sync_regular_file "$runtime_home/settings.json" 2>/dev/null \
      || retain_transaction=true
  fi
  if [[ "$marketplaces_created" == true ]]; then
    rm -f -- "$runtime_home/plugins/known_marketplaces.json"
    sync_directory "$runtime_home/plugins" 2>/dev/null || retain_transaction=true
  elif [[ "$marketplaces_replaced" == true && -f "$backup/plugins/known_marketplaces.json" ]]; then
    mv -f -- "$backup/plugins/known_marketplaces.json" \
      "$runtime_home/plugins/known_marketplaces.json" 2>/dev/null \
      || retain_transaction=true
    sync_regular_file "$runtime_home/plugins/known_marketplaces.json" 2>/dev/null \
      || retain_transaction=true
  fi
  remove_owned_files \
    "$runtime_home" "$published" "$rollback_removed" "$rollback_recovery" \
    "$rollback_retain" "$new_manifest" false \
    || retain_transaction=true
  if [[ -e "$rollback_retain" || -L "$rollback_retain" ]]; then
    retain_transaction=true
  fi
  if [[ "$prior_removed" == true ]]; then
    if [[ ! -f "$prior_present" || -L "$prior_present" ]]; then
      retain_transaction=true
    else
      rollback_restore="$transaction/rollback-restore"
      : >"$rollback_restore"
      if ! while IFS= read -r managed_path; do
        if ! validate_managed_path "$managed_path"; then
          retain_transaction=true
          continue
        fi
        if [[ ! -f "$managed_backup/$managed_path" \
          || -L "$managed_backup/$managed_path" ]]; then
          retain_transaction=true
          continue
        fi
        if ! ensure_runtime_parent "$managed_path"; then
          retain_transaction=true
          continue
        fi
        printf '%s\n' "$managed_path" >>"$rollback_restore"
      done <"$prior_present" 2>/dev/null; then
        retain_transaction=true
      fi
      if ! copy_managed_files \
        "$managed_backup" "$runtime_home" "$rollback_restore" "$restored" \
        2>/dev/null; then
        retain_transaction=true
      fi
      if ! verify_owned_files \
        "$runtime_home" "$restored" "$rollback_restore" 2>/dev/null; then
        retain_transaction=true
      fi
    fi
  fi
  sync_filesystem "$runtime_home" 2>/dev/null || retain_transaction=true
  sync_filesystem "$(dirname "$global_state")" 2>/dev/null \
    || retain_transaction=true
  transaction_active=false
  if [[ "$retain_transaction" == true ]]; then
    printf 'trellage-claude-entry: retained rollback data for manual recovery: %s\n' \
      "$transaction" >&2
  else
    rm -f -- "$transaction_journal"
    rm -rf -- "$transaction"
    sync_directory "$runtime_home" 2>/dev/null || {
      printf 'trellage-claude-entry: cannot finalize rollback cleanup\n' >&2
    }
  fi
}

cleanup_on_exit() {
  local status=$?
  if [[ "$transaction_active" == true ]]; then rollback_sync; fi
  if [[ "$lock_active" == true ]]; then rm -rf -- "$lock_dir"; fi
  exit "$status"
}
trap cleanup_on_exit EXIT HUP INT TERM
create_transaction_journal "$runtime_home" "$transaction" "$transaction_journal" \
  || fail 'cannot create Claude managed-state transaction journal'

prior_manifest="$manifest"
if [[ ! -e "$prior_manifest" && ! -L "$prior_manifest" && -f "$legacy_manifest" && ! -L "$legacy_manifest" ]]; then
  prior_manifest="$legacy_manifest"
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

sync_regular_file "$prior_present" \
  || fail 'cannot make Claude prior-file recovery metadata durable'
snapshot_managed_files \
  "$runtime_home" "$prior_ownership" "$managed_backup" \
  "$prior_present" "$prior_metadata" \
  || fail 'cannot snapshot Claude managed-state backup'
sync_filesystem "$runtime_home" \
  || fail 'cannot make Claude managed-state snapshot durable'
while IFS= read -r managed_path; do
  [[ -f "$prior_ownership/$managed_path" && ! -L "$prior_ownership/$managed_path" ]] \
    || fail "failed to record managed Claude file ownership: $managed_path"
done <"$prior_present"
prior_removed=true
remove_owned_files \
  "$runtime_home" "$prior_ownership" "$prior_removed_root" "$prior_recovery" \
  "$rollback_retain" "$prior_present" true "$prior_metadata" \
  || fail 'cannot remove prior managed Claude files'

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
if [[ ! -e "$settings" && ! -L "$settings" ]]; then
  settings_tmp="$runtime_home/.settings.json.trellage.$$"
  cp -- "$default_settings" "$settings_tmp"
  chmod 600 "$settings_tmp"
  mv -n -- "$settings_tmp" "$settings"
  if [[ -e "$settings_tmp" || -L "$settings_tmp" ]]; then
    rm -f -- "$settings_tmp"
  else
    settings_created=true
  fi
fi
if [[ "$settings_created" == false ]]; then
  [[ -f "$settings" && ! -L "$settings" ]] || fail 'Claude settings must be a regular file'
  cp -- "$settings" "$backup/settings.json"
  sync_regular_file "$backup/settings.json" \
    || fail 'cannot make Claude settings backup durable'
  settings_replaced=true
fi
merge_default_user_settings "$settings"
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
  [[ -f "$settings" && ! -L "$settings" ]] || fail 'Claude settings must be a regular file'
  jq -e 'type == "object"' "$settings" >/dev/null || fail 'Claude settings are invalid'
  if [[ "$settings_created" == false && "$settings_replaced" == false ]]; then
    cp -- "$settings" "$backup/settings.json"
    sync_regular_file "$backup/settings.json" \
      || fail 'cannot make Claude settings backup durable'
    settings_replaced=true
  fi
  settings_tmp="$runtime_home/.settings.json.trellage.$$"
  jq -S --slurpfile plugin "$plugin_settings" \
    '.enabledPlugins = ((.enabledPlugins // {}) + $plugin[0].enabledPlugins)
    | if $plugin[0].pluginConfigs == null
      then .
      else .pluginConfigs = ((.pluginConfigs // {}) + $plugin[0].pluginConfigs)
      end' \
    "$settings" >"$settings_tmp"
  chmod 600 "$settings_tmp"
  mv -f -- "$settings_tmp" "$settings"
fi
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
  if [[ -e "$marketplace_registry" || -L "$marketplace_registry" ]]; then
    [[ -f "$marketplace_registry" && ! -L "$marketplace_registry" ]] \
      || fail 'Claude marketplace registry must be a regular file'
    jq -e 'type == "object"' "$marketplace_registry" >/dev/null \
      || fail 'Claude marketplace registry is invalid'
    mkdir -p "$backup/plugins"
    sync_directory "$backup" \
      || fail 'cannot make Claude marketplace backup directory durable'
    cp -- "$marketplace_registry" "$backup/plugins/known_marketplaces.json"
    sync_regular_file "$backup/plugins/known_marketplaces.json" \
      || fail 'cannot make Claude marketplace backup durable'
    marketplaces_replaced=true
  else
    printf '{}\n' >"$marketplace_registry"
    chmod 600 "$marketplace_registry"
    marketplaces_created=true
  fi
  marketplaces_tmp="$runtime_home/plugins/.known_marketplaces.json.trellage.$$"
  jq -S --slurpfile managed "$plugin_marketplaces" \
    '. + $managed[0]' "$marketplace_registry" >"$marketplaces_tmp"
  chmod 600 "$marketplaces_tmp"
  mv -f -- "$marketplaces_tmp" "$marketplace_registry"
fi
if [[ -e "$global_state" || -L "$global_state" ]]; then
  [[ -f "$global_state" && ! -L "$global_state" ]] \
    || fail 'Claude global state must be a regular file'
  jq -e 'type == "object"' "$global_state" >/dev/null || fail 'Claude global state is invalid'
  cp -- "$global_state" "$backup/.claude.json"
  sync_regular_file "$backup/.claude.json" \
    || fail 'cannot make Claude global-state backup durable'
  global_state_replaced=true
  global_state_tmp="$runtime_home/.claude.json.trellage.$$"
  jq -S --arg workspace "$workspace" --slurpfile defaults "$default_onboarding" '
    $defaults[0] + .
    | .projects = (
        (.projects // {})
        | .[$workspace] = ((.[$workspace] // {}) + {"hasTrustDialogAccepted": true})
      )
  ' "$global_state" >"$global_state_tmp"
else
  global_state_tmp="$runtime_home/.claude.json.trellage.$$"
  jq -S --arg workspace "$workspace" '
    .projects = {($workspace): {"hasTrustDialogAccepted": true}}
  ' "$default_onboarding" >"$global_state_tmp"
  global_state_created=true
fi
chmod 600 "$global_state_tmp"
mv -f -- "$global_state_tmp" "$global_state"
manifest_tmp="$runtime_home/.trellage-claude-managed.$$"
cp -- "$new_manifest" "$manifest_tmp"
if [[ -e "$manifest" || -L "$manifest" ]]; then
  [[ -f "$manifest" && ! -L "$manifest" ]] \
    || fail 'Claude managed-path manifest is unsafe'
  cp -- "$manifest" "$backup/.trellage-claude-managed"
  sync_regular_file "$backup/.trellage-claude-managed" \
    || fail 'cannot make Claude managed-path manifest backup durable'
  manifest_replaced=true
else
  manifest_created=true
fi
mv -f -- "$manifest_tmp" "$manifest"
validate_managed_files "$runtime_home" "$new_manifest" \
  || fail 'managed Claude file validation failed'
sync_regular_file "$settings" \
  || fail 'cannot make Claude settings durable'
marketplace_registry="$runtime_home/plugins/known_marketplaces.json"
if [[ -e "$marketplace_registry" || -L "$marketplace_registry" ]]; then
  [[ -f "$marketplace_registry" && ! -L "$marketplace_registry" ]] \
    || fail 'Claude marketplace registry must be a regular file'
  sync_regular_file "$marketplace_registry" \
    || fail 'cannot make Claude marketplace registry durable'
fi
sync_regular_file "$global_state" \
  || fail 'cannot make Claude global state durable'
sync_regular_file "$manifest" \
  || fail 'cannot make Claude managed-path manifest durable'
sync_directory "$runtime_home" \
  || fail 'cannot make Claude managed-state directory durable'
sync_filesystem "$runtime_home" \
  || fail 'cannot make Claude managed-state commit durable'
sync_filesystem "$(dirname "$global_state")" \
  || fail 'cannot make Claude global-state commit durable'
transaction_active=false
settings_created=false
settings_replaced=false
global_state_created=false
global_state_replaced=false
manifest_created=false
manifest_replaced=false
rm -f -- "$transaction_journal"
rm -rf -- "$transaction"
sync_directory "$runtime_home" \
  || fail 'cannot finalize Claude managed-state transaction'
rm -f -- "$legacy_manifest"
sync_directory "$runtime_home" \
  || fail 'cannot finalize Claude legacy managed-state cleanup'
rm -rf -- "$lock_dir"
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
