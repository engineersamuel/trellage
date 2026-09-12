import { describe, expect, it, vi } from "vitest"
import {
  harnessUpdateAllPlanFor,
  harnessUpdateAllSummary,
  harnessUpdateScopeKey,
  refreshHarnessUpdateGroupVersions,
  runAllHarnessUpdates,
} from "../src/admin-harness-update-all.ts"
import { HarnessUpdateManager, type HarnessUpdatePlan, type HarnessUpdateQueueEvent } from "../src/admin-harness-update.ts"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import type { CommandRunner, CommandRunResult } from "../src/guide-launch.ts"

const container = (name: string, harness = "claude", commandPath = "/fixture/trellage"): AdminProfileEntry => ({
  ref: `sandbox:${name}`,
  surface: "sandbox",
  harness,
  name,
  description: name,
  commandPath,
  doctorSupported: true,
  inventorySupported: false,
  health: "unknown",
  install: "unknown",
  stale: true,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
})

const native = (launcher: string, harness: string, name = "default", commandPath = `/fixture/${launcher}`): AdminProfileEntry => ({
  ...container(name, harness, commandPath),
  ref: `native:${launcher}/${name}`,
  surface: "native",
  launcher,
})

const success: CommandRunResult = { stdout: "updated", stderr: "", exitCode: 0 }
const help: CommandRunResult = { ...success, stdout: "usage: launcher harness-update\nlauncher skills-update PROFILE\ntrx skills update" }
const successfulRun = () => vi.fn<CommandRunner["run"]>(async (_executable, args) => (args[0] === "--help" ? help : success))

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise was not initialized")
  }
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("all-harness update planning", () => {
  it("includes the full catalog, deduplicates native runtimes, and keeps container and Firstmate operations per profile", () => {
    const entries = [
      native("cldx", "claude", "default"),
      native("cldx", "claude", "other"),
      native("omp", "oh-my-pi", "copilot"),
      native("omp", "oh-my-pi", "local"),
      native("picx", "pi"),
      native("fmx", "firstmate"),
      native("fmx", "firstmate", "pstack-workers"),
      container("claude-a"),
      container("claude-b"),
      container("pi", "pi"),
      container("prime", "prime"),
      native("agx", "agency"),
    ]
    const plan = harnessUpdateAllPlanFor([...entries].reverse().concat(entries[0]!))
    expect(plan.profileCount).toBe(entries.length)
    expect(plan.nativeUpdateCount).toBe(5)
    expect(plan.containerUpdateCount).toBe(4)
    expect(plan.unsupported).toEqual([{ entry: entries.at(-1), diagnostic: "No harness update command is supported for agx." }])
    expect(plan.groups.flatMap((group) => group.targets.map((entry) => entry.ref)).sort()).toEqual(
      entries
        .slice(0, -1)
        .map((entry) => entry.ref)
        .sort(),
    )
    expect(plan.groups.filter((group) => group.harness.includes("pi")).map((group) => group.key)).toEqual([
      "native:omp",
      "native:picx",
      "sandbox:pi",
    ])
    expect(plan.groups.find((group) => group.key === "native:fmx")?.steps.map((step) => step.command.args)).toEqual([
      ["update", "default"],
      ["update", "pstack-workers"],
    ])
    expect(
      plan.groups.filter((group) => group.surface === "sandbox").flatMap((group) => group.steps.map((step) => step.command.args)),
    ).toEqual([
      ["upgrade", "claude-a", "--strict-harness"],
      ["upgrade", "claude-b", "--strict-harness"],
      ["upgrade", "pi", "--strict-harness"],
      ["upgrade", "prime", "--strict-harness"],
    ])
  })

  it("retains separate executable paths when their harness update keys match", async () => {
    const entries = [
      native("cldx", "claude", "a"),
      native("cldx", "claude", "b", "/other/cldx"),
      container("a"),
      container("b", "claude", "/other/trellage"),
    ]
    const plan = harnessUpdateAllPlanFor(entries)
    expect(plan.groups).toHaveLength(4)
    expect(new Set(plan.groups.map(harnessUpdateScopeKey)).size).toBe(4)
    const run = successfulRun()
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh: async () => {} })
    expect(
      run.mock.calls
        .filter(([, args]) => ["harness-update", "upgrade", "update"].includes(args[0] ?? ""))
        .map(([executable]) => executable),
    ).toEqual(entries.map((entry) => entry.commandPath))
    expect(harnessUpdateAllSummary(outcome).updated).toBe(4)
  })

  it("does not override configured pins with a cached latest version", () => {
    const entries = [container("claude-pinned"), native("fmx", "firstmate")]
    const plain = harnessUpdateAllPlanFor(entries)
    const withLatest = harnessUpdateAllPlanFor(entries, () => ({
      installed: { kind: "known", version: "1.0.0" },
      latest: { kind: "known", version: "99.0.0" },
    }))
    expect(withLatest.groups.map((group) => group.steps)).toEqual(plain.groups.map((group) => group.steps))
  })

  it("reports missing commands and unknown harnesses rather than silently excluding them", () => {
    const entries = [container("missing", "claude", ""), container("unknown", "custom"), native("other", "custom")]
    const plan = harnessUpdateAllPlanFor(entries)
    expect(plan.groups).toHaveLength(0)
    expect(plan.unsupported.map(({ entry }) => entry.ref).sort()).toEqual(entries.map((entry) => entry.ref).sort())
    expect(plan.unsupported.map(({ diagnostic }) => diagnostic)).toContain("The launcher command is unavailable.")
  })
})

