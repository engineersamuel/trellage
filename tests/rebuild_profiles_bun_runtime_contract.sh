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

workspace="$fixture_root/worktree"
mkdir -p "$workspace/scripts" "$workspace/prototypes/trellage" \
  "$workspace/profiles/alpha" "$workspace/profiles/beta"
workspace="$(cd "$workspace" && pwd -P)"
cp "$rebuild_script" "$workspace/scripts/rebuild-profile-images.sh"
touch "$workspace/profiles/alpha/profile.toml" "$workspace/profiles/beta/profile.toml"

cat >"$workspace/scripts/bun-runtime.sh" <<'EOF'
trellage_ensure_bun_runtime() {
  printf 'bun\n' >>"${TRELLAGE_TEST_REBUILD_LOG:?}"
}
EOF

cat >"$workspace/scripts/install-source-runtime.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 1 && "$1" == --prepare ]]
printf 'prepare\n' >>"${TRELLAGE_TEST_REBUILD_LOG:?}"
if [[ "${TRELLAGE_TEST_PREPARE_FAIL:-0}" == 1 ]]; then
  printf 'fixture dependency installation failed\n' >&2
  exit 1
fi
touch "${TRELLAGE_TEST_READY:?}"
EOF

cat >"$workspace/prototypes/trellage/trellage" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ -f "${TRELLAGE_TEST_READY:?}" ]] || {
  printf 'source runtime is stale\n' >&2
  exit 1
}
printf '%s\n' "$*" >>"${TRELLAGE_TEST_REBUILD_LOG:?}"
EOF
chmod +x "$workspace/scripts/install-source-runtime.sh" "$workspace/prototypes/trellage/trellage"

export TRELLAGE_TEST_REBUILD_LOG="$fixture_root/rebuild-calls"
export TRELLAGE_TEST_READY="$fixture_root/source-ready"

for mode in development locked; do
  rm -f "$TRELLAGE_TEST_READY"
  : >"$TRELLAGE_TEST_REBUILD_LOG"
  args=(--sandbox-only)
  build_args=build
  if [[ "$mode" == locked ]]; then
    args+=(--locked)
    build_args='build --locked'
  fi
  output="$(bash "$workspace/scripts/rebuild-profile-images.sh" "${args[@]}" 2>&1)" \
    || fail "$mode rebuild failed: $output"
  expected="$(printf 'bun\nprepare\n%s %s/profiles/alpha/profile.toml\n%s %s/profiles/beta/profile.toml' \
    "$build_args" "$workspace" "$build_args" "$workspace")"
  [[ "$(cat "$TRELLAGE_TEST_REBUILD_LOG")" == "$expected" ]] \
    || fail "$mode rebuild did not prepare once before all builds"
  [[ "$output" == *'sandbox built 2/2'* ]] || fail "$mode rebuild did not build both profiles"
done

rm -f "$TRELLAGE_TEST_READY"
: >"$TRELLAGE_TEST_REBUILD_LOG"
if output="$(TRELLAGE_TEST_PREPARE_FAIL=1 bash "$workspace/scripts/rebuild-profile-images.sh" --sandbox-only 2>&1)"; then
  fail 'failed source preparation was accepted'
fi
[[ "$(cat "$TRELLAGE_TEST_REBUILD_LOG")" == $'bun\nprepare' ]] \
  || fail 'sandbox builds ran after failed source preparation'
[[ "$output" == *'fixture dependency installation failed'* \
  && "$output" == *'source runtime preparation failed; skipping sandbox builds'* ]] \
  || fail 'preparation failure diagnostic was lost'

: >"$TRELLAGE_TEST_REBUILD_LOG"
if bash "$workspace/scripts/rebuild-profile-images.sh" --sandbox-only missing >"$fixture_root/invalid-output" 2>&1; then
  fail 'missing profile was accepted'
fi
[[ "$(cat "$TRELLAGE_TEST_REBUILD_LOG")" == bun ]] \
  || fail 'invalid profile triggered preparation'

printf 'rebuild profiles Bun runtime contract: PASS\n'
