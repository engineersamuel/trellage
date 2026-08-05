#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readme="$prototype_dir/README.md"
root_readme="$prototype_dir/../../README.md"
mise_config="$prototype_dir/mise.toml"
smoke_runner="$prototype_dir/tests/smoke.sh"
runtime_startup_contract="$prototype_dir/tests/runtime_startup_contract.sh"
runtime_persistence_contract="$prototype_dir/tests/runtime_persistence_contract.sh"
cleanup_behavior_contract="$prototype_dir/tests/resource_cleanup_behavior_contract.sh"

fail() {
  printf 'trellage README test: FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$readme" ]] || fail 'README.md does not exist'

visible_markdown() {
  awk '
    function without_html_comments(line, start, rest, closing_position, before) {
      while (1) {
        if (inside_comment) {
          closing_position = index(line, "-->")
          if (closing_position == 0) {
            return ""
          }
          line = substr(line, closing_position + 3)
          inside_comment = 0
        }
        start = index(line, "<!--")
        if (start == 0) {
          return line
        }
        before = substr(line, 1, start - 1)
        rest = substr(line, start + 4)
        closing_position = index(rest, "-->")
        if (closing_position == 0) {
          inside_comment = 1
          return before
        }
        line = before substr(rest, closing_position + 3)
      }
    }
    { print without_html_comments($0) }
  ' "$1"
}

has_visible_heading() {
  local source="$1"
  local expected="$2"
  visible_markdown "$source" | awk -v expected="$expected" '
    /^[[:space:]]*(```|~~~)/ {
      in_fence = !in_fence
      next
    }
    !in_fence {
      line = $0
      sub(/[[:space:]]+$/, "", line)
      if (line == expected) {
        found++
      }
    }
    END { exit(found == 1 ? 0 : 1) }
  '
}

require_heading() {
  has_visible_heading "$readme" "$1" \
    || fail "missing unique visible heading: $1"
}

section_contains_text() {
  local source="$1"
  local section="$2"
  local expected="$3"
  visible_markdown "$source" | awk -v section="$section" -v expected="$expected" '
    /^[[:space:]]*(```|~~~)/ {
      in_fence = !in_fence
      next
    }
    !in_fence && /^##[[:space:]]/ {
      heading = $0
      sub(/[[:space:]]+$/, "", heading)
      in_section = (heading == section)
      next
    }
    !in_fence && in_section && index($0, expected) {
      found = 1
    }
    END { exit(found ? 0 : 1) }
  '
}

require_section_text() {
  local section="$1"
  local expected="$2"
  section_contains_text "$readme" "$section" "$expected" \
    || fail "missing text in $section: $expected"
}

