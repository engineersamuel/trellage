/**
 * Bounded harness-version scheduler. Native operations always run when
 * their installed state is stale. For each release identity, one
 * latest-capable primary runs; a sandbox alternate runs only after the
 * primary and its one bounded retry cannot provide latest.
 */
import {
  buildHarnessVersionCommand,
  failedHarnessVersionResult,
  harnessVersionLatestLookupSupported,
  harnessVersionOperationKeyFor,
  harnessVersionReleaseKeyFor,
  parseHarnessVersionOutput,
  type AdminHarnessVersionResult,
  type HarnessReleaseKey,
} from "./admin-harness-version.js"
import {
  isHarnessVersionCacheStale,
  type AdminHarnessVersionCacheEntry,
  type AdminHarnessVersionCacheRecord,
} from "./admin-harness-version-cache.js"
import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminRunManager } from "./admin-run-manager.js"

export interface HarnessVersionSchedulerOptions {
  readonly maxConcurrent?: number
  readonly forceResync?: boolean
  readonly selectedEntryRef?: string
  readonly now?: () => number
  readonly onResult?: (
    operationKey: string,
    entry: AdminHarnessVersionCacheEntry,
    sourceEntry: AdminProfileEntry,
  ) => void
}

interface HarnessVersionOperation {
  readonly key: string
  readonly entry: AdminProfileEntry
  readonly releaseKey: HarnessReleaseKey | undefined
  readonly latestLookupSupported: boolean
  readonly requiresInstalled: boolean
}

const defaultMaxConcurrent = 4

export const harnessVersionRefFor = (operationKey: string): string => `harness-version::${operationKey}`

export const harnessVersionResultForOperation = (
  operationKey: string,
  runManager: AdminRunManager,
): AdminHarnessVersionResult | undefined => {
  const latest = runManager.status(harnessVersionRefFor(operationKey)).latest
  if (latest === undefined) return undefined
  if (latest.state === "success") return parseHarnessVersionOutput(latest.stdout)
  const reason = latest.stderr.trim() || latest.stdout.trim() || latest.state
  return failedHarnessVersionResult(
    `harness-version ${latest.state}: ${(reason.split("\n")[0] ?? reason).slice(0, 450)}`,
  )
}

const resultFromRun = (operationKey: string, runManager: AdminRunManager): AdminHarnessVersionResult =>
  harnessVersionResultForOperation(operationKey, runManager) ??
  failedHarnessVersionResult("harness-version did not complete")

const operationSort = (
  left: AdminProfileEntry,
  right: AdminProfileEntry,
  preferredEntryRef: string | undefined,
): number => {
  if (left.ref === preferredEntryRef) return -1
  if (right.ref === preferredEntryRef) return 1
  const leftMissingVersion = left.surface === "sandbox" && left.version === undefined
  const rightMissingVersion = right.surface === "sandbox" && right.version === undefined
  if (leftMissingVersion !== rightMissingVersion) return leftMissingVersion ? 1 : -1
  return left.ref.localeCompare(right.ref)
}

export const harnessVersionOperations = (
  entries: ReadonlyArray<AdminProfileEntry>,
  preferredEntryRef?: string,
): ReadonlyArray<HarnessVersionOperation> => {
  const operations = new Map<string, HarnessVersionOperation>()
  for (const entry of [...entries].sort((left, right) => operationSort(left, right, preferredEntryRef))) {
    const key = harnessVersionOperationKeyFor(entry)
    if (key === undefined || operations.has(key)) continue
    operations.set(key, {
      key,
      entry,
      releaseKey: harnessVersionReleaseKeyFor(entry),
      latestLookupSupported: harnessVersionLatestLookupSupported(entry),
      requiresInstalled: entry.surface === "native",
    })
  }
  return [...operations.values()]
}

const primaryOperations = (
  operations: ReadonlyArray<HarnessVersionOperation>,
  selectedEntryRef: string | undefined,
  forceResync: boolean,
): ReadonlyArray<HarnessVersionOperation> => {
  const selected = new Map<string, HarnessVersionOperation>()
  if (forceResync && selectedEntryRef !== undefined) {
    const selectedOperation = operations.find((operation) => operation.entry.ref === selectedEntryRef)
    if (selectedOperation !== undefined) selected.set(selectedOperation.key, selectedOperation)
  } else {
    for (const operation of operations) {
      if (operation.entry.surface === "native") selected.set(operation.key, operation)
    }
  }
  const releaseKeys = new Set(
    operations
      .map((operation) => operation.releaseKey)
      .filter((releaseKey): releaseKey is HarnessReleaseKey => releaseKey !== undefined),
  )
  for (const releaseKey of releaseKeys) {
    const candidates = operations.filter(
      (operation) => operation.releaseKey === releaseKey && operation.latestLookupSupported,
    )
    if (
      [...selected.values()].some((operation) => operation.releaseKey === releaseKey && operation.latestLookupSupported)
    ) {
      continue
    }
    const candidate = candidates[0]
    if (candidate !== undefined) selected.set(candidate.key, candidate)
  }
  return [...selected.values()]
}

