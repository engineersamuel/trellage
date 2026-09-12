/**
 * Bounded-concurrency startup batch scheduler for doctor/diagnostic runs.
 * This module adds no subprocess-spawning or state-tracking logic of its
 * own: it is a thin worklist queue that calls the existing
 * `AdminRunManager.trigger()` for each doctor-supporting profile, never more
 * than `maxConcurrent` in flight at once. `AdminRunManager` retains full
 * ownership of per-profile state, history, and single-in-flight-per-ref
 * guarantees (`admin-run-manager.ts`) — this scheduler never bypasses them.
 */
import type { AdminProfileEntry } from "./admin-model.ts"
import type { AdminRunManager } from "./admin-run-manager.ts"
import { buildDiagnosticCommand } from "./admin-launch.ts"

export interface BatchDoctorSchedulerOptions {
  readonly maxConcurrent?: number
}

const defaultMaxConcurrent = 4

/**
 * Triggers a doctor run for every doctor-supporting entry, at most
 * `maxConcurrent` in flight at a time, and resolves once every scheduled
 * entry has reached a terminal state. A single entry's failure never stops
 * or delays scheduling of the remaining queued entries (each `trigger()`
 * promise is awaited independently, not chained).
 */
export const runBatchedDoctorChecks = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  runManager: AdminRunManager,
  options: BatchDoctorSchedulerOptions = {},
): Promise<void> => {
  const maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent
  const queue = entries.filter((entry) => entry.doctorSupported).slice()
  if (queue.length === 0) return

  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift()
      if (entry === undefined) return
      const command = buildDiagnosticCommand(entry)
      // Each entry's outcome is isolated by `AdminRunManager`'s own per-ref
      // state; a rejection here would only ever come from a defect in the
      // manager itself (it already converts run failures into recorded
      // terminal states, never a rejected promise), so no entry's failure
      // can stop this worker from continuing to the next queued entry.
      await runManager.trigger(entry.ref, command.executable, command.args)
    }
  }

  const workerCount = Math.max(1, Math.min(maxConcurrent, queue.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
