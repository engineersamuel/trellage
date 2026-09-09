import { describe, expect, it } from "vitest"

import type {
  AdminHarnessVersionCacheEntry,
  AdminHarnessVersionCacheRecord,
} from "../src/admin-harness-version-cache.js"
import {
  harnessVersionRefFor,
  harnessVersionResultForOperation,
  runBatchedHarnessVersionChecks,
} from "../src/admin-harness-version-scheduler.js"
import type { AdminProfileEntry } from "../src/admin-model.js"
import { AdminRunManager } from "../src/admin-run-manager.js"
import type { CommandRunOptions, CommandRunner, CommandRunResult } from "../src/guide-launch.js"

class DeferredRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string> }> = []
  private readonly pending: Array<{
    resolve: (value: CommandRunResult) => void
    reject: (error: unknown) => void
  }> = []

  run(executable: string, args: ReadonlyArray<string>, _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args })
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  resolveNext(result: CommandRunResult): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error("no pending run to resolve")
    pending.resolve(result)
  }

  rejectNext(error: unknown): void {
    const pending = this.pending.shift()
    if (pending === undefined) throw new Error("no pending run to reject")
    pending.reject(error)
  }
}

const nativeEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "native:omp/local",
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

const sandboxEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "sandbox:claude-blog",
  surface: "sandbox",
  harness: "claude",
  name: "claude-blog",
  description: "Sandboxed Claude profile.",
  commandPath: "/opt/trellage/bin/trellage",
  doctorSupported: true,
  inventorySupported: false,
  health: "healthy",
  install: "installed",
  version: "2.1.222",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

const runResult = (installed: string | null, latest: string | null, latestDiagnostic?: string): CommandRunResult => ({
  stdout: JSON.stringify({
    schemaVersion: 1,
    installed,
    latest,
    latestKnown: latest !== null,
    ...(latestDiagnostic === undefined ? {} : { latestDiagnostic }),
  }),
  stderr: "",
  exitCode: 0,
})

const emptyCache = (): AdminHarnessVersionCacheRecord => ({ schemaVersion: 2, entries: {} })

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

