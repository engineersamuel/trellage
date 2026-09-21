#!/usr/bin/env bash
set -euo pipefail

case "${npm_config_user_agent-}" in
  bun/1.4.2|bun/1.4.2\ *) ;;
  *)
    printf 'trellage dependencies: Bun 1.4.2 is required; package manager reported: %s\n' \
      "${npm_config_user_agent:-unknown}" >&2
    exit 1
    ;;
esac
