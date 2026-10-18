#!/usr/bin/env bash
set -euo pipefail

[[ "${TRELLAGE_TEST_OFFLINE:-}" == 1 ]] || {
  printf 'Run this contract through scripts/test-offline.py.\n' >&2
  exit 1
}
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-offline-install.XXXXXX")"
fixture="$(cd "$fixture" && pwd -P)"
trap 'rm -rf -- "$fixture"' EXIT

# Copy source only: reusing node_modules would hide an empty download cache.
bun --no-env-file --no-install --config="$root/bunfig.toml" -e '
  import { copySources } from "@trellage/runtime/workspace";
  copySources(process.argv[1], process.argv[2]);
' "$root" "$fixture"
export BUN_INSTALL_CACHE_DIR="${TRELLAGE_TEST_PACKAGE_CACHE:?run make test-prepare first}"
bash "$fixture/scripts/install-source-runtime.sh" --prepare
bun --no-env-file --no-install --config="$fixture/bunfig.toml" \
  "$fixture/packages/trellage-runtime/src/workspace-cli.ts" check "$fixture"
printf 'offline source installation: PASS\n'
