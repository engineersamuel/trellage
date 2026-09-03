import { describe, expect, it } from "vitest"

import type { AdminHarnessVersionCacheRecord } from "../src/admin-harness-version-cache.js"
import { harnessVersionRefFor, harnessVersionResultForLauncher, runBatchedHarnessVersionChecks } from "../src/admin-harness-version-scheduler.js"
import type { AdminProfileEntry } from "../src/admin-model.js"
import { AdminRunManager } from "../src/admin-run-manager.js"
import { CommandRunnerError, type CommandRunOptions, type CommandRunner, type CommandRunResult } from "../src/guide-launch.js"

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
  ref: overrides.ref ?? "native:omp/local",
  surface: "native",
  launcher: "omp",
  harness: "oh-my-pi",
  name: "local",
  description: "Oh My Pi native profile.",
  commandPath: "/opt/trellage/omp/bin/omp",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

const knownLatest = (): CommandRunResult => ({
  stdout: JSON.stringify({ schemaVersion: 1, launcher: "omp", harness: "oh-my-pi", installed: "18.1.1", latest: "18.1.1", latestKnown: true }),
  stderr: "",
  exitCode: 0,
})

const emptyCache: AdminHarnessVersionCacheRecord = { schemaVersion: 1, entries: {} }

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

describe("runBatchedHarnessVersionChecks", () => {
  it("runs exactly one check for two profiles sharing the same launcher (dedup by launcher, not by ref)", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:omp/local", name: "local" }), entry({ ref: "native:omp/copilot", name: "copilot" })]

    const batch = runBatchedHarnessVersionChecks(entries, manager, emptyCache)
    await flush()
    expect(runner.calls.length).toBe(1)
    runner.resolveNext(knownLatest())
    await batch

    expect(runner.calls).toEqual([{ executable: "/opt/trellage/omp/bin/omp", args: ["harness-version"] }])
  })

  it("skips a launcher whose cache entry is still fresh", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const freshCache: AdminHarnessVersionCacheRecord = {
      schemaVersion: 1,
      entries: { omp: { result: { kind: "known-latest", installed: "18.1.1", latest: "18.1.1" }, checkedAt: Date.now() } },
    }

    await runBatchedHarnessVersionChecks(entries, manager, freshCache)
    expect(runner.calls.length).toBe(0)
    expect(manager.status(harnessVersionRefFor("omp")).state).toBe("idle")
  })

  it("checks a launcher whose cache entry is stale", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const staleCache: AdminHarnessVersionCacheRecord = {
      schemaVersion: 1,
      entries: {
        omp: { result: { kind: "known-latest", installed: "18.1.1", latest: "18.1.1" }, checkedAt: Date.now() - 25 * 60 * 60 * 1000 },
      },
    }

    const batch = runBatchedHarnessVersionChecks(entries, manager, staleCache)
    await flush()
    runner.resolveNext(knownLatest())
    await batch

    expect(runner.calls.length).toBe(1)
  })

  it("never checks a launcher that does not support harness-version", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:fmx/default", launcher: "fmx", harnessVersionSupported: false })]

    await runBatchedHarnessVersionChecks(entries, manager, emptyCache)
    expect(runner.calls.length).toBe(0)
  })

  it("isolates one launcher's failure from another launcher's result", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [
      entry({ ref: "native:omp/local", launcher: "omp", commandPath: "/opt/trellage/omp/bin/omp" }),
      entry({ ref: "native:picx/default", launcher: "picx", commandPath: "/opt/trellage/picx/bin/picx" }),
    ]

    const batch = runBatchedHarnessVersionChecks(entries, manager, emptyCache, { maxConcurrent: 1 })
    await flush()
    runner.rejectNext(new Error("boom"))
    await flush()
    runner.resolveNext(knownLatest())
    await batch

    expect(manager.status(harnessVersionRefFor("omp")).state).toBe("failure")
    expect(manager.status(harnessVersionRefFor("picx")).state).toBe("success")
  })

  it("bypasses a fresh cache entry when forceResync is set", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({})]
    const freshCache: AdminHarnessVersionCacheRecord = {
      schemaVersion: 1,
      entries: { omp: { result: { kind: "known-latest", installed: "18.1.1", latest: "18.1.1" }, checkedAt: Date.now() } },
    }

    const batch = runBatchedHarnessVersionChecks(entries, manager, freshCache, { forceResync: true })
    await flush()
    runner.resolveNext(knownLatest())
    await batch

    expect(runner.calls.length).toBe(1)
  })

  it("invokes onResult exactly once per checked launcher with the parsed result", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:omp/local" }), entry({ ref: "native:omp/copilot", name: "copilot" })]
    const results: Array<{ launcher: string; result: unknown }> = []

    const batch = runBatchedHarnessVersionChecks(entries, manager, emptyCache, {
      onResult: (launcher, cacheEntry) => results.push({ launcher, result: cacheEntry.result }),
    })
    await flush()
    runner.resolveNext(knownLatest())
    await batch

    expect(results).toHaveLength(1)
    expect(results[0]!.launcher).toBe("omp")
    expect(results[0]!.result).toEqual({ kind: "known-latest", installed: "18.1.1", latest: "18.1.1" })
  })

  it("resolves immediately when nothing is scheduled", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    await expect(runBatchedHarnessVersionChecks([], manager, emptyCache)).resolves.toBeUndefined()
    expect(runner.calls.length).toBe(0)
  })
})

describe("harnessVersionResultForLauncher", () => {
  it("returns undefined when no check has run yet this session", () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    expect(harnessVersionResultForLauncher("omp", manager)).toBeUndefined()
  })

  it("returns the parsed result once a check succeeds", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const batch = runBatchedHarnessVersionChecks([entry({})], manager, emptyCache)
    await flush()
    runner.resolveNext(knownLatest())
    await batch

    expect(harnessVersionResultForLauncher("omp", manager)).toEqual({ kind: "known-latest", installed: "18.1.1", latest: "18.1.1" })
  })

  it("returns an unavailable result when the run itself fails", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const batch = runBatchedHarnessVersionChecks([entry({})], manager, emptyCache)
    await flush()
    runner.rejectNext(new Error("boom"))
    await batch

    expect(harnessVersionResultForLauncher("omp", manager)).toMatchObject({ kind: "unavailable" })
  })

  it("returns an unavailable result for a non-zero exit whose stdout does not parse", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const batch = runBatchedHarnessVersionChecks([entry({})], manager, emptyCache)
    await flush()
    runner.rejectNext(
      new CommandRunnerError({
        kind: "exited",
        executable: "/opt/trellage/omp/bin/omp",
        args: ["harness-version"],
        stdout: "",
        stderr: "omp: mise is not installed",
        exitCode: 1,
        message: "command exited with status 1",
      }),
    )
    await batch

    expect(harnessVersionResultForLauncher("omp", manager)).toMatchObject({
      kind: "unavailable",
      diagnostic: "harness-version failure: omp: mise is not installed",
    })
  })
})
