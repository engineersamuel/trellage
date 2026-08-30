#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/publication-contract.XXXXXX")"
cleanup() { rm -rf -- "$fixture_root"; }
trap cleanup EXIT

fail() {
  printf 'publication contract self-test: FAIL: %s\n' "$1" >&2
  exit 1
}

fixture_git() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git "$@"
}

seed_fixture() {
  local fixture="$1"
  fixture_git init -q -b main "$fixture"
  mkdir -p \
    "$fixture/scripts" \
    "$fixture/tests" \
    "$fixture/packages/trellage-cli" \
    "$fixture/packages/trellage-guide-core"
  cp tests/publication_contract.sh "$fixture/tests/publication_contract.sh"
  cp .gitignore "$fixture/.gitignore"
  cp LICENSE "$fixture/LICENSE"
  printf '%s\n' '{"name":"@trellage/profile-compiler","license":"MIT"}' \
    >"$fixture/packages/trellage-cli/package.json"
  printf '%s\n' '{"name":"@trellage/guide-core","private":true,"license":"MIT"}' \
    >"$fixture/packages/trellage-guide-core/package.json"
  printf '%s\n' \
    '{"name":"trellage-publication-fixture","version":"0.0.0","files":["scripts/trellage-session-bridge.py"]}' \
    >"$fixture/package.json"
  printf '%s\n' '#!/usr/bin/env python3' >"$fixture/scripts/trellage-session-bridge.py"
  printf 'Generic fixture\n' >"$fixture/README.md"
}

run_contract() {
  local fixture="$1"
  shift
  (
    cd "$fixture"
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
      bash tests/publication_contract.sh "$@"
  )
}

tree_fixture="$fixture_root/tree"
seed_fixture "$tree_fixture"
fixture_git -C "$tree_fixture" config user.name 'Unrelated Contributor'
fixture_git -C "$tree_fixture" config user.email 'contributor@example.invalid'
fixture_git -C "$tree_fixture" add .
fixture_git -C "$tree_fixture" commit --no-verify -qm 'tree fixture one'
printf 'Second tree state\n' >>"$tree_fixture/README.md"
fixture_git -C "$tree_fixture" commit --no-verify -qam 'tree fixture two'
printf 'Third tree state\n' >>"$tree_fixture/README.md"
fixture_git -C "$tree_fixture" commit --no-verify -qam 'tree fixture three'
fixture_git -C "$tree_fixture" branch extra-branch
fixture_git -C "$tree_fixture" tag extra-tag
fixture_git -C "$tree_fixture" remote add origin https://example.invalid/trellage.git
run_contract "$tree_fixture" >/dev/null \
  || fail 'default tree mode rejected contributor or additional Git state'

printf 'RSU fixture\n' >"$tree_fixture/README.md"
if run_contract "$tree_fixture" >"$fixture_root/content-output" 2>&1; then
  fail 'forbidden content was accepted'
fi
grep -Fq 'forbidden RSU content' "$fixture_root/content-output" \
  || fail 'forbidden content diagnostic changed'
fixture_git -C "$tree_fixture" restore README.md

sed 's|^/research/$|/research/runs/|' "$tree_fixture/.gitignore" \
  >"$tree_fixture/.gitignore.tmp"
mv "$tree_fixture/.gitignore.tmp" "$tree_fixture/.gitignore"
if run_contract "$tree_fixture" >"$fixture_root/research-ignore-output" 2>&1; then
  fail 'narrow research ignore rule was accepted'
fi
grep -Fq 'missing exact .gitignore rule: /research/' "$fixture_root/research-ignore-output" \
  || fail 'research ignore diagnostic changed'
fixture_git -C "$tree_fixture" restore .gitignore

mkdir -p "$tree_fixture/research"
printf 'tracked research\n' >"$tree_fixture/research/notes.md"
fixture_git -C "$tree_fixture" add -f research/notes.md
if run_contract "$tree_fixture" >"$fixture_root/tracked-research-output" 2>&1; then
  fail 'tracked research content was accepted'
fi
grep -Fq 'forbidden tracked path: research' "$fixture_root/tracked-research-output" \
  || fail 'tracked research diagnostic changed'
fixture_git -C "$tree_fixture" rm -qf research/notes.md

history_fixture="$fixture_root/history"
seed_fixture "$history_fixture"
fixture_git -C "$history_fixture" config user.name 'Samuel Mendenhall'
fixture_git -C "$history_fixture" config user.email '2019830+engineersamuel@users.noreply.github.com'
fixture_git -C "$history_fixture" add .
fixture_git -C "$history_fixture" commit --no-verify -qm 'history fixture one'
fixture_git -C "$history_fixture" branch feat/native-codex-profile-isolation
printf 'Second approved state\n' >>"$history_fixture/README.md"
fixture_git -C "$history_fixture" commit --no-verify -qam 'history fixture two'
run_contract "$history_fixture" --sanitized-history >/dev/null \
  || fail 'valid sanitized history was rejected'

cp -R "$history_fixture" "$fixture_root/history-extra-commit"
printf 'Third state\n' >>"$fixture_root/history-extra-commit/README.md"
fixture_git -C "$fixture_root/history-extra-commit" commit --no-verify -qam 'history fixture three'
if run_contract "$fixture_root/history-extra-commit" --sanitized-history \
  >"$fixture_root/history-output" 2>&1; then
  fail 'sanitized-history mode accepted an extra commit'
