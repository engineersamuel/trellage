#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${TRELLAGE_TEST_MANAGED_RACE-}" ]]; then
  exec /usr/local/lib/trellage/bun-real \
    --preload /fixture/tests/fixtures/claude-managed-race.ts "$@"
fi
exec /usr/local/lib/trellage/bun-real "$@"
