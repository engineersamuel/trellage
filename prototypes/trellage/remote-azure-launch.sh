#!/usr/bin/env bash
set -euo pipefail

# Invoked only by `trellage --remote`/`-r`. Not a supported standalone entry
# point: it assumes its caller already validated `az` is installed and
# authenticated, and that a profile path was supplied. Provisions (or reuses)
# a single shared ARM64 Azure VM, mirrors the current worktree onto it at
# identical paths, transfers the locally-built locked profile image, and
# re-execs the unmodified `trellage` launcher on the VM's own Docker daemon
# with an interactive PTY (ssh -t). This mirrors the validated
# scripts/prototype-azure-copilot-spike.sh flow, generalized for any profile.

fail() { printf 'trellage --remote: %s\n' "$1" >&2; exit 1; }

[[ "$#" -ge 1 ]] || fail 'internal error: missing profile path'
profile_path="$1"
shift
forward_args=("$@")

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
local_trellage="$script_dir/trellage"
compiler_package_dir="$(cd "$script_dir/../../packages/trellage-cli" && pwd -P)"
compiler="$compiler_package_dir/dist/cli.js"

for dependency in az docker git ssh rsync scp gh node; do
  command -v "$dependency" >/dev/null 2>&1 || fail "required command not found: $dependency"
done

state_dir="$HOME/.trellage-azure-remote"
state_file="$state_dir/state"
ssh_key="$state_dir/id_ed25519"
rg="trellage-remote-rg"
location="westus2"
vm_name="trellage-remote-vm"
vm_size="Standard_D2ps_v5"
vm_image="Canonical:ubuntu-24_04-lts:server-arm64:latest"

worktree="$(git rev-parse --show-toplevel)"
git_common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"

mkdir -p "$state_dir"
[[ -f "$ssh_key" ]] || ssh-keygen -t ed25519 -f "$ssh_key" -N "" -C "trellage-remote" >/dev/null

printf 'trellage --remote: building locked profile image locally\n' >&2
"$local_trellage" build --locked "$profile_path"
image_tag="$(node "$compiler" metadata "$profile_path" | node -e \
  'process.stdin.once("data", d => process.stdout.write(JSON.parse(d).image))')"

load_state() { [[ -f "$state_file" ]] && source "$state_file" || true; }
save_state() {
  printf 'vm_ip=%q\n' "$vm_ip" > "$state_file"
}

load_state
vm_present=false
if az group exists --name "$rg" -o tsv 2>/dev/null | grep -qx true \
  && az vm show -g "$rg" -n "$vm_name" >/dev/null 2>&1; then
  vm_present=true
fi

ssh_opts=(-i "$ssh_key" -o StrictHostKeyChecking=accept-new)

if [[ "$vm_present" == false ]]; then
  printf 'trellage --remote: creating Azure resource group + ARM64 VM (%s)\n' "$rg" >&2
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
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
CLOUDINIT
  az vm create \
    --resource-group "$rg" --name "$vm_name" --location "$location" \
    --image "$vm_image" --size "$vm_size" --admin-username azureuser \
    --ssh-key-values "$ssh_key.pub" --custom-data "$cloud_init" \
    --public-ip-sku Standard -o none
  rm -f "$cloud_init"
  vm_ip="$(az vm show -d -g "$rg" -n "$vm_name" --query publicIps -o tsv)"
  save_state

  printf 'trellage --remote: waiting for cloud-init (Docker + Node install)\n' >&2
  ssh "${ssh_opts[@]}" "azureuser@$vm_ip" "cloud-init status --wait" >/dev/null

  printf 'trellage --remote: preparing mirrored worktree paths on VM\n' >&2
  ssh "${ssh_opts[@]}" "azureuser@$vm_ip" \
    "sudo mkdir -p '$worktree' '$git_common_dir' && sudo chown -R azureuser:azureuser '$worktree' '$git_common_dir' && mkdir -p ~/.copilot"
else
  vm_ip="${vm_ip:-$(az vm show -d -g "$rg" -n "$vm_name" --query publicIps -o tsv)}"
  save_state
  printf 'trellage --remote: reusing existing Azure VM (%s)\n' "$vm_ip" >&2
  ssh "${ssh_opts[@]}" "azureuser@$vm_ip" \
    "mkdir -p '$worktree' '$git_common_dir' ~/.copilot"
fi

printf 'trellage --remote: mirroring worktree + git dir + Copilot models onto VM\n' >&2
rsync -az --delete -e "ssh ${ssh_opts[*]}" "$worktree/" "azureuser@$vm_ip:$worktree/"
rsync -az -e "ssh ${ssh_opts[*]}" "$git_common_dir/" "azureuser@$vm_ip:$git_common_dir/"
[[ ! -f "$HOME/.copilot/models.json" ]] \
  || scp "${ssh_opts[@]}" "$HOME/.copilot/models.json" "azureuser@$vm_ip:~/.copilot/models.json"

printf 'trellage --remote: transferring locked image to VM Docker\n' >&2
docker save "$image_tag" | ssh "${ssh_opts[@]}" "azureuser@$vm_ip" docker load

gh_token="$(gh auth token)"
quoted_forward_args="$(printf '%q ' "${forward_args[@]}")"
printf 'trellage --remote: launching on Azure VM %s\n' "$vm_ip" >&2
exec ssh -t "${ssh_opts[@]}" "azureuser@$vm_ip" \
  "cd '$worktree' && GH_TOKEN='$gh_token' ./prototypes/trellage/trellage $quoted_forward_args"
