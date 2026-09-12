#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$repo_root/scripts/bun-runtime.sh"
trellage_bun_runtime "$repo_root"

case "${1-}" in
  --package)
    [[ "$#" == 1 ]] || exit 2
    exec "${trellage_bun[@]}" "$repo_root/packages/trellage-runtime/src/workspace-cli.ts" \
      install "$repo_root" "$repo_root/.trellage-runtime"
    ;;
  --prepare)
    [[ "$#" == 1 ]] || exit 2
    exec "${trellage_bun[@]}" "$repo_root/packages/trellage-runtime/src/workspace-cli.ts" prepare "$repo_root"
    ;;
  --stage|--install|--install-floating|--install-environment)
    [[ "$#" == 2 && "$2" == /* ]] || {
      printf 'source runtime destination must be absolute\n' >&2
      exit 2
    }
    exec "${trellage_bun[@]}" "$repo_root/packages/trellage-runtime/src/workspace-cli.ts" \
      "${1#--}" "$repo_root" "$2"
    ;;
  *)
    printf 'Usage: install-source-runtime.sh --package|--prepare|--stage PATH|--install PATH\n' >&2
    exit 2
    ;;
esac
