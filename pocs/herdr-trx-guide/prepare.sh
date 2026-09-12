#!/usr/bin/env bash
set -euo pipefail

plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(cd -- "$plugin_root/../.." && pwd -P)"

"$source_root/scripts/install-source-runtime.sh" --prepare
source "$source_root/scripts/bun-runtime.sh"
trellage_bun_runtime "$source_root"
export BUN_INSTALL="$plugin_root/node_modules/.trellage-links"
for package in trellage-conversation-source trellage-guide-core trellage-runtime; do
  (
    cd -- "$source_root/packages/$package"
    "${trellage_bun[@]}" link
  )
done
cd -- "$plugin_root"
exec env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "${trellage_bun[0]}" \
  --no-env-file --config=/dev/null install --frozen-lockfile --ignore-scripts