has_valid_numbered_section() {
  local source="$1"
  local section="$2"
  visible_markdown "$source" | awk -v section="$section" '
    /^[[:space:]]*(```|~~~)/ {
      in_fence = !in_fence
      next
    }
    !in_fence && /^##[[:space:]]/ {
      heading = $0
      sub(/[[:space:]]+$/, "", heading)
      in_section = (heading == section)
      next
    }
    !in_fence && in_section && /^[0-9]+\.[[:space:]]/ {
      number = $0
      sub(/\..*/, "", number)
      seen[number]++
      total++
    }
    END {
      if (total != 10) {
        exit 1
      }
      for (number = 1; number <= 10; number++) {
        if (seen[number] != 1) {
          exit 1
        }
      }
      exit 0
    }
  '
}

has_exact_bash_command() {
  local source="$1"
  local expected="$2"
  visible_markdown "$source" | awk -v expected="$expected" '
    /^```bash[[:space:]]*$/ {
      in_bash = 1
      next
    }
    /^```[[:space:]]*$/ {
      in_bash = 0
      next
    }
    in_bash {
      line = $0
      sub(/[[:space:]]+$/, "", line)
      sub(/[[:space:]]+#.*/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == expected) {
        found = 1
      }
    }
    END { exit(found ? 0 : 1) }
  '
}

require_command() {
  has_exact_bash_command "$readme" "$1" \
    || fail "missing exact bash command: $1"
}

has_exact_smoke_task() {
  local source="$1"
  awk '
    /^\[tasks\.smoke\]$/ {
      sections++
      in_smoke = 1
      next
    }
    /^\[/ {
      in_smoke = 0
      next
    }
    in_smoke && $0 == "description = \"Build and run the bundled profile smoke verification\"" {
      descriptions++
      next
    }
    in_smoke && $0 == "run = \"./tests/smoke.sh\"" {
      runs++
      next
    }
    in_smoke && /^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*=/ {
      unexpected++
    }
    END { exit(sections == 1 && descriptions == 1 && runs == 1 && unexpected == 0 ? 0 : 1) }
  ' "$source"
}

has_exact_mise_task() {
  local source="$1"
  local task_name="$2"
  local expected_description="$3"
  local expected_run="$4"
  awk -v section="[tasks."$task_name"]" \
    -v expected_description="$expected_description" -v expected_run="$expected_run" '
    $0 == section {
      sections++
      in_task = 1
      next
    }
    /^\[/ {
      in_task = 0
      next
    }
    in_task && $0 == "description = \"" expected_description "\"" {
      descriptions++
      next
    }
    in_task && $0 == "run = \"" expected_run "\"" {
      runs++
      next
    }
    in_task && /^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*=/ {
      unexpected++
    }
    END { exit(sections == 1 && descriptions == 1 && runs == 1 && unexpected == 0 ? 0 : 1) }
  ' "$source"
}

function_has_exact_line() {
  local source="$1"
  local function_name="$2"
  local expected="$3"
  awk -v function_name="$function_name" -v expected="$expected" '
    function trim(line) {
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      return line
    }
    $0 ~ "^" function_name "\\(\\)[[:space:]]*\\{$" {
      in_function = 1
      next
    }
    in_function && /^}$/ {
      in_function = 0
    }
    in_function && trim($0) == expected {
      found++
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$source"
}

file_exact_line_count() {
  local source="$1"
  local expected="$2"
  awk -v expected="$expected" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == expected) {
        found++
      }
    }
    END { print found + 0 }
  ' "$source"
}

function_exact_line_count() {
  local source="$1"
  local function_name="$2"
  local expected="$3"
  awk -v function_name="$function_name" -v expected="$expected" '
    function trim(line) {
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      return line
    }
    $0 ~ "^" function_name "\\(\\)[[:space:]]*\\{$" {
      in_function = 1
      next
    }
    in_function && /^}$/ {
      in_function = 0
    }
    in_function && trim($0) == expected {
      found++
    }
    END { print found + 0 }
  ' "$source"
}

has_smoke_immutable_identity() {
  local source="$1"
  [[ "$(file_exact_line_count "$source" 'container_id=')" -eq 2 ]] \
    && [[ "$(file_exact_line_count "$source" 'local container_id')" -eq 0 ]] \
    && function_has_exact_line "$source" create_smoke_container \
      'created_container="$(docker container create \' \
    && function_has_exact_line "$source" create_smoke_container \
      'container_id="$created_container"' \
    && function_has_exact_line "$source" validate_container_ownership \
      '[[ -n "$container_id" ]] || return 1' \
    && function_has_exact_line "$source" validate_container_ownership \
      '"$container_id" 2>/dev/null)" || return 1' \
    && function_has_exact_line "$source" remove_smoke_container \
      'docker container rm --force "$container_id" >/dev/null || return 1' \
    && function_has_exact_line "$source" remove_smoke_container \
      'container_id=' \
    && function_has_exact_line "$source" cleanup \
      'if [[ -n "$container_id" ]]; then' \
    && [[ "$(function_exact_line_count "$source" cleanup 'container_id=')" -eq 0 ]] \
    && [[ "$(file_exact_line_count "$source" 'docker container rm --force "$container_name" >/dev/null')" -eq 0 ]]
}

has_persistence_immutable_identity() {
  local source="$1"
  [[ "$(file_exact_line_count "$source" 'container_id=')" -eq 2 ]] \
    && function_has_exact_line "$source" run_persistence_container \
      'created_container="$(docker container create \' \
    && function_has_exact_line "$source" run_persistence_container \
      'container_id="$created_container"' \
    && function_has_exact_line "$source" validate_container_ownership \
      '[[ -n "$container_id" ]] || return 1' \
    && function_has_exact_line "$source" validate_container_ownership \
      '"$container_id" 2>/dev/null)" || return 1' \
    && function_has_exact_line "$source" remove_owned_container \
      'docker container rm --force "$container_id" >/dev/null || return 1' \
    && function_has_exact_line "$source" remove_owned_container \
      'container_id=' \
    && function_has_exact_line "$source" cleanup \
      'if [[ -n "$container_id" ]]; then' \
    && [[ "$(function_exact_line_count "$source" cleanup 'container_id=')" -eq 0 ]] \
    && [[ "$(file_exact_line_count "$source" 'inspected_id="$(docker container inspect --format '\''{{ .Id }}'\'' \')" -eq 0 ]]
}

has_ordered_smoke_stages() {
  local source="$1"
  awk '
    BEGIN {
      expected[1] = "check_shell_syntax"
      expected[2] = "run_static_contracts"
      expected[3] = "build_image"
      expected[4] = "run_live_contracts"
      expected[5] = "run_session_contracts"
      expected[6] = "run_live_container_probe"
      expected[7] = "run_installer_probe"
    }
    function trim(line) {
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      return line
    }
    /^main\(\)[[:space:]]*\{$/ {
      main_functions++
      in_main = 1
      next
    }
    in_main && /^}$/ {
      in_main = 0
      next
    }
    in_main {
      line = trim($0)
      for (position = 1; position <= 7; position++) {
        if (line == expected[position]) {
          seen++
          if (seen != position) {
            bad_order = 1
          }
          calls[line]++
        }
      }
    }
    END {
      if (main_functions != 1 || seen != 7 || bad_order) {
        exit 1
      }
      for (position = 1; position <= 7; position++) {
        if (calls[expected[position]] != 1) {
          exit 1
        }
      }
      exit 0
    }
  ' "$source"
}

has_exact_static_contract_inventory() {
  local source="$1"
  awk '
    BEGIN {
      expected["copilot_transcript_contract.sh"] = 1
      expected["host_command_contract.sh"] = 1
      expected["image_contract.sh"] = 1
      expected["installer_contract.sh"] = 1
      expected["readme_contract.sh"] = 1
      expected["resource_cleanup_behavior_contract.sh"] = 1
    }
    function trim(line) {
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      return line
    }
    /^run_static_contracts\(\)[[:space:]]*\{$/ {
      functions++
      in_function = 1
      next
    }
    in_function && /^}$/ {
      in_function = 0
      next
    }
    in_function {
      line = trim($0)
      if (line ~ /^[A-Za-z0-9_]+_contract\.sh$/) {
        actual[line]++
      }
    }
    END {
      if (functions != 1) {
        exit 1
      }
      for (name in expected) {
        if (actual[name] != 1) {
          exit 1
        }
      }
      for (name in actual) {
        if (!expected[name]) {
          exit 1
        }
      }
      exit 0
    }
  ' "$source"
}

require_smoke_contract() {
  [[ -f "$mise_config" ]] || fail 'mise.toml does not exist'
  has_exact_smoke_task "$mise_config" \
    || fail 'missing exact tasks.smoke definition'
  [[ -f "$smoke_runner" ]] || fail 'tests/smoke.sh does not exist'
  [[ -x "$smoke_runner" ]] || fail 'tests/smoke.sh is not executable'
  [[ "$(sed -n '2,5p' "$smoke_runner")" == $'if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then\n  return 0\nfi\nset -euo pipefail' ]] \
    || fail 'smoke runner must return when sourced before enabling strict Bash mode'
  has_ordered_smoke_stages "$smoke_runner" \
    || fail 'smoke runner stages are missing, duplicated, or out of order'
  has_exact_static_contract_inventory "$smoke_runner" \
    || fail 'smoke runner static contract inventory is incomplete'

  for assertion in \
    '[[ "$container_name" == trellage-codex-smoke-* ]] || return 1' \
    '[[ "$volume_name" == trellage-codex-smoke-* ]] || return 1' \
    '[[ "$(basename "$smoke_root")" == trellage-codex-smoke-* ]] || return 1' \
    'if ! remove_smoke_container; then' \
    'if ! remove_smoke_volume; then'; do
    function_has_exact_line "$smoke_runner" cleanup "$assertion" \
      || fail "smoke cleanup lacks exact owned-resource boundary: $assertion"
  done

  for assertion in \
    'validate_container_ownership || return 1' \
    'docker container rm --force "$container_id" >/dev/null || return 1'; do
    function_has_exact_line "$smoke_runner" remove_smoke_container "$assertion" \
      || fail "smoke container removal lacks explicit safeguard: $assertion"
  done
  for assertion in \
    'validate_volume_ownership || return 1' \
    'docker volume rm "$volume_name" >/dev/null || return 1'; do
    function_has_exact_line "$smoke_runner" remove_smoke_volume "$assertion" \
      || fail "smoke volume removal lacks explicit safeguard: $assertion"
  done

  function_has_exact_line "$smoke_runner" build_image \
    'IMAGE_REF="$image_ref" ./build-image.sh' \
    || fail 'smoke runner does not invoke a fresh locked build'
  function_has_exact_line "$smoke_runner" check_shell_syntax \
    'bash -n "$source"' \
    || fail 'smoke runner does not execute shell syntax checks'
  function_has_exact_line "$smoke_runner" run_static_contracts \
    '"$tests_dir/$contract"' \
    || fail 'smoke runner does not execute each listed static contract'
  function_has_exact_line "$smoke_runner" run_live_contracts \
    'IMAGE_REF="$image_ref" "$tests_dir/image_contract.sh"' \
    || fail 'smoke runner does not invoke the live image contract'
  function_has_exact_line "$smoke_runner" run_live_contracts \
    'IMAGE_REF="$image_ref" "$tests_dir/runtime_startup_contract.sh"' \
    || fail 'smoke runner does not invoke the live runtime contract'
  function_has_exact_line "$smoke_runner" run_session_contracts \
    '"$tests_dir/runtime_session_contract.sh"' \
    || fail 'smoke runner does not invoke the native session contract'
  function_has_exact_line "$smoke_runner" run_session_contracts \
    'IMAGE_REF="$image_ref" "$tests_dir/runtime_persistence_contract.sh"' \
    || fail 'smoke runner does not invoke the persistence contract'
  for probe in \
    probe_bind_and_state \
    probe_runtime_inventory \
    probe_proxy \
    probe_recovery_fish; do
    function_has_exact_line "$smoke_runner" run_live_container_probe "$probe" \
      || fail "smoke runner does not invoke live probe: $probe"
  done

  function_has_exact_line "$smoke_runner" initialize_smoke \
    'git init --quiet "$smoke_root"' \
    || fail 'smoke bind directory is not initialized as a Git working tree'
  function_has_exact_line "$smoke_runner" initialize_smoke \
    'git_root="$(git -C "$smoke_root" rev-parse --show-toplevel)"' \
    || fail 'smoke Git root is not resolved through Git'
  function_has_exact_line "$smoke_runner" initialize_smoke \
    '[[ "$git_root" == "$smoke_root" ]] || fail "smoke Git root does not match its bind directory: $git_root"' \
    || fail 'smoke Git root is not verified against the canonical bind directory'
  has_smoke_immutable_identity "$smoke_runner" \
    || fail 'smoke runner does not preserve immutable container identity'
}

require_live_resource_contracts() {
  [[ -f "$runtime_startup_contract" ]] \
    || fail 'runtime_startup_contract.sh does not exist'
  [[ -f "$runtime_persistence_contract" ]] \
    || fail 'runtime_persistence_contract.sh does not exist'
  [[ -x "$runtime_startup_contract" ]] \
    || fail 'runtime_startup_contract.sh is not executable'
  [[ -x "$runtime_persistence_contract" ]] \
    || fail 'runtime_persistence_contract.sh is not executable'
  [[ -x "$cleanup_behavior_contract" ]] \
    || fail 'resource_cleanup_behavior_contract.sh is not executable'

  function_has_exact_line "$runtime_startup_contract" cleanup \
    '[[ "$volume_name" == trellage-codex-runtime-test-* ]] || return 1' \
    || fail 'runtime startup cleanup lacks its exact volume prefix boundary'
  for assertion in \
    'validate_container_ownership || return 1' \
    'docker container rm --force "$container_id" >/dev/null || return 1'; do
    function_has_exact_line "$runtime_startup_contract" remove_runtime_container "$assertion" \
      || fail "runtime startup container removal lacks explicit safeguard: $assertion"
  done
  for assertion in \
    'validate_volume_ownership || return 1' \
    'docker volume rm "$volume_name" >/dev/null || return 1'; do
    function_has_exact_line "$runtime_startup_contract" remove_runtime_volume "$assertion" \
      || fail "runtime startup volume removal lacks explicit safeguard: $assertion"
  done
  function_has_exact_line "$runtime_startup_contract" create_runtime_volume \
    '--label "$prototype_label=trellage-codex" \' \
    || fail 'runtime startup volume lacks the exact prototype label'
  function_has_exact_line "$runtime_startup_contract" create_runtime_volume \
    '--label "$worktree_label=$test_root" \' \
    || fail 'runtime startup volume lacks exact test ownership'
  [[ "$(file_exact_line_count "$runtime_startup_contract" \
    '--mount "type=volume,src=$volume_name,dst=/home/agent" \')" -eq 1 ]] \
    || fail 'runtime startup does not use exactly one named state-volume mount'
  if grep -Fq -- '--mount type=volume,dst=/home/agent' "$runtime_startup_contract"; then
    fail 'runtime startup still creates an anonymous volume'
  fi

  function_has_exact_line "$runtime_persistence_contract" cleanup \
    '[[ "$container_name" == trellage-codex-persistence-test-* ]] || return 1' \
    || fail 'persistence cleanup lacks its exact container prefix boundary'
  function_has_exact_line "$runtime_persistence_contract" cleanup \
    '[[ "$volume_name" == trellage-codex-persistence-test-* ]] || return 1' \
    || fail 'persistence cleanup lacks its exact volume prefix boundary'
  for assertion in \
    'validate_container_ownership || return 1' \
    'docker container rm --force "$container_id" >/dev/null || return 1'; do
    function_has_exact_line "$runtime_persistence_contract" remove_owned_container "$assertion" \
      || fail "persistence container removal lacks explicit safeguard: $assertion"
  done
  for assertion in \
    'validate_volume_ownership || return 1' \
    'docker volume rm "$volume_name" >/dev/null || return 1'; do
    function_has_exact_line "$runtime_persistence_contract" remove_owned_volume "$assertion" \
      || fail "persistence volume removal lacks explicit safeguard: $assertion"
  done
  function_has_exact_line "$runtime_persistence_contract" run_persistence_container \
    '--label "$prototype_label=trellage-codex" \' \
    || fail 'persistence containers lack the exact prototype label'
  function_has_exact_line "$runtime_persistence_contract" run_persistence_container \
    '--label "$worktree_label=$test_root" \' \
    || fail 'persistence containers lack exact test ownership'
  has_persistence_immutable_identity "$runtime_persistence_contract" \
    || fail 'persistence contract does not preserve immutable container identity'

  for source in "$smoke_runner" "$runtime_startup_contract" "$runtime_persistence_contract"; do
    if grep -Fq 'if docker container inspect "$container_id"' "$source"; then
      fail "container removal treats inspect failure as proof of absence: $(basename "$source")"
    fi
  done
}

has_valid_verdict() {
  local source="$1"
  local raw_token_count
  raw_token_count="$(awk '
    {
      line = $0
      while ((position = index(line, "NATIVE_HERDR_DETECTION_")) != 0) {
        count++
        line = substr(line, position + length("NATIVE_HERDR_DETECTION_"))
      }
    }
    END { print count + 0 }
  ' "$source")"
  [[ "$raw_token_count" -eq 1 ]] || return 1

  visible_markdown "$source" | awk '
    /^[[:space:]]*(```|~~~)/ {
      in_fence = !in_fence
      next
    }
    !in_fence && /^##[[:space:]]/ {
      heading = $0
      sub(/[[:space:]]+$/, "", heading)
      in_verdict = (heading == "## Verdict")
      next
    }
    !in_fence && index($0, "NATIVE_HERDR_DETECTION_") {
      visible_tokens++
      if (in_verdict && $0 ~ /^NATIVE_HERDR_DETECTION_(WORKS|PARTIAL|FAILS)$/) {
        approved_tokens++
      }
      if (in_verdict && $0 == "NATIVE_HERDR_DETECTION_WORKS") {
        observed_tokens++
      }
    }
    END {
      exit(visible_tokens == 1 && approved_tokens == 1 && observed_tokens == 1 ? 0 : 1)
    }
  '
}

