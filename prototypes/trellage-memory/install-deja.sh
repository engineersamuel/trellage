#!/usr/bin/env bash
set -u -o pipefail

readonly DEJA_VERSION='0.17.0'
readonly RELEASE_BASE='https://github.com/vshulcz/deja-vu/releases/download/v0.17.0'

warn() {
  printf 'deja installer: %s\n' "$*" >&2
}

if stat -c '%u' / >/dev/null 2>&1; then
  stat_owner() { stat -c '%u' "$1"; }
  stat_mode() { stat -c '%a' "$1"; }
else
  stat_owner() { stat -f '%u' "$1"; }
  stat_mode() { stat -f '%Lp' "$1"; }
fi

platform() {
  case "$(uname -s):$(uname -m)" in
    Linux:aarch64|Linux:arm64) printf '%s\n' 'linux_arm64' ;;
    Linux:x86_64|Linux:amd64) printf '%s\n' 'linux_amd64' ;;
    Darwin:arm64|Darwin:aarch64) printf '%s\n' 'darwin_arm64' ;;
    Darwin:x86_64|Darwin:amd64) printf '%s\n' 'darwin_amd64' ;;
    *) warn 'unsupported operating system or architecture'; return 1 ;;
  esac
}

real_home() {
  local candidate
  for candidate in \
    "${TRELLAGE_MEMORY_REAL_HOME:-}" \
    "${TRELLAGE_REAL_HOME:-}" \
    "${TRELLAGE_HOST_HOME:-}" \
    "${HOME:-}"; do
    if [[ -n "$candidate" && "$candidate" == /* ]]; then
      printf '%s\n' "${candidate%/}"
      return 0
    fi
  done
  warn 'no absolute user home is available'
  return 1
}

no_symlink_ancestors() {
  local path="$1" component current=''
  local -a pieces

  [[ "$path" == /* ]] || return 1
  IFS=/ read -r -a pieces <<< "${path#/}"
  for component in "${pieces[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    [[ ! -L "$current" ]] || {
      warn 'an installation parent is a symbolic link'
      return 1
    }
  done
}

safe_user_dir() {
  local path="$1" owner mode
  no_symlink_ancestors "$path" || return 1
  [[ -d "$path" && ! -L "$path" ]] || {
    warn 'an installation parent is unsafe'
    return 1
  }
  owner="$(stat_owner "$path")" || return 1
  mode="$(stat_mode "$path")" || return 1
  [[ "$owner" == "$(id -u)" ]] && (( (8#$mode & 8#022) == 0 )) || {
    warn 'an installation parent is not private to this user'
    return 1
  }
}

ensure_user_dir() {
  local path="$1"
  safe_user_dir "$(dirname "$path")" || return 1
  if [[ -e "$path" || -L "$path" ]]; then
    safe_user_dir "$path"
  else
    mkdir -m 700 "$path" 2>/dev/null || {
      warn 'cannot create an installation parent'
      return 1
    }
    safe_user_dir "$path"
  fi
}

ensure_private_dir() {
  local path="$1" owner mode
  ensure_user_dir "$path" || return 1
  [[ ! -L "$path" ]] || {
    warn 'a managed installation directory is a symbolic link'
    return 1
  }
  owner="$(stat_owner "$path")" || return 1
  chmod 700 "$path" 2>/dev/null || {
    warn 'cannot secure a managed installation directory'
    return 1
  }
  mode="$(stat_mode "$path")" || return 1
  [[ "$owner" == "$(id -u)" && "$mode" == '700' ]] || {
    warn 'a managed installation directory is unsafe'
    return 1
  }
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_size() {
  wc -c < "$1" | tr -d '[:space:]'
}

select_artifact() {
  case "$1" in
    linux_arm64)
      ARTIFACT='deja-vu_0.17.0_linux_arm64.tar.gz'
      ARTIFACT_SHA='e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1'
      ARTIFACT_SIZE='4364290'
      ;;
    linux_amd64)
      ARTIFACT='deja-vu_0.17.0_linux_amd64.tar.gz'
      ARTIFACT_SHA='1d176d47d3a6990dbb74a91086a6a9099fe7c3461e4d196718ef8a7d51570d78'
      ARTIFACT_SIZE='4796137'
      ;;
    darwin_arm64)
      ARTIFACT='deja-vu_0.17.0_darwin_arm64.tar.gz'
      ARTIFACT_SHA='17daa4e2036191ce87e41b47154785ae3b59c537fe89c1606eb476ba540799b4'
      ARTIFACT_SIZE='4509436'
      ;;
    darwin_amd64)
      ARTIFACT='deja-vu_0.17.0_darwin_amd64.tar.gz'
      ARTIFACT_SHA='a45650cf5041da49cd318577ce674be919b414d6994aab5615c529df31c349b2'
      ARTIFACT_SIZE='4852970'
      ;;
    *) warn 'unsupported release platform'; return 1 ;;
  esac
}

valid_install() {
  local binary="$1" marker="$2" owner mode value last_byte

  [[ -f "$binary" && ! -L "$binary" && -x "$binary" ]] || return 1
  owner="$(stat_owner "$binary")" || return 1
  mode="$(stat_mode "$binary")" || return 1
  [[ "$owner" == "$(id -u)" && "$mode" == '700' ]] || return 1
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  owner="$(stat_owner "$marker")" || return 1
  mode="$(stat_mode "$marker")" || return 1
  [[ "$owner" == "$(id -u)" && "$mode" == '600' ]] || return 1
  value="$(<"$marker")"
  last_byte="$(tail -c 1 "$marker" | od -An -tu1 | tr -d '[:space:]')" || return 1
  [[ "$value" == "$ARTIFACT_SHA" && "$last_byte" == '10' ]]
}

install_binary() {
  local version_dir="$1" platform_dir="$2" binary="$3" marker="$4"
  local archive extract marker_stage digest size

  umask 077
  archive="${version_dir}/.deja-download.${BASHPID:-$$}.${RANDOM}"
  extract="${version_dir}/.deja-extract.${BASHPID:-$$}.${RANDOM}"
  if ! curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
    --output "$archive" "${RELEASE_BASE}/${ARTIFACT}"; then
    rm -f "$archive"
    warn 'download failed'
    return 1
  fi
  [[ -f "$archive" && ! -L "$archive" ]] || {
    rm -f "$archive"
    warn 'download is unsafe'
    return 1
  }
  size="$(file_size "$archive")" || return 1
  [[ "$size" == "$ARTIFACT_SIZE" ]] || {
    rm -f "$archive"
    warn 'download size verification failed'
    return 1
  }
  digest="$(sha256 "$archive")" || return 1
  [[ "$digest" == "$ARTIFACT_SHA" ]] || {
    rm -f "$archive"
    warn 'download checksum verification failed'
    return 1
  }
  mkdir -m 700 "$extract" 2>/dev/null || {
    rm -f "$archive"
    warn 'cannot create private extraction'
    return 1
  }
  if ! tar -xzf "$archive" -C "$extract"; then
    rm -f "$archive"
    rm -rf "$extract"
    warn 'archive extraction failed'
    return 1
  fi
  rm -f "$archive"
  [[ -f "${extract}/deja" && ! -L "${extract}/deja" ]] || {
    rm -rf "$extract"
    warn 'archive did not contain a regular Deja binary'
    return 1
  }
  chmod 700 "${extract}/deja" || return 1
  [[ ! -L "$binary" ]] || {
    rm -rf "$extract"
    warn 'the Deja binary destination is a symbolic link'
    return 1
  }
  mv "${extract}/deja" "$binary" || {
    rm -rf "$extract"
    warn 'cannot install the Deja binary'
    return 1
  }
  rm -rf "$extract"
  marker_stage="${platform_dir}/.archive-sha256.${BASHPID:-$$}.${RANDOM}"
  printf '%s\n' "$ARTIFACT_SHA" > "$marker_stage"
  chmod 600 "$marker_stage"
  [[ ! -L "$marker" ]] || {
    rm -f "$marker_stage"
    warn 'the Deja marker destination is a symbolic link'
    return 1
  }
  mv "$marker_stage" "$marker"
}

install_helper() {
  local root="$1" source="$2" stage destination

  [[ -f "$source" && ! -L "$source" ]] || {
    warn 'the bundled helper is unavailable'
    return 1
  }
  destination="${root}/deja-memory"
  stage="${root}/.deja-memory.${BASHPID:-$$}.${RANDOM}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf 'TRELLAGE_MEMORY_INSTALL_ROOT_DEFAULT=%q\n' "$root"
    tail -n +2 "$source"
  } > "$stage" || return 1
  chmod 700 "$stage"
  [[ ! -L "$destination" ]] || {
    rm -f "$stage"
    warn 'the helper destination is a symbolic link'
    return 1
  }
  mv "$stage" "$destination"
}

main() {
  local script_dir source home root version_dir platform_dir binary marker selected_platform

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
  source="${script_dir}/deja-memory"
  home="$(real_home)" || exit 1
  selected_platform="$(platform)" || exit 1
  select_artifact "$selected_platform" || exit 1

  safe_user_dir "$home" || exit 1
  ensure_user_dir "${home}/.local" || exit 1
  ensure_user_dir "${home}/.local/share" || exit 1
  ensure_private_dir "${home}/.local/share/trellage" || exit 1
  root="${home}/.local/share/trellage/deja"
  ensure_private_dir "$root" || exit 1
  version_dir="${root}/${DEJA_VERSION}"
  ensure_private_dir "$version_dir" || exit 1
  platform_dir="${version_dir}/${selected_platform}"
  ensure_private_dir "$platform_dir" || exit 1
  binary="${platform_dir}/deja"
  marker="${platform_dir}/.archive-sha256"

  valid_install "$binary" "$marker" || install_binary \
    "$version_dir" "$platform_dir" "$binary" "$marker" || exit 1
  install_helper "$root" "$source" || exit 1
  printf 'deja installer: ready\n'
}

main "$@"
