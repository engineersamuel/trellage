/**
 * File-based 24-hour cache for `update --check` results, keyed by profile
 * `ref`. Mirrors `guide-match-cache.ts`'s atomic-write convention (write to
 * a `.tmp` sibling with `wx`+`0o600`, then `rename` into place) so a crash
 * mid-write can never leave a half-written cache file. A missing, corrupt,
 * or oversized cache file is treated as "no cache yet" (fail-open to a
 * fresh check) rather than blocking startup — the cache is a pure
 * optimization, never a source of truth for whether a profile is healthy.
 *
 * `schemaVersion` bumped 1 -> 2: an earlier release's on-disk cache could
 * contain `current: true` entries with no `installed` field (from a load-side
 * bug that has since been fixed) or terminal `malformed` results recorded
 * before `versionCheckResultForEntry` learned to reparse a non-zero-exit
 * launcher's stdout. Neither shape self-identifies as stale, so they would
 * otherwise sit unrefreshed for the full TTL. Bumping the schema discards
 * every pre-fix cache file on next load, forcing one fresh check per profile
 * that immediately repopulates in the current, fully-populated format.
 */
import { createAdminRecordCache } from "./admin-record-cache.ts"
import os from "node:os"
import path from "node:path"

import type { AdminUpdateCheckResult } from "./admin-model.ts"

const maximumCacheBytes = 256 * 1024
const maximumCacheEntries = 512

export const versionCacheTtlMs = 24 * 60 * 60 * 1000

export interface AdminVersionCacheEntry {
  readonly result: AdminUpdateCheckResult
  readonly checkedAt: number
}

export interface AdminVersionCacheRecord {
  readonly schemaVersion: 2
  readonly entries: Readonly<Record<string, AdminVersionCacheEntry>>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseResult = (value: unknown): AdminUpdateCheckResult | undefined => {
  if (!isPlainObject(value)) return undefined
  const installed = typeof value.installed === "string" ? value.installed : undefined
  if (value.malformed === true && typeof value.diagnostic === "string") return { malformed: true, diagnostic: value.diagnostic }
  if (value.current === true) return { current: true, ...(installed === undefined ? {} : { installed }) }
  if (value.current === false && typeof value.latest === "string") {
    return { current: false, latest: value.latest, ...(installed === undefined ? {} : { installed }) }
  }
  return undefined
}

const parseEntry = (value: unknown): AdminVersionCacheEntry | undefined => {
  if (!isPlainObject(value)) return undefined
  const result = parseResult(value.result)
  if (result === undefined || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return undefined
  return { result, checkedAt: value.checkedAt }
}

const cache = createAdminRecordCache<AdminVersionCacheEntry>({
  maximumBytes: maximumCacheBytes,
  maximumEntries: maximumCacheEntries,
  label: "admin version cache",
  parseEntry,
})

export const parseVersionCacheRecord = cache.parse
export const loadVersionCache = cache.load
export const saveVersionCache = cache.save

export const defaultAdminVersionCachePath = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const cacheRoot = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(cacheRoot, "trellage", "trx-admin", "version-cache.json")
}

/**
 * A cache entry is stale once `versionCacheTtlMs` has elapsed since it was
 * recorded, if it was never recorded, or if the recorded result itself was
 * malformed. A malformed result (unparseable `update --check` output, an
 * unknown-profile error, etc.) never reflects a real installed/latest
 * version, so honoring it as "fresh" for a full day would strand the
 * VERSION/LATEST VERSION columns on "—" until a manual force-resync —
 * treating it as stale instead lets the next startup batch retry it
 * automatically, exactly like every other missing result.
 */
export const isVersionCacheStale = (entry: AdminVersionCacheEntry | undefined, now: number): boolean =>
  entry === undefined || now - entry.checkedAt >= versionCacheTtlMs || "malformed" in entry.result
