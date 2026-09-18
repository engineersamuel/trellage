#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'shell syntax: not inside a Git worktree\n' >&2
  exit 1
}
cd "$repo_root"

files_tmp="$(mktemp "${TMPDIR:-/tmp}/check-shell-syntax.XXXXXX")"
trap 'rm -f -- "$files_tmp"' EXIT

if ! git ls-files -z -- >"$files_tmp"; then
  printf 'shell syntax: git ls-files failed\n' >&2
  exit 1
fi

checked=0
while IFS= read -r -d '' file; do
  [[ -L "$file" || ! -f "$file" ]] && continue

  shebang=''
  IFS= read -r shebang <"$file" || :
  read -r -a shebang_parts <<<"$shebang"
  shell=''
  case "${shebang_parts[0]:-}" in
    '#!/usr/bin/env')
      case "${shebang_parts[1]:-}" in
        bash) shell=bash ;;
        sh) shell=sh ;;
      esac
      ;;
    '#!/bin/bash') shell=bash ;;
    '#!/bin/sh') shell=sh ;;
  esac
  if [[ -z "$shell" && "$shebang" != '#!'* && "$file" == *.sh ]]; then
    shell=bash
  fi
  [[ -n "$shell" ]] || continue

  if ! "$shell" -n -- "$file"; then
    printf 'shell syntax error: %s\n' "$file" >&2
    exit 1
  fi
  checked=$((checked + 1))
done <"$files_tmp"

printf 'shell syntax: checked %d scripts\n' "$checked"
