#!/usr/bin/env bash
# Post-merge / heavy-dev refresh for Trellage:
#   1. Install worktree trellage CLI (optional)
#   2. Reinstall every native launcher + trx from this worktree
#   3. Rebuild every sandbox development profile OCI image
#
# Native install order matches prototypes/trellage-router/README.md:
# launchers first, router last. Any additional prototypes/trellage-*-profiles
# packages are installed after the known set and before trx.
set -euo pipefail

fail() {
  printf 'rebuild-profile-images: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  scripts/rebuild-profile-images.sh [options] [PROFILE...]

  --install         Install ~/.local/bin/trellage from this worktree first
  --native-only     Only refresh native launchers + trx (skip sandbox images)
  --sandbox-only    Only rebuild sandbox profile images (skip native reinstall)
  --locked          Use an existing release lock for sandbox images
  --fallback        With --locked, on digest mismatch retry as a development build
  PROFILE...        Optional bare profile names (default: every profiles/*/profile.toml)

Default: reinstall native launchers + trx, then development sandbox rebuilds.

Examples:
  mise run rebuild-profiles
  mise run rebuild-native-profiles
  scripts/rebuild-profile-images.sh --install
  scripts/rebuild-profile-images.sh --native-only
  scripts/rebuild-profile-images.sh --sandbox-only prime-agent
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
trellage="$repo_root/prototypes/trellage/trellage"
installer="$repo_root/prototypes/trellage/install-trellage.sh"
profiles_dir="$repo_root/profiles"
prototypes_dir="$repo_root/prototypes"

[[ -d "$prototypes_dir" ]] || fail "prototypes directory missing: $prototypes_dir"

do_install=0
do_native=1
do_sandbox=1
use_locked=0
allow_fallback=0
requested=()

while (( $# > 0 )); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --install)
      do_install=1
      shift
      ;;
    --native-only)
      do_native=1
      do_sandbox=0
      shift
      ;;
    --sandbox-only)
      do_native=0
      do_sandbox=1
      shift
      ;;
    --locked)
      use_locked=1
      shift
      ;;
    --fallback)
      allow_fallback=1
      shift
      ;;
    --no-fallback)
      allow_fallback=0
      shift
      ;;
    --)
      shift
      requested+=("$@")
      break
      ;;
    -*)
      fail "unknown option: $1 (try --help)"
      ;;
    *)
      requested+=("$1")
      shift
      ;;
  esac
done

if (( allow_fallback == 1 && use_locked == 0 )); then
  fail "--fallback requires --locked"
fi
if (( do_native == 0 && do_sandbox == 0 )); then
  fail "nothing to do (both native and sandbox disabled)"
fi

if (( do_install == 1 )); then
  [[ -x "$installer" ]] || fail "installer missing or not executable: $installer"
  printf 'rebuild-profile-images: installing worktree trellage CLI\n' >&2
  "$installer" install
fi

# --- Native launchers + trx -------------------------------------------------

# Preferred install order from router README; unknown packages append before trx.
known_native_packages=(
  trellage-codex-profiles
  trellage-copilot-profiles
  trellage-agency-profiles
  trellage-claude-profiles
  trellage-firstmate-profiles
  trellage-grok-profiles
  trellage-jcode-profiles
  trellage-omp-profiles
  trellage-picx-profiles
  trellage-prime-profiles
)

is_known_native_package() {
  local candidate="$1" pkg
  for pkg in "${known_native_packages[@]}"; do
    [[ "$pkg" == "$candidate" ]] && return 0
  done
  return 1
}

list_native_packages() {
  local pkg name
  for pkg in "${known_native_packages[@]}"; do
    if [[ -x "$prototypes_dir/$pkg/install.sh" ]]; then
      printf '%s\n' "$pkg"
    fi
  done
  # Any new trellage-*-profiles package not in the preferred list.
  for name in "$prototypes_dir"/trellage-*-profiles; do
    [[ -d "$name" ]] || continue
    pkg="$(basename "$name")"
    is_known_native_package "$pkg" && continue
    [[ -x "$name/install.sh" ]] || continue
    printf '%s\n' "$pkg"
  done
}

install_native_stack() {
  local pkg install_script status=0
  local -a packages=()
  local -a failed_packages=()

  while IFS= read -r pkg; do
    [[ -n "$pkg" ]] || continue
    packages+=("$pkg")
  done < <(list_native_packages)

  (( ${#packages[@]} > 0 )) \
    || fail "no native launcher packages found under $prototypes_dir/trellage-*-profiles"

  printf 'rebuild-profile-images: reinstalling %d native launcher package(s)\n' \
    "${#packages[@]}" >&2

  for pkg in "${packages[@]}"; do
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

  printf 'rebuild-profile-images: verifying native commands on PATH\n' >&2
  local cmd resolved runtime
  for cmd in cdx cpx agx cldx fmx grx jcx omp picx prx trx; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      printf 'rebuild-profile-images: missing required command on PATH: %s\n' "$cmd" >&2
      status=1
      continue
    fi
    resolved="$(command -v "$cmd")"
    if [[ -L "$resolved" ]]; then
      runtime="$(readlink "$resolved" 2>/dev/null || true)"
      printf 'rebuild-profile-images: %s -> %s\n' "$cmd" "$runtime" >&2
    else
      printf 'rebuild-profile-images: %s -> %s\n' "$cmd" "$resolved" >&2
    fi
  done

  if command -v trx >/dev/null 2>&1; then
    # Best-effort catalog sanity; do not require TTY.
    if trx --help >/dev/null 2>&1; then
      printf 'rebuild-profile-images: trx --help ok\n' >&2
    fi
  fi

  return "$status"
}

# --- Sandbox profile images -------------------------------------------------

discover_profiles() {
  local dir name
  for dir in "$profiles_dir"/*/; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    [[ -f "$dir/profile.toml" ]] || continue
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

build_sandbox_images() {
  local name profile_path log status mode_label
  local -a profiles=()
  local -a failed=()
  local -a fallback_used=()
  local -a built=()

  [[ -x "$trellage" ]] || fail "trellage launcher missing or not executable: $trellage"
  [[ -d "$profiles_dir" ]] || fail "profiles directory missing: $profiles_dir"

  if (( ${#requested[@]} > 0 )); then
    for name in "${requested[@]}"; do
      [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
        || fail "unsafe profile name: $name"
      [[ -f "$profiles_dir/$name/profile.toml" ]] \
        || fail "profile not found: $profiles_dir/$name/profile.toml"
      profiles+=("$name")
    done
  else
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      profiles+=("$name")
    done < <(discover_profiles)
  fi

  (( ${#profiles[@]} > 0 )) || fail "no profiles to rebuild under $profiles_dir"

  if (( use_locked == 1 )); then
    printf 'rebuild-profile-images: sandbox mode=release-locked\n' >&2
  else
    printf 'rebuild-profile-images: sandbox mode=development\n' >&2
  fi
  printf 'rebuild-profile-images: rebuilding %d sandbox profile(s)\n' "${#profiles[@]}" >&2

  for name in "${profiles[@]}"; do
    profile_path="$profiles_dir/$name/profile.toml"
    if (( use_locked == 1 )); then
      mode_label='build --locked'
    else
      mode_label='build'
    fi
    printf 'rebuild-profile-images: === sandbox %s (%s) ===\n' "$name" "$mode_label" >&2
    log="$(mktemp "${TMPDIR:-/tmp}/trellage-rebuild.$name.XXXXXX")"
    status=0
    set +e
    if (( use_locked == 1 )); then
      "$trellage" build --locked "$profile_path" 2>&1 | tee "$log"
    else
      "$trellage" build "$profile_path" 2>&1 | tee "$log"
    fi
    status=${PIPESTATUS[0]}
    set -e
    if (( status == 0 )); then
      rm -f -- "$log"
      built+=("$name")
      continue
    fi

    if (( use_locked == 1 && allow_fallback == 1 )) \
      && grep -Fq 'locked OCI digest mismatch' "$log"; then
      printf \
        'rebuild-profile-images: %s locked digest mismatch; rebuilding without --locked\n' \
        "$name" >&2
      set +e
      "$trellage" build "$profile_path" 2>&1 | tee -a "$log"
      status=${PIPESTATUS[0]}
      set -e
      if (( status == 0 )); then
        rm -f -- "$log"
        built+=("$name")
        fallback_used+=("$name")
        continue
      fi
    fi

    printf 'rebuild-profile-images: FAILED sandbox %s (log: %s)\n' "$name" "$log" >&2
    failed+=("$name")
  done

  printf 'rebuild-profile-images: sandbox built %d/%d\n' "${#built[@]}" "${#profiles[@]}" >&2
  if (( ${#fallback_used[@]} > 0 )); then
    printf 'rebuild-profile-images: locked fallback used for: %s\n' "${fallback_used[*]}" >&2
  fi
  if (( ${#failed[@]} > 0 )); then
    printf 'rebuild-profile-images: sandbox failed: %s\n' "${failed[*]}" >&2
    return 1
  fi
  return 0
}

overall=0

if (( do_native == 1 )); then
  install_native_stack || overall=1
fi

if (( do_sandbox == 1 )); then
  build_sandbox_images || overall=1
fi

if (( overall != 0 )); then
  fail "one or more refresh steps failed"
fi

printf 'rebuild-profile-images: ok\n' >&2
