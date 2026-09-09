#!/usr/bin/env bash
set -euo pipefail

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"

fail() {
  printf 'trellage Codex harness-version contract failed: %s\n' "$1" >&2
  exit 1
}

fixture="$(mktemp -d "${TMPDIR:-/tmp}/trellage-codex-harness-version.XXXXXX")"
case "$fixture" in "${TMPDIR:-/tmp}"/trellage-codex-harness-version.*) ;; *) fail 'unsafe fixture root' ;; esac
cleanup() {
  case "$fixture" in "${TMPDIR:-/tmp}"/trellage-codex-harness-version.*) rm -rf -- "$fixture" ;; esac
}
trap cleanup EXIT HUP INT TERM

runtime="$fixture/runtime"
fake_bin="$fixture/fake-bin"
mkdir -p "$runtime/bin" "$runtime/lib" "$fake_bin" "$fixture/home"
cp "$root/bin/cdx" "$runtime/bin/cdx"
cp "$root/../trellage-codex-common/native-codex" "$runtime/lib/native-codex"
chmod 0755 "$runtime/bin/cdx" "$runtime/lib/native-codex"

cat >"$fake_bin/codex" <<'EOF'
#!/usr/bin/env bash
set -u
if [ "${1:-}" = --version ]; then
  printf 'codex-cli 0.146.0\n'
  exit 0
fi
printf '%s\n' \
  "args=$*" \
  "HOME=$HOME" \
  "CODEX_HOME=${CODEX_HOME-}" \
  "TRANSCRIPT_API_KEY=${TRANSCRIPT_API_KEY+set}" >>"$FAKE_CODEX_HARNESS_LOG"
case "$*" in
  'help update')
    if [ "${FAKE_CODEX_UPDATE_SUPPORTED:-1}" != 1 ]; then
      printf 'fixture Codex has no update subcommand\n' >&2
      exit 2
    fi
    ;;
  update)
    if [ "${FAKE_CODEX_UPDATE_STATUS:-0}" -ne 0 ]; then
      printf 'fixture Codex updater failed\n' >&2
      exit "$FAKE_CODEX_UPDATE_STATUS"
    fi
    printf 'Codex updated\n'
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fake_bin/codex"

write_fake_curl_json() {
  local body="$1"
  printf '#!/usr/bin/env bash\ncat <<'"'"'CURL_FIXTURE_JSON'"'"'\n%s\nCURL_FIXTURE_JSON\n' "$body" >"$fake_bin/curl"
  chmod +x "$fake_bin/curl"
}

write_fake_curl_failure() {
  printf '#!/usr/bin/env bash\nexit %s\n' "$1" >"$fake_bin/curl"
  chmod +x "$fake_bin/curl"
}

run_harness_version() {
  HOME="$fixture/home" PATH="$fake_bin:$PATH" "$runtime/bin/cdx" harness-version
}

run_harness_update() (
  unset CODEX_HOME _TRELLAGE_NATIVE_VARLOCK_ACTIVE
  export HOME="$fixture/home"
  export FAKE_CODEX_HARNESS_LOG="$fixture/harness-update.log"
  PATH="$fake_bin:$PATH" "$runtime/bin/cdx" harness-update "$@"
)

assert_json_field() {
  local output="$1" filter="$2" expected="$3"
  local actual
  actual="$(printf '%s' "$output" | jq -r "$filter")" || fail "invalid JSON output: $output"
  [ "$actual" = "$expected" ] || fail "expected $filter to be '$expected' but got '$actual' in: $output"
}

# A stable, non-prerelease GitHub release resolves both installed and latest.
write_fake_curl_json '{"tag_name":"rust-v0.152.1","draft":false,"prerelease":false}'
output="$(run_harness_version)"
assert_json_field "$output" .schemaVersion 1
assert_json_field "$output" .launcher cdx
assert_json_field "$output" .harness codex
assert_json_field "$output" .installed 0.146.0
assert_json_field "$output" .latest 0.152.1
assert_json_field "$output" .latestKnown true

