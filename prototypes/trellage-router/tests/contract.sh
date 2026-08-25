#!/usr/bin/env bash
set -euo pipefail

prototype_root="$(cd -P "$(dirname "$0")/.." && pwd -P)"
fixture_root="$prototype_root/.contract-fixture.$$"
fixture_home="$fixture_root/home"
fixture_bin="$fixture_home/.local/bin"
runtime_parent="$fixture_home/.local/share/trellage"
argument_log="$fixture_root/arguments.bin"
inventory_log="$fixture_root/inventory.log"
real_node="$(mise which node --tool=node@24 2>/dev/null || command -v node)"

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
ln -s "$real_node" "$fixture_bin/node"
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

  local sandbox=false
  if [[ "$launcher" == cdx || "$launcher" == grx ]]; then
    sandbox=true
  fi

  mkdir -p "$runtime/bin"
  printf '%s\n' "$marker_value" >"$runtime/$marker"
  if [[ "$launcher" == omp ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "omp",
  "harness": "oh-my-pi",
  "sandbox": false,
  "profiles": [
    {
      "name": "copilot",
      "description": "Native GitHub Copilot",
      "headless": {
        "schemaVersion": 1,
        "prompt": true,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "prompt-only",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": "17.2.12"
      },
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": []
    },
    {
      "name": "local",
      "description": "Local Qwen",
      "headless": {
        "schemaVersion": 1,
        "prompt": false,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "none",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": null
      },
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": []
    }
  ]
}
EOF
  elif [[ "$launcher" == picx ]]; then
    cat >"$runtime/catalog.json" <<EOF
{
  "schemaVersion": 1,
  "launcher": "picx",
  "harness": "pi",
  "sandbox": false,
  "profiles": [
    {
      "name": "default",
      "description": "Ordered Pi extension profile",
      "headless": {
        "schemaVersion": 1,
        "prompt": true,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "prompt-only",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": "0.84.2"
      },
      "plugin": null,
      "source": null,
      "marketplace": null,
      "standaloneMcps": [],
      "extensions": [
        {"name":"Ponytail","package":"@dietrichgebert/ponytail","installSpec":"git:github.com/DietrichGebert/ponytail"}
      ]
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
  "sandbox": $sandbox,
  "profiles": [
    {
      "name": "${launcher}-p",
      "description": "$description",
      "headless": {
        "schemaVersion": 1,
        "prompt": true,
        "outputFormats": ["text"],
        "eventContract": null,
        "trellageEventContract": null,
        "sessionId": "none",
        "resume": false,
        "resumeWithPrompt": false,
        "questionToolControl": "none",
        "changedFiles": "none",
        "usage": false,
        "cost": false,
        "modelOverride": false,
        "effortOverride": false,
        "testedHarnessVersion": "1.2.3"
      },
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
create_native_launcher cldx claude .managed-by-trellage-claude-profiles trellage-claude-profiles-v1
create_native_launcher grx grok .managed-by-trellage-grok-profiles trellage-grok-profiles-v1
create_native_launcher jcx jcode .managed-by-trellage-jcode-profiles trellage-jcode-profiles-v1
create_native_launcher omp oh-my-pi .managed-by-trellage-omp-profiles trellage-omp-profiles-v1
create_native_launcher picx pi .managed-by-trellage-picx-profiles trellage-picx-profiles-v1
create_native_launcher prx prime .managed-by-trellage-prime-profiles trellage-prime-profiles-v1

export HOME="$fixture_home"
export PATH="$fixture_bin:/usr/bin:/bin"

"$prototype_root/install.sh" >"$fixture_root/install.out"
[[ -L "$fixture_bin/trx" ]] || fail 'installer did not publish trx command symlink'
[[ "$(readlink "$fixture_bin/trx")" == "$runtime_parent/trx/bin/trx" ]] \
  || fail 'installer published the wrong trx command target'
assert_contains 'Installed trx' "$fixture_root/install.out"

mv "$runtime_parent/trx/lib/launcher.mjs" \
  "$runtime_parent/trx/lib/terminal-picker.mjs"
"$prototype_root/install.sh" >"$fixture_root/reinstall.out"
[[ -x "$runtime_parent/trx/bin/trx" ]] || fail 'repeat install removed launcher'
[[ -x "$runtime_parent/trx/lib/launcher.mjs" ]] \
  || fail 'upgrade did not install the Ink launcher'
[[ -x "$runtime_parent/trx/lib/bootstrap-development-dependencies.sh" ]] \
  || fail 'upgrade did not install the dependency bootstrap'
[[ ! -e "$runtime_parent/trx/lib/terminal-picker.mjs" ]] \
  || fail 'upgrade left the legacy terminal picker'

"$fixture_bin/trx" --help >"$fixture_root/help.out"
assert_contains 'trx list [--json]' "$fixture_root/help.out"
assert_contains 'Bare trx opens the launcher.' "$fixture_root/help.out"

"$fixture_bin/trx" list >"$fixture_root/list.out" \
  || fail 'human list failed'
assert_contains $'cpx/cpx-p\t' "$fixture_root/list.out"
assert_contains $'cdx/cdx-p\tcdx' "$fixture_root/list.out"
assert_contains $'cldx/cldx-p\tcldx' "$fixture_root/list.out"
assert_contains $'grx/grx-p\tgrx' "$fixture_root/list.out"
assert_contains $'jcx/jcx-p\tjcx' "$fixture_root/list.out"
assert_contains $'omp/copilot\tNative GitHub Copilot' "$fixture_root/list.out"
assert_contains $'omp/local\tLocal Qwen' "$fixture_root/list.out"
assert_contains $'picx/default\tOrdered Pi extension profile' "$fixture_root/list.out"
assert_contains $'prx/prx-p\tprx' "$fixture_root/list.out"

"$fixture_bin/trx" list --json >"$fixture_root/list.json" \
  || fail 'JSON list failed'
jq -e '
  type == "object"
  and keys == ["profiles", "schemaVersion"]
  and .schemaVersion == 1
  and ([.profiles[] | keys] | all(. == ["description", "harness", "headless", "herdrCompatibility", "launcher", "name", "sandbox"]))
  and [.profiles[] | .launcher + "/" + .name] == [
    "cpx/cpx-p",
    "cdx/cdx-p",
    "cldx/cldx-p",
    "grx/grx-p",
    "jcx/jcx-p",
    "omp/copilot",
    "omp/local",
    "picx/default",
    "prx/prx-p"
  ]
  and [.profiles[] | .harness] == [
    "copilot",
    "codex",
    "claude",
    "grok",
    "jcode",
    "oh-my-pi",
    "oh-my-pi",
    "pi",
    "prime"
  ]
  and [.profiles[] | .sandbox] == [
    false,
    true,
    false,
    true,
    false,
    false,
    false,
    false,
    false
  ]
  and all(.profiles[]; .herdrCompatibility.status | . == "untested" or . == "verified" or . == "known-issue")
  and (.profiles[] | select(.launcher == "omp" and .name == "copilot") | .herdrCompatibility) == { status: "verified" }
  and (.profiles[] | select(.launcher == "omp" and .name == "local") | .herdrCompatibility.status) == "known-issue"
  and (.profiles[] | select(.launcher == "picx" and .name == "default") | .herdrCompatibility.status) == "untested"
  and (.profiles[] | select(.launcher == "cpx") | .herdrCompatibility) == { status: "untested" }
  and (.profiles[] | select(.launcher == "omp" and .name == "copilot") | .headless.questionToolControl) == "prompt-only"
  and (.profiles[] | select(.launcher == "cdx") | .headless.testedHarnessVersion) == "1.2.3"
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
  'codex\x1e\r\x1el' '' "$prototype_root/bin/trx" '--source-mode' \
  || fail 'worktree source type-to-filter selection failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source arguments were not forwarded'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cdx", b"cdx-p", b"--source-mode", b""]
raise SystemExit(0 if actual == expected else 1)
PY

TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/source-slash-select.out" \
  '/codex\x1e\r\x1el' '' "$prototype_root/bin/trx" '--source-mode' \
  || fail 'worktree source leading-slash selection failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source leading-slash arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cdx", b"cdx-p", b"--source-mode", b""]
raise SystemExit(0 if actual == expected else 1)
PY

TRX_ARGUMENT_LOG="$argument_log" \
  TRELLAGE_TRX_SOURCE_ROOT="$prototype_root" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/source-backspace-select.out" \
  'codex\x1e\x7f\x1e\x7f\x1e\x7f\x1e\x7f\x1e\x7f\x1ecopilot\x1e\r\x1el' \
  '' "$prototype_root/bin/trx" '--source-mode' \
  || fail 'worktree source Backspace filtering failed'
python3 - "$argument_log" <<'PY' || fail 'worktree source Backspace selection launched the wrong profile'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"--source-mode", b""]
if actual != expected:
    print(f"expected {expected!r}, got {actual!r}", file=sys.stderr)
    raise SystemExit(1)
PY

status=0
"$fixture_bin/trx" list --json-full >"$fixture_root/list-invalid.out" \
  2>"$fixture_root/list-invalid.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid list arguments exited $status instead of 1"
assert_contains 'list accepts only --json' "$fixture_root/list-invalid.err"

status=0
"$fixture_bin/trx" >"$fixture_root/non-tty.out" 2>"$fixture_root/non-tty.err" \
  || status=$?
[[ "$status" == 1 ]] || fail "non-TTY invocation exited $status instead of 1"
assert_contains 'an interactive terminal is required' "$fixture_root/non-tty.err"

cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs"

writeFileSync(process.env.TRX_PICKER_INPUT, readFileSync(process.argv[2]))
writeFileSync(process.argv[3], '{"id":"cpx:cpx-p","target":"current"}\n')
EOF
selection_started="$(python3 -c 'import time; print(time.monotonic_ns())')"
TRX_ARGUMENT_LOG="$argument_log" \
  TRX_INVENTORY_DELAY=4 \
  TRX_INVENTORY_LOG="$inventory_log" \
  TRX_PICKER_INPUT="$fixture_root/picker-input.json" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/select.out" \
  '\r' '' "$fixture_bin/trx" \
  'two words' '' '--literal=*' \
  || fail 'interactive selection failed'
selection_finished="$(python3 -c 'import time; print(time.monotonic_ns())')"
selection_milliseconds="$(((selection_finished - selection_started) / 1000000))"
((selection_milliseconds < 4000)) \
  || fail "selected profile launch was delayed ${selection_milliseconds}ms by inventory"
jq --arg commandPath "$runtime_parent/cpx/bin/cpx" -e '
  .description == "Trellage Native runs coding-agent launchers directly on the host with isolated state. Codex (cdx) and Grok (grx) enable the native sandbox for each harness; other native profiles are not security boundaries."
  and (.choices[0]
    | .label == "copilot / cpx-p"
      and (.description | length == 1200)
      and .commandAlias == "cpx"
      and .commandPath == $commandPath
      and .profileArgument == "cpx-p"
      and .passthroughArgs == ["two words", "", "--literal=*"]
      and .plugins == ["cpx-plug"]
      and .skills == []
      and .mcps == ["docs", "files"]
      and .sandbox == false
      and (.details == "The selected launcher checks readiness before starting.")
      and ([.label,.description,.details,.plugins[],.mcps[]] | all(test("[[:cntrl:]]") | not)))
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choice omitted complete catalog metadata or launch readiness status'
jq -e '
  ([.choices[] | select(.id == "cldx:cldx-p")]
    | length == 1
      and .[0].label == "claude / cldx-p"
      and .[0].harness == "claude"
      and .[0].profile == "cldx-p")
  and ([.choices[] | select(.id == "omp:copilot")]
    | length == 1
      and .[0].label == "pi / oh-my-pi"
      and .[0].harness == "pi"
      and .[0].profile == "oh-my-pi")
  and ([.choices[] | select(.id == "omp:local")]
    | length == 1
      and .[0].label == "pi / local"
      and .[0].harness == "pi"
      and .[0].profile == "local")
  and ([.choices[] | select(.id == "picx:default")]
    | length == 1
      and .[0].label == "pi / default"
      and .[0].harness == "pi"
      and .[0].profile == "default"
      and .[0].defaultModel == "copilot-proxy-rs/gpt-5.6-sol:medium"
      and .[0].models == ["copilot-proxy-rs/gpt-5.6-sol:medium"]
      and .[0].modelOverrideSupported == false)
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router choices did not expose Claude and Pi harness/profile identities'
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
jq -e '
  ([.choices[] | select(.id == "omp:local" or .id == "picx:default") | .modelOverrideSupported] | all(. == false))
  and ([.choices[] | select(.id != "omp:local" and .id != "picx:default") | .modelOverrideSupported] | all)
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router did not enable model overrides for every launcher except local Qwen'
jq -e '
  ([.choices[] | select(.id == "cdx:cdx-p") | .sandbox] == [true])
  and ([.choices[] | select(.id == "grx:grx-p") | .sandbox] == [true])
  and ([.choices[] | select(.commandAlias == "cldx" or .commandAlias == "jcx" or .commandAlias == "omp" or .commandAlias == "picx" or .commandAlias == "prx") | .sandbox] | all(. == false))
' "$fixture_root/picker-input.json" >/dev/null \
  || fail 'router did not expose accurate per-choice sandbox status'
[[ ! -e "$inventory_log" ]] \
  || fail 'router read diagnostic inventory before launching the selected profile'

inventory_output="$("$fixture_bin/trx" inventory cpx cpx-p --json)" \
  || fail 'trx inventory failed for a known launcher/profile'
jq -e '
  .schemaVersion == 1
  and .launcher == "cpx"
  and .profile == "cpx-p"
  and .readiness == "healthy"
' <<<"$inventory_output" >/dev/null \
  || fail 'trx inventory did not return the expected readiness contract'

status=0
"$fixture_bin/trx" inventory bogus cpx-p --json >"$fixture_root/inventory-bad-launcher.out" \
  2>"$fixture_root/inventory-bad-launcher.err" || status=$?
[[ "$status" == 1 ]] || fail "trx inventory for an unknown launcher exited $status instead of 1"
assert_contains 'unknown launcher: bogus' "$fixture_root/inventory-bad-launcher.err"

status=0
"$fixture_bin/trx" inventory cpx cpx-p >"$fixture_root/inventory-missing-json.out" \
  2>"$fixture_root/inventory-missing-json.err" || status=$?
[[ "$status" == 1 ]] || fail "trx inventory without --json exited $status instead of 1"
assert_contains 'inventory requires LAUNCHER PROFILE --json' "$fixture_root/inventory-missing-json.err"

mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
python3 - "$argument_log" <<'PY' || fail 'arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"two words", b"", b"--literal=*", b""]
raise SystemExit(0 if actual == expected else 1)
PY

# Selecting Prime without passthrough arguments must invoke PRX with only its
# profile argument. This composes with the PRX argument-free launch contract.
cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"prx:prx-p","target":"current"}\n')
EOF
: >"$argument_log"
TRX_ARGUMENT_LOG="$argument_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/prx-select.out" \
  '\r' '' "$fixture_bin/trx" \
  || fail 'argument-free Prime selection failed'
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
python3 - "$argument_log" <<'PY' || fail 'argument-free Prime selection arguments differ'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
# The fake launcher's zero-argument `printf` emits one empty sentinel, followed
# by the trailing split field. No non-empty passthrough argument is present.
expected = [b"prx", b"prx-p", b"", b""]
if actual != expected:
    print(f"actual={actual!r} expected={expected!r}", file=sys.stderr)
    raise SystemExit(1)
PY

herdr_log="$fixture_root/herdr.log"
cat >"$fixture_bin/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TRX_HERDR_LOG"
if [[ "${1-} ${2-}" == 'pane split' ]]; then
  printf '%s\n' '{"result":{"pane":{"pane_id":"w1:p2"}}}'
fi
EOF
chmod 0755 "$fixture_bin/herdr"
cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"cdx:cdx-p","target":"herdr","model":"gpt-5.6-terra"}\n')
EOF
HERDR_ENV=1 HERDR_PANE_ID=w1:p1 TRX_HERDR_LOG="$herdr_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/herdr-select.out" \
  'l' '' "$fixture_bin/trx" '--literal=herdr' \
  || fail 'Herdr profile launch failed'
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
assert_contains 'pane split --current --direction right --cwd ' "$herdr_log"
assert_contains 'pane run w1:p2 ' "$herdr_log"
assert_contains '--model gpt-5.6-terra --literal=herdr' "$herdr_log"
rm "$fixture_bin/herdr"

cp "$runtime_parent/trx/lib/launcher.mjs" "$fixture_root/launcher.mjs"
cat >"$runtime_parent/trx/lib/launcher.mjs" <<'EOF'
import {writeFileSync} from "node:fs"
writeFileSync(process.argv[3], '{"id":"omp:copilot","target":"current"}\n')
EOF
TRX_ARGUMENT_LOG="$argument_log" \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/omp-select.out" \
  '\r' '' "$fixture_bin/trx" '--native-copilot' \
  || fail 'OMP interactive selection failed'
mv "$fixture_root/launcher.mjs" "$runtime_parent/trx/lib/launcher.mjs"
python3 - "$argument_log" <<'PY' || fail 'OMP arguments were not forwarded unchanged'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"omp", b"copilot", b"--native-copilot", b""]
raise SystemExit(0 if actual == expected else 1)
PY

status=0
TRX_ARGUMENT_LOG="$argument_log" \
  TRX_CHILD_EXIT=37 \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/child-exit.out" \
  'co\x1e\x1b[B\x1e\r\x1el' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 37 ]] || fail "child exit status became $status instead of 37"
python3 - "$argument_log" <<'PY' || fail 'filtered arrow selection did not launch the next profile'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
expected = [b"cpx", b"cpx-p", b"", b""]
if actual != expected:
    print(f"expected {expected!r}, got {actual!r}", file=sys.stderr)
    raise SystemExit(1)
PY

status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/cancel.out" \
  '\x03' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 130 ]] || fail "cancellation exited $status instead of 130"

status=0
TRX_WAIT=1 \
  python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/signal.out" \
  '\r\x1el' 'CHILD_READY' "$fixture_bin/trx" || status=$?
[[ "$status" == 143 ]] || fail "terminated child exited $status instead of 143"

mv "$fixture_bin/grx" "$fixture_bin/grx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing.out" \
  2>"$fixture_root/list-missing.err" || status=$?
[[ "$status" == 1 ]] || fail "missing launcher list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: grx' "$fixture_root/list-missing.err"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: grx' "$fixture_root/missing.out"
mv "$fixture_bin/grx.absent" "$fixture_bin/grx"

mv "$fixture_bin/cldx" "$fixture_bin/cldx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing-cldx.out" \
  2>"$fixture_root/list-missing-cldx.err" || status=$?
[[ "$status" == 1 ]] || fail "missing cldx list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: cldx' \
  "$fixture_root/list-missing-cldx.err"
mv "$fixture_bin/cldx.absent" "$fixture_bin/cldx"

mv "$fixture_bin/omp" "$fixture_bin/omp.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-omp.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing OMP launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: omp' "$fixture_root/missing-omp.out"
mv "$fixture_bin/omp.absent" "$fixture_bin/omp"

mv "$fixture_bin/picx" "$fixture_bin/picx.absent"
status=0
"$fixture_bin/trx" list >"$fixture_root/list-missing-picx.out" \
  2>"$fixture_root/list-missing-picx.err" || status=$?
[[ "$status" == 1 ]] || fail "missing picx list exited $status instead of 1"
assert_contains 'required launcher not found on PATH: picx' \
  "$fixture_root/list-missing-picx.err"
mv "$fixture_bin/picx.absent" "$fixture_bin/picx"

mv "$fixture_bin/jcx" "$fixture_bin/jcx.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-jcx.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "missing jcx launcher exited $status instead of 1"
assert_contains 'required launcher not found on PATH: jcx' "$fixture_root/missing-jcx.out"
mv "$fixture_bin/jcx.absent" "$fixture_bin/jcx"

mv "$fixture_bin/prx" "$fixture_bin/prx.absent"
status=0
python3 "$prototype_root/tests/pty_driver.py" "$fixture_root/missing-prx.out" \
  '\r' '' "$fixture_bin/trx" || status=$?
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
  '\r' '' "$fixture_bin/trx" || status=$?
[[ "$status" == 1 ]] || fail "invalid catalog exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/invalid.out"
mv "$fixture_root/cdx.catalog" "$runtime_parent/cdx/catalog.json"

cp "$runtime_parent/cdx/catalog.json" "$fixture_root/cdx.headless.catalog"
python3 - "$runtime_parent/cdx/catalog.json" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
data["profiles"][0]["headless"]["questionToolControl"] = "invalid"
path.write_text(json.dumps(data, indent=2) + "\n")
PY
status=0
"$fixture_bin/trx" list --json >"$fixture_root/list-invalid-headless.out" \
  2>"$fixture_root/list-invalid-headless.err" || status=$?
[[ "$status" == 1 ]] || fail "invalid headless catalog list exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/list-invalid-headless.err"
python3 - "$fixture_root/cdx.headless.catalog" "$runtime_parent/cdx/catalog.json" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
data = json.loads(source.read_text())
data["profiles"][0]["headless"]["trellageEventContract"] = "unsupported-trellage-events-v1"
destination.write_text(json.dumps(data, indent=2) + "\n")
PY
status=0
"$fixture_bin/trx" list --json >"$fixture_root/list-invalid-trellage-event.out" \
  2>"$fixture_root/list-invalid-trellage-event.err" || status=$?
[[ "$status" == 1 ]] \
  || fail "unsupported Trellage event contract list exited $status instead of 1"
assert_contains 'invalid catalog from cdx' "$fixture_root/list-invalid-trellage-event.err"
mv "$fixture_root/cdx.headless.catalog" "$runtime_parent/cdx/catalog.json"

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
  '\r' '' "$fixture_bin/trx" || status=$?
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

mv "$runtime_parent/trx/lib/launcher.mjs" \
  "$runtime_parent/trx/lib/terminal-picker.mjs"
"$prototype_root/uninstall.sh" >"$fixture_root/uninstall.out"
[[ ! -e "$runtime_parent/trx" ]] || fail 'uninstaller left trx runtime'
[[ ! -e "$fixture_bin/trx" && ! -L "$fixture_bin/trx" ]] \
  || fail 'uninstaller left trx command'
[[ -x "$runtime_parent/cpx/bin/cpx" && -x "$runtime_parent/cdx/bin/cdx" \
  && -x "$runtime_parent/cldx/bin/cldx" && -x "$runtime_parent/grx/bin/grx" \
  && -x "$runtime_parent/jcx/bin/jcx" \
  && -x "$runtime_parent/omp/bin/omp" && -x "$runtime_parent/picx/bin/picx" \
  && -x "$runtime_parent/prx/bin/prx" ]] \
  || fail 'uninstaller changed native launchers'
assert_contains 'Uninstalled trx.' "$fixture_root/uninstall.out"

printf 'trx contract: PASS\n'
