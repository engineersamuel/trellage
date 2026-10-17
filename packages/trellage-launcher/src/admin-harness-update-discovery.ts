import type { AdminProfileEntry } from "./admin-model.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { AdminRunManager } from "./admin-run-manager.ts"
import {
  harnessVersionOperationKeyFor,
  reconcileHarnessVersionObservations,
  type AdminHarnessVersionResult,
} from "./admin-harness-version.ts"
import { runBatchedHarnessVersionChecks, type HarnessVersionSchedulerOptions } from "./admin-harness-version-scheduler.ts"

const scopeKeyFor = (entry: AdminProfileEntry): string | undefined => {
  const operation = harnessVersionOperationKeyFor(entry)
  return operation === undefined ? undefined : JSON.stringify([entry.commandPath, operation])
}

const emptyCache = { schemaVersion: 2 as const, entries: {} }

const publishResults = (
  entries: ReadonlyArray<AdminProfileEntry>,
  results: ReadonlyMap<string, AdminHarnessVersionResult>,
  onResult: HarnessVersionSchedulerOptions["onResult"],
): void => {
  for (const entry of entries) {
    const key = harnessVersionOperationKeyFor(entry)
    const result = results.get(entry.ref)
    const paths = new Set(
      entries.filter((candidate) => harnessVersionOperationKeyFor(candidate) === key).map((candidate) => candidate.commandPath),
    )
    if (key !== undefined && result !== undefined && paths.size === 1) onResult?.(key, { result, checkedAt: Date.now() }, entry)
  }
}

const readMissingScopes = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  raw: ReadonlyMap<string, AdminHarnessVersionResult>,
  manager: AdminRunManager,
  signal: AbortSignal,
  onResult: NonNullable<HarnessVersionSchedulerOptions["onResult"]>,
): Promise<void> => {
  for (const entry of entries) {
    const key = scopeKeyFor(entry)
    if (key === undefined || raw.has(key)) continue
    signal.throwIfAborted()
    await runBatchedHarnessVersionChecks([entry], manager, emptyCache, { forceResync: true, onResult })
  }
}

export const checkAdminHarnessUpdates = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal,
  onResult?: HarnessVersionSchedulerOptions["onResult"],
): Promise<ReadonlyMap<string, AdminHarnessVersionResult>> => {
  const manager = new AdminRunManager({
    runner: {
      run: async (executable, args, options) => {
        signal.throwIfAborted()
        const combined = options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal])
        return runner.run(executable, args, { ...options, cwd, signal: combined })
      },
    },
  })
  const raw = new Map<string, AdminHarnessVersionResult>()
  const collect: NonNullable<HarnessVersionSchedulerOptions["onResult"]> = (_key, observation, entry) => {
    const key = scopeKeyFor(entry)
    if (key !== undefined) raw.set(key, observation.result)
  }
  await runBatchedHarnessVersionChecks(entries, manager, emptyCache, { forceResync: true, onResult: collect })
  await readMissingScopes(entries, raw, manager, signal, collect)
  signal.throwIfAborted()
  const results = reconcileHarnessVersionObservations(entries, (entry) => {
    const key = scopeKeyFor(entry)
    return key === undefined ? undefined : raw.get(key)
  })
  publishResults(entries, results, onResult)
  return results
}
