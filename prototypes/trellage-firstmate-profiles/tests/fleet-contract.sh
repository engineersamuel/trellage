#!/usr/bin/env bash
# Sourced by contract.sh after its owned fake installation is ready.

. "$repo_root/scripts/bun-runtime.sh"
trellage_bun_runtime "$repo_root"

fleet_contract="$repo_root/tests/helpers/firstmate_control_contract.ts"
fleet_profile="$profiles_root/default"
fleet_home="$fleet_profile/home"
rm -rf -- "$fleet_profile/locks/session"
fmx inventory default --json >"$logs/fleet-ready.json" || fail 'fleet inventory failed'
"${trellage_bun[@]}" "$fleet_contract" inventory <"$logs/fleet-ready.json" \
  || fail 'native fleet readiness differs from the shared contract'
jq -e '
  .fleet.runtime == "ready" and .fleet.supervisor.state == "stopped"
  and .fleet.actions.start.allowed and .fleet.actions.submit.allowed
  and (.fleet.consentRequired | not)
' "$logs/fleet-ready.json" >/dev/null || fail 'an idle configured fleet is not ready'
fleet_identity="$(jq -c '.fleet.identity' "$logs/fleet-ready.json")"
instance_before="$(cat "$fleet_profile/receipts/instance.json")"
NATIVE_CLAUDE_SKILLS_STATUS=1 fmx inventory default --json >"$logs/fleet-missing-skills.json" \
  || fail 'missing cached skills caused an inventory failure'
jq -e '
  .readiness == "unhealthy" and .fleet.runtime == "ready" and .fleet.actions.submit.allowed
  and (.fleet.actions.start.allowed | not) and (.fleet.actions.recover.allowed | not)
' "$logs/fleet-missing-skills.json" >/dev/null || fail 'missing cached skills admitted a supervisor'
python3 - "$fleet_profile/receipts/instance.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text())
value["prerequisitesConsent"] = False
path.write_text(json.dumps(value))
PY
fmx inventory default --json >"$logs/fleet-needs-consent.json" || fail 'consent inventory failed'
jq -e '.fleet.consentRequired and .fleet.actions.submit.allowed and (.fleet.actions.start.allowed | not)' \
  "$logs/fleet-needs-consent.json" >/dev/null || fail 'inventory ignored prior consent'
status=0
fmx default >/dev/null 2>"$logs/launch-needs-consent.err" || status=$?
[[ "$status" != 0 ]] || fail 'launch ignored missing prior consent'
fmx repair default >/dev/null 2>&1 || fail 'explicit idle repair could not record consent'
[[ "$instance_before" == "$(cat "$fleet_profile/receipts/instance.json")" ]] \
  || fail 'explicit consent renewal changed the fleet identity'
request_id='b6a3d4cc-7b09-4a7b-9bd8-60ec9a7025e5'
jq -n --argjson fleet "$fleet_identity" --arg id "$request_id" '
  {
    schemaVersion: 1, requestId: $id, expectedFleet: $fleet,
    originalIntent: "\n  Keep my exact words: café 🧭.\r\nDo not merge this with the specification.\n",
    generatedSpec: "A separate specification.\n\tPreserve both fields.",
    workflowId: "firstmate-fleet", projectTarget: null
  }
' >"$logs/request.json"
fmx submit default --json <"$logs/request.json" >"$logs/saved.json" \
  || { cat "$logs/saved.json" >&2; fail 'saving before start failed'; }
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/request.json" <"$logs/saved.json" \
  || fail 'native and guide canonical request digests differ'
assert_contains "root=$fleet_profile/runtime|home=$fleet_home|gh=$gh_config" "$logs/inbox-provider-boundary.log"
status=0
env -i HOME="$home" PATH="$fake_bin" GH_CONFIG_DIR="$gh_config" \
  TRELLAGE_CLAUDE_LAUNCHER_NAME=fmx TRELLAGE_CLAUDE_RUNTIME_ROOT="$install_root" \
  "$repo_root/prototypes/trellage-claude-common/native-claude" exec-clean \
  --interpreter "$real_bash" -- "$fleet_profile/runtime/bin/fm-inbox.sh" \
  receipt --request-id "$request_id" --json \
  >"$logs/inbox-outside-root.out" 2>"$logs/inbox-outside-root.err" || status=$?
