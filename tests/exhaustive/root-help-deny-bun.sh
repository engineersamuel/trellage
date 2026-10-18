#!/bin/bash
set -euo pipefail
[[ "${TRELLAGE_TEST_OFFLINE-}" == 1 ]] || exit 97
printf 'Unexpected Bun startup during root help\n' > "$TRELLAGE_ROOT_HELP_UNEXPECTED"
exit 97
