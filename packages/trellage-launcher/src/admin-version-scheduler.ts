/**
 * Bounded-concurrency batch scheduler for `update --check` runs, mirroring
 * `admin-batch-scheduler.ts`'s worklist-queue shape. Adds one behavior the
 * doctor scheduler doesn't need: cache-aware skipping. A profile whose
 * cached result is still fresh (see `admin-version-cache.ts`'s
 * `isVersionCacheStale`, 24h TTL) is never re-checked by the startup batch —
 * only `forceResync` bypasses the cache for an explicit manual resync. This
 * scheduler never spawns a subprocess itself: it always delegates to the
 * same `AdminRunManager.trigger()`/`.retry()` used elsewhere, so a single
 * profile's update-check failure or timeout is isolated exactly like every
 * other run and never affects any other profile's outcome.
 */
import type { AdminProfileEntry, AdminUpdateCheckResult } from "./admin-model.js"
import type { AdminRunManager } from "./admin-run-manager.js"
import { buildUpdateCheckCommand, parseUpdateCheckOutput } from "./admin-version-check.js"
import type { AdminVersionCacheEntry, AdminVersionCacheRecord } from "./admin-version-cache.js"
import { isVersionCacheStale } from "./admin-version-cache.js"

export interface VersionCheckSchedulerOptions {
  readonly maxConcurrent?: number
  readonly forceResync?: boolean
  readonly now?: () => number
  /** Called once per profile as soon as its check settles, so the caller can persist the cache incrementally (a crash mid-batch never loses earlier results). */
  readonly onResult?: (ref: string, entry: AdminVersionCacheEntry) => void
}

const defaultMaxConcurrent = 4

const runManagerRefFor = (ref: string): string => `${ref}::update-check`

/** The distinct `AdminRunManager` ref used to track a profile's update-check runs, kept separate from its doctor/repair/setup history. */
export const updateCheckRefFor = runManagerRefFor

/**
 * Decides whether one profile's just-settled `update --check` result should
 * receive one automatic, cache-bypassing retry: only when the result is
 * malformed (unparseable output, an unknown-profile error, a transient
 * failure, etc. — never a real version, so leaving it cached would strand
 * the VERSION/LATEST VERSION columns on "—" for a full day) and this ref
 * has not already received its one automatic retry this session. Pure and
 * exported so the bound-to-one-retry-per-session policy is independently
 * testable without an Ink render.
 */
export const shouldAutoRetryMalformedVersion = (
  result: AdminUpdateCheckResult,
  ref: string,
  alreadyAutoRetriedRefs: ReadonlySet<string>,
): boolean => "malformed" in result && !alreadyAutoRetriedRefs.has(ref)

/**
 * Reads the current in-session update-check result for a profile directly
 * from `AdminRunManager`, or `undefined` when no check has run yet this
 * session (the caller should then fall back to the on-disk cache — see
 * `admin-version-cache.ts`). Exported so `admin-ui.tsx` can render live
 * status without duplicating this parsing.
 */
export const versionCheckResultForEntry = (
  entry: AdminProfileEntry,
  runManager: AdminRunManager,
): AdminUpdateCheckResult | undefined => {
  const status = runManager.status(updateCheckRefFor(entry.ref))
  const latest = status.latest
  if (latest === undefined) return undefined
  if (latest.state === "success") return parseUpdateCheckOutput(latest.stdout, entry.version)
  if (latest.state === "failure") {
    // Some launchers (verified for cpx, grx, and cdx's shared native-codex
    // implementation) exit non-zero specifically to signal "update available"
    // as a normal business outcome rather than a genuine run failure — their
    // stdout is the same parseable `update --check` text every other
    // launcher prints on a zero exit. Try parsing it before treating the
    // non-zero exit as unusable; fall back to the real stderr/stdout
    // diagnostic only when the output truly doesn't match any known format.
    const parsed = parseUpdateCheckOutput(latest.stdout, entry.version)
    if (!("malformed" in parsed)) return parsed
  }
  const reason = latest.stderr.trim() || latest.stdout.trim() || latest.state
  return { malformed: true, diagnostic: `update --check ${latest.state}: ${reason.split("\n")[0] ?? reason}` }
}

const resultFromRun = (entry: AdminProfileEntry, runManager: AdminRunManager): AdminUpdateCheckResult =>
  versionCheckResultForEntry(entry, runManager) ?? { malformed: true, diagnostic: "update --check did not complete" }

/**
 * Runs `update --check` for every update-check-supporting entry whose cache
 * entry is stale (or missing), at most `maxConcurrent` in flight at a time.
 * `forceResync` bypasses the cache entirely (used by the manual resync
 * key). Resolves once every scheduled entry has reached a terminal state;
 * a cache-fresh entry is never scheduled and never invokes `onResult`.
 */
export const runBatchedVersionChecks = async (
  entries: ReadonlyArray<AdminProfileEntry>,
  runManager: AdminRunManager,
  cache: AdminVersionCacheRecord,
  options: VersionCheckSchedulerOptions = {},
): Promise<void> => {
  const maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent
  const now = options.now ?? (() => Date.now())
  const forceResync = options.forceResync ?? false
  const queue = entries
    .filter((entry) => entry.updateCheckSupported)
    .filter((entry) => forceResync || isVersionCacheStale(cache.entries[entry.ref], now()))
    .slice()
  if (queue.length === 0) return

  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = queue.shift()
      if (entry === undefined) return
      const command = buildUpdateCheckCommand(entry)
      const ref = updateCheckRefFor(entry.ref)
      // Each entry's outcome is isolated by `AdminRunManager`'s own per-ref
      // state; `trigger`/`retry` already convert run failures into recorded
      // terminal states rather than a rejected promise, so no entry's
      // failure can stop this worker from continuing to the next one.
      if (forceResync) {
        await runManager.retry(ref, command.executable, command.args)
      } else {
        await runManager.trigger(ref, command.executable, command.args)
      }
      options.onResult?.(entry.ref, { result: resultFromRun(entry, runManager), checkedAt: now() })
    }
  }

  const workerCount = Math.max(1, Math.min(maxConcurrent, queue.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