# A network failure (curl exits nonzero) still reports the installed version,
# with the latest version left unknown rather than fabricated.
write_fake_curl_failure 7
output="$(run_harness_version)"
assert_json_field "$output" .installed 0.146.0
assert_json_field "$output" .latest null
assert_json_field "$output" .latestKnown false

# A prerelease tag must never be reported as the latest stable version.
write_fake_curl_json '{"tag_name":"rust-v0.152.1","draft":false,"prerelease":true}'
output="$(run_harness_version)"
assert_json_field "$output" .latest null
assert_json_field "$output" .latestKnown false

# A tag without the required rust-v prefix must never be reported as latest.
write_fake_curl_json '{"tag_name":"v0.152.1","draft":false,"prerelease":false}'
output="$(run_harness_version)"
assert_json_field "$output" .latest null
assert_json_field "$output" .latestKnown false

TRANSCRIPT_API_KEY=fixture-only run_harness_update >"$fixture/harness-update.out" \
  || fail 'harness update failed'
cmp -s "$fixture/harness-update.log" <(printf '%s\n' \
  'args=help update' "HOME=$fixture/home" 'CODEX_HOME=' 'TRANSCRIPT_API_KEY=' \
  'args=update' "HOME=$fixture/home" 'CODEX_HOME=' 'TRANSCRIPT_API_KEY=') \
  || fail 'harness update changed its arguments, HOME, profile environment, or secret isolation'
grep -Fxq 'Codex updated' "$fixture/harness-update.out" \
  || fail 'harness update hid updater output'
[ -z "$(find "$fixture/home" -mindepth 1 -print -quit)" ] \
  || fail 'harness update created authentication or profile state'

update_status=0
FAKE_CODEX_UPDATE_STATUS=23 run_harness_update \
  >"$fixture/harness-update-failed.out" 2>"$fixture/harness-update-failed.err" || update_status=$?
[ "$update_status" -eq 23 ] || fail "harness update exit was $update_status, expected 23"
grep -Fxq 'fixture Codex updater failed' "$fixture/harness-update-failed.err" \
  || fail 'harness update hid the updater diagnostic'

: >"$fixture/harness-update.log"
update_status=0
FAKE_CODEX_UPDATE_SUPPORTED=0 run_harness_update \
  >"$fixture/harness-update-unsupported.out" 2>"$fixture/harness-update-unsupported.err" || update_status=$?
[ "$update_status" -eq 1 ] || fail 'an unsupported updater did not fail closed'
grep -Fxq 'args=help update' "$fixture/harness-update.log" \
  || fail 'missing safe updater capability probe'
if grep -Fxq 'args=update' "$fixture/harness-update.log"; then
  fail 'an unsupported updater could start an agent prompt'
fi
grep -Fq 'installed Codex has no built-in updater' "$fixture/harness-update-unsupported.err" \
  || fail 'missing unsupported updater diagnostic'

calls_before="$(wc -l <"$fixture/harness-update.log" | tr -d ' ')"
for argument in youtube superpowers --all --check; do
  if run_harness_update "$argument" >"$fixture/harness-update-invalid.out" 2>"$fixture/harness-update-invalid.err"; then
    fail "harness update accepted $argument"
  fi
  grep -Fxq 'cdx: usage: cdx harness-update' "$fixture/harness-update-invalid.err" \
    || fail 'missing harness update argument diagnostic'
done
[ "$(wc -l <"$fixture/harness-update.log" | tr -d ' ')" = "$calls_before" ] \
  || fail 'invalid harness update arguments reached Codex'

missing_bin="$fixture/missing-bin"
mkdir -p "$missing_bin"
for tool in bash dirname uname; do
  ln -s "$(command -v "$tool")" "$missing_bin/$tool"
done
if HOME="$fixture/home" PATH="$missing_bin" "$runtime/bin/cdx" harness-update \
  >"$fixture/harness-update-missing.out" 2>"$fixture/harness-update-missing.err"; then
  fail 'harness update accepted a missing Codex executable'
fi
grep -Fxq 'cdx: required command not found: codex' "$fixture/harness-update-missing.err" \
  || fail 'missing Codex executable diagnostic'

printf 'trellage Codex harness-version contract: PASS\n'
