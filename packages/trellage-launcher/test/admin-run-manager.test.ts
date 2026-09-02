import { describe, expect, it } from "vitest"

import { CommandRunnerError, type CommandRunOptions, type CommandRunner, type CommandRunResult } from "../src/guide-launch.js"
import { AdminRunManager } from "../src/admin-run-manager.js"

/** A controllable fake runner: each `run()` call gets its own deferred resolve/reject, released manually by the test. */
class DeferredRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string>; options?: CommandRunOptions }> = []
  private readonly pending: Array<{
    resolve: (value: CommandRunResult) => void
    reject: (error: unknown) => void
    options?: CommandRunOptions
  }> = []

  run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    return new Promise((resolve, reject) => {
      const entry: { resolve: (value: CommandRunResult) => void; reject: (error: unknown) => void; options?: CommandRunOptions } = {
        resolve,
        reject,
        ...(options === undefined ? {} : { options }),
      }
      this.pending.push(entry)
      if (options?.signal !== undefined) {
        options.signal.addEventListener("abort", () => {
          reject(
            new CommandRunnerError({
              kind: "aborted",
              executable,
              args,
              message: "aborted",
            }),
          )
        })
      }
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
}

const ok = (stdout = "healthy"): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })

describe("AdminRunManager", () => {
  it("reports idle status before any trigger", () => {
    const manager = new AdminRunManager({ runner: new DeferredRunner() })
    expect(manager.status("native:cpx/hve")).toMatchObject({ state: "idle", history: [] })
  })

  it("transitions pending -> running -> success and records history", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const promise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    expect(manager.status("native:cpx/hve").state).toBe("running")
    runner.resolveNext(ok("all good"))
    await promise
    expect(manager.status("native:cpx/hve")).toMatchObject({
      state: "success",
      latest: { state: "success", stdout: "all good" },
    })
  })

  it("uses the manager's own default timeout when no per-call override is given", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const promise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    expect(runner.calls[0]!.options?.timeoutMs).toBe(30_000)
    runner.resolveNext(ok("all good"))
    await promise
  })

  it("honors a per-call timeoutMs override on trigger, without affecting the manager's own default for other calls", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const promise = manager.trigger("native:cpx/hve::setup", "/bin/cpx", ["setup", "hve"], { timeoutMs: 180_000 })
    expect(runner.calls[0]!.options?.timeoutMs).toBe(180_000)
    runner.resolveNext(ok("set up"))
    await promise
    const secondPromise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    expect(runner.calls[1]!.options?.timeoutMs).toBe(30_000)
    runner.resolveNext(ok("all good"))
    await secondPromise
  })

  it("honors a per-call timeoutMs override on retry", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const promise = manager.retry("native:cpx/hve::repair", "/bin/cpx", ["repair", "hve"], { timeoutMs: 180_000 })
    expect(runner.calls[0]!.options?.timeoutMs).toBe(180_000)
    runner.resolveNext(ok("repaired"))
    await promise
  })

  it("transitions pending -> running -> failure on a non-zero exit", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const promise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    runner.rejectNext(
      new CommandRunnerError({ kind: "exited", executable: "/bin/cpx", args: [], exitCode: 1, message: "failed", stderr: "boom" }),
    )
    await promise
    expect(manager.status("native:cpx/hve")).toMatchObject({ state: "failure", latest: { state: "failure", stderr: "boom" } })
  })

  it("does not spawn a second process when a run is already in flight for the profile", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const first = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    const second = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    expect(runner.calls).toHaveLength(1)
    runner.resolveNext(ok())
    await Promise.all([first, second])
  })

  it("cancel aborts the in-flight run and records a cancelled terminal state, not failure", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const promise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    manager.cancel("native:cpx/hve")
    await promise
    expect(manager.status("native:cpx/hve").state).toBe("cancelled")
  })

  it("retry after a terminal state issues a new, independent run", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const first = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    runner.rejectNext(new CommandRunnerError({ kind: "exited", executable: "/bin/cpx", args: [], exitCode: 1, message: "failed" }))
    await first
    const second = manager.retry("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    expect(runner.calls).toHaveLength(2)
    runner.resolveNext(ok())
    await second
    expect(manager.status("native:cpx/hve").state).toBe("success")
  })

  it("bounds history to the configured cap, evicting the oldest entries first", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner, historyCap: 2 })
    for (let index = 0; index < 3; index += 1) {
      const promise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
      runner.resolveNext(ok(`run-${index}`))
      await promise
    }
    const status = manager.status("native:cpx/hve")
    expect(status.history).toHaveLength(2)
    expect(status.history.map((entry) => entry.stdout)).toEqual(["run-1", "run-2"])
  })

  it("times out a hung command and reaches a terminal timed-out state, not a permanently running one", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner, timeoutMs: 5 })
    const promise = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    runner.rejectNext(new CommandRunnerError({ kind: "timed-out", executable: "/bin/cpx", args: [], message: "timed out" }))
    await promise
    expect(manager.status("native:cpx/hve").state).toBe("timed-out")
  })

  it("keeps independent profiles' state independent when one fails", async () => {
    const runner = new DeferredRunner()
    const manager = new AdminRunManager({ runner })
    const a = manager.trigger("native:cpx/hve", "/bin/cpx", ["doctor", "hve"])
    const b = manager.trigger("native:cldx/hve", "/bin/cldx", ["doctor", "hve"])
    runner.rejectNext(new CommandRunnerError({ kind: "exited", executable: "/bin/cpx", args: [], exitCode: 1, message: "failed" }))
    runner.resolveNext(ok())
    await Promise.all([a, b])
    expect(manager.status("native:cpx/hve").state).toBe("failure")
    expect(manager.status("native:cldx/hve").state).toBe("success")
  })
})
