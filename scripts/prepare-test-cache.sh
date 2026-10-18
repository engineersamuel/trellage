#!/usr/bin/env bash
set -euo pipefail

python3 -c 'import sys; assert sys.version_info >= (3, 11), "repository tests require Python 3.11+ on PATH"'

root="$(CDPATH= cd -P -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cache="${TRELLAGE_TEST_PACKAGE_CACHE:-$root/.test-performance/package-cache}"
[[ "$cache" == /* ]] || { printf 'test package cache must be absolute\n' >&2; exit 2; }
mkdir -p "$root/.test-performance" "$cache"
temporary="$(mktemp -d "$root/.test-performance/cache-prepare.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT

# Populate all locked packages through the repository's frozen preparer. This
# setup step may access the configured package feed; test execution may not.
BUN_INSTALL_CACHE_DIR="$cache" "$root/scripts/install-source-runtime.sh" --stage "$temporary/runtime"
npm --prefix "$root/tests/playwright" ci
printf 'Offline test package cache prepared: %s\n' "$cache"
