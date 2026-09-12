#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bootstrap="$repository_root/scripts/bootstrap-development-dependencies.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-bootstrap.XXXXXX")"
fixture_bin="$fixture_root/bin"
state_root="$fixture_root/state"
call_log="$fixture_root/mise-calls"
bootstrap_pid=

cleanup() {
  if [[ -n "$bootstrap_pid" ]]; then
    : >"$install_release"
    wait "$bootstrap_pid" || true
  fi
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
source_root="$fixture_root/source"
source_bootstrap="$source_root/scripts/bootstrap-development-dependencies.sh"
mkdir -p "$source_root/scripts"
cp "$bootstrap" "$source_bootstrap"
: >"$source_root/mise.toml"
cat >"$source_root/scripts/build-profile-compiler.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' 'source:prepare' >>"$TRELLAGE_TEST_MISE_CALL_LOG"
EOF
chmod 0755 "$source_bootstrap" "$source_root/scripts/build-profile-compiler.sh"
mkdir -p "$state_root/dependency-bootstrap.lock"
printf '%s\n' '99999999' >"$state_root/dependency-bootstrap.lock/pid"
install_ready="$fixture_root/install-ready"
install_release="$fixture_root/install-release"

started_at="$(date +%s)"
if env \
  PATH="$fixture_bin:/usr/bin:/bin" \
  MISE_PROJECT_ROOT="$source_root" \
  TRELLAGE_BOOTSTRAP_STATE_DIR="$state_root" \
  TRELLAGE_TEST_MISE_CALL_LOG="$call_log" \
  TRELLAGE_TEST_MISE_INSTALL_READY="$install_ready" \
  TRELLAGE_TEST_MISE_INSTALL_RELEASE="$install_release" \
  "$source_bootstrap" --background >"$fixture_root/automatic.log" 2>&1; then
  fail 'automatic installation unexpectedly succeeded'
fi
elapsed="$(( $(date +%s) - started_at ))"
(( elapsed < 2 )) || fail "automatic-install rejection blocked startup for ${elapsed}s"
grep -Fq 'Automatic dependency installation is disabled' "$fixture_root/automatic.log" \
  || fail 'automatic-install rejection did not explain explicit setup'
[[ ! -e "$call_log" ]] || fail 'automatic rejection invoked installation tools'
[[ "$(<"$state_root/dependency-bootstrap.lock/pid")" == 99999999 ]] \
  || fail 'automatic rejection changed the existing lock'

env \
  PATH="$fixture_bin:/usr/bin:/bin" \
  MISE_PROJECT_ROOT="$source_root" \
  TRELLAGE_BOOTSTRAP_STATE_DIR="$state_root" \
  TRELLAGE_TEST_MISE_CALL_LOG="$call_log" \
  TRELLAGE_TEST_MISE_INSTALL_READY="$install_ready" \
  TRELLAGE_TEST_MISE_INSTALL_RELEASE="$install_release" \
  "$source_bootstrap" --run &
bootstrap_pid=$!

for _ in {1..50}; do
  [[ -f "$install_ready" ]] && break
  sleep 0.1
done
[[ -f "$install_ready" ]] || fail 'explicit mise install did not start'
[[ "$(<"$state_root/dependency-bootstrap.lock/pid")" == "$bootstrap_pid" ]] \
  || fail 'explicit setup did not replace the dead lock owner'
[[ "$(head -n 1 "$call_log")" == source:prepare ]] \
  || fail 'explicit setup did not prepare source dependencies first'
: >"$install_release"
wait "$bootstrap_pid"
bootstrap_pid=
[[ ! -e "$state_root/dependency-bootstrap.lock" ]] \
  || fail 'explicit setup did not release its lock'

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
installed_bootstrap="$installed_root/scripts/bootstrap-development-dependencies.sh"
installed_state="$fixture_root/installed-state"
mkdir -p "$installed_root/scripts"
cp "$bootstrap" "$installed_bootstrap"
cp "$source_root/scripts/build-profile-compiler.sh" "$installed_root/scripts/build-profile-compiler.sh"
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
  "$installed_bootstrap" --run &
bootstrap_pid=$!

for _ in {1..50}; do
  [[ -f "$install_ready" ]] && break
  sleep 0.1
done
[[ -f "$install_ready" ]] || fail 'installed source workspace mise install did not start'
[[ "$(head -n 1 "$call_log")" == source:prepare ]] \
  || fail 'installed explicit setup did not prepare source dependencies first'
: >"$install_release"
wait "$bootstrap_pid"
bootstrap_pid=
[[ ! -e "$installed_state/dependency-bootstrap.lock" ]] \
  || fail 'installed explicit setup did not release its lock'

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

if grep -Fq '"$dependency_bootstrap" --background' "$repository_root/prototypes/trellage/trellage"; then
  fail 'trellage still schedules automatic dependency installation'
fi
if grep -Eq 'bootstrap-development-dependencies\.sh.*--background' "$repository_root/prototypes/trellage-router/bin/trx"; then
  fail 'source trx still schedules automatic dependency installation'
fi
grep -Fq 'auto_install = false' \
  "$repository_root/mise.toml" \
  || fail 'mise still installs missing tools on directory entry'

printf 'dependency bootstrap contract: PASS\n'
