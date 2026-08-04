#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(cd "$prototype_dir/../.." && pwd -P)"
entry="$prototype_dir/runtime-pi-entry.sh"
root="$repo_root/.agent_work/pi-entry-contract-$$"
fixture_source_ref='mcr.microsoft.com/devcontainers/javascript-node@sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af'
fixture_source_pulled=false

cleanup() {
  local status=$?
  if [[ "$fixture_source_pulled" == true ]]; then
    docker image rm "$fixture_source_ref" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$root"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'Pi entry contract: FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p \
  "$root/fake-bin" \
  "$root/home/.omp/agent/skills/stale-managed" \
  "$root/output" \
  "$root/pi-seed/skills/semantic-compression" \
  "$root/pi-seed/skills/system-prompts" \
  "$root/pi-seed/skills/tool-prompt-optimization"
printf 'stale-managed\n' >"$root/home/.omp/agent/.trellage-managed-skills"
printf 'stale\n' >"$root/home/.omp/agent/skills/stale-managed/SKILL.md"
printf '%s\n' semantic-compression system-prompts tool-prompt-optimization >"$root/pi-seed/managed-skills.txt"
for skill in semantic-compression system-prompts tool-prompt-optimization; do
  printf '%s\n' "---" "name: $skill" "description: $skill fixture" "---" >"$root/pi-seed/skills/$skill/SKILL.md"
done
chmod -R 777 "$root/home" "$root/output"

cat >"$root/fake-bin/omp" <<'FAKE_OMP'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$TRELLAGE_TEST_OUTPUT/argv"
printf 'COPILOT_GITHUB_TOKEN=%s\n' "${COPILOT_GITHUB_TOKEN-}" >"$TRELLAGE_TEST_OUTPUT/env"
printf 'GH_TOKEN=%s\n' "${GH_TOKEN-}" >>"$TRELLAGE_TEST_OUTPUT/env"
printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN-}" >>"$TRELLAGE_TEST_OUTPUT/env"
printf 'PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR-}" >>"$TRELLAGE_TEST_OUTPUT/env"
exit "${TRELLAGE_TEST_PI_EXIT:-0}"
FAKE_OMP
chmod 755 "$root/fake-bin/omp"

if ! docker image inspect "$fixture_source_ref" >/dev/null 2>&1; then
  docker image pull "$fixture_source_ref" >/dev/null
  fixture_source_pulled=true
fi

run_entry() {
  local status=0
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs '/tmp:rw,nosuid,nodev,size=16m' \
    --user '10001:10001' \
    --entrypoint /bin/bash \
    --mount "type=bind,src=$entry,dst=/test/runtime-pi-entry.sh,readonly" \
    --mount "type=bind,src=$root/fake-bin,dst=/test-bin,readonly" \
    --mount "type=bind,src=$root/home,dst=/home/agent" \
    --mount "type=bind,src=$root/output,dst=/test-output" \
    --mount "type=bind,src=$root/pi-seed,dst=/usr/local/share/trellage/pi-seed,readonly" \
    --env 'PATH=/test-bin:/usr/local/bin:/usr/bin:/bin' \
    --env 'TRELLAGE_TEST_OUTPUT=/test-output' \
    --env "COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN-}" \
    --env "GH_TOKEN=${GH_TOKEN-}" \
    --env "GITHUB_TOKEN=${GITHUB_TOKEN-}" \
    --env "TRELLAGE_TEST_PI_EXIT=${TRELLAGE_TEST_PI_EXIT-}" \
    "$fixture_source_ref" /test/runtime-pi-entry.sh "$@" || status=$?
  return "$status"
}

prompt='literal $(touch /tmp/not-executed) --resume prompt'
COPILOT_GITHUB_TOKEN='selected-token' GH_TOKEN='poison-gh' GITHUB_TOKEN='poison-github' \
  run_entry prompt --yolo -- "$prompt"
expected_prompt_argv=$'--provider\ngithub-copilot\n--model\ngpt-5.6-terra\n--config\n/usr/local/share/trellage/pi-config.yml\n--yolo\n--print\n--\nliteral $(touch /tmp/not-executed) --resume prompt'
[[ "$(cat "$root/output/argv")" == "$expected_prompt_argv" ]] \
  || fail 'prompt mode did not preserve literal prompt and fixed provider/model argv'
grep -Fqx 'COPILOT_GITHUB_TOKEN=selected-token' "$root/output/env" \
  || fail 'prompt mode did not preserve selected Copilot authentication'
grep -Fqx 'GH_TOKEN=' "$root/output/env" || fail 'prompt mode exposed ambient GH_TOKEN'
grep -Fqx 'GITHUB_TOKEN=' "$root/output/env" || fail 'prompt mode exposed ambient GITHUB_TOKEN'
grep -Fqx 'PI_CODING_AGENT_DIR=/home/agent/.omp/agent' "$root/output/env" \
  || fail 'prompt mode did not isolate persistent OMP state'
[[ -d "$root/home/.omp/agent" ]] || fail 'OMP state directory did not persist in the state mount'
[[ ! -e "$root/home/.omp/agent/skills/stale-managed" ]] \
  || fail 'stale managed OMP skill was not removed'
for skill in semantic-compression system-prompts tool-prompt-optimization; do
  [[ -f "$root/home/.omp/agent/skills/$skill/SKILL.md" ]] \
    || fail "managed OMP skill was not seeded: $skill"
done
[[ "$(cat "$root/home/.omp/agent/.trellage-managed-skills")" == \
  $'semantic-compression\nsystem-prompts\ntool-prompt-optimization' ]] \
  || fail 'managed OMP skill manifest was not refreshed'

COPILOT_GITHUB_TOKEN= GH_TOKEN= GITHUB_TOKEN= run_entry new --yolo
expected_new_argv=$'--provider\ngithub-copilot\n--model\ngpt-5.6-terra\n--config\n/usr/local/share/trellage/pi-config.yml\n--yolo'
[[ "$(cat "$root/output/argv")" == "$expected_new_argv" ]] \
  || fail 'interactive mode changed the fixed OMP launch argv'
grep -Fqx 'COPILOT_GITHUB_TOKEN=' "$root/output/env" \
  || fail 'interactive mode invented Copilot authentication'

run_entry resume --yolo
expected_resume_argv=$'--provider\ngithub-copilot\n--model\ngpt-5.6-terra\n--config\n/usr/local/share/trellage/pi-config.yml\n--yolo\n--continue'
[[ "$(cat "$root/output/argv")" == "$expected_resume_argv" ]] \
  || fail 'resume mode did not select OMP native worktree sessions'

status=0
TRELLAGE_TEST_PI_EXIT=29 run_entry prompt --yolo -- 'native status' || status=$?
[[ "$status" -eq 29 ]] || fail "prompt mode changed OMP status 29 to $status"

printf 'Pi entry contract: PASS\n'
