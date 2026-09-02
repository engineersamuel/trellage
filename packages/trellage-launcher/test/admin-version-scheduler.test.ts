import { describe, expect, it } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.js"
import { AdminRunManager } from "../src/admin-run-manager.js"
import type { AdminVersionCacheRecord } from "../src/admin-version-cache.js"
import { runBatchedVersionChecks, updateCheckRefFor, versionCheckResultForEntry } from "../src/admin-version-scheduler.js"
import type { CommandRunOptions, CommandRunner, CommandRunResult } from "../src/guide-launch.js"

/** A controllable fake runner: each `run()` call gets its own deferred resolve/reject, released manually by the test. */
class DeferredRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string> }> = []
  private readonly pending: Array<{ resolve: (value: CommandRunResult) => void; reject: (error: unknown) => void }> = []

  run(executable: string, args: ReadonlyArray<string>, _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args })
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  resolveNext(result: CommandRunResult): void {
    const entry = this.pending.shift()
    if (entry === undefined) throw new Error("no pending run to resolve")
    entry.resolve(result)
  }

  rejectNext(error: unknown): void {
    const entry = this.pending.shift()
    if (entry === undefined) throw new Error("no pending run to reject")
    entry.reject(error)
  }

  get pendingCount(): number {
    return this.pending.length
  }
}

const entry = (overrides: Partial<AdminProfileEntry>): AdminProfileEntry => ({
  ref: overrides.ref ?? "native:prx/default",
  surface: "native",
  launcher: "prx",
  harness: "prime",
  name: "default",
  description: "Prime native launcher.",
  commandPath: "/opt/trellage/prx/bin/prx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  updateCheckStale: false,
  version: "0.8.1",
  ...overrides,
})

const current = (): CommandRunResult => ({ stdout: "prx update: 0.8.1 is current", stderr: "", exitCode: 0 })
const emptyCache: AdminVersionCacheRecord = { schemaVersion: 1, entries: {} }

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

describe("runBatchedVersionChecks", () => {
  it("skips a profile whose cache entry is still fresh", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const freshCache: AdminVersionCacheRecord = {
      schemaVersion: 1,
      entries: { "native:prx/default": { result: { current: true }, checkedAt: Date.now() } },
    }

    await runBatchedVersionChecks(entries, manager, freshCache)
    expect(runner.calls.length).toBe(0)
    expect(manager.status(updateCheckRefFor(entries[0]!.ref)).state).toBe("idle")
  })

  it("checks a profile whose cache entry is missing", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]

    const batch = runBatchedVersionChecks(entries, manager, emptyCache)
    await flush()
    runner.resolveNext(current())
    await batch

    expect(runner.calls).toEqual([{ executable: "/opt/trellage/prx/bin/prx", args: ["update", "--check", "default"] }])
    expect(manager.status(updateCheckRefFor(entries[0]!.ref)).state).toBe("success")
  })

  it("checks a profile whose cache entry is stale", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const staleCache: AdminVersionCacheRecord = {
      schemaVersion: 1,
      entries: { "native:prx/default": { result: { current: true }, checkedAt: Date.now() - 25 * 60 * 60 * 1000 } },
    }

    const batch = runBatchedVersionChecks(entries, manager, staleCache)
    await flush()
    runner.resolveNext(current())
    await batch

    expect(runner.calls.length).toBe(1)
  })

  it("never checks a profile that does not support update --check", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:cldx/default", launcher: "cldx", updateCheckSupported: false })]

    await runBatchedVersionChecks(entries, manager, emptyCache)
    expect(runner.calls.length).toBe(0)
  })

  it("isolates one profile's failure from another profile's result", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:prx/a", name: "a" }), entry({ ref: "native:prx/b", name: "b" })]

    const batch = runBatchedVersionChecks(entries, manager, emptyCache, { maxConcurrent: 1 })
    await flush()
    runner.rejectNext(new Error("boom"))
    await flush()
    runner.resolveNext(current())
    await batch

    expect(manager.status(updateCheckRefFor("native:prx/a")).state).toBe("failure")
    expect(manager.status(updateCheckRefFor("native:prx/b")).state).toBe("success")
  })

  it("bypasses a fresh cache entry when forceResync is set", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const freshCache: AdminVersionCacheRecord = {
      schemaVersion: 1,
      entries: { "native:prx/default": { result: { current: true }, checkedAt: Date.now() } },
    }

    const batch = runBatchedVersionChecks(entries, manager, freshCache, { forceResync: true })
    await flush()
    runner.resolveNext(current())
    await batch

    expect(runner.calls.length).toBe(1)
  })

  it("invokes onResult exactly once per checked profile with the parsed result", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const results: Array<{ ref: string; entry: { result: unknown; checkedAt: number } }> = []

    const batch = runBatchedVersionChecks(entries, manager, emptyCache, {
      onResult: (ref, cacheEntry) => results.push({ ref, entry: cacheEntry }),
    })
    await flush()
    runner.resolveNext(current())
    await batch

    expect(results).toHaveLength(1)
    expect(results[0]!.ref).toBe("native:prx/default")
    expect(results[0]!.entry.result).toEqual({ current: true })
  })

  it("resolves immediately when nothing is scheduled", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    await expect(runBatchedVersionChecks([], manager, emptyCache)).resolves.toBeUndefined()
    expect(runner.calls.length).toBe(0)
  })
})

describe("versionCheckResultForEntry", () => {
  it("returns undefined when no check has run yet this session", () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    expect(versionCheckResultForEntry(entry({}), manager)).toBeUndefined()
  })

  it("returns the parsed result once a check succeeds", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const target = entry({})
    const batch = runBatchedVersionChecks([target], manager, emptyCache)
    await flush()
    runner.resolveNext(current())
    await batch

    expect(versionCheckResultForEntry(target, manager)).toEqual({ current: true })
  })

  it("returns a malformed result when the run itself fails", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const target = entry({})
    const batch = runBatchedVersionChecks([target], manager, emptyCache)
    await flush()
    runner.rejectNext(new Error("boom"))
    await batch

    expect(versionCheckResultForEntry(target, manager)).toMatchObject({ malformed: true })
  })
})
