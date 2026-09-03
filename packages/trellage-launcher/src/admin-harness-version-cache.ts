/**
 * File-based 24-hour cache for `harness-version` results, keyed by
 * **launcher** (e.g. `"cpx"`, `"omp"`) rather than profile `ref` — every
 * profile sharing one launcher shares the exact same one harness binary,
 * so caching per-launcher is both correct and exactly matches the
 * per-launcher scheduling dedup in `admin-harness-version-scheduler.ts`
 * ("prevent duplicate or unbounded work"). Mirrors
 * `admin-version-cache.ts`'s atomic-write convention (write to a `.tmp`
 * sibling with `wx`+`0o600`, then `rename` into place) so a crash mid-write
 * can never leave a half-written cache file. A missing, corrupt, or
 * oversized cache file is treated as "no cache yet" (fail-open to a fresh
 * check) rather than blocking startup.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import type { AdminHarnessVersionResult } from "./admin-harness-version.js"

const maximumCacheBytes = 256 * 1024
const maximumCacheEntries = 64

export const harnessVersionCacheTtlMs = 24 * 60 * 60 * 1000

export interface AdminHarnessVersionCacheEntry {
  readonly result: AdminHarnessVersionResult
  readonly checkedAt: number
}

export interface AdminHarnessVersionCacheRecord {
  readonly schemaVersion: 1
  readonly entries: Readonly<Record<string, AdminHarnessVersionCacheEntry>>
}

const emptyRecord: AdminHarnessVersionCacheRecord = { schemaVersion: 1, entries: {} }

const isMissingFile = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseResult = (value: unknown): AdminHarnessVersionResult | undefined => {
  if (!isPlainObject(value)) return undefined
  if (value.kind === "unavailable" && typeof value.diagnostic === "string") {
    return { kind: "unavailable", diagnostic: value.diagnostic }
  }
  if (value.kind === "unknown-latest" && typeof value.installed === "string") {
    return { kind: "unknown-latest", installed: value.installed }
  }
  if (value.kind === "known-latest" && typeof value.installed === "string" && typeof value.latest === "string") {
    return { kind: "known-latest", installed: value.installed, latest: value.latest }
  }
  return undefined
}

const parseEntry = (value: unknown): AdminHarnessVersionCacheEntry | undefined => {
  if (!isPlainObject(value)) return undefined
  const result = parseResult(value.result)
  if (result === undefined || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return undefined
  return { result, checkedAt: value.checkedAt }
}

/** Tolerantly parses a cache file's contents. Any structural problem yields the empty record rather than throwing, since a corrupt cache must never block startup. */
export const parseHarnessVersionCacheRecord = (source: string): AdminHarnessVersionCacheRecord => {
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) return emptyRecord
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return emptyRecord
  }
  if (!isPlainObject(payload) || payload.schemaVersion !== 1 || !isPlainObject(payload.entries)) return emptyRecord
  const entries: Record<string, AdminHarnessVersionCacheEntry> = {}
  for (const [launcher, value] of Object.entries(payload.entries).slice(0, maximumCacheEntries)) {
    const entry = parseEntry(value)
    if (entry !== undefined) entries[launcher] = entry
  }
  return { schemaVersion: 1, entries }
}

/** Loads the cache from disk. A missing or corrupt file resolves to an empty record; only an unexpected read error (not ENOENT) is swallowed the same way. */
export const loadHarnessVersionCache = async (cachePath: string): Promise<AdminHarnessVersionCacheRecord> => {
  let source: string
  try {
    source = await readFile(cachePath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return emptyRecord
    return emptyRecord
  }
  return parseHarnessVersionCacheRecord(source)
}

const removeTemporaryCache = async (temporaryPath: string): Promise<void> => {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

/** Atomically persists the cache. Failures are surfaced to the caller (unlike `loadHarnessVersionCache`) so a write-permission problem can be surfaced once rather than silently discarding every check result. */
export const saveHarnessVersionCache = async (cachePath: string, value: AdminHarnessVersionCacheRecord): Promise<void> => {
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  const source = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) {
    throw new Error(`admin harness-version cache exceeds ${maximumCacheBytes} bytes`)
  }
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporaryPath, cachePath)
  } catch (error) {
    await removeTemporaryCache(temporaryPath)
    throw new Error(`could not write admin harness-version cache: ${cachePath}`, { cause: error })
  }
}

export const defaultAdminHarnessVersionCachePath = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const cacheRoot = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(cacheRoot, "trellage", "trx-admin", "harness-version-cache.json")
}

/**
 * A cache entry is stale once `harnessVersionCacheTtlMs` has elapsed since
 * it was recorded, if it was never recorded, or if the recorded result
 * itself is `"unavailable"`. An unavailable result never reflects a real
 * installed/latest version, so honoring it as "fresh" for a full day would
 * strand the VERSION/LATEST VERSION columns on "—" until a manual
 * force-resync — treating it as stale instead lets the next startup batch
 * retry it automatically.
 */
export const isHarnessVersionCacheStale = (entry: AdminHarnessVersionCacheEntry | undefined, now: number): boolean =>
  entry === undefined || now - entry.checkedAt >= harnessVersionCacheTtlMs || entry.result.kind === "unavailable"
