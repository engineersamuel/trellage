#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 5 ]] || { printf 'usage: retire-native-command HOME NAME TARGET MARKER OWNER\n' >&2; exit 2; }
native_home="$1"
native_name="$2"
native_target="$3"
native_marker="$4"
native_owner="$5"
[[ "$native_home" == /* && "$native_home" != / && "$native_name" =~ ^[a-z][a-z0-9]*$ ]] \
  || { printf 'invalid native command retirement identity\n' >&2; exit 1; }

native_command="$native_home/.local/bin/$native_name"
# An upstream executable or unrelated symlink with the same name belongs to the user.
[[ -L "$native_command" && "$(readlink "$native_command")" == "$native_target" ]] || exit 0
for native_directory in "$native_home" "$native_home/.local" "$native_home/.local/bin"; do
  [[ -d "$native_directory" && ! -L "$native_directory" ]] \
    || { printf 'refusing redirected native command directory: %s\n' "$native_directory" >&2; exit 1; }
done
[[ -f "$native_marker" && ! -L "$native_marker" && "$(cat "$native_marker")" == "$native_owner" \
  && -f "$native_target" && ! -L "$native_target" ]] \
  || { printf 'refusing native command retirement without owned runtime: %s\n' "$native_name" >&2; exit 1; }
rm -- "$native_command"
