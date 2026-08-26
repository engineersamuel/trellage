#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
cd "${ROOT}"

fail() {
  printf 'agent harness contract: FAIL: %s\n' "$1" >&2
  exit 1
}

[[ ! -e biome.json && ! -L biome.json ]] || fail "biome.json must be removed"
[[ ! -e .cursor && ! -L .cursor ]] || fail ".cursor must be removed"
[[ ! -e .mcp.json && ! -L .mcp.json ]] || fail "root .mcp.json must move under .agents"

for required in \
  .agents/rules/trellage-cli.md \
  .agents/hooks/guard-shell.sh \
  .agents/hooks/check-edit.sh \
  .agents/mcp_config.json \
  .github/instructions/trellage-cli.instructions.md \
  .eslintrc.json \
  .prettierrc.json \
  scripts/build-profile-compiler.sh \
  scripts/profile-compiler-fingerprint.sh \
  scripts/install-lefthook-hook.sh; do
  [[ -f "${required}" ]] || fail "missing ${required}"
done

[[ -x .agents/hooks/guard-shell.sh ]] || fail "guard hook is not executable"
[[ -x .agents/hooks/check-edit.sh ]] || fail "edit hook is not executable"
[[ -x scripts/build-profile-compiler.sh ]] || fail "profile compiler build script is not executable"
[[ -x scripts/profile-compiler-fingerprint.sh ]] \
  || fail "profile compiler fingerprint script is not executable"
[[ -x scripts/install-lefthook-hook.sh ]] || fail "Lefthook installer is not executable"

jq -e '
  .devDependencies.oxlint and
  .devDependencies.oxfmt and
  (.devDependencies["@biomejs/biome"] | not) and
  .devDependencies.lefthook and
  (.scripts.lint | startswith("oxlint ")) and
  (.scripts["lint:fix"] | startswith("oxlint ")) and
  .scripts.build == "bash ../../scripts/build-profile-compiler.sh" and
  .scripts.prepare == "bash ../../scripts/install-lefthook-hook.sh" and
  .scripts.format == "cd ../.. && packages/trellage-cli/node_modules/.bin/oxfmt --config .prettierrc.json '\''packages/trellage-cli/src/*.ts'\'' '\''packages/trellage-cli/test/*.ts'\'' packages/trellage-cli/package.json .eslintrc.json .prettierrc.json .agents/mcp_config.json" and
  .scripts["format:check"] == "cd ../.. && packages/trellage-cli/node_modules/.bin/oxfmt --check --config .prettierrc.json '\''packages/trellage-cli/src/*.ts'\'' '\''packages/trellage-cli/test/*.ts'\'' packages/trellage-cli/package.json .eslintrc.json .prettierrc.json .agents/mcp_config.json"
' packages/trellage-cli/package.json >/dev/null || fail "package scripts or dependencies do not use Oxc"

jq -e '.mcpServers["codebase-memory"].command == "codebase-memory-mcp"' \
  .agents/mcp_config.json >/dev/null || fail "generic MCP configuration is invalid"

rg -q '\.agents/rules/trellage-cli\.md' .github/instructions/trellage-cli.instructions.md \
  || fail "GitHub instruction does not reference canonical generic rule"

ci_tool_probe='for tool in jq curl git make fish rg; do command -v "$tool" >/dev/null; done'
for required_ci_line in \
  '          ref: ${{ github.event.pull_request.head.sha || github.sha }}' \
  '          fetch-depth: 2' \
  '        run: sudo apt-get install --yes --no-install-recommends fish ripgrep' \
  "        run: ${ci_tool_probe}" \
  '        run: npm ci --prefix packages/trellage-cli' \
  '        run: npm ci --prefix packages/trellage-guide-core' \
  '        run: npm ci --prefix packages/trellage-launcher' \
  '        run: npm ci --prefix tests/playwright' \
  '        run: make test'; do
  grep -Fxq -- "$required_ci_line" .github/workflows/ci.yml \
    || fail "CI does not run the full deterministic contract: $required_ci_line"
