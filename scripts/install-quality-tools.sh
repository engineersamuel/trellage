#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
tools=(bun node python uv)
case "${1:-static}" in
  runtime) ;;
  static|all)
    tools+=(shellcheck ruff github:jdx/jactionlint github:betterleaks/betterleaks
      github:agent-sh/agnix typos github:rvben/rumdl hadolint)
    ;;
  analysis) tools+=(npm:syncpack) ;;
  network) tools+=(github:google/osv-scanner lychee) ;;
  *) printf 'Usage: install-quality-tools.sh [runtime|static|analysis|network|all]\n' >&2; exit 2 ;;
esac
if [[ "${1:-static}" == all ]]; then
  tools+=(npm:syncpack github:google/osv-scanner lychee)
fi
mise install "${tools[@]}"
