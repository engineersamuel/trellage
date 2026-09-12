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
  type AdminInstalledVersionState,
} from "../src/admin-harness-version.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import { CommandRunnerError, type CommandRunner, type CommandRunResult } from "../src/guide-launch.ts"

const sandboxEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "sandbox:claude-blog",
  surface: "sandbox",
  harness: "claude",
  name: "claude-blog",
  description: "Sandboxed Claude profile.",
  commandPath: "/usr/local/bin/trellage",
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
  ...sandboxEntry(),
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
const help: CommandRunResult = { stdout: "usage: launcher harness-update", stderr: "", exitCode: 0 }
const successfulRun = () => vi.fn<CommandRunner["run"]>(async (_executable, args) => (args[0] === "--help" ? help : success))

describe("harnessUpdatePlanFor", () => {
  it.each(["claude", "codex", "copilot", "pi", "prime", "headlong"])(
    "updates every container profile for %s, without including other surfaces or harnesses",
    (harness) => {
      const selected = sandboxEntry({ harness, ref: `sandbox:${harness}-a`, name: `${harness}-a` })
      const peer = sandboxEntry({ harness, ref: `sandbox:${harness}-b`, name: `${harness}-b` })
      const other = sandboxEntry({ harness: "other", ref: "sandbox:other", name: "other" })
      const native = nativeEntry("cpx", harness)
      const plan = requirePlan(selected, [peer, other, native, selected, peer])

      expect(plan.key).toBe(`sandbox:${harness}`)
      expect(plan.targets).toEqual([selected, peer])
      expect(plan.steps.map(({ command }) => command)).toEqual([
        { executable: selected.commandPath, args: ["upgrade", selected.name, "--strict-harness"] },
        { executable: peer.commandPath, args: ["upgrade", peer.name, "--strict-harness"] },
      ])
    },
  )

  it.each([
    ["cpx", "copilot", "hve", ["harness-update"]],
    ["cdx", "codex", "youtube", ["harness-update"]],
    ["cdx", "codex", "superpowers", ["harness-update"]],
    ["grx", "grok", "superpowers", ["harness-update"]],
    ["cldx", "claude", "default", ["harness-update"]],
    ["omp", "oh-my-pi", "copilot", ["update", "copilot"]],
    ["jcx", "jcode", "default", ["update", "default"]],
    ["picx", "pi", "default", ["update", "default"]],
    ["prx", "prime", "default", ["update", "default"]],
    ["fmx", "firstmate", "pstack-workers", ["update", "pstack-workers"]],
  ] as const)("uses %s's harness command, not a plugin update or container rebuild", (launcher, harness, name, args) => {
    const selected = nativeEntry(launcher, harness, name)
    const container = sandboxEntry({ harness })
    const plan = requirePlan(selected, [selected, container])
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
    for (const selected of [sandboxEntry(), nativeEntry("cpx", "copilot", "hve")]) {
      const plan = requirePlan(selected, [selected], result)
      expect(plan.targets).toEqual([selected])
      expect(plan.latestVersion).toBe(result?.latest.kind === "known" ? result.latest.version : undefined)
    }
  })

  it("keeps native Pi Coding Agent, native Oh My Pi, and container Oh My Pi in separate update groups", () => {
    const pi = nativeEntry("picx", "pi")
    const omp = nativeEntry("omp", "oh-my-pi", "local")
    const container = sandboxEntry({ harness: "pi", ref: "sandbox:pi", name: "pi" })
    const entries = [pi, omp, container]
    const plans = entries.map((selected) => requirePlan(selected, entries))

    expect(plans.map(({ key }) => key)).toEqual(["native:picx", "native:omp", "sandbox:pi"])
    expect(plans.map(({ targets }) => targets)).toEqual([[pi], [omp], [container]])
  })

  it("does not select another runtime executable with the same harness label", () => {
    const selected = nativeEntry("cpx", "copilot", "hve")
    const otherRuntime = { ...nativeEntry("cpx", "copilot", "awesome"), commandPath: "/different/cpx" }
    expect(requirePlan(selected, [selected, otherRuntime]).targets).toEqual([selected])
  })

  it("groups native Codex profiles without including Grok superpowers or Codex containers", () => {
    const youtube = nativeEntry("cdx", "codex", "youtube")
    const superpowers = nativeEntry("cdx", "codex", "superpowers")
    const grok = nativeEntry("grx", "grok", "superpowers")
    const container = sandboxEntry({ harness: "codex", ref: "sandbox:codex", name: "codex" })
    const entries = [youtube, superpowers, grok, container]

    for (const selected of [youtube, superpowers]) {
      const plan = requirePlan(selected, entries)
      expect(plan.key).toBe("native:cdx")
      expect(plan.targets).toEqual([superpowers, youtube])
      expect(plan.steps).toHaveLength(1)
    }
    expect(requirePlan(grok, entries).targets).toEqual([grok])
    expect(requirePlan(container, entries).targets).toEqual([container])
  })

  it("fails closed for unsupported launchers and unknown or incomplete entries", () => {
    const unsupported = [nativeEntry("unknown", "copilot"), sandboxEntry({ harness: "unknown" }), sandboxEntry({ commandPath: "" })]
    for (const selected of unsupported) {
      expect(harnessUpdateKeyFor(selected)).toBeUndefined()
      expect(harnessUpdatePlanFor(selected, [selected], versionResult("1.0.0", "2.0.0"))).toBeUndefined()
    }
    expect(harnessUpdatePlanFor(sandboxEntry(), [], undefined)).toBeUndefined()
  })
})

