#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: prototype-azure-copilot-spike.sh <up|run|resume|down|status> [profile-path|session-id]

Throwaway eval helper for the Azure Copilot offload spike. Not wired into any
Trellage contract or CI; safe to delete once the eval is done.

  up      Create resource group + ARM64 VM, install Docker/Node, mirror the
          current worktree + git common dir + ~/.copilot/models.json onto the
          VM at identical paths, and load the locked profile image.
  run     Open a REAL interactive session (SSH -t, full PTY) that runs the
          unmodified `trellage` launcher on the VM against its local Docker.
  resume  Re-attach to a stopped (Ctrl-C'd) session via `trellage resume`.
          Requires the session ID `trellage` printed on exit. Only works
          while the VM from `up` still exists (the container is stopped,
          not destroyed, on Ctrl-C, so `down` deletes it for good).
          Usage: ... resume <session-id> [profile-path]
  down    Delete the Azure resource group (VM + all spike resources).
  status  Show whether the spike resource group/VM exist.

profile-path defaults to profiles/copilot-hve/profile.toml.

State (resource group name, VM IP, SSH key path) is kept in
~/.trellage-azure-copilot-spike/state so up/run/down/status share it.
EOF
}

command_name="${1:-}"
case "$command_name" in
  up|run|down|status)
    profile_path="${2:-profiles/copilot-hve/profile.toml}"
    ;;
  resume)
    [[ -n "${2:-}" ]] || { printf 'prototype-azure-copilot-spike: resume requires a session ID\n' >&2; exit 2; }
    resume_session_id="$2"
    profile_path="${3:-profiles/copilot-hve/profile.toml}"
    ;;
  -h|--help|'') usage; exit 0 ;;
  *) printf 'prototype-azure-copilot-spike: unsupported command: %s\n' "$command_name" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$HOME/.trellage-azure-copilot-spike"
state_file="$state_dir/state"
ssh_key="$state_dir/id_ed25519"
rg="copilot-spike-rg"
location="westus2"
vm_name="copilot-spike-vm"
vm_size="Standard_D2ps_v5"
vm_image="Canonical:ubuntu-24_04-lts:server-arm64:latest"

fail() { printf 'prototype-azure-copilot-spike: %s\n' "$1" >&2; exit 1; }

for dependency in az docker git ssh rsync scp gh; do
  command -v "$dependency" >/dev/null 2>&1 || fail "required command not found: $dependency"
done

load_state() { [[ -f "$state_file" ]] && source "$state_file" || true; }
save_state() {
  mkdir -p "$state_dir"
  printf 'vm_ip=%q\n' "$vm_ip" > "$state_file"
}

case "$command_name" in
  up)
    cd "$repo_root"
    worktree="$(git rev-parse --show-toplevel)"
    git_common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
    image_tag="$(node packages/trellage-cli/dist/cli.js metadata "$profile_path" | node -e \
      'process.stdin.once("data", d => process.stdout.write(JSON.parse(d).image))')"

    mkdir -p "$state_dir"
    [[ -f "$ssh_key" ]] || ssh-keygen -t ed25519 -f "$ssh_key" -N "" -C "trellage-azure-spike" >/dev/null

    printf 'trellage: building locked profile image\n' >&2
    mise run trellage -- build --locked "$profile_path"

    printf 'trellage: creating Azure resource group + ARM64 VM\n' >&2
    az group create --name "$rg" --location "$location" -o none
    cloud_init="$(mktemp)"
    cat > "$cloud_init" <<'CLOUDINIT'
#cloud-config
package_update: true
packages: [ca-certificates, curl, rsync]
runcmd:
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - usermod -aG docker azureuser
CLOUDINIT
    az vm create \
      --resource-group "$rg" --name "$vm_name" --location "$location" \
      --image "$vm_image" --size "$vm_size" --admin-username azureuser \
      --ssh-key-values "$ssh_key.pub" --custom-data "$cloud_init" \
      --public-ip-sku Standard -o none
    rm -f "$cloud_init"
    vm_ip="$(az vm show -d -g "$rg" -n "$vm_name" --query publicIps -o tsv)"
    save_state

    ssh_opts=(-i "$ssh_key" -o StrictHostKeyChecking=accept-new)
    printf 'trellage: waiting for cloud-init (Docker install)\n' >&2
    ssh "${ssh_opts[@]}" "azureuser@$vm_ip" "cloud-init status --wait" >/dev/null

    printf 'trellage: mirroring worktree + git dir + Copilot models onto VM\n' >&2
    ssh "${ssh_opts[@]}" "azureuser@$vm_ip" \
      "sudo mkdir -p '$worktree' '$git_common_dir' && sudo chown -R azureuser:azureuser /Users && mkdir -p ~/.copilot"
    rsync -az -e "ssh ${ssh_opts[*]}" "$worktree/" "azureuser@$vm_ip:$worktree/"
    rsync -az -e "ssh ${ssh_opts[*]}" "$git_common_dir/" "azureuser@$vm_ip:$git_common_dir/"
    scp "${ssh_opts[@]}" "$HOME/.copilot/models.json" "azureuser@$vm_ip:~/.copilot/models.json"

    printf 'trellage: installing Node.js on VM\n' >&2
    ssh "${ssh_opts[@]}" "azureuser@$vm_ip" \
      "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null && sudo apt-get install -y nodejs >/dev/null"

    printf 'trellage: transferring locked image to VM Docker\n' >&2
    docker save "$image_tag" | ssh "${ssh_opts[@]}" "azureuser@$vm_ip" docker load

    printf 'trellage: ready. Run: %s run\n' "$0" >&2
    ;;

  run)
    load_state
    [[ -n "${vm_ip:-}" ]] || fail "no VM found; run '$0 up' first"
    cd "$repo_root"
    worktree="$(git rev-parse --show-toplevel)"
    gh_token="$(gh auth token)"
    ssh -t -i "$ssh_key" -o StrictHostKeyChecking=accept-new "azureuser@$vm_ip" \
      "cd '$worktree' && GH_TOKEN='$gh_token' ./prototypes/trellage/trellage --profile '$profile_path'"
    ;;

  resume)
    load_state
    [[ -n "${vm_ip:-}" ]] || fail "no VM found; run '$0 up' first"
    cd "$repo_root"
    worktree="$(git rev-parse --show-toplevel)"
    gh_token="$(gh auth token)"
    ssh -t -i "$ssh_key" -o StrictHostKeyChecking=accept-new "azureuser@$vm_ip" \
      "cd '$worktree' && GH_TOKEN='$gh_token' ./prototypes/trellage/trellage --profile '$profile_path' resume '$resume_session_id'"
    ;;

  status)
    load_state
    if az group exists --name "$rg" -o tsv 2>/dev/null | grep -qx true; then
      printf 'resource group: present (%s)\n' "$rg"
      printf 'vm ip: %s\n' "${vm_ip:-unknown}"
    else
      printf 'resource group: absent\n'
    fi
    ;;

  down)
    load_state
    printf 'trellage: deleting Azure resource group %s (async)\n' "$rg" >&2
    az group delete --name "$rg" --yes --no-wait
    rm -f "$state_file"
    docker context use default >/dev/null 2>&1 || true
    docker context rm trellage-azure-spike >/dev/null 2>&1 || true
    printf 'trellage: deletion in progress; check with: az group exists --name %s\n' "$rg" >&2
    ;;
esac
