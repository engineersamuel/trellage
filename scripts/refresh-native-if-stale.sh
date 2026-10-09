#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'refresh-native-if-stale: %s\n' "$1" >&2
  exit 1
}

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
prepare="$repo_root/scripts/build-profile-compiler.sh"
refresh="$repo_root/scripts/rebuild-profile-images.sh"
current_receipt="$repo_root/.trellage-source-ready.json"
runtime_parent="$HOME/.local/share/trellage"
freshness_receipt="$runtime_parent/.native-stack-sources"

[[ -x "$prepare" ]] || fail "source preparation script is missing or not executable: $prepare"
[[ -x "$refresh" ]] || fail "native refresh script is missing or not executable: $refresh"

"$prepare"

read_sources() {
  local receipt="$1"
  [[ -f "$receipt" && ! -L "$receipt" ]] || return 1
  jq -er '
    if .schema == 1 and (.sources | type == "string" and length > 0)
    then .sources
    else error("invalid source readiness receipt")
    end
  ' "$receipt" 2>/dev/null
}

current_sources="$(read_sources "$current_receipt")" \
  || fail "source preparation did not publish a valid readiness receipt: $current_receipt"
installed_sources=''
if [[ -f "$freshness_receipt" && ! -L "$freshness_receipt" ]]; then
  installed_sources="$(<"$freshness_receipt")"
fi

if [[ -n "$installed_sources" && "$installed_sources" == "$current_sources" ]]; then
  printf 'refresh-native-if-stale: installed Native runtime is current\n' >&2
  exit 0
fi

printf 'refresh-native-if-stale: installed Native runtime is stale; refreshing from %s\n' "$repo_root" >&2
"$refresh" --native-only

[[ -d "$runtime_parent" && ! -L "$runtime_parent" ]] \
  || fail "native refresh did not publish a safe runtime parent: $runtime_parent"
if [[ -e "$freshness_receipt" || -L "$freshness_receipt" ]]; then
  [[ -f "$freshness_receipt" && ! -L "$freshness_receipt" ]] \
    || fail "unsafe Native freshness receipt: $freshness_receipt"
fi
temporary_receipt="$(mktemp "$runtime_parent/.native-stack-sources.XXXXXX")" \
  || fail "cannot stage Native freshness receipt in: $runtime_parent"
trap 'rm -f -- "$temporary_receipt"' EXIT HUP INT TERM
chmod 0644 "$temporary_receipt"
printf '%s\n' "$current_sources" >"$temporary_receipt"
mv -f -- "$temporary_receipt" "$freshness_receipt"
trap - EXIT HUP INT TERM
printf 'refresh-native-if-stale: Native runtime refresh complete\n' >&2
