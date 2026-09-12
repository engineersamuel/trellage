#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/trellage-source-startup.XXXXXX")"
fixture_root="$(cd -P -- "$fixture_root" && pwd -P)"
bun_executable="$(command -v bun)"
fixture_bin="$fixture_root/bin"
installed_root="$fixture_root/lib/trellage source"

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fail() {
  printf 'source startup contract: FAIL: %s\n' "$1" >&2
  exit 1
}

hook_fixture="$fixture_root/hook"
mkdir -p "$hook_fixture/bin" "$hook_fixture/caller"
git init --quiet "$hook_fixture/caller"
cp "$hook_fixture/caller/.git/config" "$hook_fixture/config-before"
cat >"$hook_fixture/bin/git" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == diff ]]; then exit 1; fi
exec "$HOOK_REAL_GIT" "$@"
SH
cat >"$hook_fixture/bin/bun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ -z "${GIT_DIR+x}${GIT_WORK_TREE+x}${GIT_COMMON_DIR+x}${GIT_INDEX_FILE+x}${GIT_PREFIX+x}" ]] || {
  printf 'Git hook repository variables leaked into source tests\n' >&2
  exit 1
}
printf '%s\n' "$*" >>"$HOOK_CALLS"
if [[ "$*" == 'run test' ]]; then git init --quiet --bare "$HOOK_NESTED"; fi
SH
chmod 0755 "$hook_fixture/bin/git" "$hook_fixture/bin/bun"
hook_command="$(awk '
  /name: source workspace checks/ { found = 1; next }
  found && /^[[:space:]]+run:/ {
    sub(/^[[:space:]]+run: /, ""); print; exit
  }
' "$repo_root/lefthook.yml")"
[[ -n "$hook_command" ]] || fail 'missing source workspace pre-push command'
HOOK_REAL_GIT="$(command -v git)" HOOK_CALLS="$hook_fixture/calls" \
  HOOK_NESTED="$hook_fixture/nested" PATH="$hook_fixture/bin:$PATH" \
  GIT_DIR="$hook_fixture/caller/.git" GIT_WORK_TREE="$hook_fixture/caller" \
  GIT_COMMON_DIR="$hook_fixture/caller/.git" GIT_INDEX_FILE="$hook_fixture/index" \
  GIT_PREFIX=fixture/ bash -c "$hook_command" \
  || fail 'source workspace hook did not isolate nested Git fixtures'
[[ "$(<"$hook_fixture/calls")" == $'run check\nrun test' ]] \
  || fail 'source workspace hook did not run both checks'
cmp -s "$hook_fixture/config-before" "$hook_fixture/caller/.git/config" \
  || fail 'source workspace hook changed its caller repository'
[[ -f "$hook_fixture/nested/HEAD" ]] || fail 'nested Git fixture was not initialized'
printf 'source startup contract: PASS: pre-push isolates nested Git fixtures\n'

mkdir -p "$hook_fixture/packages/trellage-cli" "$hook_fixture/git-bin" "$hook_fixture/home"
cp "$hook_fixture/bin/git" "$hook_fixture/git-bin/git"
cat >"$hook_fixture/packages/trellage-cli/package.json" <<'JSON'
{"scripts":{"lint":"echo lint >> \"$HOOK_SCRIPT_CALLS\"","format:check":"echo format >> \"$HOOK_SCRIPT_CALLS\"","check":"echo check >> \"$HOOK_SCRIPT_CALLS\""}}
JSON
: >"$hook_fixture/script-calls"
while IFS= read -r package_hook; do
  (
    cd "$hook_fixture"
    HOME="$hook_fixture/home" PATH="$hook_fixture/git-bin:$(dirname "$bun_executable"):$PATH" \
      HOOK_REAL_GIT="$(command -v git)" HOOK_SCRIPT_CALLS="$hook_fixture/script-calls" \
      bash -c "$package_hook"
  ) >"$hook_fixture/package-hook.out" 2>&1 || fail 'compiler package hook failed'
done < <(awk '
  /^[[:space:]]+run:.*packages\/trellage-cli/ {
    sub(/^[[:space:]]+run: /, ""); print
  }
' "$repo_root/lefthook.yml")
[[ "$(<"$hook_fixture/script-calls")" == $'lint\nformat\ncheck\ncheck' ]] \
  || fail 'compiler package hooks did not execute all four Bun scripts'
printf 'source startup contract: PASS: compiler hooks execute their Bun scripts\n'

(
  cd "$repo_root"
  "$bun_executable" --no-install --no-env-file \
    "--config=$repo_root/packages/trellage-runtime/bunfig.toml" \
    --input-type=module - "$repo_root" "$fixture_root" <<'JS'
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { copySources } from "@trellage/runtime/workspace"

assert.equal(process.versions.bun, "1.3.3")
const [repository, fixture] = process.argv.slice(2)
const installed = path.join(fixture, "lib", "trellage source")
mkdirSync(installed, { recursive: true, mode: 0o700 })
copySources(repository, installed)

for (const location of ["cwd", "cwd-with-home", "cwd-with-xdg"]) {
  const directory = path.join(fixture, location)
  const caller = path.join(directory, "caller directory")
  const home = path.join(directory, "home")
  mkdirSync(caller, { recursive: true, mode: 0o700 })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const preload = path.join(directory, "caller-preload.ts")
  writeFileSync(preload, `
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
assert.equal(process.versions.bun, "1.3.3")
const log = process.env.TRELLAGE_TEST_PRELOAD_LOG
if (log === undefined) throw new Error("Missing preload fixture log")
appendFileSync(log, process.versions.bun + "\\n")
throw new Error("TRELLAGE_CALLER_BUNFIG_PRELOAD")
`, { mode: 0o600 })
  const config = `preload = [${JSON.stringify(preload)}]\n`
  writeFileSync(path.join(caller, "bunfig.toml"), config, { mode: 0o600 })
  if (location !== "cwd") {
    const directory = location === "cwd-with-home" ? home : path.join(home, ".config")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(directory, ".bunfig.toml"), config, { mode: 0o600 })
  }
}
JS
)