describe("runHarnessUpdate", () => {
  it.each([
    ["cpx", "copilot", ["awesome", "hve"]],
    ["cdx", "codex", ["youtube", "superpowers", "pstack"]],
    ["grx", "grok", ["superpowers"]],
    ["cldx", "claude", ["default"]],
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
    const entries = ["awesome", "hve"].map((name) => nativeEntry("cpx", "copilot", name))
    const plan = requirePlan(entries[0]!, entries)
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "--help") return help
      throw new Error("download failed")
    })
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")

    expect(run).toHaveBeenCalledTimes(2)
    expect(outcome.results).toEqual(entries.map(({ ref, name }) => ({ ref, name, state: "failure", diagnostic: "download failed" })))
  })

  it.each(["sandbox", "firstmate"])("updates %s profiles sequentially and continues after failures", async (kind) => {
    const entries = ["a", "b", "c"].map((name) =>
      kind === "sandbox" ? sandboxEntry({ ref: `sandbox:claude-${name}`, name: `claude-${name}` }) : nativeEntry("fmx", "firstmate", name),
    )
    const plan = requirePlan(entries[0]!, entries)
    let active = 0
    let peak = 0
    const run = vi.fn<CommandRunner["run"]>(async (executable, args) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      if (args[1] === entries[1]!.name) {
        throw new CommandRunnerError({
          kind: "exited",
          executable,
          args,
          exitCode: 1,
          message: "command failed",
          stdout: "",
          stderr: "registry unavailable",
        })
      }
      return success
    })
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")

    expect(peak).toBe(1)
    expect(run.mock.calls.map(([, args]) => args[1])).toEqual(entries.map(({ name }) => name))
    expect(outcome.results.map(({ state }) => state)).toEqual(["success", "failure", "success"])
    expect(outcome.results[1]).toMatchObject({ diagnostic: "registry unavailable" })
  })

  it("does not forward an unsupported management verb to an old native launcher", async () => {
    const plan = requirePlan(nativeEntry("cldx", "claude"))
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({ ...success, stdout: "usage: cldx [PROFILE] [ARGS]" })
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["--help"]])
    expect(outcome.results).toEqual([
      expect.objectContaining({ state: "failure", diagnostic: expect.stringContaining("Refresh the installed Trellage launcher") }),
    ])
  })

  it.each([
    ["claude", "upgrade fallback: harness claude@latest -> 2.1.252"],
    [
      "headlong",
      "upgrade fallback: source https://github.com/laude-institute/headlong.git@main -> aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
  ])("reports %s harness fallback as failure even if an older container command exits successfully", async (harness, fallback) => {
    const plan = requirePlan(sandboxEntry({ harness }))
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
      ...success,
      stdout: `${fallback}\nupgraded: fixture`,
    })
    const outcome = await runHarnessUpdate(plan, { run }, "/worktree")
    expect(outcome.results).toEqual([
      expect.objectContaining({ state: "failure", diagnostic: expect.stringContaining("Harness was not updated") }),
    ])
  })
})

