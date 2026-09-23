/**
 * Async, fail-closed readiness refresh: probes health/install for every
 * catalog entry whose launcher supports it (`entry.doctorSupported`,
 * skipping only a genuinely doctor-unsupported native launcher — currently
 * none) and merges results back into `AdminProfileEntry` rows. Each
 * profile's check is isolated — one profile's rejected/thrown check never
 * blocks or corrupts another profile's result. Bounded workers prevent a
 * large instance registry from starting all inventory processes at once. This
 * is the "initial discovery" data flow; `admin-run-manager.ts` is the
 * separate, user-triggered doctor-run orchestration.
 */
import { toSelectedProfile } from "./admin-launch.ts"
import {
  aggregateAdminInstanceProfiles,
  aggregateAdminProfiles,
  isAdminFirstmate,
  mergeAdminReadiness,
  type AdminFirstmateInstancesInput,
  type AdminProfileEntry,
  type AdminReadinessInput,
} from "./admin-model.ts"
import { adminNativeSelectedProfile } from "./admin-firstmate.ts"
import { buildInventoryCommand, parseInventoryOutput, type AdminInventoryResult } from "./admin-inventory.ts"
import { createFirstmateInstancesClient, type FirstmateInstanceCommandOptions } from "./guide-firstmate-instances.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { checkSelectedProfileReadiness, ProfileReadinessKind, type ProfileReadinessResult } from "./guide-preflight.ts"

const discoverInstances = async (
  runner: CommandRunner,
  catalog: CombinedGuideCatalog,
  cwd: string,
  options: FirstmateInstanceCommandOptions,
): Promise<ReadonlyArray<AdminFirstmateInstancesInput>> =>
  Promise.all(aggregateAdminProfiles(catalog)
    .filter((entry) => isAdminFirstmate(entry) && entry.orchestration?.instances !== undefined)
    .map(async (entry): Promise<AdminFirstmateInstancesInput> => {
      try {
        const instances = await createFirstmateInstancesClient(runner, adminNativeSelectedProfile(entry), cwd).list(options)
        if (instances.filter((descriptor) => descriptor.mode === "legacy").length !== 1) {
          throw new Error("The instance list is missing its explicit legacy entry.")
        }
        return { ref: entry.ref, state: "complete", instances }
      } catch (error) {
        return { ref: entry.ref, state: "failed", diagnostic: error instanceof Error ? error.message : String(error) }
      }
    }))

class AdminInstanceDiscoveryError extends Error {
  constructor(readonly entries: ReadonlyArray<AdminProfileEntry>, diagnostics: ReadonlyArray<string>) {
    super(`Admin instance discovery is incomplete:\n${diagnostics.join("\n")}`)
    this.name = "AdminInstanceDiscoveryError"
  }
}

