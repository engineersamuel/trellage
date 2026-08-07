#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: cleanup-orphaned-trellage-containers.sh [--apply]

Find Trellage Docker containers whose labeled Git worktree path no longer
exists. The default is a dry run. --apply stops idle orphan containers, removes
them, and removes their verified, unshared /home/agent state volumes.

Containers with active session processes or inconsistent ownership metadata
are reported and preserved.
EOF
}

apply=false
case "${1:-}" in
  '') ;;
  --apply) apply=true ;;
  -h|--help) usage; exit 0 ;;
  *) printf 'Trellage orphan cleanup: unsupported argument: %s\n' "$1" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { printf 'Trellage orphan cleanup: too many arguments\n' >&2; exit 2; }

docker="${TRELLAGE_DOCKER_BIN:-docker}"
for dependency in "$docker" jq; do
  command -v "$dependency" >/dev/null 2>&1 \
    || { printf 'Trellage orphan cleanup: required command not found: %s\n' "$dependency" >&2; exit 1; }
done

prototype_label='dev.trellage.prototype'
worktree_label='dev.trellage.worktree'
profile_label='dev.trellage.profile'
platform_label='dev.trellage.platform'
found=0
removed=0
skipped=0
failed=0

skip_candidate() {
  local name="$1" reason="$2"
  printf 'SKIP %s: %s\n' "$name" "$reason"
  skipped=$((skipped + 1))
}

inspect_identity() {
  jq -er '
    .[0]
    | [
        .Id,
        (.Name | ltrimstr("/")),
        .Config.Labels["dev.trellage.prototype"],
        .Config.Labels["dev.trellage.worktree"],
        .Config.Labels["dev.trellage.profile"],
        .Config.Labels["dev.trellage.platform"],
        (.State.Running | tostring),
        (.State.Pid | tostring)
      ]
    | if all(.[]; type == "string") then @tsv else error("invalid identity") end
  '
}