fi
grep -Fq 'history must contain exactly two commits' "$fixture_root/history-output" \
  || fail 'sanitized history topology diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-wrong-author"
fixture_git -C "$fixture_root/history-wrong-author" config user.name 'Wrong Author'
fixture_git -C "$fixture_root/history-wrong-author" config user.email 'wrong@example.invalid'
fixture_git -C "$fixture_root/history-wrong-author" commit --no-verify -q --amend --no-edit --reset-author
fixture_git -C "$fixture_root/history-wrong-author" config user.name 'Samuel Mendenhall'
fixture_git -C "$fixture_root/history-wrong-author" config user.email \
  '2019830+engineersamuel@users.noreply.github.com'
if run_contract "$fixture_root/history-wrong-author" --sanitized-history \
  >"$fixture_root/identity-output" 2>&1; then
  fail 'sanitized-history mode accepted a wrong commit identity'
fi
grep -Fq 'unexpected commit identity' "$fixture_root/identity-output" \
  || fail 'sanitized history identity diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-wrong-author-only"
GIT_AUTHOR_NAME='Wrong Author' \
GIT_AUTHOR_EMAIL='wrong-author@example.invalid' \
GIT_COMMITTER_NAME='Samuel Mendenhall' \
GIT_COMMITTER_EMAIL='2019830+engineersamuel@users.noreply.github.com' \
  fixture_git -C "$fixture_root/history-wrong-author-only" commit --no-verify -q --amend --no-edit --reset-author
[[ "$(fixture_git -C "$fixture_root/history-wrong-author-only" log -1 \
  --format='%an <%ae>|%cn <%ce>')" = \
  'Wrong Author <wrong-author@example.invalid>|Samuel Mendenhall <2019830+engineersamuel@users.noreply.github.com>' ]] \
  || fail 'wrong-author-only fixture identity is invalid'
if run_contract "$fixture_root/history-wrong-author-only" --sanitized-history \
  >"$fixture_root/author-only-output" 2>&1; then
  fail 'sanitized-history mode accepted a wrong author with approved committer'
fi
grep -Fq 'unexpected commit identity' "$fixture_root/author-only-output" \
  || fail 'sanitized history author-only diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-wrong-committer-only"
GIT_AUTHOR_NAME='Samuel Mendenhall' \
GIT_AUTHOR_EMAIL='2019830+engineersamuel@users.noreply.github.com' \
GIT_COMMITTER_NAME='Wrong Committer' \
GIT_COMMITTER_EMAIL='wrong-committer@example.invalid' \
  fixture_git -C "$fixture_root/history-wrong-committer-only" commit --no-verify -q --amend --no-edit --reset-author
[[ "$(fixture_git -C "$fixture_root/history-wrong-committer-only" log -1 \
  --format='%an <%ae>|%cn <%ce>')" = \
  'Samuel Mendenhall <2019830+engineersamuel@users.noreply.github.com>|Wrong Committer <wrong-committer@example.invalid>' ]] \
  || fail 'wrong-committer-only fixture identity is invalid'
if run_contract "$fixture_root/history-wrong-committer-only" --sanitized-history \
  >"$fixture_root/committer-only-output" 2>&1; then
  fail 'sanitized-history mode accepted an approved author with wrong committer'
fi
grep -Fq 'unexpected commit identity' "$fixture_root/committer-only-output" \
  || fail 'sanitized history committer-only diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-missing-local-identity"
fixture_git -C "$fixture_root/history-missing-local-identity" config --unset user.name
if run_contract "$fixture_root/history-missing-local-identity" --sanitized-history \
  >"$fixture_root/local-identity-output" 2>&1; then
  fail 'sanitized-history mode accepted missing local identity'
fi
grep -Fq 'repo-local user.name must be Samuel Mendenhall' \
  "$fixture_root/local-identity-output" \
  || fail 'sanitized history local identity diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-extra-refs"
fixture_git -C "$fixture_root/history-extra-refs" remote add origin https://example.invalid/trellage.git
if run_contract "$fixture_root/history-extra-refs" --sanitized-history \
  >"$fixture_root/refs-output" 2>&1; then
  fail 'sanitized-history mode accepted a remote'
fi
grep -Fq 'repository must have no remotes' "$fixture_root/refs-output" \
  || fail 'sanitized history remote diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-tagged"
fixture_git -C "$fixture_root/history-tagged" tag unexpected-tag
if run_contract "$fixture_root/history-tagged" --sanitized-history \
  >"$fixture_root/tag-output" 2>&1; then
  fail 'sanitized-history mode accepted a tag'
fi
grep -Fq 'repository must have no tags' "$fixture_root/tag-output" \
  || fail 'sanitized history tag diagnostic changed'

cp -R "$history_fixture" "$fixture_root/history-extra-branch"
fixture_git -C "$fixture_root/history-extra-branch" branch unexpected-branch
if run_contract "$fixture_root/history-extra-branch" --sanitized-history \
  >"$fixture_root/branch-output" 2>&1; then
  fail 'sanitized-history mode accepted an extra branch'
fi
grep -Fq 'unexpected branch refs' "$fixture_root/branch-output" \
  || fail 'sanitized history branch diagnostic changed'

invalid_status=0
run_contract "$tree_fixture" --invalid >"$fixture_root/invalid-output" 2>&1 \
  || invalid_status=$?
[[ "$invalid_status" -eq 2 ]] \
  || fail "invalid mode returned $invalid_status instead of 2"

printf 'publication contract self-test: PASS\n'
