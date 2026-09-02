#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

usage() {
  cat <<'EOF'
Usage: scripts/azure-fresh-install.sh <all|create|bootstrap|accept|ssh|status|down|plan>

Create a fresh Azure ARM64 VM, install Trellage from a Git clone on that VM,
install all nine Trellage Native launchers, live-probe the eight coding-agent
launchers, verify both Firstmate profiles, and run one Trellage Sandbox prompt.

Commands:
  all        Create, bootstrap, and run acceptance checks
  create     Create the resource group, network, and VM
  bootstrap Clone and install Trellage on the VM
  accept     Retry the live Native and Sandbox acceptance checks
  ssh        Open an interactive SSH session
  status     Show the saved resource group and Azure VM state
  down       Delete only the saved resource group
  plan       Print the effective configuration without changing Azure

Environment:
  TRELLAGE_AZURE_LOCATION       Azure region (default: westus2)
  TRELLAGE_AZURE_VM_SIZE        VM SKU (default: Standard_D4ps_v5)
  TRELLAGE_AZURE_RESOURCE_GROUP_PREFIX Resource group prefix
  TRELLAGE_AZURE_SSH_SOURCE     IPv4 CIDR allowed to use SSH
  TRELLAGE_AZURE_REPOSITORY     Public GitHub clone URL
  TRELLAGE_AZURE_REF            Git branch, tag, or commit (default: main)
  TRELLAGE_AZURE_PROXY_REPOSITORY copilot-proxy-rs GitHub clone URL
  TRELLAGE_AZURE_PROXY_REF      Proxy Git branch, tag, or commit (default: main)
  TRELLAGE_AZURE_APPLY_LOCAL_CHANGES Set to 1 to test local unmerged runtime fixes
  TRELLAGE_AZURE_ATTEMPTS       Acceptance attempts (default: 3)
  TRELLAGE_AZURE_COPILOT_VERSION Copilot CLI npm version (default: 1.0.81)

Authentication:
  Native Copilot uses COPILOT_GITHUB_TOKEN, GH_TOKEN, or `gh auth token`.
  copilot-proxy-rs uses COPILOT_PROXY_GITHUB_TOKEN or the token value from a
  safe ~/.config/copilot-proxy-rs/github_token. Both values are streamed over
  SSH and written only to VM tmpfs.

The automated Native matrix invokes `cpx/hve`, `cdx/pstack`, `cldx/default`,
`grx/superpowers`, `jcx/default`, `omp/copilot`, `picx/default`, and
`prx/default` through `trx run`. It verifies `fmx/default` and
`fmx/pstack-workers` with setup, doctor, inventory, source-pin, and overlay
evidence without starting a paid fleet.
Bare `trx` is an interactive TTY picker.
The Sandbox check invokes `trellage --profile claude-council`.
EOF
}

fail() {
  printf 'azure-fresh-install: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

validate_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] \
    || fail "invalid Azure resource name: $1"
}

validate_ref() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] \
    && [[ "$1" != *..* ]] \
    || fail "invalid Git ref: $1"
}

validate_repository() {
  [[ "$1" =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$ ]] \
    || fail "repository must be a public GitHub HTTPS clone URL: $1"
}

validate_ipv4_cidr() {
  local value="$1"
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/(3[0-2]|[12]?[0-9])$ ]] \
    || fail "SSH source must be an IPv4 CIDR: $value"
}

command_name="${1:-}"
case "$command_name" in
  all | create | bootstrap | accept | ssh | status | down | plan) ;;
  -h | --help | '') usage; exit 0 ;;
  *) fail "unsupported command: $command_name" ;;
esac

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/trellage-azure-fresh"
state_file="$state_dir/state"
ssh_key="$state_dir/id_ed25519"
known_hosts="$state_dir/known_hosts"
location="${TRELLAGE_AZURE_LOCATION:-westus2}"
vm_size="${TRELLAGE_AZURE_VM_SIZE:-Standard_D4ps_v5}"
vm_image="Canonical:ubuntu-24_04-lts:server-arm64:latest"
repository="${TRELLAGE_AZURE_REPOSITORY:-https://github.com/engineersamuel/trellage.git}"
git_ref="${TRELLAGE_AZURE_REF:-main}"
proxy_repository="${TRELLAGE_AZURE_PROXY_REPOSITORY:-https://github.com/engineersamuel/copilot-proxy-rs.git}"
proxy_ref="${TRELLAGE_AZURE_PROXY_REF:-main}"
attempts="${TRELLAGE_AZURE_ATTEMPTS:-3}"
copilot_version="${TRELLAGE_AZURE_COPILOT_VERSION:-1.0.81}"
vm_name="trellage-fresh-vm"
vnet_name="trellage-fresh-vnet"
subnet_name="default"
nsg_name="trellage-fresh-nsg"
public_ip_name="trellage-fresh-ip"
nic_name="trellage-fresh-nic"
checkout="/home/azureuser/trellage"
proxy_checkout="/home/azureuser/copilot-proxy-rs"
resource_group=''
vm_ip=''
subscription_id=''