const freshCachedResults = (
  operations: ReadonlyArray<HarnessVersionOperation>,
  cache: AdminHarnessVersionCacheRecord,
  now: number,
  forceResync: boolean,
): Map<string, AdminHarnessVersionResult> => {
  const results = new Map<string, AdminHarnessVersionResult>()
  if (forceResync) return results
  for (const operation of operations) {
    const cached = cache.entries[operation.key]
    if (
      !isHarnessVersionCacheStale(cached, now, {
        requiresInstalled: operation.requiresInstalled,
        requiresLatest: operation.latestLookupSupported,
      })
    ) {
      results.set(operation.key, cached!.result)
    }
  }
  return results
}

const releaseHasKnownLatest = (
  releaseKey: HarnessReleaseKey,
  operations: ReadonlyArray<HarnessVersionOperation>,
  results: ReadonlyMap<string, AdminHarnessVersionResult>,
): boolean =>
  operations.some(
    (operation) => operation.releaseKey === releaseKey && results.get(operation.key)?.latest.kind === "known",
  )

const operationNeedsRetry = (
  operation: HarnessVersionOperation,
  result: AdminHarnessVersionResult | undefined,
  operations: ReadonlyArray<HarnessVersionOperation>,
  results: ReadonlyMap<string, AdminHarnessVersionResult>,
): boolean => {
  if (result === undefined) return false
  if (operation.requiresInstalled && result.installed.kind === "unavailable") return true
  return (
    result.latest.kind === "failed" &&
    (operation.releaseKey === undefined || !releaseHasKnownLatest(operation.releaseKey, operations, results))
  )
}

const mergeAttemptResult = (
  previous: AdminHarnessVersionResult | undefined,
  current: AdminHarnessVersionResult,
): AdminHarnessVersionResult => {
  if (previous === undefined) return current
  const installed =
    current.installed.kind === "known" || previous.installed.kind !== "known" ? current.installed : previous.installed
  const latest =
    current.latest.kind === "known" || previous.latest.kind !== "known"
      ? current.latest.kind === "unsupported" && previous.latest.kind === "failed"
        ? previous.latest
        : current.latest
      : previous.latest
  return { installed, latest }
}

export const runBatchedHarnessVersionChecks = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  runManager: AdminRunManager,
  cache: AdminHarnessVersionCacheRecord,
  options: HarnessVersionSchedulerOptions = {},
): Promise<void> => {
  const operations = harnessVersionOperations(entries, options.selectedEntryRef)
  if (operations.length === 0) return
  const maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent
  const now = options.now ?? (() => Date.now())
  const forceResync = options.forceResync ?? false
  const results = freshCachedResults(operations, cache, now(), forceResync)
  const attempted = new Set<string>()

  const runOperations = async (
    candidates: ReadonlyArray<HarnessVersionOperation>,
    forceRun: boolean,
  ): Promise<void> => {
    const queue = candidates.filter(
      (operation) =>
        forceRun ||
        isHarnessVersionCacheStale(cache.entries[operation.key], now(), {
          requiresInstalled: operation.requiresInstalled,
          requiresLatest: operation.latestLookupSupported,
        }),
    )
    if (queue.length === 0) return
    const worker = async (): Promise<void> => {
      for (;;) {
        const operation = queue.shift()
        if (operation === undefined) return
        const command = buildHarnessVersionCommand(operation.entry, {
          refreshLatest: forceRun && operation.entry.surface === "sandbox",
        })
        const ref = harnessVersionRefFor(operation.key)
        if (forceRun) {
          await runManager.retry(ref, command.executable, command.args)
        } else {
          await runManager.trigger(ref, command.executable, command.args)
        }
        const result = mergeAttemptResult(results.get(operation.key), resultFromRun(operation.key, runManager))
        results.set(operation.key, result)
        attempted.add(operation.key)
        options.onResult?.(operation.key, { result, checkedAt: now() }, operation.entry)
      }
    }
    const workerCount = Math.max(1, Math.min(maxConcurrent, queue.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  const primary = primaryOperations(operations, options.selectedEntryRef, forceResync)
  await runOperations(primary, forceResync)
  const primaryRetries = primary.filter((operation) =>
    operationNeedsRetry(operation, results.get(operation.key), operations, results),
  )
  await runOperations(primaryRetries, true)

  const primaryKeys = new Set(primary.map((operation) => operation.key))
  const fallbacks = operations.filter(
    (operation) =>
      operation.latestLookupSupported &&
      !primaryKeys.has(operation.key) &&
      operation.releaseKey !== undefined &&
      !releaseHasKnownLatest(operation.releaseKey, operations, results),
  )
  await runOperations(fallbacks, forceResync)
  const fallbackRetries = fallbacks.filter(
    (operation) =>
      attempted.has(operation.key) && operationNeedsRetry(operation, results.get(operation.key), operations, results),
  )
  await runOperations(fallbackRetries, true)
}
