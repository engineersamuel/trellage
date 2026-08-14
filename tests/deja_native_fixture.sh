#!/usr/bin/env bash

deja_native_platform() {
  case "$(uname -s):$(uname -m)" in
    Linux:aarch64|Linux:arm64) printf '%s\n' linux_arm64 ;;
    Linux:x86_64|Linux:amd64) printf '%s\n' linux_amd64 ;;
    Darwin:arm64|Darwin:aarch64) printf '%s\n' darwin_arm64 ;;
    Darwin:x86_64|Darwin:amd64) printf '%s\n' darwin_amd64 ;;
    *) return 1 ;;
  esac
}

deja_native_release_sha() {
  case "$1" in
    linux_arm64) printf '%s\n' e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1 ;;
    linux_amd64) printf '%s\n' 1d176d47d3a6990dbb74a91086a6a9099fe7c3461e4d196718ef8a7d51570d78 ;;
    darwin_arm64) printf '%s\n' 17daa4e2036191ce87e41b47154785ae3b59c537fe89c1606eb476ba540799b4 ;;
    darwin_amd64) printf '%s\n' a45650cf5041da49cd318577ce674be919b414d6994aab5615c529df31c349b2 ;;
    *) return 1 ;;
  esac
}

deja_native_prepare_install() {
  local home="$1" platform root binary marker

  platform="$(deja_native_platform)" || return 1
  root="$home/.local/share/trellage/deja"
  binary="$root/0.17.0/$platform/deja"
  marker="$root/0.17.0/$platform/.archive-sha256"
  mkdir -p "$(dirname "$binary")" || return 1
  chmod 700 \
    "$home/.local" \
    "$home/.local/share" \
    "$home/.local/share/trellage" \
    "$root" \
    "$root/0.17.0" \
    "$(dirname "$binary")" || return 1
  cat >"$binary" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod 700 "$binary" || return 1
  deja_native_release_sha "$platform" >"$marker" || return 1
  chmod 600 "$marker"
}

deja_native_install_fake_helper() {
  local home="$1" log="$2"
  local helper="$home/.local/share/trellage/deja/deja-memory"

  cat >"$helper" <<'EOF'
#!/usr/bin/env bash
set -u

: "${FAKE_DEJA_LOG:?}"
operation="${1-}"
credential_names=(
  COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
  ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  OPENAI_API_KEY XAI_API_KEY
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID
  GOOGLE_APPLICATION_CREDENTIALS
)
credential_state=()
for credential_name in "${credential_names[@]}"; do
  if [[ -n "${!credential_name-}" ]]; then
    credential_state+=("${credential_name}=present")
  else
    credential_state+=("${credential_name}=absent")
  fi
done
if [[ -n "${FAKE_DEJA_ENV_LOG-}" ]]; then
  printf '%s %s\n' "$operation" "${credential_state[*]}" >>"$FAKE_DEJA_ENV_LOG"
fi
if [[ "${FAKE_DEJA_REJECT_CREDENTIALS:-0}" == 1 ]]; then
  for state in "${credential_state[@]}"; do
    [[ "$state" == *=absent ]] || exit 65
  done
fi
printf '%s home=%s real=%s memory=%s recall=%s\n' \
  "$operation" "${HOME-}" "${TRELLAGE_REAL_HOME-}" \
  "${TRELLAGE_MEMORY-}" "${DEJA_RECALL-}" >>"$FAKE_DEJA_LOG"
case "$operation" in
  prepare) exit "${FAKE_DEJA_PREPARE_STATUS:-0}" ;;
  finalize) exit "${FAKE_DEJA_FINALIZE_STATUS:-0}" ;;
  *) exit 64 ;;
esac
EOF
  chmod 700 "$helper"
  : >"$log"
}

deja_native_assert_installed_helper() {
  local home="$1"
  local helper="$home/.local/share/trellage/deja/deja-memory"

  [[ -f "$helper" && ! -L "$helper" && -x "$helper" ]]
}

deja_native_install_ambient_helper() {
  local directory="$1" log="$2"

  cat >"$directory/deja-memory" <<EOF
#!/usr/bin/env bash
printf 'ambient helper used\\n' >>'$log'
exit 99
EOF
  chmod 700 "$directory/deja-memory"
}
