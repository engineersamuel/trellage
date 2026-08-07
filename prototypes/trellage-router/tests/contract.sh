#!/usr/bin/env bash
set -euo pipefail

prototype_root="$(cd -P "$(dirname "$0")/.." && pwd -P)"
fixture_root="$prototype_root/.contract-fixture.$$"
fixture_home="$fixture_root/home"
fixture_bin="$fixture_home/.local/bin"
runtime_parent="$fixture_home/.local/share/trellage"
argument_log="$fixture_root/arguments.bin"
inventory_log="$fixture_root/inventory.log"

cleanup() {
  if [[ "${TRX_KEEP_FIXTURE-}" == 1 ]]; then
    printf 'trx contract fixture: %s\n' "$fixture_root" >&2
    return
  fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fail() {
  printf 'trx contract: FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local expected="$1"
  local file="$2"
  grep -Fq -- "$expected" "$file" || fail "missing '$expected' in $file"
}

mkdir -p "$fixture_home" "$fixture_bin"
ln -s "$(command -v node)" "$fixture_bin/node"
ln -s "$(command -v jq)" "$fixture_bin/jq"
ln -s "$(command -v python3)" "$fixture_bin/python3"

create_native_launcher() {
  local launcher="$1"
  local harness="$2"
  local marker="$3"
  local marker_value="$4"
  local runtime="$runtime_parent/$launcher"
  local description="$launcher"
  local standalone_mcps='[]'

  if [[ "$launcher" == cpx ]]; then
    printf -v description '%1200s' ''
    description="${description// /x}"
    standalone_mcps='["docs", {"name":"files","transport":"stdio"}]'
  fi

  mkdir -p "$runtime/bin"
  printf '%s\n' "$marker_value" >"$runtime/$marker"
  if [[ "$launcher" == omp ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "omp",
  "harness": "oh-my-pi",
  "profiles": [
    {
      "name": "copilot",
      "description": "Native GitHub Copilot",
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": []
    },
    {
      "name": "local",
      "description": "Local Qwen",
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": []
    }
  ]
}
EOF
  else
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "$launcher",
  "harness": "$harness",
  "profiles": [
    {
      "name": "${launcher}-p",
      "description": "$description",
      "plugin": "${launcher}-plug",
      "source": null,
      "marketplace": null,
      "standaloneMcps": $standalone_mcps
    }
  ]
}
EOF
  fi
  cat >"$runtime/bin/$launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
runtime="$(cd -P "$(dirname "$0")/.." && pwd -P)"
if [[ "${1-} ${2-}" == 'list --json' ]]; then
  cat "$runtime/catalog.json"
  exit 0
fi
if [[ "${1-}" == inventory && "${3-}" == --json ]]; then
  launcher="$(basename "$0")"
  sleep "${TRX_INVENTORY_DELAY-0}"
  if [[ -n "${TRX_INVENTORY_LOG-}" ]]; then
    printf '%s:%s\n' "$launcher" "$2" >>"$TRX_INVENTORY_LOG"
  fi
  package_count=2
  jq -cn \
    --arg launcher "$launcher" \
    --arg harness "$(jq -r .harness "$runtime/catalog.json")" \
    --arg profile "$2" \
    --argjson packageCount "$package_count" \
    '{
      schemaVersion:1,
      launcher:$launcher,
      harness:$harness,
      profile:$profile,
      readiness:"healthy",
      plugins:[{name:($launcher + "-plug"),version:"1.2.3"}],
      skills:{packageCount:$packageCount,visibleCount:4},
      mcps:["docs","files"]
    }'
  exit 0
fi
profile="${1-}"
shift || true
if [[ -n "${TRX_ARGUMENT_LOG-}" ]]; then
  {
    printf '%s\0' "$(basename "$0")" "$profile"
    printf '%s\0' "$@"
  } >"$TRX_ARGUMENT_LOG"
fi
if [[ "${TRX_WAIT-}" == 1 ]]; then
  printf 'CHILD_READY\n'
  while :; do sleep 1; done
fi
exit "${TRX_CHILD_EXIT-0}"
EOF
  chmod 0755 "$runtime/bin/$launcher"
  ln -s "$runtime/bin/$launcher" "$fixture_bin/$launcher"
}