[[ "$status" != 0 && ! -s "$logs/inbox-outside-root.out" ]] \
  || fail 'the real shared helper accepted an inbox command outside its execution root'
assert_contains 'outside the runtime root' "$logs/inbox-outside-root.err"
jq -e '.state == "saved" and .announcement == "sent" and .supervisorState == "stopped"' \
  "$logs/saved.json" >/dev/null || fail 'save-before-start did not retain durable evidence'
assert_contains "inbox:$request_id" "$fleet_home/state/.wake-queue"
python3 - "$logs/request.json" "$fleet_home/state/inbox/$request_id.note" <<'PY'
import json, pathlib, sys
request = json.loads(pathlib.Path(sys.argv[1]).read_text())
body = pathlib.Path(sys.argv[2]).read_bytes().partition(b"\n--\n")[2][:-1]
assert body == json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
assert json.loads(body)["originalIntent"] == request["originalIntent"]
assert json.loads(body)["generatedSpec"] == request["generatedSpec"]
PY
note_before="$(shasum -a 256 "$fleet_home/state/inbox/$request_id.note")"
wakes_before="$(shasum -a 256 "$fleet_home/state/.wake-queue")"
. "$root/tests/launch-guard-contract.sh"
[[ "$note_before" == "$(shasum -a 256 "$fleet_home/state/inbox/$request_id.note")" \
  && "$wakes_before" == "$(shasum -a 256 "$fleet_home/state/.wake-queue")" ]] \
  || fail 'guarded startup changed or requeued the saved required input'
fmx submit --json default <"$logs/request.json" >"$logs/replayed.json" \
  || fail 'an identical submission replay failed'
[[ "$note_before" == "$(shasum -a 256 "$fleet_home/state/inbox/$request_id.note")" \
  && "$wakes_before" == "$(shasum -a 256 "$fleet_home/state/.wake-queue")" ]] \
  || fail 'an identical replay replaced the note or sent another wake'
jq '{schemaVersion, requestId, expectedFleet}' "$logs/request.json" >"$logs/lookup.json"
fmx receipt --json default <"$logs/lookup.json" >"$logs/lookup-result.json" \
  || fail 'saved receipt lookup failed'
home="$home/." fmx receipt default --json <"$logs/lookup.json" >"$logs/canonical-home-receipt.json" \
  || fail 'the native API did not use the canonical HOME boundary'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/request.json" <"$logs/lookup-result.json" \
  || fail 'receipt lookup violates the shared contract'
[[ "$wakes_before" == "$(shasum -a 256 "$fleet_home/state/.wake-queue")" ]] \
  || fail 'a receipt lookup sent a wake'
jq '.originalIntent = "different"' "$logs/request.json" >"$logs/conflict-request.json"
status=0
fmx submit default --json <"$logs/conflict-request.json" >"$logs/conflict.json" || status=$?
[[ "$status" != 0 ]] || fail 'conflicting request content was accepted'
jq -e '.state == "rejected" and .error.code == "request-conflict" and .noteId == null' \
  "$logs/conflict.json" >/dev/null || fail 'request conflict did not fail closed'
