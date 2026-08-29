#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -P -- "$script_dir/.." && pwd -P)"
state_root="${TRELLAGE_BOOTSTRAP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/trellage}"
lock_dir="$state_root/dependency-bootstrap.lock"
log_path="$state_root/dependency-bootstrap.log"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
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
  command -v mise >/dev/null 2>&1 || {
    log "mise is unavailable; skipping development dependency bootstrap"
    return 0
  }
  acquire_lock || return 0

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

is_project_context() {
  local mise_root
  if [[ -n "${MISE_PROJECT_ROOT:-}" && -d "$MISE_PROJECT_ROOT" && ! -L "$MISE_PROJECT_ROOT" ]]; then
    mise_root="$(cd -P -- "$MISE_PROJECT_ROOT" && pwd -P)" || return 1
    [[ "$mise_root" != "$project_root" ]] || return 0
  fi
  [[ "$HOME" == /* ]] || return 1
  case "$project_root/" in
    "$HOME"/*) return 0 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  --background)
    is_project_context || exit 0
    command -v mise >/dev/null 2>&1 || exit 0
    mkdir -p -- "$state_root"
    nohup "$0" --run >>"$log_path" 2>&1 </dev/null &
    exit 0
    ;;
  --run)
    run_bootstrap
    ;;
  *)
    printf 'Usage: %s --background|--run\n' "${0##*/}" >&2
    exit 2
    ;;
esac
