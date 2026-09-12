/**
 * File-based 24-hour cache for a harness kind's "latest" GitHub Release
 * version (e.g. `claude` → `2.1.259`), keyed by `harnessKind:platform` and
 * shared by every sandbox profile of that harness kind regardless of which
 * profile's `harness-version` subprocess happens to run first.
 *
 * The Admin scheduler normally invokes one representative sandbox profile
 * per release identity. This persistent cache also deduplicates direct CLI
 * calls and later Admin startups, where an in-memory cache would not
 * survive. The first successful lookup pays the network cost and every
 * subsequent profile of that harness kind reuses it for the TTL.
 *
 * Mirrors `admin-harness-version-cache.ts`'s atomic-write convention
 * (write to a `.tmp` sibling with `wx`+`0o600`, then `rename` into place)
 * so a crash mid-write can never leave a half-written cache file. A
 * missing, corrupt, or oversized cache file is treated as "no cache yet"
 * (fail-open to a fresh lookup) rather than blocking the report. Only a
 * successful lookup is ever cached — a lookup failure is never persisted,
 * so the next check (in this profile or another sharing the same harness
 * kind) retries rather than being stuck on a stale failure for 24 hours.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

import lockfile from "proper-lockfile"

import type { Platform } from "./platform.ts"

const maximumCacheBytes = 64 * 1024
const maximumCacheEntries = 32

export const harnessLatestVersionCacheTtlMs = 24 * 60 * 60 * 1000

export interface HarnessLatestVersionCacheEntry {
  readonly version: string
  readonly checkedAt: number
}

export interface HarnessLatestVersionCacheRecord {
  readonly schemaVersion: 1
  readonly entries: Readonly<Record<string, HarnessLatestVersionCacheEntry>>
}

const emptyRecord: HarnessLatestVersionCacheRecord = { schemaVersion: 1, entries: {} }

const isMissingFile = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseEntry = (value: unknown): HarnessLatestVersionCacheEntry | undefined => {
  if (!isPlainObject(value)) return undefined
  if (typeof value.version !== "string" || value.version.length === 0) return undefined
  if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return undefined
  return { version: value.version, checkedAt: value.checkedAt }
}

/** Tolerantly parses a cache file's contents. Any structural problem yields the empty record rather than throwing, since a corrupt cache must never block a version check. */
export const parseHarnessLatestVersionCacheRecord = (source: string): HarnessLatestVersionCacheRecord => {
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) return emptyRecord
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return emptyRecord
  }
  if (!isPlainObject(payload) || payload.schemaVersion !== 1 || !isPlainObject(payload.entries)) return emptyRecord
  const entries: Record<string, HarnessLatestVersionCacheEntry> = {}
  for (const [key, value] of Object.entries(payload.entries).slice(0, maximumCacheEntries)) {
    const entry = parseEntry(value)
    if (entry !== undefined) entries[key] = entry
  }
  return { schemaVersion: 1, entries }
}

export const harnessLatestVersionCacheKey = (harnessKind: string, platform: Platform): string =>
  `${harnessKind}:${platform}`

export const harnessLatestVersionCachePath = (xdgCacheHome: string): string =>
  path.join(xdgCacheHome, "trellage", "harness-latest-version-cache.json")

/** Loads the cache from disk. A missing or corrupt file resolves to an empty record. */
export const loadHarnessLatestVersionCache = async (cachePath: string): Promise<HarnessLatestVersionCacheRecord> => {
  let source: string
  try {
    source = await readFile(cachePath, "utf8")
  } catch {
    return emptyRecord
  }
  return parseHarnessLatestVersionCacheRecord(source)
}

/** A cache entry is fresh only when it exists and its TTL has not elapsed. */
export const cachedLatestVersion = (
  record: HarnessLatestVersionCacheRecord,
  harnessKind: string,
  platform: Platform,
  now: number,
): string | undefined => {
  const entry = record.entries[harnessLatestVersionCacheKey(harnessKind, platform)]
  return entry !== undefined && now - entry.checkedAt < harnessLatestVersionCacheTtlMs ? entry.version : undefined
}

const removeTemporaryCache = async (temporaryPath: string): Promise<void> => {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

/**
 * Atomically records a freshly-resolved "latest" version for one harness
 * kind, read-modify-write against the current cache file so a concurrent
 * writer for a different harness kind is never clobbered. Write failures
 * are swallowed (never thrown): a cache-write problem must never fail an
 * otherwise-successful version report, it only forgoes the deduplication
 * benefit for later profiles of the same harness kind.
 */
export const recordLatestVersion = async (
  xdgCacheHome: string,
  harnessKind: string,
  platform: Platform,
  version: string,
  now: number,
): Promise<void> => {
  const cachePath = harnessLatestVersionCachePath(xdgCacheHome)
  try {
    await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 })
    const release = await lockfile.lock(cachePath, {
      realpath: false,
      stale: 10_000,
      update: 5_000,
      retries: { retries: 50, factor: 1, minTimeout: 10, maxTimeout: 50 },
    })
    try {
      const current = await loadHarnessLatestVersionCache(cachePath)
      const key = harnessLatestVersionCacheKey(harnessKind, platform)
      const entries = { ...current.entries, [key]: { version, checkedAt: now } }
      const trimmedEntries = Object.fromEntries(Object.entries(entries).slice(-maximumCacheEntries))
      const value: HarnessLatestVersionCacheRecord = { schemaVersion: 1, entries: trimmedEntries }
      const source = `${JSON.stringify(value)}\n`
      if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) return
      const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 })
        await rename(temporaryPath, cachePath)
      } catch (error) {
        await removeTemporaryCache(temporaryPath)
        throw error
      }
    } finally {
      await release()
    }
  } catch {
    // Never fail the version report over a cache-write problem.
  }
}