/** Listing only. Never return partial maintenance targets or run readiness/version probes. */
export const discoverAdminInstanceEntries = async (
  runner: CommandRunner,
  catalog: CombinedGuideCatalog,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<ReadonlyArray<AdminProfileEntry>> => {
  signal?.throwIfAborted()
  const instances = await discoverInstances(runner, catalog, cwd, {
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  signal?.throwIfAborted()
  const entries = aggregateAdminInstanceProfiles(catalog, instances)
  const failures = instances.flatMap((input) => input.state === "failed" ? [`${input.ref}: ${input.diagnostic}`] : [])
  if (failures.length > 0) throw new AdminInstanceDiscoveryError(entries, failures)
  return entries
}

const discoveryRowsForRefresh = async (
  runner: CommandRunner,
  catalog: CombinedGuideCatalog,
  cwd: string,
  options: FirstmateInstanceCommandOptions,
): Promise<ReadonlyArray<AdminProfileEntry>> => {
  try {
    return await discoverAdminInstanceEntries(runner, catalog, cwd, options.signal, options.timeoutMs)
  } catch (error) {
    if (error instanceof AdminInstanceDiscoveryError) return error.entries
    throw error
  }
}

const firstmateReadinessDiagnostic = (
  entry: AdminProfileEntry,
  inventory: AdminInventoryResult,
  matchesSource: boolean,
): string => [
  inventory.readiness === "not-setup"
    ? "The selected fleet identity is missing. Recover it explicitly; Admin does not create fleets."
    : "Inspect the selected Firstmate instance with doctor.",
  `Fleet runtime: ${inventory.fleet?.runtime ?? "unknown"}.`,
  ...(inventory.fleet?.identity != null && !matchesSource ? ["The installed fleet source differs from this template's catalog pin."] : []),
  ...(entry.firstmateInstanceDescriptor?.diagnostics.map(({ message }) => message) ?? []),
  ...(inventory.fleet?.preparation?.diagnostic == null ? [] : [inventory.fleet.preparation.diagnostic]),
].join(" ")

const firstmateReadiness = async (
  runner: CommandRunner,
  entry: AdminProfileEntry,
  cwd: string,
  options: FirstmateInstanceCommandOptions,
): Promise<ProfileReadinessResult> => {
  const command = buildInventoryCommand(entry)
  const output = await runner.run(command.executable, command.args, { cwd, timeoutMs: 30_000, ...options })
  const inventory = parseInventoryOutput(output.stdout, entry)
  if (inventory.malformed === true) throw new Error(inventory.diagnostic)
  const fleet = inventory.fleet
  const matchesSource = fleet?.identity != null && fleet.identity.sourceRevision === entry.orchestration?.sourceRevision
  if (inventory.readiness === "healthy" && matchesSource && fleet?.runtime === "ready" && fleet.supervisor.state !== "unsafe") {
    return { kind: ProfileReadinessKind.Ready, summary: "The selected Firstmate instance is healthy.", fleet }
  }
  return {
    kind: ProfileReadinessKind.Blocked,
    summary: `Firstmate profile is ${inventory.readiness}; fleet runtime is ${fleet?.runtime ?? "unknown"}`,
    diagnostic: firstmateReadinessDiagnostic(entry, inventory, matchesSource),
    ...(fleet === undefined ? {} : { fleet }),
  }
}

const refreshReadinessInputs = async (
  runner: CommandRunner,
  entries: ReadonlyArray<AdminProfileEntry>,
  cwd: string,
  now: () => number,
  options: FirstmateInstanceCommandOptions,
): Promise<ReadonlyArray<AdminReadinessInput>> => {
  const queue = entries.filter((entry) => entry.doctorSupported)
  const inputs: Array<AdminReadinessInput> = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift()
      if (entry === undefined) return
      try {
        options.signal?.throwIfAborted()
        const result = isAdminFirstmate(entry) && entry.orchestration !== undefined
          ? await firstmateReadiness(runner, entry, cwd, options)
          : await checkSelectedProfileReadiness(runner, toSelectedProfile(entry), cwd, options.signal)
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
 * Individual listing/probe failures stay visible on their own rows.
 * Cancellation and unexpected catalog failures are not converted into partial success.
 */
export interface AdminRefreshOptions extends FirstmateInstanceCommandOptions {
  readonly onDiscovered?: (entries: ReadonlyArray<AdminProfileEntry>) => void
}

export const refreshAdminEntries = async (
  runner: CommandRunner,
  catalog: CombinedGuideCatalog,
  cwd: string,
  now: () => number = () => Date.now(),
  options: AdminRefreshOptions = {},
): Promise<ReadonlyArray<AdminProfileEntry>> => {
  const initial = await discoveryRowsForRefresh(runner, catalog, cwd, options)
  options.signal?.throwIfAborted()
  options.onDiscovered?.(initial)
  const readinessInputs = await refreshReadinessInputs(runner, initial, cwd, now, options)
  options.signal?.throwIfAborted()
  return mergeAdminReadiness(catalog, initial, readinessInputs)
}