describe("harness update version refresh", () => {
  it.each([
    ["omp", "oh-my-pi", 1],
    ["cdx", "codex", 1],
    ["grx", "grok", 1],
    ["cldx", "claude", 1],
    ["fmx", "firstmate", 2],
    ["sandbox", "claude", 2],
  ] as const)("refreshes the correct installed scopes for %s", async (launcher, harness, expectedReads) => {
    const entries = ["a", "b"].map((name) => {
      if (launcher === "sandbox") return sandboxEntry({ ref: `sandbox:claude-${name}`, name: `claude-${name}` })
      return nativeEntry(launcher, harness, name)
    })
    const plan = requirePlan(entries[0]!, entries)
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
      stdout: JSON.stringify({ schemaVersion: 1, installed: "3.0.0", latest: "3.0.0", latestKnown: true }),
      stderr: "",
      exitCode: 0,
    })
    const manager = new AdminRunManager({ runner: { run } })
    const cacheEntries: Record<string, AdminHarnessVersionCacheEntry> = {}
    const installedByRef = new Map<string, AdminInstalledVersionState>()

    await refreshHarnessUpdateVersions(plan, manager, { schemaVersion: 2, entries: cacheEntries }, (key, entry, source) => {
      cacheEntries[key] = entry
      if (source.surface === "sandbox") installedByRef.set(source.ref, entry.result.installed)
    })
    expect(run).toHaveBeenCalledTimes(expectedReads)
    expect(run.mock.calls.every(([, args]) => !args.includes("--refresh-latest"))).toBe(true)
    const refreshed = reconcileHarnessVersionResults(
      entries,
      (key) => cacheEntries[key]?.result,
      (ref) => installedByRef.get(ref),
    )
    for (const entry of entries) {
      expect(refreshed.get(entry.ref)?.installed).toEqual({ kind: "known", version: "3.0.0" })
    }
  })

  it("waits for a pre-update version check, then reads the newly installed version", async () => {
    const selected = sandboxEntry()
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
    const oldCheck = manager.trigger(harnessVersionRefFor("sandbox:claude-code"), selected.commandPath, ["harness-version", selected.name])
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
    const entries = ["awesome", "hve"].map((name) => nativeEntry("cpx", "copilot", name))
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

  it("does not block container updates while the equivalent native harness is updating", async () => {
    const nativePlan = requirePlan(nativeEntry("cpx", "copilot", "hve"))
    const containerPlan = requirePlan(sandboxEntry({ harness: "copilot" }))
    const run = successfulRun()
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    await Promise.all([manager.run(nativePlan, async () => {}), manager.run(containerPlan, async () => {})])
    expect(
      run.mock.calls
        .filter(([, args]) => args[0] !== "--help")
        .map(([, args]) => args)
        .sort(),
    ).toEqual([["harness-update"], ["upgrade", "claude-blog", "--strict-harness"]])
  })

  it("surfaces refresh failures and releases the group so a later retry is possible", async () => {
    const plan = requirePlan(sandboxEntry())
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(success)
    const manager = new HarnessUpdateManager({ run }, "/worktree")
    await expect(
      manager.run(plan, async () => {
        throw new Error("refresh failed")
      }),
    ).rejects.toThrow("refresh failed")
    expect(manager.isRunning(plan.key)).toBe(false)
    await expect(manager.run(plan, async () => {})).resolves.toMatchObject({ key: plan.key })
    expect(run).toHaveBeenCalledTimes(2)
  })
})
