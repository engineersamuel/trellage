#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$prototype_dir/../.." && pwd)"
profile="${1:-$repo_root/profiles/codex-superpowers/profile.toml}"
profile="$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")"
lock="${profile%.toml}.lock.toml"
compiler="$repo_root/packages/trellage-cli/dist/cli.js"

fail() {
  printf 'Trellage image: FAIL: %s\n' "$1" >&2
  exit 1
}

for required_file in "$profile" "$lock" "$compiler"; do
  [[ -f "$required_file" ]] || fail "missing required file: $required_file"
done

node "$compiler" validate "$profile" >/dev/null
metadata="$(node "$compiler" metadata "$profile")"
profile_name="$(jq -er '.profile_name' <<<"$metadata")"
profile_hash="$(jq -er '.profile_hash' <<<"$metadata")"
harness_kind="$(jq -er '.harness_kind' <<<"$metadata")"
image_name="$(jq -er '.image' <<<"$metadata")"

[[ "$image_name" == "trellage-profile-${profile_name}:locked" ]] \
  || fail "profile metadata uses a non-Trellage image tag: $image_name"

jq -e \
  --arg name "$profile_name" \
  --arg image "trellage-profile-${profile_name}:locked" '
    .profile_name == $name
    and .locked == true
    and .image == $image
    and (.profile_hash | test("^sha256:[0-9a-f]{64}$"))
  ' <<<"$metadata" >/dev/null || fail 'profile metadata is invalid, stale, or missing its final OCI digest'

grep -Eq '^final_digest = "sha256:[0-9a-f]{64}"$' "$lock" \
  || fail 'final OCI digest is not locked'
! grep -Eiq '(token|secret|password|api[_-]?key)[[:space:]]*=[[:space:]]*"[^"[:space:]]+"' "$profile" "$lock" \
  || fail 'credential-like value is embedded in profile inputs'
! grep -Eq '(/[U]sers/|/var/[f]olders/|/private/tmp/|/tmp/harness-|harness-build-)' "$profile" "$lock" \
  || fail 'host, temporary, or build path is embedded in profile inputs'

locked_value() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    $0 == section { active = 1; next }
    active && /^\[/ { exit }
    active && index($0, key " = \"") == 1 {
      value = $0
      sub("^" key " = \\\"", "", value)
      sub("\\\"$", "", value)
      print value
      exit
    }
  ' "$lock"
}

case "$harness_kind" in
  codex)
    runtime_entry="$prototype_dir/runtime-entry.sh"
    [[ -f "$runtime_entry" ]] || fail "missing required file: $runtime_entry"
    grep -Fqx 'commit = "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9"' "$lock" \
      || fail 'Superpowers commit is not exact'
    grep -Fqx 'commit = "c4b82b0ad771190355eb8e204b1329732a18449a"' "$lock" \
      || fail 'compatibility plugin commit is not exact'
    ;;
  copilot)
    runtime_entry="$prototype_dir/runtime-copilot-entry.sh"
    [[ -f "$runtime_entry" ]] || fail "missing required file: $runtime_entry"
    [[ "$profile_name" == copilot-hve ]] || fail 'Copilot profile name is not exact'
    [[ "$(jq -r '.harness_executable' <<<"$metadata")" == copilot ]] \
      || fail 'Copilot executable metadata is not exact'
    [[ "$(jq -r '.runtime_entry' <<<"$metadata")" == trellage-copilot-entry ]] \
      || fail 'Copilot runtime entry metadata is not exact'
    [[ "$(jq -r '.auth_policy' <<<"$metadata")" == host-or-login ]] \
      || fail 'Copilot auth policy metadata is not exact'
    grep -Fqx 'kind = "copilot"' "$lock" || fail 'Copilot lock kind is not exact'
    grep -Fqx 'selector = "latest"' "$lock" || fail 'Copilot lock selector is not upgradeable'
    grep -Fqx 'adapter = "copilot-marketplace"' "$lock" || fail 'Copilot marketplace adapter is not locked'
    grep -Fqx 'marketplace = "hve-core"' "$lock" || fail 'HVE Core marketplace is not locked'
    grep -Fqx 'select = ["hve-core"]' "$lock" || fail 'HVE Core selection is not exact'
    grep -Eq '^plugin_versions = \{ "hve-core" = "[0-9]+\.[0-9]+\.[0-9]+" \}$' "$lock" \
      || fail 'HVE Core plugin version is not exact'
    ;;
  claude)
    runtime_entry="$prototype_dir/runtime-claude-entry.sh"
    [[ -f "$runtime_entry" ]] || fail "missing required file: $runtime_entry"
    [[ "$profile_name" == claude-hyperresearch ]] || fail 'Claude profile name is not exact'
    [[ "$(jq -r '.harness_executable' <<<"$metadata")" == claude ]] \
      || fail 'Claude executable metadata is not exact'
    [[ "$(jq -r '.runtime_entry' <<<"$metadata")" == trellage-claude-entry ]] \
      || fail 'Claude runtime entry metadata is not exact'
    [[ "$(jq -r '.auth_policy' <<<"$metadata")" == claude-explicit ]] \
      || fail 'Claude auth policy metadata is not exact'
    [[ "$(locked_value '[packages.harness]' kind)" == claude ]] \
      || fail 'Claude lock kind is not exact'
    [[ "$(locked_value '[packages.harness]' version)" == 2.1.218 ]] \
      || fail 'Claude version is not exact'
    grep -Fqx 'adapter = "hyperresearch"' "$lock" || fail 'Hyperresearch adapter is not locked'
    grep -Fqx 'commit = "183443aefec8d0444f4b53095cee17bf77ad5fb2"' "$lock" \
      || fail 'Hyperresearch commit is not exact'
    ;;
  *) fail "unsupported harness kind: $harness_kind" ;;
