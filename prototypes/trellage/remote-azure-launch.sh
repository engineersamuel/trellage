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

for dependency in az docker git ssh rsync scp gh jq node; do
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
transfer_root=
remote_stage=
ssh_opts=()

cleanup_transfer() {
  if [[ -n "$transfer_root" && -d "$transfer_root" ]]; then
    rm -rf -- "$transfer_root"
  fi
  if [[ -n "$remote_stage" && "$remote_stage" == /home/azureuser/.cache/trellage/.incoming/receipt.* \
    && "${#ssh_opts[@]}" -gt 0 && -n "${vm_ip-}" ]]; then
    ssh "${ssh_opts[@]}" "azureuser@$vm_ip" "rm -rf -- '$remote_stage'" >/dev/null 2>&1 || true
  fi
}
trap cleanup_transfer EXIT

mkdir -p "$state_dir"
[[ -f "$ssh_key" ]] || ssh-keygen -t ed25519 -f "$ssh_key" -N "" -C "trellage-remote" >/dev/null

normalize_docker_platform() {
  case "$1" in
    linux/aarch64) printf '%s\n' linux/arm64 ;;
    linux/x86_64) printf '%s\n' linux/amd64 ;;
    *) printf '%s\n' "$1" ;;
  esac
}

local_docker_platform="$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null)" \
  || fail 'cannot inspect local Docker server platform'
local_docker_platform="$(normalize_docker_platform "$local_docker_platform")"
[[ "$local_docker_platform" == linux/arm64 ]] \
  || fail "Azure remote launch requires a linux/arm64 local Docker server: $local_docker_platform"

printf 'trellage --remote: building resolved profile image locally\n' >&2
"$local_trellage" build "$profile_path"
profile_metadata="$(node "$compiler" metadata "$profile_path")" \
  || fail 'could not read resolved profile metadata'
image_tag="$(jq -er '.image' <<<"$profile_metadata")" \
  || fail 'resolved profile metadata has no image'
bundle_schema="$(jq -er '.development_resolution_bundle.schema_version' <<<"$profile_metadata")" \
  || fail 'resolved profile metadata has no development receipt bundle'
[[ "$bundle_schema" == 1 ]] || fail "unsupported development receipt bundle schema: $bundle_schema"
bundle_relative_directory="$(jq -er '.development_resolution_bundle.cache_relative_directory' \
  <<<"$profile_metadata")" || fail 'development receipt bundle has no cache destination'
case "/$bundle_relative_directory/" in
  */../*|*/./*|//*)
    fail "development receipt bundle has an unsafe cache destination: $bundle_relative_directory"
    ;;
esac
[[ "$bundle_relative_directory" != /* ]] \
  || fail "development receipt bundle has an absolute cache destination: $bundle_relative_directory"

transfer_root="$(mktemp -d)"
bundle_root="$transfer_root/receipt"
mkdir -p "$bundle_root"
bundle_file_count=0
while IFS=$'\t' read -r source relative; do
  [[ -n "$source" && -n "$relative" ]] || fail 'development receipt bundle contains an empty file path'
  [[ -f "$source" && ! -L "$source" ]] || fail "development receipt bundle file is unsafe: $source"
  case "/$relative/" in
    */../*|*/./*|//*)
      fail "development receipt bundle contains an unsafe relative path: $relative"
      ;;
  esac
  [[ "$relative" != /* ]] || fail "development receipt bundle contains an absolute relative path: $relative"
  mkdir -p "$bundle_root/$(dirname "$relative")"
  cp -p -- "$source" "$bundle_root/$relative"
  bundle_file_count=$((bundle_file_count + 1))
done < <(
  jq -er '.development_resolution_bundle.files[] | [.source, .relative] | @tsv' <<<"$profile_metadata"
)
[[ "$bundle_file_count" -gt 0 ]] || fail 'development receipt bundle contains no files'

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
remote_xdg_cache_home=/home/azureuser/.cache

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

remote_stage="$(ssh "${ssh_opts[@]}" "azureuser@$vm_ip" \
  "mkdir -p '$remote_xdg_cache_home/trellage/.incoming' && mktemp -d '$remote_xdg_cache_home/trellage/.incoming/receipt.XXXXXX'")" \
  || fail 'could not stage the remote development receipt bundle'
[[ "$remote_stage" == "$remote_xdg_cache_home"/trellage/.incoming/receipt.* ]] \
  || fail "remote development receipt staging path is unsafe: $remote_stage"
rsync -az -e "ssh ${ssh_opts[*]}" "$bundle_root/" "azureuser@$vm_ip:$remote_stage/" \
  || fail 'could not transfer the development receipt bundle'

printf 'trellage --remote: transferring resolved image to VM Docker\n' >&2
docker save "$image_tag" | ssh "${ssh_opts[@]}" "azureuser@$vm_ip" docker load

remote_receipt_directory="$remote_xdg_cache_home/$bundle_relative_directory"
ssh "${ssh_opts[@]}" "azureuser@$vm_ip" bash -s -- "$remote_stage" "$remote_receipt_directory" <<'REMOTE'
set -euo pipefail

source_directory="$1"
destination="$2"
case "$source_directory" in
  /home/azureuser/.cache/trellage/.incoming/receipt.*) ;;
  *) printf 'unsafe receipt staging path: %s\n' "$source_directory" >&2; exit 1 ;;
esac
case "$destination" in
  /home/azureuser/.cache/trellage/resolutions/v1/*) ;;
  *) printf 'unsafe receipt destination: %s\n' "$destination" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "$destination")"
backup="${destination}.previous.$$"
[[ ! -e "$backup" && ! -L "$backup" ]]
had_previous=false
if [[ -e "$destination" || -L "$destination" ]]; then
  mv "$destination" "$backup"
  had_previous=true
fi
if mv "$source_directory" "$destination"; then
  if [[ "$had_previous" == true ]]; then
    rm -rf -- "$backup"
  fi
else
  if [[ "$had_previous" == true ]]; then
    mv "$backup" "$destination"
  fi
  exit 1
fi
REMOTE
remote_stage=
rm -rf -- "$transfer_root"
transfer_root=
trap - EXIT

gh_token="$(gh auth token)"
quoted_forward_args="$(printf '%q ' "${forward_args[@]}")"
printf 'trellage --remote: launching on Azure VM %s\n' "$vm_ip" >&2
exec ssh -t "${ssh_opts[@]}" "azureuser@$vm_ip" \
  "cd '$worktree' && XDG_CACHE_HOME='$remote_xdg_cache_home' GH_TOKEN='$gh_token' ./prototypes/trellage/trellage $quoted_forward_args"