done
if (
  ci_tool_probe_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-ci-tool-probe.XXXXXX")"
  trap 'rm -rf -- "${ci_tool_probe_root}"' EXIT
  for tool in jq git make fish rg; do
    ln -s /usr/bin/true "${ci_tool_probe_root}/${tool}"
  done
  PATH="${ci_tool_probe_root}" /bin/bash -e -c "${ci_tool_probe}"
); then
  fail 'CI system-tool probe does not fail when an intermediate tool is missing'
fi
if grep -Eq -- 'git config --local user\.(name|email)|PUBLICATION_CONTRACT_ARGS|publication-history-audit|--sanitized-history' \
  .github/workflows/ci.yml; then
  fail 'CI invokes contributor-specific or point-in-time publication assertions'
fi
if grep -Eq -- 'PROFILE_MATRIX_ARGS=--live|make compare|docker compose (build|up|run)' \
  .github/workflows/ci.yml; then
  fail 'CI invokes a paid or live Docker verification surface'
fi

probe_failures=()

for risky_command in \
  "rm -rf target" \
  "rm -fr target" \
  "git reset --hard HEAD" \
  "git clean -f" \
  "git push --force origin main" \
  "docker volume rm trellage-data" \
  "rm -r -f target" \
  "rm --recursive --force target" \
  "git push -f origin main" \
  "git -C /tmp reset --hard HEAD" \
  "git clean -d -f" \
  "/bin/rm -rf target" \
  "/usr/bin/git reset --hard HEAD" \
  "rm -Rf target" \
  "git push --force-with-lease origin main" \
  "(rm -rf target)" \
  "sh -c 'rm -rf target'"; do
  risky_output="$(jq -nc --arg command "${risky_command}" '{
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: {command: $command}
  }' | .agents/hooks/guard-shell.sh)"
  if ! jq -e '.hookSpecificOutput.permissionDecision == "ask"' <<<"${risky_output}" >/dev/null; then
    probe_failures+=("guard allowed: ${risky_command}")
  fi
done

for uncertain_command in \
  '`rm -rf target`' \
  '\rm -rf target' \
  '"rm" -rf target' \
  "'/bin/rm' -rf target"; do
  uncertain_output="$(jq -nc --arg command "${uncertain_command}" '{
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: {command: $command}
  }' | .agents/hooks/guard-shell.sh)"
  if jq -e '.hookSpecificOutput.permissionDecision == "allow"' <<<"${uncertain_output}" >/dev/null; then
    probe_failures+=("guard auto-allowed uncertain syntax: ${uncertain_command}")
  fi
done

safe_output="$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}' | .agents/hooks/guard-shell.sh)"
jq -e '.hookSpecificOutput.permissionDecision == "allow"' <<<"${safe_output}" >/dev/null \
  || fail "guard hook did not allow safe command"

unmatched_output="$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hello"}}' | .agents/hooks/guard-shell.sh)"
jq -e 'type == "object" and length == 0' <<<"${unmatched_output}" >/dev/null \
  || probe_failures+=("guard did not return neutral output for unmatched command: echo hello")

temp_ts="packages/trellage-cli/.agent-harness-debugger-${BASHPID:-$$}-${RANDOM}.ts"
[[ ! -e "${temp_ts}" && ! -L "${temp_ts}" ]] || fail "temporary TypeScript probe path already exists"
lefthook_regression_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-lefthook-contract.XXXXXX")"
cleanup() {
  rm -f -- "${temp_ts}"
  rm -rf -- "${lefthook_regression_root}"
}
trap cleanup EXIT HUP INT TERM
printf 'debugger;\n' >"${temp_ts}"
temp_abs="${ROOT}/${temp_ts}"