esac

if [[ "${STATIC_ONLY:-0}" == 1 ]]; then
  printf 'Trellage image contract: PASS (static: %s)\n' "$profile_name"
  exit 0
fi

[[ "$harness_kind" != claude ]] \
  || fail 'live Claude image contract is not implemented; use STATIC_ONLY=1'

IMAGE_REF="${IMAGE_REF:-$image_name}"
[[ "$IMAGE_REF" == "$image_name" ]] \
  || fail "live image reference does not match profile metadata: $IMAGE_REF"
[[ "$IMAGE_REF" == trellage-profile-*:locked ]] \
  || fail "live image reference is not a locked Trellage profile tag: $IMAGE_REF"
image_config="$(docker image inspect "$IMAGE_REF")"
case "$harness_kind" in
  codex) locked_version="$(locked_value '[packages]' codex)" ;;
  copilot) locked_version="$(locked_value '[packages.harness]' version)" ;;
esac
[[ "$locked_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] \
  || fail 'harness version is not exact in the lock'

jq -e \
  --arg hash "$profile_hash" \
  --arg name "$profile_name" \
  --arg kind "$harness_kind" \
  --arg version "$locked_version" '
    .[0].Config.User == "10001:10001"
    and .[0].Config.Cmd == ["fish", "-l"]
    and .[0].Config.Labels["dev.trellage.prototype"] == "trellage"
    and .[0].Config.Labels["dev.trellage.profile"] == $name
    and .[0].Config.Labels["dev.trellage.profile.hash"] == $hash
    and (.[0].Config.Env | any(. == "HOME=/home/agent"))
    and (.[0].Config.Env | all(test("(?i)(token|secret|password|api[_-]?key)=") | not))
    and (if $kind == "copilot" then
      .[0].Config.Labels["dev.trellage.harness.kind"] == $kind
      and .[0].Config.Labels["dev.trellage.copilot.version"] == $version
      and (.[0].Config.Env | any(. == "COPILOT_HOME=/home/agent/.copilot"))
      and (.[0].Config.Env | any(. == "COPILOT_AUTO_UPDATE=false"))
      and (.[0].Config.Env | any(. == "XDG_CACHE_HOME=/home/agent/.cache"))
      and (.[0].Config.Env | all(startswith("CODEX_HOME=") | not))
    else
      .[0].Config.Labels["dev.trellage.codex.version"] == $version
      and (.[0].Config.Env | any(. == "CODEX_HOME=/home/agent/.codex"))
    end)
  ' <<<"$image_config" >/dev/null \
  || fail 'image config violates exact labels, user, shell, home, version, or secret contract'

inspect_and_history="$(printf '%s\n' "$image_config"; docker history --no-trunc --format '{{.CreatedBy}} {{.Comment}}' "$IMAGE_REF")"
! grep -Eiq '(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|Authorization:|Bearer[[:space:]]+[[:graph:]]+|/[U]sers/|/var/[f]olders/|/private/tmp/|harness-build-|harness-profile-|dev\.sandbox-harness|/usr/local/share/harness|/usr/local/bin/harness-(codex|copilot)-entry|(^|[/[:space:]])harness-(codex|copilot)-entry([[:space:]]|$))' <<<"$inspect_and_history" \
  || fail 'image inspect or history contains auth, host, temporary, build, or old-brand data'

if [[ "$harness_kind" == copilot ]]; then
  [[ "$(docker run --rm --entrypoint stat "$IMAGE_REF" -c '%u:%g' /home/agent)" == 10001:10001 ]] \
    || fail 'Copilot image home directory is missing or not owned by the runtime user'
  hve_version="$(sed -n 's/^plugin_versions = { "hve-core" = "\([0-9.]*\)" }$/\1/p' "$lock")"
  [[ "$hve_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'HVE Core version is unavailable'
  docker run --rm \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001 \
    --tmpfs /home/agent:rw,exec,nosuid,nodev,size=256m,uid=10001,gid=10001 \
    --env 'COPILOT_GITHUB_TOKEN=trellage-image-contract-auth-canary' \
    --entrypoint bash \
    "$IMAGE_REF" -ceu '
      locked_version="$1"
      hve_version="$2"
      auth_canary="${COPILOT_GITHUB_TOKEN:?}"
      test "$(id -u):$(id -g)" = 10001:10001
      test "$COPILOT_HOME" = /home/agent/.copilot
      test "$(command -v copilot)" = "/mise/installs/http-copilot/$locked_version/copilot"
      test -x /usr/local/bin/trellage-copilot-entry
      test "$(copilot --version | sed -n '\''1s/^GitHub Copilot CLI \([0-9.]*\)\.$/\1/p'\'')" = "$locked_version"
      seed=/usr/local/share/trellage/copilot-seed
      test -d /usr/local/share/trellage
      test ! -e /usr/local/share/harness
      test ! -e /usr/local/bin/harness-copilot-entry
      for control in managed-lock.json managed-settings.json managed-files.txt managed.sha256; do
        test -f "$seed/$control"
      done
      plugin="$seed/installed-plugins/hve-core/hve-core"
      test -f "$plugin/.github/plugin/plugin.json"
      jq -e --arg version "$hve_version" '\''
        .name == "hve-core" and .version == $version
      '\'' "$plugin/.github/plugin/plugin.json" >/dev/null
      jq -e '\''
        .extraKnownMarketplaces["hve-core"].source
          == {source:"github", repo:"microsoft/hve-core"}
        and .enabledPlugins["hve-core@hve-core"] == true
      '\'' "$seed/managed-settings.json" >/dev/null
      test ! -e "$seed/settings.json"
      test ! -e "$seed/config.json"
      test ! -e /home/agent/.codex/config.toml
      ! find "$seed" -type f -exec grep -alE '\''/[U]sers/[^/]+/projects/prototypes/sandbox-harness|/src/hve-core|/src/copilot-seed|/var/[f]olders/|/private/tmp/|/tmp/harness-|harness-build-'\'' {} + | grep -q .
      ! find "$seed" -type f -exec grep -alF "$auth_canary" {} + | grep -q .
      trellage-copilot-entry new --version >/tmp/copilot-version
      test "$(sed -n '\''1s/^GitHub Copilot CLI \([0-9.]*\)\.$/\1/p'\'' /tmp/copilot-version)" = "$locked_version"
      test -f "$COPILOT_HOME/managed-lock.json"
      test ! -e "$COPILOT_HOME/config.toml"
      ! find "$COPILOT_HOME" "$XDG_CACHE_HOME" -type f -exec grep -alE '\''/[U]sers/[^/]+/projects/prototypes/sandbox-harness|/src/hve-core|/src/copilot-seed|/var/[f]olders/|/private/tmp/|/tmp/harness-|harness-build-'\'' {} + | grep -q .
      ! find "$COPILOT_HOME" "$XDG_CACHE_HOME" -type f -exec grep -alF "$auth_canary" {} + | grep -q .
    ' -- "$locked_version" "$hve_version" \
    || fail 'Copilot executable, entry, seed, HVE, path, auth, or Codex-isolation probe failed'
else
  docker run --rm \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
    --entrypoint bash \
    "$IMAGE_REF" -ceu '
      locked_version="$1"
      test "$(id -u):$(id -g)" = 10001:10001
      command -v fish bash zsh git curl jq flock codex trellage-codex-entry >/dev/null
      test -x /usr/local/bin/trellage-codex-entry
      test ! -e /usr/local/share/harness
      test ! -e /usr/local/bin/harness-codex-entry
      test "$(codex --version 2>/dev/null)" = "codex-cli $locked_version"
      grep -Fqx '\''model_provider = "copilot_proxy"'\'' "$CODEX_HOME/config.toml"
      test -f "$CODEX_HOME/skills/using-superpowers/SKILL.md"
      test -f "$CODEX_HOME/skills/full-stack-orchestration__full-stack-feature/SKILL.md"
      test -f "$CODEX_HOME/agents/full-stack-orchestration__security-auditor.toml"
      test "$(find "$CODEX_HOME/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d " ")" = 15
      test "$(find "$CODEX_HOME/agents" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 4
      test -z "$(find "$CODEX_HOME/skills" "$CODEX_HOME/agents" -type l -print -quit)"
      ! touch /read-only-root-proof 2>/dev/null
      test -w /tmp
    ' -- "$locked_version" || fail 'read-only-root Codex runtime smoke failed'
fi

printf 'Trellage image contract: PASS (static + live: %s)\n' "$profile_name"
