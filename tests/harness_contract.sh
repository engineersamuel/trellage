#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'harness contract: FAIL: %s\n' "$1" >&2
  exit 1
}

for required_file in \
  Dockerfile.agent \
  Dockerfile.copilot-agent \
  Dockerfile.app \
  compose.yaml \
  compose.copilot.yaml \
  docker/codex-config.toml \
  scripts/agent-entrypoint.sh \
  scripts/find-harness-session.sh \
  scripts/run-agent.sh \
  scripts/app-entrypoint.sh; do
  [[ -f "$required_file" ]] || fail "missing required file: $required_file"
done

grep -Fqx 'model = "gpt-5.5"' docker/codex-config.toml || fail 'Codex model is not pinned'
grep -Fqx 'base_url = "http://copilot-proxy-rs:8080/v1"' docker/codex-config.toml || fail 'proxy URL is not container-local'
grep -Fqx 'wire_api = "responses"' docker/codex-config.toml || fail 'Codex is not using Responses'

for agent_dockerfile in Dockerfile.agent Dockerfile.copilot-agent; do
  grep -Fq 'ARG PLAYWRIGHT_VERSION=latest' "$agent_dockerfile" \
    || fail "$agent_dockerfile does not use the latest stable browser-runtime dependency"
  grep -Fq 'playwright@${PLAYWRIGHT_VERSION}" install-deps chromium' "$agent_dockerfile" \
    || fail "$agent_dockerfile does not install Chromium runtime dependencies"
  grep -Fq 'ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/' "$agent_dockerfile" \
    || fail "$agent_dockerfile does not accept the selected npm registry"
  grep -Fq '/opt/trellage/source-provenance.json' "$agent_dockerfile" \
    || fail "$agent_dockerfile does not install immutable source provenance"
  grep -Fq '{schemaVersion: 1, source: $source, requestedRef: $requestedRef, resolvedCommit: $resolvedCommit}' \
    "$agent_dockerfile" \
    || fail "$agent_dockerfile source provenance schema is incomplete"
  grep -Fq "grep -Eq '^[0-9a-f]{40}$'" "$agent_dockerfile" \
    || fail "$agent_dockerfile does not require a lowercase full resolved commit"
done

if grep -Eq '/opt/(agent-kit|awesome-copilot)-source-commit\.txt' \
  Dockerfile.agent Dockerfile.copilot-agent; then
  fail 'legacy unstructured image source commit remains'
fi

grep -Fq 'ARG WSHOBSON_AGENTS_REF=main' Dockerfile.agent \
  || fail 'Codex package source does not follow its development branch'
grep -Fq 'ARG PIP_INDEX_URL=https://pypi.org/simple/' Dockerfile.agent \
  || fail 'Codex adapter does not accept the selected Python index'
grep -Fq 'ARG CODEX_VERSION=latest' Dockerfile.agent \
  || fail 'Codex comparison runtime does not use the latest stable release'
grep -Fq 'ARG WSHOBSON_AGENTS_PLUGIN=full-stack-orchestration' Dockerfile.agent \
  || fail 'Codex plugin build argument is missing'
grep -Fq -- '--plugin "${WSHOBSON_AGENTS_PLUGIN}"' Dockerfile.agent \
  || fail 'Codex plugin build argument does not drive generation'
grep -Fq '/opt/agent-kit-inventory.txt' scripts/agent-entrypoint.sh \
  || fail 'Codex entrypoint does not validate a plugin-independent inventory'

if missing_skills_output="$(
  env -u HARNESS_SKILLS_CONTEXT docker compose --profile tools config --format json 2>&1
)"; then
  fail 'Compose accepted a missing floating-skill build context'
fi
grep -Fq 'set HARNESS_SKILLS_CONTEXT to a staged floating-skill snapshot' \
  <<<"$missing_skills_output" \
  || fail 'Compose did not explain the missing floating-skill build context'

compose_json="$(HARNESS_SKILLS_CONTEXT=/dev/null docker compose --profile tools config --format json)"
alternate_compose_json="$(
  HARNESS_SKILLS_CONTEXT=/dev/null EXPERIMENT_ID=isolation-probe APP_PORT=4273 \
    docker compose --profile tools config --format json
)"
copilot_compose_json="$(
  HARNESS_SKILLS_CONTEXT=/dev/null \
  HARNESS_COPILOT_TOKEN_FILE='/tmp/contract-sentinel-copilot-token' \
  EXPERIMENT_ID='copilot-isolation-probe' \
  APP_PORT=4274 \
  docker compose -f compose.yaml -f compose.copilot.yaml --profile tools config --format json
)"

jq -e '
  .name == "trellage"
  and .services.agent.image == "trellage-agent:local"
  and .services.workspace_init.image == "trellage-agent:local"
  and .services.app.image == "trellage-app:local"
  and .services.data_init.image == "trellage-app:local"
  and .services.workspace_publish.image == "trellage-app:local"
