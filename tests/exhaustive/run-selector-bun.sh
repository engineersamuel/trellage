#!/bin/bash
set -euo pipefail
[[ "${TRELLAGE_TEST_OFFLINE-}" == 1 ]] || exit 97
if [[ "$#" == 1 && "$1" == --version ]]; then
  exec "$TRELLAGE_SELECTOR_REAL_BUN" "$@"
fi
for arg in "$@"; do
  case "$arg" in
    */packages/trellage-launcher/src/run-select-cli.tsx)
      exec "$TRELLAGE_SELECTOR_REAL_BUN" --preload "$TRELLAGE_SELECTOR_PRELOAD" "$@"
      ;;
    */packages/trellage-runtime/src/workspace-cli.ts)
      exec "$TRELLAGE_SELECTOR_REAL_BUN" "$@"
      ;;
  esac
done
printf 'Unexpected router Bun invocation in selector fixture\n' >&2
exit 97
