#!/usr/bin/env bash
# Minimal lifecycle for running GitHub Copilot CLI inside Azure Container
# Instances (ACI), working against a local project folder.
#
#   ./run.sh up <local-folder>   # sync folder up, build image, start container
#   ./run.sh attach              # interactive Copilot CLI session (PTY)
#   ./run.sh sync                # pull container changes back to the local folder
#   ./run.sh down                # sync down, then delete everything this script created
#
# IMPORTANT: ACI containers do not run on your machine, so there is no live
# bind mount. This script mirrors <local-folder> into an Azure File Share,
# mounts that share into the container at /workspace, and copies the share's
# contents back to <local-folder> on `sync` / `down` / `attach` exit. Changes
# made inside the container appear locally after a sync, not continuously.
#
# Requires: az CLI logged in (`az login`), gh CLI logged in (`gh auth login`)
# or GH_TOKEN set to a token with Copilot access.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_file="$script_dir/.aci-copilot-state"

RG="${RG:-copilot-aci-demo-rg}"
LOCATION="${LOCATION:-eastus2}"
CONTAINER_NAME="${CONTAINER_NAME:-copilot-cli}"
IMAGE_TAG="${IMAGE_TAG:-v1}"
FILE_SHARE_NAME="${FILE_SHARE_NAME:-workspace}"

fail() {
  printf 'run.sh: %s\n' "$1" >&2
  exit 1
}

# Files that should never be uploaded to Azure regardless of .gitignore
# (build artifacts, VCS internals, editor/OS cruft). Used as the fallback
# for folders that are not git repos; git repos additionally get real
# .gitignore-aware filtering via `git ls-files`.
DEFAULT_EXCLUDES=(
  ".git" "node_modules" "target" "dist" "build" "__pycache__"
  ".venv" "venv" ".DS_Store" "*.pyc" ".next" ".cache"
)

# Copies $1 (source folder) into $2 (empty staging dir), skipping anything
# git-ignored (for git repos) or matching DEFAULT_EXCLUDES (for everything
# else). This is what actually gets uploaded to the Azure File Share, so
# things like target/, node_modules/, and .git/ never leave your machine.
stage_folder() {
  local src="$1" dest="$2"
  mkdir -p "$dest"
  if git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "==> staging: git repo detected, respecting .gitignore"
    (cd "$src" && git ls-files -z --cached --others --exclude-standard) \
      | tar -C "$src" --null -T - -cf - \
      | tar -C "$dest" -xf -
  else
    echo "==> staging: not a git repo, excluding common build/VCS folders"
    local exclude_args=()
    local pattern
    for pattern in "${DEFAULT_EXCLUDES[@]}"; do
      exclude_args+=(--exclude="$pattern")
    done
    rsync -a "${exclude_args[@]}" "$src"/ "$dest"/
  fi
}

load_state() { [[ -f "$state_file" ]] && source "$state_file"; }
save_state() {
  {
    printf 'ACR_NAME=%q\n' "$ACR_NAME"
    printf 'STORAGE_ACCOUNT=%q\n' "$STORAGE_ACCOUNT"
    printf 'LOCAL_FOLDER=%q\n' "$LOCAL_FOLDER"
  } >"$state_file"
}

sync_down() {
  load_state
  [[ -n "${STORAGE_ACCOUNT:-}" ]] || fail "no state found; run '$0 up <folder>' first"
  local key
  key="$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --resource-group "$RG" --query '[0].value' -o tsv)"

  if command -v azcopy >/dev/null 2>&1; then
    # azcopy sync only transfers files that are new or changed (by size +
    # last-modified time), unlike `az storage file download-batch`, which
    # unconditionally re-copies everything on every run. No delete flag is
    # passed, so local-only files (e.g. gitignored build artifacts that
    # were never uploaded) are never removed.
    echo "==> syncing changed files back to $LOCAL_FOLDER (azcopy, incremental)"
    local expiry sas
    expiry="$(date -u -v+2H '+%Y-%m-%dT%H:%MZ' 2>/dev/null || date -u -d '+2 hours' '+%Y-%m-%dT%H:%MZ')"
    sas="$(az storage share generate-sas --account-name "$STORAGE_ACCOUNT" --account-key "$key" \
      --name "$FILE_SHARE_NAME" --permissions rl --expiry "$expiry" -o tsv)"
    azcopy sync "https://$STORAGE_ACCOUNT.file.core.windows.net/$FILE_SHARE_NAME?$sas" \
      "$LOCAL_FOLDER" --recursive=true
  else
    echo "==> syncing container changes back to $LOCAL_FOLDER (full copy; install" \
         "azcopy for incremental sync: brew install azcopy)"
    az storage file download-batch \
      --account-name "$STORAGE_ACCOUNT" --account-key "$key" \
      --destination "$LOCAL_FOLDER" --source "$FILE_SHARE_NAME" -o none
  fi
}

