#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Compatibility entrypoint for explicit dependency preparation, never compilation.
exec "$repo_root/scripts/install-source-runtime.sh" --prepare