require_smoke_contract
require_live_resource_contracts

[[ "$(sed -n '1p' "$readme")" == '# Trellage' ]] \
  || fail 'prototype README title is not Trellage'

has_exact_mise_task "$mise_config" install-trellage \
  'Install the user-local Trellage command' './install-trellage.sh install' \
  || fail 'missing exact tasks.install-trellage definition'
has_exact_mise_task "$mise_config" uninstall-trellage-dry-run \
  'Preview removal of the user-local Trellage command' './install-trellage.sh uninstall --dry-run' \
  || fail 'missing exact tasks.uninstall-trellage-dry-run definition'
has_exact_mise_task "$mise_config" uninstall-trellage \
  'Remove the user-local Trellage command installed by this prototype' './install-trellage.sh uninstall' \
  || fail 'missing exact tasks.uninstall-trellage definition'

for heading in \
  '## Prototype Question and Scope' \
  '## Prerequisites and Setup' \
  '## Profiles and Locks' \
  '## Build' \
  '## Deterministic Smoke Verification' \
  '## Install' \
  '## Doctor' \
  '## Automatic Environment Loading' \
  '## Use' \
  '## Copilot with HVE Core' \
  '## Pi with Oh My Pi' \
  '## Ten-step Herdr Human Test' \
  '## Cleanup' \
  '## Safety Boundary' \
  '## Observations' \
  '## Verdict' \
  '## Smallest Next Experiment'; do
  require_heading "$heading"
