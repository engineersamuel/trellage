#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'trellage-codex-entry: %s\n' "$1" >&2
  exit "${2:-1}"
}

valid_thread_id() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

session_thread_id() {
  local session_file="$1"
  local expected_cwd="$2"
  jq -er --arg cwd "$expected_cwd" '
    select(.type == "session_meta")
    | .payload
    | select(.cwd == $cwd)
    | .id
  ' "$session_file" 2>/dev/null
}

find_newest_session() {
  local expected_cwd="$1"
  local newer_than="${2:-}"
  local session_file session_id newest_file= newest_id=

  while IFS= read -r -d '' session_file; do
    if [[ -n "$newer_than" && ! "$session_file" -nt "$newer_than" ]]; then
      continue
    fi
    session_id="$(session_thread_id "$session_file" "$expected_cwd" || true)"
    valid_thread_id "$session_id" || continue
    if [[ -z "$newest_file" \
      || "$session_file" -nt "$newest_file" \
      || ( ! "$newest_file" -nt "$session_file" \
        && "$session_file" > "$newest_file" ) ]]; then
      newest_file="$session_file"
      newest_id="$session_id"
    fi
  done < <(find "$runtime_home/sessions" -type f -name '*.jsonl' -print0 2>/dev/null)

  [[ -n "$newest_id" ]] || return 1
  printf '%s\n' "$newest_id"
}

find_session_by_id() {
  local expected_cwd="$1"
  local expected_id="$2"
  local session_file session_id

  while IFS= read -r -d '' session_file; do
    session_id="$(session_thread_id "$session_file" "$expected_cwd" || true)"
    if [[ "$session_id" == "$expected_id" ]]; then
      return 0
    fi
  done < <(find "$runtime_home/sessions" -type f -name '*.jsonl' -print0 2>/dev/null)
  return 1
}

record_thread_id() {
  local thread_id="$1"
  local metadata_tmp="$metadata_dir/.last-thread-id.$$"
  printf '%s\n' "$thread_id" >"$metadata_tmp" || return
  mv -f "$metadata_tmp" "$thread_file"
}

missing_session() {
  fail 'no resumable native Codex session for this worktree; start a new session with: trellage' 66
}

seed_home="${TRELLAGE_CODEX_SEED_HOME:-/home/agent/.codex}"
runtime_home="${TRELLAGE_CODEX_HOME:-${CODEX_HOME:-/home/agent/.codex}}"

[[ "$runtime_home" == /* ]] || fail 'TRELLAGE_CODEX_HOME must be an absolute path'
[[ "$seed_home" == /* ]] || fail 'TRELLAGE_CODEX_SEED_HOME must be an absolute path'
[[ -d "$seed_home" ]] || fail "missing baked Codex seed: $seed_home"
[[ "$#" -gt 0 ]] || fail 'a command is required'

if [[ "$runtime_home" != "$seed_home" ]]; then
  seed_marker="$runtime_home/.trellage-seed-v1"
  if [[ ! -f "$seed_marker" ]]; then
    mkdir -p "$runtime_home"
    cp -R "$seed_home/." "$runtime_home/"
    : >"$seed_marker"
  fi
fi

export CODEX_HOME="$runtime_home"
metadata_dir="$runtime_home/.trellage-codex"
thread_file="$metadata_dir/last-thread-id"
worktree="$(pwd -P)"

mode="$1"
case "$mode" in
  new|resume|passthrough) shift ;;
  prompt)
    shift
    [[ "$#" -gt 0 ]] || fail 'prompt mode requires a Codex command'
    prompt_command="$1"
    shift
    prompt_args=()
    while (( $# > 0 )) && [[ "$1" != -- ]]; do
      prompt_args+=("$1")
      shift
    done
    [[ "$#" -eq 2 && "$1" == -- && -n "$2" ]] \
      || fail 'prompt mode requires exactly one prompt after --'
    prompt="$2"
    set -- "$prompt_command" exec "${prompt_args[@]}" -- "$prompt"
    mode=new
    ;;
  *) mode=passthrough ;;
esac
[[ "$#" -gt 0 ]] || fail 'a command is required'

if [[ "$mode" == passthrough ]]; then
  exec "$@"
fi

command -v jq >/dev/null 2>&1 || fail 'jq is required for native session discovery'
umask 077
mkdir -p "$metadata_dir"

if [[ "$mode" == resume ]]; then
  if [[ -f "$thread_file" ]]; then
    thread_id="$(sed -n '1p' "$thread_file")"
    valid_thread_id "$thread_id" || missing_session
    find_session_by_id "$worktree" "$thread_id" || missing_session
  else
    thread_id="$(find_newest_session "$worktree" || true)"
    [[ -n "$thread_id" ]] || missing_session
    record_thread_id "$thread_id" \
      || fail 'recovered native session but could not record its thread ID' 74
  fi
  exec "$@" resume "$thread_id"
fi

marker="$metadata_dir/.session-start.$$"
: >"$marker"
previous_thread="$(find_newest_session "$worktree" || true)"
set +e
"$@"
codex_status=$?
set -e

thread_id="$(find_newest_session "$worktree" "$marker" || true)"
if [[ -z "$thread_id" ]]; then
  newest_thread="$(find_newest_session "$worktree" || true)"
  if [[ -n "$newest_thread" && "$newest_thread" != "$previous_thread" ]]; then
    thread_id="$newest_thread"
  fi
fi
rm -f "$marker"

metadata_status=0
if [[ -n "$thread_id" ]] && ! record_thread_id "$thread_id"; then
  printf 'trellage-codex-entry: native session exists but its thread ID could not be recorded\n' >&2
  metadata_status=74
fi

if [[ "$codex_status" -ne 0 ]]; then
  exit "$codex_status"
fi
exit "$metadata_status"
