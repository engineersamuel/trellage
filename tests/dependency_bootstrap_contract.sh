#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bootstrap="$repository_root/scripts/bootstrap-development-dependencies.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-bootstrap.XXXXXX")"
fixture_bin="$fixture_root/bin"
state_root="$fixture_root/state"
call_log="$fixture_root/mise-calls"

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fail() {
  printf 'dependency bootstrap contract: FAIL: %s\n' "$1" >&2
  exit 1
}

mkdir -p -- "$fixture_bin"
cat >"$fixture_bin/mise" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$TRELLAGE_TEST_MISE_CALL_LOG"
wait_for_install_release() {
  : >"${TRELLAGE_TEST_MISE_INSTALL_READY:?}"
  while [[ ! -e "${TRELLAGE_TEST_MISE_INSTALL_RELEASE:?}" ]]; do sleep 0.01; done
}
case "$*" in
  *'install --dry-run-code')
    exit 1
    ;;
  *' install')
    wait_for_install_release
    exit 0
    ;;
  *'exec -- uvx --offline yt-dlp --version')
    exit 1
    ;;
  *'exec -- uvx yt-dlp --version')
    printf '2026.07.04\n'
    exit 0
    ;;
  *'where uv@latest')
    exit 1
    ;;
  *'install uv@latest')
    wait_for_install_release
    exit 0
    ;;
  *'exec uv@latest -- uvx --offline yt-dlp --version')
    exit 1
    ;;
  *'exec uv@latest -- uvx yt-dlp --version')
    printf '2026.07.04\n'
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod 0755 "$fixture_bin/mise"
mkdir -p "$state_root/dependency-bootstrap.lock"
printf '%s\n' '99999999' >"$state_root/dependency-bootstrap.lock/pid"
install_ready="$fixture_root/install-ready"
install_release="$fixture_root/install-release"

started_at="$(date +%s)"
env \
  PATH="$fixture_bin:/usr/bin:/bin" \
  MISE_PROJECT_ROOT="$repository_root" \
  TRELLAGE_BOOTSTRAP_STATE_DIR="$state_root" \
  TRELLAGE_TEST_MISE_CALL_LOG="$call_log" \
  TRELLAGE_TEST_MISE_INSTALL_READY="$install_ready" \
  TRELLAGE_TEST_MISE_INSTALL_RELEASE="$install_release" \
  "$bootstrap" --background
elapsed="$(( $(date +%s) - started_at ))"
(( elapsed < 2 )) || fail "background request blocked startup for ${elapsed}s"

for _ in {1..50}; do
  [[ -f "$install_ready" ]] && break
  sleep 0.1
done
[[ -f "$install_ready" ]] || fail 'background mise install did not start'
: >"$install_release"

for _ in {1..50}; do
  [[ -f "$call_log" ]] \
    && grep -Fq 'exec -- uvx yt-dlp --version' "$call_log" \
    && break
  sleep 0.1
done

grep -Fq 'install --dry-run-code' "$call_log" \
  || fail 'missing tools were not detected'
grep -Fq ' install' "$call_log" \
  || fail 'missing mise tools were not installed'
grep -Fq 'exec -- uvx --offline yt-dlp --version' "$call_log" \
  || fail 'yt-dlp cache was not checked'
grep -Fq 'exec -- uvx yt-dlp --version' "$call_log" \
  || fail 'yt-dlp was not warmed'

installed_root="$fixture_root/installed-trx"
installed_bootstrap="$installed_root/lib/bootstrap-development-dependencies.sh"
installed_state="$fixture_root/installed-state"
mkdir -p "$installed_root/lib"
cp "$bootstrap" "$installed_bootstrap"
chmod 0755 "$installed_bootstrap"
: >"$call_log"
install_ready="$fixture_root/installed-install-ready"
install_release="$fixture_root/installed-install-release"

env \
  PATH="$fixture_bin:/usr/bin:/bin" \
  MISE_PROJECT_ROOT="$installed_root" \
  TRELLAGE_BOOTSTRAP_STATE_DIR="$installed_state" \
  TRELLAGE_TEST_MISE_CALL_LOG="$call_log" \
  TRELLAGE_TEST_MISE_INSTALL_READY="$install_ready" \
  TRELLAGE_TEST_MISE_INSTALL_RELEASE="$install_release" \
  "$installed_bootstrap" --background

for _ in {1..50}; do
  [[ -f "$install_ready" ]] && break
  sleep 0.1
done
[[ -f "$install_ready" ]] || fail 'installed trx mise install did not start'
: >"$install_release"

for _ in {1..50}; do
  grep -Fq 'exec uv@latest -- uvx yt-dlp --version' "$call_log" 2>/dev/null \
    && break
  sleep 0.1
done

grep -Fq 'where uv@latest' "$call_log" \
  || fail 'installed trx did not detect missing uv'
grep -Fq 'install uv@latest' "$call_log" \
  || fail 'installed trx did not install uv'
grep -Fq 'exec uv@latest -- uvx yt-dlp --version' "$call_log" \
  || fail 'installed trx did not warm yt-dlp'

grep -Fq '"$dependency_bootstrap" --background' \
  "$repository_root/prototypes/trellage/trellage" \
  || fail 'trellage does not schedule the dependency bootstrap'
grep -Fq 'bootstrap-development-dependencies.sh' \
  "$repository_root/prototypes/trellage-router/bin/trx" \
  || fail 'source trx does not schedule the dependency bootstrap'
grep -Fq 'auto_install = true' \
  "$repository_root/mise.toml" \
  || fail 'mise does not install missing tools on directory entry'

printf 'dependency bootstrap contract: PASS\n'
