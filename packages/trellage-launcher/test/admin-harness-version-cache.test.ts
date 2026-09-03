import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  defaultAdminHarnessVersionCachePath,
  harnessVersionCacheTtlMs,
  isHarnessVersionCacheStale,
  loadHarnessVersionCache,
  parseHarnessVersionCacheRecord,
  saveHarnessVersionCache,
  type AdminHarnessVersionCacheEntry,
  type AdminHarnessVersionCacheRecord,
} from "../src/admin-harness-version-cache.js"

const temporaryRoots: string[] = []

const temporaryCachePath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-harness-version-cache-test-"))
  temporaryRoots.push(root)
  return path.join(root, "harness-version-cache.json")
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("loadHarnessVersionCache / saveHarnessVersionCache", () => {
  it("round-trips a saved record, keyed by launcher rather than profile ref", async () => {
    const cachePath = await temporaryCachePath()
    const record = {
      schemaVersion: 1 as const,
      entries: {
        omp: { result: { kind: "known-latest", installed: "18.1.1", latest: "18.1.2" }, checkedAt: 1000 },
        cpx: { result: { kind: "unknown-latest", installed: "1.0.82" }, checkedAt: 2000 },
      },
    } satisfies AdminHarnessVersionCacheRecord

    await saveHarnessVersionCache(cachePath, record)
    expect(await loadHarnessVersionCache(cachePath)).toEqual(record)
  })

  it("resolves to an empty record when the cache file does not exist", async () => {
    const cachePath = await temporaryCachePath()
    expect(await loadHarnessVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("resolves to an empty record for a corrupt cache file rather than throwing", async () => {
    const cachePath = await temporaryCachePath()
    await writeFile(cachePath, "{not valid json", "utf8")
    expect(await loadHarnessVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("creates parent directories on save", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-harness-version-cache-test-"))
    temporaryRoots.push(root)
    const cachePath = path.join(root, "nested", "deeper", "harness-version-cache.json")
    await saveHarnessVersionCache(cachePath, { schemaVersion: 1, entries: {} })
    expect(await loadHarnessVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })
})

describe("parseHarnessVersionCacheRecord", () => {
  it("drops an entry with a malformed result rather than failing the whole record", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      entries: {
        good: { result: { kind: "known-latest", installed: "1.0.0", latest: "1.0.0" }, checkedAt: 1000 },
        bad: { result: { nonsense: true }, checkedAt: 1000 },
      },
    })
    expect(parseHarnessVersionCacheRecord(source)).toEqual({
      schemaVersion: 1,
      entries: { good: { result: { kind: "known-latest", installed: "1.0.0", latest: "1.0.0" }, checkedAt: 1000 } },
    })
  })

  it("returns the empty record for an unrecognized schema version", () => {
    expect(parseHarnessVersionCacheRecord(JSON.stringify({ schemaVersion: 2, entries: {} }))).toEqual({
      schemaVersion: 1,
      entries: {},
    })
  })

  it("returns the empty record for a cache file over the size limit", () => {
    const bloated = JSON.stringify({ schemaVersion: 1, entries: {}, padding: "x".repeat(300 * 1024) })
    expect(parseHarnessVersionCacheRecord(bloated)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("preserves an unknown-latest result (installed known, latest architecturally unknowable) through a round trip", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      entries: { cpx: { result: { kind: "unknown-latest", installed: "1.0.82" }, checkedAt: 1000 } },
    })
    expect(parseHarnessVersionCacheRecord(source)).toEqual({
      schemaVersion: 1,
      entries: { cpx: { result: { kind: "unknown-latest", installed: "1.0.82" }, checkedAt: 1000 } },
    })
  })
})

describe("defaultAdminHarnessVersionCachePath", () => {
  it("uses XDG_CACHE_HOME and a distinct harness-version-cache filename", () => {
    expect(defaultAdminHarnessVersionCachePath({ XDG_CACHE_HOME: "/tmp/custom-cache" })).toBe(
      "/tmp/custom-cache/trellage/trx-admin/harness-version-cache.json",
    )
  })
})

describe("isHarnessVersionCacheStale", () => {
  it("treats a missing entry as stale", () => {
    expect(isHarnessVersionCacheStale(undefined, 1000)).toBe(true)
  })

  it("treats a fresh entry as not stale", () => {
    const entry: AdminHarnessVersionCacheEntry = { result: { kind: "known-latest", installed: "1.0.0", latest: "1.0.0" }, checkedAt: 1000 }
    expect(isHarnessVersionCacheStale(entry, 1000 + harnessVersionCacheTtlMs - 1)).toBe(false)
  })

  it("treats an entry past the 24h TTL as stale", () => {
    const entry: AdminHarnessVersionCacheEntry = { result: { kind: "known-latest", installed: "1.0.0", latest: "1.0.0" }, checkedAt: 1000 }
    expect(isHarnessVersionCacheStale(entry, 1000 + harnessVersionCacheTtlMs)).toBe(true)
  })

  it("treats an unavailable result as stale even well within the TTL, so it is retried automatically", () => {
    const entry: AdminHarnessVersionCacheEntry = { result: { kind: "unavailable", diagnostic: "boom" }, checkedAt: 1000 }
    expect(isHarnessVersionCacheStale(entry, 1000 + 1)).toBe(true)
  })

  it("treats an unknown-latest result as fresh (not unavailable), since it is a legitimate architectural limit, not a failure", () => {
    const entry: AdminHarnessVersionCacheEntry = { result: { kind: "unknown-latest", installed: "1.0.82" }, checkedAt: 1000 }
    expect(isHarnessVersionCacheStale(entry, 1000 + 1)).toBe(false)
  })
})
