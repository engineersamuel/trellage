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
resume_profile="${TRELLAGE_RESUME_PROFILE-}"
resume_session_id="${TRELLAGE_RESUME_SESSION_ID-}"
unset TRELLAGE_RESUME_PROFILE TRELLAGE_RESUME_SESSION_ID
if [[ -n "$resume_session_id" \
  && ! "$resume_session_id" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
  fail 'resume session ID must be a UUID'
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
  [[ -n "$resume_profile" ]] || return 0
  printf '\nResume this conversation:\n'
  printf 'trellage resume --profile %q %q\n' "$resume_profile" "$session_id"
}
case "$claude_mode" in
  core|hyperresearch) ;;
  *) fail "unsupported Claude profile mode: $claude_mode" ;;
esac
[[ "$seed_home" == /* && "$runtime_home" == /* ]] || fail 'Claude homes must be absolute paths'
[[ -d "$seed_home" && ! -L "$seed_home" ]] || fail "missing baked Claude seed: $seed_home"
if [[ "$claude_mode" == hyperresearch ]]; then
  [[ -f "$seed_home/managed-paths.txt" && ! -L "$seed_home/managed-paths.txt" ]] \
    || fail 'baked Claude managed-path manifest is missing or unsafe'
fi
default_settings="$seed_home/default-settings.json"
[[ -f "$default_settings" && ! -L "$default_settings" ]] \
  || fail 'baked Claude default settings are missing or unsafe'
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
mkdir -p "$runtime_home"
[[ -d "$runtime_home" && ! -L "$runtime_home" ]] || fail 'Claude runtime home must be a directory'

if [[ "$claude_mode" == core ]]; then
  settings="$runtime_home/settings.json"
  if [[ ! -e "$settings" && ! -L "$settings" ]]; then
    settings_tmp="$runtime_home/.settings.json.trellage.$$"
    cp -- "$default_settings" "$settings_tmp"
    chmod 600 "$settings_tmp"
    mv -n -- "$settings_tmp" "$settings"
    rm -f -- "$settings_tmp"
  fi
fi

if [[ "$claude_mode" == hyperresearch ]]; then
validate_managed_path() {
  local candidate="$1"
  [[ -n "$candidate" && "$candidate" != /* && "$candidate" != *'//'*
    && "$candidate" != . && "$candidate" != .. && "$candidate" != ./* && "$candidate" != ../*
    && "$candidate" != */. && "$candidate" != */.. && "$candidate" != *'/./'* && "$candidate" != *'/../'*
    && "$candidate" != *'\'* ]] || return 1
  case "$candidate" in
    skills/hyperresearch|skills/hyperresearch/*|agents/hyperresearch-*.md) ;;
    *) return 1 ;;
  esac
}

manifest="$runtime_home/.trellage-hyperresearch-managed"
lock_dir="$runtime_home/.trellage-hyperresearch.lock"
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

new_manifest="$seed_home/managed-paths.txt"
cmp -s "$new_manifest" <(LC_ALL=C sort -u "$new_manifest") \
  || fail 'baked Claude managed-path manifest is not sorted and unique'
while IFS= read -r managed_path; do
  validate_managed_path "$managed_path" || fail "unsafe managed Claude seed path: $managed_path"
  [[ -f "$seed_home/$managed_path" && ! -L "$seed_home/$managed_path" ]] \
    || fail "missing managed Claude seed file: $managed_path"
done <"$new_manifest"

transaction="$runtime_home/.trellage-hyperresearch-transaction.$$"
backup="$transaction/backup"
placed="$transaction/placed"
mkdir -p "$backup"
: >"$placed"
transaction_active=true
settings_created=false

rollback_sync() {
  local managed_path
  if [[ "$settings_created" == true ]]; then
    rm -f -- "$runtime_home/settings.json"
  fi
  while IFS= read -r managed_path; do
    [[ -n "$managed_path" ]] || continue
    rm -f -- "$runtime_home/$managed_path"
  done <"$placed" 2>/dev/null || true
  if [[ -d "$backup" ]]; then
    while IFS= read -r -d '' restored; do
      managed_path="${restored#"$backup/"}"
      mkdir -p "$(dirname "$runtime_home/$managed_path")"
      mv -f -- "$restored" "$runtime_home/$managed_path" 2>/dev/null || true
    done < <(find "$backup" -type f -print0 2>/dev/null)
  fi
  rm -rf -- "$transaction"
}

cleanup_on_exit() {
  local status=$?
  if [[ "$transaction_active" == true ]]; then rollback_sync; fi
  if [[ "$lock_active" == true ]]; then rm -rf -- "$lock_dir"; fi
  exit "$status"
}
trap cleanup_on_exit EXIT HUP INT TERM

if [[ -f "$manifest" && ! -L "$manifest" ]]; then
  while IFS= read -r managed_path; do
    validate_managed_path "$managed_path" || fail "unsafe prior managed Claude path: $managed_path"
    if [[ -e "$runtime_home/$managed_path" || -L "$runtime_home/$managed_path" ]]; then
      [[ -f "$runtime_home/$managed_path" && ! -L "$runtime_home/$managed_path" ]] \
        || fail "managed Claude destination is unsafe: $managed_path"
      mkdir -p "$backup/$(dirname "$managed_path")"
      mv -- "$runtime_home/$managed_path" "$backup/$managed_path"
    fi
  done <"$manifest"
elif [[ -e "$manifest" || -L "$manifest" ]]; then
  fail 'Claude managed-path manifest is unsafe'
fi

while IFS= read -r managed_path; do
  destination="$runtime_home/$managed_path"
  [[ ! -e "$destination" && ! -L "$destination" ]] \
    || fail "managed Claude destination collides with an unmanaged path: $managed_path"
  mkdir -p "$(dirname "$destination")"
  temporary="$(dirname "$destination")/.trellage.$(basename "$destination").$$"
  cp -- "$seed_home/$managed_path" "$temporary"
  mv -- "$temporary" "$destination"
  printf '%s\n' "$managed_path" >>"$placed"
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
manifest_tmp="$runtime_home/.trellage-hyperresearch-managed.$$"
cp -- "$new_manifest" "$manifest_tmp"
mv -f -- "$manifest_tmp" "$manifest"
transaction_active=false
settings_created=false
rm -rf -- "$transaction"
rm -rf -- "$lock_dir"
lock_active=false
trap - EXIT HUP INT TERM
fi

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
  passthrough) exec "$claude_command" "$@" ;;
  *) fail "unsupported Claude launch mode: $mode" ;;
esac

browser_token="${PLAYWRIGHT_MCP_EXTENSION_TOKEN-}"
[[ "$claude_mode" == hyperresearch ]] || browser_token=
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

mcp_config=
cleanup_mcp() { [[ -z "$mcp_config" ]] || rm -f -- "$mcp_config"; }
managed_args=(--dangerously-skip-permissions --settings "$default_settings")
if [[ "$claude_mode" == hyperresearch ]]; then
  mcp_config="$(mktemp "${TMPDIR:-/tmp}/trellage-claude-mcp.XXXXXX.json")"
  trap cleanup_mcp EXIT HUP INT TERM
  if [[ -n "$browser_token" ]]; then
    printf '%s\n' '{"mcpServers":{"playwright":{"command":"playwright-mcp","args":["--extension"]},"obscura":{"command":"obscura","args":["mcp","--stealth"]}}}' >"$mcp_config"
  else
    printf 'trellage-claude-entry: Playwright extension token is absent; exposing Obscura only\n' >&2
    printf '%s\n' '{"mcpServers":{"obscura":{"command":"obscura","args":["mcp","--stealth"]}}}' >"$mcp_config"
  fi
  managed_args+=(--mcp-config "$mcp_config" --strict-mcp-config)
fi

export CLAUDE_CONFIG_DIR="$runtime_home"
set +e
"$claude_command" "${managed_args[@]}" "${claude_args[@]}"
claude_status=$?
set -e
cleanup_mcp
trap - EXIT HUP INT TERM
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
