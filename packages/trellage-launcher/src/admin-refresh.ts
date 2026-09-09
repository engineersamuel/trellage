/**
 * Async, fail-closed readiness refresh: probes health/install for every
 * catalog entry whose launcher supports it (`entry.doctorSupported`,
 * skipping only a genuinely doctor-unsupported native launcher — currently
 * none) and merges results back into `AdminProfileEntry` rows. Each
 * profile's check is isolated — one profile's rejected/thrown check never
 * blocks or corrupts another profile's result (`Promise.allSettled`). This
 * is the "initial discovery" data flow; `admin-run-manager.ts` is the
 * separate, user-triggered doctor-run orchestration.
 */
import { toSelectedProfile } from "./admin-launch.js"
import { aggregateAdminProfiles, type AdminProfileEntry, type AdminReadinessInput } from "./admin-model.js"
import type { CombinedGuideCatalog } from "./guide-catalog.js"
import type { CommandRunner } from "./guide-launch.js"
import { checkSelectedProfileReadiness } from "./guide-preflight.js"

/**
 * Runs one readiness check per doctor-supporting entry, in parallel,
 * isolating failures per profile, and returns the refreshed entry list.
 * Never throws: an individual check's rejection becomes a `malformed`
 * readiness input for that profile only.
 */
export const refreshAdminEntries = async (
  runner: CommandRunner,
  catalog: CombinedGuideCatalog,
  cwd: string,
  now: () => number = () => Date.now(),
): Promise<ReadonlyArray<AdminProfileEntry>> => {
  const initial = aggregateAdminProfiles(catalog)
  const settled = await Promise.allSettled(
    initial
      .filter((entry) => entry.doctorSupported)
      .map(async (entry): Promise<AdminReadinessInput> => {
        const result = await checkSelectedProfileReadiness(runner, toSelectedProfile(entry), cwd)
        return { ref: entry.ref, result, checkedAt: now() }
      }),
  )
  const readinessInputs: ReadonlyArray<AdminReadinessInput> = settled.map((outcome, index) => {
    const entry = initial.filter((candidate) => candidate.doctorSupported)[index]!
    return outcome.status === "fulfilled"
      ? outcome.value
      : {
          ref: entry.ref,
          result: {
            malformed: true,
            diagnostic: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          },
          checkedAt: now(),
        }
  })
  return aggregateAdminProfiles(catalog, readinessInputs)
}