create_native_launcher cpx copilot .managed-by-trellage-profiles trellage-profiles-v1
create_native_launcher cdx codex .managed-by-trellage-codex-profiles trellage-codex-profiles-v1
create_native_launcher grx grok .managed-by-trellage-grok-profiles trellage-grok-profiles-v1
create_native_launcher jcx jcode .managed-by-trellage-jcode-profiles trellage-jcode-profiles-v1
create_native_launcher omp oh-my-pi .managed-by-trellage-omp-profiles trellage-omp-profiles-v1
create_native_launcher prx prime .managed-by-trellage-prime-profiles trellage-prime-profiles-v1

export HOME="$fixture_home"
export PATH="$fixture_bin:/usr/bin:/bin"

"$prototype_root/install.sh" >"$fixture_root/install.out"
[[ -L "$fixture_bin/trx" ]] || fail 'installer did not publish trx command symlink'
[[ "$(readlink "$fixture_bin/trx")" == "$runtime_parent/trx/bin/trx" ]] \
  || fail 'installer published the wrong trx command target'
assert_contains 'Installed trx' "$fixture_root/install.out"

"$prototype_root/install.sh" >"$fixture_root/reinstall.out"
[[ -x "$runtime_parent/trx/bin/trx" ]] || fail 'repeat install removed launcher'

"$fixture_bin/trx" --help >"$fixture_root/help.out"
assert_contains 'trx list [--json]' "$fixture_root/help.out"
assert_contains 'trx -i [LAUNCHER_ARGS...]' "$fixture_root/help.out"

"$fixture_bin/trx" list >"$fixture_root/list.out" \
  || fail 'human list failed'
assert_contains $'cpx/cpx-p\t' "$fixture_root/list.out"
assert_contains $'cdx/cdx-p\tcdx' "$fixture_root/list.out"
assert_contains $'grx/grx-p\tgrx' "$fixture_root/list.out"
assert_contains $'jcx/jcx-p\tjcx' "$fixture_root/list.out"
assert_contains $'omp/copilot\tNative GitHub Copilot' "$fixture_root/list.out"
assert_contains $'omp/local\tLocal Qwen' "$fixture_root/list.out"
assert_contains $'prx/prx-p\tprx' "$fixture_root/list.out"

"$fixture_bin/trx" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  type == "object"
  and keys == ["profiles", "schemaVersion"]
  and .schemaVersion == 1
  and ([.profiles[] | keys] | all(. == ["description", "harness", "launcher", "name"]))
  and [.profiles[] | .launcher + "/" + .name] == [
    "cpx/cpx-p",
    "cdx/cdx-p",
    "grx/grx-p",
    "jcx/jcx-p",
    "omp/copilot",
    "omp/local",
    "prx/prx-p"
  ]
  and [.profiles[] | .harness] == [
    "copilot",
    "codex",
    "grok",
    "jcode",
    "oh-my-pi",
    "oh-my-pi",
    "prime"
  ]
  and all(.profiles[]; .description | type == "string" and length > 0)
' "$fixture_root/list.json" >/dev/null \
  || fail 'JSON list shape or ordering differs'

TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  "$prototype_root/bin/trx" list --json >"$fixture_root/source-list.json" \
  || fail 'worktree source JSON list failed'
cmp -s "$fixture_root/source-list.json" "$fixture_root/list.json" \
  || fail 'worktree source list differs from installed router list'

TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/source-select.out" \
  '\r' '' "$prototype_root/bin/trx" -i '--source-mode' \
  || fail 'worktree source interactive selection failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source arguments were not forwarded'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"--source-mode", b""]
raise SystemExit(0 if actual == expected else 1)
PY

status=0
"$fixture_bin/trx" list --json-full >"$fixture_root/list-invalid.out" \
  2>"$fixture_root/list-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid list arguments exited $status instead of 1"
assert_contains 'list accepts only --json' "$fixture_root/list-invalid.err"

