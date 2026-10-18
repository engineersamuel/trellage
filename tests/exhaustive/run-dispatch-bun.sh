#!/bin/bash
set -euo pipefail
[[ "${TRELLAGE_TEST_OFFLINE-}" == 1 ]] || exit 97
if [[ "$#" == 1 && "$1" == --version ]]; then
  exec "$TRELLAGE_DISPATCH_REAL_BUN" "$@"
fi
for arg in "$@"; do
  case "$arg" in
    */packages/trellage-runtime/src/native-run/cli.ts|*/packages/trellage-launcher/src/run-select-cli.tsx)
      exec "$TRELLAGE_DISPATCH_REAL_BUN" --no-env-file --config=/dev/null "$TRELLAGE_DISPATCH_CAPTURE" "$@"
      ;;
    */packages/trellage-runtime/src/workspace-cli.ts)
      exec "$TRELLAGE_DISPATCH_REAL_BUN" "$@"
      ;;
  esac
done
printf 'Unexpected Bun invocation in router dispatch fixture\n' >&2
exit 97
