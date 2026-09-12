#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$repo_root/scripts/bun-runtime.sh"
trellage_bun_runtime "$repo_root"
exec "${trellage_bun[@]}" "$repo_root/packages/trellage-runtime/src/workspace-cli.ts" fingerprint "$repo_root"
