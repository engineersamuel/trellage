#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

runner='scripts/run-agent.sh'

grep -Fq -- '--new' "$runner" || {
  printf 'run agent session: FAIL: explicit new-session mode missing\n' >&2
  exit 1
}
grep -Fq -- '--resume' "$runner" || {
  printf 'run agent session: FAIL: resume mode missing\n' >&2
  exit 1
}
grep -Fq '/workspace/.harness/codex-session-id' "$runner" || {
  printf 'run agent session: FAIL: durable session ID path missing\n' >&2
  exit 1
}
grep -Fq 'codex exec resume' "$runner" || {
  printf 'run agent session: FAIL: Codex resume invocation missing\n' >&2
  exit 1
}
grep -Fq '/usr/local/bin/find-harness-session.sh' "$runner" || {
  printf 'run agent session: FAIL: native Codex session recovery is missing\n' >&2
  exit 1
}
grep -Fq 'thread.started' "$runner" || {
  printf 'run agent session: FAIL: session ID is not captured from Codex events\n' >&2
  exit 1
}
grep -Fq '/workspace/.harness/codex-runtime.json' "$runner" || {
  printf 'run agent session: FAIL: normalized Codex runtime evidence is missing\n' >&2
  exit 1
}
grep -Fq 'provider' "$runner" || {
  printf 'run agent session: FAIL: Codex provider evidence is missing\n' >&2
  exit 1
}

grep -Fq '/workspace/.harness/agent-package-inventory.txt' scripts/agent-entrypoint.sh || {
  printf 'run agent session: FAIL: Codex package inventory is missing\n' >&2
  exit 1
}

printf 'run agent session: PASS\n'
