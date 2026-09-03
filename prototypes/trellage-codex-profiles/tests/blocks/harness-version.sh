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
mkdir -p "$runtime/bin" "$runtime/lib" "$fake_bin"
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
exit 1
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
  PATH="$fake_bin:$PATH" "$runtime/bin/cdx" harness-version
}

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

printf 'trellage Codex harness-version contract: PASS\n'
