#!/usr/bin/env bash
# Post-merge / heavy-dev refresh for Trellage Native.
# Reinstall the six launch-required lifecycle backends, then trx.
set -euo pipefail

fail() {
  printf 'rebuild-profile-images: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/rebuild-profile-images.sh

Reinstall the six launch-required Native backends and trx from this worktree,
then verify the public trx router and each owned backend.

Examples:
  mise run rebuild-profiles
  scripts/rebuild-profile-images.sh
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
. "$repo_root/scripts/bun-runtime.sh"
prototypes_dir="$repo_root/prototypes"
original_args=("$@")

while (( $# > 0 )); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1 (try --help)"
      ;;
  esac
done

[[ -d "$prototypes_dir" ]] || fail "prototypes directory missing: $prototypes_dir"

if (( ${#original_args[@]} > 0 )); then
  trellage_ensure_bun_runtime "$repo_root" "$repo_root/scripts/rebuild-profile-images.sh" "${original_args[@]}"
else
  trellage_ensure_bun_runtime "$repo_root" "$repo_root/scripts/rebuild-profile-images.sh"
fi

# --- Native lifecycle backends + trx ----------------------------------------

native_packages=(
  trellage-copilot-profiles
  trellage-agency-profiles
  trellage-claude-profiles
  trellage-jcode-profiles
  trellage-omp-profiles
  trellage-prime-profiles
)

install_native_stack() {
  local pkg install_script status=0
  local -a failed_packages=()

  printf 'rebuild-profile-images: reinstalling %d native backend package(s)\n' \
    "${#native_packages[@]}" >&2

  for pkg in "${native_packages[@]}"; do
    install_script="$prototypes_dir/$pkg/install.sh"
    printf 'rebuild-profile-images: === native %s ===\n' "$pkg" >&2
    if ! (
      cd "$prototypes_dir/$pkg"
      ./install.sh
    ); then
      printf 'rebuild-profile-images: FAILED native install: %s\n' "$pkg" >&2
      failed_packages+=("$pkg")
      status=1
    fi
  done

  if [[ -x "$prototypes_dir/trellage-router/install.sh" ]]; then
    printf 'rebuild-profile-images: === native trellage-router (trx) ===\n' >&2
    if ! (
      cd "$prototypes_dir/trellage-router"
      ./install.sh
    ); then
      printf 'rebuild-profile-images: FAILED native install: trellage-router\n' >&2
      failed_packages+=("trellage-router")
      status=1
    fi
  else
    fail "trellage-router install.sh missing: $prototypes_dir/trellage-router/install.sh"
  fi

  if (( status != 0 )); then
    printf 'rebuild-profile-images: native install failures: %s\n' "${failed_packages[*]}" >&2
    return 1
  fi

  printf 'rebuild-profile-images: verifying public trx and owned backends\n' >&2
  if ! command -v trx >/dev/null 2>&1; then
    printf 'rebuild-profile-images: missing required command on PATH: trx\n' >&2
    status=1
  elif trx --help >/dev/null 2>&1; then
    printf 'rebuild-profile-images: trx --help ok\n' >&2
  else
    printf 'rebuild-profile-images: trx --help failed\n' >&2
    status=1
  fi

  local record cmd package version runtime marker ownership
  for record in 'cpx copilot v1' 'agx agency v1' 'cldx claude v1' \
    'jcx jcode v1' 'omp omp v2' 'prx prime v1'; do
    read -r cmd package version <<<"$record"
    runtime="$HOME/.local/share/trellage/$cmd"
    marker="trellage-$package-profiles"
    [[ "$cmd" != cpx ]] || marker=trellage-profiles
    ownership="$runtime/.managed-by-$marker"
    if [[ ! -d "$runtime" || -L "$runtime" || -L "$runtime/bin" \
      || ! -f "$runtime/bin/$cmd" || -L "$runtime/bin/$cmd" || ! -x "$runtime/bin/$cmd" ]]; then
      printf 'rebuild-profile-images: missing or unsafe private backend: %s\n' "$cmd" >&2
      status=1
    elif [[ ! -f "$ownership" || -L "$ownership" \
      || "$(<"$ownership")" != "$marker-$version" ]]; then
      printf 'rebuild-profile-images: invalid private backend ownership: %s\n' "$cmd" >&2
      status=1
    else
      printf 'rebuild-profile-images: private backend %s -> %s/bin/%s\n' "$cmd" "$runtime" "$cmd" >&2
    fi
  done

  return "$status"
}

install_native_stack || fail "one or more refresh steps failed"

printf 'rebuild-profile-images: ok\n' >&2
