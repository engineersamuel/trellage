#!/usr/bin/env bash
set -euo pipefail

python3 -c 'import sys; assert sys.version_info >= (3, 11), "repository tests require Python 3.11+ on PATH"'

root="$(CDPATH= cd -P -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cache="${TRELLAGE_TEST_PACKAGE_CACHE:-$root/.test-performance/package-cache}"
[[ "$cache" == /* ]] || { printf 'test package cache must be absolute\n' >&2; exit 2; }
mkdir -p "$root/.test-performance" "$cache"
temporary="$(mktemp -d "$root/.test-performance/cache-prepare.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT

# A ready --stage reuses node_modules and does not populate the download cache.
# Prepare a source-only copy so a fresh frozen install downloads every package.
mkdir "$temporary/runtime"
bun --no-env-file --no-install --config="$root/bunfig.toml" -e '
  import { copySources } from "@trellage/runtime/workspace";
  copySources(process.argv[1], process.argv[2]);
' "$root" "$temporary/runtime"
BUN_INSTALL_CACHE_DIR="$cache" "$temporary/runtime/scripts/install-source-runtime.sh" --prepare
npm --prefix "$root/tests/playwright" ci
printf 'Offline test package cache prepared: %s\n' "$cache"