status=0
"$fixture_bin/trx" -i >"$fixture_root/non-tty.out" 2>"$fixture_root/non-tty.err" \
  || status=$?
[[ "$status" == 1 ]] || fail "non-TTY invocation exited $status instead of 1"
assert_contains 'an interactive terminal is required' "$fixture_root/non-tty.err"

cp "$runtime_parent/trx/lib/terminal-picker.mjs" "$fixture_root/terminal-picker.mjs"
cat >"$runtime_parent/trx/lib/terminal-picker.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs"

writeFileSync(process.env.TRX_PICKER_INPUT, readFileSync(0))
process.stdout.write("cpx:cpx-p\n")
EOF
selection_started="$(python3 -c 'import time; print(time.monotonic_ns())')"
TRX_ARGUMENT_LOG="$argument_log" \
  TRX_INVENTORY_DELAY=4 \
  TRX_INVENTORY_LOG="$inventory_log" \
  TRX_PICKER_INPUT="$fixture_root/picker-input.json" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/select.out" \
  '\r' '' "$fixture_bin/trx" --interactive \
  'two words' '' '--literal=*' \
  || fail 'interactive selection failed'
selection_finished="$(python3 -c 'import time; print(time.monotonic_ns())')"
selection_milliseconds="$(((selection_finished - selection_started) / 1000000))"
((selection_milliseconds < 4000)) \
  || fail "selected profile launch was delayed ${selection_milliseconds}ms by inventory"
jq -e '
  .choices[0]
  | .label == "copilot / cpx-p"
    and (.description | length == 1200)
    and (.details == "The selected launcher checks readiness before starting.")
    and ([.label,.description,.details] | all(test("[[:cntrl:]]") | not))
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choice omitted concise catalog data or launch readiness status'
jq -e '
  [.choices[] | select(.label == "oh-my-pi / copilot" or .label == "oh-my-pi / local")]
  | length == 2
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices omitted OMP profiles'
jq -e '
  [.choices[] | select(.label == "jcode / jcx-p")]
  | length == 1
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices omitted jcode profile'
jq -e '
  [.choices[] | select(.label == "prime / prx-p")]
  | length == 1
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices omitted prime profile'
[[ ! -e "$inventory_log" ]] \
  || fail 'router read diagnostic inventory before launching the selected profile'
mv "$fixture_root/terminal-picker.mjs" "$runtime_parent/trx/lib/terminal-picker.mjs"
python3 - "$argument_log" <<'PY' || fail 'arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"two words", b"", b"--literal=*", b""]
raise SystemExit(0 if actual == expected else 1)
PY

cp "$runtime_parent/trx/lib/terminal-picker.mjs" "$fixture_root/terminal-picker.mjs"
cat >"$runtime_parent/trx/lib/terminal-picker.mjs" <<'EOF'
process.stdout.write("omp:copilot\n")
EOF
TRX_ARGUMENT_LOG="$argument_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/omp-select.out" \
  '\r' '' "$fixture_bin/trx" -i '--native-copilot' \
  || fail 'OMP interactive selection failed'
mv "$fixture_root/terminal-picker.mjs" "$runtime_parent/trx/lib/terminal-picker.mjs"
python3 - "$argument_log" <<'PY' || fail 'OMP arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"omp", b"copilot", b"--native-copilot", b""]
raise SystemExit(0 if actual == expected else 1)
PY

status=0
TRX_CHILD_EXIT=37 \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/child-exit.out" \
  '\x1b[B\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status instead of 37"

status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/cancel.out" \
  '\x1b' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 130 ]] || fail "cancellation exited $status instead of 130"

status=0
TRX_WAIT=1 \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/signal.out" \
  '\r' 'CHILD_READY' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 143 ]] || fail "terminated child exited $status instead of 143"

mv "$fixture_bin/grx" "$fixture_bin/grx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing.out" \
  2>"$fixture_root/list-missing.err" || status=$?
