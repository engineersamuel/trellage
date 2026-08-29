#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'copilot agent image: FAIL: %s\n' "$1" >&2
  exit 1
}

for required_file in \
  Dockerfile.copilot-agent \
  scripts/copilot-agent-entrypoint.sh \
  scripts/run-copilot-agent.sh; do
  [[ -f "$required_file" ]] || fail "missing required file: $required_file"
done

grep -Fq 'ARG COPILOT_VERSION=latest' Dockerfile.copilot-agent \
  || fail 'Copilot CLI does not use the latest stable release'
grep -Fq 'ARG AWESOME_COPILOT_REF=main' Dockerfile.copilot-agent \
  || fail 'Awesome Copilot does not follow its development branch'
grep -Fq 'ARG AWESOME_COPILOT_PLUGINS="frontend-web-dev testing-automation"' Dockerfile.copilot-agent \
  || fail 'Awesome Copilot plugin selection changed'
grep -Fq 'npm install --global "@github/copilot@${COPILOT_VERSION}"' Dockerfile.copilot-agent \
  || fail 'selected Copilot CLI is not installed'
grep -Fq 'ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/' Dockerfile.copilot-agent \
  || fail 'Copilot image does not accept the selected npm registry'
grep -Fq '/usr/local/bin/materialize-awesome-plugin.sh' Dockerfile.copilot-agent \
  || fail 'Awesome Copilot materializer is not used'
grep -Fq 'USER 10001:10001' Dockerfile.copilot-agent \
  || fail 'Copilot agent user is not pinned non-root'
grep -Fq '/opt/trellage/source-provenance.json' Dockerfile.copilot-agent \
  || fail 'Copilot image does not install source provenance'
grep -Fq -- "--arg source 'https://github.com/github/awesome-copilot.git'" Dockerfile.copilot-agent \
  || fail 'Copilot source provenance does not identify Awesome Copilot'

if grep -Eiq 'ARG[[:space:]]+.*(TOKEN|SECRET|PASSWORD|API_KEY)' Dockerfile.copilot-agent; then
  fail 'credential build argument found'
fi

grep -Fq 'COPILOT_HOME=/workspace/.copilot-home' Dockerfile.copilot-agent \
  || fail 'Copilot home is not workspace-local'
grep -Fq 'scripts/find-harness-session.sh /usr/local/bin/find-harness-session.sh' \
  Dockerfile.copilot-agent || fail 'Copilot session discovery helper is not installed'
grep -Fq '/usr/local/bin/find-harness-session.sh' scripts/run-copilot-agent.sh \
  || fail 'native Copilot session recovery is missing'
grep -Fq '/run/secrets/copilot_token' scripts/run-copilot-agent.sh \
  || fail 'Copilot runner does not require the runtime secret'
grep -Fq 'unset COPILOT_PROVIDER_BASE_URL' scripts/run-copilot-agent.sh \
  || fail 'Copilot runner does not explicitly disable custom provider routing'
grep -Fq -- '--plugin-dir' scripts/run-copilot-agent.sh \
  || fail 'Copilot runner does not load local plugins'
grep -Fq -- '--disable-builtin-mcps' scripts/run-copilot-agent.sh \
  || fail 'Copilot runner does not disable the built-in GitHub MCP server'
grep -Fq -- '--no-remote' scripts/run-copilot-agent.sh \
  || fail 'Copilot runner does not disable remote session control'

if [[ "${BUILD_IMAGE_SMOKE:-0}" == '1' ]]; then
  image='trellage-copilot-agent:test'
  docker build -f Dockerfile.copilot-agent -t "$image" .
  version_output="$(docker run --rm --entrypoint copilot "$image" --version)"
  grep -Fq 'GitHub Copilot CLI' <<<"$version_output" \
    || fail "unexpected Copilot version output: $version_output"
  docker run --rm --entrypoint bash "$image" -lc '
    set -euo pipefail
    test -f /opt/awesome-plugins/frontend-web-dev/.github/plugin/plugin.json
    test -f /opt/awesome-plugins/frontend-web-dev/agents/expert-react-frontend-engineer.md
    test -f /opt/awesome-plugins/testing-automation/.github/plugin/plugin.json
    test -f /opt/awesome-plugins/testing-automation/agents/tdd-red.md
    jq -e '\''
      .schemaVersion == 1
      and .source == "https://github.com/github/awesome-copilot.git"
      and .requestedRef == "main"
      and (.resolvedCommit | test("^[0-9a-f]{40}$"))
    '\'' /opt/trellage/source-provenance.json >/dev/null
  '
fi

printf 'copilot agent image: PASS\n'
