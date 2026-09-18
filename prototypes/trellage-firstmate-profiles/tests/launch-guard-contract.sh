#!/usr/bin/env bash
# Sourced by fleet-contract.sh with an owned, stopped, ready fleet.

guard_inputs="$fixture_root/launch-guard-inputs"
mkdir "$guard_inputs"
NATIVE_CLAUDE_ARGV_LOG="$guard_inputs/claude-argv.jsonl"
: >"$NATIVE_CLAUDE_ARGV_LOG"
printf '%s' "$fleet_identity" >"$guard_inputs/expected.json"
python3 - "$guard_inputs" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
expected = json.loads((root / "expected.json").read_text())
for field, value in (
    ("profile", "pstack-workers"),
    ("instanceId", "314ea25d-e3e7-429c-bfb7-7385db576e26"),
    ("home", expected["home"] + "/other"),
    ("sourceRevision", "0" * 40),
):
    wrong = dict(expected)
    wrong[field] = value
    (root / (field + ".json")).write_text(json.dumps(wrong))
(root / "malformed.json").write_text("{")
(root / "array.json").write_text("[]")
(root / "extra.json").write_text(json.dumps(dict(expected, schemaVersion=1)))
(root / "duplicate.json").write_text('{"profile":"default",' + json.dumps(expected)[1:])
(root / "oversized.json").write_text(" " * 65537)
PY
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
: >"$NATIVE_CLAUDE_LOG"
guard_source_before="$(shasum -a 256 "$fleet_profile/receipts/source.json")"
for guard_case in profile instanceId home sourceRevision malformed array extra duplicate oversized; do
  guard_status=0
  fmx default --fmx-expected-fleet-json "$(cat "$guard_inputs/$guard_case.json")" \
    >/dev/null 2>"$logs/guard-$guard_case.err" || guard_status=$?
  [[ "$guard_status" != 0 ]] || fail "launch accepted a $guard_case expected identity"
done
guard_status=0
fmx default --fmx-expected-fleet-json "$fleet_identity" --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-repeated.err" || guard_status=$?
[[ "$guard_status" != 0 ]] || fail 'launch accepted duplicate identity guards'
guard_status=0
fmx default --fmx-expected-fleet-json >/dev/null 2>"$logs/guard-missing.err" || guard_status=$?
[[ "$guard_status" != 0 ]] || fail 'launch accepted an identity guard without its value'
[[ ! -s "$NATIVE_CLAUDE_LAUNCH_LOG" && ! -s "$NATIVE_CLAUDE_LOG" \
  && ! -s "$NATIVE_CLAUDE_ARGV_LOG" && ! -e "$fleet_profile/locks/session" ]] \
  || fail 'invalid launch identity reached supervisor startup'

# The guard must read the current persistent instance, not a preflight snapshot.
python3 - "$fleet_profile/receipts/instance.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["instanceId"] = "314ea25d-e3e7-429c-bfb7-7385db576e26"
path.write_text(json.dumps(value))
PY
guard_status=0
fmx default --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-replaced-instance.err" || guard_status=$?
[[ "$guard_status" != 0 && ! -s "$NATIVE_CLAUDE_LAUNCH_LOG" ]] \
  || fail 'launch used an identity captured before fleet replacement'
printf '%s\n' "$instance_before" >"$fleet_profile/receipts/instance.json"

# A controlled launch never repairs source or refreshes prerequisites after preflight.
mkdir "$fleet_profile/runtime.previous"
guard_status=0
fmx default --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-interrupted-publication.err" || guard_status=$?
[[ "$guard_status" != 0 && -d "$fleet_profile/runtime.previous" ]] \
  || fail 'guarded launch changed an interrupted source publication'
rmdir "$fleet_profile/runtime.previous"
guard_status=0
NATIVE_CLAUDE_SKILLS_STATUS=1 fmx default --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-missing-skills.err" || guard_status=$?
[[ "$guard_status" != 0 && ! -s "$NATIVE_CLAUDE_LAUNCH_LOG" ]] \
  || fail 'guarded launch refreshed missing cached skills'
assert_not_contains 'prepare|' "$NATIVE_CLAUDE_LOG"
[[ "$guard_source_before" == "$(shasum -a 256 "$fleet_profile/receipts/source.json")" ]] \
  || fail 'a rejected guarded launch replaced its source receipt'

guard_doctor_ready="$fixture_root/guard-doctor-ready"
guard_doctor_release="$fixture_root/guard-doctor-release"
guard_launch_ready="$fixture_root/guard-launch-ready"
guard_launch_release="$fixture_root/guard-launch-release"
(
  NATIVE_CLAUDE_DOCTOR_READY="$guard_doctor_ready" NATIVE_CLAUDE_DOCTOR_RELEASE="$guard_doctor_release" \
    NATIVE_CLAUDE_LAUNCH_READY="$guard_launch_ready" NATIVE_CLAUDE_LAUNCH_RELEASE="$guard_launch_release" \
    fmx default --fmx-expected-fleet-json "$fleet_identity" >/dev/null 2>"$logs/guard-winner.err"
) &
guard_pid=$!
for _ in $(seq 1 200); do
  [[ -f "$guard_doctor_ready" ]] && break
  sleep 0.01
