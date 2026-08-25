#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'harness runner: FAIL: %s\n' "$1" >&2
  exit 1
}

runner='scripts/harness'
manifest='harnesses/todo-side-by-side/harness.json'
[[ -x "$runner" ]] || fail "missing executable runner: $runner"

fixture_root="$(mktemp -d)"
cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT

fake_bin="$fixture_root/bin"
docker_log_dir="$fixture_root/docker-calls"
gh_log_dir="$fixture_root/gh-calls"
mkdir -p "$fake_bin" "$docker_log_dir" "$gh_log_dir"

real_node="$(command -v node)"
cat >"$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${1-}" in
  */scripts/update-engineersamuel-skills.mjs)
    printf '%s\n' "$*" >>"$FAKE_NODE_LOG"
    exit 0
    ;;
esac

exec "$REAL_NODE" "$@"
EOF

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

token_state='absent'
token_file="${HARNESS_COPILOT_TOKEN_FILE:-}"
if [[ -n "$token_file" && -f "$token_file" ]]; then
  case "$(uname -s 2>/dev/null)" in
    Darwin) token_mode="$(stat -f '%Lp' "$token_file")" ;;
    Linux) token_mode="$(stat -c '%a' "$token_file")" ;;
    *) exit 1 ;;
  esac
  [[ "$token_mode" == '600' ]] || token_state="unsafe-mode-$token_mode"
  [[ "$token_mode" != '600' ]] || token_state='set'
fi
prompt_hash=''
for argument in "$@"; do
  if [[ "$argument" == *'Build and fully verify a production-ready personal TODO web application'* ]]; then
    prompt_hash="$(printf '%s' "$argument" | shasum -a 256 | awk '{print $1}')"
  fi
done

jq -n \
  --arg tokenState "$token_state" \
  --arg promptHash "$prompt_hash" \
  --arg wshobsonPlugin "${WSHOBSON_AGENTS_PLUGIN:-}" \
  '{tokenState: $tokenState, promptHash: $promptHash,
    wshobsonPlugin: $wshobsonPlugin, args: $ARGS.positional}' \
  --args -- "$@" \
  >"$FAKE_DOCKER_LOG_DIR/call.$$.json"

if [[ "$*" == *'/usr/local/bin/find-harness-session.sh'* ]]; then
  case "$*" in
    *todo-side-by-side-codex-wshobson_workspace:/workspace:ro*)
      printf '%s\n' 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      ;;
    *todo-side-by-side-copilot-awesome_workspace:/workspace:ro*)
      printf '%s\n' 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      ;;
    *) exit 1 ;;
  esac
fi

if [[ "$*" == *'--entrypoint tar'* ]]; then
  contestant_id=''
  for argument in "$@"; do
    case "$argument" in
      *todo-side-by-side-codex-wshobson_workspace:/workspace:ro)
        contestant_id='codex-wshobson'
        ;;
      *todo-side-by-side-copilot-awesome_workspace:/workspace:ro)
        contestant_id='copilot-awesome'
        ;;
    esac
  done
  [[ -n "$contestant_id" ]]
  tar -C "$FAKE_EXPORT_ROOT/$contestant_id" -cf - \
    .harness package.json package-lock.json dist
fi
EOF

cat >"$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$FAKE_GH_LOG_DIR/call.$$.txt"
[[ "$*" == 'auth token' ]] || exit 64
printf 'fallback-native-token\n'
EOF

cat >"$fake_bin/playwright" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "${HARNESS_ACCEPTANCE_SPEC:-}" "$*" >>"$FAKE_PLAYWRIGHT_LOG"
cat <<'JSON'
{
  "suites": [{
    "specs": [{
      "tests": [
        {"projectName":"codex-wshobson","results":[{"status":"passed"}]},
        {"projectName":"copilot-awesome","results":[{"status":"passed"}]}
      ]
    }]
  }]
}
JSON
EOF

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_CURL_LOG"
EOF

chmod 0555 "$fake_bin/node" "$fake_bin/docker" "$fake_bin/gh" "$fake_bin/playwright" "$fake_bin/curl"