container_ids="$($docker container ls --all --filter "label=$prototype_label" --format '{{.ID}}')" 
while IFS= read -r listed_id; do
  [[ -n "$listed_id" ]] || continue
  inspect_json="$($docker container inspect "$listed_id" 2>/dev/null)" || {
    printf 'SKIP %s: container inspection failed\n' "$listed_id"
    skipped=$((skipped + 1))
    continue
  }
  identity="$(inspect_identity <<<"$inspect_json" 2>/dev/null)" || {
    printf 'SKIP %s: invalid Trellage identity labels\n' "$listed_id"
    skipped=$((skipped + 1))
    continue
  }
  IFS=$'\t' read -r container_id name prototype worktree profile platform running main_pid <<<"$identity"

  if [[ "$container_id" != "$listed_id"* || "$name" != trellage-* || "$prototype" != trellage-* ]]; then
    skip_candidate "$name" 'container ownership identity is invalid'
    continue
  fi
  if [[ -z "$profile" || ! "$platform" =~ ^linux/(arm64|amd64)$ ]]; then
    skip_candidate "$name" 'profile or platform ownership is invalid'
    continue
  fi
  if [[ "$worktree" != /* || "$worktree" == *$'\n'* || "$worktree" == *$'\t'* ]]; then
    skip_candidate "$name" 'worktree label is not a safe absolute path'
    continue
  fi
  if [[ -e "$worktree" || -L "$worktree" ]]; then
    continue
  fi
  worktree_parent="${worktree%/*}"
  if [[ ! -d "$worktree_parent" || ! -x "$worktree_parent" ]]; then
    skip_candidate "$name" 'worktree parent is unavailable; absence cannot be proven safely'
    continue
  fi
  found=$((found + 1))

  if ! jq -e --arg worktree "$worktree" '
    [.[0].Mounts[] | select(.Type == "bind" and .Source == $worktree and .RW == true)] | length == 1
  ' <<<"$inspect_json" >/dev/null; then
    skip_candidate "$name" 'worktree mount does not match ownership label'
    continue
  fi
  state_volume="$(jq -er '
    [.[0].Mounts[] | select(.Type == "volume" and .Destination == "/home/agent" and .RW == true)]
    | if length == 1 and .[0].Name != null and .[0].Name != "" then .[0].Name else error("invalid state volume") end
  ' <<<"$inspect_json" 2>/dev/null)" || {
    skip_candidate "$name" 'expected exactly one writable /home/agent volume'
    continue
  }

  volume_json="$($docker volume inspect "$state_volume" 2>/dev/null)" || {
    skip_candidate "$name" 'state volume inspection failed'
    continue
  }
  expected_volume_ownership="$prototype"$'\t'"$worktree"$'\t'"$profile"$'\t'"$platform"
  volume_ownership="$(jq -er '
    .[0].Labels
    | [
        .["dev.trellage.prototype"],
        .["dev.trellage.worktree"],
        .["dev.trellage.profile"],
        .["dev.trellage.platform"]
      ]
    | @tsv
  ' <<<"$volume_json" 2>/dev/null)" || volume_ownership=
  if [[ "$volume_ownership" != "$expected_volume_ownership" ]]; then
    skip_candidate "$name" 'state volume ownership mismatch'
    continue
  fi

  volume_users="$($docker container ls --all --filter "volume=$state_volume" --format '{{.ID}}')" || {
    skip_candidate "$name" 'cannot determine state volume users'
    continue
  }
  if [[ "$volume_users" != "$listed_id" ]]; then
    skip_candidate "$name" 'state volume is not exclusively attached to this container'
    continue
  fi
  if [[ "$running" == true ]]; then
    top_output="$($docker container top "$container_id" -eo pid,ppid,comm 2>/dev/null)" || {
      skip_candidate "$name" 'cannot inspect running processes'
      continue
    }
    if awk -v main_pid="$main_pid" 'NR > 1 && $1 != main_pid { found = 1 } END { exit(found ? 0 : 1) }' \
      <<<"$top_output"; then
      skip_candidate "$name" 'active session processes remain'
      continue
    fi
  elif [[ "$running" != false ]]; then
    skip_candidate "$name" 'container running state is invalid'
    continue
  fi

  if [[ "$apply" != true ]]; then
    printf 'WOULD REMOVE %s container=%s volume=%s worktree=%s\n' \
      "$name" "$container_id" "$state_volume" "$worktree"
    continue
  fi

  latest_json="$($docker container inspect "$container_id" 2>/dev/null)" || {
    skip_candidate "$name" 'container changed before removal'
    continue
  }
  latest_identity="$(inspect_identity <<<"$latest_json" 2>/dev/null)" || latest_identity=
  if [[ "$latest_identity" != "$identity" || -e "$worktree" || -L "$worktree" \
    || ! -d "$worktree_parent" || ! -x "$worktree_parent" ]]; then
    skip_candidate "$name" 'container or worktree changed before removal'
    continue
  fi
  latest_volume_ownership="$($docker volume inspect "$state_volume" 2>/dev/null \
    | jq -er '.[0].Labels | [.["dev.trellage.prototype"], .["dev.trellage.worktree"], .["dev.trellage.profile"], .["dev.trellage.platform"]] | @tsv' \
    2>/dev/null)" || latest_volume_ownership=
  latest_volume_users="$($docker container ls --all --filter "volume=$state_volume" --format '{{.ID}}' 2>/dev/null)" \
    || latest_volume_users=
  if [[ "$latest_volume_ownership" != "$expected_volume_ownership" || "$latest_volume_users" != "$listed_id" ]]; then
    skip_candidate "$name" 'state volume changed before removal'
    continue
  fi

  if [[ "$running" == true ]] && ! "$docker" container stop "$container_id" >/dev/null; then
    printf 'ERROR %s: container stop failed\n' "$name" >&2
    failed=$((failed + 1))
    continue
  fi
  if ! "$docker" container rm "$container_id" >/dev/null; then
    printf 'ERROR %s: container removal failed\n' "$name" >&2
    failed=$((failed + 1))
    continue
  fi
  if ! "$docker" volume rm "$state_volume" >/dev/null; then
    printf 'ERROR %s: container removed but state volume removal failed: %s\n' "$name" "$state_volume" >&2
    failed=$((failed + 1))
    continue
  fi
  printf 'REMOVED %s container=%s volume=%s worktree=%s\n' \
    "$name" "$container_id" "$state_volume" "$worktree"
  removed=$((removed + 1))
done <<<"$container_ids"

printf 'SUMMARY orphans=%d removed=%d skipped=%d failed=%d mode=%s\n' \
  "$found" "$removed" "$skipped" "$failed" "$([[ "$apply" == true ]] && printf apply || printf dry-run)"
(( failed == 0 ))
