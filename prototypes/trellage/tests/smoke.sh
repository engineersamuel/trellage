#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tests_dir="$prototype_dir/tests"
image_ref="${IMAGE_REF:-trellage-profile-codex-superpowers-linux-arm64:locked}"
network='copilot-proxy-rs_default'
prototype_label='dev.trellage.prototype'
worktree_label='dev.trellage.worktree'
smoke_root=
container_name=
container_id=
volume_name=
volume_created=0
mount_path=
copilot_root=
copilot_container_name=
copilot_container_id=
copilot_volume_name=
copilot_login_container_name=
copilot_login_container_id=
copilot_login_volume_name=
copilot_login_attach_pid=
copilot_profile=
copilot_smoke_token=
copilot_verified_session=

fail() {
  printf 'trellage smoke: FAIL: %s\n' "$1" >&2
  exit 1
}

check_host_commands() {
  local command_name
  for command_name in awk bash basename cat docker find git jq mise mktemp readlink rm sed sort tr; do
    command -v "$command_name" >/dev/null 2>&1 \
      || fail "missing host command: $command_name"
  done
  docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
  docker network inspect "$network" >/dev/null 2>&1 \
    || fail "required proxy network is unavailable: $network"
}

initialize_smoke() {
  local git_root safe_name
  smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-codex-smoke-XXXXXX")"
  smoke_root="$(cd "$smoke_root" && pwd -P)"
  safe_name="$(basename "$smoke_root")"
  [[ "$safe_name" == trellage-codex-smoke-* ]] \
    || fail "unsafe smoke directory name: $safe_name"
  [[ "$safe_name" =~ ^[A-Za-z0-9._-]+$ ]] \
    || fail "smoke directory is not a safe mount segment: $safe_name"
  container_name="${safe_name}-container"
  volume_name="${safe_name}-state"
  mount_path="/mounts/$safe_name"
  printf '%s\n' "$smoke_root" >"$smoke_root/.trellage-codex-smoke-owner"
  git init --quiet "$smoke_root"
  git_root="$(git -C "$smoke_root" rev-parse --show-toplevel)"
  git_root="$(cd "$git_root" && pwd -P)"
  [[ "$git_root" == "$smoke_root" ]] || fail "smoke Git root does not match its bind directory: $git_root"
}

validate_container_ownership() {
  local actual expected
  [[ -n "$container_id" ]] || return 1
  actual="$(docker container inspect --format \
    '{{ printf "%s\t%s\t%s" .Id (index .Config.Labels "dev.trellage.prototype") (index .Config.Labels "dev.trellage.worktree") }}' \
    "$container_id" 2>/dev/null)" || return 1
  expected="$container_id"$'\ttrellage-codex\t'"$smoke_root"
  [[ "$actual" == "$expected" ]]
}

remove_smoke_container() {
  [[ -n "$container_id" ]] || return 1
  validate_container_ownership || return 1
  docker container rm --force "$container_id" >/dev/null || return 1
  container_id=
}

validate_volume_ownership() {
  local actual expected
  actual="$(docker volume inspect --format \
    '{{ printf "%s\t%s" (index .Labels "dev.trellage.prototype") (index .Labels "dev.trellage.worktree") }}' \
    "$volume_name" 2>/dev/null)" || return 1
  expected=$'trellage-codex\t'"$smoke_root"
  [[ "$actual" == "$expected" ]]
}

remove_smoke_volume() {
  [[ "$volume_created" -eq 1 ]] || return 1
  validate_volume_ownership || return 1
  docker volume rm "$volume_name" >/dev/null || return 1
  volume_created=0
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT

  [[ "$container_name" == trellage-codex-smoke-* ]] || return 1
  [[ "$volume_name" == trellage-codex-smoke-* ]] || return 1
  [[ "$(basename "$smoke_root")" == trellage-codex-smoke-* ]] || return 1

  if [[ -n "$container_id" ]]; then
    if ! remove_smoke_container; then
      printf 'trellage smoke: refusing container cleanup without preserved ownership: %s\n' \
        "$container_id" >&2
      cleanup_status=1
    fi
  fi

  if [[ "$volume_created" -eq 1 ]]; then
    if ! remove_smoke_volume; then
      printf 'trellage smoke: refusing unowned volume cleanup: %s\n' \
        "$volume_name" >&2
      cleanup_status=1
    fi
  fi

  if [[ -d "$smoke_root" ]]; then
    if [[ -f "$smoke_root/.trellage-codex-smoke-owner" ]] \
      && [[ "$(cat "$smoke_root/.trellage-codex-smoke-owner")" == "$smoke_root" ]]; then
      rm -rf -- "$smoke_root" || cleanup_status=1
    else
      printf 'trellage smoke: refusing unowned directory cleanup: %s\n' \
        "$smoke_root" >&2
      cleanup_status=1
    fi
  fi

  if [[ "$original_status" -ne 0 ]]; then
    return "$original_status"
  fi
  return "$cleanup_status"
}

