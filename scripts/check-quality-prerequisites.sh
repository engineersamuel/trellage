#!/usr/bin/env bash
set -euo pipefail

for tool in jq curl git make fish rg bun node uv; do
  command -v "$tool" >/dev/null || {
    printf 'quality prerequisite missing: %s\n' "$tool" >&2
    exit 1
  }
done
