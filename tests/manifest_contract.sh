#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'manifest contract: FAIL: %s\n' "$1" >&2
  exit 1
}

manifest='harnesses/todo-side-by-side/harness.json'
[[ -f "$manifest" ]] || fail "missing manifest: $manifest"

jq -e '
  .schemaVersion == 1
  and .id == "todo-side-by-side"
  and .acceptance == "todo-v1"
  and (.prompt | type == "string" and length > 0)
  and (.contestants | length == 2)
  and ([.contestants[].id] | unique | length == 2)
  and ([.contestants[].port] | unique | length == 2)
  and all(.contestants[];
    (.id | test("^[a-z0-9][a-z0-9-]*$"))
    and (.port | type == "number" and . >= 1024 and . <= 65535)
    and (.model | type == "string" and length > 0)
    and (.packages | type == "array" and length > 0)
  )
  and any(.contestants[];
    .id == "codex-wshobson"
    and .runtime == "codex"
    and .service == "agent"
    and .port == 4173
    and .model == "gpt-5.5"
    and .provider == "copilot-proxy-rs"
    and .packages == [{
      "source": "https://github.com/wshobson/agents.git",
      "ref": "c4b82b0ad771190355eb8e204b1329732a18449a",
      "plugins": ["full-stack-orchestration"],
      "skills": [],
      "hooks": []
    }]
  )
  and any(.contestants[];
    .id == "copilot-awesome"
    and .runtime == "copilot"
    and .service == "copilot_agent"
    and .port == 4174
    and .model == "gpt-5.5"
    and .provider == "github-copilot-native"
    and .packages == [{
      "source": "https://github.com/github/awesome-copilot.git",
      "ref": "ecf0f5a9f4b014d2e0f5e3c1cec55b4e7792ed8a",
      "plugins": ["frontend-web-dev", "testing-automation"],
      "skills": [],
      "hooks": []
    }]
  )
' "$manifest" >/dev/null || fail 'manifest fields do not match the pinned comparison contract'

prompt_path="$(jq -r '.prompt' "$manifest")"
[[ "$prompt_path" != /* && "$prompt_path" != *'..'* ]] || fail 'prompt path must be repository-relative'
[[ -f "$prompt_path" ]] || fail "missing shared prompt: $prompt_path"

for required_text in \
  'GET /health' \
  'GET /api/tasks' \
  'POST /api/tasks' \
  'PATCH /api/tasks/:id' \
  'DELETE /api/tasks/:id' \
  'Personal TODO' \
  "Today's tasks" \
  'Task title' \
  'Add task' \
  '0.0.0.0' \
  'PORT=3000' \
  'npm test' \
  'npm run typecheck' \
  'npm run lint' \
  'npm run build' \
  'npm run start'; do
  grep -Fq "$required_text" "$prompt_path" || fail "shared prompt is missing: $required_text"
done

prompt_hash="$(shasum -a 256 "$prompt_path" | awk '{print $1}')"
[[ "$prompt_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'shared prompt hash is invalid'

printf 'manifest contract: PASS (%s)\n' "$prompt_hash"
