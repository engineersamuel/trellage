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
skills_home="$runtime_home/skills"
mkdir -p "$skills_home"
[[ ! -L "$skills_home" ]] || fail 'managed Pi skills directory must not be a symlink'
if [[ -L "$managed_manifest" ]]; then
  fail 'managed Pi skill manifest must not be a symlink'
fi
if [[ -f "$managed_manifest" ]]; then
  while IFS= read -r skill_name; do
    [[ -z "$skill_name" ]] && continue
    [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
      || fail "managed Pi skill name is unsafe: $skill_name"
    rm -rf -- "$skills_home/$skill_name"
  done <"$managed_manifest"
fi
if [[ -f "$seed_root/managed-skills.txt" ]]; then
  while IFS= read -r skill_name; do
    [[ -z "$skill_name" ]] && continue
    [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
      || fail "seeded Pi skill name is unsafe: $skill_name"
    [[ -d "$seed_root/skills/$skill_name" ]] \
      || fail "seeded Pi skill is missing: $skill_name"
    rm -rf -- "$skills_home/$skill_name"
    cp -R -- "$seed_root/skills/$skill_name" "$skills_home/$skill_name"
  done <"$seed_root/managed-skills.txt"
  cp "$seed_root/managed-skills.txt" "$managed_manifest"
else
  : >"$managed_manifest"
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
