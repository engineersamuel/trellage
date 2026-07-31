#!/usr/bin/env bash
set -euo pipefail

[[ -f /workspace/package.json ]] || {
  printf 'generated application is missing /workspace/package.json\n' >&2
  exit 1
}

[[ -d /workspace/node_modules ]] || {
  printf 'generated application dependencies are missing /workspace/node_modules\n' >&2
  exit 1
}

cd /workspace
exec npm run start