done

for qualification in \
  'automatically runs new, prompt, and resume launches through its bundled Varlock version' \
  'do not prefix the command with `varlock`' \
  '`~/.config/trellage`' \
  '`PLAYWRIGHT_MCP_EXTENSION_TOKEN`' \
  '`strict_permissions = true`' \
  '`TRELLAGE_CONFIG`' \
  '`TRELLAGE_ENVIRONMENT=off`' \
  'Do not use `varlock(prompt)` in unattended launches'; do
  require_section_text '## Automatic Environment Loading' "$qualification"
done

for command in \
  'mise trust' \
  './trellage validate ../../profiles/codex-superpowers/profile.toml' \
  './trellage lock ../../profiles/codex-superpowers/profile.toml' \
  './trellage lock --update ../../profiles/codex-superpowers/profile.toml' \
  './trellage build --locked ../../profiles/codex-superpowers/profile.toml' \
  'mise run smoke' \
  './install-trellage.sh install' \
  './install-trellage.sh uninstall --dry-run' \
  './install-trellage.sh uninstall' \
  'mise run install-trellage' \
  'mise run uninstall-trellage-dry-run' \
  'mise run uninstall-trellage' \
  'trellage doctor' \
  'trellage' \
  'trellage "<prompt>"' \
  'trellage resume' \
  'trellage resume SESSION_ID' \
  'trellage shell' \
  'trellage stop' \
  'trellage destroy' \
  'trellage upgrade all' \
  'trellage validate /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage build --locked /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage --profile /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage resume --profile /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage doctor --profile /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage destroy --profile /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage upgrade /absolute/path/to/profiles/copilot-hve/profile.toml' \
  'trellage validate /absolute/path/to/profiles/pi-oh-my-pi/profile.toml' \
  'trellage build --locked /absolute/path/to/profiles/pi-oh-my-pi/profile.toml' \
  'trellage --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml' \
  'trellage --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml -p "review this repository"' \
  'trellage resume --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml' \
  'trellage doctor --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml' \
  'trellage destroy --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml'; do
  require_command "$command"