lefthook_primary="${lefthook_regression_root}/primary"
lefthook_linked="${lefthook_regression_root}/linked"
lefthook_custom_hooks="${lefthook_regression_root}/custom-hooks"
mkdir -p "${lefthook_custom_hooks}"
lefthook_custom_hooks="$(cd "${lefthook_custom_hooks}" && pwd -P)"
mkdir -p "${lefthook_primary}/packages/trellage-cli"
lefthook_primary="$(cd "${lefthook_primary}" && pwd -P)"
git -C "${lefthook_primary}" init -q
git -C "${lefthook_primary}" config user.name "Trellage Contract"
git -C "${lefthook_primary}" config user.email "trellage-contract@example.invalid"
git -C "${lefthook_primary}" config core.hooksPath "${lefthook_custom_hooks}"
touch "${lefthook_primary}/packages/trellage-cli/.keep"
git -C "${lefthook_primary}" add packages/trellage-cli/.keep
git -C "${lefthook_primary}" commit -qm "contract fixture"
git -C "${lefthook_primary}" branch -M main
git -C "${lefthook_primary}" worktree add -q "${lefthook_linked}"
mkdir -p "${lefthook_linked}/packages/trellage-cli"
lefthook_hook="$(git -C "${lefthook_linked}" rev-parse --path-format=absolute --git-path hooks/pre-commit)"
pre_push_hook="$(git -C "${lefthook_linked}" rev-parse --path-format=absolute --git-path hooks/pre-push)"
post_merge_hook="$(git -C "${lefthook_linked}" rev-parse --path-format=absolute --git-path hooks/post-merge)"
post_rewrite_hook="$(git -C "${lefthook_linked}" rev-parse --path-format=absolute --git-path hooks/post-rewrite)"
[[ "${lefthook_hook}" == "${lefthook_custom_hooks}/pre-commit" ]] \
  || fail "Git did not resolve configured hooks path"
(
  cd "${lefthook_linked}/packages/trellage-cli"
  bash "${ROOT}/scripts/install-lefthook-hook.sh"
)

[[ -x "${lefthook_hook}" ]] || fail "installer did not create executable effective pre-commit hook"
[[ -x "${pre_push_hook}" ]] || fail "installer did not create executable pre-push hook"
[[ -x "${post_merge_hook}" ]] || fail "installer did not create executable post-merge hook"
[[ -x "${post_rewrite_hook}" ]] || fail "installer did not create executable post-rewrite hook"
for installed_hook in "${lefthook_hook}" "${pre_push_hook}" "${post_merge_hook}" "${post_rewrite_hook}"; do
  if grep -Fq -- "${lefthook_linked}" "${installed_hook}"; then
    fail "installed Git hook embeds linked-worktree path: ${installed_hook}"
  fi
done

git -C "${lefthook_primary}" worktree remove "${lefthook_linked}"
lefthook_fake_dir="${lefthook_primary}/packages/trellage-cli/node_modules/.bin"
lefthook_args="${lefthook_regression_root}/lefthook-args"
mkdir -p "${lefthook_fake_dir}"
cat >"${lefthook_fake_dir}/lefthook" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"${LEFTHOOK_CONTRACT_ARGS:?}"
EOF
chmod +x "${lefthook_fake_dir}/lefthook"
(
  cd "${lefthook_primary}"
  LEFTHOOK_CONTRACT_ARGS="${lefthook_args}" \
    "${lefthook_hook}" "forwarded" "two words"
)
printf 'run\npre-commit\n--no-auto-install\nforwarded\ntwo words\n' \
  >"${lefthook_regression_root}/expected-args"
cmp -s "${lefthook_regression_root}/expected-args" "${lefthook_args}" \
  || fail "installed pre-commit hook did not forward Lefthook command and arguments"

(
  cd "${lefthook_primary}"
  LEFTHOOK_CONTRACT_ARGS="${lefthook_args}" \
    "${pre_push_hook}" "origin" "git@example.invalid:trellage.git"
)
printf 'run\npre-push\n--no-auto-install\norigin\ngit@example.invalid:trellage.git\n' \
  >"${lefthook_regression_root}/expected-args"
