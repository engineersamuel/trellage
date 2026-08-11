#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  printf 'usage: find-harness-session.sh codex|copilot RUNTIME_HOME CWD [SESSION_ID]\n' >&2
  exit 64
fi

runtime="$1"
runtime_home="$2"
expected_cwd="$3"
requested_id="${4:-}"

valid_session_id() {
  [[ "$1" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]
}

session_matches() {
  [[ -z "$requested_id" || "$1" == "$requested_id" ]]
}

newest_file=
newest_id=
consider_session() {
  local session_file="$1"
  local session_id="$2"

  valid_session_id "$session_id" || return
  session_matches "$session_id" || return
  if [[ -z "$newest_file" \
    || "$session_file" -nt "$newest_file" \
    || ( ! "$newest_file" -nt "$session_file" && "$session_file" > "$newest_file" ) ]]; then
    newest_file="$session_file"
    newest_id="$session_id"
  fi
}

case "$runtime" in
  codex)
    while IFS= read -r -d '' session_file; do
      [[ -f "$session_file" && ! -L "$session_file" ]] || continue
      session_id="$(jq -er --arg cwd "$expected_cwd" '
        select(.type == "session_meta")
        | .payload
        | select(.cwd == $cwd)
        | .id
      ' "$session_file" 2>/dev/null || true)"
      consider_session "$session_file" "$session_id" || true
    done < <(find "$runtime_home/sessions" -type f -name '*.jsonl' -print0 2>/dev/null)
    ;;
  copilot)
    while IFS= read -r -d '' workspace_file; do
      [[ -f "$workspace_file" && ! -L "$workspace_file" ]] || continue
      stored_cwd="$(sed -n 's/^cwd: //p; /^cwd: /q' "$workspace_file")"
      case "$stored_cwd" in
        "$expected_cwd"|"'$expected_cwd'"|"\"$expected_cwd\"") ;;
        *) continue ;;
      esac
      session_id="$(basename "$(dirname "$workspace_file")")"
      consider_session "$workspace_file" "$session_id" || true
    done < <(find "$runtime_home/session-state" -type f -name workspace.yaml -print0 2>/dev/null)
    ;;
  *)
    printf 'unsupported harness runtime: %s\n' "$runtime" >&2
    exit 64
    ;;
esac

[[ -n "$newest_id" ]] || exit 1
printf '%s\n' "$newest_id"