done

for qualification in \
  'Multiple Codex sessions can run concurrently for the same worktree' \
  '`trellage resume` selects the newest recorded native session' \
  'session ID to select an exact conversation' \
  'prints a copyable exact resume command' \
  '`trellage stop` stops the shared container and terminates every active session for that profile and worktree'; do
  require_section_text '## Use' "$qualification"
done

for qualification in \
  'Bare `trellage` remains the Codex profile' \
  'HVE installs natively as `hve-core@hve-core`' \
  '`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`, then device login' \
  'Host authentication is ephemeral' \
  'Device login persists in the profile state volume' \
  '`destroy` deletes that sensitive local state only after confirmation' \
  'HVE Core and HVE Core All are different products' \
  'Upgrades never happen automatically'; do
  require_section_text '## Copilot with HVE Core' "$qualification"
done

for qualification in \
  'standalone `omp` executable from' \
  'OMP is not GitHub Copilot CLI' \
  '`github-copilot` provider' \
  '`gpt-5.6-terra`' \
  'Prompt mode translates to OMP `--print`' \
  'resume uses OMP `--continue`' \
  '`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`' \
  'forwarded only as `COPILOT_GITHUB_TOKEN`' \
  '`/home/agent/.omp/agent`' \
  'No host' \
  'Docker `bridge`' \
  'GitHub-provided SHA-256 digest'; do
  require_section_text '## Pi with Oh My Pi' "$qualification"
