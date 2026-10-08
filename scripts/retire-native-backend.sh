#!/usr/bin/env bash
set -euo pipefail

readonly home="${1-}"
readonly backend="${2-}"
readonly marker_name="${3-}"
shift 3 2>/dev/null || true
readonly -a marker_values=("$@")

fail() {
  if [[ "${TRELLAGE_RETIRE_BEST_EFFORT-}" == 1 ]]; then
    printf 'retire native backend: warning: %s; remove it manually if it is obsolete\n' "$1" >&2
    exit 0
  fi
  printf 'retire native backend: %s\n' "$1" >&2
  exit 1
}

canonical_directory() {
  (unset CDPATH; cd -P -- "$1" >/dev/null 2>&1 && pwd -P)
}

canonical_file() {
  local file="$1"
  printf '%s/%s\n' "$(canonical_directory "$(dirname "$file")")" "$(basename "$file")"
}

[[ -n "$home" && -n "$backend" && -n "$marker_name" && ${#marker_values[@]} -gt 0 ]] \
  || fail 'expected HOME BACKEND MARKER_NAME MARKER_VALUE...'
case "$home" in
  /*) ;;
  *) fail "HOME must be an absolute path: $home" ;;
esac
[[ -d "$home" && ! -L "$home" ]] || fail "unsafe HOME: $home"
canonical_home="$(canonical_directory "$home")"
readonly canonical_home
readonly runtime_root="$canonical_home/.local/share/trellage/$backend"
readonly launcher="$runtime_root/bin/$backend"
readonly marker="$runtime_root/$marker_name"
readonly private_command="$canonical_home/.local/share/trellage/.native-commands/$backend"
readonly public_command="$canonical_home/.local/bin/$backend"

if [[ ! -e "$runtime_root" && ! -L "$runtime_root" ]]; then
  for command in "$private_command" "$public_command"; do
    [[ ! -e "$command" && ! -L "$command" ]] \
      || fail "refusing orphaned command without owned runtime: $command"
  done
  exit 0
fi

[[ -d "$runtime_root" && ! -L "$runtime_root" ]] \
  || fail "unsafe retired runtime: $runtime_root"
[[ "$(canonical_directory "$runtime_root")" == "$runtime_root" ]] \
  || fail "redirected retired runtime: $runtime_root"
[[ -f "$marker" && ! -L "$marker" ]] || fail "unowned retired runtime: $runtime_root"
installed_marker="$(<"$marker")"
marker_owned=false
for expected_marker in "${marker_values[@]}"; do
  if [[ "$installed_marker" == "$expected_marker" ]]; then
    marker_owned=true
    break
  fi
done
[[ "$marker_owned" == true ]] || fail "unowned retired runtime: $runtime_root"

for command in "$private_command" "$public_command"; do
  if [[ -e "$command" || -L "$command" ]]; then
    [[ -L "$command" ]] || fail "refusing unrelated retired command: $command"
    target="$(readlink "$command")"
    case "$target" in
      /*) ;;
      *) target="$(dirname "$command")/$target" ;;
    esac
    [[ "$(canonical_file "$target")" == "$launcher" ]] \
      || fail "refusing unrelated retired command: $command"
    rm -- "$command"
  fi
done

rm -rf -- "$runtime_root"
printf 'Retired owned %s backend.\n' "$backend"
