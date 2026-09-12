/**
 * Pure decision helpers for P05 wiring: which profile refs need a batch
 * doctor run kicked off, which refs need a Copilot diagnosis dispatched,
 * and which repair-capable refs need an automatic repair-then-recheck
 * attempt, given the current `AdminRunStatus` snapshot for each ref.
 * Contains no subprocess, Copilot, or Ink logic of its own — callers (an
 * Ink effect) only call these functions and update their own bookkeeping
 * `Set`s with the returned refs. Fully unit-testable without any Ink
 * rendering.
 */
import type { AdminRunStatus } from "./admin-run-manager.ts"

/**
 * Returns `true` exactly once per distinct, non-empty entry set: the batch
 * scheduler must be triggered the first time a given set of refs is seen,
 * and never again for the same set (guards against a re-render or a
 * spurious effect re-run starting a second overlapping batch).
 */
export const shouldStartBatch = (refs: ReadonlyArray<string>, alreadyStartedForRefs: ReadonlySet<string> | undefined): boolean => {
  if (refs.length === 0) return false
  if (alreadyStartedForRefs === undefined) return true
  if (alreadyStartedForRefs.size !== refs.length) return true
  return refs.some((ref) => !alreadyStartedForRefs.has(ref))
}

/**
 * Selects exactly the refs whose latest known status is a terminal failure
 * (`failure` or `timed-out`) and that are not already recorded in
 * `alreadyDiagnosedRefs`. Never returns refs in `success`/`cancelled`/
 * `running`/`idle` state, and never returns a ref more than once across
 * repeated calls with an unchanged snapshot plus an updated
 * `alreadyDiagnosedRefs` (the caller is expected to add every returned ref
 * to `alreadyDiagnosedRefs` before the next call). A recording gap for one
 * ref never affects whether any other ref is selected (per-ref isolation).
 */
export const selectPendingDiagnosisTargets = (
  statusesByRef: ReadonlyMap<string, AdminRunStatus>,
  alreadyDiagnosedRefs: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const targets: Array<string> = []
  for (const [ref, status] of statusesByRef) {
    if (status.state !== "failure" && status.state !== "timed-out") continue
    if (alreadyDiagnosedRefs.has(ref)) continue
    targets.push(ref)
  }
  return targets
}

/**
 * Selects exactly the repair-capable refs (present in `repairSupportedRefs`)
 * whose latest known doctor status is a terminal failure (`failure` or
 * `timed-out`) and that are not already recorded in
 * `alreadyAttemptedRefs`. Never returns a ref more than once across
 * repeated calls with an unchanged snapshot plus an updated
 * `alreadyAttemptedRefs` (the caller is expected to add every returned ref
 * to `alreadyAttemptedRefs` before the next call), and a ref outside
 * `repairSupportedRefs` (e.g. a sandbox profile, or a native launcher with
 * no repair subcommand) is never selected regardless of its doctor status.
 */
export const selectPendingRepairTargets = (
  statusesByRef: ReadonlyMap<string, AdminRunStatus>,
  repairSupportedRefs: ReadonlySet<string>,
  alreadyAttemptedRefs: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const targets: Array<string> = []
  for (const [ref, status] of statusesByRef) {
    if (status.state !== "failure" && status.state !== "timed-out") continue
    if (!repairSupportedRefs.has(ref)) continue
    if (alreadyAttemptedRefs.has(ref)) continue
    targets.push(ref)
  }
  return targets
}
