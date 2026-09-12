#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -P -- "$script_dir/.." && pwd -P)"
state_root="${TRELLAGE_BOOTSTRAP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/trellage}"
lock_dir="$state_root/dependency-bootstrap.lock"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

resolve_project_root() {
  if [[ "$script_dir" == "$project_root/lib" ]]; then
    local marker="$project_root/.managed-by-trellage-router"
    if [[ ! -f "$marker" || -L "$marker" ]] \
      || ! cmp -s -- "$marker" <(printf 'trellage-router-v3\n'); then
      printf 'dependency bootstrap: missing or unsafe v3 router ownership marker: %s\n' "$marker" >&2
      return 1
    fi
    if [[ ! -d "$project_root/source" || -L "$project_root/source" ]]; then
      printf 'dependency bootstrap: missing or unsafe installed source workspace: %s\n' \
        "$project_root/source" >&2
      return 1
    fi
    project_root="$project_root/source"
  fi

  local preparer="$project_root/scripts/build-profile-compiler.sh"
  if [[ ! -d "$project_root/scripts" || -L "$project_root/scripts" \
    || ! -f "$preparer" || -L "$preparer" || ! -x "$preparer" ]]; then
    printf 'dependency bootstrap: missing or unsafe source preparer: %s\n' "$preparer" >&2
    return 1
  fi
}

release_lock() {
  rm -f -- "$lock_dir/pid"
  rmdir -- "$lock_dir" 2>/dev/null || true
}

acquire_lock() {
  mkdir -p -- "$state_root"
  if mkdir -- "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    trap release_lock EXIT HUP INT TERM
    return 0
  fi

  local owner_pid=
  if [[ -f "$lock_dir/pid" && ! -L "$lock_dir/pid" ]]; then
    owner_pid="$(<"$lock_dir/pid")"
  fi
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    return 1
  fi

  rm -f -- "$lock_dir/pid"
  rmdir -- "$lock_dir" 2>/dev/null || return 1
  mkdir -- "$lock_dir" 2>/dev/null || return 1
  printf '%s\n' "$$" >"$lock_dir/pid"
  trap release_lock EXIT HUP INT TERM
}

run_bootstrap() {
  resolve_project_root
  command -v mise >/dev/null 2>&1 || {
    log "mise is required for explicit development dependency bootstrap"
    return 1
  }
  acquire_lock || {
    log "development dependency bootstrap is locked"
    return 1
  }
  "$project_root/scripts/build-profile-compiler.sh"

  local -a mise_exec
  if [[ -f "$project_root/mise.toml" && ! -L "$project_root/mise.toml" ]]; then
    if ! mise -C "$project_root" install --dry-run-code >/dev/null 2>&1; then
      log "installing missing mise tools"
      mise -C "$project_root" install
    fi
    mise_exec=(mise -C "$project_root" exec --)
  else
    if ! mise where uv@latest >/dev/null 2>&1; then
      log "installing latest stable uv"
      mise install uv@latest
    fi
    mise_exec=(mise exec uv@latest --)
  fi

  if ! "${mise_exec[@]}" uvx --offline yt-dlp --version >/dev/null 2>&1; then
    log "warming the yt-dlp uvx package"
    "${mise_exec[@]}" uvx yt-dlp --version >/dev/null
  fi
}

case "${1:-}" in
  --background)
    printf 'Automatic dependency installation is disabled; run bootstrap-development-dependencies.sh --run explicitly.\n' >&2
    exit 1
    ;;
  --run)
    run_bootstrap
    ;;
  *)
    printf 'Usage: %s --background|--run\n' "${0##*/}" >&2
    exit 2
    ;;
esac