done
if [[ ! -f "$guard_doctor_ready" ]]; then
  : >"$guard_doctor_release"; : >"$guard_launch_release"
  wait "$guard_pid" || true
  cat "$logs/guard-winner.err" >&2
  fail 'guarded launch did not retain its mutation gate through startup checks'
fi
guard_update_status=0
fmx update default >/dev/null 2>"$logs/update-during-guarded-launch.err" || guard_update_status=$?
guard_contender_status=0
fmx default --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-contender.err" || guard_contender_status=$?
: >"$guard_doctor_release"
for _ in $(seq 1 200); do
  [[ -f "$guard_launch_ready" ]] && break
  sleep 0.01
done
if [[ ! -f "$guard_launch_ready" ]]; then
  : >"$guard_launch_release"
  wait "$guard_pid" || true
  cat "$logs/guard-winner.err" >&2
  fail 'the matching guarded launch did not start its supervisor'
fi
guard_active_status=0
fmx default --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-active-contender.err" || guard_active_status=$?
guard_inventory_status=0
fmx inventory default --json >"$logs/guard-running.json" || guard_inventory_status=$?
: >"$guard_launch_release"
wait "$guard_pid" || { cat "$logs/guard-winner.err" >&2; fail 'guarded supervisor launch failed'; }
[[ "$guard_update_status" != 0 && "$guard_contender_status" != 0 && "$guard_active_status" != 0 ]] \
  || fail 'runtime replacement or a second start bypassed the guarded launch'
[[ "$guard_inventory_status" == 0 ]] || fail 'a concurrent loser could not inspect the owned fleet'
"${trellage_bun[@]}" "$fleet_contract" inventory <"$logs/guard-running.json" \
  || fail 'guarded startup produced invalid live-fleet evidence'
jq -e --argjson expected "$fleet_identity" '
  .fleet.identity == $expected and .fleet.runtime == "ready" and .fleet.supervisor.state == "running"
' "$logs/guard-running.json" >/dev/null || fail 'concurrent startup did not expose its matching owned identity'
[[ "$(grep -c '^launch|' "$NATIVE_CLAUDE_LAUNCH_LOG")" == 1 ]] \
  || fail 'concurrent guarded launches started more than one supervisor'
assert_not_contains '--fmx-expected-fleet-json' "$NATIVE_CLAUDE_LAUNCH_LOG"

# A completed session-open hook cannot initiate the first model turn. Recovery
# must also supply an operational first message, without copying the saved task.
fmx inventory default --json >"$logs/guard-exited.json" || fail 'could not inspect the exited supervisor'
jq -e '.fleet.supervisor.state == "stale"' "$logs/guard-exited.json" >/dev/null \
  || fail 'guarded recovery fixture has no stale supervisor'
fmx default --fmx-expected-fleet-json "$fleet_identity" \
  >/dev/null 2>"$logs/guard-recovery.err" \
  || { cat "$logs/guard-recovery.err" >&2; fail 'guarded recovery did not start a supervisor'; }
python3 - "$NATIVE_CLAUDE_ARGV_LOG" "$logs/request.json" \
  "$real_bash" "$fleet_profile/runtime/bin/fm-operational-input.sh" <<'PY'
import json, pathlib, subprocess, sys
calls = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
request = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert len(calls) == 2, "start and recovery must each invoke one supervisor"
assert calls[0] == calls[1], "recovery must use the same operational startup contract"
for arguments in calls:
    assert len(arguments) == 1 and arguments[0], "Claude needs exactly one initial operational message"
    message = arguments[0]
    result = subprocess.run([sys.argv[3], sys.argv[4], "kind"], input=message, text=True,
                            capture_output=True, check=True)
    assert result.stdout.strip() == "session-start", "startup is not a new captain request"
    body = subprocess.run([sys.argv[3], sys.argv[4], "body"], input=message, text=True,
                          capture_output=True, check=True).stdout
    assert "bin/fm-inbox.sh drain" in body, "the supervisor must read existing pending work"
    for value in (request["requestId"], request["originalIntent"], request["generatedSpec"]):
        assert value not in message, "saved task content must not be delivered again in launch arguments"
PY
[[ "$?" == 0 ]] || fail 'guarded startup did not supply an operational first message'
rm -rf -- "$fleet_profile/locks/session"

: >"$NATIVE_CLAUDE_LAUNCH_LOG"
fmx default --model claude-opus-5 "--fmx-expected-fleet-json=$fleet_identity" \
  >/dev/null 2>"$logs/guard-passthrough.err" \
  || { cat "$logs/guard-passthrough.err" >&2; fail 'guarded launch lost normal argument ordering'; }
assert_contains 'args=--model claude-opus-5' "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_not_contains '--fmx-expected-fleet-json' "$NATIVE_CLAUDE_LAUNCH_LOG"
python3 - "$NATIVE_CLAUDE_ARGV_LOG" <<'PY'
import json, pathlib, sys
calls = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
assert len(calls) == 3 and calls[-1] == ["--model", "claude-opus-5"]
PY
[[ "$?" == 0 ]] || fail 'guarded startup changed explicit Claude arguments'
unset NATIVE_CLAUDE_ARGV_LOG
rm -rf -- "$fleet_profile/locks/session"
printf 'fmx launch identity guard: passed\n'
