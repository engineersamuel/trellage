#!/usr/bin/env bash
set -euo pipefail

umask 077

mkdir -p \
  "$COPILOT_HOME" \
  "$COPILOT_HOME/instructions" \
  /workspace/.harness/copilot-logs \
  /workspace/.npm \
  /workspace/.cache \
  /workspace/.config

managed_instructions='/usr/local/share/trellage/copilot-instructions/rundown.instructions.md'
instructions_tmp="$(mktemp "$COPILOT_HOME/instructions/.rundown.instructions.md.XXXXXX")"
cat -- "$managed_instructions" >"$instructions_tmp"
chmod 0600 "$instructions_tmp"
mv -f "$instructions_tmp" "$COPILOT_HOME/instructions/rundown.instructions.md"

plugin_inventory='/workspace/.harness/copilot-plugin-inventory.txt'
inventory_tmp="$(mktemp /workspace/.harness/copilot-plugin-inventory.XXXXXX)"
plugin_count=0

for plugin_dir in /opt/awesome-plugins/*; do
  [[ -d "$plugin_dir" ]] || continue
  plugin_name="$(basename "$plugin_dir")"
  manifest="$plugin_dir/.github/plugin/plugin.json"
  [[ -f "$manifest" ]] || {
    printf 'missing materialized Copilot plugin manifest: %s\n' "$manifest" >&2
    exit 1
  }
  jq -e --arg name "$plugin_name" '.name == $name' "$manifest" >/dev/null || {
    printf 'materialized Copilot plugin name mismatch: %s\n' "$manifest" >&2
    exit 1
  }
  find "$plugin_dir" -type f -printf '%P\n' | sort | sed "s#^#$plugin_name/#" >>"$inventory_tmp"
  plugin_count=$((plugin_count + 1))
done

[[ "$plugin_count" -gt 0 ]] || {
  printf 'no materialized Copilot plugins found\n' >&2
  exit 1
}

chmod 0600 "$inventory_tmp"
mv "$inventory_tmp" "$plugin_inventory"
chmod 0700 /workspace

if ! git -C /workspace rev-parse --git-dir >/dev/null 2>&1; then
  git -C /workspace init -b main -q
  git -C /workspace config user.name 'Sandbox Copilot Agent'
  git -C /workspace config user.email 'sandbox-copilot-agent@localhost'
fi

exec "$@"
