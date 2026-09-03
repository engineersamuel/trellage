import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  cachedLatestVersion,
  harnessLatestVersionCacheKey,
  harnessLatestVersionCachePath,
  harnessLatestVersionCacheTtlMs,
  loadHarnessLatestVersionCache,
  parseHarnessLatestVersionCacheRecord,
  recordLatestVersion,
  type HarnessLatestVersionCacheRecord,
} from "../src/harness-latest-version-cache.js"

const temporaryRoots: string[] = []

const temporaryXdgCacheHome = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-harness-latest-version-cache-test-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("harnessLatestVersionCacheKey", () => {
  it("keys by harness kind and platform together", () => {
    expect(harnessLatestVersionCacheKey("claude", "linux/arm64")).toBe("claude:linux/arm64")
    expect(harnessLatestVersionCacheKey("claude", "linux/amd64")).toBe("claude:linux/amd64")
    expect(harnessLatestVersionCacheKey("codex", "linux/arm64")).toBe("codex:linux/arm64")
  })
})

describe("recordLatestVersion / loadHarnessLatestVersionCache", () => {
  it("round-trips a recorded version, keyed by harness kind and platform", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    await recordLatestVersion(xdgCacheHome, "claude", "linux/arm64", "2.1.259", 1000)

    const record = await loadHarnessLatestVersionCache(harnessLatestVersionCachePath(xdgCacheHome))
    expect(record).toEqual({
      schemaVersion: 1,
      entries: { "claude:linux/arm64": { version: "2.1.259", checkedAt: 1000 } },
    })
  })

  it("preserves an existing entry for a different harness kind when recording a new one", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    await recordLatestVersion(xdgCacheHome, "claude", "linux/arm64", "2.1.259", 1000)
    await recordLatestVersion(xdgCacheHome, "codex", "linux/arm64", "0.153.0", 2000)

    const record = await loadHarnessLatestVersionCache(harnessLatestVersionCachePath(xdgCacheHome))
    expect(record).toEqual({
      schemaVersion: 1,
      entries: {
        "claude:linux/arm64": { version: "2.1.259", checkedAt: 1000 },
        "codex:linux/arm64": { version: "0.153.0", checkedAt: 2000 },
      },
    })
  })

  it("preserves independently completed entries when different harness kinds write concurrently", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    await Promise.all([
      recordLatestVersion(xdgCacheHome, "claude", "linux/arm64", "2.1.259", 1000),
      recordLatestVersion(xdgCacheHome, "codex", "linux/arm64", "0.153.0", 2000),
      recordLatestVersion(xdgCacheHome, "copilot", "linux/arm64", "1.0.90", 3000),
    ])

    const record = await loadHarnessLatestVersionCache(harnessLatestVersionCachePath(xdgCacheHome))
    expect(record.entries).toEqual({
      "claude:linux/arm64": { version: "2.1.259", checkedAt: 1000 },
      "codex:linux/arm64": { version: "0.153.0", checkedAt: 2000 },
      "copilot:linux/arm64": { version: "1.0.90", checkedAt: 3000 },
    })
  })

  it("overwrites a stale entry for the same harness kind and platform", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    await recordLatestVersion(xdgCacheHome, "claude", "linux/arm64", "2.1.252", 1000)
    await recordLatestVersion(xdgCacheHome, "claude", "linux/arm64", "2.1.259", 2000)

    const record = await loadHarnessLatestVersionCache(harnessLatestVersionCachePath(xdgCacheHome))
    expect(record).toEqual({
      schemaVersion: 1,
      entries: { "claude:linux/arm64": { version: "2.1.259", checkedAt: 2000 } },
    })
  })

  it("resolves to an empty record when the cache file does not exist", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    const record = await loadHarnessLatestVersionCache(harnessLatestVersionCachePath(xdgCacheHome))
    expect(record).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("resolves to an empty record for a corrupt cache file rather than throwing", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    const cachePath = harnessLatestVersionCachePath(xdgCacheHome)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, "{not valid json", "utf8")
    expect(await loadHarnessLatestVersionCache(cachePath)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("never throws when the cache directory cannot be created", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-harness-latest-version-cache-test-"))
    temporaryRoots.push(root)
    const blockingFile = path.join(root, "blocked-by-a-file")
    await writeFile(blockingFile, "not a directory", "utf8")
    await expect(recordLatestVersion(blockingFile, "claude", "linux/arm64", "2.1.259", 1000)).resolves.toBeUndefined()
  })
})

describe("parseHarnessLatestVersionCacheRecord", () => {
  it("drops an entry with a malformed version rather than failing the whole record", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      entries: {
        "claude:linux/arm64": { version: "2.1.259", checkedAt: 1000 },
        "codex:linux/arm64": { version: "", checkedAt: 1000 },
      },
    })
    expect(parseHarnessLatestVersionCacheRecord(source)).toEqual({
      schemaVersion: 1,
      entries: { "claude:linux/arm64": { version: "2.1.259", checkedAt: 1000 } },
    })
  })

  it("returns the empty record for an unrecognized schema version", () => {
    const source = JSON.stringify({ schemaVersion: 2, entries: {} })
    expect(parseHarnessLatestVersionCacheRecord(source)).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("returns the empty record for malformed JSON", () => {
    expect(parseHarnessLatestVersionCacheRecord("{not valid json")).toEqual({ schemaVersion: 1, entries: {} })
  })

  it("returns the empty record for an oversized cache file", () => {
    const oversized: HarnessLatestVersionCacheRecord = {
      schemaVersion: 1,
      entries: { "claude:linux/arm64": { version: "x".repeat(70_000), checkedAt: 1000 } },
    }
    expect(parseHarnessLatestVersionCacheRecord(JSON.stringify(oversized))).toEqual({ schemaVersion: 1, entries: {} })
  })
})

describe("cachedLatestVersion", () => {
  const record: HarnessLatestVersionCacheRecord = {
    schemaVersion: 1,
    entries: { "claude:linux/arm64": { version: "2.1.259", checkedAt: 1000 } },
  }

  it("returns the cached version when the entry is within the TTL", () => {
    expect(cachedLatestVersion(record, "claude", "linux/arm64", 1000 + harnessLatestVersionCacheTtlMs - 1)).toBe(
      "2.1.259",
    )
  })

  it("returns undefined once the entry's TTL has elapsed", () => {
    expect(cachedLatestVersion(record, "claude", "linux/arm64", 1000 + harnessLatestVersionCacheTtlMs)).toBeUndefined()
  })

  it("returns undefined for a harness kind with no cached entry", () => {
    expect(cachedLatestVersion(record, "codex", "linux/arm64", 1000)).toBeUndefined()
  })

  it("returns undefined for the same harness kind on a different platform", () => {
    expect(cachedLatestVersion(record, "claude", "linux/amd64", 1000)).toBeUndefined()
  })
})
