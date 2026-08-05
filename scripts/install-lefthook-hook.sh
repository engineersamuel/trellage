#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

install_hook() {
  local hook_name="$1"
  local hook_path hook_dir temp_hook
  hook_path="$(git -C "$repo_root" rev-parse --path-format=absolute --git-path "hooks/$hook_name")"
  hook_dir="$(dirname "$hook_path")"
  mkdir -p "$hook_dir"
  temp_hook="$(mktemp "$hook_dir/.$hook_name.XXXXXX")"

  cat >"$temp_hook" <<'EOF'
#!/bin/sh
set -eu

hook_name="$(basename "$0")"
active_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'trellage %s: unable to resolve the active Git worktree.\n' "$hook_name" >&2
  exit 1
}

case "$hook_name" in
  pre-commit)
    lefthook="${active_root}/packages/trellage-cli/node_modules/.bin/lefthook"
    if [ ! -x "$lefthook" ]; then
      printf '%s\n' \
        "trellage pre-commit: Lefthook is missing or not executable at ${lefthook}" \
        "Run 'npm ci' in ${active_root}/packages/trellage-cli and retry." >&2
      exit 1
    fi
    exec "$lefthook" run pre-commit "$@"
    ;;
  post-merge|post-rewrite)
    command -v npm >/dev/null 2>&1 || {
      printf 'trellage %s: npm is unavailable; rebuild the profile compiler manually.\n' "$hook_name" >&2
      exit 1
    }
    exec npm --prefix "${active_root}/packages/trellage-cli" run build
    ;;
  *)
    printf 'trellage hook: unsupported hook name: %s\n' "$hook_name" >&2
    exit 1
    ;;
esac
EOF

  chmod 0755 "$temp_hook"
  mv -f -- "$temp_hook" "$hook_path"
}

for hook_name in pre-commit post-merge post-rewrite; do
  install_hook "$hook_name"
done
