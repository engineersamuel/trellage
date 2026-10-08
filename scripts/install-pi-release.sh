#!/usr/bin/env bash
# Install the latest Pi release from GitHub, bypassing npm package feeds that lag.
# Usage: scripts/install-pi-release.sh [TAG]   (default: latest release)
# Installs to ${PI_RELEASE_HOME:-~/.local/share/pi-release}/<version> and links
# ${PI_RELEASE_BIN:-~/.local/bin}/pi to the new version. Needs gh, tar and shasum.
set -euo pipefail

repo=earendil-works/pi
root="${PI_RELEASE_HOME:-$HOME/.local/share/pi-release}"
bin_dir="${PI_RELEASE_BIN:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) echo "install-pi-release: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

tag="${1:-$(gh release view -R "$repo" --json tagName --jq .tagName)}"
version="${tag#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || { echo "install-pi-release: invalid tag $tag" >&2; exit 1; }

target="$root/$version"
if [[ -x "$target/pi/pi" ]]; then
  echo "Pi $version already installed"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  asset="pi-$platform.tar.gz"
  gh release download "$tag" -R "$repo" -p "$asset" -p SHA256SUMS -D "$work"
  expected="$(awk -v a="$asset" '$2 == a { print $1 }' "$work/SHA256SUMS")"
  actual="$(shasum -a 256 "$work/$asset" | awk '{ print $1 }')"
  [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "install-pi-release: checksum mismatch for $asset" >&2; exit 1; }
  mkdir -p "$work/extract" "$root"
  tar xzf "$work/$asset" -C "$work/extract"
  rm -rf "$target"
  mv "$work/extract" "$target"
fi

mkdir -p "$bin_dir"
ln -sfn "$target/pi/pi" "$bin_dir/pi"
echo "Linked $bin_dir/pi -> $target/pi/pi"
"$bin_dir/pi" --version
