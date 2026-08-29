#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
script="$repo_root/scripts/azure-fresh-install.sh"

fail() {
  printf 'azure fresh install contract: %s\n' "$1" >&2
  exit 1
}

[[ -x "$script" ]] || fail "script is missing or not executable: $script"
bash -n "$script"

help="$("$script" --help)"
grep -Fq 'all|create|bootstrap|accept|ssh|status|down|plan' <<<"$help" \
  || fail 'help does not publish the lifecycle commands'
grep -Fq 'copilot-proxy-rs uses COPILOT_PROXY_GITHUB_TOKEN' <<<"$help" \
  || fail 'help does not state the separate proxy authentication source'
grep -Fq 'Bare `trx` is an interactive TTY picker' <<<"$help" \
  || fail 'help does not explain the automated native launch'
grep -Fq 'all eight Trellage Native launchers' <<<"$help" \
  || fail 'help does not describe the complete Native matrix'
grep -Fq '`trellage --profile claude-council`' <<<"$help" \
  || fail 'help does not describe the Sandbox acceptance profile'

plan="$(
  TRELLAGE_AZURE_RESOURCE_GROUP_PREFIX=trellage-contract \
  TRELLAGE_AZURE_SSH_SOURCE=192.0.2.10/32 \
  TRELLAGE_AZURE_ATTEMPTS=2 \
  XDG_STATE_HOME="$(mktemp -d)" \
  "$script" plan
)"
grep -Eq '^resource group: trellage-contract-[0-9]{14}-[0-9]+-[0-9]+$' <<<"$plan" \
  || fail 'plan does not generate a unique disposable resource group'
grep -Fq 'VM:             trellage-fresh-vm (Standard_D4ps_v5)' <<<"$plan" \
  || fail 'plan does not use the ARM64 D4ps default'
grep -Fq 'image:          Canonical:ubuntu-24_04-lts:server-arm64:latest' <<<"$plan" \
  || fail 'plan does not use Ubuntu 24.04 ARM64'
grep -Fq 'SSH source:     192.0.2.10/32' <<<"$plan" \
  || fail 'plan does not preserve the restricted SSH source'
grep -Fq 'native probes:  all eight launchers through trx run' <<<"$plan" \
  || fail 'plan does not include all Native launchers'
grep -Fq 'sandbox probe:  trellage --profile claude-council' <<<"$plan" \
  || fail 'plan does not include the Claude Council Sandbox profile'

grep -Fq -- '--source-address-prefixes "$ssh_source"' "$script" \
  || fail 'NSG rule is not source restricted'
grep -Fq 'resource group already exists; use a new disposable group name' "$script" \
  || fail 'create does not refuse a pre-existing resource group'
grep -Fq 'printf '\''subscription_id=%s\n'\'' "$subscription_id"' "$script" \
  || fail 'state is not bound to the creating Azure subscription'
grep -Fq -- '--subscription "$subscription_id"' "$script" \
  || fail 'Azure lifecycle commands do not use the saved subscription'
grep -Fq -- '--security-type Standard' "$script" \
  || fail 'VM security type is not explicit'
grep -Fq 'git clone --no-checkout "$repository" "$checkout"' "$script" \
  || fail 'bootstrap does not clone on the fresh VM'
grep -Fq 'git -C "$checkout" fetch origin --tags --prune' "$script" \
  || fail 'bootstrap cannot resume safely after a failed install'
grep -Fq 'git -C "$checkout" checkout --detach "$target"' "$script" \
  || fail 'bootstrap does not check out a deterministic fetched revision'
grep -Fq 'TRELLAGE_AZURE_APPLY_LOCAL_CHANGES' "$script" \
  || fail 'workflow cannot test local unmerged runtime candidates'
grep -Fq 'trellage-omp-catalog-candidate' "$script" \
  || fail 'local candidate overlay does not include the certified OMP catalog'
grep -Fq 'trellage-headless-capabilities-candidate' "$script" \
  || fail 'local candidate overlay does not include compiler headless capabilities'
grep -Fq 'trellage-application-candidate' "$script" \
  || fail 'local candidate overlay does not include compiler builder fixes'
grep -Fq 'trellage-materialize-candidate' "$script" \
  || fail 'local candidate overlay does not include compiler materialization fixes'
grep -Fq 'trellage-finalize-claude-seed-candidate' "$script" \
  || fail 'local candidate overlay does not include Claude finalizer fixes'
grep -Fq '  - fish' "$script" \
  || fail 'cloud-init does not install Fish for the Native Codex launcher'
grep -Fq '  - bubblewrap' "$script" \
  || fail 'cloud-init does not install bubblewrap for the Native Grok sandbox'
