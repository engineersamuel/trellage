#!/usr/bin/env bash
# Trellage shared TUI status line. Reads one JSON object on stdin.
# Always exits 0. Empty stdout hides the row.

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
printf '%s' "$input" | jq -e 'type == "object"' >/dev/null 2>&1 || exit 0

field() {
  printf '%s' "$input" | jq -r "$1"
}

sanitize() {
  local max="$2"
  printf '%s' "$1" | tr -d '\000-\037\177' | head -c "$max"
}

basename_of() {
  local value="$1"
  value="${value%/}"
  printf '%s' "${value##*/}"
}

worktree=$(field '.worktree.name // .workspace.git_worktree // empty')
branch=$(field '.worktree.branch // .workspace.branch // empty')
cwd=$(field '.workspace.current_dir // .cwd // empty')
[[ "$worktree" == */* ]] && worktree="$(basename_of "$worktree")"
worktree=$(sanitize "$worktree" 40)
branch=$(sanitize "$branch" 40)
location=""
if [[ -n "$worktree" && -n "$branch" ]]; then
  location="${worktree}@${branch}"
elif [[ -n "$worktree" ]]; then
  location="$worktree"
elif [[ -n "$branch" ]]; then
  location="$branch"
elif [[ -n "$cwd" ]]; then
  location=$(sanitize "$(basename_of "$cwd")" 40)
fi
location=$(sanitize "$location" 40)

duration=$(field 'if .cost.total_duration_ms != null then (.cost.total_duration_ms | floor | tostring) else empty end')
time=""
if [[ -n "$duration" && "$duration" -ge 1000 ]]; then
  minutes=$((duration / 60000))
  hours=$((minutes / 60))
  remain=$((minutes % 60))
  if [[ "$hours" -ge 1 ]]; then
    time="${hours}h${remain}m"
  else
    time="${minutes}m"
  fi
fi

context=$(field 'if .context_window.used_percentage != null then (.context_window.used_percentage | floor | tostring) else empty end')
[[ -n "$context" ]] && context="${context}% ctx"

model=$(field '.model.display_name // .model.id // empty')
effort=$(field '.effort.level // empty')
model=$(sanitize "$model" 30)
effort=$(sanitize "$effort" 16)
model_effort=""
if [[ -n "$model" && -n "$effort" ]]; then
  model_effort="${model} ${effort}"
elif [[ -n "$model" ]]; then
  model_effort="$model"
fi

five=$(field 'if .rate_limits.five_hour.used_percentage != null then (.rate_limits.five_hour.used_percentage | floor | tostring) else empty end')
seven=$(field 'if .rate_limits.seven_day.used_percentage != null then (.rate_limits.seven_day.used_percentage | floor | tostring) else empty end')
[[ -n "$five" ]] && five="5h ${five}%"
[[ -n "$seven" ]] && seven="7d ${seven}%"

# Fixed order: location, time, context, model+effort, five, seven
# Never reorder; just drop empty parts
parts=()
[[ -n "$location" ]] && parts+=("$location")
[[ -n "$time" ]] && parts+=("$time")
[[ -n "$context" ]] && parts+=("$context")
[[ -n "$model_effort" ]] && parts+=("$model_effort")
[[ -n "$five" ]] && parts+=("$five")
[[ -n "$seven" ]] && parts+=("$seven")

out=""
for part in "${parts[@]}"; do
  if [[ -n "$out" ]]; then
    out="$out │ $part"
  else
    out="$part"
  fi
done
printf '%s\n' "$out"
exit 0
