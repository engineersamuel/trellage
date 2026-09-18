#!/usr/bin/env bash
# Sourced by fleet-contract.sh after its original request has been handled.

# A lookup error is not a rejection of the submitted payload.
jq '.expectedFleet = null' "$logs/lookup.json" >"$logs/invalid-lookup.json"
uncertain_status=0
fmx receipt default --json <"$logs/invalid-lookup.json" >"$logs/invalid-lookup-result.json" \
  2>"$logs/invalid-lookup.err" || uncertain_status=$?
[[ "$uncertain_status" != 0 && ! -s "$logs/invalid-lookup-result.json" ]] \
  || fail 'an invalid lookup produced a rejection of an accepted request'

# Unsafe source prevents reconciliation; it cannot prove that a request is absent.
uncertain_runtime="$fleet_profile/runtime/bin/fm-spawn.sh"
cp "$uncertain_runtime" "$logs/uncertain-runtime.saved"
printf '\n# simulated source drift\n' >>"$uncertain_runtime"
uncertain_status=0
fmx receipt default --json <"$logs/lookup.json" >"$logs/drift-lookup.json" \
  2>"$logs/drift-lookup.err" || uncertain_status=$?
cp "$logs/uncertain-runtime.saved" "$uncertain_runtime"
[[ "$uncertain_status" != 0 && ! -s "$logs/drift-lookup.json" ]] \
  || fail 'unverified source produced an authoritative request outcome'
fmx receipt default --json <"$logs/lookup.json" >"$logs/reconciled-handled.json" \
  || fail 'an accepted request was lost after an uncertain lookup'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/request.json" <"$logs/reconciled-handled.json" \
  || fail 'lookup uncertainty changed the prior handled receipt'
jq -e '.state == "handled"' "$logs/reconciled-handled.json" >/dev/null \
  || fail 'lookup uncertainty erased the handled state'

# Conflicts reject only the new payload, including after the original was handled.
uncertain_status=0
fmx submit default --json <"$logs/conflict-request.json" >"$logs/handled-conflict.json" || uncertain_status=$?
[[ "$uncertain_status" != 0 ]] || fail 'handled request content was replaced'
fmx receipt default --json <"$logs/lookup.json" >"$logs/handled-after-conflict.json" \
  || fail 'a conflict erased the handled request'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/request.json" <"$logs/handled-after-conflict.json" \
  || fail 'a conflicting payload changed the original handled digest'

# A successful external exit without a confirmed note is still an unknown outcome.
jq '.requestId = "fe2a1cf6-4f6b-4f5c-b02c-f3e1c21997af"' "$logs/request.json" >"$logs/unconfirmed-request.json"
uncertain_status=0
NATIVE_CLAUDE_INBOX_RESULT=unconfirmed fmx submit default --json \
  <"$logs/unconfirmed-request.json" >"$logs/unconfirmed-result.json" \
  2>"$logs/unconfirmed.err" || uncertain_status=$?
[[ "$uncertain_status" != 0 && ! -s "$logs/unconfirmed-result.json" ]] \
  || fail 'an unconfirmed submit returned not-found or rejected'
jq '{schemaVersion, requestId, expectedFleet}' "$logs/unconfirmed-request.json" >"$logs/unconfirmed-lookup.json"
fmx receipt default --json <"$logs/unconfirmed-lookup.json" >"$logs/reconciled-not-found.json" \
  || fail 'a completed lookup could not reconcile an unconfirmed request'
"${trellage_bun[@]}" "$fleet_contract" receipt <"$logs/reconciled-not-found.json" \
  || fail 'gated not-found reconciliation violates the receipt contract'
jq -e '.state == "not-found"' "$logs/reconciled-not-found.json" >/dev/null \
  || fail 'unconfirmed request absence was not checked under the gate'
fmx submit default --json <"$logs/unconfirmed-request.json" >"$logs/confirmed-retry.json" \
  || fail 'an unconfirmed request could not retry its original ID'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/unconfirmed-request.json" <"$logs/confirmed-retry.json" \
  || fail 'the original request ID did not preserve its payload on retry'

# Lost producer acknowledgement must reconcile the actual canonical note.
jq '.requestId = "ae530f68-e52f-4c01-8a82-40f5111c2150"' "$logs/request.json" >"$logs/lost-ack-request.json"
uncertain_status=0
NATIVE_CLAUDE_INBOX_RESULT=lost-ack fmx submit default --json \
  <"$logs/lost-ack-request.json" >"$logs/lost-ack-result.json" || uncertain_status=$?
[[ "$uncertain_status" != 0 ]] || fail 'the lost producer acknowledgement was hidden'
"${trellage_bun[@]}" "$fleet_contract" receipt "$logs/lost-ack-request.json" <"$logs/lost-ack-result.json" \
  || fail 'lost acknowledgement discarded confirmed saved evidence'
jq -e '.state == "saved" and .error.code == "save-incomplete"' "$logs/lost-ack-result.json" >/dev/null \
  || fail 'lost acknowledgement was misreported as rejection'
uncertain_wakes="$(shasum -a 256 "$fleet_home/state/.wake-queue")"
fmx submit default --json <"$logs/lost-ack-request.json" >"$logs/lost-ack-retry.json" \
  || fail 'the original request ID could not retry a lost acknowledgement'
[[ "$uncertain_wakes" == "$(shasum -a 256 "$fleet_home/state/.wake-queue")" ]] \
  || fail 'retrying an acknowledged note queued another wake'
[[ "$(find "$fleet_home/state/inbox" -name 'ae530f68-e52f-4c01-8a82-40f5111c2150.note' | wc -l | tr -d ' ')" == 1 ]] \
  || fail 'retrying a lost acknowledgement duplicated its note'
printf 'fmx uncertain receipt contract: passed\n'
