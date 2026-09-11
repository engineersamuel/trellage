#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANON="$ROOT/scripts/trellage-statusline.sh"

install_script() {
  local dest="$1"
  local dir staged

  dir="$(dirname "$dest")"
  [ -d "$dir" ] || return 0
  [ ! -L "$dir" ] || return 0

  staged="$(mktemp "$dir/.statusline.sh.XXXXXX")"
  cp "$CANON" "$staged"
  chmod 0755 "$staged"
  mv -f "$staged" "$dest"
}

claude_home() {
  local dir="$1"
  local settings="$dir/settings.json"
  local staged

  install_script "$dir/statusline.sh"
  staged="$(mktemp "$dir/.settings.json.XXXXXX")"

  if [[ -e "$settings" ]]; then
    [[ -f "$settings" && ! -L "$settings" ]] || return 0
    jq --arg home "$dir" '
      if type != "object" then .
      elif (.statusLine.command? | type == "string") and (.statusLine.command | test("statusline-balanced\\.sh")) then
        .statusLine = {
          type: "command",
          command: ("bash " + $home + "/statusline.sh"),
          refreshInterval: 15
        }
      elif .statusLine == null then
        .statusLine = {
          type: "command",
          command: ("bash " + $home + "/statusline.sh"),
          refreshInterval: 15
        }
      else .
      end
    ' "$settings" >"$staged" || {
      rm -f -- "$staged"
      return 0
    }
  else
    jq -n --arg home "$dir" '{
      statusLine: {
        type: "command",
        command: ("bash " + $home + "/statusline.sh"),
        refreshInterval: 15
      }
    }' >"$staged"
  fi

  chmod 0600 "$staged"
  mv -f "$staged" "$settings"
}

copilot_home() {
  local dir="$1"
  local settings="$dir/settings.json"
  local staged

  install_script "$dir/statusline.sh"
  staged="$(mktemp "$dir/.settings.json.XXXXXX")"

  if [[ -e "$settings" ]]; then
    [[ -f "$settings" && ! -L "$settings" ]] || return 0
    jq --arg home "$dir" '
      if type != "object" then .
      else
        (if .statusLine == null then
          .statusLine = {
            type: "command",
            command: ("bash " + $home + "/statusline.sh"),
            refreshInterval: 15
          }
        else . end)
        | (if .footer == null then
            .footer = { showCustom: true }
          elif (.footer | type) == "object" and .footer.showCustom == null then
            .footer.showCustom = true
          else .
          end)
      end
    ' "$settings" >"$staged" || {
      rm -f -- "$staged"
      return 0
    }
  else
    jq -n --arg home "$dir" '{
      statusLine: {
        type: "command",
        command: ("bash " + $home + "/statusline.sh"),
        refreshInterval: 15
      },
      footer: {
        showCustom: true
      }
    }' >"$staged"
  fi

  chmod 0600 "$staged"
  mv -f "$staged" "$settings"
}

codex_home() {
  local dir="$1"
  local target="$dir/config.toml"
  local block

  block=$(printf '%s\n' \
    '' \
    '[tui]' \
    'status_line = ["git-branch", "context-used", "model-with-reasoning"]')

  if [[ ! -e "$target" ]]; then
    printf '%s\n' "$block" | sed '1d' >"$target"
    chmod 0600 "$target"
    return 0
  fi

  [[ -f "$target" && ! -L "$target" ]] || return 0
  grep -Eq '^[[:space:]]*status_line[[:space:]]*=' "$target" && return 0
  grep -Eq '^[[:space:]]*\[tui\][[:space:]]*$' "$target" && return 0
  printf '%s\n' "$block" >>"$target"
}

grok_home() {
  local dir="$1"
  local target="$dir/config.toml"
  local table

  install_script "$dir/statusline.sh"
  table=$(printf '%s\n' \
    '' \
    '[ui.status_line]' \
    'type = "command"' \
    "command = \"$dir/statusline.sh\"" \
    'refresh_interval = 15')

  if [[ ! -e "$target" ]]; then
    printf '%s\n' "$table" | sed '1d' >"$target"
    chmod 0600 "$target"
    return 0
  fi

  [[ -f "$target" && ! -L "$target" ]] || return 0
  grep -Eq '^\[ui\.status_line\]' "$target" && return 0
  printf '%s\n' "$table" >>"$target"
}

apply_home() {
  local kind="$1"
  local dir="$2"

  [ -d "$dir" ] || return 0
  [ ! -L "$dir" ] || return 0

  case "$kind" in
    claude) claude_home "$dir" ;;
    copilot) copilot_home "$dir" ;;
    codex) codex_home "$dir" ;;
    grok) grok_home "$dir" ;;
  esac
}

[ -d "$HOME" ] || exit 0
[ ! -L "$HOME" ] || {
  printf 'refusing symlink home: %s\n' "$HOME" >&2
  exit 0
}

apply_home claude "$HOME/.claude"
apply_home copilot "$HOME/.copilot"
apply_home codex "$HOME/.codex"
apply_home grok "$HOME/.grok"

for kind in claude copilot codex grok; do
  for dir in "$HOME/.local/share/trellage/profiles/$kind"/*/home; do
    [ -d "$dir" ] || continue
    [ ! -L "$dir" ] || continue
    apply_home "$kind" "$dir"
  done
done

printf 'Restart Grok (and other TUIs) to paint the status line.\n'
