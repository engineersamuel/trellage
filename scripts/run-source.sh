#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$repo_root/scripts/bun-runtime.sh"
trellage_require_source_runtime "$repo_root"
[[ "$#" -gt 0 && "$1" == /* && -f "$1" && ! -L "$1" ]] || {
  printf 'trellage runtime: entrypoint must be an absolute regular source file\n' >&2
  exit 1
}
entrypoint="$1"
shift
exec "${trellage_bun[@]}" "$entrypoint" -- "$@"
