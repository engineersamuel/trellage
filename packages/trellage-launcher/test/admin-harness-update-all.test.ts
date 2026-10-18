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

const base = (name: string, harness = "claude", commandPath = "/fixture/trx"): AdminProfileEntry => ({
  ref: `native:unknown/${name}`,
  surface: "native",
  harness,
  launcher: harness,
  name,
  profiles: [name],
  lifecycle: { runtime: harness, profile: name },
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

const native = (launcher: string, harness: string, name = "default", commandPath = "/fixture/trx"): AdminProfileEntry => ({
  ...base(name, harness, commandPath),
  ref: `native:${launcher}/${name}`,
  launcher,
  harness: launcher,
  profiles: [name],
  lifecycle: ["codex", "pi"].includes(launcher) ? null : { runtime: launcher, profile: name },
})

const success: CommandRunResult = { stdout: "updated", stderr: "", exitCode: 0 }
const help: CommandRunResult = { ...success, stdout: "usage: trx upgrade HARNESS PROFILE --harness-only --skills-only\ntrx skills update" }
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
  it("includes the full catalog and deduplicates native runtimes", () => {
    const entries = [
      native("claude", "claude", "default"),
      native("claude", "claude", "other"),
      native("omp", "oh-my-pi", "copilot"),
      native("omp", "oh-my-pi", "local"),
      native("pi", "pi"),
      native("agency", "agency"),
    ]
    const plan = harnessUpdateAllPlanFor([...entries].reverse().concat(entries[0]!))
    expect(plan.profileCount).toBe(entries.length)
    expect(plan.nativeUpdateCount).toBe(2)
    expect(plan.externallyManaged.map(({ harness }) => harness)).toEqual(["agency", "pi"])
    expect(plan.groups.flatMap((group) => group.targets.map((entry) => entry.ref)).sort()).toEqual(
      entries
        .filter((entry) => !["agency", "pi"].includes(entry.harness))
        .map((entry) => entry.ref)
        .sort(),
    )
    expect(plan.groups.filter((group) => group.key === "native:omp").map((group) => group.key)).toEqual([
      "native:omp",
    ])
  })

  it("retains separate executable paths when their harness update keys match", async () => {
    const entries = [
      native("claude", "claude", "a"),
      native("claude", "claude", "b", "/other/trx"),
    ]
    const plan = harnessUpdateAllPlanFor(entries)
    expect(plan.groups).toHaveLength(2)
    expect(new Set(plan.groups.map(harnessUpdateScopeKey)).size).toBe(2)
    const run = successfulRun()
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh: async () => {} })
    expect(
      run.mock.calls
        .filter(([, args]) => ["harness-update", "upgrade", "update"].includes(args[0] ?? "") && !args.includes("--skills-only"))
        .map(([executable]) => executable),
    ).toEqual(entries.map((entry) => entry.commandPath))
    expect(harnessUpdateAllSummary(outcome).updated).toBe(2)
  })

  it("does not override configured pins with a cached latest version", () => {
    const entries = [native("claude", "claude", "pinned"), native("pi", "pi")]
    const plain = harnessUpdateAllPlanFor(entries)
    const withLatest = harnessUpdateAllPlanFor(entries, () => ({
      installed: { kind: "known", version: "1.0.0" },
      latest: { kind: "known", version: "99.0.0" },
    }))
    expect(withLatest.groups.map((group) => group.steps)).toEqual(plain.groups.map((group) => group.steps))
  })

  it("reports missing commands and unknown harnesses rather than silently excluding them", () => {
    const entries = [base("missing", "claude", ""), base("unknown", "custom"), native("other", "custom")]
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
    const plan = harnessUpdateAllPlanFor([native("claude", "claude")])
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh: async () => {} })
    expect(run.mock.calls.some(([, args]) => args[0] === "skills")).toBe(false)
    expect(run.mock.calls.some(([, args]) => args.includes("--skills-only"))).toBe(false)
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ skillsCacheFailed: true, nativeSkillsNotRun: 1, success: false })
  })

  it("serializes commands and refreshes, reports every profile, and continues after independent failures", async () => {
    const entries = [
      native("copilot", "copilot", "a"),
      native("copilot", "copilot", "b"),
      native("jcode", "jcode"),
      native("agency", "agency"),
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
      if (args[1] === "jcode" && !args.includes("--skills-only")) throw new Error(`Download failed: ${args[1]}`)
      return success
    })
    const refresh = vi.fn(async (group: HarnessUpdatePlan) => {
      sequence.push(`refresh ${group.key}`)
      if (group.key === "native:copilot") throw new Error("Version receipt unavailable")
    })
    const events: HarnessUpdateQueueEvent[] = []
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree with spaces"), {
      refresh,
      onProgress: (event) => events.push(event),
    })
    expect(peak).toBe(1)
    expect(sequence).toEqual([
      "upgrade copilot a --harness-only",
      "refresh native:copilot",
      "upgrade jcode default",
      "refresh native:jcode",
      "skills update",
      "upgrade agency default --skills-only",
      "upgrade copilot a --skills-only",
      "upgrade copilot b --skills-only",
      "upgrade jcode default --skills-only",
    ])
    expect(run.mock.calls.every(([, , options]) => options?.cwd === "/worktree with spaces")).toBe(true)
    expect(events.filter((event) => event.kind === "step-completed")).toHaveLength(2)
    expect(events.filter((event) => event.kind === "completed")).toHaveLength(2)
    expect(outcome.reports[0]?.refreshError).toBe("Version receipt unavailable")
    expect(harnessUpdateAllSummary(outcome)).toEqual({
      updated: 2,
      failed: 1,
      unsupported: 0,
      refreshFailed: 1,
      notRun: 0,
      success: false,
      nativeSkillsUpdated: 4,
      nativeSkillsFailed: 0,
      nativeSkillsNotRun: 0,
      skillsCacheFailed: false,
    })
  })

  it("deduplicates a repeated all-run and blocks U until the final version refresh completes", async () => {
    const plan = harnessUpdateAllPlanFor([native("claude", "claude", "claude")])
    const other = harnessUpdateAllPlanFor([native("jcode", "jcode", "default")]).groups[0]!
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const pending = deferred<void>()
    const refresh = vi.fn(() => pending.promise)
    const first = manager.runAll(plan.groups, { refresh })
    expect(manager.runAll(plan.groups, { refresh })).toBe(first)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await expect(manager.run(other, async () => {})).rejects.toThrow("Update all is running")
    expect(manager.isBusy()).toBe(true)
    const updates = () => run.mock.calls.filter(([, args]) => args[0] !== "--help")
    expect(updates()).toHaveLength(1)
    pending.resolve()
    await first
    expect(manager.isBusy()).toBe(false)
    await manager.run(other, async () => {})
    expect(updates()).toHaveLength(2)
  })

  it("does not start an all-run over an active selected-group update", async () => {
    const plan = harnessUpdateAllPlanFor([native("claude", "claude", "claude")])
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const pending = deferred<void>()
    const first = manager.run(plan.groups[0]!, () => pending.promise)
    await expect(runAllHarnessUpdates(plan, manager, { refresh: async () => {} })).rejects.toThrow("A harness update is already running")
    pending.resolve()
    await first
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help")).toHaveLength(1)
    const outcome = await runAllHarnessUpdates(plan, manager, { refresh: async () => {} })
    expect(harnessUpdateAllSummary(outcome).success).toBe(true)
  })

  it("does not attach a different confirmed scope to an active all-run", async () => {
    const firstPlan = harnessUpdateAllPlanFor([native("claude", "claude", "a")])
    const secondPlan = harnessUpdateAllPlanFor([native("claude", "claude", "b")])
    const pending = deferred<void>()
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const refresh = vi.fn(() => pending.promise)
    const first = runAllHarnessUpdates(firstPlan, manager, { refresh })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await expect(runAllHarnessUpdates(secondPlan, manager, { refresh })).rejects.toThrow("different scope")
    pending.resolve()
    expect((await first).reports[0]?.outcome.results[0]?.ref).toBe("native:claude/a")
    expect(run.mock.calls.filter(([, args]) => args.includes("--harness-only")).map(([, args]) => args)).toEqual([
      ["upgrade", "claude", "a", "--harness-only"],
    ])
  })

  it("cancels the active command and does not start later profiles or groups", async () => {
    const plan = harnessUpdateAllPlanFor([native("claude", "claude", "a"), native("claude", "claude", "b"), native("prime", "prime", "default")])
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
    const plan = harnessUpdateAllPlanFor([native("claude", "claude")])
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), {
      refresh: async () => {},
      signal: controller.signal,
    })
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["--help"]])
    expect(outcome.cancelled).toBe(true)
    expect(harnessUpdateAllSummary(outcome).success).toBe(false)
  })

  it("treats externally managed-only catalogs as informational success", async () => {
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const outcome = await runAllHarnessUpdates(harnessUpdateAllPlanFor([native("agency", "agency")]), manager, { refresh: async () => {} })
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ unsupported: 0, updated: 0, success: true })
    expect(harnessUpdateAllSummary(outcome).nativeSkillsUpdated).toBe(1)
    run.mockClear()
    await expect(runAllHarnessUpdates(harnessUpdateAllPlanFor([]), manager, { refresh: async () => {} })).rejects.toThrow(
      "No updates were selected",
    )
    expect(run).not.toHaveBeenCalled()
  })

  it("publishes Native skill copies after harness updates, ", async () => {
    const entries = [native("claude", "claude", "a"), native("claude", "claude", "b")]
    const plan = harnessUpdateAllPlanFor(entries, undefined, "/selected worktree/bin/trx")
    const run = successfulRun()
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/worktree"), { refresh: async () => {} })
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help").map(([executable, args]) => [executable, args])).toEqual([
      ["/fixture/trx", ["upgrade", "claude", "a", "--harness-only"]],
      ["/selected worktree/bin/trx", ["skills", "update"]],
      ["/fixture/trx", ["upgrade", "claude", "a", "--skills-only"]],
      ["/fixture/trx", ["upgrade", "claude", "b", "--skills-only"]],
    ])
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ success: true, nativeSkillsUpdated: 2, updated: 2 })
  })

  it("does not copy stale Native skills after cache refresh fails, but continues independent harness updates", async () => {
    const entries = [native("claude", "claude"), native("jcode", "jcode")]
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "--help") return help
      if (args[0] === "skills") throw new Error("Skill source unavailable")
      return success
    })
    const outcome = await runAllHarnessUpdates(harnessUpdateAllPlanFor(entries), new HarnessUpdateManager({ run }, "/worktree"), {
      refresh: async () => {},
    })
    expect(run.mock.calls.some(([, args]) => args.includes("--skills-only"))).toBe(false)
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({
      updated: 2,
      nativeSkillsUpdated: 0,
      nativeSkillsNotRun: 2,
      skillsCacheFailed: true,
      success: false,
    })
    expect(outcome.skills?.cache).toEqual({ state: "failure", diagnostic: "Skill source unavailable" })
  })

  it("keeps the all-run reservation during skills refresh and blocks an overlapping U", async () => {
    const plan = harnessUpdateAllPlanFor([native("claude", "claude"), native("claude", "claude", "claude")])
    const pending = deferred<CommandRunResult>()
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "--help") return help
      return args[0] === "skills" ? pending.promise : success
    })
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    const first = runAllHarnessUpdates(plan, manager, { refresh: async () => {} })
    await vi.waitFor(() => expect(run.mock.calls.some(([, args]) => args[0] === "skills")).toBe(true))
    await expect(manager.run(plan.groups[0]!, async () => {})).rejects.toThrow("Update all is running")
    expect(run.mock.calls.filter(([, args]) => args.includes("--harness-only"))).toHaveLength(1)
    expect(run.mock.calls.some(([, args]) => args[0] === "upgrade" && !args.includes("--harness-only") && !args.includes("--skills-only"))).toBe(false)
    pending.resolve(success)
    expect(harnessUpdateAllSummary(await first).success).toBe(true)
    expect(manager.isBusy()).toBe(false)
  })

  it("reports an old skills launcher without forwarding the new management verb into a profile", async () => {
    const entry = native("claude", "claude")
    const run = vi.fn<CommandRunner["run"]>(async (executable, args) => {
      if (args[0] === "--help") return executable === "trx" ? help : { ...help, stdout: "usage: cldx harness-update" }
      return success
    })
    const outcome = await runAllHarnessUpdates(harnessUpdateAllPlanFor([entry]), new HarnessUpdateManager({ run }, "/worktree"), {
      refresh: async () => {},
    })
    expect(run.mock.calls.some(([, args]) => args.includes("--skills-only"))).toBe(false)
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ updated: 0, failed: 1, nativeSkillsFailed: 1, success: false })
    expect(outcome.skills?.results).toEqual([
      expect.objectContaining({ state: "failure", diagnostic: expect.stringContaining("does not support upgrade") }),
    ])
  })
})

describe("all-harness installed-version refresh", () => {
  it("surfaces an unavailable installed version instead of claiming a fully refreshed update", async () => {
    const plan = harnessUpdateAllPlanFor([native("claude", "claude", "claude")]).groups[0]!
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({ ...success, stdout: "invalid version report" })
    const onResult = vi.fn()
    await expect(
      refreshHarnessUpdateGroupVersions(plan, new AdminRunManager({ runner: { run } }), { schemaVersion: 2, entries: {} }, onResult),
    ).rejects.toThrow("Installed-version refresh failed")
    expect(onResult).toHaveBeenCalled()
    expect(run.mock.calls.every(([, args]) => !args.includes("--refresh-latest"))).toBe(true)
  })

  it("does not claim success if no installed-version read is supported", async () => {
    const entry = { ...native("claude", "claude"), harnessVersionSupported: false }
    const plan = harnessUpdateAllPlanFor([entry]).groups[0]!
    const run = successfulRun()
    await expect(
      refreshHarnessUpdateGroupVersions(plan, new AdminRunManager({ runner: { run } }), { schemaVersion: 2, entries: {} }, vi.fn()),
    ).rejects.toThrow("Installed-version refresh is not supported")
    expect(run).not.toHaveBeenCalled()
  })
})
