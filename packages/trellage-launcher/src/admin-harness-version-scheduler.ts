/**
 * Bounded-concurrency batch scheduler for `harness-version` runs, deduped
 * by **launcher** rather than per-profile `ref` (unlike
 * `admin-version-scheduler.ts`'s per-profile `update --check` scheduler).
 * Every profile sharing one launcher shares the exact same one harness
 * binary and `commandPath`, so running one check per profile would be
 * genuinely duplicate, unbounded work as the catalog grows — this
 * scheduler runs at most one `harness-version` invocation per distinct
 * launcher and fans the single settled result out to every profile entry
 * that shares it. Never spawns a subprocess itself: it always delegates to
 * the same `AdminRunManager.trigger()`/`.retry()` used elsewhere, so one
 * launcher's failure or timeout is isolated exactly like every other run
 * and never affects any other launcher's outcome.
 */
import type { AdminProfileEntry } from "./admin-model.js"
import type { AdminRunManager } from "./admin-run-manager.js"
import { buildHarnessVersionCommand, harnessVersionLauncherFor, parseHarnessVersionOutput, type AdminHarnessVersionResult } from "./admin-harness-version.js"
import type { AdminHarnessVersionCacheEntry, AdminHarnessVersionCacheRecord } from "./admin-harness-version-cache.js"
import { isHarnessVersionCacheStale } from "./admin-harness-version-cache.js"

export interface HarnessVersionSchedulerOptions {
  readonly maxConcurrent?: number
  readonly forceResync?: boolean
  readonly now?: () => number
  /** Called once per launcher as soon as its check settles, so the caller can persist the cache incrementally (a crash mid-batch never loses earlier results). */
  readonly onResult?: (launcher: string, entry: AdminHarnessVersionCacheEntry) => void
}

const defaultMaxConcurrent = 4

/** The distinct `AdminRunManager` ref used to track a launcher's harness-version runs, namespaced apart from any profile's own doctor/repair/update-check history. */
export const harnessVersionRefFor = (launcher: string): string => `harness-version::${launcher}`

/**
 * Reads the current in-session `harness-version` result for a launcher
 * directly from `AdminRunManager`, or `undefined` when no check has run yet
 * this session (the caller should then fall back to the on-disk cache).
 */
export const harnessVersionResultForLauncher = (
  launcher: string,
  runManager: AdminRunManager,
): AdminHarnessVersionResult | undefined => {
  const status = runManager.status(harnessVersionRefFor(launcher))
  const latest = status.latest
  if (latest === undefined) return undefined
  if (latest.state === "success") return parseHarnessVersionOutput(latest.stdout)
  const reason = latest.stderr.trim() || latest.stdout.trim() || latest.state
  return { kind: "unavailable", diagnostic: `harness-version ${latest.state}: ${reason.split("\n")[0] ?? reason}` }
}

const resultFromRun = (launcher: string, runManager: AdminRunManager): AdminHarnessVersionResult =>
  harnessVersionResultForLauncher(launcher, runManager) ?? { kind: "unavailable", diagnostic: "harness-version did not complete" }

/** One representative entry (and thus `commandPath`) per distinct, harness-version-supporting launcher present in `entries`. */
const distinctLauncherEntries = (entries: ReadonlyArray<AdminProfileEntry>): ReadonlyArray<AdminProfileEntry> => {
  const seen = new Set<string>()
  const result: Array<AdminProfileEntry> = []
  for (const entry of entries) {
    if (!entry.harnessVersionSupported) continue
    const launcher = harnessVersionLauncherFor(entry)
    if (launcher === undefined || seen.has(launcher)) continue
    seen.add(launcher)
    result.push(entry)
  }
  return result
}

/**
 * Runs `harness-version` for every distinct, supporting launcher whose
 * cache entry is stale (or missing), at most `maxConcurrent` in flight at a
 * time. `forceResync` bypasses the cache entirely (used by the manual
 * resync key). Resolves once every scheduled launcher has reached a
 * terminal state; a cache-fresh launcher is never scheduled and never
 * invokes `onResult`.
 */
export const runBatchedHarnessVersionChecks = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  runManager: AdminRunManager,
  cache: AdminHarnessVersionCacheRecord,
  options: HarnessVersionSchedulerOptions = {},
): Promise<void> => {
  const maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent
  const now = options.now ?? (() => Date.now())
  const forceResync = options.forceResync ?? false
  const queue = distinctLauncherEntries(entries)
    .filter((entry) => forceResync || isHarnessVersionCacheStale(cache.entries[entry.launcher ?? ""], now()))
    .slice()
  if (queue.length === 0) return

  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift()
      if (entry === undefined) return
      const launcher = harnessVersionLauncherFor(entry)
      if (launcher === undefined) continue
      const command = buildHarnessVersionCommand(entry.commandPath)
      const ref = harnessVersionRefFor(launcher)
      // Each launcher's outcome is isolated by `AdminRunManager`'s own per-ref
      // state; `trigger`/`retry` already convert run failures into recorded
      // terminal states rather than a rejected promise, so no launcher's
      // failure can stop this worker from continuing to the next one.
      if (forceResync) {
        await runManager.retry(ref, command.executable, command.args)
      } else {
        await runManager.trigger(ref, command.executable, command.args)
      }
      options.onResult?.(launcher, { result: resultFromRun(launcher, runManager), checkedAt: now() })
    }
  }

  const workerCount = Math.max(1, Math.min(maxConcurrent, queue.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
