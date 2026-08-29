#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'evidence contract: FAIL: %s\n' "$1" >&2
  exit 1
}

assembler='scripts/assemble-evidence.sh'
manifest='harnesses/todo-side-by-side/harness.json'
[[ -x "$assembler" ]] || fail "missing executable assembler: $assembler"

fixture_root="$PWD/tests/.evidence-contract.${BASHPID:-$$}"
[[ ! -e "$fixture_root" && ! -L "$fixture_root" ]] || fail "fixture path already exists: $fixture_root"
mkdir -p "$fixture_root"
cleanup() {
  rm -rf "$fixture_root"
}
trap cleanup EXIT

staging_root="$fixture_root/staging"
output_root="$fixture_root/results/todo-side-by-side/fixture-run"

for contestant_id in codex-wshobson copilot-awesome; do
  harness_dir="$staging_root/$contestant_id/.harness"
  mkdir -p "$harness_dir"

  runtime='codex'
  event_name='codex-events.jsonl'
  message_name='last-message.md'
  runtime_name='codex-runtime.json'
  inventory_name='agent-package-inventory.txt'
  if [[ "$contestant_id" == 'copilot-awesome' ]]; then
    runtime='copilot'
    event_name='copilot-events.jsonl'
    message_name='copilot-last-message.md'
    runtime_name='copilot-runtime.json'
    inventory_name='copilot-plugin-inventory.txt'
  fi

  jq -n \
    --arg runtime "$runtime" \
    --arg provider "$([[ "$runtime" == 'codex' ]] && printf copilot-proxy-rs || printf github-copilot-native)" \
    --arg model 'gpt-5.5' \
    '{runtime: $runtime, provider: $provider, model: $model, version: "fixture", startedAt: "2026-07-21T00:00:00Z", finishedAt: "2026-07-21T00:01:00Z", exitCode: 0}' \
    >"$harness_dir/$runtime_name"
  printf '%s\n' '{"type":"result","fixture":true}' >"$harness_dir/$event_name"
  printf '# Fixture final message\n' >"$harness_dir/$message_name"
  printf '%s\n' "$contestant_id/package-fixture" >"$harness_dir/$inventory_name"
  printf '%s\n' '{"files":["package.json","dist/server.js"]}' \
    >"$staging_root/$contestant_id/app-inventory.json"
  printf '%s\n' '{"overall":"passed","test":0,"typecheck":0,"lint":0,"build":0,"audit":0}' \
    >"$staging_root/$contestant_id/checks.json"
  printf '%s\n' '{"overall":"passed","crud":0,"restartPersistence":0,"pageErrors":0,"consoleErrors":0,"failedRequests":0}' \
    >"$staging_root/$contestant_id/browser.json"
  printf '%s\n' '{"package.json":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dist":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' \
    >"$staging_root/$contestant_id/artifact-hashes.json"

  source="$(jq -r --arg id "$contestant_id" '.contestants[] | select(.id == $id) | .packages[0].source' "$manifest")"
  requested_ref="$(jq -r --arg id "$contestant_id" '.contestants[] | select(.id == $id) | .packages[0].ref' "$manifest")"
  resolved_commit='1111111111111111111111111111111111111111'
  if [[ "$contestant_id" == 'copilot-awesome' ]]; then
    resolved_commit='2222222222222222222222222222222222222222'
  fi
  jq -n \
    --arg source "$source" \
    --arg requestedRef "$requested_ref" \
    --arg resolvedCommit "$resolved_commit" \
    '{schemaVersion: 1, source: $source, requestedRef: $requestedRef, resolvedCommit: $resolvedCommit}' \
    >"$staging_root/$contestant_id/source-provenance.json"
done

"$assembler" "$manifest" "$staging_root" "$output_root" fixture-run

for required_file in \
  manifest.resolved.json \
  prompt.md \
  acceptance.json \
  comparison.json; do
  [[ -f "$output_root/$required_file" ]] || fail "missing top-level evidence: $required_file"
done

for contestant_id in codex-wshobson copilot-awesome; do
  contestant_root="$output_root/contestants/$contestant_id"
  for required_file in \
    input.json \
    runtime.json \
    events.jsonl \
    last-message.md \
    package-inventory.txt \
    source-provenance.json \
    app-inventory.json \
    checks.json \
    browser.json \
    artifact-hashes.json; do
    [[ -f "$contestant_root/$required_file" ]] \
      || fail "missing $contestant_id evidence: $required_file"
  done

  jq -e '
    .contestants[0].packages[0].ref == "main"
    and .contestants[0].packages[0].resolvedCommit == "1111111111111111111111111111111111111111"
    and .contestants[1].packages[0].ref == "main"
    and .contestants[1].packages[0].resolvedCommit == "2222222222222222222222222222222222222222"
  ' "$output_root/manifest.resolved.json" >/dev/null \
    || fail 'resolved manifest did not preserve refs and add source commits'

  for contestant_id in codex-wshobson copilot-awesome; do
    cmp -s \
      "$staging_root/$contestant_id/source-provenance.json" \
      "$output_root/contestants/$contestant_id/source-provenance.json" \
      || fail "source provenance receipt was not preserved for $contestant_id"
  done