python3 - "$logs/conflict-request.json" "$logs/conflict.json" "$logs/saved.json" <<'PY'
import hashlib, json, pathlib, sys
attempt, rejected, accepted = [json.loads(pathlib.Path(path).read_text()) for path in sys.argv[1:]]
digest = hashlib.sha256(json.dumps(attempt, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()
assert rejected["digest"] == digest
assert rejected["digest"] != accepted["digest"]
PY
[[ "$note_before" == "$(shasum -a 256 "$fleet_home/state/inbox/$request_id.note")" ]] \
  || fail 'a conflicting request replaced the saved note'
fmx receipt default --json <"$logs/lookup.json" >"$logs/after-conflict.json" \
  || fail 'a conflict erased the prior accepted request'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/request.json" <"$logs/after-conflict.json" \
  || fail 'conflict reconciliation lost the original accepted identity or digest'

for project_name in MyProject my_project my.project _local; do
  jq --arg name "$project_name" --arg id "$(python3 -c 'import uuid; print(uuid.uuid4())')" '
    .requestId = $id
    | .projectTarget = {
      schemaVersion: 1, projectName: $name, source: null,
      entryWorktree: null, baseRevision: null, dirty: null, dirtyChanges: "excluded"
    }
  ' "$logs/request.json" >"$logs/named-project-request.json"
  fmx submit default --json <"$logs/named-project-request.json" >"$logs/named-project-saved.json" \
    || fail "registered project spelling was refused: $project_name"
  "${trellage_bun[@]}" "$fleet_contract" receipt "$logs/named-project-request.json" <"$logs/named-project-saved.json" \
    || fail "registered project spelling changed across native submission: $project_name"
done

# Short submissions and runtime replacement share the profile mutation lock.
submit_ready="$fixture_root/submit-ready"
submit_release="$fixture_root/submit-release"
jq --arg commit "$pinned_commit" '
  .requestId = "715707a8-ff1c-48a4-aa9a-d5efebef5e9e"
  | .projectTarget = {
    schemaVersion: 1, projectName: "firstmate",
    source: {kind: "git", location: "https://github.com/kunchenguid/firstmate.git"},
    entryWorktree: null, baseRevision: $commit, dirty: null, dirtyChanges: "excluded"
  }
' "$logs/request.json" >"$logs/locked-request.json"
jq '{schemaVersion, requestId, expectedFleet}' "$logs/locked-request.json" >"$logs/locked-lookup.json"
(
  NATIVE_CLAUDE_DOCTOR_READY="$submit_ready" NATIVE_CLAUDE_DOCTOR_RELEASE="$submit_release" \
    fmx submit default --json <"$logs/locked-request.json" >"$logs/locked-saved.json"
) &
submit_pid=$!
for _ in $(seq 1 200); do
  [[ -e "$submit_ready" ]] && break
  sleep 0.01
done
if [[ ! -e "$submit_ready" ]]; then
  : >"$submit_release"
  wait "$submit_pid" || true
  fail 'submission did not hold its short mutation lock'
fi
replacement_status=0
fmx update default >/dev/null 2>"$logs/update-during-submit.err" || replacement_status=$?
concurrent_status=0
fmx submit default --json <"$logs/locked-request.json" >"$logs/concurrent-submit.json" \
  2>"$logs/concurrent-submit.err" || concurrent_status=$?
concurrent_lookup_status=0
fmx receipt default --json <"$logs/locked-lookup.json" >"$logs/concurrent-lookup.json" \
  2>"$logs/concurrent-lookup.err" || concurrent_lookup_status=$?
: >"$submit_release"
wait "$submit_pid" || fail 'the serialized submission failed'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/locked-request.json" <"$logs/locked-saved.json" \
  || fail 'confirmed project metadata changed at the native boundary'
[[ "$replacement_status" != 0 && "$concurrent_status" != 0 && "$concurrent_lookup_status" != 0 ]] \
  || fail 'a concurrent mutation bypassed the submit lock'
[[ ! -s "$logs/concurrent-submit.json" && ! -s "$logs/concurrent-lookup.json" ]] \
  || fail 'mutation contention returned an authoritative request outcome'
assert_contains 'outcome unknown' "$logs/concurrent-submit.err"
assert_contains 'outcome unknown' "$logs/concurrent-lookup.err"
fmx receipt default --json <"$logs/locked-lookup.json" >"$logs/after-contention.json" \
  || fail 'an uncertain request could not reconcile under the mutation gate'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/locked-request.json" <"$logs/after-contention.json" \
  || fail 'contention reconciliation lost the saved request'
fmx submit default --json <"$logs/locked-request.json" >"$logs/locked-replay.json" \
  || fail 'a contended request could not safely retry'
[[ "$(find "$fleet_home/state/inbox" -name '715707a8-ff1c-48a4-aa9a-d5efebef5e9e.note' | wc -l | tr -d ' ')" == 1 ]] \
  || fail 'concurrent native submissions duplicated the note'
wakes_before="$(shasum -a 256 "$fleet_home/state/.wake-queue")"

inbox_command=("$fleet_profile/runtime/bin/fm-inbox.sh")
env -i HOME="$home" PATH="$fake_bin" TMPDIR="$TMPDIR" \
  FM_HOME="$fleet_home" "${inbox_command[@]}" drain --ack "$request_id" >/dev/null \
  || fail 'the canonical producer did not acknowledge its note'
fmx receipt default --json <"$logs/lookup.json" >"$logs/handled.json" \
  || fail 'handled receipt lookup failed'
jq -e '.state == "handled" and .announcement == "not-needed"' "$logs/handled.json" >/dev/null \
  || fail 'receipt lookup did not reconcile drain acknowledgement'
fmx submit default --json <"$logs/request.json" >"$logs/handled-replay.json" \
  || fail 'handled request replay failed'
[[ ! -e "$fleet_home/state/inbox/$request_id.note" ]] \
  || fail 'a handled request was queued again'

jq '.requestId = "ab17f5c6-d349-480d-a5ef-681c45ec9a13"' "$logs/lookup.json" >"$logs/missing-lookup.json"
fmx receipt default --json <"$logs/missing-lookup.json" >"$logs/not-found.json" \
  || fail 'missing receipt lookup failed'
jq -e '.state == "not-found" and .noteId == null and .digest == null' "$logs/not-found.json" >/dev/null \
  || fail 'a missing receipt was not reported accurately'
[[ "$wakes_before" == "$(shasum -a 256 "$fleet_home/state/.wake-queue")" ]] \
  || fail 'status or handled replay queued work'

. "$root/tests/receipt-uncertainty-contract.sh"

# A wake failure must retain the note and return the saved receipt, not a false rejection.
mv "$fleet_home/state/.wake-queue" "$logs/wakes.saved"
mkdir "$fleet_home/state/.wake-queue"
jq '.requestId = "86436c1a-c694-469e-9295-247c706a907f"' "$logs/request.json" >"$logs/wake-request.json"
status=0
fmx submit default --json <"$logs/wake-request.json" >"$logs/wake-failed.json" || status=$?
[[ "$status" != 0 ]] || fail 'wake failure was hidden'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/wake-request.json" <"$logs/wake-failed.json" \
  || fail 'wake failure lost structured saved evidence'
jq -e '.state == "saved" and .announcement == "failed" and .error.code == "wake-failed"' \
  "$logs/wake-failed.json" >/dev/null || fail 'wake failure was reported as no save'
rmdir "$fleet_home/state/.wake-queue"
mv "$logs/wakes.saved" "$fleet_home/state/.wake-queue"
fmx submit default --json <"$logs/wake-request.json" >"$logs/wake-retry.json" \
  || fail 'the saved note could not retry its failed wake'
jq -e '.state == "saved" and .announcement == "sent"' "$logs/wake-retry.json" >/dev/null \
  || fail 'retry did not reconcile the saved note'

python3 - "$logs/request.json" "$logs" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[2])
request = json.loads(pathlib.Path(sys.argv[1]).read_text())
request["requestId"] = "4b001099-4eca-49cc-9fbf-008181a084e7"
for name, intent, spec in (
    ("maximum", "🧭" * 30000, "s" * 8000),
    ("intent-overflow", "🧭" * 30000 + "x", "spec"),
    ("spec-overflow", "intent", "s" * 8001),
    ("surrogate", "\ud800", "spec"),
    ("bom-blank", "\ufeff \t", "spec"),
):
    request["originalIntent"], request["generatedSpec"] = intent, spec
    (root / (name + ".json")).write_text(json.dumps(request, ensure_ascii=True))
(root / "oversized.json").write_bytes(b" " * 524289)
request["originalIntent"], request["generatedSpec"] = "intent", "spec"
request["expectedFleet"]["instanceId"] = "631c7713-bbc2-4734-af59-8769c80117e3"
(root / "changed-fleet.json").write_text(json.dumps(request))
request = json.loads((root / "locked-request.json").read_text())
request["projectTarget"]["baseRevision"] = 10 ** 39
(root / "numeric-revision.json").write_text(json.dumps(request))
PY
fmx submit default --json <"$logs/maximum.json" >"$logs/maximum-receipt.json" \
  || fail 'the supported UTF-16 text limits were rejected'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/maximum.json" <"$logs/maximum-receipt.json" \
  || fail 'maximum-size Unicode canonicalization differs from the guide'
for invalid in intent-overflow spec-overflow surrogate bom-blank oversized numeric-revision; do
  status=0
  fmx submit default --json <"$logs/$invalid.json" >"$logs/$invalid-result.json" || status=$?
  [[ "$status" != 0 ]] || fail "$invalid request was accepted"
  jq -e '.state == "rejected" and .noteId == null and .error != null' \
    "$logs/$invalid-result.json" >/dev/null || fail "$invalid has no structured rejection"
done
status=0
fmx submit default --json <"$logs/changed-fleet.json" >"$logs/changed-fleet-result.json" \
  2>"$logs/changed-fleet.err" || status=$?
[[ "$status" != 0 && ! -s "$logs/changed-fleet-result.json" ]] \
  || fail 'a changed fleet returned an authoritative result for an earlier request'

# An active fleet is inspectable. Saving does not start a second supervisor.
mkdir -p "$fleet_profile/locks/session"
printf '%s\n' "$ownership_value" >"$fleet_profile/locks/session/owner"
printf 'tmux\n' >"$fleet_profile/locks/session/backend"
printf '%s\n' "$$" >"$fleet_profile/locks/session/pid"
printf '%s\n' "$$" >"$fleet_home/state/.lock"
fmx inventory default --json >"$logs/fleet-running.json" || fail 'active fleet inventory failed'
"${trellage_bun[@]}" "$fleet_contract" inventory <"$logs/fleet-running.json" \
  || fail 'active readiness violates the shared contract'
jq -e '
  .readiness == "busy" and .fleet.runtime == "ready"
  and .fleet.supervisor.state == "running" and .fleet.actions.submit.allowed
  and (.fleet.actions.start.allowed | not) and (.fleet.actions.recover.allowed | not)
' "$logs/fleet-running.json" >/dev/null || fail 'healthy active runtime was hidden behind busy'
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
fmx submit default --json <"$logs/wake-request.json" >"$logs/active-save.json" \
  || fail 'an existing fleet could not receive a request'
[[ ! -s "$NATIVE_CLAUDE_LAUNCH_LOG" ]] || fail 'submission started a supervisor'

# Recover only an owned dead supervisor, on unchanged source, with live workers intact.
sleep 300 &
busy_pid=$!
recovery_worker="$fleet_profile/workers/fmd-recovery"
mkdir -p "$recovery_worker" "$fixture_root/recovery-worktree"
printf '%s\n' "$ownership_value" >"$recovery_worker/.managed-by-trellage-firstmate-profiles"
printf '%s\n' "$busy_pid" >"$recovery_worker/.active"
printf 'keep worker worktree\n' >"$fixture_root/recovery-worktree/sentinel"
printf '999999\n' >"$fleet_profile/locks/session/pid"
printf '999999\n' >"$fleet_home/state/.lock"
fmx inventory default --json >"$logs/fleet-recoverable.json" || fail 'recovery inventory failed'
jq -e '.fleet.supervisor.state == "stale" and .fleet.activeWorkers == 1 and .fleet.actions.recover.allowed' \
  "$logs/fleet-recoverable.json" >/dev/null || fail 'an owned stale supervisor cannot recover'
for command_name in setup update repair; do
  status=0
  fmx "$command_name" default >/dev/null 2>"$logs/$command_name-live-worker.err" || status=$?
  [[ "$status" != 0 ]] || fail "$command_name changed runtime under a live worker"
done
mkdir "$fleet_profile/runtime.previous"
status=0
fmx default >/dev/null 2>"$logs/recovery-interrupted.err" || status=$?
[[ "$status" != 0 && -d "$fleet_profile/runtime.previous" ]] \
  || fail 'live-worker recovery restored an interrupted publication'
rmdir "$fleet_profile/runtime.previous"

# A second live lock, an incomplete lock, and an unowned lock must not be adopted.
for unsafe in second-live incomplete unowned; do
  printf '%s\n' "$ownership_value" >"$fleet_profile/locks/session/owner"
  printf 'tmux\n' >"$fleet_profile/locks/session/backend"
  printf '999999\n' >"$fleet_profile/locks/session/pid"
  printf '999999\n' >"$fleet_home/state/.lock"
  case "$unsafe" in
    second-live)
      printf '%s\n' "$$" >"$fleet_profile/locks/session/pid"
      printf '%s\n' "$busy_pid" >"$fleet_home/state/.lock" ;;
    incomplete) rm "$fleet_profile/locks/session/backend" ;;
    unowned) printf 'other-owner\n' >"$fleet_profile/locks/session/owner" ;;
  esac
  status=0
  fmx default >/dev/null 2>"$logs/recovery-$unsafe.err" || status=$?
  [[ "$status" != 0 ]] || fail "recovery adopted a $unsafe supervisor lock"
