import { describe, expect, it, vi } from "vitest"

import {
  HarnessUpdateManager,
  harnessUpdateKeyFor,
  harnessUpdatePlanFor,
  refreshHarnessUpdateVersions,
  runHarnessUpdate,
  type HarnessUpdatePlan,
} from "../src/admin-harness-update.ts"
import type { AdminHarnessVersionCacheEntry } from "../src/admin-harness-version-cache.ts"
import { harnessVersionRefFor } from "../src/admin-harness-version-scheduler.ts"
import {
  reconcileHarnessVersionResults,
  type AdminHarnessVersionResult,
} from "../src/admin-harness-version.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import { CommandRunnerError, type CommandRunner, type CommandRunResult } from "../src/guide-launch.ts"

const baseEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "native:claude/blog",
  surface: "native",
  launcher: "claude",
  harness: "claude",
  name: "blog",
  description: "Native Claude profile.",
  commandPath: "/opt/trellage/claude/bin/claude",
  doctorSupported: true,
  inventorySupported: false,
  health: "healthy",
  install: "installed",
  version: "2.1.252",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

const versionResult = (installed: string, latest: string): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "known", version: latest },
})

const nativeEntry = (launcher: string, harness: string, name = "default"): AdminProfileEntry => ({
  ...baseEntry(),
  ref: `native:${launcher}/${name}`,
  surface: "native",
  launcher,
  harness,
  name,
  commandPath: `/opt/trellage/${launcher}/bin/${launcher}`,
})

const requirePlan = (
  selected: AdminProfileEntry,
  entries: ReadonlyArray<AdminProfileEntry> = [selected],
  result?: AdminHarnessVersionResult,
): HarnessUpdatePlan => {
  const plan = harnessUpdatePlanFor(selected, entries, result)
  if (plan === undefined) throw new Error(`Expected an update plan for ${selected.ref}`)
  return plan
}

const success: CommandRunResult = { stdout: "updated", stderr: "", exitCode: 0 }
const help: CommandRunResult = { stdout: "usage: trx upgrade HARNESS PROFILE", stderr: "", exitCode: 0 }
const successfulRun = () => vi.fn<CommandRunner["run"]>(async (_executable, args) => (args[0] === "--help" ? help : success))

describe("harnessUpdatePlanFor", () => {
  it.each([
    ["copilot", "copilot", "hve", ["upgrade", "copilot", "hve", "--harness-only"]],
    ["codex", "codex", "youtube", ["upgrade", "codex", "youtube", "--harness-only"]],
    ["codex", "codex", "superpowers", ["upgrade", "codex", "superpowers", "--harness-only"]],
    ["claude", "claude", "default", ["upgrade", "claude", "default", "--harness-only"]],
    ["omp", "oh-my-pi", "copilot", ["upgrade", "omp", "copilot"]],
    ["jcode", "jcode", "default", ["upgrade", "jcode", "default"]],
    ["pi", "pi", "default", ["upgrade", "pi", "default"]],
    ["prime", "prime", "default", ["upgrade", "prime", "default"]],
  ] as const)("uses %s's harness command, not a plugin update", (launcher, harness, name, args) => {
    const selected = nativeEntry(launcher, harness, name)
    const plan = requirePlan(selected, [selected])
    expect(plan.surface).toBe("native")
    expect(plan.targets).toEqual([selected])
    expect(plan.steps).toEqual([{ command: { executable: selected.commandPath, args }, targets: [selected] }])
  })

  it.each<AdminHarnessVersionResult | undefined>([
    undefined,
    versionResult("2.1.260", "2.1.260"),
    { installed: { kind: "unavailable", diagnostic: "receipt unavailable" }, latest: { kind: "known", version: "2.1.260" } },
    { installed: { kind: "known", version: "2.1.252" }, latest: { kind: "failed", diagnostic: "offline" } },
    { installed: { kind: "known", version: "2.1.252" }, latest: { kind: "unsupported" } },
  ])("allows explicit updates regardless of cached version availability: %j", (result) => {
    for (const selected of [baseEntry(), nativeEntry("copilot", "copilot", "hve")]) {
      const plan = requirePlan(selected, [selected], result)
      expect(plan.targets).toEqual([selected])
      expect(plan.latestVersion).toBe(result?.latest.kind === "known" ? result.latest.version : undefined)
    }
  })

  it("keeps native Pi Coding Agent and native Oh My Pi in separate update groups", () => {
    const pi = nativeEntry("pi", "pi")
    const omp = nativeEntry("omp", "oh-my-pi", "local")
    const entries = [pi, omp]
    const plans = entries.map((selected) => requirePlan(selected, entries))

    expect(plans.map(({ key }) => key)).toEqual(["native:pi", "native:omp"])
    expect(plans.map(({ targets }) => targets)).toEqual([[pi], [omp]])
  })

  it("does not select another runtime executable with the same harness label", () => {
    const selected = nativeEntry("copilot", "copilot", "hve")
    const otherRuntime = { ...nativeEntry("copilot", "copilot", "awesome"), commandPath: "/different/trx" }
    expect(requirePlan(selected, [selected, otherRuntime]).targets).toEqual([selected])
  })

  it("groups native Codex profiles", () => {
    const youtube = nativeEntry("codex", "codex", "youtube")
    const superpowers = nativeEntry("codex", "codex", "superpowers")
    const entries = [youtube, superpowers]

    for (const selected of [youtube, superpowers]) {
      const plan = requirePlan(selected, entries)
      expect(plan.key).toBe("native:codex")
      expect(plan.targets).toEqual([superpowers, youtube])
      expect(plan.steps).toHaveLength(1)
    }
  })

  it("fails closed for unsupported launchers and unknown or incomplete entries", () => {
    const unsupported = [nativeEntry("unknown", "copilot"), baseEntry({ commandPath: "" })]
    for (const selected of unsupported) {
      expect(harnessUpdateKeyFor(selected)).toBeUndefined()
      expect(harnessUpdatePlanFor(selected, [selected], versionResult("1.0.0", "2.0.0"))).toBeUndefined()
    }
    expect(harnessUpdatePlanFor(baseEntry(), [], undefined)).toBeUndefined()
  })
})

