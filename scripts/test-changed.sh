#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
base_ref="${TEST_CHANGED_BASE:-origin/main}"
files_from=""
dry_run=0
build_profiles=0
committed_only="${TEST_CHANGED_COMMITTED_ONLY:-0}"
targets=()
profiles=()
changed_files=()
parallel_targets=()
serial_targets=()
final_targets=()
shell_files=()
merge_base=""

usage() {
  cat <<'EOF'
Usage: scripts/test-changed.sh [options]

  --base REF         Compare committed changes from the merge base with REF.
  --files-from PATH  Read repository-relative changed paths from PATH.
  --build-profiles   Build selected Sandbox profiles after static tests pass.
  --committed-only   Ignore staged, unstaged, and untracked worktree changes.
  --dry-run          Print selected tests without running them.
  -h, --help         Show this help.

The default comparison base is origin/main. Staged, unstaged, and untracked
files are included unless --committed-only is set. Unmapped source paths fall
back to the explicit full make test suite.
EOF
}

fail() {
  printf 'test-changed: %s\n' "$1" >&2
  exit 1
}

add_unique() {
  local array_name="$1"
  local value="$2"
  local existing
  case "$array_name" in
    targets)
      for existing in "${targets[@]-}"; do
        [[ "$existing" != "$value" ]] || return 0
      done
      targets+=("$value")
      ;;
    profiles)
      for existing in "${profiles[@]-}"; do
        [[ "$existing" != "$value" ]] || return 0
      done
      profiles+=("$value")
      ;;
    shell_files)
      for existing in "${shell_files[@]-}"; do
        [[ "$existing" != "$value" ]] || return 0
      done
      shell_files+=("$value")
      ;;
    *)
      fail "internal array is unsupported: $array_name"
      ;;
  esac
}

add_target() {
  add_unique targets "$1"
}

