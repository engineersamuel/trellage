#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'trellage statusline apply: FAIL: %s\n' "$1" >&2
  exit 1
}

script='scripts/apply-trellage-statusline.sh'
[[ -f "$script" && -x "$script" && ! -L "$script" ]] \
  || fail "missing executable $script"

home_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-statusline-apply.XXXXXX")"
trap 'rm -rf -- "$home_root"' EXIT
export HOME="$home_root/home"
mkdir -p "$HOME"

run_apply() {
  "$script"
}

assert_not_exists() {
  local path="$1"
  [[ ! -e "$path" ]] || fail "expected absent: $path"
}

assert_exists() {
  local path="$1"
  [[ -e "$path" ]] || fail "expected present: $path"
}

assert_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || fail "expected regular file: $path"
}

assert_contains() {
  local needle="$1" haystack="$2" label="$3"
  grep -Fqx "$needle" "$haystack" || fail "$label missing line: $needle"
}

assert_json() {
  local file="$1" filter="$2" expected="$3" label="$4"
  local actual
  actual="$(jq -r "$filter" "$file")"
  [[ "$actual" == "$expected" ]] || fail "$label: got $(printf %q "$actual") want $(printf %q "$expected")"
}

assert_same_as_canon() {
  cmp -s scripts/trellage-statusline.sh "$1" || fail "$1 differs from canonical script"
}

output="$(run_apply)"
[[ "$output" == 'Restart Grok (and other TUIs) to paint the status line.' ]] \
  || fail "unexpected restart note for missing homes"
assert_not_exists "$HOME/.claude"
assert_not_exists "$HOME/.copilot"
assert_not_exists "$HOME/.codex"
assert_not_exists "$HOME/.grok"
assert_not_exists "$HOME/.local"

mkdir -p "$HOME/.claude"
printf '%s\n' '{"statusLine":{"type":"command","command":"bash /tmp/statusline-balanced.sh","refreshInterval":60}}' >"$HOME/.claude/settings.json"
run_apply >/dev/null
assert_file "$HOME/.claude/statusline.sh"
assert_same_as_canon "$HOME/.claude/statusline.sh"
assert_json "$HOME/.claude/settings.json" '.statusLine.command' "bash $HOME/.claude/statusline.sh" 'claude balanced command'
assert_json "$HOME/.claude/settings.json" '.statusLine.refreshInterval' '15' 'claude balanced refresh'

rm -rf "$HOME/.claude"
mkdir -p "$HOME/.claude"
printf '%s\n' '{"statusLine":{"type":"command","command":"echo custom","refreshInterval":5}}' >"$HOME/.claude/settings.json"
run_apply >/dev/null
assert_file "$HOME/.claude/statusline.sh"
assert_same_as_canon "$HOME/.claude/statusline.sh"
assert_json "$HOME/.claude/settings.json" '.statusLine.command' 'echo custom' 'claude custom command preserved'
assert_json "$HOME/.claude/settings.json" '.statusLine.refreshInterval' '5' 'claude custom refresh preserved'

mkdir -p "$HOME/.copilot"
printf '%s\n' '{}' >"$HOME/.copilot/settings.json"
run_apply >/dev/null
assert_file "$HOME/.copilot/statusline.sh"
assert_same_as_canon "$HOME/.copilot/statusline.sh"
assert_json "$HOME/.copilot/settings.json" '.statusLine.command' "bash $HOME/.copilot/statusline.sh" 'copilot command'
assert_json "$HOME/.copilot/settings.json" '.footer.showCustom' 'true' 'copilot footer enabled'

mkdir -p "$HOME/.codex"
printf '%s\n' '' >"$HOME/.codex/config.toml"
run_apply >/dev/null
assert_not_exists "$HOME/.codex/statusline.sh"
assert_contains '[tui]' "$HOME/.codex/config.toml" 'codex tui table'
assert_contains 'status_line = ["git-branch", "context-used", "model-with-reasoning"]' "$HOME/.codex/config.toml" 'codex status line list'

printf '%s\n' '[tui]' 'status_line = []' >"$HOME/.codex/config.toml"
run_apply >/dev/null
assert_contains 'status_line = []' "$HOME/.codex/config.toml" 'codex existing status line preserved'

mkdir -p "$HOME/.grok"
rm -f "$HOME/.grok/config.toml"
run_apply >/dev/null
assert_file "$HOME/.grok/statusline.sh"
assert_same_as_canon "$HOME/.grok/statusline.sh"
assert_contains '[ui.status_line]' "$HOME/.grok/config.toml" 'grok status line table'
assert_contains 'type = "command"' "$HOME/.grok/config.toml" 'grok type'
assert_contains "command = \"$HOME/.grok/statusline.sh\"" "$HOME/.grok/config.toml" 'grok command'
assert_contains 'refresh_interval = 15' "$HOME/.grok/config.toml" 'grok refresh'

profile_home="$HOME/.local/share/trellage/profiles/claude/default/home"
mkdir -p "$profile_home"
printf '%s\n' '{}' >"$profile_home/settings.json"
run_apply >/dev/null
assert_file "$profile_home/statusline.sh"
assert_same_as_canon "$profile_home/statusline.sh"
assert_json "$profile_home/settings.json" '.statusLine.command' "bash $profile_home/statusline.sh" 'profile claude command'
assert_json "$profile_home/settings.json" '.statusLine.refreshInterval' '15' 'profile claude refresh'

printf '%s\n' 'trellage statusline apply: PASS'