done
printf '%s\n' "$ownership_value" >"$fleet_profile/locks/session/owner"
printf 'tmux\n' >"$fleet_profile/locks/session/backend"
printf '999999\n' >"$fleet_profile/locks/session/pid"
printf '999999\n' >"$fleet_home/state/.lock"
source_before="$(shasum -a 256 "$fleet_profile/receipts/source.json")"
wakes_before="$(shasum -a 256 "$fleet_home/state/.wake-queue")"
: >"$NATIVE_CLAUDE_LOG"
: >"$NATIVE_CLAUDE_LAUNCH_LOG"
: >"$FAKE_GIT_LOG"
fmx default --fmx-expected-fleet-json "$fleet_identity" >/dev/null 2>"$logs/recovered.err" \
  || { cat "$logs/recovered.err" >&2; fail 'live-worker supervisor recovery failed'; }
kill -0 "$busy_pid" || fail 'recovery terminated a live worker'
[[ "$source_before" == "$(shasum -a 256 "$fleet_profile/receipts/source.json")" \
  && "$wakes_before" == "$(shasum -a 256 "$fleet_home/state/.wake-queue")" \
  && -f "$fleet_home/state/inbox/handled/$request_id.note" \
  && -f "$fixture_root/recovery-worktree/sentinel" ]] \
  || fail 'supervisor recovery changed durable worker or inbox state'
