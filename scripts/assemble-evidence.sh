#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"

fail() {
  printf 'evidence assembler: %s\n' "$1" >&2
  exit "${2:-1}"
}

[[ $# -eq 4 ]] || fail \
  'usage: assemble-evidence.sh MANIFEST STAGING_ROOT OUTPUT_ROOT RUN_ID' 64

manifest="$1"
staging_root="$2"
output_root="$3"
run_id="$4"

[[ -f "$manifest" ]] || fail "manifest not found: $manifest" 66
[[ -d "$staging_root" ]] || fail "staging root not found: $staging_root" 66
[[ "$run_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail 'invalid run id' 65
jq empty "$manifest" >/dev/null 2>&1 || fail 'manifest is not valid JSON' 65
jq -e '
  (.contestants | type == "array" and length > 0)
  and ([.contestants[].id] | unique | length) == (.contestants | length)
  and all(.contestants[];
    (.id | type == "string" and test("^[a-z0-9][a-z0-9-]*$"))
    and (.packages | type == "array" and length == 1)
    and (.packages[0].source | type == "string")
    and (.packages[0].ref | type == "string")
  )
' "$manifest" >/dev/null || fail 'manifest provenance inputs are invalid' 65

secret_scan_value="${HARNESS_SECRET_SCAN_VALUE:-}"
if [[ -n "$secret_scan_value" && "${#secret_scan_value}" -ge 8 ]]; then
  if grep -RFl -- "$secret_scan_value" "$staging_root" >/dev/null 2>&1; then
    fail 'secret value detected in evidence' 68
  fi
fi

if find "$staging_root" -type f -name '*.json' -print0 \
  | xargs -0 grep -Eil '"(token|secret|password|apiKey|api_key)"[[:space:]]*:' \
  >/dev/null 2>&1; then
  fail 'credential-like JSON field detected in evidence' 68
fi

harness_id="$(jq -r '.id' "$manifest")"
acceptance_id="$(jq -r '.acceptance' "$manifest")"
prompt_relative="$(jq -r '.prompt' "$manifest")"
prompt_path="$repo_root/$prompt_relative"
[[ -f "$prompt_path" ]] || fail "shared prompt not found: $prompt_relative" 66
prompt_hash="$(shasum -a 256 "$prompt_path" | awk '{print $1}')"
contestant_count="$(jq '.contestants | length' "$manifest")"
resolved_manifest="$(jq '.' "$manifest")"

while IFS= read -r contestant; do
  contestant_id="$(jq -r '.id' <<<"$contestant")"
  receipt="$staging_root/$contestant_id/source-provenance.json"
  [[ -f "$receipt" && ! -L "$receipt" ]] \
    || fail "missing source provenance receipt for $contestant_id" 66
done < <(jq -c '.contestants[]' "$manifest")

provenance_files=()
while IFS= read -r receipt; do
  provenance_files+=("$receipt")
done < <(find "$staging_root" -type f -name source-provenance.json -print | LC_ALL=C sort)

for receipt in "${provenance_files[@]}"; do
  accounted='false'
  while IFS= read -r contestant_id; do
    if [[ "$receipt" == "$staging_root/$contestant_id/source-provenance.json" ]]; then
      accounted='true'
      break
    fi
  done < <(jq -r '.contestants[].id' "$manifest")
  [[ "$accounted" == 'true' ]] \
    || fail "duplicate or unaccounted source provenance receipt: ${receipt#"$staging_root/"}" 65
done

[[ "${#provenance_files[@]}" -eq "$contestant_count" ]] \
  || fail 'source provenance receipt count does not match contestant count' 65

while IFS= read -r contestant; do
  contestant_id="$(jq -r '.id' <<<"$contestant")"
  expected_source="$(jq -r '.packages[0].source' <<<"$contestant")"
  expected_ref="$(jq -r '.packages[0].ref' <<<"$contestant")"
  receipt="$staging_root/$contestant_id/source-provenance.json"

  jq empty "$receipt" >/dev/null 2>&1 \
    || fail "malformed source provenance receipt for $contestant_id" 65
  jq -e '
    type == "object"
    and (keys | sort) == ["requestedRef", "resolvedCommit", "schemaVersion", "source"]
    and .schemaVersion == 1
    and (.source | type == "string" and length > 0)
    and (.requestedRef | type == "string" and test("^(main|master|[0-9a-f]{40})$"))
    and (.resolvedCommit | type == "string" and test("^[0-9a-f]{40}$"))
  ' "$receipt" >/dev/null \
    || fail "invalid source provenance receipt for $contestant_id" 65

  receipt_source="$(jq -r '.source' "$receipt")"
  receipt_ref="$(jq -r '.requestedRef' "$receipt")"
  resolved_commit="$(jq -r '.resolvedCommit' "$receipt")"
  [[ "$receipt_source" == "$expected_source" ]] \
    || fail "source provenance source mismatch for $contestant_id" 65
  [[ "$receipt_ref" == "$expected_ref" ]] \
    || fail "source provenance ref mismatch for $contestant_id" 65

  resolved_manifest="$(
    jq \
      --arg contestantId "$contestant_id" \
      --arg resolvedCommit "$resolved_commit" \
      '(.contestants[] | select(.id == $contestantId) | .packages[0].resolvedCommit) = $resolvedCommit' \
      <<<"$resolved_manifest"
  )"
done < <(jq -c '.contestants[]' "$manifest")

mkdir -p "$output_root/contestants"
jq -S '.' <<<"$resolved_manifest" >"$output_root/manifest.resolved.json"
cp "$prompt_path" "$output_root/prompt.md"
jq -n \
  --arg id "$acceptance_id" \
  --arg promptSha256 "$prompt_hash" \
  --argjson contestantCount "$contestant_count" \
  '{schemaVersion: 1, id: $id, promptSha256: $promptSha256, contestantCount: $contestantCount}' \
  >"$output_root/acceptance.json"

summary_file="$output_root/.contestant-summaries.jsonl"
: >"$summary_file"

while IFS= read -r contestant; do
  contestant_id="$(jq -r '.id' <<<"$contestant")"
  runtime="$(jq -r '.runtime' <<<"$contestant")"
  source_root="$staging_root/$contestant_id"
  source_harness="$source_root/.harness"
  contestant_output="$output_root/contestants/$contestant_id"
  [[ -d "$source_harness" ]] || fail "missing harness evidence for $contestant_id" 66
  mkdir -p "$contestant_output"

  case "$runtime" in
    codex)
      runtime_source="$source_harness/codex-runtime.json"
      events_source="$source_harness/codex-events.jsonl"
      message_source="$source_harness/last-message.md"
      inventory_source="$source_harness/agent-package-inventory.txt"
      ;;
    copilot)
      runtime_source="$source_harness/copilot-runtime.json"
      events_source="$source_harness/copilot-events.jsonl"
      message_source="$source_harness/copilot-last-message.md"
      inventory_source="$source_harness/copilot-plugin-inventory.txt"
      ;;
    *)
      fail "unsupported runtime in evidence: $runtime" 65
      ;;
  esac

  for required_source in \
    "$runtime_source" \
    "$events_source" \
    "$message_source" \
    "$inventory_source" \
    "$source_root/app-inventory.json" \
    "$source_root/checks.json" \
    "$source_root/browser.json" \
    "$source_root/artifact-hashes.json"; do
    [[ -f "$required_source" ]] \
      || fail "missing $contestant_id evidence source: $(basename "$required_source")" 66
  done

  jq -n \
    --argjson contestant "$contestant" \
    --arg promptSha256 "$prompt_hash" \
    --arg promptPath 'prompt.md' \
    '{contestant: $contestant, promptSha256: $promptSha256, promptPath: $promptPath}' \
    >"$contestant_output/input.json"
  jq -S '.' "$runtime_source" >"$contestant_output/runtime.json"
  cp "$events_source" "$contestant_output/events.jsonl"
  cp "$message_source" "$contestant_output/last-message.md"
  cp "$inventory_source" "$contestant_output/package-inventory.txt"
  cp "$source_root/source-provenance.json" "$contestant_output/source-provenance.json"
  jq -S '.' "$source_root/app-inventory.json" >"$contestant_output/app-inventory.json"
  jq -S '.' "$source_root/checks.json" >"$contestant_output/checks.json"
  jq -S '.' "$source_root/browser.json" >"$contestant_output/browser.json"
  jq -S '.' "$source_root/artifact-hashes.json" >"$contestant_output/artifact-hashes.json"

  runtime_exit="$(jq -r '.exitCode' "$runtime_source")"
  checks_status="$(jq -r '.overall' "$source_root/checks.json")"
  browser_status="$(jq -r '.overall' "$source_root/browser.json")"
  contestant_status='failed'
  if [[ "$runtime_exit" == '0' && "$checks_status" == 'passed' && "$browser_status" == 'passed' ]]; then
    contestant_status='passed'
  fi

  jq -n \
    --arg id "$contestant_id" \
    --arg runtime "$runtime" \
    --arg provider "$(jq -r '.provider' "$runtime_source")" \
    --arg model "$(jq -r '.model' "$runtime_source")" \
    --arg status "$contestant_status" \
    --arg evidenceRoot "contestants/$contestant_id" \
    --arg startedAt "$(jq -r '.startedAt' "$runtime_source")" \
    --arg finishedAt "$(jq -r '.finishedAt' "$runtime_source")" \
    '{id: $id, runtime: $runtime, provider: $provider, model: $model, status: $status,
      evidenceRoot: $evidenceRoot, startedAt: $startedAt, finishedAt: $finishedAt}' \
    >>"$summary_file"
done < <(jq -c '.contestants[]' "$manifest")

jq -s \
  --arg harnessId "$harness_id" \
  --arg runId "$run_id" \
  --arg acceptance "$acceptance_id" \
  --arg promptSha256 "$prompt_hash" \
  '{schemaVersion: 1, harnessId: $harnessId, runId: $runId, acceptance: $acceptance,
    promptSha256: $promptSha256, contestants: .}' \
  "$summary_file" >"$output_root/comparison.json"
rm -f "$summary_file"

if [[ -n "$secret_scan_value" && "${#secret_scan_value}" -ge 8 ]]; then
  if grep -RFl -- "$secret_scan_value" "$output_root" >/dev/null 2>&1; then
    fail 'secret value detected in evidence' 68
  fi
fi

printf 'evidence assembled: %s\n' "$output_root"
