#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -P -- "$(dirname "$0")/.." && pwd -P)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-command-retirement.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
home="$fixture/home"
runtime="$home/.local/share/trellage/omp"
mkdir -p "$home/.local/bin" "$runtime/bin" "$runtime/mise"
printf 'owned-v1\n' >"$runtime/.owned"
printf '#!/bin/sh\nexit 0\n' >"$runtime/bin/omp"
chmod +x "$runtime/bin/omp"
printf 'runtime\n' >"$runtime/mise/keep"
printf 'session\n' >"$home/session"
ln -s "$runtime/bin/omp" "$home/.local/bin/omp"
retire() {
  bash "$root/scripts/retire-native-command.sh" "$home" omp "$runtime/bin/omp" "$runtime/.owned" owned-v1
}
retire
[[ ! -L "$home/.local/bin/omp" && -x "$runtime/bin/omp" && -f "$runtime/mise/keep" && -f "$home/session" ]]
retire
printf '#!/bin/sh\nexit 7\n' >"$home/.local/bin/omp"
retire
[[ -f "$home/.local/bin/omp" && ! -L "$home/.local/bin/omp" ]]
rm "$home/.local/bin/omp"
ln -s "$fixture/unrelated" "$home/.local/bin/omp"
retire
[[ "$(readlink "$home/.local/bin/omp")" == "$fixture/unrelated" ]]
rm "$home/.local/bin/omp"
ln -s "$runtime/bin/omp" "$home/.local/bin/omp"
printf 'foreign\n' >"$runtime/.owned"
if retire; then
  printf 'retirement accepted an invalid ownership marker\n' >&2
  exit 1
fi
[[ -L "$home/.local/bin/omp" ]]
printf 'native command retirement: PASS\n'
