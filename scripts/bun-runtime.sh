#!/usr/bin/env bash

TRELLAGE_BUN_VERSION=1.4.2

trellage_ensure_bun_runtime() {
  local root="$1"
  shift
  local executable version
  [[ "$root" == /* && -d "$root" && ! -L "$root" ]] || {
    printf 'trellage runtime: unsafe source workspace: %s\n' "$root" >&2
    return 1
  }
  (( $# > 0 )) || {
    printf 'trellage runtime: missing command for Bun runtime re-execution\n' >&2
    return 1
  }
  if [[ -n "${TRELLAGE_BUN_EXECUTABLE-}" ]]; then
    return 0
  fi
  executable="$(command -v bun 2>/dev/null || true)"
  version=
  if [[ -n "$executable" ]]; then
    version="$("$executable" --version 2>/dev/null || true)"
  fi
  if [[ "$version" == "$TRELLAGE_BUN_VERSION" ]]; then
    return 0
  fi
  if [[ "${TRELLAGE_BUN_BOOTSTRAPPED-}" == 1 ]]; then
    printf 'trellage runtime: Bun %s is required; found %s after Mise upgrade\n' \
      "$TRELLAGE_BUN_VERSION" "${version:-none}" >&2
    return 1
  fi
  command -v mise >/dev/null 2>&1 || {
    printf 'trellage runtime: Bun %s is required; found %s and Mise is unavailable\n' \
      "$TRELLAGE_BUN_VERSION" "${version:-none}" >&2
    return 1
  }
  printf 'trellage runtime: installing Bun %s with Mise; found %s\n' \
    "$TRELLAGE_BUN_VERSION" "${version:-none}" >&2
  mise install "bun@$TRELLAGE_BUN_VERSION"
  exec env TRELLAGE_BUN_BOOTSTRAPPED=1 \
    mise exec "bun@$TRELLAGE_BUN_VERSION" -- "$@"
}

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
      printf 'trellage runtime: Bun %s is required; install it explicitly\n' \
        "$TRELLAGE_BUN_VERSION" >&2
      return 1
    }
  fi
  [[ "$executable" == /* && -f "$executable" && -x "$executable" ]] || {
    printf 'trellage runtime: Bun must resolve to an absolute executable file: %s\n' "$executable" >&2
    return 1
  }
  version="$("$executable" --version)" || return 1
  [[ "$version" == "$TRELLAGE_BUN_VERSION" ]] || {
    printf 'trellage runtime: Bun %s is required; found %s\n' \
      "$TRELLAGE_BUN_VERSION" "$version" >&2
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
