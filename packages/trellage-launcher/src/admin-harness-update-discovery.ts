import type { AdminProfileEntry } from "./admin-model.js"
import type { CommandRunner } from "./guide-launch.js"
import { AdminRunManager } from "./admin-run-manager.js"
import {
  harnessVersionOperationKeyFor,
  reconcileHarnessVersionObservations,
  type AdminHarnessVersionResult,
  type AdminInstalledVersionState,
} from "./admin-harness-version.js"
import { runBatchedHarnessVersionChecks, type HarnessVersionSchedulerOptions } from "./admin-harness-version-scheduler.js"

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
    await runBatchedHarnessVersionChecks([entry], manager, emptyCache, { forceResync: true, refreshLatest: true, onResult })
  }
}

const observationFor = (
  entry: AdminProfileEntry,
  raw: ReadonlyMap<string, AdminHarnessVersionResult>,
  installed: ReadonlyMap<string, AdminInstalledVersionState>,
): AdminHarnessVersionResult | undefined => {
  const key = scopeKeyFor(entry)
  const result = key === undefined ? undefined : raw.get(key)
  if (entry.surface === "native") return result
  return {
    installed: installed.get(entry.ref) ?? { kind: "unavailable", diagnostic: "Installed Container version could not be checked." },
    latest: result?.latest ?? { kind: "unsupported" },
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
  const installed = new Map<string, AdminInstalledVersionState>()
  const collect: NonNullable<HarnessVersionSchedulerOptions["onResult"]> = (_key, observation, entry) => {
    const key = scopeKeyFor(entry)
    if (key !== undefined) raw.set(key, observation.result)
    if (entry.surface === "sandbox") installed.set(entry.ref, observation.result.installed)
  }
  await runBatchedHarnessVersionChecks(entries, manager, emptyCache, { forceResync: true, refreshLatest: true, onResult: collect })
  await readMissingScopes(entries, raw, manager, signal, collect)
  for (const entry of entries.filter((candidate) => candidate.surface === "sandbox" && !installed.has(candidate.ref))) {
    signal.throwIfAborted()
    await runBatchedHarnessVersionChecks([entry], manager, emptyCache, {
      forceResync: true,
      refreshLatest: false,
      // Only the fresh release checks above determine targets; ignore stale CLI latest caches here.
      onResult: (_key, observation) => installed.set(entry.ref, observation.result.installed),
    })
  }
  signal.throwIfAborted()
  const results = reconcileHarnessVersionObservations(entries, (entry) => observationFor(entry, raw, installed))
  publishResults(entries, results, onResult)
  return results
}
