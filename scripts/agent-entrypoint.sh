#!/usr/bin/env bash
set -euo pipefail

umask 077

mkdir -p "$CODEX_HOME" /workspace/.harness /workspace/.npm /workspace/.cache /workspace/.config

inventory_path='/opt/agent-kit-inventory.txt'
needs_seed=false
while IFS= read -r artifact; do
  if [[ ! -f "/workspace/$artifact" ]]; then
    needs_seed=true
    break
  fi
done <"$inventory_path"
if [[ "$needs_seed" == true ]]; then
  cp -a /opt/agent-kit/. /workspace/
fi
/usr/local/bin/adapt-agent-kit.sh /workspace
chmod 0700 /workspace

install -m 0600 /opt/codex-config.toml "$CODEX_HOME/config.toml"

while IFS= read -r artifact; do
  [[ -f "/workspace/$artifact" ]] || {
    printf 'missing generated agent artifact: %s\n' "$artifact" >&2
    exit 1
  }
done <"$inventory_path"

inventory_tmp="$(mktemp /workspace/.harness/agent-package-inventory.XXXXXX)"
while IFS= read -r artifact; do
  printf '%s\n' "$artifact" >>"$inventory_tmp"
done <"$inventory_path"
chmod 0600 "$inventory_tmp"
mv "$inventory_tmp" /workspace/.harness/agent-package-inventory.txt

mkdir -p "$CODEX_HOME/agents"
for agent_config in /workspace/.codex/agents/*.toml; do
  install -m 0600 "$agent_config" "$CODEX_HOME/agents/$(basename "$agent_config")"
done

if ! git -C /workspace rev-parse --git-dir >/dev/null 2>&1; then
  git -C /workspace init -b main -q
  git -C /workspace config user.name 'Sandbox Agent'
  git -C /workspace config user.email 'sandbox-agent@localhost'
fi

exec "$@"