done

for qualification in \
  'requires Bash, Docker, Git, `gh`, jq, and mise' \
  'existing `copilot-proxy-rs_default` network and reachable proxy service' \
  'performs a fresh locked image build' \
  'usually takes 5-10 minutes' \
  'creates uniquely named `trellage-codex-smoke-*`, `trellage-codex-runtime-test-*`, and `trellage-codex-persistence-test-*` temporary resources' \
  'tracks immutable container IDs and successful volume creation' \
  'revalidates ownership labels before removing only tracked resources' \
  'removes its temporary containers, volumes, bind directories, and installer directory' \
  'retains the built image, proxy, network, Herdr, repository worktrees, and unrelated resources'; do
  require_section_text '## Deterministic Smoke Verification' "$qualification"
done

for qualification in \
  'Every profile image includes `gh`' \
  'writable Git common directory' \
  'GH_CONFIG_DIR' \
  'GIT_CONFIG_GLOBAL' \
  '`GH_TOKEN` is never passed to the agent process' \
  'temporary configuration disappears when the container stops'; do
  require_section_text '## GitHub CLI Delivery' "$qualification"
done

for qualification in \
  'HERDR_AGENT=codex is host-only wrapper metadata' \
  'The hint is not passed into the container' \
  'Herdr is not installed or mounted in the container' \
  'No bridge, socket, or plugin was added' \
  'The only host-backed mounts are' \
  'private `/tmp` tmpfs'; do
  require_section_text '## Safety Boundary' "$qualification"
