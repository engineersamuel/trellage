# shellcheck shell=bash
# Sourced (bash) by the mise factory:* tasks and by ./sf: which factory instance this checkout runs.
# Main checkout (or SF_PRIMARY=1): ports 7700/5174 and the shared state dir ~/.local/state/trellage/factory.
# Linked git worktree: its own ports (from a hash of the worktree name), state dir and run worktrees, so it runs
# beside the main factory with a clean slate. Variables already set in the environment always win.
_sf_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_sf_state_root="${XDG_STATE_HOME:-$HOME/.local/state}/trellage"
_sf_git="$(git -C "$_sf_dir" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
_sf_common="$(git -C "$_sf_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ "${SF_PRIMARY:-0}" != 1 && -n "$_sf_git" && "$_sf_git" != "$_sf_common" ]]; then
  SF_INSTANCE="$(basename "$(git -C "$_sf_dir" rev-parse --show-toplevel)")"
  _sf_hash=$(printf '%s' "$SF_INSTANCE" | cksum | cut -d' ' -f1)
  _sf_coord_default=$((20000 + (_sf_hash % 2000) * 2))
  _sf_state_default="$_sf_state_root/factory-wt/$SF_INSTANCE"
  export SF_WORKTREES="${SF_WORKTREES:-${SF_STATE_DIR:-$_sf_state_default}/worktrees}"
else
  SF_INSTANCE=main
  _sf_coord_default=7700
  _sf_state_default="$_sf_state_root/factory"
fi
export SF_INSTANCE
export SF_STATE_DIR="${SF_STATE_DIR:-$_sf_state_default}"
export SF_COORD_PORT="${SF_COORD_PORT:-$_sf_coord_default}"
export SF_UI_PORT="${SF_UI_PORT:-$([[ $SF_INSTANCE == main ]] && echo 5174 || echo $((SF_COORD_PORT + 1)))}"
export SF_ADDR="${SF_ADDR:-127.0.0.1:$SF_COORD_PORT}"
export SF_URL="${SF_URL:-http://$SF_ADDR}"
export SF_UI_URL="${SF_UI_URL:-http://localhost:$SF_UI_PORT/}"
export SF_LOGS="${SF_LOGS:-$SF_STATE_DIR/logs}"
export PC_SOCKET_PATH="${PC_SOCKET_PATH:-$SF_STATE_DIR/pc.sock}"
unset _sf_dir _sf_state_root _sf_git _sf_common _sf_hash _sf_coord_default _sf_state_default
