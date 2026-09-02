import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  defaultAdminVersionCachePath,
  isVersionCacheStale,
  loadVersionCache,
  parseVersionCacheRecord,
  saveVersionCache,
  versionCacheTtlMs,
  type AdminVersionCacheEntry,
  type AdminVersionCacheRecord,
} from "../src/admin-version-cache.js"

const temporaryRoots: string[] = []

const temporaryCachePath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-version-cache-test-"))
  temporaryRoots.push(root)
  return path.join(root, "version-cache.json")
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("loadVersionCache / saveVersionCache", () => {
  it("round-trips a saved record", async () => {
    const cachePath = await temporaryCachePath()
    const record = {
      schemaVersion: 1 as const,
      entries: {
        "native:prx:default": { result: { current: true }, checkedAt: 1000 },
        "native:jcx:default": { result: { current: false, latest: "2.0.0" }, checkedAt: 2000 },
      },
    } satisfies AdminVersionCacheRecord

    await saveVersionCache(cachePath, record)
    expect(await loadVersionCache(cachePath)).toEqual(record)
  })

  it("resolves to an empty record when the cache file does not exist", async () => {
    const cachePath = await temporaryCachePath()
    expect(await loadVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("resolves to an empty record for a corrupt cache file rather than throwing", async () => {
    const cachePath = await temporaryCachePath()
    await writeFile(cachePath, "{not valid json", "utf8")
    expect(await loadVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("creates parent directories on save", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-version-cache-test-"))
    temporaryRoots.push(root)
    const cachePath = path.join(root, "nested", "deeper", "version-cache.json")
    await saveVersionCache(cachePath, { schemaVersion: 1, entries: {} })
    expect(await loadVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })
})

describe("parseVersionCacheRecord", () => {
  it("drops an entry with a malformed result rather than failing the whole record", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      entries: {
        good: { result: { current: true }, checkedAt: 1000 },
        bad: { result: { nonsense: true }, checkedAt: 1000 },
      },
    })
    expect(parseVersionCacheRecord(source)).toEqual({
      schemaVersion: 1,
      entries: { good: { result: { current: true }, checkedAt: 1000 } },
    })
  })

  it("returns the empty record for an unrecognized schema version", () => {
    expect(parseVersionCacheRecord(JSON.stringify({ schemaVersion: 2, entries: {} }))).toEqual({
      schemaVersion: 1,
      entries: {},
    })
  })

  it("returns the empty record for a cache file over the size limit", () => {
    const bloated = JSON.stringify({ schemaVersion: 1, entries: {}, padding: "x".repeat(300 * 1024) })
    expect(parseVersionCacheRecord(bloated)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("preserves the installed version through a save/load round trip for both current and mismatched results", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      entries: {
        current: { result: { current: true, installed: "0.8.1" }, checkedAt: 1000 },
        stale: { result: { current: false, installed: "0.8.1", latest: "0.9.0" }, checkedAt: 2000 },
      },
    })
    expect(parseVersionCacheRecord(source)).toEqual({
      schemaVersion: 1,
      entries: {
        current: { result: { current: true, installed: "0.8.1" }, checkedAt: 1000 },
        stale: { result: { current: false, installed: "0.8.1", latest: "0.9.0" }, checkedAt: 2000 },
      },
    })
  })
})

describe("defaultAdminVersionCachePath", () => {
  it("uses XDG_CACHE_HOME and a distinct trx-admin subdirectory", () => {
    expect(defaultAdminVersionCachePath({ XDG_CACHE_HOME: "/tmp/custom-cache" })).toBe(
      "/tmp/custom-cache/trellage/trx-admin/version-cache.json",
    )
  })
})

describe("isVersionCacheStale", () => {
  it("treats a missing entry as stale", () => {
    expect(isVersionCacheStale(undefined, 1000)).toBe(true)
  })

  it("treats a fresh entry as not stale", () => {
    const entry: AdminVersionCacheEntry = { result: { current: true }, checkedAt: 1000 }
    expect(isVersionCacheStale(entry, 1000 + versionCacheTtlMs - 1)).toBe(false)
  })

  it("treats an entry past the 24h TTL as stale", () => {
    const entry: AdminVersionCacheEntry = { result: { current: true }, checkedAt: 1000 }
    expect(isVersionCacheStale(entry, 1000 + versionCacheTtlMs)).toBe(true)
  })

  it("treats a malformed result as stale even well within the TTL, so it is retried automatically", () => {
    const entry: AdminVersionCacheEntry = { result: { malformed: true, diagnostic: "boom" }, checkedAt: 1000 }
    expect(isVersionCacheStale(entry, 1000 + 1)).toBe(true)
  })
})
