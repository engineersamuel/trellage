#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hook_path="$(git -C "${repo_root}" rev-parse --path-format=absolute --git-path hooks/pre-commit)"
hook_dir="$(dirname "${hook_path}")"

mkdir -p "${hook_dir}"
temp_hook="$(mktemp "${hook_dir}/.pre-commit.XXXXXX")"
cleanup() {
  rm -f -- "${temp_hook}"
}
trap cleanup EXIT HUP INT TERM

cat >"${temp_hook}" <<'EOF'
#!/bin/sh
set -eu

active_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf '%s\n' 'trellage pre-commit: unable to resolve the active Git worktree.' >&2
  exit 1
}
lefthook="${active_root}/packages/trellage-cli/node_modules/.bin/lefthook"

if [ ! -x "${lefthook}" ]; then
  printf '%s\n' \
    "trellage pre-commit: Lefthook is missing or not executable at ${lefthook}" \
    "Run 'npm ci' in ${active_root}/packages/trellage-cli and retry." >&2
  exit 1
fi

exec "${lefthook}" run pre-commit "$@"
EOF

chmod 0755 "${temp_hook}"
mv -f -- "${temp_hook}" "${hook_path}"
trap - EXIT HUP INT TERM