done

for qualification in \
  'destroy removes only the named container and state volume after confirmation' \
  'type `destroy <container> <state-volume>` to confirm' \
  'Stop preserves container and conversation state' \
  'retains the image, network, proxy, Herdr, and unrelated resources'; do
  require_section_text '## Cleanup' "$qualification"
done

for qualification in \
  'TERM=xterm-256color' \
  'COLORTERM=truecolor' \
  'Codex YOLO/dangerous bypass was active' \
  'idle -> working -> done -> release' \
  'Native resume continued the same conversation' \
  'recovery Fish opened but printed `/tmp/fish`' \
  'error: Runtime path not available. Try deleting the directory /tmp/fish.'; do
  require_section_text '## Observations' "$qualification"
done

for qualification in \
  'correct only the recovery-shell Fish runtime-path warning' \
  'repeat the recovery shell check' \
  'Do not generalize Prototype A into a registry or framework yet'; do
  require_section_text '## Smallest Next Experiment' "$qualification"
done

for qualification in \
  'Install and compile the profile compiler once' \
  'npm run build'; do
  require_section_text '## Prerequisites and Setup' "$qualification"
done

require_section_text '## Build' 'trellage-profile-codex-superpowers-linux-arm64:locked'
require_section_text '## Install' '`~/.local/bin/trellage`'
require_section_text '## Install' '`TRELLAGE_INSTALL_DIR`'

has_valid_numbered_section "$readme" '## Ten-step Herdr Human Test' \
  || fail 'human-test section must contain exactly steps 1 through 10'

has_valid_verdict "$readme" \
  || fail 'README must contain only one standalone approved verdict: NATIVE_HERDR_DETECTION_WORKS'

mutation_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-readme-test.XXXXXX")"
trap 'rm -rf -- "$mutation_root"' EXIT
mutated_readme="$mutation_root/missing-bare-trellage.md"
awk '
  /^trellage[[:space:]]+# new interactive Codex conversation$/ {
    print "trellage doctor             # bare command removed"
    next
  }
  { print }
' "$readme" >"$mutated_readme"
has_exact_bash_command "$mutated_readme" 'trellage doctor' \
  || fail 'bare-command mutation did not retain the longer Trellage command'
if has_exact_bash_command "$mutated_readme" 'trellage'; then
  fail 'exact command matcher accepted README without a bare Trellage command'
fi

mutated_readme="$mutation_root/extended-verdict.md"
awk '
  /^NATIVE_HERDR_DETECTION_WORKS$/ {
    print "NATIVE_HERDR_DETECTION_WORKS_EXTRA"
    next
  }
  { print }
' "$readme" >"$mutated_readme"
if has_valid_verdict "$mutated_readme"; then
  fail 'standalone verdict matcher accepted an extended verdict token'
fi

mutated_readme="$mutation_root/commented-safety-claim.md"
awk '
  /Herdr is not installed or mounted in the container/ {
    print "<!-- " $0 " -->"
    next
  }
  { print }
' "$readme" >"$mutated_readme"
if section_contains_text "$mutated_readme" '## Safety Boundary' \
  'Herdr is not installed or mounted in the container'; then
  fail 'section matcher accepted a safety claim hidden in an HTML comment'
fi

mutated_readme="$mutation_root/moved-human-step.md"
awk '
  /^10\. Record the Herdr verdict/ {
    moved = $0
    next
  }
  { print }
  END { print ""; print moved }