cmp -s "${lefthook_regression_root}/expected-args" "${lefthook_args}" \
  || fail "installed pre-push hook did not forward Lefthook command and arguments"

npm_fake_dir="${lefthook_regression_root}/fake-npm"
npm_args="${lefthook_regression_root}/npm-args"
native_args="${lefthook_regression_root}/native-args"
mkdir -p "${npm_fake_dir}"
cat >"${npm_fake_dir}/npm" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"${NPM_CONTRACT_ARGS:?}"
EOF
chmod +x "${npm_fake_dir}/npm"
mkdir -p "${lefthook_primary}/scripts"
cat >"${lefthook_primary}/scripts/rebuild-profile-images.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"${NATIVE_CONTRACT_ARGS:?}"
EOF
chmod +x "${lefthook_primary}/scripts/rebuild-profile-images.sh"
for rebuild_hook in "${post_merge_hook}" "${post_rewrite_hook}"; do
  (
    cd "${lefthook_primary}"
    PATH="${npm_fake_dir}:${PATH}" \
      NPM_CONTRACT_ARGS="${npm_args}" \
      NATIVE_CONTRACT_ARGS="${native_args}" \
      "${rebuild_hook}"
  )
  printf '%s\n' --prefix "${lefthook_primary}/packages/trellage-cli" run build \
    >"${lefthook_regression_root}/expected-npm-args"
  cmp -s "${lefthook_regression_root}/expected-npm-args" "${npm_args}" \
    || fail "installed rebuild hook did not rebuild the active worktree compiler"
  printf '%s\n' --native-only >"${lefthook_regression_root}/expected-native-args"
  cmp -s "${lefthook_regression_root}/expected-native-args" "${native_args}" \
    || fail "installed rebuild hook did not refresh native launchers"
done

rm -f -- "${lefthook_fake_dir}/lefthook"
set +e
lefthook_missing_output="$(cd "${lefthook_primary}" && "${lefthook_hook}" 2>&1)"
lefthook_missing_status=$?
set -e
((lefthook_missing_status != 0)) || fail "installed pre-commit hook did not fail closed"
if [[ "${lefthook_missing_output}" != *"npm ci"* ]] || \
  [[ "${lefthook_missing_output}" != *"packages/trellage-cli/node_modules/.bin/lefthook"* ]]; then
  fail "installed pre-commit hook missing actionable dependency diagnostic"
fi

assert_edit_blocks() {
  local label="$1"
  local cwd="$2"
  local payload_path="$3"
  local output

  output="$(
    cd "${cwd}"
    jq -nc --arg file_path "${payload_path}" '{tool_input: {file_path: $file_path}}' \
      | "${ROOT}/.agents/hooks/check-edit.sh"
  )"
  if ! jq -e '
    .decision == "block" and
    (.reason | contains("no-debugger"))
  ' <<<"${output}" >/dev/null; then
    probe_failures+=("check-edit did not run Oxlint: ${label}")
  fi
}

assert_edit_blocks "root-relative path" "${ROOT}" "${temp_ts}"
assert_edit_blocks "dot-relative path" "${ROOT}" "./${temp_ts}"
assert_edit_blocks "absolute path" "${ROOT}" "${temp_abs}"
assert_edit_blocks "root-relative path from package directory" "${ROOT}/packages/trellage-cli" "${temp_ts}"
assert_edit_blocks "dot-relative path from package directory" "${ROOT}/packages/trellage-cli" "./${temp_ts}"
assert_edit_blocks "absolute path from package directory" "${ROOT}/packages/trellage-cli" "${temp_abs}"

((${#probe_failures[@]} == 0)) \
  || fail "$(printf '%s; ' "${probe_failures[@]}")"

printf 'agent harness contract: PASS\n'