check_shell_syntax() {
  local source
  local syntax_sources=(
    "$prototype_dir"/*.sh
    "$prototype_dir/trellage"
    "$tests_dir"/*.sh
    "$tests_dir"/fakes/*
  )
  for source in "${syntax_sources[@]}"; do
    [[ -f "$source" ]] || fail "missing shell source: $source"
    bash -n "$source"
  done
  printf 'trellage smoke: PASS: shell syntax\n'
}

run_static_contracts() {
  local contract
  local static_contracts=(
    copilot_transcript_contract.sh
    host_command_contract.sh
    image_contract.sh
    installer_contract.sh
    readme_contract.sh
    resource_cleanup_behavior_contract.sh
  )
  for contract in "${static_contracts[@]}"; do
    (
      unset IMAGE_REF
      export STATIC_ONLY=1
      "$tests_dir/$contract"
    )
  done
}

build_image() {
  (
    cd "$prototype_dir"
    IMAGE_REF="$image_ref" ./build-image.sh
  )
}

run_live_contracts() {
  IMAGE_REF="$image_ref" "$tests_dir/image_contract.sh"
  IMAGE_REF="$image_ref" "$tests_dir/runtime_startup_contract.sh"
}

run_session_contracts() {
  "$tests_dir/runtime_session_contract.sh"
  IMAGE_REF="$image_ref" "$tests_dir/runtime_persistence_contract.sh"
}

create_smoke_container() {
  local created_container
  [[ -z "$container_id" ]] \
    || fail "refusing to replace a preserved smoke container ID: $container_id"
  created_container="$(docker container create \
    --name "$container_name" \
    --label "$prototype_label=trellage-codex" \
    --label "$worktree_label=$smoke_root" \
    --user '10001:10001' \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 256 \
    --memory 2g \
    --cpus 2 \
    --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001' \
    --mount "type=bind,src=$smoke_root,dst=$mount_path" \
    --mount "type=volume,src=$volume_name,dst=/home/agent" \
    --network "$network" \
    --workdir "$mount_path" \
    "$image_ref" sleep infinity)" \
    || fail 'Docker failed to create the smoke container'
  [[ -n "$created_container" ]] || fail 'Docker returned an empty smoke container ID'
  container_id="$created_container"
  validate_container_ownership \
    || fail "smoke container ownership labels are invalid: $container_name"
  docker container start "$container_id" >/dev/null
}

validate_container_contract() {
  local inspect_json
  [[ -n "$container_id" ]] || fail 'smoke container ID is unavailable for inspection'
  inspect_json="$(docker container inspect "$container_id")" \
    || fail "cannot inspect smoke container ID: $container_id"
  jq -e \
    --arg id "$container_id" \
    --arg source "$smoke_root" \
    --arg destination "$mount_path" \
    --arg volume "$volume_name" \
    --arg network "$network" '
      .[0].Id == $id
      and .[0].Config.User == "10001:10001"
      and .[0].Config.WorkingDir == $destination
      and .[0].HostConfig.ReadonlyRootfs == true
      and .[0].HostConfig.CapDrop == ["ALL"]
      and (.[0].HostConfig.SecurityOpt | length == 1)
      and (.[0].HostConfig.SecurityOpt[0] == "no-new-privileges"
        or .[0].HostConfig.SecurityOpt[0] == "no-new-privileges:true")
      and .[0].HostConfig.PidsLimit == 256
      and .[0].HostConfig.Memory == 2147483648
      and .[0].HostConfig.NanoCpus == 2000000000
      and .[0].HostConfig.NetworkMode == $network
      and (.[0].HostConfig.Tmpfs["/tmp"] | split(",") as $options
        | ($options | length == 7)
        and ($options | index("rw") != null)
        and ($options | index("noexec") != null)
        and ($options | index("nosuid") != null)
        and ($options | index("nodev") != null)
        and ($options | index("uid=10001") != null)
        and ($options | index("gid=10001") != null)
        and ([$options[] | select(startswith("size="))] | length == 1))
      and (.[0].Mounts | length == 2)
      and ([.[0].Mounts[]
        | select(.Type == "bind"
          and .Source == $source
          and .Destination == $destination
          and .RW == true)] | length == 1)
      and ([.[0].Mounts[]
        | select(.Type == "volume"
          and .Name == $volume
          and .Destination == "/home/agent"
          and .RW == true)] | length == 1)
    ' <<<"$inspect_json" >/dev/null \
    || fail 'smoke container violates mounts or launcher security restrictions'
}

probe_bind_and_state() {
  printf 'host-visible\n' >"$smoke_root/host-visible"
  docker container exec "$container_id" bash -ceu '
    test "$(cat "$1/host-visible")" = host-visible
    printf "container-visible\n" >"$1/container-visible"
  ' -- "$mount_path"
  [[ "$(cat "$smoke_root/container-visible")" == 'container-visible' ]] \
    || fail 'container-to-host bind visibility failed'

  docker container exec "$container_id" trellage-codex-entry passthrough bash -ceu '
    printf "state-survives\n" >"$CODEX_HOME/smoke-state"
  '
  validate_container_ownership \
    || fail 'smoke container ownership changed before recreation'
  remove_smoke_container \
    || fail 'smoke container could not be safely removed for recreation'
  create_smoke_container
  validate_container_contract
  docker container exec "$container_id" bash -ceu '
    test "$(cat "$CODEX_HOME/smoke-state")" = state-survives
  '
}

probe_runtime_inventory() {
  docker container exec "$container_id" bash -ceu '
    fish -Nlc "exit 0"
    bash -lc ":"
    zsh -lc ":"
    test "$(codex --version 2>/dev/null)" = "codex-cli 0.144.6"
    expected_skills="brainstorming
dispatching-parallel-agents
executing-plans
finishing-a-development-branch
receiving-code-review
requesting-code-review
subagent-driven-development
systematic-debugging
test-driven-development
using-git-worktrees
using-superpowers
verification-before-completion
writing-plans
writing-skills"
    actual_skills="$(find "$CODEX_HOME/skills" -mindepth 1 -maxdepth 1 -type d \
      ! -name full-stack-orchestration__full-stack-feature -printf "%f\n" | sort)"
    test "$actual_skills" = "$expected_skills"
    test -f "$CODEX_HOME/skills/full-stack-orchestration__full-stack-feature/SKILL.md"
    expected_agents="full-stack-orchestration__deployment-engineer.toml
full-stack-orchestration__performance-engineer.toml
full-stack-orchestration__security-auditor.toml
full-stack-orchestration__test-automator.toml"
    actual_agents="$(find "$CODEX_HOME/agents" -mindepth 1 -maxdepth 1 -type f \
      -printf "%f\n" | sort)"
    test "$actual_agents" = "$expected_agents"
  ' || fail 'runtime shell, Codex, skill, or plugin inventory probe failed'
}

probe_proxy() {
  local model_count
  model_count="$(docker container exec "$container_id" bash -ceu '
    curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
      http://copilot-proxy-rs:8080/health >/tmp/proxy-health
    curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
      http://copilot-proxy-rs:8080/v1/models >/tmp/proxy-models.json
    jq -e '\''type == "object"
      and (.data | type == "array")
      and (.data | length > 0)'\'' /tmp/proxy-models.json >/dev/null
    jq -r '\''.data | length'\'' /tmp/proxy-models.json
  ')" || fail 'proxy health or nonempty models probe failed'
  [[ "$model_count" =~ ^[1-9][0-9]*$ ]] \
    || fail "proxy returned an invalid model count: $model_count"
  printf 'trellage smoke: PASS: proxy returned %s models\n' "$model_count"
}

probe_recovery_fish() {
  local output_file="$smoke_root/recovery.out"
  local error_file="$smoke_root/recovery.err"
  local recovery_status line warning_count=0
  set +e
  docker container exec --workdir "$mount_path" "$container_id" \
    fish -Nlc 'exec fish -l -c "printf recovery-fish-ok\\n"' \
    >"$output_file" 2>"$error_file"
  recovery_status=$?
  set -e
  [[ "$recovery_status" -eq 0 ]] \
    || fail "recovery Fish exited $recovery_status: $(cat "$error_file")"
  [[ "$(tr -d '\r' <"$output_file")" == 'recovery-fish-ok' ]] \
    || fail "recovery Fish returned unexpected output: $(cat "$output_file")"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" ]] && continue
    case "$line" in
      '/tmp/fish'|'error: Runtime path not available. Try deleting the directory /tmp/fish.')
        warning_count=$((warning_count + 1))
        ;;
      *) fail "recovery Fish emitted an unknown warning: $line" ;;
    esac
  done <"$error_file"
  if [[ "$warning_count" -gt 0 ]]; then
    printf 'trellage smoke: accepted known recovery Fish /tmp/fish warning\n'
  fi
  docker container exec "$container_id" bash -ceu 'test ! -e "$CODEX_HOME/sessions"' \
    || fail 'recovery Fish started Codex or created native session state'
  docker container top "$container_id" -eo pid,comm \
    | awk 'NR > 1 && $2 == "codex" { found = 1 } END { exit(found ? 1 : 0) }' \
    || fail 'Codex remained active after recovery Fish probe'
}

run_live_container_probe() {
  local created_volume
  docker image inspect "$image_ref" >/dev/null 2>&1 \
    || fail "fresh image is unavailable: $image_ref"
  created_volume="$(docker volume create \
    --label "$prototype_label=trellage-codex" \
    --label "$worktree_label=$smoke_root" \
    "$volume_name")"
  [[ "$created_volume" == "$volume_name" ]] \
    || fail "Docker created an unexpected smoke volume: $created_volume"
  volume_created=1
  validate_volume_ownership \
    || fail "smoke volume ownership labels are invalid: $volume_name"
  create_smoke_container
  validate_container_contract
  probe_bind_and_state
  probe_runtime_inventory
  probe_proxy
  probe_recovery_fish
  printf 'trellage smoke: PASS: live restricted container probe\n'
}

run_installer_probe() {
  local install_dir="$smoke_root/install/bin"
  local installed="$install_dir/trellage"
  local dry_run_output
  TRELLAGE_INSTALL_DIR="$install_dir" "$prototype_dir/install-trellage.sh" install
  [[ -L "$installed" ]] || fail 'installer probe did not create the harness link'
  [[ "$(readlink "$installed")" == "$prototype_dir/trellage" ]] \
    || fail 'installer probe created an unowned harness link'
  dry_run_output="$(TRELLAGE_INSTALL_DIR="$install_dir" \
    "$prototype_dir/install-trellage.sh" uninstall --dry-run)"
  [[ "$dry_run_output" == "trellage installer: would remove $installed" ]] \
    || fail "uninstall dry-run returned unexpected output: $dry_run_output"
  [[ -L "$installed" ]] || fail 'uninstall dry-run removed the harness link'
  [[ "$(readlink "$installed")" == "$prototype_dir/trellage" ]] \
    || fail 'uninstall dry-run changed the harness link'
  TRELLAGE_INSTALL_DIR="$install_dir" "$prototype_dir/install-trellage.sh" uninstall
  [[ ! -e "$installed" && ! -L "$installed" ]] \
    || fail 'uninstall probe left the harness link installed'
  printf 'trellage smoke: PASS: installer dry-run and uninstall\n'
}

copilot_resource_names() {
  local path_hash resource_segment
  resource_segment="$(basename "$copilot_root" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_.-]+/-/g; s/^[^a-z0-9]+//; s/[^a-z0-9]+$//')"
  if command -v sha256sum >/dev/null 2>&1; then
    path_hash="$(printf '%s' "$copilot_root" | sha256sum | awk '{print $1}')"
  else
    path_hash="$(printf '%s' "$copilot_root" | shasum -a 256 | awk '{print $1}')"
  fi
  copilot_container_name="trellage-copilot-copilot-hve-${resource_segment}-${path_hash:0:16}"
  copilot_volume_name="trellage-copilot-state-copilot-hve-${resource_segment}-${path_hash:0:16}"
  copilot_login_container_name="trellage-copilot-smoke-login-${path_hash:0:16}"
  copilot_login_volume_name="trellage-copilot-smoke-login-state-${path_hash:0:16}"
}

validate_copilot_container() {
  local id="$1"
  local name="$2"
  local expected_owner="$3"
  local actual
  actual="$(docker container inspect --format \
    '{{ printf "%s\t%s\t%s\t%s" .Id (index .Config.Labels "dev.trellage.prototype") (index .Config.Labels "dev.trellage.worktree") (index .Config.Labels "dev.trellage.profile") }}' \
    "$id" 2>/dev/null)" || return 1
  [[ "$actual" == "$id"$'\t'"$expected_owner"$'\t'"$copilot_root"$'\t'copilot-hve ]] \
    && [[ "$(docker container inspect --format '{{.Name}}' "$id")" == "/$name" ]]
}

validate_copilot_volume() {
  local name="$1"
  local expected_owner="$2"
  local actual
  actual="$(docker volume inspect --format \
    '{{ printf "%s\t%s\t%s" (index .Labels "dev.trellage.prototype") (index .Labels "dev.trellage.worktree") (index .Labels "dev.trellage.profile") }}' \
    "$name" 2>/dev/null)" || return 1
  [[ "$actual" == "$expected_owner"$'\t'"$copilot_root"$'\t'copilot-hve ]]
}

stop_copilot_login_attach() {
  local term_seconds="${1:-5}"
  local kill_seconds="${2:-2}"
  local deadline pid="$copilot_login_attach_pid"
  [[ -n "$pid" ]] || return 0
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$term_seconds" =~ ^[1-9][0-9]*$ \
    && "$kill_seconds" =~ ^[1-9][0-9]*$ ]] || return 1

  deadline=$((SECONDS + term_seconds))
  while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    deadline=$((SECONDS + kill_seconds))
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
      sleep 0.1
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
  copilot_login_attach_pid=
  ! kill -0 "$pid" 2>/dev/null
}

cleanup_copilot_smoke() {
  local original_status=$?
  local cleanup_status=0
  local discovered_container_id
  trap - EXIT

  if [[ -z "$copilot_container_id" && -n "$copilot_container_name" ]]; then
    discovered_container_id="$(docker container inspect --format '{{.Id}}' \
      "$copilot_container_name" 2>/dev/null || true)"
    if [[ -n "$discovered_container_id" ]]; then
      copilot_container_id="$discovered_container_id"
    fi
  fi
  if [[ -z "$copilot_login_container_id" && -n "$copilot_login_container_name" ]]; then
    discovered_container_id="$(docker container inspect --format '{{.Id}}' \
      "$copilot_login_container_name" 2>/dev/null || true)"
    if [[ -n "$discovered_container_id" ]]; then
      copilot_login_container_id="$discovered_container_id"
    fi
  fi

  if [[ -n "$copilot_login_container_id" ]]; then
    if validate_copilot_container "$copilot_login_container_id" \
      "$copilot_login_container_name" trellage-copilot-smoke; then
      docker container rm --force "$copilot_login_container_id" >/dev/null || cleanup_status=1
      copilot_login_container_id=
    else
      printf 'trellage smoke: refusing unowned Copilot login container cleanup: %s\n' \
        "$copilot_login_container_id" >&2
      cleanup_status=1
    fi
  fi
  if [[ -n "$copilot_login_attach_pid" ]]; then
    stop_copilot_login_attach || cleanup_status=1
  fi
  if [[ -n "$copilot_container_id" ]]; then
    if validate_copilot_container "$copilot_container_id" \
      "$copilot_container_name" trellage-copilot; then
      docker container rm --force "$copilot_container_id" >/dev/null || cleanup_status=1
      copilot_container_id=
    else
      printf 'trellage smoke: refusing unowned Copilot container cleanup: %s\n' \
        "$copilot_container_id" >&2
      cleanup_status=1
    fi
  fi
  if [[ -n "$copilot_login_volume_name" ]] \
    && docker volume inspect "$copilot_login_volume_name" >/dev/null 2>&1; then
    if validate_copilot_volume "$copilot_login_volume_name" trellage-copilot-smoke; then
      docker volume rm "$copilot_login_volume_name" >/dev/null || cleanup_status=1
    else
      printf 'trellage smoke: refusing unowned Copilot login volume cleanup: %s\n' \
        "$copilot_login_volume_name" >&2
      cleanup_status=1
    fi
  fi
  if [[ -n "$copilot_volume_name" ]] \
    && docker volume inspect "$copilot_volume_name" >/dev/null 2>&1; then
    if validate_copilot_volume "$copilot_volume_name" trellage-copilot; then
      docker volume rm "$copilot_volume_name" >/dev/null || cleanup_status=1
    else
      printf 'trellage smoke: refusing unowned Copilot volume cleanup: %s\n' \
        "$copilot_volume_name" >&2
      cleanup_status=1
    fi
  fi
  if [[ -d "$copilot_root" ]]; then
    if [[ -f "$copilot_root/.trellage-copilot-smoke-owner" ]] \
      && [[ "$(cat "$copilot_root/.trellage-copilot-smoke-owner")" == "$copilot_root" ]]; then
      rm -rf -- "$copilot_root" || cleanup_status=1
    else
      printf 'trellage smoke: refusing unowned Copilot smoke directory cleanup: %s\n' \
        "$copilot_root" >&2
      cleanup_status=1
    fi
  fi
  if [[ "$original_status" -ne 0 ]]; then
    return "$original_status"
  fi
  return "$cleanup_status"
}

initialize_copilot_smoke() {
  local safe_name
  if [[ -z "$copilot_profile" ]]; then
    copilot_profile="$(cd "$prototype_dir/../../profiles/copilot-hve" && pwd)/profile.toml"
  fi
  copilot_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-copilot-smoke-XXXXXX")"
  copilot_root="$(cd "$copilot_root" && pwd -P)"
  safe_name="$(basename "$copilot_root")"
  [[ "$safe_name" == trellage-copilot-smoke-* && "$safe_name" =~ ^[A-Za-z0-9._-]+$ ]] \
    || fail "unsafe Copilot smoke directory: $safe_name"
  printf '%s\n' "$copilot_root" >"$copilot_root/.trellage-copilot-smoke-owner"
  trap cleanup_copilot_smoke EXIT
  copilot_resource_names
  cp "$tests_dir/copilot_pty_driver.py" "$copilot_root/.trellage-copilot-smoke-pty.py"
  cp "$tests_dir/copilot_state_scanner.py" "$copilot_root/.trellage-copilot-state-scanner.py"
  git init --quiet "$copilot_root"
}

validate_copilot_login_output() {
  local output="$1"
  LC_ALL=C grep -aEq '^To authenticate, visit https://github\.com/login/device and enter code [A-Z0-9]{4}-[A-Z0-9]{4}\r?$' "$output" \
    && LC_ALL=C grep -aEq '^Waiting for authorization\.\.\.\r?$' "$output" \
    && ! LC_ALL=C grep -aEiq '(error|failed|unauthorized|forbidden|expired|denied)' "$output"
}

validate_copilot_inventory_output() {
  local marketplace_output="$1"
  local plugin_output="$2"
  local hve_version="$3"
  local marketplaces plugins
  marketplaces="$(LC_ALL=C awk '/^[[:space:]]+[^[:space:]]+[[:space:]]+/ { sub(/^[[:space:]]+[^[:space:]]+[[:space:]]+/, ""); print }' "$marketplace_output")"
  plugins="$(LC_ALL=C awk '/^[[:space:]]+[^[:space:]]+[[:space:]]+/ { sub(/^[[:space:]]+[^[:space:]]+[[:space:]]+/, ""); print }' "$plugin_output")"
  [[ "$marketplaces" == $'copilot-plugins (GitHub: github/copilot-plugins)\nawesome-copilot (GitHub: github/awesome-copilot)\nhve-core (GitHub: microsoft/hve-core)' ]] \
    && [[ "$plugins" == "hve-core@hve-core (v${hve_version})" ]]
}

probe_copilot_inventory() {
  local hve_version marketplace_output plugin_output
  hve_version="$(sed -n 's/^plugin_versions = { "hve-core" = "\([0-9.]*\)" }$/\1/p' \
    "${copilot_profile%.toml}.lock.toml")"
  docker container exec "$copilot_container_id" trellage-copilot-entry new --version >/dev/null
  marketplace_output="$copilot_root/marketplace.out"
  plugin_output="$copilot_root/plugins.out"
  docker container exec "$copilot_container_id" trellage-copilot-entry new plugin marketplace list \
    >"$marketplace_output"
  docker container exec "$copilot_container_id" trellage-copilot-entry new plugin list \
    >"$plugin_output"
  validate_copilot_inventory_output "$marketplace_output" "$plugin_output" "$hve_version" \
    || fail 'Copilot marketplace or plugin inventory contains missing or extra entries'
  docker container exec "$copilot_container_id" bash -ceu '
    hve_version="$1"
    plugin="$COPILOT_HOME/installed-plugins/hve-core/hve-core"
    expected_agents="documentation.md
rpi-agent.md"
    actual_agents="$(find "$plugin/agents/hve-core" -mindepth 1 -maxdepth 1 -type f -printf "%f\n" | sort)"
    test "$actual_agents" = "$expected_agents"
    expected_subagents="hve-artifact-tester.md
rpi-planner.md
rpi-researcher.md"
    actual_subagents="$(find "$plugin/agents/hve-core/subagents" -mindepth 1 -maxdepth 1 -type f -printf "%f\n" | sort)"
    test "$actual_subagents" = "$expected_subagents"
    expected_commands="git-commit-message.md
git-commit.md
git-merge.md
git-setup.md
pr-review.md
pull-request.md
rpi.md"
    actual_commands="$(find "$plugin/commands/hve-core" -mindepth 1 -maxdepth 1 -type f -printf "%f\n" | sort)"
    test "$actual_commands" = "$expected_commands"
    expected_skills="rpi-challenger
rpi-implement
rpi-plan
rpi-plan-critique
rpi-quick
rpi-research
rpi-review"
    actual_skills="$(find "$plugin/skills/rpi" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort)"
    test "$actual_skills" = "$expected_skills"
    test ! -e "$plugin/agents/ado"
    test ! -e "$plugin/skills/project-planning"
  ' -- "$hve_version" || fail 'Copilot marketplace, HVE Core, or exact RPI inventory probe failed'
  printf 'trellage smoke: PASS: Copilot %s and HVE Core %s exact inventory\n' \
    "$(sed -n '/^\[packages.harness\]$/,/^\[/s/^version = "\([^"]*\)"$/\1/p' "${copilot_profile%.toml}.lock.toml")" \
    "$hve_version"
}

probe_copilot_login_fallback() {
  local created login_device_code login_output="$copilot_root/login-ui.out" deadline
  created="$(docker volume create \
    --label dev.trellage.prototype=trellage-copilot-smoke \
    --label "dev.trellage.worktree=$copilot_root" \
    --label dev.trellage.profile=copilot-hve \
    "$copilot_login_volume_name")"
  [[ "$created" == "$copilot_login_volume_name" ]] || fail 'Copilot login volume name changed'
  validate_copilot_volume "$copilot_login_volume_name" trellage-copilot-smoke \
    || fail 'Copilot login volume ownership is invalid'
  copilot_login_container_id="$(docker container create \
    --name "$copilot_login_container_name" \
    --label dev.trellage.prototype=trellage-copilot-smoke \
    --label "dev.trellage.worktree=$copilot_root" \
    --label dev.trellage.profile=copilot-hve \
    --user 10001:10001 --read-only --interactive --tty \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001 \
    --mount "type=volume,src=$copilot_login_volume_name,dst=/home/agent" \
    --workdir /workspace \
    "$image_ref" trellage-copilot-entry new --no-color login)"
  validate_copilot_container "$copilot_login_container_id" \
    "$copilot_login_container_name" trellage-copilot-smoke \
    || fail 'Copilot login container ownership is invalid'
  env -u COPILOT_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN \
    docker container start --attach "$copilot_login_container_id" \
      >"$login_output" 2>&1 &
  copilot_login_attach_pid=$!
  deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if validate_copilot_login_output "$login_output"; then
      break
    fi
    sleep 1
  done
  validate_copilot_login_output "$login_output" \
    || fail "fresh no-token Copilot volume did not reach login UI within 30 seconds (state=$(docker container inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$copilot_login_container_id"), bytes=$(wc -c <"$login_output" | tr -d ' '))"
  login_device_code="$(LC_ALL=C sed -n 's/^To authenticate, visit https:\/\/github\.com\/login\/device and enter code \([A-Z0-9]\{4\}-[A-Z0-9]\{4\}\)\r$/\1/p' "$login_output")"
  [[ "$login_device_code" =~ ^[A-Z0-9]{4}-[A-Z0-9]{4}$ ]] \
    || fail 'fresh no-token Copilot login UI did not expose one exact device code'
  ! grep -Eiq '(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|Bearer[[:space:]]+[[:graph:]]+)' "$login_output" \
    || fail 'Copilot login UI log contains credential material'
  [[ "$(docker container inspect --format '{{.State.Running}} {{.Config.OpenStdin}} {{.Config.Tty}}' "$copilot_login_container_id")" == 'true true true' ]] \
    && kill -0 "$copilot_login_attach_pid" 2>/dev/null \
    || fail 'fresh no-token Copilot login UI did not remain interactive'
  docker container stop --time 5 "$copilot_login_container_id" >/dev/null \
    || fail 'fresh no-token Copilot login container did not stop'
  wait "$copilot_login_attach_pid" || true
  copilot_login_attach_pid=
  [[ "$(docker container inspect --format '{{.State.Running}}' "$copilot_login_container_id")" == false ]] \
    || fail 'fresh no-token Copilot login container remained active during state inspection'
  docker run --rm \
    --network none \
    --read-only \
    --user 10001:10001 \
    --mount "type=volume,src=$copilot_login_volume_name,dst=/home/agent,readonly" \
    --entrypoint bash \
    "$image_ref" -ceu 'test ! -f "$COPILOT_HOME/config.json"' \
    || fail 'fresh no-token volume persisted Copilot auth configuration'
  printf '%s\n' \
    "$login_device_code" \
    "$copilot_root" \
    "$prototype_dir" \
    "$copilot_profile" \
    /src/finalize-copilot-seed.mjs \
    /src/build-support \
    /src/oci \
    | docker run --rm --interactive --network none --read-only --user 10001:10001 \
      --mount "type=volume,src=$copilot_login_volume_name,dst=/home/agent,readonly" \
      --mount "type=bind,src=$copilot_root,dst=/scan,readonly" \
      --entrypoint python3 "$image_ref" /scan/.trellage-copilot-state-scanner.py /home/agent \
    || fail 'fresh no-token volume persisted credential state'
  printf '%s\n' \
    device_code deviceCode \
    access_token accessToken \
    refresh_token refreshToken \
    oauth_token oauthToken \
    github_token githubToken \
    copilot_token copilotToken \
    token_type tokenType \
    | docker run --rm --interactive --network none --read-only --user 10001:10001 \
      --mount "type=volume,src=$copilot_login_volume_name,dst=/home/agent,readonly" \
      --mount "type=bind,src=$copilot_root,dst=/scan,readonly" \
      --entrypoint python3 "$image_ref" /scan/.trellage-copilot-state-scanner.py \
        /home/agent --mutable-copilot-home \
    || fail 'fresh no-token mutable state persisted a Copilot credential field'
  printf 'trellage smoke: PASS: fresh no-token volume reached login UI without persisted auth\n'
}

copilot_failure_tail() {
  local output="$1"
  COPILOT_FAILURE_SECRET="$copilot_smoke_token" python3 - "$output" <<'PY'
import os
import sys

limit = 1024
secret = os.environ.pop("COPILOT_FAILURE_SECRET", "").encode()
with open(sys.argv[1], "rb") as handle:
    data = handle.read()
if secret:
    data = data.replace(secret, b"[REDACTED]")
text = data.decode("utf-8", "replace").replace("\r", "\n")
text = "".join(character for character in text if character in "\n\t" or character.isprintable())
payload = text.encode("utf-8")
if len(payload) > limit:
    payload = payload[-limit:]
sys.stdout.buffer.write(payload)
if not payload.endswith(b"\n"):
    sys.stdout.buffer.write(b"\n")
PY
}

run_expect_session() {
  local mode="$1"
  local expected="$2"
  local prompt="${3:-}"
  local output="$copilot_root/${mode}.out"
  local container_root expect_status=0 transcript_class=no-bounded-result
  container_root="/mounts/$(basename "$copilot_root")"
  COPILOT_GITHUB_TOKEN="$copilot_smoke_token" \
    docker container exec --interactive --env COPILOT_GITHUB_TOKEN \
      --env "COPILOT_SMOKE_TIMEOUT=${COPILOT_SMOKE_EXPECT_TIMEOUT:-120}" \
      "$copilot_container_id" python3 \
      "$container_root/.trellage-copilot-smoke-pty.py" \
      "$mode" "$expected" "$prompt" "$container_root" \
      >"$output" 2>&1 || expect_status=$?
  ! grep -Eiq '(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|Bearer[[:space:]]+[[:graph:]]+)' "$output" \
    || fail "Copilot $mode transcript contains credential material"
  if [[ "$expect_status" -ne 0 ]]; then
    if grep -Eiq '(log in|login|device code|authenticate)' "$output"; then
      transcript_class=login-ui
    elif grep -Eiq '(error|failed|unauthorized|forbidden|rate limit|timed out)' "$output"; then
      transcript_class=error-output
    fi
    printf 'trellage smoke: Copilot %s PTY stderr tail (redacted, max 1024 bytes):\n' \
      "$mode" >&2
    copilot_failure_tail "$output" >&2
    fail "Copilot $mode PTY exited $expect_status before the bounded result (class=$transcript_class, bytes=$(wc -c <"$output" | tr -d ' '))"
  fi
  grep -Fq "$expected" "$output" || fail "Copilot $mode prompt did not return the bounded expected result"
  copilot_verified_session="$(sed -n 's/^session=\([0-9a-f-]*\)$/\1/p' "$output")"
  [[ "$copilot_verified_session" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || fail "Copilot $mode prompt did not identify one native result session"
}

probe_copilot_harness_auth_dispatch() {
  local dispatch_status=0
  COPILOT_SMOKE_HARNESS="$prototype_dir/trellage" \
  COPILOT_SMOKE_PROFILE="$copilot_profile" \
  COPILOT_SMOKE_ROOT="$copilot_root" \
  COPILOT_SMOKE_CONTAINER_NAME="$copilot_container_name" \
    expect <<'EXPECT' || dispatch_status=$?
set timeout 30
log_user 0
cd $env(COPILOT_SMOKE_ROOT)
set stty_init "rows 40 columns 120"
spawn -noecho $env(COPILOT_SMOKE_HARNESS) --profile $env(COPILOT_SMOKE_PROFILE)
set ready 0
for {set attempt 0} {$attempt < 200} {incr attempt} {
  set probe {
    for command_line in /proc/[0-9]*/cmdline; do
      grep -aq "copilot" "$command_line" || continue
      environment="${command_line%/cmdline}/environ"
      grep -azq "^COPILOT_GITHUB_TOKEN=" "$environment" || continue
      ! grep -azq "^GH_TOKEN=" "$environment"
      ! grep -azq "^GITHUB_TOKEN=" "$environment"
      exit 0
    done
    exit 1
  }
  if {![catch {exec rtk docker container exec $env(COPILOT_SMOKE_CONTAINER_NAME) bash -ceu $probe}]} {
    set ready 1
    break
  }
  after 100
}
if {!$ready} { exit 125 }
send -- "\003"
expect {
  eof { exit 0 }
  timeout { exit 124 }
}
EXPECT
  [[ "$dispatch_status" -eq 0 ]] \
    || fail "bounded harness host-auth dispatch probe exited $dispatch_status"
  copilot_container_id="$(docker container inspect --format '{{.Id}}' "$copilot_container_name")" \
    || fail 'host-auth dispatch did not preserve its Copilot container'
  validate_copilot_container "$copilot_container_id" "$copilot_container_name" trellage-copilot \
    || fail 'host-auth dispatch created an invalid Copilot container'
  validate_copilot_volume "$copilot_volume_name" trellage-copilot \
    || fail 'host-auth dispatch created an invalid Copilot volume'
  jq -e '.[0].Config.Env | all(test("^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=") | not)' \
    <<<"$(docker container inspect "$copilot_container_id")" >/dev/null \
    || fail 'host auth leaked into persistent container configuration'
}

