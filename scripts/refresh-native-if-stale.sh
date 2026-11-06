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

# One native refresh at a time across all worktrees: two at once overwrite the
# shared runtime under each other and both fail. A waiter rechecks freshness
# after it gets the lock, so it skips work the other refresh already did.
refresh_lock="$runtime_parent/.native-refresh.lock"
lock_wait_seconds=900
mkdir -p -m 0700 "$runtime_parent"
[[ -d "$runtime_parent" && ! -L "$runtime_parent" ]] || fail "unsafe runtime parent: $runtime_parent"

release_lock() {
  rm -f -- "$refresh_lock/pid"
  rmdir -- "$refresh_lock" 2>/dev/null || true
}

acquire_lock() {
  local waited=0 holder
  until mkdir -m 0700 "$refresh_lock" 2>/dev/null; do
    holder="$(cat "$refresh_lock/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      printf 'refresh-native-if-stale: removing lock of exited refresh %s\n' "$holder" >&2
      release_lock
      continue
    fi
    ((waited > 0)) || printf 'refresh-native-if-stale: waiting for another native refresh (%s)\n' "$refresh_lock" >&2
    ((waited < lock_wait_seconds)) || fail "another native refresh held $refresh_lock for ${lock_wait_seconds}s"
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s\n' "$$" >"$refresh_lock/pid"
}

acquire_lock
trap release_lock EXIT
trap 'exit 1' HUP INT TERM

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
"$refresh"

[[ -d "$runtime_parent" && ! -L "$runtime_parent" ]] \
  || fail "native refresh did not publish a safe runtime parent: $runtime_parent"
if [[ -e "$freshness_receipt" || -L "$freshness_receipt" ]]; then
  [[ -f "$freshness_receipt" && ! -L "$freshness_receipt" ]] \
    || fail "unsafe Native freshness receipt: $freshness_receipt"
fi
temporary_receipt="$(mktemp "$runtime_parent/.native-stack-sources.XXXXXX")" \
  || fail "cannot stage Native freshness receipt in: $runtime_parent"
trap 'rm -f -- "$temporary_receipt"; release_lock' EXIT
chmod 0644 "$temporary_receipt"
printf '%s\n' "$current_sources" >"$temporary_receipt"
mv -f -- "$temporary_receipt" "$freshness_receipt"
trap release_lock EXIT
printf 'refresh-native-if-stale: Native runtime refresh complete\n' >&2