grep -Fq 'profile trellage-bwrap /usr/bin/bwrap flags=(unconfined)' "$script" \
  || fail 'bootstrap does not grant bubblewrap a narrow AppArmor userns policy'
grep -Fq 'bwrap --ro-bind / / --dev /dev --proc /proc /bin/true' "$script" \
  || fail 'bootstrap does not verify the bubblewrap sandbox prerequisite'
grep -Fq 'install -m 600 /dev/null "$HOME/.config/fish/config.fish"' "$script" \
  || fail 'bootstrap does not create the required regular Fish config'
[[ "$(grep -Fc 'eval "$(mise activate bash)"' "$script")" -ge 2 ]] \
  || fail 'bootstrap and acceptance do not activate mise for managed tools'
grep -Fq '| map(. as $pair' "$script" \
  || fail 'trx list assertion does not use portable jq array predicates'
grep -Fq 'and .data.content != ""' "$script" \
  || fail 'Copilot result assertion does not ignore trailing empty events'
grep -Fq "jq -e '.text == \"OK\"' \"\$log_dir/native-jcx.json\"" "$script" \
  || fail 'JCode result does not require exact JSON text OK'
grep -Fq 'scripts/rebuild-profile-images.sh --install --native-only' "$script" \
  || fail 'bootstrap does not install the Native stack and trx'
grep -Fq '@xai-official/grok@0.2.112' "$script" \
  || fail 'bootstrap does not install the verified Grok CLI'
grep -Fq 'git clone --no-checkout "$proxy_repository" "$proxy_checkout"' "$script" \
  || fail 'bootstrap does not clone copilot-proxy-rs on the VM'
grep -Fq 'docker compose -f compose.yaml -f "$proxy_override" up -d --build --force-recreate' "$script" \
  || fail 'acceptance does not start copilot-proxy-rs'
grep -Fq 'source: $proxy_config' "$script" \
  || fail 'proxy token directory is not supplied through the tmpfs path'
grep -Fq 'COPILOT_PROXY_RS_LOG_FAILED_REQUEST_BODIES: "false"' "$script" \
  || fail 'proxy failed-request body logging is not disabled'
grep -Fq 'http://127.0.0.1:8080/v1/chat/completions' "$script" \
  || fail 'acceptance does not live-probe copilot-proxy-rs'
grep -Fq 'collect_evidence' "$script" \
  || fail 'successful remote evidence is not collected locally'
grep -Fq "trap 'all_failure \$?' EXIT" "$script" \
  || fail 'all does not report explicit-exit failures and retained resources'
if ! awk '
  /cloud_init=.*mktemp/ { before = previous }
  { previous = $0 }
  END { exit before == "  (" ? 0 : 1 }
' "$script"; then
  fail 'cloud-init cleanup is not isolated from the all failure trap'
fi
grep -Fq "printf -v rsync_ssh '%s %q'" "$script" \
  || fail 'evidence transport does not shell-escape SSH arguments'
if grep -Fq '${SSH_ARGUMENTS[*]}' "$script"; then
  fail 'evidence transport re-splits the SSH argument array'
fi
grep -Fq 'deleted resource group' "$script" \
  || fail 'all does not delete the successful resource group'
for pair in \
  'cpx hve' \
  'cdx pstack' \
  'cldx default' \
  'grx superpowers' \
  'jcx default' \
  'omp copilot' \
  'picx default' \
  'prx default'; do
  grep -Fq "trx run $pair --" "$script" \
    || fail "acceptance does not route $pair through trx run"
done
grep -Fq 'trellage --profile claude-council' "$script" \
  || fail 'acceptance does not invoke the Claude Council Sandbox profile'
grep -Fq 'trellage build claude-council' "$script" \
  || fail 'acceptance does not resolve and build the floating Council profile before probing'
grep -Fq '$result.finalText == "OK"' "$script" \
  || fail 'Claude Council result does not require exact final text OK'
grep -Fq "printf '%s\\n' \"\$copilot_token\"" "$script" \
  || fail 'Copilot token is not streamed through stdin'
grep -Fq "printf '%s\\n' \"\$proxy_token\"" "$script" \
  || fail 'proxy token is not streamed through stdin'
grep -Fq 'IFS= read -r COPILOT_PROXY_GITHUB_TOKEN' "$script" \
  || fail 'remote acceptance does not read the proxy token from stdin'
grep -Fq 'bash "$script_file" </dev/null' "$script" \
  || fail 'harnesses can consume the remote acceptance program from stdin'
if grep -Eq 'GH_TOKEN=.gh_token.|COPILOT_GITHUB_TOKEN=.copilot_token.' "$script"; then
  fail 'Copilot token is exposed in an SSH command argument'
fi

printf 'azure fresh install contract: PASS\n'