runner_env=(
  env
  -u COPILOT_GITHUB_TOKEN
  -u GH_TOKEN
  PATH="$fake_bin:$PATH"
  FAKE_DOCKER_LOG_DIR="$docker_log_dir"
  FAKE_GH_LOG_DIR="$gh_log_dir"
  FAKE_NODE_LOG="$fixture_root/node.log"
  FAKE_PLAYWRIGHT_LOG="$fixture_root/playwright.log"
  FAKE_CURL_LOG="$fixture_root/curl.log"
  REAL_NODE="$real_node"
  HARNESS_PLAYWRIGHT_BIN="$fake_bin/playwright"
  HARNESS_STATE_ROOT="$fixture_root/state"
  HARNESS_RESULTS_ROOT="$fixture_root/results"
  HARNESS_RUN_ID='fixture-run'
  FAKE_EXPORT_ROOT="$fixture_root/export"
)

"${runner_env[@]}" "$runner" validate "$manifest" >/dev/null
[[ -z "$(find "$docker_log_dir" -type f -print -quit)" ]] \
  || fail 'validate invoked Docker'
[[ -z "$(find "$gh_log_dir" -type f -print -quit)" ]] \
  || fail 'validate looked up authentication'

invalid_manifest="$fixture_root/invalid.json"
jq '.contestants[1].port = .contestants[0].port' "$manifest" >"$invalid_manifest"
if "${runner_env[@]}" "$runner" validate "$invalid_manifest" \
  >"$fixture_root/invalid.stdout" 2>"$fixture_root/invalid.stderr"; then
  fail 'duplicate contestant port was accepted'
fi
grep -Fq 'duplicate contestant port' "$fixture_root/invalid.stderr" \
  || fail 'duplicate-port rejection was unclear'
[[ -z "$(find "$docker_log_dir" -type f -print -quit)" ]] \
  || fail 'invalid manifest invoked Docker'

for invalid_mutation in \
  '.acceptance = "unknown-v1"' \
  '.contestants[0].packages[0].plugins += ["api-security"]' \
  '.contestants[0].packages[0].skills = ["direct-skill"]' \
  '.contestants[1].packages[0].hooks = ["direct-hook"]' \
  '.contestants[0].packages[0].source = "https://github.com/example/ignored.git"'; do
  jq "$invalid_mutation" "$manifest" >"$invalid_manifest"
  if "${runner_env[@]}" "$runner" validate "$invalid_manifest" \
    >"$fixture_root/invalid.stdout" 2>"$fixture_root/invalid.stderr"; then
    fail "unsupported manifest surface was accepted: $invalid_mutation"
  fi
done

"${runner_env[@]}" "$runner" build "$manifest" >/dev/null
grep -Fxq "$PWD/scripts/update-engineersamuel-skills.mjs" "$fixture_root/node.log" \
  || fail 'build did not request a personal skill refresh'
build_calls=()
while IFS= read -r call_file; do
  build_calls+=("$call_file")
done < <(find "$docker_log_dir" -type f -name '*.json' -print | sort)
[[ "${#build_calls[@]}" -eq 2 ]] || fail "expected 2 build calls, found ${#build_calls[@]}"
jq -s -e '
  any(.[]; (.args | index("todo-side-by-side-codex-wshobson")) and (.args | index("agent")) and (.args | index("build")))
  and any(.[]; (.args | index("todo-side-by-side-codex-wshobson")) and .wshobsonPlugin == "full-stack-orchestration")
  and any(.[]; (.args | index("todo-side-by-side-copilot-awesome")) and (.args | index("copilot_agent")) and (.args | index("compose.copilot.yaml")))
' "${build_calls[@]}" >/dev/null || fail 'build did not isolate both contestant projects and services'