assert_not_contains 'prepare|' "$NATIVE_CLAUDE_LOG"
assert_not_contains 'fetch ' "$FAKE_GIT_LOG"
assert_not_contains 'checkout ' "$FAKE_GIT_LOG"
[[ "$(grep -c '^launch|' "$NATIVE_CLAUDE_LAUNCH_LOG")" == 1 ]] \
  || fail 'recovery did not start exactly one supervisor'
assert_contains "cwd=$fleet_profile/runtime" "$NATIVE_CLAUDE_LAUNCH_LOG"
assert_not_contains '--fmx-expected-fleet-json' "$NATIVE_CLAUDE_LAUNCH_LOG"
kill -TERM "$busy_pid"
wait "$busy_pid" 2>/dev/null || true
busy_pid=''
rm -rf -- "$recovery_worker" "$fleet_profile/locks/session"
rm "$fleet_home/state/.lock"
[[ "$instance_before" == "$(cat "$fleet_profile/receipts/instance.json")" ]] \
  || fail 'read, submit, or recovery changed the persistent fleet instance'

dispatch_file="$fleet_home/config/crew-dispatch.json"
printf '%s\n' '{"rules":[{"when":"The change is small","use":{"harness":"claude","model":"sonnet","effort":"low"}}],"default":{"harness":"claude","model":"opus","effort":"high"}}' \
  >"$dispatch_file"
dispatch_before="$(cat "$dispatch_file")"
fmx repair default >/dev/null 2>"$logs/repair-valid-rules.err" \
  || { cat "$logs/repair-valid-rules.err" >&2; fail 'repair rejected valid Claude rules'; }
[[ "$dispatch_before" == "$(cat "$dispatch_file")" ]] || fail 'repair replaced valid worker rules'
rm "$dispatch_file"
fmx repair default >/dev/null 2>&1 || fail 'repair with absent dispatch rules failed'
[[ ! -e "$dispatch_file" ]] || fail 'repair created unwanted dispatch overrides'

python3 "$root/tests/pinned-contract.py" "$fixture_root" "$root" "$install_root" \
  "$profiles_root" "$fake_bin" "$real_git" "$real_bash" "$home" "$gh_config" \
  || fail 'real pinned Firstmate entry-point contracts failed'
printf 'fmx fleet contract: passed\n'
