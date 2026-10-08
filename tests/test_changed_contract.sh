#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
selector="$repo_root/scripts/test-changed.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-test-changed.XXXXXX")"

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fail() {
  printf 'test changed contract: FAIL: %s\n' "$1" >&2
  exit 1
}

select_files() {
  local name="$1"
  shift
  printf '%s\n' "$@" >"$fixture_root/$name.files"
  "$selector" --dry-run --files-from "$fixture_root/$name.files"
}

default_recipe="$(make -C "$repo_root" --no-print-directory -n)"
[[ "$default_recipe" == 'bash scripts/test-changed.sh' ]] \
  || fail "bare make does not default to test-changed: $default_recipe"

output="$(select_files copilot prototypes/trellage-copilot-profiles/install.sh)"
grep -Fqx 'test-changed: make targets: native-copilot-profiles' <<<"$output" \
  || fail "Copilot-private change selected unexpected targets: $output"
grep -Fqx 'test-changed: sandbox profiles: none' <<<"$output" \
  || fail 'Copilot-private change selected Sandbox profiles'
grep -Fqx 'test-changed: sandbox builds: disabled' <<<"$output" \
  || fail 'Copilot-private change enabled Sandbox builds'
grep -Fqx 'test-changed: shell files: prototypes/trellage-copilot-profiles/install.sh' <<<"$output" \
  || fail 'Copilot-private change did not select only its changed shell file'

output="$(select_files codex-lifecycle prototypes/trellage-codex-profiles/tests/blocks/lifecycle.sh)"
grep -Fqx 'test-changed: make targets: native-codex-lifecycle' <<<"$output" \
  || fail "Codex lifecycle change selected unrelated Codex slices: $output"

output="$(select_files runtime packages/trellage-runtime/src/workspace-cli.ts)"
grep -Fqx 'test-changed: make targets: source-runtime' <<<"$output" \
  || fail "runtime change did not select source-runtime: $output"

output="$(select_files sandbox profiles/copilot-hve/profile.toml)"
grep -Fqx 'test-changed: make targets: floating-skills-contract manifest profile-guide-contract' <<<"$output" \
  || fail "private Sandbox profile omitted static contracts: $output"
grep -Fqx 'test-changed: sandbox profiles: copilot-hve' <<<"$output" \
  || fail "private Sandbox profile did not select only itself: $output"
grep -Fqx 'test-changed: sandbox builds: disabled' <<<"$output" \
  || fail 'private Sandbox profile enabled its build by default'

printf '%s\n' profiles/copilot-hve/profile.toml >"$fixture_root/sandbox-build.files"
output="$("$selector" --dry-run --build-profiles --files-from "$fixture_root/sandbox-build.files")"
grep -Fqx 'test-changed: sandbox builds: enabled' <<<"$output" \
  || fail 'explicit Sandbox build mode was not enabled'

output="$(select_files docs docs/verification.md)"
grep -Fqx 'test-changed: make targets: none' <<<"$output" \
  || fail "documentation-only change selected tests: $output"
grep -Fqx 'test-changed: sandbox profiles: none' <<<"$output" \
  || fail 'documentation-only change selected Sandbox profiles'

output="$(select_files unknown tests/new_integration_contract.sh)"
grep -Fqx 'test-changed: make targets: test' <<<"$output" \
  || fail "unmapped source change did not fall back to the full suite: $output"
grep -Fqx 'test-changed: shell files: none' <<<"$output" \
  || fail 'full-suite fallback repeated changed-only shell syntax checks'

output="$(select_files functional-markdown .agents/rules/runtime.md)"
grep -Fqx 'test-changed: make targets: agent-harness' <<<"$output" \
  || fail "functional Markdown was skipped: $output"

output="$(select_files shared-sandbox prototypes/trellage/runtime-entry.sh)"
profile_count="$(sed -n 's/^test-changed: sandbox profiles: //p' <<<"$output" | wc -w | tr -d ' ')"
expected_profile_count="$(find "$repo_root/profiles" -mindepth 2 -maxdepth 2 -name profile.toml | wc -l | tr -d ' ')"
[[ "$profile_count" == "$expected_profile_count" ]] \
  || fail "shared Sandbox runtime selected $profile_count/$expected_profile_count profiles"
grep -Fq 'trellage-host-runtime' <<<"$output" \
  || fail 'shared Sandbox runtime omitted host runtime contracts'

output="$(select_files sandbox-test prototypes/trellage/tests/copilot_entry_contract.sh)"
grep -Fqx 'test-changed: make targets: copilot-entry' <<<"$output" \
  || fail "Copilot entry test selected unrelated Sandbox contracts: $output"
grep -Fqx 'test-changed: sandbox profiles: none' <<<"$output" \
  || fail 'Copilot entry test selected Sandbox image builds'

output="$(select_files deleted-profile profiles/removed-profile/profile.toml)"
grep -Fqx 'test-changed: make targets: test' <<<"$output" \
  || fail "deleted Sandbox profile did not fall back safely: $output"

while IFS= read -r test_file; do
  relative_test="${test_file#"$repo_root"/}"
  output="$(select_files test-reachability "$relative_test")"
  if grep -Fqx 'test-changed: make targets: none' <<<"$output"; then
    fail "test file is unreachable from the selector: $relative_test"
  fi
done < <(find "$repo_root/tests" -maxdepth 1 -type f -print | LC_ALL=C sort)

git_fixture="$fixture_root/git-repo"
mkdir -p "$git_fixture/scripts" "$git_fixture/packages/trellage-runtime/src"
cp "$selector" "$git_fixture/scripts/test-changed.sh"
git -C "$git_fixture" init -q
git -C "$git_fixture" config user.name "Trellage Test"
git -C "$git_fixture" config user.email "trellage-test@example.invalid"
printf 'fixture\n' >"$git_fixture/README.md"
git -C "$git_fixture" add README.md scripts/test-changed.sh
git -C "$git_fixture" commit -qm initial

output="$(cd "$git_fixture" && scripts/test-changed.sh --dry-run --base HEAD)"
grep -Fqx 'test-changed: no changed files' <<<"$output" \
  || fail "clean repository did not exit cleanly: $output"

if missing_base_output="$(cd "$git_fixture" && scripts/test-changed.sh --dry-run --base refs/heads/missing 2>&1)"; then
  fail 'missing comparison base unexpectedly succeeded'
fi
grep -Fqx 'test-changed: comparison base does not resolve to a commit: refs/heads/missing' \
  <<<"$missing_base_output" || fail "missing base error was unclear: $missing_base_output"

printf 'dirty\n' >"$git_fixture/packages/trellage-runtime/src/dirty.ts"
output="$(cd "$git_fixture" && scripts/test-changed.sh --dry-run --base HEAD --committed-only)"
grep -Fqx 'test-changed: no changed files' <<<"$output" \
  || fail "committed-only mode included dirty worktree state: $output"
output="$(cd "$git_fixture" && scripts/test-changed.sh --dry-run --base HEAD)"
grep -Fqx 'test-changed: make targets: source-runtime' <<<"$output" \
  || fail "default mode omitted dirty worktree state: $output"

printf 'test changed contract: PASS\n'
