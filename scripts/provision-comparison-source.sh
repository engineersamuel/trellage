#!/usr/bin/env bash
# Build-time only: verify Linux Bun, then stage the complete frozen source workspace.
set -euo pipefail
umask 022

fail() {
  printf 'comparison source: %s\n' "$1" >&2
  exit 1
}

[[ "$#" == 4 || "$#" == 5 ]] \
  || fail 'usage: provision-comparison-source.sh SOURCE DESTINATION linux/arm64|linux/amd64 HTTPS_REGISTRY [BUN_ARCHIVE]'
source_root="$1"
destination="$2"
platform="$3"
registry="$4"
supplied_archive="${5-}"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

case "$platform" in
  linux/arm64) architecture=aarch64 ;;
  linux/amd64) architecture=x86_64 ;;
  *) fail "unsupported Bun platform: $platform" ;;
esac
[[ "$(uname -s)" == Linux && "$(uname -m)" == "$architecture" ]] \
  || fail "Bun provisioning must run on the selected Linux platform: $platform"
[[ "$registry" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] \
  || fail 'npm registry must be an HTTPS URL without credentials, query, or fragment'
[[ "$source_root" == /* && -d "$source_root" && ! -L "$source_root" ]] \
  || fail 'source workspace must be an absolute, non-symlink directory'
[[ "$destination" == /* && ! -e "$destination" && ! -L "$destination" ]] \
  || fail 'destination must be an unoccupied absolute path'

for tool in bash curl jq sha256sum tar install; do
  command -v "$tool" >/dev/null || fail "missing build dependency: $tool"
done
pins="$source_root/prototypes/trellage/bun-runtime.json"
config="$source_root/packages/trellage-runtime/bunfig.toml"
installer="$source_root/scripts/install-source-runtime.sh"
for asset in "$pins" "$config" "$installer"; do
  [[ -f "$asset" && ! -L "$asset" ]] || fail "missing or unsafe source asset: $asset"
done

descriptor="$(jq -er --arg platform "$platform" '
  select(.version == "1.3.3")
  | .platforms[$platform]
  | select(
      (.package | type) == "string"
      and (.sha256 | type) == "string"
      and (.size | type) == "number"
    )
  | [.package, .sha256, (.size | tostring)] | @tsv
' "$pins")" || fail "invalid Bun 1.3.3 pin for $platform"
IFS=$'\t' read -r package digest size <<<"$descriptor"
[[ "$package" =~ ^@oven/bun-linux-(aarch64|x64-baseline)$ \
  && "$digest" =~ ^[0-9a-f]{64}$ && "$size" =~ ^[1-9][0-9]*$ ]] \
  || fail "invalid Bun archive metadata for $platform"

mkdir -m 0755 "$destination"
temporary="$(mktemp -d "$destination/.bun.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
archive="$temporary/bun.tgz"
if [[ -n "$supplied_archive" ]]; then
  [[ -f "$supplied_archive" && ! -L "$supplied_archive" ]] \
    || fail 'Bun archive must be a regular, non-symlink file'
  cp -- "$supplied_archive" "$archive"
else
  curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' \
    "${registry%/}/${package}/-/${package##*/}-1.3.3.tgz" --output "$archive"
fi
[[ "$(wc -c <"$archive" | tr -d '[:space:]')" == "$size" ]] || fail 'Bun archive size mismatch'
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status \
  || fail 'Bun archive SHA-256 mismatch'
tar -xzf "$archive" -C "$temporary" package/bin/bun
extracted="$temporary/package/bin/bun"
[[ -f "$extracted" && ! -L "$extracted" && -x "$extracted" ]] \
  || fail 'Bun archive does not contain a regular executable'
install -m 0555 "$extracted" "$destination/bun"

export TRELLAGE_BUN_EXECUTABLE="$destination/bun"
version="$("$TRELLAGE_BUN_EXECUTABLE" --no-install --no-env-file "--config=$config" --version)" \
  || fail 'Bun version command failed'
[[ "$version" == 1.3.3 ]] || fail "expected Bun 1.3.3, found $version"
export npm_config_registry="$registry" NPM_CONFIG_REGISTRY="$registry"
export BUN_INSTALL_CACHE_DIR="$temporary/cache"
bash "$installer" --stage "$destination/source"
cmp -- "$source_root/bun.lock" "$destination/source/bun.lock" \
  || fail 'source installation changed the canonical frozen lock'
printf 'comparison source: ready (Bun %s, %s)\n' "$version" "$platform"
