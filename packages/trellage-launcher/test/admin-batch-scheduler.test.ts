import { describe, expect, it } from "vitest"

import type { CommandRunOptions, CommandRunner, CommandRunResult } from "../src/guide-launch.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import { runBatchedDoctorChecks } from "../src/admin-batch-scheduler.ts"

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
  ref: overrides.ref ?? "native:cpx/hve",
  surface: "native",
  launcher: "cpx",
  harness: "copilot",
  name: "hve",
  description: "Copilot native launcher.",
  commandPath: "/opt/trellage/cpx/bin/cpx",
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

const ok = (): CommandRunResult => ({ stdout: "healthy", stderr: "", exitCode: 0 })

describe("runBatchedDoctorChecks", () => {
  it("never runs more than maxConcurrent profiles at once", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry({ ref: `native:cpx/p${index}`, name: `p${index}` }),
    )

    const batch = runBatchedDoctorChecks(entries, manager, { maxConcurrent: 2 })
    await Promise.resolve()
    await Promise.resolve()

    expect(runner.pendingCount).toBe(2)
    const flush = async (): Promise<void> => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
    }

    runner.resolveNext(ok())
    await flush()
    expect(runner.pendingCount).toBe(2)

    // Drain the rest to let the batch settle.
    for (let i = 0; i < 5; i += 1) {
      runner.resolveNext(ok())
      await flush()
    }
    await batch
    expect(entries.every((item) => manager.status(item.ref).state === "success")).toBe(true)
  })

  it("skips entries that do not support doctor and never triggers them", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [
      entry({ ref: "native:cdx/pstack", launcher: "cdx", doctorSupported: false }),
      entry({ ref: "native:cpx/hve" }),
    ]

    const batch = runBatchedDoctorChecks(entries, manager, { maxConcurrent: 2 })
    await Promise.resolve()
    runner.resolveNext(ok())
    await batch

    expect(manager.status("native:cdx/pstack").state).toBe("idle")
    expect(manager.status("native:cpx/hve").state).toBe("success")
  })

  it("continues scheduling remaining profiles after one profile fails", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:cpx/a", name: "a" }), entry({ ref: "native:cpx/b", name: "b" })]

    const batch = runBatchedDoctorChecks(entries, manager, { maxConcurrent: 1 })
    runner.rejectNext(new Error("boom"))
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
    runner.resolveNext(ok())
    await batch

    expect(manager.status("native:cpx/a").state).toBe("failure")
    expect(manager.status("native:cpx/b").state).toBe("success")
  })

  it("does not double-trigger a profile already running when scheduled twice", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const entries = [entry({ ref: "native:cpx/hve" })]

    const batch1 = runBatchedDoctorChecks(entries, manager, { maxConcurrent: 2 })
    const batch2 = runBatchedDoctorChecks(entries, manager, { maxConcurrent: 2 })
    await Promise.resolve()
    await Promise.resolve()

    expect(runner.calls.length).toBe(1)
    runner.resolveNext(ok())
    await Promise.all([batch1, batch2])
  })

  it("resolves immediately when there is nothing to schedule", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    await expect(runBatchedDoctorChecks([], manager)).resolves.toBeUndefined()
    expect(runner.calls.length).toBe(0)
  })
})