mkdir -p -- "$fixture_bin"
ln -s "$bun_executable" "$fixture_bin/bun"
for command_name in trellage trx; do
  ln -s "../lib/trellage source/bin/$command_name" "$fixture_bin/$command_name"
done
for command_name in node npm npx pnpm yarn docker gh curl; do
  cat >"$fixture_bin/$command_name" <<'SH'
#!/bin/sh
printf '%s\n' "$0" >>"$TRELLAGE_TEST_FORBIDDEN_LOG"
printf 'source startup contract: forbidden tool: %s\n' "$0" >&2
exit 97
SH
  chmod 0755 "$fixture_bin/$command_name"
done

run_in_caller() {
  local -a environment=(
    "HOME=$home"
    "PATH=$fixture_bin:/usr/bin:/bin"
    "XDG_CACHE_HOME=$home/.cache"
    "XDG_STATE_HOME=$home/.local/state"
    "XDG_DATA_HOME=$home/.local/share"
    "TRELLAGE_TEST_PRELOAD_LOG=$preload_log"
    "TRELLAGE_TEST_FORBIDDEN_LOG=$forbidden_log"
  )
  if [[ "$location" == cwd-with-xdg ]]; then
    environment+=("XDG_CONFIG_HOME=$home/.config")
  fi
  (
    cd "$caller"
    env -i "${environment[@]}" "$@" </dev/null
  )
}

assert_unpolluted() {
  [[ ! -e "$preload_log" ]] || fail "$1 loaded the caller $location preload"
  [[ ! -e "$forbidden_log" ]] || fail "$1 invoked Node or an external tool"
}

assert_help() {
  local label="$1" command_name="$2" executable="$3"
  local output="$case_root/$label.out" errors="$case_root/$label.err"
  if ! run_in_caller "$executable" --help >"$output" 2>"$errors"; then
    cat "$output" "$errors" >&2
    fail "$label did not reach help with a polluted $location"
  fi
  assert_unpolluted "$label"
  [[ ! -s "$errors" ]] || {
    cat "$errors" >&2
    fail "$label wrote unexpected startup diagnostics"
  }
  case "$command_name" in
    trellage)
      grep -Fqx 'Usage: trellage [--profile PROFILE] [AGENT ARGS...]' "$output" \
        || fail "$label did not print the public Trellage help"
      ;;
    trx)
      grep -Fqx '  trx --profile agency [COPILOT_ARGS...]' "$output" \
        || fail "$label did not print the public trx help"
      ;;
    *) fail "unknown help command: $command_name" ;;
  esac
  printf 'source startup contract: PASS: %s ignores %s preload\n' "$label" "$location"
}

assert_installer_refusal() {
  local label="$1" installer="$2"
  local destination="$case_root/$label occupied stage"
  local output="$case_root/$label.out" errors="$case_root/$label.err"
  mkdir -- "$destination"
  printf '%s\n' 'user-owned fixture' >"$destination/keep"
  if run_in_caller "$installer" --stage "$destination" >"$output" 2>"$errors"; then
    fail "$label accepted an occupied stage destination"
  fi
  assert_unpolluted "$label"
  grep -Fq 'trellage source runtime: EEXIST' "$errors" || {
    cat "$errors" >&2
    fail "$label did not reach the occupied-destination refusal"
  }
  [[ "$(<"$destination/keep")" == 'user-owned fixture' ]] \
    || fail "$label changed the occupied destination"
  [[ "$(find "$destination" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" == 1 ]] \
    || fail "$label added entries to the occupied destination"
  [[ ! -e "$destination/node_modules" ]] || fail "$label installed dependencies"
  printf 'source startup contract: PASS: %s refuses occupied stage despite %s preload\n' "$label" "$location"
}

for location in cwd cwd-with-home cwd-with-xdg; do
  case_root="$fixture_root/$location"
  caller="$case_root/caller directory"
  home="$case_root/home"
  preload_log="$case_root/preload.log"
  forbidden_log="$case_root/forbidden.log"

  if run_in_caller "$bun_executable" --no-install --no-env-file \
    "$repo_root/bin/trellage.ts" --help >"$case_root/control.out" 2>"$case_root/control.err"; then
    fail "unprotected Bun ignored the $location preload control"
  fi
  grep -Fq 'TRELLAGE_CALLER_BUNFIG_PRELOAD' "$case_root/control.err" \
    || fail "the $location control did not execute the throwing preload"
  [[ "$(<"$preload_log")" == 1.3.3 ]] \
    || fail "the $location control did not execute under Bun 1.3.3"
  rm -- "$preload_log"
  printf 'source startup contract: PASS: unprotected Bun executes %s preload control\n' "$location"

  for command_name in trellage trx; do
    assert_help "source-shell-$command_name" "$command_name" "$repo_root/bin/$command_name"
    assert_help "source-ts-$command_name" "$command_name" "$repo_root/bin/$command_name.ts"
    assert_help "installed-shell-$command_name" "$command_name" "$fixture_bin/$command_name"
    assert_help "installed-ts-$command_name" "$command_name" "$installed_root/bin/$command_name.ts"
  done
  assert_installer_refusal source-installer "$repo_root/scripts/install-source-runtime.sh"
  assert_installer_refusal installed-installer "$installed_root/scripts/install-source-runtime.sh"
done

printf 'source startup contract: PASS\n'
