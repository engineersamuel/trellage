/** Bounded startup refresh for lifecycle-backed rows; other compositions load inventory only when selected. */
import { toSelectedProfile } from "./admin-launch.ts"
import {
  aggregateAdminProfiles,
  mergeAdminReadiness,
  type AdminProfileEntry,
  type AdminReadinessInput,
} from "./admin-model.ts"
import type { CompositionCatalog } from "./composition-catalog.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { checkSelectedProfileReadiness } from "./guide-preflight.ts"

const refreshReadinessInputs = async (
  runner: CommandRunner,
  entries: ReadonlyArray<AdminProfileEntry>,
  cwd: string,
  now: () => number,
  signal: AbortSignal | undefined,
): Promise<ReadonlyArray<AdminReadinessInput>> => {
  const queue = entries.filter((entry) => entry.lifecycle !== null)
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

/** Runs one inventory v2 check per lifecycle-backed row; config and external rows stay lazy. */
export interface AdminRefreshOptions {
  readonly signal?: AbortSignal
}

export const refreshAdminEntries = async (
  runner: CommandRunner,
  catalog: CompositionCatalog,
  cwd: string,
  now: () => number = () => Date.now(),
  options: AdminRefreshOptions = {},
): Promise<ReadonlyArray<AdminProfileEntry>> => {
  const initial = aggregateAdminProfiles(catalog)
  const readinessInputs = await refreshReadinessInputs(runner, initial, cwd, now, options.signal)
  options.signal?.throwIfAborted()
  return mergeAdminReadiness(catalog, initial, readinessInputs)
}
