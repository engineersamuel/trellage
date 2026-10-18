#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  printf 'usage: test-offline.sh COMMAND [ARG ...]\n' >&2
  exit 2
fi

export TRELLAGE_TEST_OFFLINE=1
python3 -c 'import tomllib' 2>/dev/null || {
  printf 'Offline repository tests require Python 3.11 or newer on PATH.\n' >&2
  exit 1
}
export TRELLAGE_TEST_PACKAGE_CACHE="${TRELLAGE_TEST_PACKAGE_CACHE:-${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}}"
test_bun="$(bun --no-install --no-env-file -p 'process.execPath')"
test_node="$(node -p 'process.execPath')"
export PATH="$(dirname "$test_bun"):$(dirname "$test_node"):$PATH"
if [[ "${1-}" == --native-sources ]]; then
  shift
  test_sources="$(mktemp -d /tmp/trellage-offline-sources.XXXXXX)"
  trap 'rm -rf -- "$test_sources"' EXIT
  test_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  TRELLAGE_DEV_SOURCES="$(bun --no-install --no-env-file "$test_root/tests/helpers/native-source-fixtures.ts" "$test_sources")"
  export TRELLAGE_DEV_SOURCES
  export GIT_CONFIG_GLOBAL="$test_sources/gitconfig"
fi
python3 "$(dirname "${BASH_SOURCE[0]}")/test-offline.py" -- "$@"