rm -f "$docker_log_dir"/* "$gh_log_dir"/*
"${runner_env[@]}" "$runner" run "$manifest" >/dev/null
run_calls=()
while IFS= read -r call_file; do
  run_calls+=("$call_file")
done < <(find "$docker_log_dir" -type f -name '*.json' -print | sort)
[[ "${#run_calls[@]}" -eq 2 ]] || fail "expected 2 run calls, found ${#run_calls[@]}"
jq -s -e '
  ([.[] | select(.promptHash != "") | .promptHash] | unique | length) == 1
  and ([.[] | select(.promptHash != "")] | length) == 2
  and any(.[]; (.args | index("agent")) and .tokenState == "absent")
  and any(.[]; (.args | index("copilot_agent")) and .tokenState == "set")
' "${run_calls[@]}" >/dev/null || fail 'prompt parity or Copilot-only secret scope failed'
[[ "$(find "$gh_log_dir" -type f -name '*.txt' | wc -l | tr -d ' ')" == '1' ]] \
  || fail 'gh auth token fallback was not used exactly once'

rm -f "$docker_log_dir"/* "$gh_log_dir"/*
sessions_output="$("${runner_env[@]}" "$runner" sessions "$manifest")"
grep -Fq $'codex-wshobson\tcodex\taaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' \
  <<<"$sessions_output" || fail 'sessions did not report retained Codex state'
grep -Fq $'copilot-awesome\tcopilot\tbbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' \
  <<<"$sessions_output" || fail 'sessions did not report retained Copilot state'
grep -Fq "resume: scripts/harness resume $(pwd -P)/$manifest" <<<"$sessions_output" \
  || fail 'sessions did not print the recovery command'
session_calls=()
while IFS= read -r call_file; do
  session_calls+=("$call_file")
done < <(
  find "$docker_log_dir" -type f -name '*.json' -print \
    | while IFS= read -r call_file; do
        jq -e '.args | index("/usr/local/bin/find-harness-session.sh")' \
          "$call_file" >/dev/null && printf '%s\n' "$call_file"
      done \
    | sort
)
[[ "${#session_calls[@]}" -eq 2 ]] \
  || fail "expected 2 session inspection calls, found ${#session_calls[@]}"
[[ "$(find "$docker_log_dir" -type f -name '*.json' | wc -l | tr -d ' ')" == '4' ]] \
  || fail 'sessions did not verify both retained volumes before inspection'
jq -s -e '
  all(.[];
    (.args | index("run"))
    and (.args | index("--network"))
    and (.args | index("none"))
    and (.args | index("--read-only"))
    and (.args | index("/usr/local/bin/find-harness-session.sh"))
    and any(.args[]; endswith("_workspace:/workspace:ro"))
    and .tokenState == "absent"
  )
' "${session_calls[@]}" >/dev/null || fail 'sessions inspection is not isolated and read-only'
[[ -z "$(find "$gh_log_dir" -type f -print -quit)" ]] \
  || fail 'sessions resolved authentication'

rm -f "$docker_log_dir"/* "$gh_log_dir"/*
COPILOT_GITHUB_TOKEN='preferred-native-token' GH_TOKEN='secondary-token' \
  PATH="$fake_bin:$PATH" \
  FAKE_DOCKER_LOG_DIR="$docker_log_dir" \
  FAKE_GH_LOG_DIR="$gh_log_dir" \
  "$runner" run "$manifest" >/dev/null
[[ -z "$(find "$gh_log_dir" -type f -print -quit)" ]] \
  || fail 'gh auth token was called despite COPILOT_GITHUB_TOKEN'

rm -f "$docker_log_dir"/*
"${runner_env[@]}" "$runner" serve "$manifest" >/dev/null
serve_calls=()
while IFS= read -r call_file; do
  serve_calls+=("$call_file")
done < <(find "$docker_log_dir" -type f -name '*.json' -print | sort)
[[ "${#serve_calls[@]}" -eq 4 ]] \
  || fail "expected 4 serve Docker calls, found ${#serve_calls[@]}"
jq -s -e '
  ([.[] | select((.args | index("run")) and (.args | index("workspace_publish")))] | length) == 2
  and ([.[] | select((.args | index("up")) and (.args | index("--force-recreate")) and (.args | index("app")))] | length) == 2
' "${serve_calls[@]}" >/dev/null || fail 'serve did not publish artifacts and recreate both app containers'

rm -f "$docker_log_dir"/* "$fixture_root/playwright.log" "$fixture_root/curl.log"
"${runner_env[@]}" "$runner" verify "$manifest" >/dev/null
verify_calls=()
while IFS= read -r call_file; do
  verify_calls+=("$call_file")
done < <(find "$docker_log_dir" -type f -name '*.json' -print | sort)
[[ "${#verify_calls[@]}" -eq 6 ]] \
  || fail "expected 6 verify Docker calls, found ${#verify_calls[@]}"
jq -s -e '
  ([.[] | select((.args | index("run")) and (.args | index("--entrypoint")) and (.args | index("bash")))] | length) == 2
  and ([.[] | select((.args | index("up")) and (.args | index("--force-recreate")) and (.args | index("app")))] | length) == 4
  and all(.[]; .tokenState == "absent")
' "${verify_calls[@]}" >/dev/null || fail 'verify did not run isolated checks and pre/post-browser app recreations'
[[ "$(wc -l <"$fixture_root/playwright.log" | tr -d ' ')" == '2' ]] \
  || fail 'verify did not run both browser phases'
[[ "$(grep -Fc 'todo.spec.ts|' "$fixture_root/playwright.log")" == '2' ]] \
  || fail 'verify did not select the TODO acceptance spec for both phases'
grep -Fq 'supports CRUD and persists state across a reload' "$fixture_root/playwright.log" \
  || fail 'verify skipped the common CRUD browser phase'
grep -Fq 'keeps the completed task after an app-container restart' "$fixture_root/playwright.log" \
  || fail 'verify skipped the persistence browser phase'
for contestant_id in codex-wshobson copilot-awesome; do
  browser_summary="$fixture_root/state/todo-side-by-side/$contestant_id/browser.json"
  jq -e '.overall == "passed" and .crud == 0 and .restartPersistence == 0' \
    "$browser_summary" >/dev/null || fail "missing passing browser summary for $contestant_id"
done

for contestant_id in codex-wshobson copilot-awesome; do
  export_root="$fixture_root/export/$contestant_id"
  harness_root="$export_root/.harness"
  mkdir -p "$harness_root/verification" "$export_root/dist"
  runtime='codex'
  runtime_name='codex-runtime.json'
  events_name='codex-events.jsonl'
  message_name='last-message.md'
  inventory_name='agent-package-inventory.txt'
  provider='copilot-proxy-rs'
  if [[ "$contestant_id" == 'copilot-awesome' ]]; then
    runtime='copilot'
    runtime_name='copilot-runtime.json'
    events_name='copilot-events.jsonl'
    message_name='copilot-last-message.md'
    inventory_name='copilot-plugin-inventory.txt'
    provider='github-copilot-native'
  fi
  jq -n \
    --arg runtime "$runtime" \
    --arg provider "$provider" \
    '{runtime: $runtime, provider: $provider, model: "gpt-5.5", version: "fixture",
      startedAt: "2026-07-21T00:00:00Z", finishedAt: "2026-07-21T00:01:00Z", exitCode: 0}' \
    >"$harness_root/$runtime_name"
  printf '%s\n' '{"type":"result","fixture":true}' >"$harness_root/$events_name"
  printf '# Fixture message\n' >"$harness_root/$message_name"
  printf '%s\n' "$contestant_id/package" >"$harness_root/$inventory_name"
  printf '%s\n' '{"schemaVersion":1,"overall":"passed","test":0,"typecheck":0,"lint":0,"build":0,"audit":0}' \
    >"$harness_root/verification/checks.json"
  printf '%s\n' '{"name":"fixture","version":"1.0.0"}' >"$export_root/package.json"
  printf '%s\n' '{"lockfileVersion":3}' >"$export_root/package-lock.json"
  printf '%s\n' 'fixture build' >"$export_root/dist/server.js"
done

rm -f "$docker_log_dir"/*
"${runner_env[@]}" "$runner" collect "$manifest" >/dev/null
comparison="$fixture_root/results/todo-side-by-side/fixture-run/comparison.json"
jq -e '
  .runId == "fixture-run"
  and (.contestants | length) == 2
  and all(.contestants[]; .status == "passed")
  and (has("winner") | not)
' "$comparison" >/dev/null || fail 'collect did not assemble judge-ready contestant evidence'
[[ "$(find "$docker_log_dir" -type f -name '*.json' | wc -l | tr -d ' ')" == '2' ]] \
  || fail 'collect did not use exactly one volume exporter per contestant'

rm -f "$docker_log_dir"/*
"${runner_env[@]}" "$runner" down "$manifest" >/dev/null
down_call="$(find "$docker_log_dir" -type f -name '*.json' -print -quit)"
[[ -n "$down_call" ]] || fail 'down did not invoke Docker'
jq -e '(.args | index("down")) and (.args | index("--remove-orphans")) and ((.args | index("--volumes")) | not)' \
  "$down_call" >/dev/null || fail 'down is destructive or incomplete'

rm -f "$docker_log_dir"/*
"${runner_env[@]}" "$runner" purge "$manifest" >/dev/null
purge_call="$(find "$docker_log_dir" -type f -name '*.json' -print -quit)"
[[ -n "$purge_call" ]] || fail 'purge did not invoke Docker'
jq -e '(.args | index("down")) and (.args | index("--volumes")) and (.args | index("--remove-orphans"))' \
  "$purge_call" >/dev/null || fail 'explicit purge does not remove project volumes'

printf 'harness runner: PASS\n'
