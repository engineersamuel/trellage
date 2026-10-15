/**
 * Atomic 24-hour cache for harness-version operation results. Schema 2
 * stores installed and latest state independently and is keyed by explicit
 * operation identity. Schema 1 is intentionally treated as empty because
 * its profile/launcher keys and combined result states cannot be migrated
 * safely.
 */
import { createAdminRecordCache } from "./admin-record-cache.ts"
import os from "node:os"
import path from "node:path"

import type {
  AdminHarnessVersionResult,
  AdminInstalledVersionState,
  AdminLatestVersionState,
} from "./admin-harness-version.ts"

const maximumCacheBytes = 4 * 1024 * 1024
const maximumCacheEntries = 4096
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

const cache = createAdminRecordCache<AdminHarnessVersionCacheEntry>({
  maximumBytes: maximumCacheBytes,
  maximumEntries: maximumCacheEntries,
  label: "admin harness-version cache",
  parseEntry,
})

export const parseHarnessVersionCacheRecord = cache.parse
export const loadHarnessVersionCache = cache.load
export const saveHarnessVersionCache = cache.save

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
