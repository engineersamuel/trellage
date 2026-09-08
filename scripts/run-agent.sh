#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  printf 'usage: run-agent.sh (--new|--resume) <Codex prompt>\n' >&2
  exit 64
fi

session_mode="$1"
shift

case "$session_mode" in
  --new | --resume) ;;
  *)
    printf 'unknown session mode: %s\n' "$session_mode" >&2
    exit 64
    ;;
esac

default_model="${CODEX_MODEL:-gpt-6-astra}"
default_reasoning_effort="${CODEX_REASONING_EFFORT:-low}"
default_plan_mode_reasoning_effort="${CODEX_PLAN_MODE_REASONING_EFFORT:-max}"
model="$default_model"
reasoning_effort="$default_reasoning_effort"
model_override=''

apply_config_override() {
  local key="${1%%=*}"
  local value="${1#*=}"
  key="${key//[[:space:]]/}"
  case "$key" in
    model | model_reasoning_effort) ;;
    *) return ;;
  esac
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="$(jq -er 'select(type == "string")' <<<"$value")" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  case "$key" in
    model) model="$value" ;;
    model_reasoning_effort) reasoning_effort="$value" ;;
  esac
}

# Match Codex's option precedence for the proxy probe and runtime receipt.
caller_args=("$@")
for ((index = 0; index < ${#caller_args[@]}; index++)); do
  argument="${caller_args[$index]}"
  case "$argument" in
    --) break ;;
    -m | --model | -c | --config)
      index=$((index + 1))
      [[ "$index" -lt "${#caller_args[@]}" ]] || break
      value="${caller_args[$index]}"
      case "$argument" in
        -m | --model) model_override="$value" ;;
        -c | --config) apply_config_override "$value" ;;
      esac
      ;;
    --model=*) model_override="${argument#--model=}" ;;
    -m?*) model_override="${argument#-m}" ;;
    --config=*) apply_config_override "${argument#--config=}" ;;
    -c?*) apply_config_override "${argument#-c}" ;;
  esac
done
[[ -z "$model_override" ]] || model="$model_override"

config_args=(
  -c "model=$(jq -nc --arg value "$default_model" '$value')"
  -c "model_reasoning_effort=$(jq -nc --arg value "$default_reasoning_effort" '$value')"
  -c "plan_mode_reasoning_effort=$(jq -nc --arg value "$default_plan_mode_reasoning_effort" '$value')"
)

mkdir -p /workspace/.harness
session_file='/workspace/.harness/codex-session-id'
events_file='/workspace/.harness/codex-events.jsonl'
last_message_file='/workspace/.harness/last-message.md'
runtime_file='/workspace/.harness/codex-runtime.json'
started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

curl -fsS http://copilot-proxy-rs:8080/health \
  > /workspace/.harness/proxy-health.json

curl -fsS http://copilot-proxy-rs:8080/v1/models \
  > /workspace/.harness/proxy-models.json

jq -e --arg model "$model" '
  any(.models[]?;
    .slug == $model
    and any(.supported_endpoints[]?; . == "/responses")
  )
' /workspace/.harness/proxy-models.json >/dev/null

curl -fsS http://copilot-proxy-rs:8080/v1/responses \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg model "$model" --arg effort "$reasoning_effort" \
    '{model: $model, reasoning: {effort: $effort}, input: "Reply with exactly PROXY_OK"}')" \
  > /workspace/.harness/proxy-proof.json

proxy_text="$(jq -r '[.output[]?.content[]? | select(.type == "output_text") | .text] | join("")' /workspace/.harness/proxy-proof.json)"
[[ "$proxy_text" == 'PROXY_OK' ]] || {
  printf 'unexpected proxy proof response: %s\n' "$proxy_text" >&2
  exit 1
}

set +e
if [[ "$session_mode" == '--new' ]]; then
  codex exec \
    "${config_args[@]}" \
    --json \
    --dangerously-bypass-approvals-and-sandbox \
    -C /workspace \
    --output-last-message "$last_message_file" \
    "$@" 2>&1 | tee "$events_file"
else
  session_id=''
  if [[ -s "$session_file" ]]; then
    candidate_session_id="$(<"$session_file")"
    if /usr/local/bin/find-harness-session.sh \
      codex "$CODEX_HOME" /workspace "$candidate_session_id" >/dev/null; then
      session_id="$candidate_session_id"
    fi
  fi
  if [[ -z "$session_id" ]]; then
    session_id="$(/usr/local/bin/find-harness-session.sh \
      codex "$CODEX_HOME" /workspace 2>/dev/null || true)"
    if [[ -z "$session_id" ]]; then
      printf 'no recoverable Codex session; start with --new\n' >&2
      exit 66
    fi
    session_tmp="$(mktemp /workspace/.harness/codex-session-id.XXXXXX)"
    printf '%s\n' "$session_id" >"$session_tmp"
    chmod 0600 "$session_tmp"
    mv "$session_tmp" "$session_file"
  fi
  codex exec resume \
    "${config_args[@]}" \
    --json \
    --dangerously-bypass-approvals-and-sandbox \
    --output-last-message "$last_message_file" \
    "$session_id" \
    "$@" 2>&1 | tee "$events_file"
fi
codex_status="${PIPESTATUS[0]}"
set -e

thread_id="$(jq -Rr 'fromjson? | select(.type == "thread.started") | .thread_id // empty' "$events_file" | head -n 1)"
if [[ -n "$thread_id" ]]; then
  session_tmp="$(mktemp /workspace/.harness/codex-session-id.XXXXXX)"
  printf '%s\n' "$thread_id" >"$session_tmp"
  chmod 0600 "$session_tmp"
  mv "$session_tmp" "$session_file"
elif [[ "$session_mode" == '--new' ]]; then
  printf 'Codex did not emit a thread.started session ID\n' >&2
  [[ "$codex_status" -ne 0 ]] || codex_status=1
fi

finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
codex_version="$(codex --version | head -n 1)"
jq -n \
  --arg runtime codex \
  --arg provider copilot-proxy-rs \
  --arg model "$model" \
  --arg reasoningEffort "$reasoning_effort" \
  --arg version "$codex_version" \
  --arg startedAt "$started_at" \
  --arg finishedAt "$finished_at" \
  --argjson exitCode "$codex_status" \
  '{runtime: $runtime, provider: $provider, model: $model, reasoningEffort: $reasoningEffort, version: $version,
    startedAt: $startedAt, finishedAt: $finishedAt, exitCode: $exitCode}' \
  >"$runtime_file"

exit "$codex_status"
