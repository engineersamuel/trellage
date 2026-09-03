import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  createHarnessVersionCacheSaveQueue,
  harnessVersionCacheTtlMs,
  isHarnessVersionCacheStale,
  loadHarnessVersionCache,
  parseHarnessVersionCacheRecord,
  saveHarnessVersionCache,
  type AdminHarnessVersionCacheEntry,
  type AdminHarnessVersionCacheRecord,
} from "../src/admin-harness-version-cache.js"
import type { AdminHarnessVersionResult } from "../src/admin-harness-version.js"

const roots: string[] = []

const cachePath = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-admin-harness-cache-"))
  roots.push(root)
  return path.join(root, "harness-version-cache.json")
}

const knownResult = (installed = "1.0.0", latest = "1.0.1"): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "known", version: latest },
})

const unsupportedResult = (): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: "1.0.82" },
  latest: { kind: "unsupported" },
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe("harness version cache schema", () => {
  it("ignores the incompatible schema-1 cache instead of guessing new identities", () => {
    expect(
      parseHarnessVersionCacheRecord(
        JSON.stringify({
          schemaVersion: 1,
          entries: {
            "native:omp/local": {
              checkedAt: 1000,
              result: { kind: "known-latest", installed: "18.1.1", latest: "18.1.2" },
            },
          },
        }),
      ),
    ).toEqual({ schemaVersion: 2, entries: {} })
  })

  it("round trips independent installed and latest states", async () => {
    const filePath = await cachePath()
    const cache: AdminHarnessVersionCacheRecord = {
      schemaVersion: 2,
      entries: {
        "native:grx": {
          checkedAt: 1000,
          result: {
            installed: { kind: "known", version: "1.0.3" },
            latest: { kind: "failed", diagnostic: "release service unavailable" },
          },
        },
        "sandbox:claude-code": {
          checkedAt: 2000,
          result: {
            installed: { kind: "unavailable", diagnostic: "representative is unresolved" },
            latest: { kind: "known", version: "2.1.259" },
          },
        },
      },
    }

    await saveHarnessVersionCache(filePath, cache)
    await expect(loadHarnessVersionCache(filePath)).resolves.toEqual(cache)
  })

  it("drops malformed entries while preserving valid peers", () => {
    expect(
      parseHarnessVersionCacheRecord(
        JSON.stringify({
          schemaVersion: 2,
          entries: {
            valid: { checkedAt: 1000, result: knownResult() },
            malformed: {
              checkedAt: 1000,
              result: {
                installed: { kind: "known", version: "" },
                latest: { kind: "known", version: "1.0.1" },
              },
            },
          },
        }),
      ),
    ).toEqual({
      schemaVersion: 2,
      entries: {
        valid: { checkedAt: 1000, result: knownResult() },
      },
    })
  })

  it("returns an empty schema-2 record for a missing or corrupt file", async () => {
    const filePath = await cachePath()
    await expect(loadHarnessVersionCache(filePath)).resolves.toEqual({ schemaVersion: 2, entries: {} })
    await writeFile(filePath, "{not json", "utf8")
    await expect(loadHarnessVersionCache(filePath)).resolves.toEqual({ schemaVersion: 2, entries: {} })
  })

  it("writes atomically with schema 2", async () => {
    const filePath = await cachePath()
    await saveHarnessVersionCache(filePath, {
      schemaVersion: 2,
      entries: {
        "native:omp": { checkedAt: 1000, result: knownResult("18.1.1", "18.1.2") },
      },
    })

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as AdminHarnessVersionCacheRecord
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.entries["native:omp"]?.result).toEqual(knownResult("18.1.1", "18.1.2"))
  })
})

describe("harness version cache freshness", () => {
  const now = 1_000_000_000

  it("requires every state promised by the operation", () => {
    expect(
      isHarnessVersionCacheStale(
        {
          checkedAt: now - 1_000,
          result: {
            installed: { kind: "unavailable", diagnostic: "not installed" },
            latest: { kind: "known", version: "2.1.259" },
          },
        },
        now,
        { requiresInstalled: true, requiresLatest: true },
      ),
    ).toBe(true)
    expect(
      isHarnessVersionCacheStale(
        {
          checkedAt: now - 1_000,
          result: {
            installed: { kind: "known", version: "1.0.3" },
            latest: { kind: "failed", diagnostic: "network failure" },
          },
        },
        now,
        { requiresInstalled: true, requiresLatest: true },
      ),
    ).toBe(true)
  })

  it("accepts a sandbox latest result without requiring a representative installed version", () => {
    expect(
      isHarnessVersionCacheStale(
        {
          checkedAt: now - 1_000,
          result: {
            installed: { kind: "unavailable", diagnostic: "representative is unresolved" },
            latest: { kind: "known", version: "2.1.259" },
          },
        },
        now,
        { requiresInstalled: false, requiresLatest: true },
      ),
    ).toBe(false)
  })

  it("accepts intentional latest unsupported only when latest is not required", () => {
    const entry = { checkedAt: now - 1_000, result: unsupportedResult() }
    expect(
      isHarnessVersionCacheStale(entry, now, {
        requiresInstalled: true,
        requiresLatest: false,
      }),
    ).toBe(false)
    expect(
      isHarnessVersionCacheStale(entry, now, {
        requiresInstalled: true,
        requiresLatest: true,
      }),
    ).toBe(true)
  })

  it("expires complete results at the 24-hour boundary", () => {
    const entry: AdminHarnessVersionCacheEntry = {
      checkedAt: now - harnessVersionCacheTtlMs + 1,
      result: knownResult(),
    }
    expect(isHarnessVersionCacheStale(entry, now, { requiresLatest: true })).toBe(false)
    expect(
      isHarnessVersionCacheStale({ ...entry, checkedAt: now - harnessVersionCacheTtlMs }, now, {
        requiresLatest: true,
      }),
    ).toBe(true)
  })
})

describe("harness version cache publication", () => {
  it("serializes slow saves in enqueue order", async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const queue = createHarnessVersionCacheSaveQueue("/unused/cache.json", async (_path, cache) => {
      const key = Object.keys(cache.entries)[0] ?? "empty"
      events.push(`start:${key}`)
      if (key === "first") await firstMayFinish
      events.push(`finish:${key}`)
    })
    const first = queue.enqueue({
      schemaVersion: 2,
      entries: { first: { checkedAt: 1000, result: knownResult() } },
    })
    const second = queue.enqueue({
      schemaVersion: 2,
      entries: { second: { checkedAt: 2000, result: knownResult() } },
    })

    for (let tick = 0; tick < 10 && events.length === 0; tick += 1) {
      await Promise.resolve()
    }
    expect(events).toEqual(["start:first"])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(["start:first", "finish:first", "start:second", "finish:second"])
  })

  it("continues the queue after a failed save", async () => {
    const saved: string[] = []
    const queue = createHarnessVersionCacheSaveQueue("/unused/cache.json", async (_path, cache) => {
      const key = Object.keys(cache.entries)[0] ?? "empty"
      if (key === "first") throw new Error("disk full")
      saved.push(key)
    })

    const first = queue.enqueue({
      schemaVersion: 2,
      entries: { first: { checkedAt: 1000, result: knownResult() } },
    })
    const second = queue.enqueue({
      schemaVersion: 2,
      entries: { second: { checkedAt: 2000, result: knownResult() } },
    })

    await expect(first).rejects.toThrow("disk full")
    await expect(second).resolves.toBeUndefined()
    expect(saved).toEqual(["second"])
  })
})
