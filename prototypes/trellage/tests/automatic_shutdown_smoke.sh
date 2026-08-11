#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$prototype_dir/../.." && pwd)"
image_ref="${IMAGE_REF:?IMAGE_REF is required}"
smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-lifecycle-smoke-XXXXXX")"
smoke_root="$(cd "$smoke_root" && pwd -P)"
container_id=
container_name=
volume_name=

fail() {
  printf 'trellage lifecycle smoke: FAIL: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$? ownership
  trap - EXIT
  if [[ -n "$container_id" ]]; then
    ownership="$(docker container inspect --format \
      '{{ printf "%s\t%s\t%s" (index .Config.Labels "dev.trellage.prototype") (index .Config.Labels "dev.trellage.worktree") (index .Config.Labels "dev.trellage.profile") }}' \
      "$container_id" 2>/dev/null || true)"
    if [[ "$ownership" == $'trellage-copilot\t'"$smoke_root"$'\tlifecycle-smoke' ]]; then
      docker container rm --force "$container_id" >/dev/null || status=1
    else
      printf 'trellage lifecycle smoke: refusing unowned container cleanup: %s\n' "$container_id" >&2
      status=1
    fi
  fi
  if [[ -n "$volume_name" ]] && docker volume inspect "$volume_name" >/dev/null 2>&1; then
    ownership="$(docker volume inspect --format \
      '{{ printf "%s\t%s\t%s" (index .Labels "dev.trellage.prototype") (index .Labels "dev.trellage.worktree") (index .Labels "dev.trellage.profile") }}' \
      "$volume_name" 2>/dev/null || true)"
    if [[ "$ownership" == $'trellage-copilot\t'"$smoke_root"$'\tlifecycle-smoke' ]]; then
      docker volume rm "$volume_name" >/dev/null || status=1
    else
      printf 'trellage lifecycle smoke: refusing unowned volume cleanup: %s\n' "$volume_name" >&2
      status=1
    fi
  fi
  rm -rf -- "$smoke_root"
  exit "$status"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v expect >/dev/null 2>&1 || fail 'expect is required'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
docker image inspect "$image_ref" >/dev/null 2>&1 || fail "image is unavailable: $image_ref"

git init --quiet "$smoke_root"
profile="$smoke_root/profile.toml"
metadata="$smoke_root/metadata.json"
fake_bin="$smoke_root/fake-bin"
node_log="$smoke_root/node.log"
runtime_dir="$smoke_root/runtime"
mkdir -p "$fake_bin" "$runtime_dir"
: >"$profile"
: >"$node_log"

profile_hash="$(docker image inspect --format \
  '{{ index .Config.Labels "dev.trellage.profile.hash" }}' "$image_ref")"
runtime_hash="$(docker image inspect --format \
  '{{ index .Config.Labels "dev.trellage.runtime.hash" }}' "$image_ref")"
platform="$(docker image inspect --format \
  '{{ index .Config.Labels "dev.trellage.platform" }}' "$image_ref")"
base_metadata="$(node "$repo_root/packages/trellage-cli/dist/cli.js" metadata \
  "$repo_root/profiles/codex-superpowers/profile.toml")"
jq \
  --arg profile "$profile" \
  --arg image "$image_ref" \
  --arg profile_hash "$profile_hash" \
  --arg runtime_hash "$runtime_hash" \
  --arg platform "$platform" '
    .profile_path = $profile
    | .profile_name = "lifecycle-smoke"
    | .profile_hash = $profile_hash
    | .runtime_hash = $runtime_hash
    | .platform = $platform
    | .image = $image
    | .locked = true
    | .harness_kind = "copilot"
    | .harness_executable = "bash"
    | .runtime_entry = "trellage-codex-entry"
    | .default_network = "bridge"
    | .auth_policy = "host-or-login"
    | .secrets_provider = "env"
    | .required_secrets = []
    | .secret_environment = {}
    | .resolved_varlock_path = null
    | .has_initial_prompt = false
    | .harness_args = [
        "bash", "-ceu",
        "if test -f /home/agent/lifecycle-smoke-marker; then printf '\''STATE:reused\\n'\''; else printf '\''STATE:new\\n'\''; : >/home/agent/lifecycle-smoke-marker; fi; printf '\''READY\\n'\''; IFS= read -r reply; test \"$reply\" = exit"
      ]
  ' <<<"$base_metadata" >"$metadata"

ln -s "$prototype_dir/tests/fakes/host-node" "$fake_bin/node"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"$fake_bin/gh"
chmod +x "$fake_bin/gh"
printf 'FAKE_NODE_LOG=%q\nFAKE_PROFILE_METADATA=%q\nFAKE_REAL_NODE=%q\n' \
  "$node_log" "$metadata" "$(command -v node)" >"$fake_bin/.trellage-fixture-env"

run_disposable_harness() {
  local expected_state="$1" transcript
  transcript="$smoke_root/$expected_state.transcript"
  TEST_PATH="$fake_bin:$PATH" TEST_ROOT="$smoke_root" TEST_PROFILE="$profile" \
    TEST_METADATA="$metadata" TEST_NODE_LOG="$node_log" TEST_RUNTIME="$runtime_dir" \
    TEST_LAUNCHER="$prototype_dir/trellage" TEST_EXPECTED="$expected_state" \
    TEST_TRANSCRIPT="$transcript" TEST_REAL_NODE="$(command -v node)" expect <<'EXPECT'
set timeout 30
log_user 0
log_file -noappend $env(TEST_TRANSCRIPT)
cd $env(TEST_ROOT)
spawn -noecho env \
  PATH=$env(TEST_PATH) \
  TRELLAGE_ENVIRONMENT=off \
  XDG_RUNTIME_DIR=$env(TEST_RUNTIME) \
  FAKE_PROFILE_METADATA=$env(TEST_METADATA) \
  FAKE_NODE_LOG=$env(TEST_NODE_LOG) \
  FAKE_REAL_NODE=$env(TEST_REAL_NODE) \
  $env(TEST_LAUNCHER) --profile $env(TEST_PROFILE)
expect "STATE:$env(TEST_EXPECTED)"
expect "READY"
send -- "exit\r"
expect eof
set result [wait]
set status [lindex $result 3]
if {$status != 0} { exit $status }
EXPECT
}

run_disposable_harness new
container_name="$(docker container ls --all \
  --filter "label=dev.trellage.worktree=$smoke_root" \
  --filter 'label=dev.trellage.profile=lifecycle-smoke' \
  --format '{{.Names}}')"
[[ -n "$container_name" ]] || fail 'launcher did not retain its container'
container_id="$(docker container inspect --format '{{.Id}}' "$container_name")"
volume_name="$(docker container inspect --format \
  '{{ range .Mounts }}{{ if eq .Destination "/home/agent" }}{{ .Name }}{{ end }}{{ end }}' \
  "$container_id")"
[[ -n "$volume_name" ]] || fail 'launcher did not retain its state volume'
[[ "$(docker container inspect --format '{{.State.Running}}' "$container_id")" == false ]] \
  || fail 'container remained running after disposable harness exit'

run_disposable_harness reused
[[ "$(docker container inspect --format '{{.Id}}' "$container_name")" == "$container_id" ]] \
  || fail 'relaunch replaced the retained container'
[[ "$(docker container inspect --format '{{.State.Running}}' "$container_id")" == false ]] \
  || fail 'container remained running after relaunch exit'
printf 'trellage lifecycle smoke: PASS: stopped container relaunched with durable state\n'
