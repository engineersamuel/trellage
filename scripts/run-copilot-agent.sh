#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  printf 'usage: run-copilot-agent.sh (--new|--resume) <Copilot prompt>\n' >&2
  exit 64
fi

session_mode="$1"
shift
prompt="$*"

case "$session_mode" in
  --new | --resume) ;;
  *)
    printf 'unknown session mode: %s\n' "$session_mode" >&2
    exit 64
    ;;
esac

secret_file='/run/secrets/copilot_token'
[[ -r "$secret_file" ]] || {
  printf 'native Copilot authentication secret is unavailable\n' >&2
  exit 67
}

copilot_token="$(<"$secret_file")"
[[ -n "$copilot_token" ]] || {
  printf 'native Copilot authentication secret is empty\n' >&2
  exit 67
}

export COPILOT_GITHUB_TOKEN="$copilot_token"
unset copilot_token
unset COPILOT_PROVIDER_BASE_URL
unset COPILOT_PROVIDER_TYPE
unset COPILOT_PROVIDER_API_KEY
unset COPILOT_PROVIDER_BEARER_TOKEN
unset COPILOT_PROVIDER_WIRE_API
unset COPILOT_PROVIDER_WIRE_MODEL
unset COPILOT_OFFLINE

mkdir -p /workspace/.harness/copilot-logs
session_file='/workspace/.harness/copilot-session-id'
events_file='/workspace/.harness/copilot-events.jsonl'
last_message_file='/workspace/.harness/copilot-last-message.md'
runtime_file='/workspace/.harness/copilot-runtime.json'
started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

plugin_args=()
for plugin_dir in /opt/awesome-plugins/*; do
  [[ -d "$plugin_dir" ]] || continue
  plugin_args+=(--plugin-dir "$plugin_dir")
done
[[ "${#plugin_args[@]}" -gt 0 ]] || {
  printf 'no Copilot plugins are available\n' >&2
  exit 1
}

copilot_args=(
  -C /workspace
  --model "${COPILOT_MODEL:-gpt-5.5}"
  "${plugin_args[@]}"
  --disable-builtin-mcps
  --no-remote
  --no-remote-export
  --no-auto-update
  --no-ask-user
  --no-color
  --plain-diff
  --allow-all
  --output-format json
  --log-dir /workspace/.harness/copilot-logs
)

if [[ "$session_mode" == '--new' ]]; then
  copilot_args+=(--autopilot --max-autopilot-continues 20 --prompt "$prompt")
else
  session_id=''
  if [[ -s "$session_file" ]]; then
    candidate_session_id="$(<"$session_file")"
    if /usr/local/bin/find-harness-session.sh \
      copilot "$COPILOT_HOME" /workspace "$candidate_session_id" >/dev/null; then
      session_id="$candidate_session_id"
    fi
  fi
  if [[ -z "$session_id" ]]; then
    session_id="$(/usr/local/bin/find-harness-session.sh \
      copilot "$COPILOT_HOME" /workspace 2>/dev/null || true)"
    if [[ -z "$session_id" ]]; then
      printf 'no recoverable Copilot session; start with --new\n' >&2
      exit 66
    fi
    session_tmp="$(mktemp /workspace/.harness/copilot-session-id.XXXXXX)"
    printf '%s\n' "$session_id" >"$session_tmp"
    chmod 0600 "$session_tmp"
    mv "$session_tmp" "$session_file"
  fi
  copilot_args+=(--resume="$session_id" --prompt "$prompt")
fi

set +e
copilot "${copilot_args[@]}" 2>&1 | tee "$events_file"
copilot_status="${PIPESTATUS[0]}"
set -e

result_session_id="$(jq -Rr 'fromjson? | select(.type == "result") | .sessionId // empty' "$events_file" | tail -n 1)"
if [[ -n "$result_session_id" ]]; then
  session_tmp="$(mktemp /workspace/.harness/copilot-session-id.XXXXXX)"
  printf '%s\n' "$result_session_id" >"$session_tmp"
  chmod 0600 "$session_tmp"
  mv "$session_tmp" "$session_file"
elif [[ "$session_mode" == '--new' ]]; then
  printf 'Copilot did not emit a result session ID\n' >&2
  [[ "$copilot_status" -ne 0 ]] || copilot_status=1
fi

jq -Rsc '
  [split("\n")[] | fromjson? | select(.type == "assistant.message") | .data.content][-1] // ""
' "$events_file" >"$last_message_file"

finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
copilot_version="$(copilot --version | head -n 1)"
jq -n \
  --arg runtime copilot \
  --arg provider github-copilot-native \
  --arg model "${COPILOT_MODEL:-gpt-5.5}" \
  --arg version "$copilot_version" \
  --arg startedAt "$started_at" \
  --arg finishedAt "$finished_at" \
  --argjson exitCode "$copilot_status" \
  '{runtime: $runtime, provider: $provider, model: $model, version: $version,
    startedAt: $startedAt, finishedAt: $finishedAt, exitCode: $exitCode}' \
  >"$runtime_file"

exit "$copilot_status"
