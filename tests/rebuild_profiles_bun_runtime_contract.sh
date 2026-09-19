#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
rebuild_script="$repo_root/scripts/rebuild-profile-images.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-rebuild-bun.XXXXXX")"
old_bin="$fixture_root/old-bin"
new_bin="$fixture_root/new-bin"
call_log="$fixture_root/mise-calls"
probe="$fixture_root/probe.sh"

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fail() {
  printf 'rebuild profiles Bun runtime contract: FAIL: %s\n' "$1" >&2
  exit 1
}

grep -Fq 'trellage_ensure_bun_runtime' "$rebuild_script" \
  || fail 'rebuild entrypoint does not ensure the pinned Bun runtime'

mkdir -p -- "$old_bin" "$new_bin"

cat >"$old_bin/bun" <<'EOF'
#!/usr/bin/env bash
printf '1.3.3\n'
EOF

cat >"$new_bin/bun" <<'EOF'
#!/usr/bin/env bash
printf '1.4.2\n'
EOF

cat >"$old_bin/mise" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${TRELLAGE_TEST_MISE_CALL_LOG:?}"
case "${1-}" in
  install)
    [[ "${2-}" == bun@1.4.2 && "$#" == 2 ]]
    ;;
  exec)
    [[ "${2-}" == bun@1.4.2 && "${3-}" == -- ]]
    shift 3
    PATH="${TRELLAGE_TEST_NEW_BIN:?}:$PATH" exec "$@"
    ;;
  *)
    exit 2
    ;;
esac
EOF

cat >"$probe" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
source "$repo_root/scripts/bun-runtime.sh"
trellage_ensure_bun_runtime "$repo_root" "\$0"
bun --version
EOF

chmod 0755 "$old_bin/bun" "$new_bin/bun" "$old_bin/mise" "$probe"

output="$(
  env \
    -u TRELLAGE_BUN_EXECUTABLE \
    PATH="$old_bin:/usr/bin:/bin" \
    TRELLAGE_TEST_MISE_CALL_LOG="$call_log" \
    TRELLAGE_TEST_NEW_BIN="$new_bin" \
    "$probe"
)" || fail 'old Bun was not upgraded'

[[ "$output" == 1.4.2 ]] || fail "expected Bun 1.4.2 after re-exec, found: $output"
call_count="$(wc -l <"$call_log" | tr -d ' ')"
install_call="$(sed -n '1p' "$call_log")"
exec_call="$(sed -n '2p' "$call_log")"
[[ "$call_count" == 2 ]] || fail "expected two Mise calls, found $call_count"
[[ "$install_call" == 'install bun@1.4.2' ]] || fail "unexpected install call: $install_call"
[[ "$exec_call" == "exec bun@1.4.2 -- $probe" ]] \
  || fail "unexpected exec call: $exec_call"

: >"$call_log"
output="$(
  env \
    -u TRELLAGE_BUN_EXECUTABLE \
    PATH="$new_bin:$old_bin:/usr/bin:/bin" \
    TRELLAGE_TEST_MISE_CALL_LOG="$call_log" \
    TRELLAGE_TEST_NEW_BIN="$new_bin" \
    "$probe"
)" || fail 'current Bun was rejected'

[[ "$output" == 1.4.2 ]] || fail "current Bun returned unexpected output: $output"
[[ ! -s "$call_log" ]] || fail 'current Bun invoked Mise'

printf 'rebuild profiles Bun runtime contract: PASS\n'