cmd_up() {
  local folder="${1:-}"
  [[ -n "$folder" ]] || fail "usage: $0 up <local-folder>"
  [[ -d "$folder" ]] || fail "folder does not exist: $folder"
  folder="$(cd "$folder" && pwd)"

  command -v az >/dev/null 2>&1 || fail "Azure CLI (az) is required"
  az account show >/dev/null 2>&1 || fail "run 'az login' first"

  local gh_token="${GH_TOKEN:-}"
  if [[ -z "$gh_token" ]] && command -v gh >/dev/null 2>&1; then
    gh_token="$(gh auth token 2>/dev/null || true)"
  fi
  [[ -n "$gh_token" ]] || fail "set GH_TOKEN or run 'gh auth login' first"

  local acr_name="${ACR_NAME:-copilotacidemo$RANDOM}"
  local storage_account="${STORAGE_ACCOUNT:-copilotacidemo$RANDOM}"
  ACR_NAME="$acr_name"
  STORAGE_ACCOUNT="$storage_account"
  LOCAL_FOLDER="$folder"

  echo "==> creating resource group $RG in $LOCATION"
  az group create -n "$RG" -l "$LOCATION" -o none

  echo "==> creating storage account $storage_account (holds the mirrored folder)"
  az storage account create -n "$storage_account" -g "$RG" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 -o none

  local storage_key
  storage_key="$(az storage account keys list --account-name "$storage_account" --resource-group "$RG" --query '[0].value' -o tsv)"

  echo "==> creating file share $FILE_SHARE_NAME"
  az storage share create --account-name "$storage_account" --account-key "$storage_key" \
    --name "$FILE_SHARE_NAME" -o none

  local staging_dir
  staging_dir="$(mktemp -d)"
  trap 'rm -rf "$staging_dir"' RETURN
  stage_folder "$folder" "$staging_dir"

  echo "==> uploading $folder to the file share (git-ignored / build artifacts excluded)"
  az storage file upload-batch \
    --account-name "$storage_account" --account-key "$storage_key" \
    --destination "$FILE_SHARE_NAME" --source "$staging_dir" -o none

  echo "==> creating container registry $acr_name"
  az acr create -n "$acr_name" -g "$RG" --sku Basic --admin-enabled true -o none

  echo "==> building image in Azure (no local Docker required)"
  az acr build --registry "$acr_name" --resource-group "$RG" \
    --image "copilot-cli:$IMAGE_TAG" "$script_dir" -o none

  local acr_user acr_pass
  acr_user="$(az acr credential show -n "$acr_name" --query username -o tsv)"
  acr_pass="$(az acr credential show -n "$acr_name" --query 'passwords[0].value' -o tsv)"

  echo "==> starting container $CONTAINER_NAME with $folder mounted at /workspace"
  az container create \
    --resource-group "$RG" \
    --name "$CONTAINER_NAME" \
    --image "$acr_name.azurecr.io/copilot-cli:$IMAGE_TAG" \
    --cpu 2 --memory 4 \
    --os-type Linux \
    --location "$LOCATION" \
    --restart-policy Never \
    --registry-login-server "$acr_name.azurecr.io" \
    --registry-username "$acr_user" \
    --registry-password "$acr_pass" \
    --secure-environment-variables "COPILOT_GITHUB_TOKEN=$gh_token" \
    --azure-file-volume-account-name "$storage_account" \
    --azure-file-volume-account-key "$storage_key" \
    --azure-file-volume-share-name "$FILE_SHARE_NAME" \
    --azure-file-volume-mount-path /workspace \
    --command-line "tail -f /dev/null" \
    -o none

  save_state
  echo "==> ready. Run: $0 attach"
}

cmd_attach() {
  load_state
  [[ -n "${STORAGE_ACCOUNT:-}" ]] || fail "no state found; run '$0 up <folder>' first"
  echo "==> attaching (working directory: /workspace, mirrors $LOCAL_FOLDER)"
  az container exec --resource-group "$RG" --name "$CONTAINER_NAME" --exec-command "copilot"
  echo "==> session ended"
  sync_down
  echo "==> local folder $LOCAL_FOLDER now reflects container changes"
}

cmd_sync() {
  sync_down
}

cmd_down() {
  load_state
  if [[ -n "${STORAGE_ACCOUNT:-}" ]]; then
    sync_down || echo "==> warning: could not sync before teardown" >&2
  fi
  echo "==> deleting container $CONTAINER_NAME (if present)"
  az container delete --resource-group "$RG" --name "$CONTAINER_NAME" --yes >/dev/null 2>&1 || true

  echo "==> deleting resource group $RG"
  # --no-wait submits the delete request and returns almost instantly, but
  # the actual teardown (ACR, ACI, storage account) keeps running on Azure's
  # side for anywhere from several seconds to a few minutes. Poll until it
  # is actually gone instead of reporting success prematurely.
  az group delete --name "$RG" --yes --no-wait
  rm -f "$state_file"

  local waited=0
  local timeout=300
  echo -n "==> waiting for deletion to finish"
  while az group exists --name "$RG" | grep -qi true; do
    if (( waited >= timeout )); then
      echo
      echo "==> still deleting after ${timeout}s; Azure is finishing this in the" \
           "background. Confirm later with: az group exists --name $RG"
      return 0
    fi
    echo -n "."
    sleep 5
    waited=$((waited + 5))
  done
  echo
  echo "==> confirmed: resource group $RG deleted (took ~${waited}s)"
}

case "${1:-}" in
  up) cmd_up "${2:-}" ;;
  attach) cmd_attach ;;
  sync) cmd_sync ;;
  down) cmd_down ;;
  *)
    echo "usage: $0 {up <local-folder>|attach|sync|down}" >&2
    exit 1
    ;;
esac
