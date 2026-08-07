#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
script="$repo_root/scripts/cleanup-orphaned-trellage-containers.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-orphan-cleanup-test.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'Trellage orphan cleanup contract: FAIL: %s\n' "$1" >&2
  exit 1
}

fake_bin="$test_root/bin"
log="$test_root/docker.log"
existing_worktree="$test_root/existing-worktree"
mkdir -p "$fake_bin" "$existing_worktree"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'CALL' >>"$FAKE_DOCKER_LOG"
printf '\t%s' "$@" >>"$FAKE_DOCKER_LOG"
printf '\n' >>"$FAKE_DOCKER_LOG"

container_json() {
  local id="$1" name worktree running pid volume prototype profile platform
  prototype=trellage-copilot
  profile=copilot-hve
  platform=linux/arm64
  running=true
  pid=101
  case "$id" in
    keep-id) name=trellage-keep; worktree="$FAKE_EXISTING_WORKTREE"; volume=keep-volume ;;
    orphan-id) name=trellage-orphan; worktree="$FAKE_ROOT/deleted-orphan"; volume=orphan-volume ;;
    busy-id) name=trellage-busy; worktree="$FAKE_ROOT/deleted-busy"; volume=busy-volume ;;
    stopped-id) name=trellage-stopped; worktree="$FAKE_ROOT/deleted-stopped"; volume=stopped-volume; running=false; pid=0 ;;
    unsafe-id) name=trellage-unsafe; worktree="$FAKE_ROOT/deleted-unsafe"; volume=unsafe-volume ;;
    *) exit 44 ;;
  esac
  jq -cn \
    --arg id "$id" --arg name "/$name" --arg prototype "$prototype" \
    --arg worktree "$worktree" --arg profile "$profile" --arg platform "$platform" \
    --arg volume "$volume" --argjson running "$running" --argjson pid "$pid" \
    '[{Id:$id,Name:$name,Config:{Labels:{
      "dev.trellage.prototype":$prototype,
      "dev.trellage.worktree":$worktree,
      "dev.trellage.profile":$profile,
      "dev.trellage.platform":$platform
    }},State:{Running:$running,Pid:$pid},Mounts:[
      {Type:"bind",Source:$worktree,Destination:"/mounts/worktree",RW:true},
      {Type:"volume",Name:$volume,Source:("/volumes/"+$volume),Destination:"/home/agent",RW:true}
    ]}]'
}

case "${1:-} ${2:-}" in
  'container ls')
    volume=
    while (( $# > 0 )); do
      if [[ "$1" == --filter && "${2:-}" == volume=* ]]; then volume="${2#volume=}"; break; fi
      shift
    done
    if [[ -n "$volume" ]]; then
      case "$volume" in
        keep-volume) printf 'keep-id\n' ;;
        orphan-volume) printf 'orphan-id\n' ;;
        busy-volume) printf 'busy-id\n' ;;
        stopped-volume) printf 'stopped-id\n' ;;
        unsafe-volume) printf 'unsafe-id\n' ;;
      esac
    else
      printf '%s\n' keep-id orphan-id busy-id stopped-id unsafe-id
    fi
    ;;
  'container inspect') container_json "${3:-}" ;;
  'container top')
    printf 'PID PPID COMMAND\n'
    printf '101 0 sleep\n'
    [[ "${3:-}" != busy-id ]] || printf '202 101 copilot\n'
    ;;
  'container stop'|'container rm'|'volume rm') ;;
  'volume inspect')
    volume="${3:-}"
    case "$volume" in
      keep-volume) worktree="$FAKE_EXISTING_WORKTREE" ;;
      orphan-volume) worktree="$FAKE_ROOT/deleted-orphan" ;;
      busy-volume) worktree="$FAKE_ROOT/deleted-busy" ;;
      stopped-volume) worktree="$FAKE_ROOT/deleted-stopped" ;;
      unsafe-volume) worktree="$FAKE_ROOT/different-worktree" ;;
      *) exit 45 ;;
    esac
    jq -cn --arg name "$volume" --arg worktree "$worktree" '[{Name:$name,Labels:{
      "dev.trellage.prototype":"trellage-copilot",
      "dev.trellage.worktree":$worktree,
      "dev.trellage.profile":"copilot-hve",
      "dev.trellage.platform":"linux/arm64"
    }}]'
    ;;
  *) exit 46 ;;
esac
EOF
chmod +x "$fake_bin/docker"

run_cleanup_task() {
  local task="$1"
  (
    cd "$repo_root"
    PATH="$fake_bin:$PATH" \
      FAKE_DOCKER_LOG="$log" \
      FAKE_EXISTING_WORKTREE="$existing_worktree" \
      FAKE_ROOT="$test_root" \
      mise run "$task"
  )
}

: >"$log"
dry_output="$(run_cleanup_task trellage-clean-orphans)"
grep -Fq "WOULD REMOVE trellage-orphan" <<<"$dry_output" || fail 'dry-run missed running orphan'
grep -Fq "WOULD REMOVE trellage-stopped" <<<"$dry_output" || fail 'dry-run missed stopped orphan'
grep -Fq "SKIP trellage-busy: active session processes remain" <<<"$dry_output" || fail 'dry-run did not preserve busy orphan'
grep -Fq "SKIP trellage-unsafe: state volume ownership mismatch" <<<"$dry_output" || fail 'dry-run did not reject mismatched volume'
if grep -Eq $'CALL\t(container\t(stop|rm)|volume\trm)' "$log"; then
  fail 'dry-run mutated Docker resources'
fi

: >"$log"
apply_output="$(run_cleanup_task trellage-clean-orphans-apply)"
grep -Fq "REMOVED trellage-orphan" <<<"$apply_output" || fail 'apply missed running orphan'
grep -Fq "REMOVED trellage-stopped" <<<"$apply_output" || fail 'apply missed stopped orphan'
grep -Fq "SKIP trellage-busy: active session processes remain" <<<"$apply_output" || fail 'apply did not preserve busy orphan'
grep -Fqx $'CALL\tcontainer\tstop\torphan-id' "$log" || fail 'running orphan was not stopped'
grep -Fqx $'CALL\tcontainer\trm\torphan-id' "$log" || fail 'running orphan container was not removed'
grep -Fqx $'CALL\tvolume\trm\torphan-volume' "$log" || fail 'running orphan volume was not removed'
grep -Fqx $'CALL\tcontainer\trm\tstopped-id' "$log" || fail 'stopped orphan container was not removed'
grep -Fqx $'CALL\tvolume\trm\tstopped-volume' "$log" || fail 'stopped orphan volume was not removed'
if grep -Eq $'CALL\t(container\t(stop|rm)\t(busy|unsafe)-id|volume\trm\t(busy|unsafe)-volume)' "$log"; then
  fail 'apply mutated busy or unsafe resources'
fi

printf 'Trellage orphan cleanup contract: PASS\n'