[[ "$status" == 1 ]] || fail "missing launcher list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: grx' "$fixture_root/list-missing.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing.out" \
  '\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 1 ]] || fail "missing launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: grx' "$fixture_root/missing.out"
mv "$fixture_bin/grx.absent" "$fixture_bin/grx"

mv "$fixture_bin/omp" "$fixture_bin/omp.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-omp.out" \
  '\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 1 ]] || fail "missing OMP launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: omp' "$fixture_root/missing-omp.out"
mv "$fixture_bin/omp.absent" "$fixture_bin/omp"

mv "$fixture_bin/jcx" "$fixture_bin/jcx.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-jcx.out" \
  '\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 1 ]] || fail "missing jcx launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: jcx' "$fixture_root/missing-jcx.out"
mv "$fixture_bin/jcx.absent" "$fixture_bin/jcx"

mv "$fixture_bin/prx" "$fixture_bin/prx.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-prx.out" \
  '\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 1 ]] || fail "missing prx launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: prx' "$fixture_root/missing-prx.out"
mv "$fixture_bin/prx.absent" "$fixture_bin/prx"

cp "$runtime_parent/cdx/catalog.json" "$fixture_root/cdx.catalog"
printf '{not-json}\n' >"$runtime_parent/cdx/catalog.json"
status=0
"$fixture_bin/trx" list --json >"$fixture_root/list-invalid-catalog.out" \
  2>"$fixture_root/list-invalid-catalog.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid catalog list exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/list-invalid-catalog.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/invalid.out" \
  '\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 1 ]] || fail "invalid catalog exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/invalid.out"
mv "$fixture_root/cdx.catalog" "$runtime_parent/cdx/catalog.json"

rm "$fixture_bin/cpx"
cp "$runtime_parent/cpx/bin/cpx" "$fixture_root/unrelated-cpx"
ln -s "$fixture_root/unrelated-cpx" "$fixture_bin/cpx"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-redirected.out" \
  2>"$fixture_root/list-redirected.err" || status=$?
[[ "$status" == 1 ]] || fail "redirected launcher list exited $status instead of 1"
assert_contains 'launcher is not the owned Trellage runtime: cpx' \
  "$fixture_root/list-redirected.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/redirected.out" \
  '\r' '' "$fixture_bin/trx" -i || status=$?
[[ "$status" == 1 ]] || fail "redirected launcher exited $status instead of 1"
assert_contains 'launcher is not the owned Trellage runtime: cpx' "$fixture_root/redirected.out"
rm "$fixture_bin/cpx"
ln -s "$runtime_parent/cpx/bin/cpx" "$fixture_bin/cpx"

printf 'unrelated\n' >"$fixture_root/unrelated-command"
rm "$fixture_bin/trx"
cp "$fixture_root/unrelated-command" "$fixture_bin/trx"
status=0
"$prototype_root/install.sh" >"$fixture_root/unrelated-install.out" \
  2>"$fixture_root/unrelated-install.err" || status=$?
[[ "$status" == 1 ]] || fail "unrelated command install exited $status instead of 1"
assert_contains 'refusing to replace unrelated command' "$fixture_root/unrelated-install.err"
rm "$fixture_bin/trx"
ln -s "$runtime_parent/trx/bin/trx" "$fixture_bin/trx"

"$prototype_root/uninstall.sh" >"$fixture_root/uninstall.out"
[[ ! -e "$runtime_parent/trx" ]] || fail 'uninstaller left trx runtime'
[[ ! -e "$fixture_bin/trx" && ! -L "$fixture_bin/trx" ]] \
  || fail 'uninstaller left trx command'
[[ -x "$runtime_parent/cpx/bin/cpx" && -x "$runtime_parent/cdx/bin/cdx" \
  && -x "$runtime_parent/grx/bin/grx" && -x "$runtime_parent/jcx/bin/jcx" \
  && -x "$runtime_parent/omp/bin/omp" && -x "$runtime_parent/prx/bin/prx" ]] \
  || fail 'uninstaller changed native launchers'
assert_contains 'Uninstalled trx.' "$fixture_root/uninstall.out"

printf 'trx contract: PASS\n'
