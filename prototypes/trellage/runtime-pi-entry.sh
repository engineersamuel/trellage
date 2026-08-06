#!/usr/bin/env bash
set +x
set -euo pipefail
ulimit -c 0 2>/dev/null || true

unset inherited_copilot_github_token
inherited_copilot_github_token="${COPILOT_GITHUB_TOKEN-}"
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN

fail() {
  printf 'trellage-pi-entry: %s\n' "$1" >&2
  exit "${2:-1}"
}

skill_tree_matches() {
  local source="$1"
  local destination="$2"
  local index
  local -a source_files=() destination_files=()
  [[ -d "$source" && ! -L "$source" && -d "$destination" && ! -L "$destination" ]] || return 1
  [[ -z "$(find "$source" "$destination" -type l -print -quit)" ]] || return 1
  mapfile -d '' -t source_files < <(cd "$source" && find . -type f -print0 | LC_ALL=C sort -z)
  mapfile -d '' -t destination_files < <(cd "$destination" && find . -type f -print0 | LC_ALL=C sort -z)
  [[ ${#source_files[@]} -eq ${#destination_files[@]} ]] || return 1
  for index in "${!source_files[@]}"; do
    [[ "${source_files[$index]}" == "${destination_files[$index]}" ]] || return 1
    cmp -s -- "$source/${source_files[$index]}" "$destination/${destination_files[$index]}" || return 1
  done
}

runtime_home="${PI_CODING_AGENT_DIR:-/home/agent/.omp/agent}"
[[ "$runtime_home" == /* ]] || fail 'PI_CODING_AGENT_DIR must be an absolute path'
case "$runtime_home" in
  /home/agent/*) ;;
  *) fail 'PI_CODING_AGENT_DIR must be under /home/agent' ;;
esac
mkdir -p "$runtime_home"
runtime_home="$(realpath "$runtime_home")"
case "$runtime_home" in
  /home/agent/*) ;;
  *) fail 'PI_CODING_AGENT_DIR resolves outside /home/agent' ;;
esac
export PI_CODING_AGENT_DIR="$runtime_home"

seed_root=/usr/local/share/trellage/pi-seed
managed_manifest="$runtime_home/.trellage-managed-skills"
managed_append_manifest="$runtime_home/.trellage-managed-append-system"
skills_home="$runtime_home/skills"
[[ -d "$seed_root" && ! -L "$seed_root" ]] || fail 'managed Pi seed must be a directory without symlinks'
mkdir -p "$skills_home"
[[ -d "$skills_home" && ! -L "$skills_home" ]] || fail 'managed Pi skills directory must not be a symlink'
[[ ! -e "$managed_manifest" || ( -f "$managed_manifest" && ! -L "$managed_manifest" ) ]] \
  || fail 'managed Pi skill manifest must be a regular file'
[[ ! -e "$managed_append_manifest" || ( -f "$managed_append_manifest" && ! -L "$managed_append_manifest" ) ]] \
  || fail 'managed Pi instruction manifest must be a regular file'

declare -A prior_skills=()
if [[ -f "$managed_manifest" ]]; then
  while IFS= read -r skill_name; do
    [[ -n "$skill_name" ]] || continue
    [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -z "${prior_skills[$skill_name]+x}" ]] \
      || fail "managed Pi skill name is unsafe or duplicated: $skill_name"
    prior_skills["$skill_name"]=1
  done <"$managed_manifest"
fi

seed_manifest="$seed_root/managed-skills.txt"
[[ -f "$seed_manifest" && ! -L "$seed_manifest" ]] \
  || fail 'seeded Pi skill manifest must be a regular file'
declare -A desired_skills=()
while IFS= read -r skill_name; do
  [[ -n "$skill_name" ]] || continue
  [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -z "${desired_skills[$skill_name]+x}" ]] \
    || fail "seeded Pi skill name is unsafe or duplicated: $skill_name"
  source_skill="$seed_root/skills/$skill_name"
  [[ -d "$source_skill" && ! -L "$source_skill" ]] || fail "seeded Pi skill is missing or unsafe: $skill_name"
  [[ -z "$(find "$source_skill" -type l -print -quit)" ]] || fail "seeded Pi skill contains a symlink: $skill_name"
  desired_skills["$skill_name"]=1
done <"$seed_manifest"

for skill_name in "${!prior_skills[@]}"; do
  target_skill="$skills_home/$skill_name"
  if [[ -e "$target_skill" || -L "$target_skill" ]]; then
    [[ -d "$target_skill" && ! -L "$target_skill" ]] || fail "managed Pi skill destination is unsafe: $skill_name"
    rm -rf -- "$target_skill"
  fi
done
for skill_name in "${!desired_skills[@]}"; do
  target_skill="$skills_home/$skill_name"
  if [[ -e "$target_skill" || -L "$target_skill" ]]; then
    skill_tree_matches "$seed_root/skills/$skill_name" "$target_skill" \
      || fail "seeded Pi skill collides with unmanaged state: $skill_name"
    rm -rf -- "$target_skill"
  fi
  cp -R -- "$seed_root/skills/$skill_name" "$target_skill"
done
cp -- "$seed_manifest" "$managed_manifest"

seed_append="$seed_root/APPEND_SYSTEM.md"
runtime_append="$runtime_home/APPEND_SYSTEM.md"
if [[ -e "$seed_append" || -L "$seed_append" ]]; then
  [[ -f "$seed_append" && ! -L "$seed_append" ]] || fail 'seeded Pi instructions must be a regular file'
  if [[ -e "$runtime_append" || -L "$runtime_append" ]]; then
    [[ -f "$runtime_append" && ! -L "$runtime_append" ]] \
      || fail 'managed Pi instructions collide with unmanaged state'
    if [[ ! -f "$managed_append_manifest" ]]; then
      cmp -s -- "$seed_append" "$runtime_append" \
        || fail 'managed Pi instructions collide with unmanaged state'
    fi
  fi
  append_temporary="$runtime_home/.APPEND_SYSTEM.md.trellage.$$"
  [[ ! -e "$append_temporary" && ! -L "$append_temporary" ]] || fail 'managed Pi instruction temporary already exists'
  cp -- "$seed_append" "$append_temporary"
  mv -f -- "$append_temporary" "$runtime_append"
  printf '%s\n' APPEND_SYSTEM.md >"$managed_append_manifest"
elif [[ -f "$managed_append_manifest" ]]; then
  [[ -f "$runtime_append" && ! -L "$runtime_append" ]] || fail 'managed Pi instructions are unsafe'
  rm -f -- "$runtime_append" "$managed_append_manifest"
fi

[[ "$#" -gt 0 ]] || fail 'a mode is required'
mode="$1"
shift
harness_args=()
while (( $# > 0 )) && [[ "$1" != -- ]]; do
  harness_args+=("$1")
  shift
done
prompt=
if (( $# > 0 )); then
  shift
  [[ "$mode" == new || "$mode" == prompt ]] || fail "$mode does not accept a prompt"
  [[ "$#" -eq 1 && -n "$1" ]] \
    || fail "$mode mode requires exactly one non-empty prompt after --"
  prompt="$1"
elif [[ "$mode" == prompt ]]; then
  fail 'prompt mode requires exactly one non-empty prompt after --'
fi

if [[ "$mode" == new && -z "$prompt" && "${#harness_args[@]}" -eq 1 && "${harness_args[0]}" == --version ]]; then
  exec omp --version
fi

if [[ -n "$inherited_copilot_github_token" ]]; then
  export COPILOT_GITHUB_TOKEN="$inherited_copilot_github_token"
fi

base_args=(
  --provider github-copilot
  --model gpt-5.6-terra
  --config /usr/local/share/trellage/pi-config.yml
)

case "$mode" in
  new)
    if [[ -n "$prompt" ]]; then
      exec omp "${base_args[@]}" "${harness_args[@]}" -- "$prompt"
    fi
    exec omp "${base_args[@]}" "${harness_args[@]}"
    ;;
  prompt)
    exec omp "${base_args[@]}" "${harness_args[@]}" --print -- "$prompt"
    ;;
  resume)
    exec omp "${base_args[@]}" "${harness_args[@]}" --continue
    ;;
  *) fail "unsupported mode: $mode" ;;
esac
