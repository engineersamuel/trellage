#!/usr/bin/env bash
# Keep identity-sensitive state on Linux storage and use the image's source layout.
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly prototype_dir
readonly fixture_image='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
work="$(mktemp -d "${TMPDIR:-/tmp}/trellage-claude-linux.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

fail() {
  printf 'Claude entry fixture: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail 'Docker is required'
command -v jq >/dev/null 2>&1 || fail 'jq is required'
platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
pin="$prototype_dir/bun-runtime.json"
version="$(jq -er '.version' "$pin")"
package="$(jq -er --arg platform "$platform" '.platforms[$platform].package // empty' "$pin")" \
  || fail "unsupported Docker platform: $platform"
expected_size="$(jq -er --arg platform "$platform" '.platforms[$platform].size' "$pin")"
expected_sha="$(jq -er --arg platform "$platform" '.platforms[$platform].sha256' "$pin")"
archive="${TRELLAGE_TEST_BUN_ARCHIVE-}"
if [[ -z "$archive" ]]; then
  command -v npm >/dev/null 2>&1 || fail 'npm is required to fetch the pinned fixture binary'
  npm pack --ignore-scripts --quiet --pack-destination "$work" "$package@$version" >/dev/null
  package_filename="${package#@}"
  archive="$work/${package_filename//\//-}-$version.tgz"
fi
[[ -f "$archive" && ! -L "$archive" ]] || fail 'the Bun archive is missing or unsafe'
[[ "$(wc -c <"$archive" | tr -d '[:space:]')" == "$expected_size" ]] || fail 'Bun archive size mismatch'
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
else
  actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
[[ "$actual_sha" == "$expected_sha" ]] || fail 'Bun archive SHA-256 mismatch'
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$work" package/bin/bun
[[ -f "$work/package/bin/bun" && ! -L "$work/package/bin/bun" ]] || fail 'unsafe extracted Bun binary'
chmod 0755 "$work/package/bin/bun"
cp "$prototype_dir/tests/fixtures/claude-managed-bun.sh" "$work/bun"
chmod 0755 "$work/bun"
entry="${TRELLAGE_CLAUDE_ENTRY_UNDER_TEST:-$prototype_dir/runtime-claude-entry.sh}"
[[ -f "$entry" && ! -L "$entry" ]] || fail 'the entrypoint must be a regular source file'
if ! docker image inspect "$fixture_image" >/dev/null 2>&1; then
  docker image pull "$fixture_image" >/dev/null
fi

docker run --rm --network none --read-only --user 10001:10001 \
  --entrypoint /bin/bash --workdir /tmp \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m \
  --tmpfs /home/agent:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=32m \
  --env HOME=/home/agent \
  --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  --env TRELLAGE_CLAUDE_FIXTURE_ACTIVE=1 \
  --env TRELLAGE_CLAUDE_ENTRY_UNDER_TEST=/usr/local/bin/trellage-claude-entry \
  --mount "type=bind,src=$entry,dst=/usr/local/bin/trellage-claude-entry,readonly" \
  --mount "type=bind,src=$work/bun,dst=/usr/local/lib/trellage/bun,readonly" \
  --mount "type=bind,src=$work/package/bin/bun,dst=/usr/local/lib/trellage/bun-real,readonly" \
  --mount "type=bind,src=$prototype_dir/claude-managed-files.ts,dst=/usr/local/lib/trellage/claude-managed-files.ts,readonly" \
  --mount "type=bind,src=$pin,dst=/usr/local/lib/trellage/bun-runtime.json,readonly" \
  --mount "type=bind,src=$prototype_dir/tests,dst=/fixture/tests,readonly" \
  "$fixture_image" /fixture/tests/claude_entry_contract.sh