describe("runHarnessUpdate", () => {
  it.each([
    ["copilot", "copilot", ["awesome", "hve"]],
    ["codex", "codex", ["youtube", "superpowers", "pstack"]],
    ["claude", "claude", ["default"]],
    ["omp", "oh-my-pi", ["local", "copilot"]],
  ] as const)("updates %s's shared harness once for all of its profiles", async (launcher, harness, names) => {
    const entries = names.map((name) => nativeEntry(launcher, harness, name))
    const selected = entries[0]!
    const plan = requirePlan(selected, entries)
    const run = successfulRun()
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree with spaces")

    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help")).toEqual([
      [
        selected.commandPath,
        plan.steps[0]!.command.args,
        {
          cwd: "/worktree with spaces",
          timeoutMs: 30 * 60 * 1000,
          outputOverflow: "truncate",
        },
      ],
    ])
    expect(outcome.results).toEqual(plan.targets.map(({ ref, name }) => ({ ref, name, state: "success" })))
  })

  it("reports a failed shared native update for all affected profiles", async () => {
    const entries = ["awesome", "hve"].map((name) => nativeEntry("copilot", "copilot", name))
    const plan = requirePlan(entries[0]!, entries)
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "--help") return help
      throw new Error("download failed")
    })
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")

    expect(run).toHaveBeenCalledTimes(2)
    expect(outcome.results).toEqual(entries.map(({ ref, name }) => ({ ref, name, state: "failure", diagnostic: "download failed" })))
  })

  it("does not forward an unsupported management verb to an old native launcher", async () => {
    const plan = requirePlan(nativeEntry("claude", "claude"))
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({ ...success, stdout: "usage: cldx [PROFILE] [ARGS]" })
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["--help"]])
    expect(outcome.results).toEqual([
      expect.objectContaining({ state: "failure", diagnostic: expect.stringContaining("Refresh the installed Trellage launcher") }),
    ])
  })

  it.each([
    ["claude", "upgrade fallback: harness claude@latest -> 2.1.252"],
    ["codex", "upgrade fallback: harness codex@latest -> 0.1.0"],
  ])("reports %s harness fallback as failure even if the command exits successfully", async (harness, fallback) => {
    const plan = requirePlan(nativeEntry(harness, harness))
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) =>
      args[0] === "--help" ? help : { ...success, stdout: `${fallback}\nupgraded: fixture` },
    )
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")
    expect(outcome.results).toEqual([
      expect.objectContaining({ state: "failure", diagnostic: expect.stringContaining("Harness was not updated") }),
    ])
  })
})

