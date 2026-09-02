/**
 * File-based 24-hour cache for `update --check` results, keyed by profile
 * `ref`. Mirrors `guide-match-cache.ts`'s atomic-write convention (write to
 * a `.tmp` sibling with `wx`+`0o600`, then `rename` into place) so a crash
 * mid-write can never leave a half-written cache file. A missing, corrupt,
 * or oversized cache file is treated as "no cache yet" (fail-open to a
 * fresh check) rather than blocking startup — the cache is a pure
 * optimization, never a source of truth for whether a profile is healthy.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import type { AdminUpdateCheckResult } from "./admin-model.js"

const maximumCacheBytes = 256 * 1024
const maximumCacheEntries = 512

export const versionCacheTtlMs = 24 * 60 * 60 * 1000

export interface AdminVersionCacheEntry {
  readonly result: AdminUpdateCheckResult
  readonly checkedAt: number
}

export interface AdminVersionCacheRecord {
  readonly schemaVersion: 1
  readonly entries: Readonly<Record<string, AdminVersionCacheEntry>>
}

const emptyRecord: AdminVersionCacheRecord = { schemaVersion: 1, entries: {} }

const isMissingFile = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

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

/** Tolerantly parses a cache file's contents. Any structural problem yields the empty record rather than throwing, since a corrupt cache must never block startup. */
export const parseVersionCacheRecord = (source: string): AdminVersionCacheRecord => {
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) return emptyRecord
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return emptyRecord
  }
  if (!isPlainObject(payload) || payload.schemaVersion !== 1 || !isPlainObject(payload.entries)) return emptyRecord
  const entries: Record<string, AdminVersionCacheEntry> = {}
  for (const [ref, value] of Object.entries(payload.entries).slice(0, maximumCacheEntries)) {
    const entry = parseEntry(value)
    if (entry !== undefined) entries[ref] = entry
  }
  return { schemaVersion: 1, entries }
}

/** Loads the cache from disk. A missing or corrupt file resolves to an empty record; only an unexpected read error (not ENOENT) propagates. */
export const loadVersionCache = async (cachePath: string): Promise<AdminVersionCacheRecord> => {
  let source: string
  try {
    source = await readFile(cachePath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return emptyRecord
    return emptyRecord
  }
  return parseVersionCacheRecord(source)
}

const removeTemporaryCache = async (temporaryPath: string): Promise<void> => {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

/** Atomically persists the cache. Failures are surfaced to the caller (unlike `loadVersionCache`) so a write-permission problem can be surfaced once rather than silently discarding every check result. */
export const saveVersionCache = async (cachePath: string, value: AdminVersionCacheRecord): Promise<void> => {
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  const source = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) {
    throw new Error(`admin version cache exceeds ${maximumCacheBytes} bytes`)
  }
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporaryPath, cachePath)
  } catch (error) {
    await removeTemporaryCache(temporaryPath)
    throw new Error(`could not write admin version cache: ${cachePath}`, { cause: error })
  }
}

export const defaultAdminVersionCachePath = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const cacheRoot = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(cacheRoot, "trellage", "trx-admin", "version-cache.json")
}

/** A cache entry is stale once `versionCacheTtlMs` has elapsed since it was recorded, or if it was never recorded. */
export const isVersionCacheStale = (entry: AdminVersionCacheEntry | undefined, now: number): boolean =>
  entry === undefined || now - entry.checkedAt >= versionCacheTtlMs