' <<<"$compose_json" >/dev/null || fail 'default project and image identities are not Trellage'

jq -e '
  .name == "isolation-probe"
  and .services.agent.image == "isolation-probe-agent:local"
  and .services.workspace_init.image == "isolation-probe-agent:local"
  and .services.app.image == "isolation-probe-app:local"
  and .services.data_init.image == "isolation-probe-app:local"
  and .services.workspace_publish.image == "isolation-probe-app:local"
  and .services.app.ports[0].published == "4273"
' <<<"$alternate_compose_json" >/dev/null || fail 'experiment identity does not scope project, images, and host port'
jq -e '.services.agent.profiles == ["tools"]' <<<"$compose_json" >/dev/null || fail 'agent profile is not tools-only'
jq -e '.services.agent.build.args.WSHOBSON_AGENTS_PLUGIN == "full-stack-orchestration"' <<<"$compose_json" >/dev/null || fail 'Codex plugin does not flow into the image build'
jq -e '.services.agent.networks | has("copilot_proxy")' <<<"$compose_json" >/dev/null || fail 'agent cannot reach proxy network'
jq -e '.services.app.networks | has("copilot_proxy") | not' <<<"$compose_json" >/dev/null || fail 'app can reach proxy network'
jq -e '(.networks.default.internal // false) == false' <<<"$compose_json" >/dev/null || fail 'app runtime network cannot publish its loopback port'
jq -e '.services.app.ports | length == 1 and .[0].mode == "ingress" and .[0].target == 3000 and .[0].published == "4173" and .[0].protocol == "tcp" and .[0].host_ip == "127.0.0.1"' <<<"$compose_json" >/dev/null || fail 'app port is not loopback-only 4173 -> 3000'
jq -e '.services.agent.volumes[] | select(.target == "/workspace" and .type == "volume" and ((has("read_only") | not) or .read_only == false))' <<<"$compose_json" >/dev/null || fail 'agent workspace is not a writable named volume'
jq -e '.services.app.volumes[] | select(.target == "/workspace" and .type == "volume" and .read_only == true)' <<<"$compose_json" >/dev/null || fail 'app workspace is not read-only'
jq -e '.services.app.volumes[] | select(.target == "/data" and .type == "volume" and ((has("read_only") | not) or .read_only == false))' <<<"$compose_json" >/dev/null || fail 'app data is not a writable named volume'
jq -e '[.services[]?.volumes[]? | select(.type == "bind")] | length == 0' <<<"$compose_json" >/dev/null || fail 'host bind mount found'
jq -e '[.services[]?.volumes[]? | select(.source == "/var/run/docker.sock")] | length == 0' <<<"$compose_json" >/dev/null || fail 'Docker socket mount found'
jq -e '.services.agent.cap_drop == ["ALL"] and .services.app.cap_drop == ["ALL"]' <<<"$compose_json" >/dev/null || fail 'capabilities are not fully dropped'
jq -e '.services.agent.read_only == true and .services.app.read_only == true' <<<"$compose_json" >/dev/null || fail 'root filesystem is writable'
jq -e '.services.agent.security_opt == ["no-new-privileges:true"] and .services.app.security_opt == ["no-new-privileges:true"]' <<<"$compose_json" >/dev/null || fail 'no-new-privileges is missing'
jq -e '.services.agent.user == "10001:10001" and .services.app.user == "10002:10002"' <<<"$compose_json" >/dev/null || fail 'container users are not pinned non-root IDs'
jq -e '.services.agent.depends_on.workspace_init.condition == "service_completed_successfully"' <<<"$compose_json" >/dev/null || fail 'agent does not wait for workspace ownership initialization'
jq -e '.services.workspace_init.user == "0:0" and .services.workspace_init.cap_drop == ["ALL"] and .services.workspace_init.cap_add == ["CHOWN", "DAC_OVERRIDE", "FOWNER"]' <<<"$compose_json" >/dev/null || fail 'workspace initializer is not minimally privileged'
jq -e '.services.workspace_init.volumes | length == 1 and .[0].target == "/workspace" and .[0].type == "volume"' <<<"$compose_json" >/dev/null || fail 'workspace initializer has unexpected mounts'
jq -e '.services.app.depends_on.data_init.condition == "service_completed_successfully"' <<<"$compose_json" >/dev/null || fail 'app does not wait for data ownership initialization'
jq -e '.services.app.depends_on.workspace_publish.condition == "service_completed_successfully"' <<<"$compose_json" >/dev/null || fail 'app does not wait for runtime artifact publication'
jq -e '.services.data_init.user == "0:0" and .services.data_init.cap_drop == ["ALL"] and .services.data_init.cap_add == ["CHOWN", "DAC_OVERRIDE", "FOWNER"]' <<<"$compose_json" >/dev/null || fail 'data initializer is not minimally privileged'
jq -e '.services.workspace_publish.user == "0:0" and .services.workspace_publish.network_mode == "none" and .services.workspace_publish.cap_drop == ["ALL"] and .services.workspace_publish.cap_add == ["CHOWN", "DAC_OVERRIDE", "FOWNER"]' <<<"$compose_json" >/dev/null || fail 'runtime artifact publisher is not minimally privileged'
jq -e '.services.workspace_publish.volumes | length == 1 and .[0].target == "/workspace" and .[0].type == "volume"' <<<"$compose_json" >/dev/null || fail 'runtime artifact publisher has unexpected mounts'
jq -e '.services.workspace_publish.command | join("\n") | contains("chmod -R u=rwX,g=rX,o= \"$${runtime_targets[@]}\"")' \
  <<<"$compose_json" >/dev/null || fail 'runtime artifact publisher does not grant only the app group read/search access'