[[ "$attempts" =~ ^[1-9][0-9]?$ ]] || fail "attempts must be an integer from 1 to 99"
[[ "$copilot_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "invalid Copilot CLI version: $copilot_version"
validate_name "$location"
validate_name "$vm_size"
validate_ref "$git_ref"
validate_repository "$repository"
validate_ref "$proxy_ref"
validate_repository "$proxy_repository"

load_state() {
  local allow_missing_ip="${1:-false}"
  local key value

  [[ -f "$state_file" && ! -L "$state_file" ]] || fail "state not found; run '$0 create' first"
  resource_group=''
  vm_ip=''
  subscription_id=''
  while IFS='=' read -r key value; do
    case "$key" in
      resource_group) resource_group="$value" ;;
      vm_ip) vm_ip="$value" ;;
      subscription_id) subscription_id="$value" ;;
      *) fail "invalid state key: $key" ;;
    esac
  done <"$state_file"
  validate_name "$resource_group"
  [[ "$subscription_id" =~ ^[0-9a-fA-F-]{36}$ ]] \
    || fail "invalid subscription ID in state"
  if [[ -n "$vm_ip" ]]; then
    validate_ipv4_cidr "$vm_ip/32"
  elif [[ "$allow_missing_ip" != true ]]; then
    fail "VM address is not recorded; inspect or delete resource group: $resource_group"
  fi
}

save_state() {
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  {
    printf 'resource_group=%s\n' "$resource_group"
    printf 'vm_ip=%s\n' "$vm_ip"
    printf 'subscription_id=%s\n' "$subscription_id"
  } >"$state_file"
  chmod 600 "$state_file"
}

ssh_arguments() {
  SSH_ARGUMENTS=(
    -i "$ssh_key"
    -o BatchMode=yes
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$known_hosts"
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=4
  )
}

effective_resource_group() {
  resource_group_prefix="${TRELLAGE_AZURE_RESOURCE_GROUP_PREFIX:-trellage-fresh}"
  validate_name "$resource_group_prefix"
  resource_group="$resource_group_prefix-$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM"
  validate_name "$resource_group"
}

resolve_ssh_source() {
  if [[ -n "${TRELLAGE_AZURE_SSH_SOURCE:-}" ]]; then
    ssh_source="$TRELLAGE_AZURE_SSH_SOURCE"
  else
    require_command curl
    public_ipv4="$(curl -4fsS --max-time 15 https://api.ipify.org)" \
      || fail "could not detect public IPv4; set TRELLAGE_AZURE_SSH_SOURCE"
    ssh_source="$public_ipv4/32"
  fi
  validate_ipv4_cidr "$ssh_source"
}

print_plan() {
  if [[ -f "$state_file" && ! -L "$state_file" ]]; then
    load_state true
  else
    effective_resource_group
  fi
  resolve_ssh_source
  cat <<EOF
resource group: $resource_group
subscription:   ${subscription_id:-current Azure CLI subscription}
location:       $location
VM:             $vm_name ($vm_size)
image:          $vm_image
OS disk:        128 GiB Premium SSD
SSH source:     $ssh_source
repository:     $repository
Git ref:        $git_ref
proxy repo:     $proxy_repository
proxy ref:      $proxy_ref
checkout:       $checkout
agent probes:   eight launchers through trx run
Firstmate:      setup, doctor, inventory, source pin, and overlay receipts
sandbox probe:  trellage --profile claude-council
attempts:       $attempts
EOF
}

create_vm() {
  local sku_restrictions cloud_init

  require_command az
  require_command ssh
  require_command ssh-keygen
  [[ ! -e "$state_file" && ! -L "$state_file" ]] \
    || fail "saved VM state already exists; run '$0 down' before creating a fresh VM"
  subscription_id="$(az account show --query id -o tsv 2>/dev/null)" \
    || fail "Azure CLI is not authenticated; run az login"
  [[ "$subscription_id" =~ ^[0-9a-fA-F-]{36}$ ]] \
    || fail "Azure CLI returned an invalid subscription ID"
  effective_resource_group
  resolve_ssh_source
  [[ "$(az group exists --name "$resource_group" --subscription "$subscription_id" -o tsv)" == false ]] \
    || fail "resource group already exists; use a new disposable group name: $resource_group"

  sku_restrictions="$(az vm list-skus \
    --subscription "$subscription_id" \
    --location "$location" \
    --size "$vm_size" \
    --all \
    --query "[?name=='$vm_size'] | [0].restrictions | length(@)" \
    -o tsv)"
  [[ "$sku_restrictions" == 0 ]] \
    || fail "$vm_size is unavailable or restricted in $location"

  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  [[ -f "$ssh_key" && ! -L "$ssh_key" ]] \
    || ssh-keygen -q -t ed25519 -f "$ssh_key" -N '' -C trellage-azure-fresh
  chmod 600 "$ssh_key"
  rm -f -- "$known_hosts"

  (
  cloud_init="$(mktemp "${TMPDIR:-/tmp}/trellage-azure-cloud-init.XXXXXX")"
  trap 'rm -f -- "$cloud_init"' EXIT
  cat >"$cloud_init" <<'CLOUDINIT'
#cloud-config
package_update: true
packages:
  - bubblewrap
  - build-essential
  - ca-certificates
  - curl
  - fish
  - git
  - gh
  - jq
  - python3
  - rsync
  - tmux
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

  printf 'azure-fresh-install: creating resource group %s\n' "$resource_group" >&2
  az group create \
    --subscription "$subscription_id" \
    --name "$resource_group" \
    --location "$location" \
    -o none
  save_state
  az network nsg create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$nsg_name" \
    --location "$location" \
    -o none
  az network nsg rule create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --nsg-name "$nsg_name" \
    --name allow-ssh \
    --priority 100 \
    --access Allow \
    --protocol Tcp \
    --direction Inbound \
    --source-address-prefixes "$ssh_source" \
    --destination-port-ranges 22 \
    -o none
  az network vnet create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$vnet_name" \
    --location "$location" \
    --address-prefixes 10.42.0.0/16 \
    -o none
  az network vnet subnet create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --vnet-name "$vnet_name" \
    --name "$subnet_name" \
    --address-prefixes 10.42.0.0/24 \
    --network-security-group "$nsg_name" \
    -o none
  az network public-ip create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$public_ip_name" \
    --location "$location" \
    --sku Standard \
    --allocation-method Static \
    -o none
  az network nic create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$nic_name" \
    --location "$location" \
    --vnet-name "$vnet_name" \
    --subnet "$subnet_name" \
    --network-security-group "$nsg_name" \
    --public-ip-address "$public_ip_name" \
    -o none
  az vm create \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$vm_name" \
    --location "$location" \
    --nics "$nic_name" \
    --image "$vm_image" \
    --size "$vm_size" \
    --security-type Standard \
    --admin-username azureuser \
    --ssh-key-values "$ssh_key.pub" \
    --custom-data "$cloud_init" \
    --os-disk-size-gb 128 \
    --storage-sku Premium_LRS \
    -o none
  rm -f -- "$cloud_init"
  trap - EXIT
  )

  vm_ip="$(az network public-ip show \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$public_ip_name" \
    --query ipAddress \
    -o tsv)"
  validate_ipv4_cidr "$vm_ip/32"
  save_state
  ssh_arguments

  printf 'azure-fresh-install: waiting for SSH and cloud-init on %s\n' "$vm_ip" >&2
  for _ in {1..60}; do
    if ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" true >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
  ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" 'cloud-init status --wait'
  ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" \
    'docker info --format "{{.OSType}}/{{.Architecture}}" | grep -Fx linux/aarch64'
  printf 'azure-fresh-install: VM ready: ssh -i %q azureuser@%s\n' "$ssh_key" "$vm_ip" >&2
}

