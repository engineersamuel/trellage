#!/usr/bin/env bash
set +x
set -euo pipefail
ulimit -c 0 2>/dev/null || true

unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY
unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN

fail() {
  printf 'trellage-prime-entry: %s\n' "$1" >&2
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

[[ "$#" -gt 0 ]] || fail 'a mode is required'
mode="$1"
shift
case "$mode" in
  new|prompt|resume) ;;
  *) fail "unsupported mode: $mode" ;;
esac

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
  exec prime-agent --version
fi
selected_model=claude-opus-5
runtime_args=()
for ((index = 0; index < ${#harness_args[@]}; index += 1)); do
  case "${harness_args[$index]}" in
    --model)
      ((index + 1 < ${#harness_args[@]})) || fail '--model requires a value'
      selected_model="${harness_args[$((index + 1))]}"
      [[ -n "$selected_model" ]] || fail '--model requires a value'
      index=$((index + 1))
      ;;
    --model=*)
      selected_model="${harness_args[$index]#--model=}"
      [[ -n "$selected_model" ]] || fail '--model requires a value'
      ;;
    *) runtime_args+=("${harness_args[$index]}") ;;
  esac
done


runtime_home="${PRIME_AGENT_CODING_AGENT_DIR:-/home/agent/.prime/agent}"
[[ "$runtime_home" == /* ]] || fail 'PRIME_AGENT_CODING_AGENT_DIR must be an absolute path'
[[ "$runtime_home" != *'//'* && "$runtime_home" != *'/./'* \
  && "$runtime_home" != *'/../'* && "$runtime_home" != */. \
  && "$runtime_home" != */.. && "$runtime_home" != *'\\'* ]] \
  || fail 'PRIME_AGENT_CODING_AGENT_DIR must be canonical'
case "$runtime_home" in
  /home/agent/*) ;;
  *) fail 'PRIME_AGENT_CODING_AGENT_DIR must be under /home/agent' ;;
esac
[[ -d /home/agent && ! -L /home/agent ]] || fail '/home/agent must be a non-symlink directory'
[[ "$(realpath -m -- "$runtime_home")" == "$runtime_home" ]] \
  || fail 'PRIME_AGENT_CODING_AGENT_DIR must not traverse symlinks'

relative_home="${runtime_home#/home/agent/}"
IFS='/' read -r -a runtime_components <<<"$relative_home"
current=/home/agent
for component in "${runtime_components[@]}"; do
  [[ -n "$component" && "$component" != . && "$component" != .. ]] \
    || fail 'PRIME_AGENT_CODING_AGENT_DIR contains an unsafe component'
  current="$current/$component"
  [[ ! -L "$current" ]] || fail "Prime config path component must not be a symlink: $current"
  if [[ -e "$current" && ! -d "$current" ]]; then
    fail "Prime config path component must be a directory: $current"
  fi
done
mkdir -p -- "$runtime_home" || fail 'cannot create Prime config directory'
current=/home/agent
for component in "${runtime_components[@]}"; do
  current="$current/$component"
  [[ -d "$current" && ! -L "$current" ]] \
    || fail "Prime config path component must be a non-symlink directory: $current"
done
[[ "$(realpath -e -- "$runtime_home")" == "$runtime_home" ]] \
  || fail 'PRIME_AGENT_CODING_AGENT_DIR resolves outside /home/agent'
export PRIME_AGENT_CODING_AGENT_DIR="$runtime_home"

kernel_archive=/usr/local/share/trellage/prime-kernel-seed.tar.gz
kernel_home=/home/agent/.trellage/prime-kernel
kernel_marker="$kernel_home/.trellage-prime-kernel"
kernel_python="$kernel_home/.prime/agent/kernel-venv/bin/python"
[[ "${PRIME_AGENT_KERNEL_PYTHON:-}" == "$kernel_python" ]] \
  || fail 'PRIME_AGENT_KERNEL_PYTHON does not select the managed Prime kernel'
[[ -f "$kernel_archive" && ! -L "$kernel_archive" ]] \
  || fail 'managed Prime kernel archive must be a regular file'
if [[ ! -x "$kernel_python" ]]; then
  if [[ -e "$kernel_home" || -L "$kernel_home" ]]; then
    [[ -d "$kernel_home" && ! -L "$kernel_home" && -f "$kernel_marker" && ! -L "$kernel_marker" ]] \
      || fail 'managed Prime kernel collides with unmanaged state'
    rm -rf -- "$kernel_home"
  fi
  kernel_parent="${kernel_home%/*}"
  mkdir -p -- "$kernel_parent"
  [[ -d "$kernel_parent" && ! -L "$kernel_parent" ]] \
    || fail 'managed Prime kernel parent must be a non-symlink directory'
  kernel_temporary="$(mktemp -d "$kernel_parent/.prime-kernel.XXXXXX")" \
    || fail 'cannot create temporary Prime kernel directory'
  cleanup_kernel_temporary() {
    local status=$?
    trap - EXIT HUP INT TERM
    rm -rf -- "$kernel_temporary"
    exit "$status"
  }
  trap cleanup_kernel_temporary EXIT HUP INT TERM
  tar -xzf "$kernel_archive" -C "$kernel_temporary" \
    || fail 'cannot extract managed Prime kernel archive'
  [[ -f "$kernel_temporary/.trellage-prime-kernel" \
    && ! -L "$kernel_temporary/.trellage-prime-kernel" \
    && -L "$kernel_temporary/.prime/agent/kernel-venv/bin/python" ]] \
    || fail 'managed Prime kernel archive is incomplete'
  mv -- "$kernel_temporary" "$kernel_home" \
    || fail 'cannot install managed Prime kernel'
  kernel_temporary=
  trap - EXIT HUP INT TERM
fi
[[ -f "$kernel_marker" && ! -L "$kernel_marker" && -x "$kernel_python" ]] \
  || fail 'managed Prime kernel is unavailable'

seed_root=/usr/local/share/trellage/prime-seed
managed_manifest="$runtime_home/.trellage-managed-skills"
managed_extension_manifest="$runtime_home/.trellage-managed-extensions"
managed_append_manifest="$runtime_home/.trellage-managed-append-system"
skills_home="$runtime_home/skills"
extensions_home="$runtime_home/extensions"
[[ -d "$seed_root" && ! -L "$seed_root" ]] || fail 'managed Prime seed must be a directory without symlinks'
mkdir -p "$skills_home" "$extensions_home"
[[ -d "$skills_home" && ! -L "$skills_home" ]] || fail 'managed Prime skills directory must not be a symlink'
[[ -d "$extensions_home" && ! -L "$extensions_home" ]] \
  || fail 'managed Prime extensions directory must not be a symlink'
[[ ! -e "$managed_manifest" || ( -f "$managed_manifest" && ! -L "$managed_manifest" ) ]] \
  || fail 'managed Prime skill manifest must be a regular file'
[[ ! -e "$managed_extension_manifest" || ( -f "$managed_extension_manifest" && ! -L "$managed_extension_manifest" ) ]] \
  || fail 'managed Prime extension manifest must be a regular file'
[[ ! -e "$managed_append_manifest" || ( -f "$managed_append_manifest" && ! -L "$managed_append_manifest" ) ]] \
  || fail 'managed Prime instruction manifest must be a regular file'

declare -A prior_skills=()
if [[ -f "$managed_manifest" ]]; then
  while IFS= read -r skill_name; do
    [[ -n "$skill_name" ]] || continue
    [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -z "${prior_skills[$skill_name]+x}" ]] \
      || fail "managed Prime skill name is unsafe or duplicated: $skill_name"
    prior_skills["$skill_name"]=1
  done <"$managed_manifest"
fi

seed_manifest="$seed_root/managed-skills.txt"
[[ -f "$seed_manifest" && ! -L "$seed_manifest" ]] \
  || fail 'seeded Prime skill manifest must be a regular file'
declare -A desired_skills=()
while IFS= read -r skill_name; do
  [[ -n "$skill_name" ]] || continue
  [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -z "${desired_skills[$skill_name]+x}" ]] \
    || fail "seeded Prime skill name is unsafe or duplicated: $skill_name"
  source_skill="$seed_root/skills/$skill_name"
  [[ -d "$source_skill" && ! -L "$source_skill" ]] || fail "seeded Prime skill is missing or unsafe: $skill_name"
  [[ -z "$(find "$source_skill" -type l -print -quit)" ]] || fail "seeded Prime skill contains a symlink: $skill_name"
  desired_skills["$skill_name"]=1
done <"$seed_manifest"

for skill_name in "${!prior_skills[@]}"; do
  target_skill="$skills_home/$skill_name"
  if [[ -e "$target_skill" || -L "$target_skill" ]]; then
    [[ -d "$target_skill" && ! -L "$target_skill" ]] || fail "managed Prime skill destination is unsafe: $skill_name"
    rm -rf -- "$target_skill"
  fi
done
for skill_name in "${!desired_skills[@]}"; do
  target_skill="$skills_home/$skill_name"
  if [[ -e "$target_skill" || -L "$target_skill" ]]; then
    skill_tree_matches "$seed_root/skills/$skill_name" "$target_skill" \
      || fail "seeded Prime skill collides with unmanaged state: $skill_name"
    rm -rf -- "$target_skill"
  fi
  cp -R -- "$seed_root/skills/$skill_name" "$target_skill"
done
cp -- "$seed_manifest" "$managed_manifest"

declare -A prior_extensions=()
if [[ -f "$managed_extension_manifest" ]]; then
  while IFS= read -r extension_name; do
    [[ -n "$extension_name" ]] || continue
    [[ "$extension_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -z "${prior_extensions[$extension_name]+x}" ]] \
      || fail "managed Prime extension name is unsafe or duplicated: $extension_name"
    prior_extensions["$extension_name"]=1
  done <"$managed_extension_manifest"
fi

seed_extension_manifest="$seed_root/managed-extensions.txt"
[[ -f "$seed_extension_manifest" && ! -L "$seed_extension_manifest" ]] \
  || fail 'seeded Prime extension manifest must be a regular file'
declare -A desired_extensions=()
while IFS= read -r extension_name; do
  [[ -n "$extension_name" ]] || continue
  [[ "$extension_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -z "${desired_extensions[$extension_name]+x}" ]] \
    || fail "seeded Prime extension name is unsafe or duplicated: $extension_name"
  source_extension="$seed_root/extensions/${extension_name}.ts"
  [[ -f "$source_extension" && ! -L "$source_extension" ]] \
    || fail "seeded Prime extension is missing or unsafe: $extension_name"
  desired_extensions["$extension_name"]=1
done <"$seed_extension_manifest"

for extension_name in "${!prior_extensions[@]}"; do
  target_extension="$extensions_home/${extension_name}.ts"
  if [[ -e "$target_extension" || -L "$target_extension" ]]; then
    [[ -f "$target_extension" && ! -L "$target_extension" ]] \
      || fail "managed Prime extension destination is unsafe: $extension_name"
    rm -f -- "$target_extension"
  fi
done
for extension_name in "${!desired_extensions[@]}"; do
  target_extension="$extensions_home/${extension_name}.ts"
  source_extension="$seed_root/extensions/${extension_name}.ts"
  if [[ -e "$target_extension" || -L "$target_extension" ]]; then
    [[ -f "$target_extension" && ! -L "$target_extension" ]] \
      || fail "managed Prime extension destination is unsafe: $extension_name"
    cmp -s -- "$source_extension" "$target_extension" \
      || fail "seeded Prime extension collides with unmanaged state: $extension_name"
    rm -f -- "$target_extension"
  fi
  cp -- "$source_extension" "$target_extension"
done
cp -- "$seed_extension_manifest" "$managed_extension_manifest"

seed_append="$seed_root/APPEND_SYSTEM.md"
runtime_append="$runtime_home/APPEND_SYSTEM.md"
if [[ -e "$seed_append" || -L "$seed_append" ]]; then
  [[ -f "$seed_append" && ! -L "$seed_append" ]] || fail 'seeded Prime instructions must be a regular file'
  if [[ -e "$runtime_append" || -L "$runtime_append" ]]; then
    [[ -f "$runtime_append" && ! -L "$runtime_append" ]] \
      || fail 'managed Prime instructions collide with unmanaged state'
    if [[ ! -f "$managed_append_manifest" ]]; then
      cmp -s -- "$seed_append" "$runtime_append" \
        || fail 'managed Prime instructions collide with unmanaged state'
    fi
  fi
  append_temporary="$runtime_home/.APPEND_SYSTEM.md.trellage.$$"
  [[ ! -e "$append_temporary" && ! -L "$append_temporary" ]] || fail 'managed Prime instruction temporary already exists'
  cp -- "$seed_append" "$append_temporary"
  mv -f -- "$append_temporary" "$runtime_append"
  printf '%s\n' APPEND_SYSTEM.md >"$managed_append_manifest"
elif [[ -f "$managed_append_manifest" ]]; then
  [[ -f "$runtime_append" && ! -L "$runtime_append" ]] || fail 'managed Prime instructions are unsafe'
  rm -f -- "$runtime_append" "$managed_append_manifest"
fi

seed="$seed_root/models.json"
models="$runtime_home/models.json"
[[ -f "$seed" && ! -L "$seed" ]] || fail "missing baked Prime models seed: $seed"
[[ ! -L "$models" ]] || fail 'managed Prime models.json must not be a symlink'
if [[ -e "$models" && ! -f "$models" ]]; then
  fail 'managed Prime models.json must be a regular file'
fi

managed_temporary=
cleanup_temporary() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$managed_temporary" ]]; then
    rm -f -- "$managed_temporary"
  fi
  exit "$status"
}
trap cleanup_temporary EXIT HUP INT TERM
managed_temporary="$(mktemp "$runtime_home/.models.json.trellage.XXXXXX")" \
  || fail 'cannot create temporary Prime models config'
if [[ "$selected_model" == claude-opus-5 ]]; then
  cp -- "$seed" "$managed_temporary" || fail 'cannot copy baked Prime models config'
else
  jq --arg model "$selected_model" '
    .providers["copilot-proxy-rs"].models |=
      if any(.id == $model) then . else . + [{ id: $model }] end
  ' "$seed" >"$managed_temporary" || fail 'cannot materialize selected Prime model'
fi
chmod 0600 "$managed_temporary" || fail 'cannot secure temporary Prime models config'
[[ -d "$runtime_home" && ! -L "$runtime_home" \
  && "$(realpath -e -- "$runtime_home")" == "$runtime_home" ]] \
  || fail 'Prime config directory changed while staging models.json'
[[ ! -L "$models" ]] || fail 'managed Prime models.json became a symlink'
if [[ -e "$models" && ! -f "$models" ]]; then
  fail 'managed Prime models.json became a non-regular file'
fi
mv -f -- "$managed_temporary" "$models" || fail 'cannot replace managed Prime models config'
managed_temporary=
trap - EXIT HUP INT TERM

base_args=(
  --provider copilot-proxy-rs
  --model "$selected_model"
  --offline
)

# prime-agent has no end-of-options guard: its parser reads `--` as an unknown
# flag and then consumes the prompt behind it as that flag's value, so the
# prompt is silently discarded. The prompt must stay a bare positional.
case "$mode" in
  new)
    if [[ -n "$prompt" ]]; then
      exec prime-agent "${base_args[@]}" "${runtime_args[@]}" "$prompt"
    fi
    exec prime-agent "${base_args[@]}" "${runtime_args[@]}"
    ;;
  prompt)
    exec prime-agent "${base_args[@]}" "${runtime_args[@]}" -p "$prompt"
    ;;
  resume)
    if [[ -n "${TRELLAGE_RESUME_SESSION_ID:-}" ]]; then
      exec prime-agent "${base_args[@]}" "${runtime_args[@]}" -r "$TRELLAGE_RESUME_SESSION_ID"
    fi
    exec prime-agent "${base_args[@]}" "${runtime_args[@]}" -c
    ;;
esac
