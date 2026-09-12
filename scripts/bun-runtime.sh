#!/usr/bin/env bash

trellage_bun_runtime() {
  local root="$1"
  local executable version
  export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
  [[ "$root" == /* && -d "$root" && ! -L "$root" ]] || {
    printf 'trellage runtime: unsafe source workspace: %s\n' "$root" >&2
    return 1
  }
  executable="${TRELLAGE_BUN_EXECUTABLE-}"
  if [[ -z "$executable" ]]; then
    executable="$(command -v bun)" || {
      printf 'trellage runtime: Bun 1.3.3 is required; install it explicitly\n' >&2
      return 1
    }
  fi
  [[ "$executable" == /* && -f "$executable" && -x "$executable" ]] || {
    printf 'trellage runtime: Bun must resolve to an absolute executable file: %s\n' "$executable" >&2
    return 1
  }
  version="$("$executable" --version)" || return 1
  [[ "$version" == 1.3.3 ]] || {
    printf 'trellage runtime: Bun 1.3.3 is required; found %s\n' "$version" >&2
    return 1
  }
  local config="$root/packages/trellage-runtime/bunfig.toml"
  [[ -f "$config" && ! -L "$config" ]] || {
    printf 'trellage runtime: missing or unsafe Bun config: %s\n' "$config" >&2
    return 1
  }
  trellage_bun=("$executable" --no-install --no-env-file "--config=$config")
  # shellcheck disable=SC2034 # Used by the router and Sandbox launchers.
  trellage_launcher=(/usr/bin/env NODE_ENV=production "${trellage_bun[@]}")
}

trellage_require_source_runtime() {
  local root="$1"
  trellage_bun_runtime "$root" || return 1
  "${trellage_bun[@]}" "$root/packages/trellage-runtime/src/workspace-cli.ts" check "$root"
}
