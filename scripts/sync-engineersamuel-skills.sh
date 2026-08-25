#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'sync-engineersamuel-skills: %s\n' "$1" >&2
  exit 1
}

source_dir=''
target_dir=''
expected_ref=''
while (( $# > 0 )); do
  case "$1" in
    --source) source_dir="${2-}"; shift 2 ;;
    --target) target_dir="${2-}"; shift 2 ;;
    --ref) expected_ref="${2-}"; shift 2 ;;
    *) fail 'usage: sync-engineersamuel-skills.sh --source DIR --target DIR --ref SHA' ;;
  esac
done

[[ -n "$source_dir" && -n "$target_dir" && "$expected_ref" =~ ^[0-9a-f]{40}$ ]] \
  || fail 'source, target, and a 40-character ref are required'
[[ -d "$source_dir" && ! -L "$source_dir" ]] || fail "invalid skill source: $source_dir"
[[ -f "$source_dir/REF" && ! -L "$source_dir/REF" ]] || fail "invalid skill source REF: $source_dir/REF"
[[ "$(< "$source_dir/REF")" == "$expected_ref" ]] \
  || fail "skill source ref differs: expected $expected_ref"
if find "$source_dir" -type l -print -quit | grep -q .; then
  fail "skill source contains a symlink: $source_dir"
fi

skills=()
for skill_dir in "$source_dir"/*; do
  [[ -d "$skill_dir" ]] || continue
  skill="$(basename "$skill_dir")"
  [[ "$skill" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -f "$skill_dir/SKILL.md" ]] \
    || fail "invalid skill source entry: $skill_dir"
  skills+=("$skill")
done
(( ${#skills[@]} > 0 )) || fail 'skill source contains no skills'

if [[ -e "$target_dir" || -L "$target_dir" ]]; then
  [[ -d "$target_dir" && ! -L "$target_dir" ]] || fail "invalid skill target: $target_dir"
else
  mkdir -p "$target_dir"
fi
chmod 0700 "$target_dir"

lock_dir="$target_dir/.trellage-engineersamuel-skills.lock"
lock_attempt=0
while ! mkdir "$lock_dir" 2>/dev/null; do
  lock_attempt=$((lock_attempt + 1))
  (( lock_attempt <= 200 )) || fail "timed out waiting for skill sync lock: $lock_dir"
  if [[ -f "$lock_dir/pid" && ! -L "$lock_dir/pid" ]]; then
    IFS= read -r lock_pid <"$lock_dir/pid" || lock_pid=''
    if [[ "$lock_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -f -- "$lock_dir/pid"
      rmdir "$lock_dir" 2>/dev/null || true
      continue
    fi
  fi
  sleep 0.05
done
printf '%s\n' "$$" >"$lock_dir/pid"
release_lock() {
  rm -f -- "$lock_dir/pid"
  rmdir "$lock_dir" 2>/dev/null || true
}
trap release_lock EXIT

manifest="$target_dir/.trellage-engineersamuel-skills"
managed=()
if [[ -e "$manifest" || -L "$manifest" ]]; then
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail "invalid managed manifest: $manifest"
  IFS= read -r installed_ref <"$manifest" || fail "invalid managed manifest: $manifest"
  [[ "$installed_ref" =~ ^[0-9a-f]{40}$ ]] || fail "invalid managed manifest ref: $manifest"
  while IFS= read -r skill; do
    [[ "$skill" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
      || fail "invalid managed skill name: $manifest"
    managed+=("$skill")
  done < <(tail -n +2 "$manifest")
fi

is_managed() {
  local candidate="$1" managed_skill
  for managed_skill in ${managed[@]+"${managed[@]}"}; do
    [[ "$managed_skill" == "$candidate" ]] && return 0
  done
  return 1
}

for skill in "${skills[@]}"; do
  if [[ -e "$target_dir/$skill" || -L "$target_dir/$skill" ]]; then
    is_managed "$skill" || fail "refusing to replace unmanaged skill: $target_dir/$skill"
    [[ -d "$target_dir/$skill" && ! -L "$target_dir/$skill" ]] \
      || fail "invalid managed skill target: $target_dir/$skill"
  fi
done

transaction="$(mktemp -d "$target_dir/.trellage-engineersamuel-skills.XXXXXX")"
stage="$transaction/new"
backup="$transaction/old"
mkdir "$stage" "$backup"
cleanup() {
  rm -rf -- "$transaction"
  release_lock
}
trap cleanup EXIT

for skill in "${skills[@]}"; do
  cp -R "$source_dir/$skill" "$stage/$skill"
done

backed_up=()
published=()
rollback() {
  local skill
  for skill in ${published[@]+"${published[@]}"}; do
    rm -rf -- "$target_dir/$skill"
  done
  for skill in ${backed_up[@]+"${backed_up[@]}"}; do
    mv "$backup/$skill" "$target_dir/$skill"
  done
}
trap 'rollback; exit 1' ERR

for skill in ${managed[@]+"${managed[@]}"}; do
  if [[ -e "$target_dir/$skill" ]]; then
    mv "$target_dir/$skill" "$backup/$skill"
    backed_up+=("$skill")
  fi
done
for skill in "${skills[@]}"; do
  mv "$stage/$skill" "$target_dir/$skill"
  published+=("$skill")
done

manifest_stage="$transaction/manifest"
{
  printf '%s\n' "$expected_ref"
  printf '%s\n' "${skills[@]}"
} >"$manifest_stage"
chmod 0600 "$manifest_stage"
mv "$manifest_stage" "$manifest"
trap - ERR
