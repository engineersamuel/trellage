#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
fixture="$(mktemp -d "${TMPDIR:-/tmp}/publication-contract.XXXXXX")"
cleanup() { rm -rf -- "$fixture"; }
trap cleanup EXIT

git init -q -b main "$fixture"
git -C "$fixture" config user.name 'Samuel Mendenhall'
git -C "$fixture" config user.email '2019830+engineersamuel@users.noreply.github.com'
mkdir -p "$fixture/tests"
mkdir -p "$fixture/packages/trellage-cli"
cp tests/publication_contract.sh "$fixture/tests/publication_contract.sh"
cp .gitignore "$fixture/.gitignore"
cp LICENSE "$fixture/LICENSE"
printf '%s\n' '{"name":"@trellage/profile-compiler","license":"MIT"}' \
  >"$fixture/packages/trellage-cli/package.json"
printf 'RSU fixture\n' >"$fixture/README.md"
git -C "$fixture" add .
if (cd "$fixture" && bash tests/publication_contract.sh --tree-only >/dev/null 2>&1); then
  printf 'publication contract self-test: FAIL: forbidden content was accepted\n' >&2
  exit 1
fi
printf 'Generic fixture\n' >"$fixture/README.md"
git -C "$fixture" add README.md

git -C "$fixture" config --unset user.name
if (cd "$fixture" && bash tests/publication_contract.sh --tree-only \
  >"$fixture/name-output" 2>&1); then
  printf 'publication contract self-test: FAIL: missing local user.name was accepted\n' >&2
  exit 1
fi
grep -Fq 'repo-local user.name must be Samuel Mendenhall' "$fixture/name-output" \
  || {
    printf 'publication contract self-test: FAIL: missing local user.name diagnostic changed\n' >&2
    exit 1
  }
git -C "$fixture" config user.name 'Samuel Mendenhall'

git -C "$fixture" config user.name 'Wrong Author'
git -C "$fixture" config user.email 'wrong@example.invalid'
git -C "$fixture" commit -qm 'fixture commit'
git -C "$fixture" config user.name 'Samuel Mendenhall'
git -C "$fixture" config user.email '2019830+engineersamuel@users.noreply.github.com'
for identity_mode in '--tree-only' ''; do
  identity_status=0
  if [[ -n "$identity_mode" ]]; then
    (cd "$fixture" && bash tests/publication_contract.sh "$identity_mode" \
      >"$fixture/identity-output" 2>&1) || identity_status=$?
  else
    (cd "$fixture" && bash tests/publication_contract.sh \
      >"$fixture/identity-output" 2>&1) || identity_status=$?
  fi
  [[ "$identity_status" -ne 0 ]] \
    || {
      printf 'publication contract self-test: FAIL: %s accepted wrong commit identity\n' \
        "${identity_mode:-default mode}" >&2
      exit 1
    }
  grep -Fq 'unexpected commit identity' "$fixture/identity-output" \
    || {
      printf 'publication contract self-test: FAIL: %s commit identity diagnostic changed\n' \
        "${identity_mode:-default mode}" >&2
      exit 1
    }
done

git -C "$fixture" commit -q --amend --no-edit --reset-author
(cd "$fixture" && bash tests/publication_contract.sh --tree-only >/dev/null)

if (cd "$fixture" && bash tests/publication_contract.sh \
  >"$fixture/full-output" 2>&1); then
  printf 'publication contract self-test: FAIL: default mode accepted incomplete history\n' >&2
  exit 1
fi
grep -Fq 'history must contain exactly two commits' "$fixture/full-output" \
  || {
    printf 'publication contract self-test: FAIL: default topology diagnostic changed\n' >&2
    exit 1
  }

invalid_status=0
(cd "$fixture" && bash tests/publication_contract.sh --invalid \
  >"$fixture/invalid-output" 2>&1) || invalid_status=$?
[[ "$invalid_status" -eq 2 ]] \
  || {
    printf 'publication contract self-test: FAIL: invalid mode returned %s instead of 2\n' \
      "$invalid_status" >&2
    exit 1
  }
printf 'publication contract self-test: PASS\n'
