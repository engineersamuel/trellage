#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$prototype_dir/../.." && pwd)"
profile="${1:-$repo_root/profiles/codex-superpowers/profile.toml}"
profile="$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")"
compiler="$repo_root/packages/trellage-cli/dist/cli.js"

fail() {
  printf 'Trellage image contract: FAIL: %s\n' "$1" >&2
  exit 1
}

for required_file in "$profile" "$compiler"; do
  [[ -f "$required_file" ]] || fail "missing required file: $required_file"
done

node "$compiler" validate "$profile" >/dev/null
metadata="$(node "$compiler" metadata "$profile")"
profile_name="$(jq -er '.profile_name' <<<"$metadata")"
profile_hash="$(jq -er '.profile_hash' <<<"$metadata")"
harness_kind="$(jq -er '.harness_kind' <<<"$metadata")"
metadata_platform="$(jq -er '.platform' <<<"$metadata")"
platform_identity="${metadata_platform//\//-}"
lock="${profile%.toml}.${platform_identity}.lock.toml"
[[ -f "$lock" ]] || fail "missing required file: $lock"
image_name="$(jq -er '.image' <<<"$metadata")"
profile_shell="$(awk '
  /^\[image\]$/ { in_image = 1; next }
  in_image && /^\[/ { exit }
  in_image && /^shell = "/ {
    value = substr($0, 10)
    sub(/"$/, "", value)
    print value
    exit
  }
' "$profile")"
[[ "$profile_shell" == bash || "$profile_shell" == fish ]] \
  || fail "profile image shell is unsupported: $profile_shell"

[[ "$image_name" == "trellage-profile-${profile_name}-${platform_identity}:locked" ]] \
  || fail "profile metadata uses a non-Trellage platform image tag: $image_name"

jq -e \
  --arg name "$profile_name" \
  --arg image "$image_name" \
  --arg platform "$metadata_platform" '
    .profile_name == $name
    and .locked == true
    and .image == $image
    and .platform == $platform
    and (.profile_hash | test("^sha256:[0-9a-f]{64}$"))
  ' <<<"$metadata" >/dev/null || fail 'profile metadata is invalid, stale, or missing its final OCI digest'

grep -Eq '^final_digest = "sha256:[0-9a-f]{64}"$' "$lock" \
  || fail 'final OCI digest is not locked'
! grep -Eiq '(token|secret|password|api[_-]?key)[[:space:]]*=[[:space:]]*"[^"[:space:]]+"' "$profile" "$lock" \
  || fail 'credential-like value is embedded in profile inputs'
! grep -Eq '(/[U]sers/|/var/[f]olders/|/private/tmp/|/tmp/harness-|harness-build-)' "$profile" "$lock" \
  || fail 'host, temporary, or build path is embedded in profile inputs'

profile_has_caveman() {
  awk '
    function complete() {
      return repository == "https://github.com/JuliusBrussee/caveman.git" \
        && ref == "v1.10.0" && select == "select = [\"caveman\"]" \
        && always_on == "always_on = true"
    }
    /^\[\[skills\]\]$/ {
      if (in_skill && complete()) found = 1
      in_skill = 1
      repository = ref = select = always_on = ""
      next
    }
    /^\[\[/ {
      if (in_skill && complete()) found = 1
      in_skill = 0
      next
    }
    in_skill && /^repository = / { repository = substr($0, 14); gsub(/"/, "", repository) }
    in_skill && /^ref = / { ref = substr($0, 7); gsub(/"/, "", ref) }
    in_skill && /^select = / { select = $0 }
    in_skill && /^always_on = / { always_on = $0 }
    END {
      if (in_skill && complete()) found = 1
      exit(found ? 0 : 1)
    }
  ' "$profile"
}

lock_has_caveman() {
  awk '
    function complete() {
      return repository == "https://github.com/JuliusBrussee/caveman.git" \
        && ref == "v1.10.0" && select == "select = [\"caveman\"]" \
        && commit ~ /^[0-9a-f]{40}$/
    }
    /^\[\[sources\]\]$/ {
      if (in_source && complete()) found = 1
      in_source = 1
      repository = ref = select = commit = ""
      next
    }
    /^\[\[/ {
      if (in_source && complete()) found = 1
      in_source = 0
      next
    }
    in_source && /^repository = / { repository = substr($0, 14); gsub(/"/, "", repository) }
    in_source && /^ref = / { ref = substr($0, 7); gsub(/"/, "", ref) }
    in_source && /^select = / { select = $0 }
    in_source && /^commit = / { commit = substr($0, 10); gsub(/"/, "", commit) }
    END {
      if (in_source && complete()) found = 1
      exit(found ? 0 : 1)
    }
  ' "$lock"
}

profile_has_caveman || fail 'profile does not declare always-on Caveman v1.10.0'
lock_has_caveman || fail 'lock does not contain an exact Caveman v1.10.0 source commit'
grep -Fqx 'path = "skills/caveman/SKILL.md"' "$lock" \
  || fail 'Caveman SKILL.md is absent from the locked source inventory'

runtime_package_locked() {
  local name="$1" version="$2" integrity="$3"
  awk -v name="$name" -v version="$version" -v integrity="$integrity" '
    /^\[\[packages\.runtime\]\]/ { if (package_name == name && package_version == version && package_integrity == integrity) found = 1; in_runtime = 1; package_name = package_version = package_integrity = ""; next }
    in_runtime && /^\[/ {
      if (package_name == name && package_version == version && package_integrity == integrity) found = 1
      in_runtime = 0
    }
    in_runtime && $0 == "name = \"" name "\"" { package_name = name }
    in_runtime && $0 == "version = \"" version "\"" { package_version = version }
    in_runtime && $0 == "integrity = \"" integrity "\"" { package_integrity = integrity }
    END { if (package_name == name && package_version == version && package_integrity == integrity) found = 1; exit(found ? 0 : 1) }
  ' "$lock"
}

runtime_package_locked gh 2.23.0+dfsg1-1 sha256:7aeed4b288718660cda8e18ea1b06b69da42f3072ec599343965b01cf01b4a12 \
  || fail 'GitHub CLI runtime package is not locked'

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
    [[ "$(locked_value '[packages.harness]' selector)" == latest ]] \
      || fail 'Codex lock selector is not upgradeable'
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
    [[ "$profile_name" == claude-* ]] || fail 'Claude profile name is not exact'
    [[ "$(jq -r '.harness_executable' <<<"$metadata")" == claude ]] \
      || fail 'Claude executable metadata is not exact'
    [[ "$(jq -r '.runtime_entry' <<<"$metadata")" == trellage-claude-entry ]] \
      || fail 'Claude runtime entry metadata is not exact'
    [[ "$(jq -r '.auth_policy' <<<"$metadata")" == claude-explicit ]] \
      || fail 'Claude auth policy metadata is not exact'
    [[ "$(locked_value '[packages.harness]' kind)" == claude ]] \
      || fail 'Claude lock kind is not exact'
    [[ "$(locked_value '[packages.harness]' selector)" == latest ]] \
      || fail 'Claude lock selector is not upgradeable'
    [[ "$(locked_value '[packages.harness]' version)" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || fail 'Claude version is not exact stable semver'
    if [[ "$profile_name" == claude-research ]]; then
      grep -Fqx 'adapter = "hyperresearch"' "$lock" || fail 'Hyperresearch adapter is not locked'
      grep -Fqx 'select = ["light"]' "$lock" || fail 'Hyperresearch light gear is not locked'
      grep -Eq '^commit = "[0-9a-f]{40}"$' "$lock" || fail 'Hyperresearch commit is not exact'
    fi
    ;;
  pi)
    runtime_entry="$prototype_dir/runtime-pi-entry.sh"
    [[ -f "$runtime_entry" ]] || fail "missing required file: $runtime_entry"
    [[ "$profile_name" == pi-oh-my-pi ]] || fail 'Pi profile name is not exact'
    [[ "$(jq -r '.harness_executable' <<<"$metadata")" == omp ]] \
      || fail 'Pi executable metadata is not exact'
    [[ "$(jq -r '.runtime_entry' <<<"$metadata")" == trellage-pi-entry ]] \
      || fail 'Pi runtime entry metadata is not exact'
    [[ "$(jq -r '.default_network' <<<"$metadata")" == bridge ]] \
      || fail 'Pi network metadata is not exact'
    [[ "$(jq -r '.auth_policy' <<<"$metadata")" == host-or-login ]] \
      || fail 'Pi auth policy metadata is not exact'
    [[ "$(locked_value '[packages.harness]' kind)" == pi ]] \
      || fail 'Pi lock kind is not exact'
    [[ "$(locked_value '[packages.harness]' selector)" == latest ]] \
      || fail 'Pi lock selector is not upgradeable'
    grep -Eq '^url = "https://github.com/can1357/oh-my-pi/releases/download/v[0-9]+\.[0-9]+\.[0-9]+/omp-linux-arm64"$' "$lock" \
      || fail 'Pi release asset identity is not exact'
    ;;
  prime)
    runtime_entry="$prototype_dir/runtime-prime-entry.sh"
    [[ -f "$runtime_entry" ]] || fail "missing required file: $runtime_entry"
    [[ "$profile_name" == prime-agent ]] || fail 'Prime profile name is not exact'
    [[ "$(jq -r '.harness_executable' <<<"$metadata")" == prime-agent ]] \
      || fail 'Prime executable metadata is not exact'
    [[ "$(jq -r '.runtime_entry' <<<"$metadata")" == trellage-prime-entry ]] \
      || fail 'Prime runtime entry metadata is not exact'
    [[ "$(jq -r '.default_network' <<<"$metadata")" == copilot-proxy-rs_default ]] \
      || fail 'Prime network metadata is not exact'
    [[ "$(jq -r '.auth_policy' <<<"$metadata")" == proxy ]] \
      || fail 'Prime auth policy metadata is not exact'
    [[ "$(jq -r '.prime_provider' <<<"$metadata")" == copilot-proxy-rs ]] \
      || fail 'Prime provider metadata is not exact'
    [[ "$(jq -r '.prime_model' <<<"$metadata")" == claude-opus-5 ]] \
      || fail 'Prime model metadata is not exact'
    [[ "$(jq -r '.prime_base_url' <<<"$metadata")" == http://copilot-proxy-rs:8080 ]] \
      || fail 'Prime base URL metadata is not exact'
    [[ "$(locked_value '[packages.harness]' kind)" == prime ]] || fail 'Prime lock kind is not exact'
    [[ "$(locked_value '[packages.harness]' selector)" == latest ]] || fail 'Prime lock selector is not upgradeable'
    grep -Eq '^url = "https://pub-728493de92a943e2a9b2d17b4719f318\.r2\.dev/releases/v[0-9]+\.[0-9]+\.[0-9]+/prime-agent-[0-9]+\.[0-9]+\.[0-9]+\.tgz"$' "$lock" \
      || fail 'Prime release asset identity is not exact'
    ;;
  *) fail "unsupported harness kind: $harness_kind" ;;
esac

if [[ "${STATIC_ONLY:-0}" == 1 ]]; then
  printf 'Trellage image contract: PASS (static: %s)\n' "$profile_name"
  exit 0
fi

IMAGE_REF="${IMAGE_REF:-$image_name}"
[[ "$IMAGE_REF" == "$image_name" ]] \
  || fail "live image reference does not match profile metadata: $IMAGE_REF"
[[ "$IMAGE_REF" == trellage-profile-*:locked ]] \
  || fail "live image reference is not a locked Trellage profile tag: $IMAGE_REF"
image_config="$(docker image inspect "$IMAGE_REF")"
locked_version="$(locked_value '[packages.harness]' version)"
[[ "$locked_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] \
  || fail 'harness version is not exact in the lock'

jq -e \
  --arg hash "$profile_hash" \
  --arg name "$profile_name" \
  --arg kind "$harness_kind" \
  --arg shell "$profile_shell" \
  --arg version "$locked_version" '
    .[0].Config.User == "10001:10001"
    and .[0].Config.Cmd == [$shell, "-l"]
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
    elif $kind == "pi" then
      .[0].Config.Labels["dev.trellage.harness.kind"] == $kind
      and .[0].Config.Labels["dev.trellage.pi.implementation"] == "oh-my-pi"
      and .[0].Config.Labels["dev.trellage.pi.version"] == $version
      and (.[0].Config.Env | any(. == "PI_CODING_AGENT_DIR=/home/agent/.omp/agent"))
      and (.[0].Config.Env | any(. == "OMP_SKIP_SETUP=1"))
      and (.[0].Config.Env | any(. == "XDG_CACHE_HOME=/home/agent/.cache"))
      and (.[0].Config.Env | all(startswith("COPILOT_HOME=") | not))
      and (.[0].Config.Env | all(startswith("CODEX_HOME=") | not))
    elif $kind == "claude" then
      .[0].Config.Labels["dev.trellage.harness.kind"] == $kind
      and .[0].Config.Labels["dev.trellage.claude.version"] == $version
      and (.[0].Config.Env | any(. == "CLAUDE_CONFIG_DIR=/home/agent/.claude"))
      and (.[0].Config.Env | any(. == "XDG_CACHE_HOME=/home/agent/.cache"))
      and (.[0].Config.Env | all(startswith("COPILOT_HOME=") | not))
      and (.[0].Config.Env | all(startswith("CODEX_HOME=") | not))
    elif $kind == "prime" then
      .[0].Config.Labels["dev.trellage.harness.kind"] == $kind
      and .[0].Config.Labels["dev.trellage.prime.version"] == $version
      and (.[0].Config.Env | any(. == "PRIME_AGENT_CODING_AGENT_DIR=/home/agent/.prime/agent"))
      and (.[0].Config.Env | any(. == "PI_OFFLINE=1"))
      and (.[0].Config.Env | any(. == "PI_SKIP_VERSION_CHECK=1"))
      and (.[0].Config.Env | any(. == "PRIME_AGENT_INSTALL_UV=0"))
      and (.[0].Config.Env | any(. == "PRIME_AGENT_KERNEL_PYTHON=/home/agent/.trellage/prime-kernel/.prime/agent/kernel-venv/bin/python"))
      and (.[0].Config.Env | any(. == "XDG_CACHE_HOME=/home/agent/.cache"))
      and (.[0].Config.Env | all(test("^(CODEX_HOME|COPILOT_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR)=") | not))
      and .[0].Config.Volumes == null
    else
      .[0].Config.Labels["dev.trellage.codex.version"] == $version
      and (.[0].Config.Env | any(. == "CODEX_HOME=/home/agent/.codex"))
    end)
  ' <<<"$image_config" >/dev/null \
  || fail 'image config violates exact labels, user, shell, home, version, or secret contract'

inspect_and_history="$(printf '%s\n' "$image_config"; docker history --no-trunc --format '{{.CreatedBy}} {{.Comment}}' "$IMAGE_REF")"
! grep -Eiq '(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|Authorization:|Bearer[[:space:]]+[[:graph:]]+|/[U]sers/|/var/[f]olders/|/private/tmp/|harness-build-|harness-profile-|dev\.sandbox-harness|/usr/local/share/harness|/usr/local/bin/harness-(codex|copilot|claude|pi|prime)-entry|(^|[/[:space:]])harness-(codex|copilot|claude|pi|prime)-entry([[:space:]]|$))' <<<"$inspect_and_history" \
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
      test -f "$seed/skills/caveman/SKILL.md" && test ! -L "$seed/skills/caveman/SKILL.md"
      test -f "$seed/copilot-instructions.md" && test ! -L "$seed/copilot-instructions.md"
      grep -Fq "ACTIVE EVERY RESPONSE" "$seed/copilot-instructions.md"
      ! find "$seed" -type f -exec grep -alE '\''/[U]sers/[^/]+/projects/prototypes/sandbox-harness|/src/hve-core|/src/copilot-seed|/var/[f]olders/|/private/tmp/|/tmp/harness-|harness-build-'\'' {} + | grep -q .
      ! find "$seed" -type f -exec grep -alF "$auth_canary" {} + | grep -q .
      trellage-copilot-entry new --version >/tmp/copilot-version
      test "$(sed -n '\''1s/^GitHub Copilot CLI \([0-9.]*\)\.$/\1/p'\'' /tmp/copilot-version)" = "$locked_version"
      test -f "$COPILOT_HOME/managed-lock.json"
      test -f "$COPILOT_HOME/skills/caveman/SKILL.md" && test ! -L "$COPILOT_HOME/skills/caveman/SKILL.md"
      test -f "$COPILOT_HOME/copilot-instructions.md" && test ! -L "$COPILOT_HOME/copilot-instructions.md"
      test "$(stat -c "%u:%g" "$COPILOT_HOME/skills/caveman/SKILL.md")" = 10001:10001
      test "$(stat -c "%u:%g" "$COPILOT_HOME/copilot-instructions.md")" = 10001:10001
      grep -Fq "ACTIVE EVERY RESPONSE" "$COPILOT_HOME/copilot-instructions.md"
      test ! -e "$COPILOT_HOME/config.toml"
      ! find "$COPILOT_HOME" "$XDG_CACHE_HOME" -type f -exec grep -alE '\''/[U]sers/[^/]+/projects/prototypes/sandbox-harness|/src/hve-core|/src/copilot-seed|/var/[f]olders/|/private/tmp/|/tmp/harness-|harness-build-'\'' {} + | grep -q .
      ! find "$COPILOT_HOME" "$XDG_CACHE_HOME" -type f -exec grep -alF "$auth_canary" {} + | grep -q .
    ' -- "$locked_version" "$hve_version" \
    || fail 'Copilot executable, entry, seed, HVE, path, auth, or Codex-isolation probe failed'
elif [[ "$harness_kind" == prime ]]; then
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
    --tmpfs /home/agent:rw,exec,nosuid,nodev,size=1g,uid=10001,gid=10001 \
    --entrypoint bash \
    "$IMAGE_REF" -ceu '
      locked_version="$1"
      test "$(id -u):$(id -g)" = 10001:10001
      command -v fish bash zsh git curl jq gh rg prime-agent >/dev/null
      test "$(command -v prime-agent)" = /usr/local/bin/prime-agent
      test -x /usr/local/bin/trellage-prime-entry
      test "$PRIME_AGENT_CODING_AGENT_DIR" = /home/agent/.prime/agent
      test "$PI_OFFLINE" = 1
      test "$PI_SKIP_VERSION_CHECK" = 1
      test "$PRIME_AGENT_INSTALL_UV" = 0
      test "$PRIME_AGENT_KERNEL_PYTHON" = /home/agent/.trellage/prime-kernel/.prime/agent/kernel-venv/bin/python
      test -f /usr/local/share/trellage/prime-kernel-seed.tar.gz
      test ! -L /usr/local/share/trellage/prime-kernel-seed.tar.gz
      mkdir -p /home/agent/.trellage/prime-kernel
      tar -xzf /usr/local/share/trellage/prime-kernel-seed.tar.gz -C /home/agent/.trellage/prime-kernel
      test -x "$PRIME_AGENT_KERNEL_PYTHON"
      "$PRIME_AGENT_KERNEL_PYTHON" -c '\''import bs4, dotenv, httpx, ipykernel, lxml, numpy, pandas, pydantic, requests, rlm, scipy, tomli, tyro, yaml'\''
      jq -e --arg version "$locked_version" '\''
        .name == "prime-agent"
        and .version == $version
        and .bin["prime-agent"] == "dist/bundle/cli.js"
      '\'' /usr/local/lib/node_modules/prime-agent/package.json >/dev/null
      jq -e '\''
        . == {
          providers: {
            "copilot-proxy-rs": {
              baseUrl: "http://copilot-proxy-rs:8080",
              api: "anthropic-messages",
              apiKey: "trellage-local-proxy",
              compat: {supportsEagerToolInputStreaming: false},
              models: [{id: "claude-opus-5"}]
            }
          }
        }
      '\'' /usr/local/share/trellage/prime-seed/models.json >/dev/null
      test -f /usr/local/share/trellage/prime-seed/skills/caveman/SKILL.md
      test ! -L /usr/local/share/trellage/prime-seed/skills/caveman/SKILL.md
      grep -Fqx caveman /usr/local/share/trellage/prime-seed/managed-skills.txt
      test -f /usr/local/share/trellage/prime-seed/APPEND_SYSTEM.md
      test ! -L /usr/local/share/trellage/prime-seed/APPEND_SYSTEM.md
      grep -Fq "ACTIVE EVERY RESPONSE" /usr/local/share/trellage/prime-seed/APPEND_SYSTEM.md
      prime-agent --version >/tmp/prime-version 2>&1
      grep -Fq "$locked_version" /tmp/prime-version
      trellage-prime-entry new --version >/tmp/trellage-prime-version 2>&1
      grep -Fq "$locked_version" /tmp/trellage-prime-version
      test ! -e /home/agent/.prime
      test ! -e /home/agent/.codex
      test ! -e /home/agent/.copilot
      test ! -e /home/agent/.claude
      test ! -e /home/agent/.omp
      test ! -e /home/agent/.config/gh
      test ! -e /usr/local/share/harness
      test ! -e /usr/local/bin/harness-prime-entry
    ' -- "$locked_version" || fail 'Prime executable, entry, seed, version, gh, or state-isolation probe failed'
elif [[ "$harness_kind" == pi ]]; then
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
    --tmpfs /home/agent:rw,exec,nosuid,nodev,size=256m,uid=10001,gid=10001 \
    --env 'COPILOT_GITHUB_TOKEN=trellage-image-contract-auth-canary' \
    --entrypoint bash \
    "$IMAGE_REF" -ceu '
      locked_version="$1"
      auth_canary="${COPILOT_GITHUB_TOKEN:?}"
      test "$(id -u):$(id -g)" = 10001:10001
      test "$PI_CODING_AGENT_DIR" = /home/agent/.omp/agent
      test "$OMP_SKIP_SETUP" = 1
      test "$(command -v omp)" = "/mise/installs/http-pi/$locked_version/omp"
      test -x /usr/local/bin/trellage-pi-entry
      test -f /usr/local/share/trellage/pi-config.yml
      test -f /usr/local/share/trellage/pi-seed/managed-skills.txt
      grep -Fqx "  checkUpdate: false" /usr/local/share/trellage/pi-config.yml
      grep -Fqx "  autoUpdate: off" /usr/local/share/trellage/pi-config.yml
      test "$(cat /usr/local/share/trellage/pi-seed/managed-skills.txt)" = "$(printf "%s\n" caveman semantic-compression system-prompts tool-prompt-optimization)"
      for skill in caveman semantic-compression system-prompts tool-prompt-optimization; do
        test -f "/usr/local/share/trellage/pi-seed/skills/$skill/SKILL.md"
      done
      test -f /usr/local/share/trellage/pi-seed/APPEND_SYSTEM.md
      test ! -L /usr/local/share/trellage/pi-seed/APPEND_SYSTEM.md
      grep -Fq "ACTIVE EVERY RESPONSE" /usr/local/share/trellage/pi-seed/APPEND_SYSTEM.md
      test "$(omp --version)" = "omp/$locked_version"
      omp --config /usr/local/share/trellage/pi-config.yml --help >/dev/null
      omp --config /usr/local/share/trellage/pi-config.yml models github-copilot --json \
        | jq -e '\''.. | strings | select(. == "gpt-5.6-terra")'\'' >/dev/null
      test ! -e /usr/local/share/harness
      test ! -e /usr/local/bin/harness-pi-entry
      test ! -e /home/agent/.copilot
      test ! -e /home/agent/.config/gh
      trellage-pi-entry new --version >/tmp/pi-version
      test "$(cat /tmp/pi-version)" = "omp/$locked_version"
      test -d "$PI_CODING_AGENT_DIR"
      test "$(cat "$PI_CODING_AGENT_DIR/.trellage-managed-skills")" = "$(printf "%s\n" caveman semantic-compression system-prompts tool-prompt-optimization)"
      for skill in caveman semantic-compression system-prompts tool-prompt-optimization; do
        test -f "$PI_CODING_AGENT_DIR/skills/$skill/SKILL.md"
      done
      test -f "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
      test ! -L "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
      test "$(stat -c "%u:%g" "$PI_CODING_AGENT_DIR/skills/caveman/SKILL.md")" = 10001:10001
      test "$(stat -c "%u:%g" "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md")" = 10001:10001
      grep -Fq "ACTIVE EVERY RESPONSE" "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"
      ! find /home/agent -type f -exec grep -alF "$auth_canary" {} + | grep -q .
    ' -- "$locked_version" || fail 'Pi executable, entry, state, update, auth, or isolation probe failed'
elif [[ "$harness_kind" == claude ]]; then
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
    --tmpfs /home/agent:rw,exec,nosuid,nodev,size=256m,uid=10001,gid=10001 \
    --entrypoint bash \
    "$IMAGE_REF" -ceu '
      locked_version="$1"
      test "$(id -u):$(id -g)" = 10001:10001
      test "$(claude --version | sed -n "s/^\([0-9.]*\) (Claude Code)$/\1/p")" = "$locked_version"
      test -x /usr/local/bin/trellage-claude-entry
      seed=/usr/local/share/trellage/claude-seed
      test -d "$seed" && test ! -L "$seed"
      test -f "$seed/skills/caveman/SKILL.md" && test ! -L "$seed/skills/caveman/SKILL.md"
      test -f "$seed/CLAUDE.md" && test ! -L "$seed/CLAUDE.md"
      grep -Fq "ACTIVE EVERY RESPONSE" "$seed/CLAUDE.md"
      trellage-claude-entry passthrough claude --version >/tmp/claude-version
      test "$(sed -n "s/^\([0-9.]*\) (Claude Code)$/\1/p" /tmp/claude-version)" = "$locked_version"
      test -f "$CLAUDE_CONFIG_DIR/skills/caveman/SKILL.md" && test ! -L "$CLAUDE_CONFIG_DIR/skills/caveman/SKILL.md"
      test -f "$CLAUDE_CONFIG_DIR/CLAUDE.md" && test ! -L "$CLAUDE_CONFIG_DIR/CLAUDE.md"
      test "$(stat -c "%u:%g" "$CLAUDE_CONFIG_DIR/skills/caveman/SKILL.md")" = 10001:10001
      test "$(stat -c "%u:%g" "$CLAUDE_CONFIG_DIR/CLAUDE.md")" = 10001:10001
      grep -Fq "ACTIVE EVERY RESPONSE" "$CLAUDE_CONFIG_DIR/CLAUDE.md"
    ' -- "$locked_version" || fail 'Claude executable, entry, seed, managed state, or isolation probe failed'
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
      test -f "$CODEX_HOME/skills/caveman/SKILL.md"
      test ! -L "$CODEX_HOME/skills/caveman/SKILL.md"
      test -f "$CODEX_HOME/AGENTS.md"
      test ! -L "$CODEX_HOME/AGENTS.md"
      test "$(stat -c "%u:%g" "$CODEX_HOME/skills/caveman/SKILL.md")" = 10001:10001
      test "$(stat -c "%u:%g" "$CODEX_HOME/AGENTS.md")" = 10001:10001
      grep -Fq '\''ACTIVE EVERY RESPONSE'\'' "$CODEX_HOME/AGENTS.md"
      test -f "$CODEX_HOME/agents/full-stack-orchestration__security-auditor.toml"
      expected_skills="$(printf "%s\n" \
        brainstorming \
        caveman \
        dispatching-parallel-agents \
        executing-plans \
        finishing-a-development-branch \
        full-stack-orchestration__full-stack-feature \
        receiving-code-review \
        requesting-code-review \
        subagent-driven-development \
        systematic-debugging \
        test-driven-development \
        using-git-worktrees \
        using-superpowers \
        verification-before-completion \
        writing-plans \
        writing-skills)"
      actual_skills="$(find "$CODEX_HOME/skills" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | LC_ALL=C sort)"
      test "$actual_skills" = "$expected_skills"
      test "$(find "$CODEX_HOME/agents" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d " ")" = 4
      test -z "$(find "$CODEX_HOME/skills" "$CODEX_HOME/agents" -type l -print -quit)"
      ! touch /read-only-root-proof 2>/dev/null
      test -w /tmp
    ' -- "$locked_version" || fail 'read-only-root Codex runtime smoke failed'
fi

printf 'Trellage image contract: PASS (static + live: %s)\n' "$profile_name"
