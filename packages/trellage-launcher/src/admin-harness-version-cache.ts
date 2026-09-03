/**
 * Atomic 24-hour cache for harness-version operation results. Schema 2
 * stores installed and latest state independently and is keyed by explicit
 * operation identity. Schema 1 is intentionally treated as empty because
 * its profile/launcher keys and combined result states cannot be migrated
 * safely.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AdminHarnessVersionResult,
  AdminInstalledVersionState,
  AdminLatestVersionState,
} from "./admin-harness-version.js"

const maximumCacheBytes = 256 * 1024
const maximumCacheEntries = 64
const maximumDiagnosticLength = 500

export const harnessVersionCacheTtlMs = 24 * 60 * 60 * 1000

export interface AdminHarnessVersionCacheEntry {
  readonly result: AdminHarnessVersionResult
  readonly checkedAt: number
}

export interface AdminHarnessVersionCacheRecord {
  readonly schemaVersion: 2
  readonly entries: Readonly<Record<string, AdminHarnessVersionCacheEntry>>
}

const emptyRecord: AdminHarnessVersionCacheRecord = { schemaVersion: 2, entries: {} }

const isMissingFile = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validText = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000\r\n]/u.test(value)
    ? value
    : undefined

const parseInstalled = (value: unknown): AdminInstalledVersionState | undefined => {
  if (!isPlainObject(value)) return undefined
  if (value.kind === "known") {
    const version = validText(value.version, 128)
    return version === undefined ? undefined : { kind: "known", version }
  }
  if (value.kind === "unavailable") {
    const diagnostic = validText(value.diagnostic, maximumDiagnosticLength)
    return diagnostic === undefined ? undefined : { kind: "unavailable", diagnostic }
  }
  return undefined
}

const parseLatest = (value: unknown): AdminLatestVersionState | undefined => {
  if (!isPlainObject(value)) return undefined
  if (value.kind === "known") {
    const version = validText(value.version, 128)
    return version === undefined ? undefined : { kind: "known", version }
  }
  if (value.kind === "unsupported") return { kind: "unsupported" }
  if (value.kind === "failed") {
    const diagnostic = validText(value.diagnostic, maximumDiagnosticLength)
    return diagnostic === undefined ? undefined : { kind: "failed", diagnostic }
  }
  return undefined
}

const parseResult = (value: unknown): AdminHarnessVersionResult | undefined => {
  if (!isPlainObject(value)) return undefined
  const installed = parseInstalled(value.installed)
  const latest = parseLatest(value.latest)
  return installed === undefined || latest === undefined ? undefined : { installed, latest }
}

const parseEntry = (value: unknown): AdminHarnessVersionCacheEntry | undefined => {
  if (!isPlainObject(value)) return undefined
  const result = parseResult(value.result)
  if (result === undefined || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return undefined
  return { result, checkedAt: value.checkedAt }
}

export const parseHarnessVersionCacheRecord = (source: string): AdminHarnessVersionCacheRecord => {
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) return emptyRecord
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return emptyRecord
  }
  if (!isPlainObject(payload) || payload.schemaVersion !== 2 || !isPlainObject(payload.entries)) return emptyRecord
  const entries: Record<string, AdminHarnessVersionCacheEntry> = {}
  for (const [operationKey, value] of Object.entries(payload.entries).slice(0, maximumCacheEntries)) {
    const entry = parseEntry(value)
    if (entry !== undefined) entries[operationKey] = entry
  }
  return { schemaVersion: 2, entries }
}

export const loadHarnessVersionCache = async (cachePath: string): Promise<AdminHarnessVersionCacheRecord> => {
  try {
    return parseHarnessVersionCacheRecord(await readFile(cachePath, "utf8"))
  } catch {
    return emptyRecord
  }
}

const removeTemporaryCache = async (temporaryPath: string): Promise<void> => {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

export const saveHarnessVersionCache = async (
  cachePath: string,
  value: AdminHarnessVersionCacheRecord,
): Promise<void> => {
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

export interface AdminHarnessVersionCacheSaveQueue {
  readonly enqueue: (value: AdminHarnessVersionCacheRecord) => Promise<void>
}

/** Orders full-record snapshots so an older save can never finish after a newer one. */
export const createHarnessVersionCacheSaveQueue = (
  cachePath: string,
  save: (cachePath: string, value: AdminHarnessVersionCacheRecord) => Promise<void> = saveHarnessVersionCache,
): AdminHarnessVersionCacheSaveQueue => {
  let pending: Promise<void> = Promise.resolve()
  return {
    enqueue: (value) => {
      const current = pending.catch(() => undefined).then(() => save(cachePath, value))
      pending = current
      return current
    },
  }
}

export const defaultAdminHarnessVersionCachePath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const cacheRoot = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(cacheRoot, "trellage", "trx-admin", "harness-version-cache.json")
}

export interface HarnessVersionCacheStaleOptions {
  readonly requiresInstalled?: boolean
  readonly requiresLatest?: boolean
}

export const isHarnessVersionCacheStale = (
  entry: AdminHarnessVersionCacheEntry | undefined,
  now: number,
  options: HarnessVersionCacheStaleOptions = {},
): boolean =>
  entry === undefined ||
  now - entry.checkedAt >= harnessVersionCacheTtlMs ||
  entry.result.latest.kind === "failed" ||
  ((options.requiresLatest ?? false) && entry.result.latest.kind !== "known") ||
  ((options.requiresInstalled ?? true) && entry.result.installed.kind === "unavailable")
