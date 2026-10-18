import { describe, expect, it } from "vitest"

import type {
  AdminHarnessVersionCacheEntry,
  AdminHarnessVersionCacheRecord,
} from "../src/admin-harness-version-cache.ts"
import {
  harnessVersionRefFor,
  harnessVersionOperations,
  harnessVersionResultForOperation,
  runBatchedHarnessVersionChecks,
} from "../src/admin-harness-version-scheduler.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import type { CommandRunOptions, CommandRunner, CommandRunResult } from "../src/guide-launch.ts"

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
  commandPath: "/opt/trellage/omp/bin/trx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
  profiles: overrides.profiles ?? [overrides.name ?? "local"],
  lifecycle: Object.hasOwn(overrides, "lifecycle") ? overrides.lifecycle! : { runtime: "omp", profile: overrides.name ?? "local" },
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
  it("uses a lifecycle-backed row as the single shared-runtime probe", () => {
    const config = nativeEntry({ ref: "native:omp/awesome", name: "awesome", profiles: ["awesome"], lifecycle: null })
    const preset = nativeEntry({ ref: "native:omp/default", name: "default", profiles: ["default"] })
    expect(harnessVersionOperations([config, preset]).map((operation) => operation.entry.ref)).toEqual([preset.ref])
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

  it("keeps independent success when another operation and its retry fail", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const settled: Array<{ key: string; result: AdminHarnessVersionCacheEntry }> = []
    const batch = runBatchedHarnessVersionChecks(
      [
        nativeEntry({
          ref: "native:copilot/default",
          launcher: "copilot",
          harness: "copilot",
          commandPath: "/opt/trellage/copilot/bin/trx",
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

    expect(manager.status(harnessVersionRefFor("native:copilot")).state).toBe("failure")
    expect(manager.status(harnessVersionRefFor("native:omp")).state).toBe("success")
    expect(settled.some(({ key, result }) => key === "native:omp" && result.result.latest.kind === "known")).toBe(true)
  })

  it("resolves immediately when no operation is supported", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    await expect(
      runBatchedHarnessVersionChecks(
        [nativeEntry({ launcher: "agency", harnessVersionSupported: false })],
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
