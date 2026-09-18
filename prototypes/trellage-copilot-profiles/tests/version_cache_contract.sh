#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
prototype_root="$PWD"
launcher="$prototype_root/bin/cpx"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/cpx-version-cache.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

fake_bin="$fixture_root/bin"
cache_root="$fixture_root/cache"
count_file="$fixture_root/version-count"
mkdir -p "$fake_bin" "$cache_root"
printf '0\n' >"$count_file"
cat >"$fake_bin/copilot" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$CPX_VERSION_COUNT")"
printf '%s\n' "$((count + 1))" >"$CPX_VERSION_COUNT"
if [[ "${CPX_VERSION_MODE:-ok}" == fail ]]; then
  printf 'unavailable\n'
  exit 42
else
  printf 'GitHub Copilot CLI %s\n' "${CPX_VERSION:-1.0.81}"
fi
EOF
chmod +x "$fake_bin/copilot"

run_cpx() {
  HOME="$fixture_root/home" XDG_CACHE_HOME="$cache_root" CPX_VERSION_COUNT="$count_file" \
  PATH="$fake_bin:/usr/bin:/bin" CPX_CATALOG="$prototype_root/catalog.json" \
    "$launcher" "$@"
}

mkdir -p "$fixture_root/home"
run_cpx list --json >"$fixture_root/first.json"
[[ "$(<"$count_file")" == 1 ]] || { printf 'expected one initial version probe\n' >&2; exit 1; }
jq -e 'all(.profiles[]; .headless.prompt == true)' "$fixture_root/first.json" >/dev/null
run_cpx list --json >"$fixture_root/second.json"
[[ "$(<"$count_file")" == 1 ]] || { printf 'cache hit reprobed Copilot\n' >&2; exit 1; }

fixture_miss="$fixture_root/miss-cache"
mkdir -p "$fixture_miss"
HOME="$fixture_root/home-miss" XDG_CACHE_HOME="$fixture_miss" CPX_VERSION_COUNT="$count_file" \
  PATH="$fake_bin:/usr/bin:/bin" CPX_CATALOG="$prototype_root/catalog.json" \
  "$launcher" list --json --cached-capabilities >"$fixture_root/miss.json"
[[ "$(<"$count_file")" == 1 ]] || { printf 'cached-only miss invoked Copilot\n' >&2; exit 1; }
jq -e 'all(.profiles[]; .headless.prompt == false and .headless.testedHarnessVersion == null)' \
  "$fixture_root/miss.json" >/dev/null

run_cpx list --json --cached-capabilities >"$fixture_root/cached.json"
[[ "$(<"$count_file")" == 1 ]] || { printf 'cached-only hit invoked Copilot\n' >&2; exit 1; }
jq -e 'all(.profiles[]; .headless.prompt == true)' "$fixture_root/cached.json" >/dev/null

# Replace the executable, then change nearby package metadata.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'count="$(cat "$CPX_VERSION_COUNT")"' \
  'printf "%s\\n" "$((count + 1))" >"$CPX_VERSION_COUNT"' \
  'printf "GitHub Copilot CLI 1.0.82\\n"' >"$fake_bin/copilot"
chmod +x "$fake_bin/copilot"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 2 ]] || { printf 'binary replacement did not invalidate cache\n' >&2; exit 1; }
printf '%s\n' '{"name":"copilot","version":"1"}' >"$fake_bin/package.json"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 3 ]] || { printf 'package metadata change did not invalidate cache\n' >&2; exit 1; }
printf '%s\n' '{"name":"copilot","version":"2"}' >"$fake_bin/package.json"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 4 ]] || { printf 'same-size package metadata change did not invalidate cache\n' >&2; exit 1; }

printf '%s\n' '#!/bin/sh' 'count="$(cat "$CPX_VERSION_COUNT")"' \
  'printf "%s\\n" "$((count + 1))" >"$CPX_VERSION_COUNT"' \
  'if [ "${CPX_VERSION_MODE:-ok}" = fail ]; then printf "GitHub Copilot CLI 9.9.9\\n"; exit 42; fi' \
  'printf "GitHub Copilot CLI 1.0.82\\n"' >"$fake_bin/copilot-one"
printf '%s\n' '#!/bin/sh' 'count="$(cat "$CPX_VERSION_COUNT")"' \
  'printf "%s\\n" "$((count + 1))" >"$CPX_VERSION_COUNT"' \
  'if [ "${CPX_VERSION_MODE:-ok}" = fail ]; then printf "GitHub Copilot CLI 9.9.9\\n"; exit 42; fi' \
  'printf "GitHub Copilot CLI 1.0.83\\n"' >"$fake_bin/copilot-two"
chmod +x "$fake_bin/copilot-one" "$fake_bin/copilot-two"
ln -sf copilot-one "$fake_bin/copilot"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 5 ]] || { printf 'initial symlink target did not invalidate cache\n' >&2; exit 1; }
ln -sf copilot-two "$fake_bin/copilot"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 6 ]] || { printf 'symlink retarget did not invalidate cache\n' >&2; exit 1; }

cache_file="$cache_root/trellage/cpx/copilot-version.json"
printf '%s\n' '{broken' >"$cache_file"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 7 ]] || { printf 'corrupt cache was trusted\n' >&2; exit 1; }
rm -f "$cache_file"
ln -s "$fixture_root/missing-cache" "$cache_file"
run_cpx list --json >/dev/null
[[ "$(<"$count_file")" == 8 ]] || { printf 'symlink cache did not probe once (count=%s)\n' "$(<"$count_file")" >&2; exit 1; }
[[ -L "$cache_file" ]] || { printf 'cache write replaced symlink\n' >&2; exit 1; }
CPX_VERSION_MODE=fail run_cpx list --json >"$fixture_root/failed-probe.json"
[[ "$(<"$count_file")" == 9 ]] || { printf 'failed probe was not attempted\n' >&2; exit 1; }
 jq -e 'all(.profiles[]; .headless.prompt == false and .headless.testedHarnessVersion == null)' \
  "$fixture_root/failed-probe.json" >/dev/null
[[ ! -e "$fixture_root/missing-cache" ]] || { printf 'cache write followed symlink\n' >&2; exit 1; }

parent_real="$fixture_root/real-cache"
parent_link="$fixture_root/cache-link"
mkdir -p "$parent_real"
ln -s "$parent_real" "$parent_link"
HOME="$fixture_root/home" XDG_CACHE_HOME="$parent_link" CPX_VERSION_COUNT="$count_file" \
  PATH="$fake_bin:/usr/bin:/bin" CPX_CATALOG="$prototype_root/catalog.json" \
  "$launcher" list --json >/dev/null
[[ "$(<"$count_file")" == 10 ]] || { printf 'symlinked cache parent did not fall back uncached\n' >&2; exit 1; }
[[ -z "$(find "$parent_real" -mindepth 1 -print -quit)" ]] || { printf 'symlinked cache parent was mutated\n' >&2; exit 1; }

printf 'cpx version cache contract: PASS\n'
