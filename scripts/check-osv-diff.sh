#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'OSV scan: not inside a Git worktree\n' >&2
  exit 1
}
cd "$repo_root"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/check-osv-diff.XXXXXX")"
trap 'rm -f -- "$temp_dir/bun.lock" "$temp_dir/base.json" "$temp_dir/current.json" "$temp_dir/base-findings" "$temp_dir/current-findings"; rmdir "$temp_dir"' EXIT

base_ref="${QUALITY_BASE_SHA:-}"
if [[ -z "$base_ref" ]] && git rev-parse --verify 'origin/main^{commit}' >/dev/null 2>&1; then
  base_ref='origin/main'
fi

scan_lockfile() {
  local lockfile="$1" report="$2" status=0
  osv-scanner scan source -L "$lockfile" --format json --output-file "$report" || status=$?
  if ((status > 1)); then
    printf 'OSV scan failed for %s with exit code %d\n' "$lockfile" "$status" >&2
    return "$status"
  fi
}

if [[ -n "$base_ref" && "$base_ref" != '0000000000000000000000000000000000000000' ]] \
  && git cat-file -e "$base_ref:bun.lock" 2>/dev/null; then
  git show "$base_ref:bun.lock" >"$temp_dir/bun.lock"
  scan_lockfile "$temp_dir/bun.lock" "$temp_dir/base.json"
else
  printf '[]\n' >"$temp_dir/base.json"
fi

scan_lockfile bun.lock "$temp_dir/current.json"

jq -r '.results[]?.packages[]? as $package | $package.vulnerabilities[]? | "\($package.package.name)@\($package.package.version)\t\(.id)"' "$temp_dir/base.json" \
  | sort -u >"$temp_dir/base-findings"
jq -r '.results[]?.packages[]? as $package | $package.vulnerabilities[]? | "\($package.package.name)@\($package.package.version)\t\(.id)"' "$temp_dir/current.json" \
  | sort -u >"$temp_dir/current-findings"

new_findings="$(comm -13 "$temp_dir/base-findings" "$temp_dir/current-findings")"
if [[ -n "$new_findings" ]]; then
  printf 'New vulnerable dependency versions or advisories:\n%s\n' "$new_findings" >&2
  exit 1
fi

printf 'OSV scan: no new vulnerable dependency versions or advisories\n'