describe("harness update version refresh", () => {
  it.each([
    ["omp", "oh-my-pi", 1],
    ["codex", "codex", 1],
    ["claude", "claude", 1],
  ] as const)("refreshes the correct installed scopes for %s", async (launcher, harness, expectedReads) => {
    const entries = ["a", "b"].map((name) => nativeEntry(launcher, harness, name))
    const plan = requirePlan(entries[0]!, entries)
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
      stdout: JSON.stringify({ schemaVersion: 1, installed: "3.0.0", latest: "3.0.0", latestKnown: true }),
      stderr: "",
      exitCode: 0,
    })
    const manager = new AdminRunManager({ runner: { run } })
    const cacheEntries: Record<string, AdminHarnessVersionCacheEntry> = {}

    await refreshHarnessUpdateVersions(plan, manager, { schemaVersion: 2, entries: cacheEntries }, (key, entry) => {
      cacheEntries[key] = entry
    })
    expect(run).toHaveBeenCalledTimes(expectedReads)
    const refreshed = reconcileHarnessVersionResults(entries, (key) => cacheEntries[key]?.result)
    for (const entry of entries) {
      expect(refreshed.get(entry.ref)?.installed).toEqual({ kind: "known", version: "3.0.0" })
    }
  })

  it("waits for a pre-update version check, then reads the newly installed version", async () => {
    const selected = baseEntry()
    const plan = requirePlan(selected)
    let finishOldCheck: (result: CommandRunResult) => void = () => {
      throw new Error("no pending check")
    }
    const pending = new Promise<CommandRunResult>((resolve) => {
      finishOldCheck = resolve
    })
    const report = (installed: string): CommandRunResult => ({
      stdout: JSON.stringify({ schemaVersion: 1, installed, latest: "2.1.260", latestKnown: true }),
      stderr: "",
      exitCode: 0,
    })
    const run = vi.fn<CommandRunner["run"]>().mockReturnValueOnce(pending).mockResolvedValue(report("2.1.260"))
    const manager = new AdminRunManager({ runner: { run } })
    const oldCheck = manager.trigger(harnessVersionRefFor("native:claude"), selected.commandPath, ["harness-version", "claude", selected.name])
    const results: AdminHarnessVersionCacheEntry[] = []
    const refresh = refreshHarnessUpdateVersions(plan, manager, { schemaVersion: 2, entries: {} }, (_key, result) => results.push(result))
    expect(run).toHaveBeenCalledTimes(1)
    finishOldCheck(report("2.1.252"))
    await oldCheck
    await refresh

    expect(run).toHaveBeenCalledTimes(2)
    expect(results.at(-1)?.result.installed).toEqual({ kind: "known", version: "2.1.260" })
  })
})

describe("HarnessUpdateManager", () => {
  it("deduplicates group updates until installed-version refresh also completes", async () => {
    const entries = ["awesome", "hve"].map((name) => nativeEntry("copilot", "copilot", name))
    const firstPlan = requirePlan(entries[0]!, entries)
    const peerPlan = requirePlan(entries[1]!, entries)
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    let finishRefresh: () => void = () => {
      throw new Error("refresh has not started")
    }
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve
        }),
    )
    const first = manager.run(firstPlan, refresh)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    expect(manager.isRunning(firstPlan.key)).toBe(true)
    const second = manager.run(peerPlan, refresh)
    expect(second).toBe(first)
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help")).toHaveLength(1)
    finishRefresh()
    await second
    expect(manager.isRunning(firstPlan.key)).toBe(false)
    await manager.run(firstPlan, async () => {})
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help")).toHaveLength(2)
  })

  it("surfaces refresh failures and releases the group so a later retry is possible", async () => {
    const plan = requirePlan(baseEntry())
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => (args[0] === "--help" ? help : success))
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    await expect(
      manager.run(plan, async () => {
        throw new Error("refresh failed")
      }),
    ).rejects.toThrow("refresh failed")
    expect(manager.isRunning(plan.key)).toBe(false)
    await expect(manager.run(plan, async () => {})).resolves.toMatchObject({ key: plan.key })
    expect(run.mock.calls.filter(([, args]) => args[0] !== "--help")).toHaveLength(2)
  })
})