done

jq -e '
  .schemaVersion == 1
  and .harnessId == "todo-side-by-side"
  and .runId == "fixture-run"
  and (.promptSha256 | test("^[0-9a-f]{64}$"))
  and (.contestants | length == 2)
  and ([.contestants[].id] | sort) == ["codex-wshobson", "copilot-awesome"]
  and all(.contestants[];
    .status == "passed"
    and (.evidenceRoot | startswith("contestants/"))
    and (.evidenceRoot | startswith("/") | not)
  )
  and (has("winner") | not)
' "$output_root/comparison.json" >/dev/null || fail 'comparison schema is invalid or chooses a winner'

jq -e '
  .id == "todo-v1"
  and (.promptSha256 | test("^[0-9a-f]{64}$"))
  and .contestantCount == 2
' "$output_root/acceptance.json" >/dev/null || fail 'acceptance evidence is invalid'

secret_value='fixture-secret-value-that-must-not-leak'
printf '%s\n' "$secret_value" >"$staging_root/copilot-awesome/.harness/leak.txt"
secret_output="$fixture_root/secret-results"
if HARNESS_SECRET_SCAN_VALUE="$secret_value" \
  "$assembler" "$manifest" "$staging_root" "$secret_output" secret-run \
  >"$fixture_root/secret.stdout" 2>"$fixture_root/secret.stderr"; then
  fail 'secret-bearing evidence was accepted'
fi
grep -Fq "$secret_value" "$fixture_root/secret.stdout" "$fixture_root/secret.stderr" \
  && fail 'secret rejection printed the secret value'
grep -Fq 'secret value detected in evidence' "$fixture_root/secret.stderr" \
  || fail 'secret rejection was unclear'

assert_rejected() {
  local label="$1"
  local expected_message="$2"
  local rejected_staging="$3"
  local rejected_output="$fixture_root/rejected-output-$label"
  if "$assembler" "$manifest" "$rejected_staging" "$rejected_output" "rejected-$label" \
    >"$fixture_root/$label.stdout" 2>"$fixture_root/$label.stderr"; then
    fail "$label source provenance was accepted"
  fi
  grep -Fq "$expected_message" "$fixture_root/$label.stderr" \
    || fail "$label source provenance rejection was unclear"
}

rejected_staging="$fixture_root/missing"
cp -R "$staging_root" "$rejected_staging"
rm "$rejected_staging/codex-wshobson/source-provenance.json"
assert_rejected missing 'missing source provenance receipt' "$rejected_staging"

rejected_staging="$fixture_root/malformed"
cp -R "$staging_root" "$rejected_staging"
printf '{\n' >"$rejected_staging/codex-wshobson/source-provenance.json"
assert_rejected malformed 'malformed source provenance receipt' "$rejected_staging"

for label in short uppercase; do
  rejected_staging="$fixture_root/$label"
  cp -R "$staging_root" "$rejected_staging"
  invalid_commit='abc123'
  [[ "$label" != 'uppercase' ]] \
    || invalid_commit='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  jq --arg commit "$invalid_commit" '.resolvedCommit = $commit' \
    "$staging_root/codex-wshobson/source-provenance.json" \
    >"$rejected_staging/codex-wshobson/source-provenance.json"
  assert_rejected "$label" 'invalid source provenance receipt' "$rejected_staging"
done

rejected_staging="$fixture_root/source-mismatch"
cp -R "$staging_root" "$rejected_staging"
jq '.source = "https://github.com/example/wrong.git"' \
  "$staging_root/codex-wshobson/source-provenance.json" \
  >"$rejected_staging/codex-wshobson/source-provenance.json"
assert_rejected source-mismatch 'source provenance source mismatch' "$rejected_staging"

rejected_staging="$fixture_root/ref-mismatch"
cp -R "$staging_root" "$rejected_staging"
jq '.requestedRef = "master"' \
  "$staging_root/codex-wshobson/source-provenance.json" \
  >"$rejected_staging/codex-wshobson/source-provenance.json"
assert_rejected ref-mismatch 'source provenance ref mismatch' "$rejected_staging"

rejected_staging="$fixture_root/duplicate"
cp -R "$staging_root" "$rejected_staging"
mkdir -p "$rejected_staging/codex-wshobson/duplicate"
cp "$staging_root/codex-wshobson/source-provenance.json" \
  "$rejected_staging/codex-wshobson/duplicate/source-provenance.json"
assert_rejected duplicate 'duplicate or unaccounted source provenance receipt' "$rejected_staging"

rejected_staging="$fixture_root/unaccounted"
cp -R "$staging_root" "$rejected_staging"
mkdir -p "$rejected_staging/not-a-contestant"
cp "$staging_root/codex-wshobson/source-provenance.json" \
  "$rejected_staging/not-a-contestant/source-provenance.json"
assert_rejected unaccounted 'duplicate or unaccounted source provenance receipt' "$rejected_staging"

printf 'evidence contract: PASS\n'
