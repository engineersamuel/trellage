#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
retire="$repo_root/scripts/retire-native-backend.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-retire-native.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT

fail() {
  printf 'retire native backend contract: FAIL: %s\n' "$1" >&2
  exit 1
}

home="$fixture/home"
runtime="$home/.local/share/trellage/cpx"
launcher="$runtime/bin/cpx"
private_command="$home/.local/share/trellage/.native-commands/cpx"
public_command="$home/.local/bin/cpx"
mkdir -p "$(dirname "$launcher")" "$(dirname "$private_command")" "$(dirname "$public_command")"
printf '#!/bin/sh\n' >"$launcher"
printf 'trellage-profiles-v1\n' >"$runtime/.managed-by-trellage-profiles"
ln -s "$launcher" "$private_command"
ln -s "$launcher" "$public_command"

bash "$retire" "$home" cpx .managed-by-trellage-profiles trellage-profiles-v1
[[ ! -e "$runtime" && ! -L "$runtime" ]] || fail 'owned runtime remains'
[[ ! -e "$private_command" && ! -L "$private_command" ]] || fail 'private command remains'
[[ ! -e "$public_command" && ! -L "$public_command" ]] || fail 'public command remains'

mkdir -p "$(dirname "$launcher")"
printf '#!/bin/sh\n' >"$launcher"
printf 'unrelated\n' >"$runtime/.managed-by-trellage-profiles"
if bash "$retire" "$home" cpx .managed-by-trellage-profiles trellage-profiles-v1 \
  >"$fixture/unowned.out" 2>&1; then
  fail 'unowned runtime was removed'
fi
[[ -e "$runtime" ]] || fail 'unowned runtime was mutated'

rm -rf -- "$runtime"
ln -s "$launcher" "$private_command"
TRELLAGE_RETIRE_BEST_EFFORT=1 \
  bash "$retire" "$home" cpx .managed-by-trellage-profiles trellage-profiles-v1 \
  >"$fixture/best-effort.out" 2>&1 \
  || fail 'best-effort retirement failed an installer'
[[ -L "$private_command" ]] || fail 'best-effort retirement mutated an orphaned command'
grep -Fq 'remove it manually if it is obsolete' "$fixture/best-effort.out" \
  || fail 'best-effort retirement did not explain manual cleanup'

printf 'retire native backend contract: PASS\n'
