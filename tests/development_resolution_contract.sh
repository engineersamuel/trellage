#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  printf 'development resolution contract: FAIL: %s\n' "$1" >&2
  exit 1
}

while IFS= read -r lock; do
  [[ ! -e "$lock" ]] || fail "bundled development profile contains release lock $lock"
done < <(git ls-files 'profiles/**/profile.*.lock.toml')

while IFS= read -r profile; do
  version="$(
    awk '
      $0 == "[harness]" { in_harness = 1; next }
      /^\[/ { in_harness = 0 }
      in_harness && /^version[[:space:]]*=/ { print; exit }
    ' "$profile"
  )"
  [[ "$version" == 'version = "latest"' ]] \
    || fail "$profile does not select the latest stable harness"

  base="$(sed -n 's/^base[[:space:]]*=[[:space:]]*"\([^"]*\)"/\1/p' "$profile")"
  [[ -n "$base" ]] || fail "$profile has no base image"
  [[ "$base" != *@sha256:* ]] || fail "$profile pins a base image digest"
  [[ ! "$base" =~ :[0-9] ]] || fail "$profile pins a numbered base image tag"

  while IFS= read -r ref; do
    [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]] || fail "$profile pins plugin commit $ref"
    [[ ! "$ref" =~ ^v?[0-9]+([.][0-9]+)+ ]] || fail "$profile pins plugin release $ref"
  done < <(sed -n 's/^ref[[:space:]]*=[[:space:]]*"\([^"]*\)"/\1/p' "$profile")
done < <(find profiles -mindepth 2 -maxdepth 2 -name profile.toml -type f | sort)

while IFS= read -r manifest; do
  jq -e '
    all(.contestants[].packages[]?;
      (.ref | test("^[0-9a-f]{40}$") | not)
      and (.ref | test("^v?[0-9]+([.][0-9]+)+") | not)
    )
  ' "$manifest" >/dev/null || fail "$manifest pins a comparison package source"
done < <(find harnesses -name harness.json -type f | sort)

while IFS= read -r pin; do
  [[ ! -e "$pin" ]] || fail "Native development profile contains external pin $pin"
done < <(git ls-files 'prototypes/trellage-*-profiles/**/PIN.txt')

for lock in \
  packages/trellage-cli/assets/graph-of-loops-requirements.lock \
  packages/trellage-cli/assets/hyperresearch-requirements.lock; do
  [[ ! -e "$lock" ]] || fail "generated development dependency lock remains at $lock"
done

grep -Eq 'uv@[0-9]+([.][0-9]+)+' scripts/bootstrap-development-dependencies.sh \
  && fail 'development dependency bootstrap pins uv'
grep -Eq 'skills@[0-9]+([.][0-9]+)+' scripts/floating-skills.mjs \
  && fail 'floating skill materialization pins the skills CLI'

jq -e '
  [.profiles[].extensions[]?.installSpec] | all(. as $spec |
    (($spec | test("^npm:")) | not)
    or (($spec | test("@[0-9]+([.][0-9]+)+([-.+][0-9A-Za-z.-]+)?$")) | not)
  )
' prototypes/trellage-picx-profiles/catalog.json >/dev/null \
  || fail 'Native Pi extension catalog pins an npm package version'

for dockerfile in Dockerfile.agent Dockerfile.copilot-agent Dockerfile.app; do
  grep -Eq '^FROM (node|python):[0-9]' "$dockerfile" \
    && fail "$dockerfile pins a numbered development base image"
  grep -Eq '^ARG (CODEX|COPILOT|PLAYWRIGHT|UV)_VERSION=[0-9]' "$dockerfile" \
    && fail "$dockerfile pins a development tool version"
  grep -Eq '^ARG (WSHOBSON_AGENTS|AWESOME_COPILOT)_REF=[0-9a-f]{40}$' "$dockerfile" \
    && fail "$dockerfile pins a development package source"
done

grep -Eq '(CODEX|COPILOT)_VERSION:-[0-9]' compose.yaml compose.copilot.yaml \
  && fail 'comparison Compose defaults pin a harness version'
grep -Eq '(WSHOBSON_AGENTS|AWESOME_COPILOT)_REF:-[0-9a-f]{40}' compose.yaml compose.copilot.yaml \
  && fail 'comparison Compose defaults pin a package source'
grep -Fq "build --pull --no-cache" scripts/harness \
  || fail 'comparison builds can reuse stale floating dependency layers'

printf 'development resolution contract: PASS\n'