jq -e '.services.workspace_publish.command | join("\n") | contains("go=rX") | not' \
  <<<"$compose_json" >/dev/null || fail 'runtime artifact publisher grants world read/search access'
jq -e '.networks.copilot_proxy.external == true and .networks.copilot_proxy.name == "copilot-proxy-rs_default"' <<<"$compose_json" >/dev/null || fail 'proxy network is not the existing external network'

jq -e '
  .services.copilot_agent.image == "copilot-isolation-probe-agent:local"
  and .services.copilot_agent.profiles == ["tools"]
  and .services.copilot_agent.user == "10001:10001"
  and .services.copilot_agent.read_only == true
  and .services.copilot_agent.cap_drop == ["ALL"]
  and .services.copilot_agent.security_opt == ["no-new-privileges:true"]
  and .services.copilot_agent.pids_limit == 512
  and .services.copilot_agent.mem_limit == "4294967296"
  and .services.copilot_agent.cpus == 4
' <<<"$copilot_compose_json" >/dev/null || fail 'Copilot agent hardening does not match the agent contract'
jq -e '
  (.services.copilot_agent.networks | keys) == ["default"]
  and (.services.agent.networks | has("copilot_proxy"))
  and (.services.copilot_agent.networks | has("copilot_proxy") | not)
' <<<"$copilot_compose_json" >/dev/null || fail 'Copilot and Codex provider networks are not isolated'
jq -e '
  .services.copilot_agent.volumes == [{"type":"volume","source":"workspace","target":"/workspace"}]
  and .services.copilot_agent.depends_on.workspace_init.condition == "service_completed_successfully"
' <<<"$copilot_compose_json" >/dev/null || fail 'Copilot workspace is not the project-scoped named volume'
jq -e '
  (.services.copilot_agent.secrets | length) == 1
  and .services.copilot_agent.secrets[0].source == "copilot_token"
  and .services.copilot_agent.secrets[0].target == "copilot_token"
  and ((.services.agent.secrets // []) | length) == 0
  and ((.services.app.secrets // []) | length) == 0
  and ((.services.workspace_init.secrets // []) | length) == 0
' <<<"$copilot_compose_json" >/dev/null || fail 'native Copilot token secret scope is incorrect'
jq -e '.secrets.copilot_token.file == "/tmp/contract-sentinel-copilot-token"' \
  <<<"$copilot_compose_json" >/dev/null || fail 'Copilot token is not sourced from an ephemeral Compose file secret'
jq -e '[.services[]?.volumes[]? | select(.type == "bind")] | length == 0' \
  <<<"$copilot_compose_json" >/dev/null || fail 'host bind mount found in Copilot comparison configuration'
jq -e '[.services[]?.volumes[]? | select(.source == "/var/run/docker.sock")] | length == 0' \
  <<<"$copilot_compose_json" >/dev/null || fail 'Docker socket found in Copilot comparison configuration'
jq -e '((.services.copilot_agent.environment // {}) | has("COPILOT_GITHUB_TOKEN") | not)' \
  <<<"$copilot_compose_json" >/dev/null || fail 'Copilot token is exposed as inspectable container environment'

grep -Fq -- '--dangerously-bypass-approvals-and-sandbox' scripts/run-agent.sh || fail 'Codex external-sandbox mode is missing'
grep -Fq '/usr/local/bin/adapt-agent-kit.sh /workspace' scripts/agent-entrypoint.sh || fail 'generated agent references are not adapted in the live workspace'
grep -Fq '"$CODEX_HOME/agents"' scripts/agent-entrypoint.sh || fail 'generated agents are not installed into container-local CODEX_HOME'
grep -Fq 'scripts/find-harness-session.sh /usr/local/bin/find-harness-session.sh' Dockerfile.agent \
  || fail 'Codex session discovery helper is not installed'
grep -Fq 'chmod 0700 /workspace' scripts/agent-entrypoint.sh || fail 'workspace mode is not restored after archive-preserving seed copy'

printf 'harness contract: PASS\n'