describe("all-harness update queue", () => {
  it("does not forward a cache update to an old router without that command", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (executable, args) => {
      if (args[0] === "--help") return executable === "trx" ? { ...help, stdout: "usage: trx [AGENT_ARGS]" } : help
      return success
    })
    const plan = harnessUpdateAllPlanFor([native("cldx", "claude")])
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh: async () => {} })
    expect(run.mock.calls.some(([, args]) => args[0] === "skills")).toBe(false)
    expect(run.mock.calls.some(([, args]) => args[0] === "skills-update")).toBe(false)
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ skillsCacheFailed: true, nativeSkillsNotRun: 1, success: false })
  })

  it("serializes commands and refreshes, reports every profile, and continues after independent failures", async () => {
    const entries = [
      native("cpx", "copilot", "a"),
      native("cpx", "copilot", "b"),
      native("fmx", "firstmate", "default"),
      native("fmx", "firstmate", "pstack-workers"),
      container("claude-a"),
      container("claude-b"),
      native("agx", "agency"),
    ]
    const plan = harnessUpdateAllPlanFor(entries)
    let active = 0
    let peak = 0
    const sequence: string[] = []
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      if (args[0] === "--help") return help
      sequence.push(args.join(" "))
      if (args[1] === "pstack-workers" || args[1] === "claude-b") throw new Error(`Download failed: ${args[1]}`)
      return success
    })
    const refresh = vi.fn(async (group: HarnessUpdatePlan) => {
      sequence.push(`refresh ${group.key}`)
      if (group.key === "native:cpx") throw new Error("Version receipt unavailable")
    })
    const events: HarnessUpdateQueueEvent[] = []
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree with spaces"), {
      refresh,
      onProgress: (event) => events.push(event),
    })
    expect(peak).toBe(1)
    expect(sequence).toEqual([
      "harness-update",
      "refresh native:cpx",
      "update default",
      "update pstack-workers",
      "refresh native:fmx",
      "skills update",
      "skills-update default",
      "skills-update a",
      "skills-update b",
      "skills-update default",
      "skills-update pstack-workers",
      "upgrade claude-a --strict-harness",
      "upgrade claude-b --strict-harness",
      "refresh sandbox:claude",
    ])
    expect(run.mock.calls.every(([, , options]) => options?.cwd === "/worktree with spaces")).toBe(true)
    expect(events.filter((event) => event.kind === "step-completed")).toHaveLength(5)
    expect(events.filter((event) => event.kind === "completed")).toHaveLength(3)
    expect(outcome.reports[0]?.refreshError).toBe("Version receipt unavailable")
    expect(harnessUpdateAllSummary(outcome)).toEqual({
      updated: 4,
      failed: 2,
      unsupported: 1,
      refreshFailed: 1,
      notRun: 0,
      success: false,
      nativeSkillsUpdated: 4,
      nativeSkillsFailed: 1,
      nativeSkillsNotRun: 0,
      skillsCacheFailed: false,
    })
  })

  it("deduplicates a repeated all-run and blocks U until the final version refresh completes", async () => {
    const plan = harnessUpdateAllPlanFor([container("claude")])
    const other = harnessUpdateAllPlanFor([container("codex", "codex")]).groups[0]!
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const pending = deferred<void>()
    const refresh = vi.fn(() => pending.promise)
    const first = manager.runAll(plan.groups, { refresh })
    expect(manager.runAll(plan.groups, { refresh })).toBe(first)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await expect(manager.run(other, async () => {})).rejects.toThrow("Update all is running")
    expect(manager.isBusy()).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    pending.resolve()
    await first
    expect(manager.isBusy()).toBe(false)
    await manager.run(other, async () => {})
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("does not start an all-run over an active selected-group update", async () => {
    const plan = harnessUpdateAllPlanFor([container("claude")])
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const pending = deferred<void>()
    const first = manager.run(plan.groups[0]!, () => pending.promise)
    await expect(runAllHarnessUpdates(plan, manager, { refresh: async () => {} })).rejects.toThrow("A harness update is already running")
    pending.resolve()
    await first
    expect(run).toHaveBeenCalledTimes(1)
    const outcome = await runAllHarnessUpdates(plan, manager, { refresh: async () => {} })
    expect(harnessUpdateAllSummary(outcome).success).toBe(true)
  })

  it("does not attach a different confirmed scope to an active all-run", async () => {
    const firstPlan = harnessUpdateAllPlanFor([container("a")])
    const secondPlan = harnessUpdateAllPlanFor([container("b")])
    const pending = deferred<void>()
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const refresh = vi.fn(() => pending.promise)
    const first = runAllHarnessUpdates(firstPlan, manager, { refresh })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await expect(runAllHarnessUpdates(secondPlan, manager, { refresh })).rejects.toThrow("different scope")
    pending.resolve()
    expect((await first).reports[0]?.outcome.results[0]?.ref).toBe("sandbox:a")
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["upgrade", "a", "--strict-harness"]])
  })

  it("cancels the active command and does not start later profiles or groups", async () => {
    const plan = harnessUpdateAllPlanFor([container("a"), container("b"), container("codex", "codex")])
    const controller = new AbortController()
    const run = vi.fn<CommandRunner["run"]>(
      (_executable, _args, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("Update cancelled")), { once: true })
        }),
    )
    const refresh = vi.fn(async () => {})
    const pending = runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh, signal: controller.signal })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    controller.abort()
    const outcome = await pending
    expect(outcome.cancelled).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ updated: 0, failed: 2, notRun: 1, success: false })
  })

  it("does not launch an update when cancellation occurs during the capability probe", async () => {
    const controller = new AbortController()
    const run = vi.fn<CommandRunner["run"]>(async () => {
      controller.abort()
      return help
    })
    const plan = harnessUpdateAllPlanFor([native("cldx", "claude")])
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), {
      refresh: async () => {},
      signal: controller.signal,
    })
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["--help"]])
    expect(outcome.cancelled).toBe(true)
    expect(harnessUpdateAllSummary(outcome).success).toBe(false)
  })

  it("does not report unsupported-only or empty catalogs as successful updates", async () => {
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const outcome = await runAllHarnessUpdates(harnessUpdateAllPlanFor([native("agx", "agency")]), manager, { refresh: async () => {} })
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ unsupported: 1, updated: 0, success: false })
    expect(harnessUpdateAllSummary(outcome).nativeSkillsUpdated).toBe(1)
    run.mockClear()
    await expect(runAllHarnessUpdates(harnessUpdateAllPlanFor([]), manager, { refresh: async () => {} })).rejects.toThrow(
      "No updates were selected",
    )
    expect(run).not.toHaveBeenCalled()
  })

  it("publishes Native skill copies after harness updates, then builds Containers with current skills", async () => {
    const entries = [native("cldx", "claude", "a"), native("cldx", "claude", "b"), container("claude")]
    const plan = harnessUpdateAllPlanFor(entries, undefined, "/selected worktree/bin/trx")
    const run = successfulRun()
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh: async () => {} })
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help").map(([executable, args]) => [executable, args])).toEqual([
      ["/fixture/cldx", ["harness-update"]],
      ["/selected worktree/bin/trx", ["skills", "update"]],
      ["/fixture/cldx", ["skills-update", "a"]],
      ["/fixture/cldx", ["skills-update", "b"]],
      ["/fixture/trellage", ["upgrade", "claude", "--strict-harness"]],
    ])
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ success: true, nativeSkillsUpdated: 2, updated: 3 })
  })

  it("does not copy stale Native skills after cache refresh fails, but continues independent harness updates", async () => {
    const entries = [native("cldx", "claude"), container("claude")]
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "--help") return help
      if (args[0] === "skills") throw new Error("Skill source unavailable")
      return success
    })
    const outcome = await runAllHarnessUpdates(harnessUpdateAllPlanFor(entries), new HarnessUpdateManager({ run }, "/worktree"), {
      refresh: async () => {},
    })
    expect(run.mock.calls.some(([, args]) => args[0] === "skills-update")).toBe(false)
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({
      updated: 2,
      nativeSkillsUpdated: 0,
      nativeSkillsNotRun: 1,
      skillsCacheFailed: true,
      success: false,
    })
    expect(outcome.skills?.cache).toEqual({ state: "failure", diagnostic: "Skill source unavailable" })
  })

  it("keeps the all-run reservation during skills refresh and blocks an overlapping U", async () => {
    const plan = harnessUpdateAllPlanFor([native("cldx", "claude"), container("claude")])
    const pending = deferred<CommandRunResult>()
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "--help") return help
      return args[0] === "skills" ? pending.promise : success
    })
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const first = runAllHarnessUpdates(plan, manager, { refresh: async () => {} })
    await vi.waitFor(() => expect(run.mock.calls.some(([, args]) => args[0] === "skills")).toBe(true))
    await expect(manager.run(plan.groups[0]!, async () => {})).rejects.toThrow("Update all is running")
    expect(run.mock.calls.filter(([, args]) => args[0] === "harness-update")).toHaveLength(1)
    expect(run.mock.calls.some(([, args]) => args[0] === "upgrade")).toBe(false)
    pending.resolve(success)
    expect(harnessUpdateAllSummary(await first).success).toBe(true)
    expect(manager.isBusy()).toBe(false)
  })

  it("reports an old skills launcher without forwarding the new management verb into a profile", async () => {
    const entry = native("cldx", "claude")
    const run = vi.fn<CommandRunner["run"]>(async (executable, args) => {
      if (args[0] === "--help") return executable === "trx" ? help : { ...help, stdout: "usage: cldx harness-update" }
      return success
    })
    const outcome = await runAllHarnessUpdates(harnessUpdateAllPlanFor([entry]), new HarnessUpdateManager({ run }, "/worktree"), {
      refresh: async () => {},
    })
    expect(run.mock.calls.some(([, args]) => args[0] === "skills-update")).toBe(false)
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ updated: 1, nativeSkillsFailed: 1, success: false })
    expect(outcome.skills?.results).toEqual([
      expect.objectContaining({ state: "failure", diagnostic: expect.stringContaining("does not support skills-update") }),
    ])
  })
})

describe("all-harness installed-version refresh", () => {
  it("surfaces an unavailable installed version instead of claiming a fully refreshed update", async () => {
    const plan = harnessUpdateAllPlanFor([container("claude")]).groups[0]!
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({ ...success, stdout: "invalid version report" })
    const onResult = vi.fn()
    await expect(
      refreshHarnessUpdateGroupVersions(plan, new AdminRunManager({ runner: { run } }), { schemaVersion: 2, entries: {} }, onResult),
    ).rejects.toThrow("Installed-version refresh failed")
    expect(onResult).toHaveBeenCalled()
    expect(run.mock.calls.every(([, args]) => !args.includes("--refresh-latest"))).toBe(true)
  })

  it("does not claim success if no installed-version read is supported", async () => {
    const entry = { ...native("cldx", "claude"), harnessVersionSupported: false }
    const plan = harnessUpdateAllPlanFor([entry]).groups[0]!
    const run = successfulRun()
    await expect(
      refreshHarnessUpdateGroupVersions(plan, new AdminRunManager({ runner: { run } }), { schemaVersion: 2, entries: {} }, vi.fn()),
    ).rejects.toThrow("Installed-version refresh is not supported")
    expect(run).not.toHaveBeenCalled()
  })
})