bootstrap_vm() {
  load_state
  ssh_arguments
  printf 'azure-fresh-install: cloning and installing Trellage on %s\n' "$vm_ip" >&2
  ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" bash -s -- \
    "$repository" "$git_ref" "$checkout" "$copilot_version" \
    "$proxy_repository" "$proxy_ref" "$proxy_checkout" <<'REMOTE'
set -euo pipefail

repository="$1"
git_ref="$2"
checkout="$3"
copilot_version="$4"
proxy_repository="$5"
proxy_ref="$6"
proxy_checkout="$7"
export PATH="$HOME/.local/bin:$PATH"

missing_packages=()
command -v bwrap >/dev/null 2>&1 || missing_packages+=(bubblewrap)
command -v fish >/dev/null 2>&1 || missing_packages+=(fish)
command -v tmux >/dev/null 2>&1 || missing_packages+=(tmux)
if (( ${#missing_packages[@]} > 0 )); then
  sudo apt-get update
  sudo apt-get install -y "${missing_packages[@]}"
fi
apparmor_profile="$(mktemp)"
printf '%s\n' \
  'abi <abi/4.0>,' \
  'include <tunables/global>' \
  'profile trellage-bwrap /usr/bin/bwrap flags=(unconfined) {' \
  '  userns,' \
  '}' >"$apparmor_profile"
sudo install -m 0644 "$apparmor_profile" /etc/apparmor.d/trellage-bwrap
rm -f -- "$apparmor_profile"
sudo apparmor_parser -r /etc/apparmor.d/trellage-bwrap
bwrap --ro-bind / / --dev /dev --proc /proc /bin/true
install -d -m 700 "$HOME/.config/fish"
if [[ ! -e "$HOME/.config/fish/config.fish" ]]; then
  install -m 600 /dev/null "$HOME/.config/fish/config.fish"
fi
[[ -f "$HOME/.config/fish/config.fish" && ! -L "$HOME/.config/fish/config.fish" ]] || {
  printf 'bootstrap: unsafe Fish config path: %s\n' "$HOME/.config/fish/config.fish" >&2
  exit 1
}

if [[ ! -e "$checkout" ]]; then
  git clone --no-checkout "$repository" "$checkout"
else
  [[ -d "$checkout/.git" && ! -L "$checkout" ]] || {
    printf 'bootstrap: refusing unexpected existing checkout path: %s\n' "$checkout" >&2
    exit 1
  }
  [[ "$(git -C "$checkout" remote get-url origin)" == "$repository" ]] || {
    printf 'bootstrap: existing checkout has the wrong origin: %s\n' "$checkout" >&2
    exit 1
  }
fi
git -C "$checkout" fetch origin --tags --prune
if git -C "$checkout" rev-parse --verify --quiet "origin/$git_ref^{commit}" >/dev/null; then
  target="origin/$git_ref"
elif git -C "$checkout" rev-parse --verify --quiet "$git_ref^{commit}" >/dev/null; then
  target="$git_ref"
else
  git -C "$checkout" fetch origin "$git_ref"
  target=FETCH_HEAD
fi
git -C "$checkout" checkout --detach "$target"

if [[ ! -e "$proxy_checkout" ]]; then
  git clone --no-checkout "$proxy_repository" "$proxy_checkout"
else
  [[ -d "$proxy_checkout/.git" && ! -L "$proxy_checkout" ]] || {
    printf 'bootstrap: refusing unexpected proxy checkout path: %s\n' "$proxy_checkout" >&2
    exit 1
  }
  [[ "$(git -C "$proxy_checkout" remote get-url origin)" == "$proxy_repository" ]] || {
    printf 'bootstrap: existing proxy checkout has the wrong origin: %s\n' "$proxy_checkout" >&2
    exit 1
  }
fi
git -C "$proxy_checkout" fetch origin --tags --prune
if git -C "$proxy_checkout" rev-parse --verify --quiet "origin/$proxy_ref^{commit}" >/dev/null; then
  proxy_target="origin/$proxy_ref"
elif git -C "$proxy_checkout" rev-parse --verify --quiet "$proxy_ref^{commit}" >/dev/null; then
  proxy_target="$proxy_ref"
else
  git -C "$proxy_checkout" fetch origin "$proxy_ref"
  proxy_target=FETCH_HEAD
fi
git -C "$proxy_checkout" checkout --detach "$proxy_target"

curl -fsSL https://mise.run | sh
eval "$(mise activate bash)"
sudo npm install -g \
  "@github/copilot@$copilot_version" \
  @openai/codex \
  @anthropic-ai/claude-code \
  @xai-official/grok@0.2.112
mkdir -p "$HOME/.copilot"
printf '{}\n' >"$HOME/.copilot/models.json"

cd "$checkout"
mise trust
mise use -g uv
mise run trellage -- validate copilot-hve
(
  cd packages/trellage-launcher
  npm ci
  npm run build
)
scripts/rebuild-profile-images.sh --install --native-only

(
  cd "$proxy_checkout"
  HOST_UID="$(id -u)" HOST_GID="$(id -g)" docker compose build
)
docker run --rm hello-world >/dev/null
trellage validate copilot-hve
trx --help >/dev/null
printf 'bootstrap: PASS\n'
REMOTE

  apply_local_changes="${TRELLAGE_AZURE_APPLY_LOCAL_CHANGES:-${TRELLAGE_AZURE_APPLY_LOCAL_TRX:-0}}"
  if [[ "$apply_local_changes" == 1 ]]; then
    require_command tar
    local_trx="$repo_root/prototypes/trellage-router/bin/trx"
    local_picx="$repo_root/prototypes/trellage-picx-profiles/bin/picx"
    local_omp="$repo_root/prototypes/trellage-omp-profiles/bin/omp"
    local_omp_catalog="$repo_root/prototypes/trellage-omp-profiles/catalog.json"
    local_prx="$repo_root/prototypes/trellage-prime-profiles/bin/prx"
    local_claude_common="$repo_root/prototypes/trellage-claude-common"
    local_claude_profiles="$repo_root/prototypes/trellage-claude-profiles"
    local_firstmate_profiles="$repo_root/prototypes/trellage-firstmate-profiles"
    local_firstmate_guides="$repo_root/profile-guides/native/fmx"
    local_guide_ui="$repo_root/packages/trellage-launcher/src/guide-ui.tsx"
    local_application="$repo_root/packages/trellage-cli/src/application.ts"
    local_materialize="$repo_root/packages/trellage-cli/src/materialize.ts"
    local_headless_capabilities="$repo_root/packages/trellage-cli/src/headless-capabilities.ts"
    local_finalize_claude_seed="$repo_root/prototypes/trellage/finalize-claude-seed.mjs"
    [[ -f "$local_trx" && -x "$local_trx" && ! -L "$local_trx" ]] \
      || fail "local trx candidate is missing or unsafe: $local_trx"
    [[ -f "$local_picx" && -x "$local_picx" && ! -L "$local_picx" ]] \
      || fail "local picx candidate is missing or unsafe: $local_picx"
    [[ -f "$local_omp" && -x "$local_omp" && ! -L "$local_omp" ]] \
      || fail "local omp candidate is missing or unsafe: $local_omp"
    [[ -f "$local_omp_catalog" && ! -L "$local_omp_catalog" ]] \
      || fail "local omp catalog candidate is missing or unsafe: $local_omp_catalog"
    [[ -f "$local_prx" && -x "$local_prx" && ! -L "$local_prx" ]] \
      || fail "local prx candidate is missing or unsafe: $local_prx"
    [[ -d "$local_claude_common" && ! -L "$local_claude_common" ]] \
      || fail "local shared Claude candidate is missing or unsafe: $local_claude_common"
    [[ -d "$local_claude_profiles" && ! -L "$local_claude_profiles" ]] \
      || fail "local Claude profile candidate is missing or unsafe: $local_claude_profiles"
    [[ -d "$local_firstmate_profiles" && ! -L "$local_firstmate_profiles" ]] \
      || fail "local Firstmate candidate is missing or unsafe: $local_firstmate_profiles"
    [[ -d "$local_firstmate_guides" && ! -L "$local_firstmate_guides" ]] \
      || fail "local Firstmate guide candidate is missing or unsafe: $local_firstmate_guides"
    [[ -f "$local_guide_ui" && ! -L "$local_guide_ui" ]] \
      || fail "local guide UI candidate is missing or unsafe: $local_guide_ui"
    [[ -f "$local_application" && ! -L "$local_application" ]] \
      || fail "local application candidate is missing or unsafe: $local_application"
    [[ -f "$local_materialize" && ! -L "$local_materialize" ]] \
      || fail "local materialize candidate is missing or unsafe: $local_materialize"
    [[ -f "$local_headless_capabilities" && ! -L "$local_headless_capabilities" ]] \
      || fail "local headless capabilities candidate is missing or unsafe: $local_headless_capabilities"
    [[ -f "$local_finalize_claude_seed" && ! -L "$local_finalize_claude_seed" ]] \
      || fail "local Claude finalizer candidate is missing or unsafe: $local_finalize_claude_seed"
    printf 'azure-fresh-install: applying local unmerged runtime candidates\n' >&2
    scp "${SSH_ARGUMENTS[@]}" "$local_trx" \
      "azureuser@$vm_ip:/tmp/trellage-trx-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_picx" \
      "azureuser@$vm_ip:/tmp/trellage-picx-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_omp" \
      "azureuser@$vm_ip:/tmp/trellage-omp-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_omp_catalog" \
      "azureuser@$vm_ip:/tmp/trellage-omp-catalog-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_prx" \
      "azureuser@$vm_ip:/tmp/trellage-prx-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_application" \
      "azureuser@$vm_ip:/tmp/trellage-application-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_materialize" \
      "azureuser@$vm_ip:/tmp/trellage-materialize-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_headless_capabilities" \
      "azureuser@$vm_ip:/tmp/trellage-headless-capabilities-candidate"
    scp "${SSH_ARGUMENTS[@]}" "$local_finalize_claude_seed" \
      "azureuser@$vm_ip:/tmp/trellage-finalize-claude-seed-candidate"
    tar -C "$repo_root" -czf - \
      prototypes/trellage-claude-common \
      prototypes/trellage-claude-profiles \
      prototypes/trellage-firstmate-profiles \
      profile-guides/native/fmx \
      packages/trellage-launcher/src/guide-ui.tsx \
      | ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" \
        "tar -xzf - -C '$checkout'"
    ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" \
      "install -m 0755 /tmp/trellage-trx-candidate '$checkout/prototypes/trellage-router/bin/trx' \
        && install -m 0755 /tmp/trellage-picx-candidate '$checkout/prototypes/trellage-picx-profiles/bin/picx' \
        && install -m 0755 /tmp/trellage-omp-candidate '$checkout/prototypes/trellage-omp-profiles/bin/omp' \
        && install -m 0644 /tmp/trellage-omp-catalog-candidate '$checkout/prototypes/trellage-omp-profiles/catalog.json' \
        && install -m 0755 /tmp/trellage-prx-candidate '$checkout/prototypes/trellage-prime-profiles/bin/prx' \
        && install -m 0644 /tmp/trellage-application-candidate '$checkout/packages/trellage-cli/src/application.ts' \
        && install -m 0644 /tmp/trellage-materialize-candidate '$checkout/packages/trellage-cli/src/materialize.ts' \
        && install -m 0644 /tmp/trellage-headless-capabilities-candidate '$checkout/packages/trellage-cli/src/headless-capabilities.ts' \
        && install -m 0644 /tmp/trellage-finalize-claude-seed-candidate '$checkout/prototypes/trellage/finalize-claude-seed.mjs' \
        && rm -f /tmp/trellage-trx-candidate /tmp/trellage-picx-candidate /tmp/trellage-omp-candidate /tmp/trellage-omp-catalog-candidate /tmp/trellage-prx-candidate /tmp/trellage-application-candidate /tmp/trellage-materialize-candidate /tmp/trellage-headless-capabilities-candidate /tmp/trellage-finalize-claude-seed-candidate \
        && cd '$checkout/packages/trellage-cli' \
        && npm run build \
        && cd '$checkout/packages/trellage-launcher' \
        && npm run build \
        && cd '$checkout/prototypes/trellage-claude-profiles' \
        && ./install.sh \
        && cd '$checkout/prototypes/trellage-firstmate-profiles' \
        && ./install.sh \
        && cd '$checkout/prototypes/trellage-picx-profiles' \
        && ./install.sh \
        && cd '$checkout/prototypes/trellage-omp-profiles' \
        && ./install.sh \
        && cd '$checkout/prototypes/trellage-prime-profiles' \
        && ./install.sh \
        && cd '$checkout/prototypes/trellage-router' \
        && ./install.sh"
  fi
}

resolve_copilot_token() {
  if [[ -n "${COPILOT_GITHUB_TOKEN:-}" ]]; then
    copilot_token="$COPILOT_GITHUB_TOKEN"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    copilot_token="$GH_TOKEN"
  else
    require_command gh
    copilot_token="$(gh auth token)" \
      || fail "Copilot token unavailable; set COPILOT_GITHUB_TOKEN or authenticate gh"
  fi
  [[ -n "$copilot_token" && "$copilot_token" != *$'\n'* ]] \
    || fail "Copilot token is empty or invalid"
}

resolve_proxy_token() {
  local host_proxy_token="$HOME/.config/copilot-proxy-rs/github_token"

  if [[ -n "${COPILOT_PROXY_GITHUB_TOKEN:-}" ]]; then
    proxy_token="$COPILOT_PROXY_GITHUB_TOKEN"
  elif [[ -f "$host_proxy_token" && ! -L "$host_proxy_token" && -r "$host_proxy_token" ]]; then
    proxy_token="$(<"$host_proxy_token")"
  else
    fail "proxy token unavailable; set COPILOT_PROXY_GITHUB_TOKEN or authenticate copilot-proxy-rs"
  fi
  [[ -n "$proxy_token" && "$proxy_token" != *$'\n'* ]] \
    || fail "proxy token is empty or invalid"
}

accept_once() {
  local attempt="$1"

  printf 'azure-fresh-install: acceptance attempt %s/%s\n' "$attempt" "$attempts" >&2
  {
    printf '%s\n' "$copilot_token"
    printf '%s\n' "$proxy_token"
    cat <<'REMOTE'
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
eval "$(mise activate bash)"
checkout="$HOME/trellage"
proxy_checkout="$HOME/copilot-proxy-rs"
log_dir="$HOME/.local/state/trellage-azure-acceptance"
mkdir -p "$log_dir"
cd "$checkout"

gh_config="/dev/shm/trellage-gh"
if [[ -e "$gh_config" && ( ! -d "$gh_config" || -L "$gh_config" ) ]]; then
  printf 'acceptance: unsafe GitHub CLI configuration path: %s\n' "$gh_config" >&2
  exit 1
fi
install -d -m 700 "$gh_config"
chmod 0700 "$gh_config"
if [[ -e "$gh_config/hosts.yml" || -L "$gh_config/hosts.yml" ]]; then
  if [[ ! -f "$gh_config/hosts.yml" || -L "$gh_config/hosts.yml" ]]; then
    printf 'acceptance: unsafe GitHub CLI hosts path: %s\n' \
      "$gh_config/hosts.yml" >&2
    exit 1
  fi
  rm -f -- "$gh_config/hosts.yml"
fi
cleanup_gh_config() {
  rm -f -- "$gh_config/hosts.yml"
  rmdir "$gh_config" 2>/dev/null || true
}
trap cleanup_gh_config EXIT
printf '%s\n' "$COPILOT_GITHUB_TOKEN" \
  | GH_CONFIG_DIR="$gh_config" gh auth login --hostname github.com --with-token
[[ -f "$gh_config/hosts.yml" && ! -L "$gh_config/hosts.yml" ]]
chmod 0600 "$gh_config/hosts.yml"
export GH_CONFIG_DIR="$gh_config"

proxy_config="/dev/shm/trellage-copilot-proxy"
proxy_override="$log_dir/copilot-proxy.override.yaml"
install -d -m 700 "$proxy_config"
printf '%s\n' "$COPILOT_PROXY_GITHUB_TOKEN" >"$proxy_config/github_token"
chmod 600 "$proxy_config/github_token"
unset COPILOT_PROXY_GITHUB_TOKEN
cat >"$proxy_override" <<EOF
services:
  copilot-proxy-rs:
    environment:
      COPILOT_PROXY_RS_LOG_FAILED_REQUEST_BODIES: "false"
    volumes:
      - type: bind
        source: $proxy_config
        target: /config
        read_only: true
EOF
(
  cd "$proxy_checkout"
  HOST_UID="$(id -u)" HOST_GID="$(id -g)" \
    COPILOT_PROXY_RS_LOG_FAILED_REQUEST_BODIES=false \
    docker compose -f compose.yaml -f "$proxy_override" up -d --build --force-recreate
  HOST_UID="$(id -u)" HOST_GID="$(id -g)" \
    docker compose -f compose.yaml -f "$proxy_override" config --format json \
    >"$log_dir/copilot-proxy.compose.json"
)
jq -e '
  .services["copilot-proxy-rs"]
  | .environment.COPILOT_PROXY_RS_LOG_FAILED_REQUEST_BODIES == "false"
    and any(.volumes[];
      .target == "/config"
      and .source == "/dev/shm/trellage-copilot-proxy"
      and .read_only == true)
    and any(.ports[]; .host_ip == "127.0.0.1" and .published == "8080")
' "$log_dir/copilot-proxy.compose.json" >/dev/null
for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:8080/health >"$log_dir/copilot-proxy.health.json"; then
    break
  fi
  sleep 2
done
curl -fsS http://127.0.0.1:8080/health >/dev/null
curl -fsS http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Reply exactly OK"}]}' \
  >"$log_dir/copilot-proxy.live.json"
jq -e '.choices[0].message.content == "OK"' "$log_dir/copilot-proxy.live.json" >/dev/null

verify_last_text_ok() {
  python3 - "$1" <<'PY'
import pathlib
import re
import sys

ansi = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
lines = [
    ansi.sub("", line).strip()
    for line in pathlib.Path(sys.argv[1]).read_text(errors="replace").splitlines()
]
lines = [line for line in lines if line]
raise SystemExit(0 if lines and lines[-1] == "OK" else 1)
PY
}

run_text_probe() {
  local name="$1"
  shift
  timeout --signal=TERM --kill-after=30s 15m "$@" \
    >"$log_dir/$name.stdout" 2>"$log_dir/$name.stderr"
  verify_last_text_ok "$log_dir/$name.stdout"
}

printf 'acceptance: setting up Native profiles\n'
cpx setup hve
cdx setup pstack
cldx setup
GRX_DISABLE_AUTH_CHECK=1 grx setup superpowers
jcx setup
omp setup copilot
picx setup
prx setup
env -u COPILOT_GITHUB_TOKEN -u COPILOT_PROXY_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN fmx setup default
env -u COPILOT_GITHUB_TOKEN -u COPILOT_PROXY_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN fmx setup pstack-workers

printf 'acceptance: checking Native profiles\n'
cpx doctor hve
cdx doctor pstack
cldx doctor
GRX_DISABLE_AUTH_CHECK=1 grx doctor superpowers
jcx doctor
omp doctor copilot
picx doctor
prx doctor
env -u COPILOT_GITHUB_TOKEN -u COPILOT_PROXY_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN fmx doctor default
env -u COPILOT_GITHUB_TOKEN -u COPILOT_PROXY_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN fmx doctor pstack-workers

trx list --json >"$log_dir/trx-list.json"
jq -e '
  .profiles as $profiles
  |
  [
    ["cpx", "hve"],
    ["cdx", "pstack"],
    ["cldx", "default"],
    ["fmx", "default"],
    ["fmx", "pstack-workers"],
    ["grx", "superpowers"],
    ["jcx", "default"],
    ["omp", "copilot"],
    ["picx", "default"],
    ["prx", "default"]
  ] as $expected
  | $expected
  | map(. as $pair
      | any($profiles[];
          .launcher == $pair[0]
          and .name == $pair[1]))
  | all
' "$log_dir/trx-list.json" >/dev/null
for pair in \
  'cpx hve' \
  'cdx pstack' \
  'cldx default' \
  'fmx default' \
  'fmx pstack-workers' \
  'grx superpowers' \
  'jcx default' \
  'omp copilot' \
  'picx default' \
  'prx default'; do
  read -r launcher profile <<<"$pair"
  if [[ "$launcher" == grx ]]; then
    GRX_DISABLE_AUTH_CHECK=1 trx inventory "$launcher" "$profile" --json \
      >"$log_dir/inventory-$launcher-$profile.json"
  elif [[ "$launcher" == fmx ]]; then
    env -u COPILOT_GITHUB_TOKEN -u COPILOT_PROXY_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN \
      trx inventory "$launcher" "$profile" --json \
      >"$log_dir/inventory-$launcher-$profile.json"
  else
    trx inventory "$launcher" "$profile" --json \
      >"$log_dir/inventory-$launcher-$profile.json"
  fi
  jq -e --arg launcher "$launcher" --arg profile "$profile" '
    .launcher == $launcher
    and .profile == $profile
    and .readiness == "healthy"
  ' "$log_dir/inventory-$launcher-$profile.json" >/dev/null
  if [[ "$launcher" == fmx ]]; then
    jq -e '
      .source.repository == "https://github.com/kunchenguid/firstmate.git"
      and .source.pinnedCommit == "4ad8cbaeafc109a17c1af3911867b7fe9e04e801"
      and .source.installedCommit == "4ad8cbaeafc109a17c1af3911867b7fe9e04e801"
      and .source.commitMatchesPin == true
      and .overlay.commit == "4ad8cbaeafc109a17c1af3911867b7fe9e04e801"
      and .overlay.digestAlgorithm == "sha256"
      and .overlay.manifestDigest == "38e643de4abebbeae177046cc0a6caaec7f27615752fbaf24bc65baafe8c1db6"
      and .overlay.contentDigest == "4be7288cc1fade834f00cca3e5e17c147e01211ca37db52a1629a95547bfda56"
      and .overlay.fileCount == 4
      and .overlay.verified == true
    ' "$log_dir/inventory-$launcher-$profile.json" >/dev/null
  fi
done

timeout --signal=TERM --kill-after=30s 15m \
  trx run cpx hve -- \
  --prompt 'Reply exactly OK. Do not use tools.' \
  --output-format json \
  --disable-builtin-mcps \
  --available-tools= \
  --no-remote \
  --no-remote-export \
  --no-auto-update \
  --stream off \
  >"$log_dir/native-cpx.jsonl" 2>"$log_dir/native-cpx.stderr"
jq -Rse '
  [split("\n")[] | fromjson?
    | select(
        .type == "assistant.message"
        and (.data.content | type == "string")
        and .data.content != "")
    | .data.content
  ][-1] == "OK"
' "$log_dir/native-cpx.jsonl" >/dev/null

run_text_probe native-cdx \
  env TRELLAGE_AUTOMATION=1 \
  trx run cdx pstack -- exec 'Reply exactly OK. Do not use tools.'

timeout --signal=TERM --kill-after=30s 15m \
  trx run cldx default -- \
  --model claude-opus-5 \
  --tools '' \
  --output-format stream-json \
  --verbose \
  -p 'Reply exactly OK. Do not use tools.' \
  >"$log_dir/native-cldx.jsonl" 2>"$log_dir/native-cldx.stderr"
jq -Rse '
  [split("\n")[] | fromjson? | select(.type == "result")][-1] as $result
  | $result.subtype == "success"
    and $result.is_error == false
    and $result.result == "OK"
' "$log_dir/native-cldx.jsonl" >/dev/null

run_text_probe native-grx \
  env GRX_DISABLE_AUTH_CHECK=1 \
  trx run grx superpowers -- -p 'Reply exactly OK. Do not use tools.'

timeout --signal=TERM --kill-after=30s 15m \
  trx run jcx default -- run \
  --json \
  --quiet \
  --tool-profile none \
  'Reply exactly OK. Do not use tools.' \
  >"$log_dir/native-jcx.json" 2>"$log_dir/native-jcx.stderr"
jq -e '.text == "OK"' "$log_dir/native-jcx.json" >/dev/null

run_text_probe native-omp \
  trx run omp copilot -- \
  --headless-policy no-user-input \
  -p 'Reply exactly OK. Do not use tools.'

run_text_probe native-picx \
  trx run picx default -- -p 'Reply exactly OK. Do not use tools.'

run_text_probe native-prx \
  trx run prx default -- --single-turn -p 'Reply exactly OK. Do not use tools.'
prx shutdown >"$log_dir/native-prx-shutdown.stdout" \
  2>"$log_dir/native-prx-shutdown.stderr"

timeout --signal=TERM --kill-after=30s 45m \
  trellage build claude-council \
  >"$log_dir/sandbox-claude-council-build.stdout" \
  2>"$log_dir/sandbox-claude-council-build.stderr"
timeout --signal=TERM --kill-after=30s 30m \
  trellage --profile claude-council \
  --output-format jsonl \
  --trellage-events \
  -p 'Reply exactly OK. Do not use tools.' \
  >"$log_dir/sandbox-claude-council.jsonl" \
  2>"$log_dir/sandbox-claude-council.stderr"
jq -Rse '
  [split("\n")[] | fromjson? | select(.type == "trellage.result")][-1] as $result
  | $result.outcome == "success"
    and $result.finalText == "OK"
    and $result.sessionIdConsistent == true
' "$log_dir/sandbox-claude-council.jsonl" >/dev/null
docker network inspect copilot-proxy-rs_default \
  >"$log_dir/copilot-proxy.network.json"

printf 'acceptance: PASS\n'
REMOTE
  } | ssh "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip" \
    'set -e; IFS= read -r COPILOT_GITHUB_TOKEN; IFS= read -r COPILOT_PROXY_GITHUB_TOKEN; export COPILOT_GITHUB_TOKEN COPILOT_PROXY_GITHUB_TOKEN; script_file="$(mktemp)"; trap '\''rm -f -- "$script_file"'\'' EXIT; cat >"$script_file"; bash "$script_file" </dev/null'
}

accept_vm() {
  local attempt status=1

  load_state
  ssh_arguments
  resolve_copilot_token
  resolve_proxy_token
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if accept_once "$attempt"; then
      status=0
      break
    else
      status=$?
    fi
    printf 'azure-fresh-install: attempt %s failed with status %s\n' "$attempt" "$status" >&2
    (( attempt < attempts )) && sleep 15
  done
  unset copilot_token proxy_token
  (( status == 0 )) \
    || fail "acceptance failed after $attempts attempts; inspect $checkout/.local state through '$0 ssh'"
}

collect_evidence() {
  local arg evidence_dir rsync_ssh=ssh

  load_state
  ssh_arguments
  for arg in "${SSH_ARGUMENTS[@]}"; do
    printf -v rsync_ssh '%s %q' "$rsync_ssh" "$arg"
  done
  evidence_dir="$state_dir/evidence/$resource_group"
  mkdir -p "$evidence_dir"
  chmod 700 "$state_dir/evidence" "$evidence_dir"
  rsync -az \
    -e "$rsync_ssh" \
    "azureuser@$vm_ip:/home/azureuser/.local/state/trellage-azure-acceptance/" \
    "$evidence_dir/"
  printf 'azure-fresh-install: evidence saved: %s\n' "$evidence_dir" >&2
}

show_status() {
  require_command az
  load_state true
  az vm get-instance-view \
    --subscription "$subscription_id" \
    --resource-group "$resource_group" \
    --name "$vm_name" \
    --query "{resourceGroup:'$resource_group',publicIp:'$vm_ip',powerState:instanceView.statuses[?starts_with(code, 'PowerState/')].displayStatus | [0]}" \
    -o table
}

delete_vm() {
  require_command az
  load_state true
  printf 'azure-fresh-install: deleting resource group %s\n' "$resource_group" >&2
  az group delete \
    --subscription "$subscription_id" \
    --name "$resource_group" \
    --yes
  rm -f -- "$state_file" "$known_hosts"
}

open_ssh() {
  load_state
  ssh_arguments
  exec ssh -t "${SSH_ARGUMENTS[@]}" "azureuser@$vm_ip"
}

all_failure() {
  local status="$1"

  trap - ERR EXIT
  if [[ -f "$state_file" && ! -L "$state_file" ]]; then
    load_state true
    printf 'azure-fresh-install: FAILED; resource group retained: %s\n' "$resource_group" >&2
    [[ -z "$vm_ip" ]] \
      || printf 'azure-fresh-install: inspect with: %s ssh\n' "$0" >&2
    printf 'azure-fresh-install: retry with: %s bootstrap; %s accept\n' "$0" "$0" >&2
    printf 'azure-fresh-install: clean up with: %s down\n' "$0" >&2
  fi
  exit "$status"
}

case "$command_name" in
  plan)
    print_plan
    ;;
  create)
    create_vm
    ;;
  bootstrap)
    bootstrap_vm
    ;;
  accept)
    accept_vm
    collect_evidence
    ;;
  ssh)
    open_ssh
    ;;
  status)
    show_status
    ;;
  down)
    delete_vm
    ;;
  all)
    trap 'all_failure $?' EXIT
    create_vm
    bootstrap_vm
    accept_vm
    collect_evidence
    completed_resource_group="$resource_group"
    delete_vm
    trap - EXIT
    printf 'azure-fresh-install: COMPLETE; deleted resource group: %s\n' "$completed_resource_group"
    ;;
esac