describe("runBatchedHarnessVersionChecks", () => {
  it("runs one Claude latest lookup for multiple sandbox profiles", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const results: Record<string, AdminHarnessVersionCacheEntry> = {}
    const batch = runBatchedHarnessVersionChecks(
      [
        sandboxEntry(),
        sandboxEntry({
          ref: "sandbox:claude-docs",
          name: "claude-docs",
          version: "2.1.220",
        }),
      ],
      manager,
      emptyCache(),
      { onResult: (key, result) => (results[key] = result) },
    )

    await flush()
    expect(runner.calls).toEqual([
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["harness-version", "claude-blog"],
      },
    ])
    runner.resolveNext(runResult(null, "2.1.259"))
    await batch

    expect(results["sandbox:claude-code"]?.result.latest).toEqual({
      kind: "known",
      version: "2.1.259",
    })
  })

  it("prefers an already-required native latest producer and suppresses its sandbox fallback", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const batch = runBatchedHarnessVersionChecks(
      [nativeEntry(), sandboxEntry({ ref: "sandbox:pi", harness: "pi", name: "pi" })],
      manager,
      emptyCache(),
    )

    await flush()
    expect(runner.calls).toEqual([{ executable: "/opt/trellage/omp/bin/omp", args: ["harness-version"] }])
    runner.resolveNext(runResult("18.1.1", "18.1.2"))
    await batch

    expect(runner.calls).toHaveLength(1)
    expect(manager.status(harnessVersionRefFor("sandbox:oh-my-pi")).state).toBe("idle")
  })

  it("retries a failed primary once, then runs one sandbox fallback", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const batch = runBatchedHarnessVersionChecks(
      [nativeEntry(), sandboxEntry({ ref: "sandbox:pi", harness: "pi", name: "pi" })],
      manager,
      emptyCache(),
    )

    await flush()
    runner.resolveNext(runResult("18.1.1", null, "npm registry unavailable"))
    await flush()
    expect(runner.calls).toHaveLength(2)
    runner.resolveNext(runResult("18.1.1", null, "npm registry unavailable"))
    await flush()
    expect(runner.calls).toHaveLength(3)
    runner.resolveNext(runResult(null, "18.1.2"))
    await batch

    expect(runner.calls).toEqual([
      { executable: "/opt/trellage/omp/bin/omp", args: ["harness-version"] },
      { executable: "/opt/trellage/omp/bin/omp", args: ["harness-version"] },
      { executable: "/opt/trellage/bin/trellage", args: ["harness-version", "pi"] },
    ])
  })

  it("preserves successful installed and latest dimensions across a bounded retry", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const settled: AdminHarnessVersionCacheEntry[] = []
    const batch = runBatchedHarnessVersionChecks([nativeEntry()], manager, emptyCache(), {
      onResult: (_key, result) => settled.push(result),
    })

    await flush()
    runner.resolveNext(runResult("18.1.1", null, "npm registry unavailable"))
    await flush()
    runner.resolveNext(runResult(null, "18.1.2"))
    await batch

    expect(settled.at(-1)?.result).toEqual({
      installed: { kind: "known", version: "18.1.1" },
      latest: { kind: "known", version: "18.1.2" },
    })
  })

  it("bypasses both admin and CLI latest caches during force refresh", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const now = Date.now()
    const cache: AdminHarnessVersionCacheRecord = {
      schemaVersion: 2,
      entries: {
        "sandbox:claude-code": {
          checkedAt: now,
          result: {
            installed: { kind: "unavailable", diagnostic: "representative unresolved" },
            latest: { kind: "known", version: "2.1.258" },
          },
        },
      },
    }
    const batch = runBatchedHarnessVersionChecks([sandboxEntry()], manager, cache, {
      forceResync: true,
      now: () => now,
    })

    await flush()
    expect(runner.calls).toEqual([
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["harness-version", "claude-blog", "--refresh-latest"],
      },
    ])
    runner.resolveNext(runResult(null, "2.1.259"))
    await batch
  })

  it("can force an installed-version refresh while reusing the CLI latest cache", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const batch = runBatchedHarnessVersionChecks([sandboxEntry()], manager, emptyCache(), {
      forceResync: true,
      refreshLatest: false,
    })

    await flush()
    expect(runner.calls).toEqual([
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["harness-version", "claude-blog"],
      },
    ])
    runner.resolveNext(runResult("2.1.260", "2.1.260"))
    await batch
  })

  it("uses the selected sandbox profile as the sole force-refresh latest producer", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const first = sandboxEntry({ ref: "sandbox:pi-alpha", harness: "pi", name: "pi-alpha", version: "18.1.0" })
    const selected = sandboxEntry({
      ref: "sandbox:pi-selected",
      harness: "pi",
      name: "pi-selected",
      version: "18.1.1",
    })
    const sources: string[] = []
    const batch = runBatchedHarnessVersionChecks([nativeEntry(), first, selected], manager, emptyCache(), {
      forceResync: true,
      selectedEntryRef: selected.ref,
      onResult: (_key, _result, source) => sources.push(source.ref),
    })

    await flush()
    expect(runner.calls).toEqual([
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["harness-version", "pi-selected", "--refresh-latest"],
      },
    ])
    runner.resolveNext(runResult("18.1.1", "18.1.2"))
    await batch
    expect(sources).toEqual(["sandbox:pi-selected"])
  })

  it("reuses complete fresh operation results", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const now = Date.now()
    const cpx = nativeEntry({
      ref: "native:cpx/default",
      launcher: "cpx",
      harness: "copilot",
      name: "default",
    })
    const sandbox = sandboxEntry({
      ref: "sandbox:copilot-awesome",
      harness: "copilot",
      name: "copilot-awesome",
      version: "1.0.70",
    })
    const cache: AdminHarnessVersionCacheRecord = {
      schemaVersion: 2,
      entries: {
        "native:cpx": {
          checkedAt: now - 1000,
          result: {
            installed: { kind: "known", version: "1.0.82" },
            latest: { kind: "unsupported" },
          },
        },
        "sandbox:copilot-cli": {
          checkedAt: now - 1000,
          result: {
            installed: { kind: "unavailable", diagnostic: "representative unresolved" },
            latest: { kind: "known", version: "1.0.90" },
          },
        },
      },
    }

    await runBatchedHarnessVersionChecks([cpx, sandbox], manager, cache, { now: () => now })
    expect(runner.calls).toEqual([])
  })

  it("keeps independent success when another operation and its retry fail", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const settled: Array<{ key: string; result: AdminHarnessVersionCacheEntry }> = []
    const batch = runBatchedHarnessVersionChecks(
      [
        nativeEntry({
          ref: "native:cpx/default",
          launcher: "cpx",
          harness: "copilot",
          commandPath: "/opt/trellage/cpx/bin/cpx",
        }),
        nativeEntry(),
      ],
      manager,
      emptyCache(),
      {
        maxConcurrent: 1,
        onResult: (key, result) => settled.push({ key, result }),
      },
    )

    await flush()
    runner.rejectNext(new Error("copilot executable failed"))
    await flush()
    runner.resolveNext(runResult("18.1.1", "18.1.2"))
    await flush()
    runner.rejectNext(new Error("copilot executable still failed"))
    await batch

    expect(manager.status(harnessVersionRefFor("native:cpx")).state).toBe("failure")
    expect(manager.status(harnessVersionRefFor("native:omp")).state).toBe("success")
    expect(settled.some(({ key, result }) => key === "native:omp" && result.result.latest.kind === "known")).toBe(true)
  })

  it("resolves immediately when no operation is supported", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    await expect(
      runBatchedHarnessVersionChecks(
        [nativeEntry({ launcher: "agx", harnessVersionSupported: false })],
        manager,
        emptyCache(),
      ),
    ).resolves.toBeUndefined()
    expect(runner.calls).toEqual([])
  })
})

describe("harnessVersionResultForOperation", () => {
  it("is absent until an operation has run and parses its eventual result", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    expect(harnessVersionResultForOperation("native:omp", manager)).toBeUndefined()

    const batch = runBatchedHarnessVersionChecks([nativeEntry()], manager, emptyCache())
    await flush()
    runner.resolveNext(runResult("18.1.1", "18.1.2"))
    await batch

    expect(harnessVersionResultForOperation("native:omp", manager)).toEqual({
      installed: { kind: "known", version: "18.1.1" },
      latest: { kind: "known", version: "18.1.2" },
    })
  })
})
