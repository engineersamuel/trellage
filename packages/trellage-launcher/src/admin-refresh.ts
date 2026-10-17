/**
 * Async, fail-closed readiness refresh: probes health/install for every
 * catalog entry whose launcher supports it (`entry.doctorSupported`,
 * skipping only a genuinely doctor-unsupported native launcher — currently
 * none) and merges results back into `AdminProfileEntry` rows. Each
 * profile's check is isolated — one profile's rejected/thrown check never
 * blocks or corrupts another profile's result. Bounded workers prevent
 * starting all inventory processes at once. This
 * is the "initial discovery" data flow; `admin-run-manager.ts` is the
 * separate, user-triggered doctor-run orchestration.
 */
import { toSelectedProfile } from "./admin-launch.ts"
import {
  aggregateAdminProfiles,
  mergeAdminReadiness,
  type AdminProfileEntry,
  type AdminReadinessInput,
} from "./admin-model.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { checkSelectedProfileReadiness } from "./guide-preflight.ts"

const refreshReadinessInputs = async (
  runner: CommandRunner,
  entries: ReadonlyArray<AdminProfileEntry>,
  cwd: string,
  now: () => number,
  signal: AbortSignal | undefined,
): Promise<ReadonlyArray<AdminReadinessInput>> => {
  const queue = entries.filter((entry) => entry.doctorSupported)
  const inputs: Array<AdminReadinessInput> = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift()
      if (entry === undefined) return
      try {
        signal?.throwIfAborted()
        const result = await checkSelectedProfileReadiness(runner, toSelectedProfile(entry), cwd, signal)
        inputs.push({ ref: entry.ref, result, checkedAt: now() })
      } catch (error) {
        inputs.push({
          ref: entry.ref,
          result: { malformed: true, diagnostic: error instanceof Error ? error.message : String(error) },
          checkedAt: now(),
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
  return inputs
}

/**
 * Runs one readiness check per doctor-supporting entry, with bounded concurrency,
 * isolating failures per profile, and returns the refreshed entry list.
 * Individual probe failures stay visible on their own rows.
 * Cancellation and unexpected catalog failures are not converted into partial success.
 */
export interface AdminRefreshOptions {
  readonly signal?: AbortSignal
}

export const refreshAdminEntries = async (
  runner: CommandRunner,
  catalog: CombinedGuideCatalog,
  cwd: string,
  now: () => number = () => Date.now(),
  options: AdminRefreshOptions = {},
): Promise<ReadonlyArray<AdminProfileEntry>> => {
  const initial = aggregateAdminProfiles(catalog)
  const readinessInputs = await refreshReadinessInputs(runner, initial, cwd, now, options.signal)
  options.signal?.throwIfAborted()
  return mergeAdminReadiness(catalog, initial, readinessInputs)
}
