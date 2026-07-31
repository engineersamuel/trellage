#!/usr/bin/env bash
set -euo pipefail

adapted_file=

cleanup_adapted_file() {
  local status=$?
  trap - EXIT
  if [[ -n "$adapted_file" ]]; then
    rm -f -- "$adapted_file" || status=1
  fi
  exit "$status"
}

trap cleanup_adapted_file EXIT

agent_kit_root="${1:?usage: adapt-agent-kit.sh AGENT_KIT_ROOT}"
agent_dir="$agent_kit_root/.codex/agents"
skill_dir="$agent_kit_root/.codex/skills"

[[ -d "$agent_dir" ]] || {
  printf 'Trellage plugin adapter: missing agent directory: %s\n' "$agent_dir" >&2
  exit 1
}
[[ -d "$skill_dir" ]] || {
  printf 'Trellage plugin adapter: missing skill directory: %s\n' "$skill_dir" >&2
  exit 1
}

for agent_file in "$agent_dir"/*.toml; do
  agent_name="$(sed -n 's/^name = "\([^"]*\)"/\1/p' "$agent_file")"
  [[ "$agent_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
    printf 'Trellage plugin adapter: invalid agent name in %s\n' "$agent_file" >&2
    exit 1
  }

  legacy_name="${agent_name/__/-}"
  [[ "$legacy_name" != "$agent_name" ]] || continue

  while IFS= read -r -d '' skill_file; do
    grep -Fq "$legacy_name" "$skill_file" || continue
    adapted_file="$(mktemp "${TMPDIR:-/tmp}/trellage-agent-kit-adapter.XXXXXX")"
    sed "s/${legacy_name}/${agent_name}/g" "$skill_file" >"$adapted_file"
    cp "$adapted_file" "$skill_file"
    rm -f -- "$adapted_file"
    adapted_file=
  done < <(find "$skill_dir" -type f -name '*.md' -print0)
done