probe_copilot_host_auth_and_resume() {
  local session_before session_after event_size_before event_size_after
  grep -Fqx '    copilot_auth_args=(--env COPILOT_GITHUB_TOKEN)' "$prototype_dir/trellage" \
    || fail 'host auth is not forwarded only on final Copilot exec'
  probe_copilot_harness_auth_dispatch
  copilot_smoke_token="$(gh auth token 2>/dev/null)" \
    || fail 'host gh auth token is unavailable for live Copilot acceptance'
  [[ -n "$copilot_smoke_token" ]] \
    || fail 'host gh auth token is empty for live Copilot acceptance'
  run_expect_session new 38259 \
    'Without tools, compute 24680 plus 13579. Reply with only the decimal result.'
  session_before="$copilot_verified_session"
  event_size_before="$(docker container exec "$copilot_container_id" bash -ceu '
    stat -c "%s" "$COPILOT_HOME/session-state/$1/events.jsonl"
  ' -- "$session_before")"
  run_expect_session resume 97531 \
    'Without tools, compute 86420 plus 11111. Reply with only the decimal result.'
  session_after="$copilot_verified_session"
  event_size_after="$(docker container exec "$copilot_container_id" bash -ceu '
    stat -c "%s" "$COPILOT_HOME/session-state/$1/events.jsonl"
  ' -- "$session_after")"
  [[ "$session_after" == "$session_before" && "$event_size_after" -gt "$event_size_before" ]] \
    || fail 'native --continue did not append to the same Copilot session'
  grep -Fqx '    exec copilot "${harness_args[@]}" --continue' \
    "$prototype_dir/runtime-copilot-entry.sh" \
    || fail 'resume entry is not the native Copilot --continue command'
  probe_copilot_inventory
  docker container exec "$copilot_container_id" bash -ceu '
    for status in /proc/[0-9]*/status; do
      name="$(sed -n "s/^Name:[[:space:]]*//p" "$status")"
      test "$name" != copilot
    done
  ' || fail 'Copilot process remained active before immutable state inspection'
  docker container stop --time 5 "$copilot_container_id" >/dev/null \
    || fail 'Copilot acceptance container did not stop before state inspection'
  [[ "$(docker container inspect --format '{{.State.Running}}' "$copilot_container_id")" == false ]] \
    || fail 'Copilot acceptance container remained active during state inspection'
  printf '%s\n' \
    "$copilot_smoke_token" \
    "$copilot_root" \
    "$prototype_dir" \
    "$copilot_profile" \
    /src/finalize-copilot-seed.mjs \
    /src/build-support \
    /src/oci \
    | docker run --rm --interactive --network none --read-only --user 10001:10001 \
      --mount "type=volume,src=$copilot_volume_name,dst=/home/agent,readonly" \
      --mount "type=bind,src=$copilot_root,dst=/scan,readonly" \
      --entrypoint python3 "$image_ref" /scan/.trellage-copilot-state-scanner.py /home/agent \
    || fail 'Copilot home persisted credential, host, or build material'
  printf 'trellage smoke: PASS: host auth prompt and native --continue reused session %s\n' \
    "$session_before"
}

run_copilot_smoke() {
  for command_name in awk bash cp docker expect find git jq mktemp python3 sed sort tr; do
    command -v "$command_name" >/dev/null 2>&1 || fail "missing host command: $command_name"
  done
  docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
  initialize_copilot_smoke
  image_ref="$(node "$prototype_dir/../../packages/trellage-cli/dist/cli.js" \
    metadata "$copilot_profile" | jq -er '.image')"
  IMAGE_REF="$image_ref" bash "$tests_dir/image_contract.sh" "$copilot_profile"
  probe_copilot_login_fallback
  probe_copilot_host_auth_and_resume
  printf 'trellage smoke: PASS: Copilot HVE live acceptance\n'
}

main() {
  if [[ "${1:-}" == --copilot ]]; then
    [[ "$#" -le 2 ]] || fail 'usage: smoke.sh --copilot [PROFILE]'
    if [[ "$#" -eq 2 ]]; then
      copilot_profile="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    fi
    run_copilot_smoke
    return
  fi
  check_host_commands
  initialize_smoke
  trap cleanup EXIT
  check_shell_syntax
  run_static_contracts
  build_image
  run_live_contracts
  run_session_contracts
  run_live_container_probe
  run_installer_probe
  printf 'trellage smoke: PASS\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
