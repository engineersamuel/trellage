#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'trellage statusline: FAIL: %s\n' "$1" >&2
  exit 1
}

script='scripts/trellage-statusline.sh'
[[ -f "$script" && -x "$script" && ! -L "$script" ]] \
  || fail "missing executable $script"

run() {
  printf '%s' "$1" | "$script"
}

expect() {
  local got="$1" want="$2" name="$3"
  # Ensure both strings are comparable (bash command substitution strips trailing newlines)
  local got_normalized="$got" want_normalized="$want"
  # Remove any trailing newlines for comparison
  got_normalized="${got_normalized%$'\n'}"
  want_normalized="${want_normalized%$'\n'}"
  [[ "$got_normalized" == "$want_normalized" ]] || fail "$name: got $(printf %q "$got") want $(printf %q "$want")"
}

got="$(run '{"model":{"display_name":"gpt-6-astra"}}')"
expect "$got" $'gpt-6-astra\n' 'sparse model'

got="$(run '{"model":{"display_name":"gpt-6-astra"},"effort":{"level":"low"},"worktree":{"name":"worktree-statusline","branch":"worktree/statusline"},"cost":{"total_duration_ms":720000},"context_window":{"used_percentage":34.7},"rate_limits":{"five_hour":{"used_percentage":12.2},"seven_day":{"used_percentage":40}}}')"
expect "$got" $'worktree-statusline@worktree/statusline │ 12m │ 34% ctx │ gpt-6-astra low │ 5h 12% │ 7d 40%\n' 'full claude'

got="$(run '{"model":{"display_name":"Grok 4.5"},"effort":{"level":"high"},"workspace":{"git_worktree":"/tmp/demo","branch":"main"},"cost":{"total_duration_ms":3600000},"context_window":{"used_percentage":8}}')"
expect "$got" $'demo@main │ 1h0m │ 8% ctx │ Grok 4.5 high\n' 'grok shaped'

got="$(run '{"model":{"display_name":"x"},"cost":{"total_duration_ms":500}}')"
expect "$got" $'x\n' 'duration under one second'

got="$(run '{"model":{"display_name":"x"},"cost":{"total_duration_ms":60000}}')"
expect "$got" $'1m │ x\n' 'one minute'

got="$(run '{"model":{"display_name":"x"},"context_window":{}}')"
expect "$got" $'x\n' 'missing used_percentage'

got="$(run '{"model":{"display_name":"x"},"context_window":{"used_percentage":null}}')"
expect "$got" $'x\n' 'null used_percentage'

got="$(run '[]')"
expect "$got" $'\n' 'non-object'

got="$(printf '' | "$script"; printf '\n')"
expect "$got" $'\n' 'empty stdin'

code=0
printf '%s' '{"model":{"display_name":"x"}}' | "$script" >/dev/null || code=$?
[[ "$code" -eq 0 ]] || fail "nonzero exit $code"