add_profile() {
  local profile="$1"
  [[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fail "unsafe Sandbox profile name from changed path: $profile"
  if [[ ! -f "$repo_root/profiles/$profile/profile.toml" ]]; then
    add_target test
    return
  fi
  add_unique profiles "$profile"
}

add_all_profiles() {
  local profile_path
  for profile_path in "$repo_root"/profiles/*/profile.toml; do
    [[ -f "$profile_path" ]] || continue
    add_profile "$(basename "$(dirname "$profile_path")")"
  done
}

add_all_codex_targets() {
  add_target native-codex-auth-config-launch
  add_target native-codex-lifecycle
  add_target native-codex-catalog
  add_target native-codex-installation
  add_target native-codex-pstack
  add_target native-codex-harness-version
}

add_all_firstmate_targets() {
  add_target native-firstmate-overlays
  add_target native-firstmate-healing
  add_target native-firstmate-instances
  add_target native-firstmate-lifecycle
}

add_all_native_targets() {
  add_all_codex_targets
  add_target native-copilot-profiles
  add_target native-agency-profile
  add_target native-claude-profile
  add_all_firstmate_targets
  add_target native-jcode-profile
  add_target native-omp-profile
  add_target native-pi-profile
  add_target native-prime-profile
  add_target native-profile-router
}

sort_array() {
  local array_name="$1"
  local value
  local sorted=()
  case "$array_name" in
    targets)
      [[ -n "${targets[*]-}" ]] || return 0
      while IFS= read -r value; do
        [[ -n "$value" ]] && sorted+=("$value")
      done < <(printf '%s\n' "${targets[@]-}" | LC_ALL=C sort -u)
      if [[ -n "${sorted[*]-}" ]]; then
        targets=("${sorted[@]}")
      else
        targets=()
      fi
      ;;
    profiles)
      [[ -n "${profiles[*]-}" ]] || return 0
      while IFS= read -r value; do
        [[ -n "$value" ]] && sorted+=("$value")
      done < <(printf '%s\n' "${profiles[@]-}" | LC_ALL=C sort -u)
      if [[ -n "${sorted[*]-}" ]]; then
        profiles=("${sorted[@]}")
      else
        profiles=()
      fi
      ;;
    *)
      fail "internal array is unsupported: $array_name"
      ;;
  esac
}

collect_git_files() {
  local committed_diff
  local path
  local found=()

  git -C "$repo_root" rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null \
    || fail "comparison base does not resolve to a commit: $base_ref"
  merge_base="$(git -C "$repo_root" merge-base "$base_ref" HEAD)" \
    || fail "could not determine a merge base for $base_ref and HEAD"
  committed_diff="$(
    git -C "$repo_root" diff --no-renames --name-only --diff-filter=ACMRTD "$merge_base...HEAD"
  )" || fail "could not read committed changes from $merge_base to HEAD"
  while IFS= read -r path; do
    if [[ -n "$path" ]]; then
      found+=("$path")
    fi
  done <<<"$committed_diff"

  if [[ "$committed_only" != 1 ]]; then
    for diff_mode in cached worktree; do
      if [[ "$diff_mode" == cached ]]; then
        while IFS= read -r path; do
          if [[ -n "$path" ]]; then
            found+=("$path")
          fi
        done < <(git -C "$repo_root" diff --cached --no-renames --name-only --diff-filter=ACMRTD)
      else
        while IFS= read -r path; do
          if [[ -n "$path" ]]; then
            found+=("$path")
          fi
        done < <(git -C "$repo_root" diff --no-renames --name-only --diff-filter=ACMRTD)
      fi
    done
    while IFS= read -r path; do
      if [[ -n "$path" ]]; then
        found+=("$path")
      fi
    done < <(git -C "$repo_root" ls-files --others --exclude-standard)
  fi

  while IFS= read -r path; do
    if [[ -n "$path" ]]; then
      changed_files+=("$path")
    fi
  done < <(printf '%s\n' "${found[@]-}" | LC_ALL=C sort -u)
}

add_test_file_target() {
  local file="$1"
  case "$file" in
    tests/test_command.py) add_target test-command ;;
    tests/dependency_bootstrap_contract.sh | tests/manage_dependencies_contract.sh) add_target dependency-bootstrap ;;
    tests/development_resolution_contract.sh) add_target development-resolution-contract ;;
    tests/rebuild_profiles_bun_runtime_contract.sh) add_target rebuild-profiles-bun-runtime ;;
    tests/publication_contract.sh) add_target publication-contract ;;
    tests/publication_contract_self_test.sh) add_target publication-contract-self-test ;;
    tests/agent_profile_hup_contract.sh) add_target agent-profile-hup-contract ;;
    tests/floating_skills.test.mjs | tests/composed_skill_snapshot.test.ts) add_target floating-skills-contract ;;
    tests/profile_guides_contract.ts) add_target profile-guide-contract ;;
    tests/profile_compiler_fingerprint_contract.sh) add_target profile-compiler-fingerprint ;;
    tests/trellage_identity_contract.sh) add_target trellage-identity ;;
    tests/trellage_session_bridge_test.py) add_target trellage-session-bridge ;;
    tests/trellage_orphan_cleanup_contract.sh) add_target trellage-orphan-cleanup ;;
    tests/trellage_statusline.sh | tests/trellage_statusline_apply.sh) add_target trellage-statusline ;;
    tests/azure_fresh_install_contract.sh) add_target azure-fresh-install-contract ;;
    tests/agent_harness_contract.sh) add_target agent-harness ;;
    tests/native-harness-version.sh) add_target native-harness-version ;;
    tests/retire_native_backend_contract.sh) add_target native-backend-retirement ;;
    tests/firstmate_overlay_contract.py) add_target native-firstmate-overlays ;;
    tests/manifest_contract.sh) add_target manifest ;;
    tests/harness_contract.sh) add_target contract ;;
    tests/agent_kit_adapter.sh) add_target adapter ;;
    tests/awesome_copilot_adapter.sh) add_target awesome-adapter ;;
    tests/copilot_agent_image.sh) add_target copilot-image ;;
    tests/harness_runner.sh) add_target runner ;;
    tests/run_agent_session.sh | tests/harness_session_discovery.sh) add_target session ;;
    tests/workspace_checks.sh) add_target workspace-checks ;;
    tests/playwright_matrix.sh) add_target playwright-matrix ;;
    tests/evidence_contract.sh) add_target evidence ;;
    tests/native_tui_matrix_test.py) add_target native-tui-matrix-test ;;
    tests/headless_contract_matrix.sh) add_target headless-matrix-static-test ;;
    tests/graph_of_loops_runtime_contract.sh) add_target graph-of-loops-runtime-contract ;;
    tests/source_startup_contract.sh) add_target source-runtime ;;
    tests/test_changed_contract.sh) add_target test-changed-contract ;;
    *) add_target test ;;
  esac
}

add_script_target() {
  local file="$1"
  case "$file" in
    scripts/install-source-runtime.sh | scripts/bun-runtime.sh)
      add_target source-runtime
      add_target rebuild-profiles-bun-runtime
      ;;
    scripts/rebuild-profile-images.sh) add_target rebuild-profiles-bun-runtime ;;
    scripts/azure-fresh-install.sh) add_target azure-fresh-install-contract ;;
    scripts/floating-skills.ts) add_target floating-skills-contract ;;
    scripts/verify-native-tuis) add_target native-tui-matrix-test ;;
    scripts/verify-headless-contracts | scripts/verify-headless-live-contracts)
      add_target headless-matrix-static-test
      ;;
    scripts/assemble-evidence.sh) add_target evidence ;;
    scripts/cleanup-orphaned-trellage-containers.sh) add_target trellage-orphan-cleanup ;;
    scripts/trellage-session-bridge.py) add_target trellage-session-bridge ;;
    scripts/trellage-statusline.sh) add_target trellage-statusline ;;
    scripts/test-changed.sh) add_target test-changed-contract ;;
    scripts/retire-native-backend.sh) add_target native-backend-retirement ;;
    *) add_target test ;;
  esac
}

classify() {
  local file="$1"
  local profile

  if [[ "$file" != */* && "$file" == *.md ]]; then
    return
  fi

  case "$file" in
    profile-guides/*)
      add_target profile-guide-contract
      return
      ;;
    docs/* | plans/*)
      return
      ;;
  esac

  case "$file" in
    profiles/*/*)
      profile="${file#profiles/}"
      add_profile "${profile%%/*}"
      add_target floating-skills-contract
      add_target profile-guide-contract
      add_target manifest
      ;;
    packages/trellage-runtime/*)
      add_target source-runtime
      ;;
    packages/trellage-launcher/*)
      add_target launcher
      ;;
    packages/trellage-conversation-source/*)
      add_target conversation-source
      ;;
    packages/trellage-guide-core/*)
      add_target profile-guide-core
      ;;
    packages/trellage-cli/*)
      add_target profile-compiler
      add_target profile-compiler-fingerprint
      add_target profile-guide-contract
      ;;
    prototypes/trellage-codex-profiles/tests/blocks/auth-config-launch.sh)
      add_target native-codex-auth-config-launch
      ;;
    prototypes/trellage-codex-profiles/tests/blocks/lifecycle.sh)
      add_target native-codex-lifecycle
      ;;
    prototypes/trellage-codex-profiles/tests/blocks/catalog.sh)
      add_target native-codex-catalog
      ;;
    prototypes/trellage-codex-profiles/tests/blocks/installation.sh)
      add_target native-codex-installation
      ;;
    prototypes/trellage-codex-profiles/tests/blocks/pstack.sh)
      add_target native-codex-pstack
      ;;
    prototypes/trellage-codex-profiles/tests/blocks/harness-version.sh)
      add_target native-codex-harness-version
      ;;
    prototypes/trellage-codex-profiles/*)
      add_all_codex_targets
      ;;
    prototypes/trellage-copilot-profiles/*)
      add_target native-copilot-profiles
      ;;
    prototypes/trellage-agency-profiles/*)
      add_target native-agency-profile
      ;;
    prototypes/trellage-claude-profiles/*)
      add_target native-claude-profile
      ;;
    prototypes/trellage-firstmate-profiles/overlay/* | \
      prototypes/trellage-firstmate-profiles/instance-overlay/* | \
      prototypes/trellage-firstmate-profiles/tests/fixtures/* | \
      prototypes/trellage-firstmate-profiles/lib/firstmate-overlay.py)
      add_target native-firstmate-overlays
      ;;
    prototypes/trellage-firstmate-profiles/tests/healing-contract.py)
      add_target native-firstmate-healing
      ;;
    prototypes/trellage-firstmate-profiles/tests/instances-contract.py)
      add_target native-firstmate-instances
      ;;
    prototypes/trellage-firstmate-profiles/tests/pinned-contract.py | \
      prototypes/trellage-firstmate-profiles/tests/fleet-contract.sh)
      add_target native-firstmate-lifecycle
      ;;
    prototypes/trellage-firstmate-profiles/tests/contract.sh)
      add_all_firstmate_targets
      ;;
    prototypes/trellage-firstmate-profiles/*)
      add_all_firstmate_targets
      ;;
    prototypes/trellage-jcode-profiles/*)
      add_target native-jcode-profile
      ;;
    prototypes/trellage-omp-profiles/*)
      add_target native-omp-profile
      ;;
    prototypes/trellage-pi-profiles/*)
      add_target native-pi-profile
      ;;
    prototypes/trellage-prime-profiles/*)
      add_target native-prime-profile
      ;;
    prototypes/trellage-router/*)
      add_target native-profile-router
      ;;
    prototypes/trellage-claude-common/*)
      add_all_codex_targets
      add_target floating-skills-contract
      add_target native-claude-profile
      add_all_firstmate_targets
      add_target native-jcode-profile
      ;;
    prototypes/trellage-codex-common/*)
      add_all_codex_targets
      add_target native-profile-router
      add_target native-tui-matrix-test
      ;;
    prototypes/trellage/tests/claude*)
      add_target claude-entry
      ;;
    prototypes/trellage/tests/copilot*)
      add_target copilot-entry
      ;;
    prototypes/trellage/tests/headlong*)
      add_target headlong-entry
      ;;
    prototypes/trellage/tests/pi*)
      add_target pi-entry
      ;;
    prototypes/trellage/tests/prime*)
      add_target prime-entry
      ;;
    prototypes/trellage/tests/host_command_contract.sh)
      add_target trellage-host-runtime
      add_target trellage-host-headless-test
      ;;
    prototypes/trellage/tests/remote_azure_contract.sh)
      add_target remote-azure-contract
      ;;
    prototypes/trellage/tests/*)
      add_target test
      ;;
    prototypes/trellage/*)
      add_target trellage-host-runtime
      add_target trellage-host-headless-test
      add_target claude-entry
      add_target copilot-entry
      add_target headlong-entry
      add_target pi-entry
      add_target prime-entry
      add_all_profiles
      ;;
    scripts/*) add_script_target "$file" ;;
    tests/*) add_test_file_target "$file" ;;
    .agents/* | .github/instructions/*)
      add_target agent-harness
      ;;
    lefthook.yml)
      add_target agent-harness
      add_target test-changed-contract
      ;;
    config.toml)
      add_target floating-skills-contract
      add_all_native_targets
      add_all_profiles
      ;;
    package.json | bun.lock | bunfig.toml | tsconfig.json | tsconfig.base.json | Makefile | \
      .github/workflows/* | harnesses/* | Dockerfile*)
      add_target test
      ;;
    *)
      add_target test
      ;;
  esac

  case "$file" in
    *.sh)
      add_unique shell_files "$file"
      ;;
  esac
}

while (( $# > 0 )); do
  case "$1" in
    --base)
      [[ $# -ge 2 ]] || fail "--base requires a ref"
      base_ref="$2"
      shift 2
      ;;
    --files-from)
      [[ $# -ge 2 ]] || fail "--files-from requires a path"
      files_from="$2"
      shift 2
      ;;
    --build-profiles)
      build_profiles=1
      shift
      ;;
    --committed-only)
      committed_only=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

cd "$repo_root"
if [[ -n "$files_from" ]]; then
  [[ -f "$files_from" && ! -L "$files_from" ]] || fail "files list is missing or unsafe: $files_from"
  while IFS= read -r file; do
    if [[ -n "$file" ]]; then
      changed_files+=("$file")
    fi
  done <"$files_from"
else
  collect_git_files
fi

if [[ -z "${changed_files[*]-}" ]]; then
  printf 'test-changed: no changed files\n'
  exit 0
fi

for file in "${changed_files[@]-}"; do
  [[ "$file" != /* && "$file" != ../* && "$file" != */../* ]] \
    || fail "changed path must be repository-relative: $file"
  classify "$file"
done

sort_array targets
sort_array profiles

full_test_selected=0
for target in "${targets[@]-}"; do
  [[ "$target" != test ]] || full_test_selected=1
done

if (( full_test_selected == 1 )); then
  targets=(test)
  shell_files=()
fi

for target in "${targets[@]-}"; do
  case "$target" in
    profile-compiler-fingerprint | native-pi-profile | native-codex-auth-config-launch | \
      native-codex-lifecycle | native-omp-profile | native-claude-profile | native-tui-matrix-test | \
      native-firstmate-healing | native-firstmate-instances | native-firstmate-lifecycle | \
      headlong-entry | test)
      serial_targets+=("$target")
      ;;
    native-profile-router | trellage-host-headless-test)
      final_targets+=("$target")
      ;;
    *)
      parallel_targets+=("$target")
      ;;
  esac
done

targets=("${parallel_targets[@]-}" "${serial_targets[@]-}")
targets+=("${final_targets[@]-}")
sort_array targets

if [[ -n "${targets[*]-}" ]]; then
  printf 'test-changed: make targets: %s\n' "${targets[*]}"
else
  printf 'test-changed: make targets: none\n'
fi
if [[ -n "${profiles[*]-}" ]]; then
  printf 'test-changed: sandbox profiles: %s\n' "${profiles[*]}"
else
  printf 'test-changed: sandbox profiles: none\n'
fi
if (( build_profiles == 1 )); then
  printf 'test-changed: sandbox builds: enabled\n'
else
  printf 'test-changed: sandbox builds: disabled\n'
fi
if [[ -n "${shell_files[*]-}" ]]; then
  printf 'test-changed: shell files: %s\n' "${shell_files[*]}"
else
  printf 'test-changed: shell files: none\n'
fi

(( dry_run == 0 )) || exit 0

if [[ -n "$merge_base" ]]; then
  git diff --check "$merge_base...HEAD"
fi
if (( committed_only == 0 )); then
  git diff --cached --check
  git diff --check
fi
if [[ -n "${shell_files[*]-}" ]]; then
  scripts/check-shell-syntax.sh "${shell_files[@]}"
fi
if [[ -n "${parallel_targets[*]-}" ]]; then
  make --no-print-directory TEST_TIMING=1 -j"${TEST_JOBS:-4}" "${parallel_targets[@]}"
fi
if [[ -n "${serial_targets[*]-}" ]]; then
  make --no-print-directory TEST_TIMING=1 -j1 "${serial_targets[@]}"
fi
if [[ -n "${final_targets[*]-}" ]]; then
  make --no-print-directory TEST_TIMING=1 -j"${TEST_JOBS:-4}" "${final_targets[@]}"
fi
if (( build_profiles == 1 )) && [[ -n "${profiles[*]-}" ]]; then
  scripts/rebuild-profile-images.sh --sandbox-only "${profiles[@]}"
fi
