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
if ! command -v shellcheck >/dev/null 2>&1; then
  printf 'shell syntax: ShellCheck is required but not installed\n' >&2
  exit 1
fi

while IFS= read -r -d '' file; do
  [[ -L "$file" || ! -f "$file" ]] && continue
  [[ "$file" == prototypes/software-factory/web-foldkit/repos/foldkit/* ]] && continue

  shebang=''
  IFS= read -r shebang <"$file" || :
  # Only a shebang line is split; read can fail on the first line of a binary file.
  shebang_parts=()
  if [[ "$shebang" == '#!'* ]]; then
    read -r -a shebang_parts <<<"$shebang"
  fi
  shell=''
  case "${shebang_parts[0]:-}" in
    '#!/usr/bin/env')
      case "${shebang_parts[1]:-}" in
        bash) shell='bash' ;;
        sh) shell='sh' ;;
      esac
      ;;
    '#!/bin/bash') shell='bash' ;;
    '#!/bin/sh') shell='sh' ;;
  esac
  if [[ -z "$shell" && "$shebang" != '#!'* && "$file" == *.sh ]]; then
    shell=bash
  fi
  [[ -n "$shell" ]] || continue

  if ! "$shell" -n -- "$file"; then
    printf 'shell syntax error: %s\n' "$file" >&2
    exit 1
  fi
  if ! shellcheck --severity=error --shell="$shell" -- "$file"; then
    printf 'shellcheck error: %s\n' "$file" >&2
    exit 1
  fi
  checked=$((checked + 1))
done <"$files_tmp"

printf 'shell syntax and critical ShellCheck rules: checked %d scripts\n' "$checked"