' "$readme" >"$mutated_readme"
if has_valid_numbered_section "$mutated_readme" '## Ten-step Herdr Human Test'; then
  fail 'section matcher accepted a human-test step outside its section'
fi

mutated_readme="$mutation_root/commented-verdict.md"
awk '
  /^NATIVE_HERDR_DETECTION_WORKS$/ {
    print "<!--"
    print $0
    print "-->"
    next
  }
  { print }
' "$readme" >"$mutated_readme"
if has_valid_verdict "$mutated_readme"; then
  fail 'verdict matcher accepted a token hidden in a multiline HTML comment'
fi

mutated_readme="$mutation_root/moved-verdict.md"
awk '
  /^NATIVE_HERDR_DETECTION_WORKS$/ {
    moved = $0
    next
  }
  { print }
  END { print ""; print moved }
' "$readme" >"$mutated_readme"
if has_valid_verdict "$mutated_readme"; then
  fail 'verdict matcher accepted a token outside the Verdict section'
fi

mutated_smoke="$mutation_root/reordered-smoke.sh"
awk '
  /^  build_image$/ { print "  run_live_contracts"; next }
  /^  run_live_contracts$/ { print "  build_image"; next }
  { print }
' "$smoke_runner" >"$mutated_smoke"
if has_ordered_smoke_stages "$mutated_smoke"; then
  fail 'smoke stage matcher accepted a reordered live build sequence'
fi

mutated_smoke="$mutation_root/missing-static-contract.sh"
awk '
  /^    image_contract\.sh$/ { next }
  { print }
' "$smoke_runner" >"$mutated_smoke"
if has_exact_static_contract_inventory "$mutated_smoke"; then
  fail 'smoke inventory matcher accepted a missing static contract'
fi

mutated_smoke="$mutation_root/missing-git-init.sh"
awk '
  /^  git init --quiet "\$smoke_root"$/ { next }
  { print }
' "$smoke_runner" >"$mutated_smoke"
if function_has_exact_line "$mutated_smoke" initialize_smoke \
  'git init --quiet "$smoke_root"'; then
  fail 'smoke Git matcher accepted a missing Git initialization'
fi

mutated_smoke="$mutation_root/local-container-id.sh"
awk '
  /^container_id=$/ { next }
  /^create_smoke_container\(\) \{$/ { print; print "  local container_id"; next }
  { print }
' "$smoke_runner" >"$mutated_smoke"
if has_smoke_immutable_identity "$mutated_smoke"; then
  fail 'smoke identity matcher accepted a function-local container ID'
fi

mutated_persistence="$mutation_root/reresolved-container-id.sh"
awk '
  /^  trap - EXIT$/ { print; print "  container_id="; next }
  { print }
' "$runtime_persistence_contract" >"$mutated_persistence"
if has_persistence_immutable_identity "$mutated_persistence"; then
  fail 'persistence identity matcher accepted cleanup that clears and rediscovers an ID'
fi

[[ -f "$root_readme" ]] || fail 'root README.md does not exist'
[[ "$(sed -n '1p' "$root_readme")" == '# Trellage' ]] \
  || fail 'root README title is not exactly Trellage'
root_quick_start_line="$(grep -n '^## Trellage Quick Start$' "$root_readme" | cut -d: -f1)"
root_harness_line="$(grep -n '^## Generic Evaluation Harness$' "$root_readme" | cut -d: -f1)"
[[ -n "$root_quick_start_line" && -n "$root_harness_line" \
  && "$root_quick_start_line" -lt "$root_harness_line" ]] \
  || fail 'root README does not put Trellage quick start before the generic harness'
for command in \
  'trellage validate /absolute/path/to/profile.toml' \
  'trellage build --locked /absolute/path/to/profile.toml' \
  'trellage --profile /absolute/path/to/profile.toml' \
  'trellage resume --profile /absolute/path/to/profile.toml SESSION_ID' \
  'trellage resume --profile /absolute/path/to/profile.toml' \
  'trellage doctor --profile /absolute/path/to/profile.toml' \
  'trellage destroy --profile /absolute/path/to/profile.toml' \
  'trellage upgrade /absolute/path/to/profile.toml' \
  './scripts/harness validate harnesses/todo-side-by-side/harness.json' \
  './scripts/harness build    harnesses/todo-side-by-side/harness.json'; do
  has_exact_bash_command "$root_readme" "$command" \
    || fail "root README is missing exact bash command: $command"
done

printf 'trellage README test: PASS\n'
