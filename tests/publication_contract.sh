#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mode='tree'
case "$#" in
  0) ;;
  1)
    [[ "$1" == '--sanitized-history' ]] || {
      printf 'usage: tests/publication_contract.sh [--sanitized-history]\n' >&2
      exit 2
    }
    mode='sanitized-history'
    ;;
  *)
    printf 'usage: tests/publication_contract.sh [--sanitized-history]\n' >&2
    exit 2
    ;;
esac

fail() {
  printf 'publication contract: FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f LICENSE ]] || fail 'MIT LICENSE is missing'
grep -Fxq 'MIT License' LICENSE || fail 'LICENSE is not MIT'
grep -Fxq 'Copyright (c) 2026 Samuel Mendenhall' LICENSE \
  || fail 'LICENSE copyright identity changed'
jq -e '
  .name == "@trellage/profile-compiler"
  and .license == "MIT"
' packages/trellage-cli/package.json >/dev/null \
  || fail 'profile compiler package identity or MIT license changed'
jq -e '
  .name == "@trellage/guide-core"
  and .private == true
  and .license == "MIT"
' packages/trellage-guide-core/package.json >/dev/null \
  || fail 'profile guide core package identity or MIT license changed'
package_manifest="$(npm pack --dry-run --ignore-scripts --json)" \
  || fail 'npm package contents could not be inspected'
jq -e '
  .[0].files
  | any(.path == "scripts/trellage-session-bridge.py")
' <<<"$package_manifest" >/dev/null \
  || fail 'npm package omits the Trellage session bridge'

for required_ignore in \
  '/.claude/' '/.hyperresearch/' '/.scratch/' '/research/' '/evidence/' \
  '/codex-*.png' '/copilot-*.png' '/CLAUDE.md' \
  '/docs/superpowers/plans/' '/docs/superpowers/specs/' \
  '.env' '.env.*' '!.env.example'; do
  grep -Fxq -- "$required_ignore" .gitignore \
    || fail "missing exact .gitignore rule: $required_ignore"
done

for forbidden_path in \
  '.claude' '.hyperresearch' '.scratch' 'research' 'evidence' \
  'harnesses/rsu-decision-side-by-side' 'docs/superpowers/plans' \
  'docs/superpowers/specs' '.agents/skills'; do
  if git ls-files -- "$forbidden_path" "$forbidden_path/**" | grep -q .; then
    fail "forbidden tracked path: $forbidden_path"
  fi
done

if git ls-files | grep -Eq '(^|/)(STYLESEED\.md|skills-lock\.json|CLAUDE\.md)$|(^|/)(codex|copilot)-.*\.png$|tests/playwright/(fixtures/|rsu\.spec\.ts$)'; then
  fail 'forbidden tracked artifact or RSU fixture'
fi

if git grep -n -I -i -E '(^|[^[:alnum:]_])rsu([^[:alnum:]_]|$)|restricted stock|etrade|e\*trade' -- . ':!tests/publication_contract.sh' ':!tests/publication_contract_self_test.sh'; then
  fail 'forbidden RSU content'
fi

if git grep -n -I -E '/Users/smendenhall|/private/var/folders|/var/folders|/Volumes/|/(Users|home|tmp|var|private|Volumes)/[^[:space:]]*\.csv' -- . ':!tests/publication_contract.sh' ':!tests/publication_contract_self_test.sh'; then
  fail 'forbidden personal or private absolute path'
fi

if git grep -n -I -E 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' -- . ':!tests/publication_contract.sh' ':!tests/publication_contract_self_test.sh'; then
  fail 'obvious secret material is tracked'
fi

if [[ "$mode" == 'sanitized-history' ]]; then
  [ "$(git config --local --get user.name || true)" = 'Samuel Mendenhall' ] \
    || fail 'repo-local user.name must be Samuel Mendenhall'
  [ "$(git config --local --get user.email || true)" = \
    '2019830+engineersamuel@users.noreply.github.com' ] \
    || fail 'repo-local user.email must be 2019830+engineersamuel@users.noreply.github.com'
  if git log --all --format='%ae%n%ce' | grep -Eq '@[^[:space:]]*\.local$'; then
    fail 'forbidden local author or committer email'
  fi
  [ "$(git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u)" = \
    'Samuel Mendenhall <2019830+engineersamuel@users.noreply.github.com>' ] \
    || fail 'unexpected commit identity'
  [ "$(git rev-list --all --count)" -eq 2 ] || fail 'history must contain exactly two commits'
  [ "$(git rev-list --max-parents=0 --all | wc -l | tr -d ' ')" -eq 1 ] \
    || fail 'history must contain exactly one root commit'
  [ "$(git remote | wc -l | tr -d ' ')" -eq 0 ] || fail 'repository must have no remotes'
  [ "$(git tag | wc -l | tr -d ' ')" -eq 0 ] || fail 'repository must have no tags'
  [ "$(git for-each-ref --format='%(refname)' refs/heads | sort)" = $'refs/heads/feat/native-codex-profile-isolation\nrefs/heads/main' ] \
    || fail 'unexpected branch refs'
fi

printf 'publication contract: PASS\n'
