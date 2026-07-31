#!/usr/bin/env bash
set -euo pipefail

workspace_root="${HARNESS_WORKSPACE_ROOT:-/workspace}"
cd "$workspace_root"

evidence_dir='.harness/verification'
mkdir -p "$evidence_dir"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run_check() {
  local name="$1"
  shift

  set +e
  "$@" 2>&1 | tee "$evidence_dir/$name.log"
  check_status="${PIPESTATUS[0]}"
  set -e
}

run_check install npm ci
install_status="$check_status"
run_check test npm test
test_status="$check_status"
run_check typecheck npm run typecheck
typecheck_status="$check_status"
run_check lint npm run lint
lint_status="$check_status"
run_check build npm run build
build_status="$check_status"
run_check audit npm audit --omit=dev
audit_status="$check_status"
run_check prune npm prune --omit=dev
prune_status="$check_status"
run_check production-tree npm ls --omit=dev --depth=0
production_tree_status="$check_status"

overall='passed'
for status in \
  "$install_status" \
  "$test_status" \
  "$typecheck_status" \
  "$lint_status" \
  "$build_status" \
  "$audit_status" \
  "$prune_status" \
  "$production_tree_status"; do
  if [[ "$status" != '0' ]]; then
    overall='failed'
  fi
done

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
output_tmp="$evidence_dir/checks.json.tmp"
jq -n \
  --arg overall "$overall" \
  --arg startedAt "$started_at" \
  --arg finishedAt "$finished_at" \
  --argjson install "$install_status" \
  --argjson test "$test_status" \
  --argjson typecheck "$typecheck_status" \
  --argjson lint "$lint_status" \
  --argjson build "$build_status" \
  --argjson audit "$audit_status" \
  --argjson prune "$prune_status" \
  --argjson productionTree "$production_tree_status" \
  '{schemaVersion: 1, overall: $overall, startedAt: $startedAt, finishedAt: $finishedAt,
    install: $install, test: $test, typecheck: $typecheck, lint: $lint, build: $build,
    audit: $audit, prune: $prune, productionTree: $productionTree}' \
  >"$output_tmp"
mv "$output_tmp" "$evidence_dir/checks.json"

[[ "$overall" == 'passed' ]]
