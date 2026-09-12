#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$repo_root/scripts/bun-runtime.sh"
trellage_bun_runtime "$repo_root"
[[ "${HOME-}" == /* && "$HOME" != / && -d "$HOME" && ! -L "$HOME" ]] || {
  printf 'install-native-environment-runtime: unsafe HOME: %s\n' "${HOME-}" >&2
  exit 1
}
canonical_home="$(cd -P "$HOME" && pwd -P)"
if [[ "${1-}" == --stage && "$#" == 2 ]]; then
  exec "$repo_root/scripts/install-source-runtime.sh" --stage "$2"
fi
[[ "$#" == 0 ]] || {
  printf 'Usage: install-native-environment-runtime.sh [--stage ABSOLUTE_PATH]\n' >&2
  exit 2
}
common_root="$("${trellage_bun[@]}" "$repo_root/packages/trellage-runtime/src/workspace-cli.ts" \
  ensure-common "$canonical_home")"
exec "$repo_root/scripts/install-source-runtime.sh" --install-environment \
  "$common_root/native-environment-runtime"
