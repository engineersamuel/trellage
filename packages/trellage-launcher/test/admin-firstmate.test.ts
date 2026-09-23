import { describe, expect, it, vi } from "vitest"
import {
  canonicalFirstmateInstanceJson,
  parseFirstmateInstanceDescriptorV1,
  type FirstmateInstanceDescriptorV1,
} from "@trellage/guide-core"
import { runBatchedDoctorChecks } from "../src/admin-batch-scheduler.ts"
import { adminFirstmateMutationBlockReason } from "../src/admin-firstmate.ts"
import { harnessUpdateAllPlanFor, harnessUpdateAllSummary, runAllHarnessUpdates } from "../src/admin-harness-update-all.ts"
import { HarnessUpdateManager, harnessUpdatePlanFor } from "../src/admin-harness-update.ts"
import { parseHarnessVersionCacheRecord, type AdminHarnessVersionCacheEntry } from "../src/admin-harness-version-cache.ts"
import { runBatchedHarnessVersionChecks } from "../src/admin-harness-version-scheduler.ts"
import {
  buildHarnessVersionCommand,
  harnessVersionEntriesForForceResync,
  harnessVersionOperationKeyFor,
  reconcileHarnessVersionResults,
} from "../src/admin-harness-version.ts"
import { buildInventoryCommand, parseInventoryOutput } from "../src/admin-inventory.ts"
import {
  buildAdminLaunchCommand, buildDiagnosticCommand, buildRepairCommand, buildSetupCommand,
  isAutoRepairSupported, isRepairSupported, launchAdminProfile, repairRefFor, repairThenRecheckDoctor, toSelectedProfile,
} from "../src/admin-launch.ts"
import {
  adminFirstmateInstanceRef, adminProfileLabel, aggregateAdminInstanceProfiles, aggregateAdminProfiles,
  toProfileGuideIdentity, type AdminProfileEntry,
} from "../src/admin-model.ts"
import { discoverAdminInstanceEntries, refreshAdminEntries } from "../src/admin-refresh.ts"
import { AdminRunManager } from "../src/admin-run-manager.ts"
import { checkAdminSkillsUpdates } from "../src/admin-skills-check.ts"
import { nativeSkillsUpdateCommand } from "../src/admin-skills-update.ts"
import { adminVisibleRowRange, filterAdminProfiles, sortAdminProfiles } from "../src/admin-table.ts"
import { buildUpdateCheckCommand } from "../src/admin-version-check.ts"
import { runBatchedVersionChecks } from "../src/admin-version-scheduler.ts"
import { createFirstmateInstanceContext } from "../src/guide-firstmate-instance-selection.ts"
import { CommandRunnerError, type CommandRunResult, type CommandRunner } from "../src/guide-launch.ts"
import {
  alpha, beta, firstmateCatalog, firstmatePin, instanceContractFixtures, instanceFleet, instanceInventory,
  instancePage, instanceRows, legacy, missingLegacy, mixedInstanceCatalog,
} from "./admin-firstmate-fixtures.ts"

const output = (stdout = ""): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })
const namedRows = () => instanceRows().filter((entry) => entry.firstmateInstance?.mode === "named")
const selectorOf = (args: ReadonlyArray<string>): string | undefined => {
  const index = args.indexOf("--instance")
  return index < 0 ? undefined : args[index + 1]
}
const contextOf = (args: ReadonlyArray<string>): unknown => JSON.parse(args[args.indexOf("--fmx-instance-context-json") + 1]!)
const bySelector = (args: ReadonlyArray<string>): FirstmateInstanceDescriptorV1 =>
  selectorOf(args) === alpha.reference.instanceId ? alpha : selectorOf(args) === beta.reference.instanceId ? beta : missingLegacy

describe("read-only Admin instance discovery", () => {
  it("publishes discovered instances before slow readiness probes finish", async () => {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let published: ReadonlyArray<AdminProfileEntry> | undefined
    let readinessStarted!: () => void
    const started = new Promise<void>((resolve) => { readinessStarted = resolve })
    const run: CommandRunner["run"] = async (_executable, args) => {
      if (args[0] === "instances") return output(instancePage([missingLegacy, alpha, beta]))
      readinessStarted()
      await waiting
      return output(instanceInventory(bySelector(args)))
    }
    const refresh = refreshAdminEntries({ run }, firstmateCatalog(), "/work/entry", () => 100, {
      onDiscovered: (rows) => { published = rows },
    })
    await started
    try {
      expect(published?.map((row) => row.ref)).toEqual(instanceRows().map((row) => row.ref))
    } finally {
      release()
      await refresh
    }
  })

  it("returns all static surfaces plus named and legacy rows using listing alone", async () => {
    const catalog = mixedInstanceCatalog()
    const descriptors = [missingLegacy, alpha, beta]
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      expect(args.slice(0, 3)).toEqual(["instances", "list", "default"])
      return output(instancePage(descriptors, args.includes("--cursor") ? 1 : 0, args.includes("--cursor") ? 2 : 1))
    })
    const rows = await discoverAdminInstanceEntries({ run }, catalog, "/work/entry", undefined, 1500)
    const templates = aggregateAdminProfiles(catalog)
    expect(rows.map(({ ref }) => ref)).toEqual(["native:cpx/default", ...instanceRows().map(({ ref }) => ref), "sandbox:container"])
    expect(rows[0]).toEqual(templates[0])
    expect(rows.at(-1)).toEqual(templates.at(-1))
    expect(rows.every((row) => row.lastCheckedAt === undefined && row.firstmateFleet === undefined)).toBe(true)
    expect(rows.find((row) => row.firstmateInstance?.instanceId === alpha.reference.instanceId)?.health).toBe("unknown")
    expect(catalog.native).toHaveLength(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls.every(([executable, , options]) => executable === "/fixture/fmx" && options?.timeoutMs === 1500 && options.cwd === "/work/entry")).toBe(true)
  })

  it("returns unchanged static coverage without a command when instance support is absent", async () => {
    const catalog = mixedInstanceCatalog(false)
    const run = vi.fn<CommandRunner["run"]>()
    expect(await discoverAdminInstanceEntries({ run }, catalog, "/work/entry")).toEqual(aggregateAdminProfiles(catalog))
    expect(run).not.toHaveBeenCalled()
  })

  it.each(["invalid", "stale", "unsafe"])("rejects %s listing instead of returning partial maintenance targets", async (failure) => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      expect(args[0]).toBe("instances")
      if (failure === "invalid") return output("{invalid-json")
      if (failure === "unsafe") return output(JSON.stringify({
        schemaVersion: 1, profile: "default", state: "blocked", instances: [], page: null,
        diagnostics: [{ code: "unsafe-state", message: "The registry cannot be enumerated safely." }],
      }))
      return output(JSON.stringify(args.includes("--cursor") ? instanceContractFixtures.listStaleCursor : instanceContractFixtures.list))
    })
    await expect(discoverAdminInstanceEntries({ run }, mixedInstanceCatalog(), "/work/entry")).rejects.toThrow(/discovery is incomplete/)
    expect(run.mock.calls.every(([, args]) => args[0] === "instances")).toBe(true)
  })

  it("honors cancellation before returning an otherwise complete target list", async () => {
    const controller = new AbortController()
    let complete!: (result: CommandRunResult) => void
    const pending = new Promise<CommandRunResult>((resolve) => { complete = resolve })
    const run = vi.fn<CommandRunner["run"]>(() => pending)
    const discovery = discoverAdminInstanceEntries({ run }, mixedInstanceCatalog(), "/work/entry", controller.signal)
    const rejected = expect(discovery).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    controller.abort()
    complete(output(instancePage([missingLegacy, alpha, beta])))
    await rejected
    await expect(discoverAdminInstanceEntries({ run }, mixedInstanceCatalog(false), "/work/entry", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("does not publish refresh results when cancellation occurs during readiness reads", async () => {
    const controller = new AbortController()
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "instances") return output(instancePage([missingLegacy, alpha, beta]))
      expect(args[0]).toBe("inventory")
      controller.abort()
      return output(instanceInventory(bySelector(args)))
    })
    await expect(refreshAdminEntries({ run }, firstmateCatalog(), "/work/entry", () => 1000, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" })
    expect(run.mock.calls.some(([, args]) => args[0] === "inventory")).toBe(true)
  })
})

describe("Firstmate Admin runtime rows", () => {
  it("keeps templates static and gives every instance its own row, label, and guide lookup", () => {
    const catalog = firstmateCatalog()
    const rows = instanceRows()
    expect(aggregateAdminProfiles(catalog).map(({ ref }) => ref)).toEqual(["native:fmx/default"])
    expect(catalog.native.map(({ name }) => name)).toEqual(["default"])
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(({ ref }) => ref)).size).toBe(3)
    for (const row of rows) {
      expect(row.name).toBe("default")
      expect(row.templateRef).toBe("native:fmx/default")
      expect(toSelectedProfile(row).profile).toBe("default")
      expect(toProfileGuideIdentity(row)).toEqual({ surface: "native", launcher: "fmx", profile: "default" })
    }
    expect(rows[0]?.firstmateInstance).toBeUndefined()
    expect(rows[0]?.firstmateInstanceDescriptor?.reference).toBeNull()
    expect(rows[0]?.install).toBe("not-installed")
    expect(sortAdminProfiles(rows, "name", "asc").map(adminProfileLabel)).toEqual(["default / alpha", "default / beta", "default / legacy"])
    expect(filterAdminProfiles(rows, beta.reference.instanceId).map(({ ref }) => ref)).toEqual([rows[2]!.ref])
    expect(filterAdminProfiles(rows, "/work/alpha")).toEqual([rows[1]])
    expect(adminFirstmateInstanceRef("native:fmx/default", { ...alpha, name: "renamed" })).toBe(rows[1]?.ref)
    const range = adminVisibleRowRange([...rows, ...rows], 5, 24)
    expect(range.start + range.count).toBe(6)
  })

  it("does not dispatch doctor, prepare, setup, or launch from pending Firstmate placeholders", async () => {
    const rows = aggregateAdminInstanceProfiles(firstmateCatalog())
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(output())
    await runBatchedDoctorChecks(rows, new AdminRunManager({ runner: { run } }))
    expect(run).not.toHaveBeenCalled()
    expect(rows[0]?.firstmateDiscovery).toBe("pending")
    expect(isAutoRepairSupported(rows[0]!)).toBe(false)
    expect(isRepairSupported(rows[0]!)).toBe(false)
    expect(() => buildAdminLaunchCommand(rows[0]!)).toThrow(/discovery/i)
    expect(() => buildRepairCommand(rows[0]!)).toThrow(/discovery/i)
    expect(() => buildSetupCommand(rows[0]!)).toThrow(/does not create/)
    expect(harnessUpdateAllPlanFor(rows).unsupported[0]?.diagnostic).toMatch(/discovery/i)
  })

  it("waits for a complete verified list and preserves rows during the readiness merge", async () => {
    const descriptors = [missingLegacy, alpha, beta]
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "instances") return output(instancePage(descriptors, args.includes("--cursor") ? 1 : 0, args.includes("--cursor") ? 2 : 1))
      expect(args[0]).toBe("inventory")
      return output(instanceInventory(bySelector(args)))
    })
    const rows = await refreshAdminEntries({ run }, firstmateCatalog(), "/work/entry", () => 100)
    expect(rows.map(({ ref }) => ref)).toEqual(instanceRows().map(({ ref }) => ref))
    expect(rows[0]).toMatchObject({ firstmateDiscovery: "complete", health: "unhealthy", install: "not-installed", stale: false })
    expect(rows.slice(1).map(({ health }) => health)).toEqual(["healthy", "healthy"])
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(["instances", "instances", "inventory", "inventory", "inventory"])
    expect(run.mock.calls[0]?.[1]).toEqual(["instances", "list", "default", "--json", "--limit", "32"])
    expect(run.mock.calls.slice(2).map(([, args]) => selectorOf(args))).toEqual(["legacy", alpha.reference.instanceId, beta.reference.instanceId])
  })

  it.each(["invalid", "stale", "unsafe"])("makes %s discovery explicit without publishing a healthy partial legacy-only list", async (failure) => {
    const pstackLegacy = parseFirstmateInstanceDescriptorV1({ ...missingLegacy, profile: "pstack-workers", root: "/state/firstmate/pstack-workers", taskIdPrefix: "fmp" })
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => {
      if (args[0] === "inventory") return output(instanceInventory(pstackLegacy))
      if (args[2] === "pstack-workers") return output(instancePage([pstackLegacy]))
      if (failure === "invalid") return output("{not-json")
      if (failure === "unsafe") return output(JSON.stringify({
        schemaVersion: 1, profile: "default", state: "blocked", instances: [], page: null,
        diagnostics: [{ code: "unsafe-state", message: "An unsafe registry root prevents complete discovery." }],
      }))
      return output(JSON.stringify(args.includes("--cursor") ? instanceContractFixtures.listStaleCursor : instanceContractFixtures.list))
    })
    const rows = await refreshAdminEntries({ run }, firstmateCatalog(true, ["default", "pstack-workers"]), "/work/entry")
    const failed = rows.find(({ name }) => name === "default")!
    expect(failed).toMatchObject({ firstmateDiscovery: "failed", health: "malformed-output", doctorSupported: false })
    expect(failed.healthDiagnostic).toMatch(/list is incomplete/)
    expect(rows.find(({ name }) => name === "pstack-workers")?.firstmateDiscovery).toBe("complete")
    expect(run.mock.calls.some(([, args]) => args[0] === "inventory" && args[1] === "default")).toBe(false)
    expect(harnessUpdateAllPlanFor(rows).unsupported.map(({ entry }) => entry.ref)).toContain(failed.ref)
  })

  it("isolates an inventory failure and rejects another instance's fleet evidence", async () => {
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) =>
      output(args[0] === "instances" ? instancePage([missingLegacy, alpha, beta]) : instanceInventory(selectorOf(args) === "legacy" ? missingLegacy : beta)))
    const rows = await refreshAdminEntries({ run }, firstmateCatalog(), "/work/entry")
    expect(rows[1]).toMatchObject({ health: "malformed-output", healthDiagnostic: expect.stringContaining("UUID") })
    expect(rows[2]?.health).toBe("healthy")
    expect(parseInventoryOutput(instanceInventory(beta), rows[1])).toMatchObject({ malformed: true })
  })

  it("rejects a malformed named descriptor after a valid legacy entry", async () => {
    const malformed = instancePage([legacy, alpha]).replace(alpha.root, `${alpha.root}-foreign`)
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(output(malformed))
    const rows = await refreshAdminEntries({ run }, firstmateCatalog(), "/work/entry")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firstmateDiscovery: "failed", health: "malformed-output" })
    expect(rows[0]?.firstmateInstanceDescriptor).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("keeps old no-capability discovery, selectors, and CLI bulk scope unchanged", async () => {
    const catalog = firstmateCatalog(false)
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(output(instanceInventory(legacy)))
    const rows = await refreshAdminEntries({ run }, catalog, "/work/entry")
    expect(run.mock.calls.map(([, args]) => args)).toEqual([["inventory", "default", "--json"]])
    expect(rows[0]).toMatchObject({ ref: "native:fmx/default", name: "default", health: "healthy" })
    expect(rows[0]?.firstmateDiscovery).toBeUndefined()
    expect(buildAdminLaunchCommand(rows[0]!).args).toEqual(["default"])
    expect(buildDiagnosticCommand(rows[0]!).args).toEqual(["doctor", "default"])
    expect(buildHarnessVersionCommand(rows[0]!).args).toEqual(["harness-version", "default"])
    expect(harnessVersionOperationKeyFor(rows[0]!)).toBe("native:fmx:default")
    expect(harnessUpdateAllPlanFor(aggregateAdminProfiles(firstmateCatalog())).groups[0]?.steps[0]?.command.args).toEqual(["update", "default"])
  })
})

describe("Firstmate Admin command and cache isolation", () => {
  it("retains selectors in every read command, skills check, and update check", async () => {
    const rows = namedRows()
    for (const row of rows) {
      const selector = ["--instance", row.firstmateInstance!.instanceId]
      expect(buildDiagnosticCommand(row).args).toEqual(["doctor", "default", ...selector])
      expect(buildInventoryCommand(row).args).toEqual(["inventory", "default", ...selector, "--json"])
      expect(buildUpdateCheckCommand(row).args).toEqual(["update", "--check", "default", ...selector])
      expect(buildHarnessVersionCommand(row).args).toEqual(["harness-version", "default", ...selector])
    }
    expect(buildInventoryCommand(instanceRows()[0]!).args).toEqual(["inventory", "default", "--instance", "legacy", "--json"])
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => output(args[0] === "--help"
      ? "launcher skills-check PROFILE\ntrx skills check --json"
      : args[0] === "update" ? `default is current (${firstmatePin})` : '{"kind":"current"}'))
    await checkAdminSkillsUpdates(rows, { run }, "/work/entry", "/fixture/trx", new AbortController().signal)
    await runBatchedVersionChecks(rows, new AdminRunManager({ runner: { run } }), { schemaVersion: 2, entries: {} })
    for (const verb of ["skills-check", "update"]) {
      expect(run.mock.calls.filter(([, args]) => args[0] === verb).map(([, args]) => selectorOf(args)))
        .toEqual([alpha.reference.instanceId, beta.reference.instanceId])
    }
    expect(run.mock.calls.every(([, args]) => !args.includes("--fmx-instance-context-json"))).toBe(true)
  })

  it("keeps two default installed versions, cached runs, and force refreshes separate", async () => {
    const rows = namedRows()
    const installed = new Map([[alpha.reference.instanceId, "a".repeat(40)], [beta.reference.instanceId, "b".repeat(40)]])
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => output(JSON.stringify({
      schemaVersion: 1, installed: installed.get(selectorOf(args)!), latestKnown: true, latest: firstmatePin,
    })))
    const manager = new AdminRunManager({ runner: { run } })
    const cacheEntries: Record<string, AdminHarnessVersionCacheEntry> = {}
    const cache = { schemaVersion: 2 as const, entries: cacheEntries }
    const options = { now: () => 1000, onResult: (key: string, value: AdminHarnessVersionCacheEntry) => { cacheEntries[key] = value } }
    await runBatchedHarnessVersionChecks(rows, manager, cache, options)
    await runBatchedHarnessVersionChecks(rows, manager, cache, options)
    expect(run).toHaveBeenCalledTimes(2)
    expect(Object.keys(cacheEntries)).toHaveLength(2)
    expect(parseHarnessVersionCacheRecord(JSON.stringify(cache))).toEqual(cache)
    const key = (entry: AdminProfileEntry) => harnessVersionOperationKeyFor(entry)!
    expect(cacheEntries[key(rows[0]!)]?.result.installed).toEqual({ kind: "known", version: "a".repeat(40) })
    expect(cacheEntries[key(rows[1]!)]?.result.installed).toEqual({ kind: "known", version: "b".repeat(40) })
    installed.set(alpha.reference.instanceId, firstmatePin)
    await runBatchedHarnessVersionChecks(harnessVersionEntriesForForceResync(rows[0]!, rows), manager, cache, { ...options, forceResync: true })
    expect(run).toHaveBeenCalledTimes(3)
    const reconciled = reconcileHarnessVersionResults(rows, (operation) => cacheEntries[operation]?.result)
    expect(reconciled.get(rows[0]!.ref)?.installed).toEqual({ kind: "known", version: firstmatePin })
    expect(reconciled.get(rows[1]!.ref)?.installed).toEqual({ kind: "known", version: "b".repeat(40) })
  })

  it("uses each template's catalog pin without promoting Firstmate latest values", () => {
    const base = firstmateCatalog(true, ["default", "pstack-workers"])
    const catalog = {
      ...base,
      native: base.native.map((entry) => entry.name === "default" ? entry : {
        ...entry, orchestration: { ...entry.orchestration!, sourceRevision: "c".repeat(40) },
      }),
    }
    const pstack = parseFirstmateInstanceDescriptorV1({
      ...beta, profile: "pstack-workers", reference: { ...beta.reference, profile: "pstack-workers" },
      runtime: { ...beta.runtime, required: { ...beta.runtime.required, sourceRevision: "c".repeat(40) } },
    })
    const pstackLegacy = parseFirstmateInstanceDescriptorV1({
      ...missingLegacy, profile: "pstack-workers", root: "/state/firstmate/pstack-workers", taskIdPrefix: "fmp",
    })
    const rows = aggregateAdminInstanceProfiles(catalog, [
      { ref: "native:fmx/default", state: "complete", instances: [missingLegacy, alpha] },
      { ref: "native:fmx/pstack-workers", state: "complete", instances: [pstackLegacy, pstack] },
    ]).filter((row) => row.firstmateInstance?.mode === "named")
    const results = reconcileHarnessVersionResults(rows, () => ({
      installed: { kind: "known", version: "a".repeat(40) }, latest: { kind: "known", version: "d".repeat(40) },
    }))
    expect(results.get(rows[0]!.ref)?.latest).toEqual({ kind: "known", version: firstmatePin })
    expect(results.get(rows[1]!.ref)?.latest).toEqual({ kind: "known", version: "c".repeat(40) })
  })

  it("builds launch and maintenance with the confirmed descriptor and refuses unconfirmed launch", async () => {
    const row = namedRows()[0]!
    const context = createFirstmateInstanceContext(alpha, null, "confirmed-join")
    const launch = buildAdminLaunchCommand(row)
    expect(launch.args).toEqual(["default", "--instance", alpha.reference.instanceId, "--fmx-instance-context-json", canonicalFirstmateInstanceJson(context)])
    const commands = [buildRepairCommand(row), nativeSkillsUpdateCommand(row)!, harnessUpdatePlanFor(row, [row], undefined)!.steps[0]!.command]
    for (const command of commands) {
      expect(selectorOf(command.args)).toBe(alpha.reference.instanceId)
      expect(contextOf(command.args)).toEqual(context)
      expect(command.args[1]).toBe("default")
    }
    expect(commands[0]?.args).toContain("--expected-source-revision")
    expect(commands[0]?.args).toContain(firstmatePin)
    const run = vi.fn(async () => {})
    await expect(launchAdminProfile(row, false, run)).rejects.toThrow(/confirmation/)
    expect(run).not.toHaveBeenCalled()
    await launchAdminProfile(row, true, run)
    expect(run).toHaveBeenCalledWith(launch)
  })

  it("refuses stale approval instead of replacing binding expectations", () => {
    const row = namedRows()[0]!
    const context = createFirstmateInstanceContext(alpha, null, "confirmed-join")
    const changed = {
      ...alpha,
      worktree: { ...alpha.worktree, evidence: { ...alpha.worktree.evidence, locators: { ...alpha.worktree.evidence.locators, worktree: "/work/moved" } } },
    }
    const stale = { ...row, firstmateInstanceDescriptor: changed, firstmateInstanceContext: context }
    expect(() => buildRepairCommand(stale)).toThrow(/current valid binding/)
    expect(() => buildAdminLaunchCommand(stale)).toThrow(/current valid binding/)
    expect(harnessUpdatePlanFor(stale, [stale], undefined)).toBeUndefined()
  })
})

describe("Firstmate safe Admin preparation and bulk maintenance", () => {
  it.each(["needs-consent", "blocked", "malformed", "transport", "foreign"])("never escalates %s preparation to setup, installation, or fleet creation", async (failure) => {
    const row = namedRows()[0]!
    const run = vi.fn<CommandRunner["run"]>(async (executable, args) => {
      if (args[0] === "doctor") throw new Error("doctor remains blocked")
      expect(args[0]).toBe("prepare")
      if (failure === "transport") throw new CommandRunnerError({ kind: "exited", executable, args, exitCode: 1, message: "refused", stderr: "Shared writer refused: beta is active." })
      if (failure === "malformed") return output("not-json")
      if (failure === "foreign") return output(instanceInventory(beta))
      return output(instanceInventory(alpha, {
        preparation: {
          schemaVersion: 1, state: failure === "needs-consent" ? "needs-consent" : "blocked",
          diagnostic: "Operator consent is required.", repairs: [],
          installation: failure === "needs-consent" ? {
            identity: "a".repeat(64), destination: "/state/tools", tools: [{ name: "claude", version: "1.0.0" }],
            sources: ["https://registry.example.invalid"], statePaths: [],
          } : null,
        },
      }))
    })
    const manager = new AdminRunManager({ runner: { run } })
    const outcome = await repairThenRecheckDoctor(row, manager)
    expect(outcome).toEqual({ repairState: "failure", doctorState: "failure" })
    expect(manager.status(repairRefFor(row)).state).toBe("failure")
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(["prepare", "doctor"])
    expect(run.mock.calls.every(([, args]) => selectorOf(args) === alpha.reference.instanceId)).toBe(true)
    expect(run.mock.calls.every(([, args]) => !args.includes("--install-prerequisites"))).toBe(true)
  })

  it("prepares an existing instance once, then rechecks only that doctor", async () => {
    const row = namedRows()[1]!
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => output(args[0] === "prepare" ? instanceInventory(beta) : "healthy"))
    const manager = new AdminRunManager({ runner: { run } })
    expect(await repairThenRecheckDoctor(row, manager)).toEqual({ repairState: "success", doctorState: "success" })
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(["prepare", "doctor"])
    expect(run.mock.calls.every(([, args]) => selectorOf(args) === beta.reference.instanceId)).toBe(true)
    expect(isAutoRepairSupported(row)).toBe(false)
    expect(manager.status(namedRows()[0]!.ref).state).toBe("idle")
  })

  it("does not treat unsafe fleet state as permission to maintain a published instance", async () => {
    const unsafe = { runtime: "unsafe" as const, supervisor: { state: "unsafe" as const, pid: null } }
    const run = vi.fn<CommandRunner["run"]>(async (_executable, args) => output(args[0] === "instances"
      ? instancePage([missingLegacy, alpha])
      : instanceInventory(selectorOf(args) === "legacy" ? missingLegacy : alpha, unsafe)))
    const refreshed = await refreshAdminEntries({ run }, firstmateCatalog(), "/work/entry")
    const row = refreshed[1]!
    expect(row.health).toBe("unhealthy")
    expect(row.firstmateFleet).toEqual(instanceFleet(alpha, unsafe))
    expect(isRepairSupported(row)).toBe(false)
    expect(() => buildAdminLaunchCommand(row)).toThrow(/unsafe fleet state/)
    expect(harnessUpdatePlanFor(row, refreshed, undefined)).toBeUndefined()
    expect(run.mock.calls.every(([, args]) => ["instances", "inventory"].includes(args[0]!))).toBe(true)
  })

  it.each(["creating", "incomplete", "missing-identity", "unsafe"] as const)("keeps %s creation inspectable without offering preparation or setup", (creationState) => {
    const descriptor = parseFirstmateInstanceDescriptorV1({
      ...alpha, creationState, diagnostics: [{ code: creationState === "missing-identity" ? "missing-identity" : "creation-incomplete", message: "Recover this same UUID." }],
    })
    const row = instanceRows([missingLegacy, descriptor])[1]!
    expect(isRepairSupported(row)).toBe(false)
    expect(adminFirstmateMutationBlockReason(row)).toContain(creationState)
    expect(() => buildSetupCommand(row)).toThrow(/does not create/)
    expect(buildDiagnosticCommand(row).args).toContain(alpha.reference.instanceId)
    expect(buildInventoryCommand(row).args).toContain(alpha.reference.instanceId)
  })

  it("materializes UUID bulk targets and reports independent and shared-writer refusals", async () => {
    const rows = instanceRows()
    const plan = harnessUpdateAllPlanFor(rows)
    expect(plan.unsupported).toHaveLength(1)
    expect(plan.groups[0]?.targets.map(({ ref }) => ref)).toEqual(rows.slice(1).map(({ ref }) => ref))
    expect(plan.groups[0]?.steps.map(({ command }) => selectorOf(command.args))).toEqual([alpha.reference.instanceId, beta.reference.instanceId])
    const run = vi.fn<CommandRunner["run"]>(async (executable, args) => {
      if (args[0] === "--help") return output("launcher skills-update PROFILE\ntrx skills update")
      if (args[0] === "skills" || selectorOf(args) === alpha.reference.instanceId) {
        throw new CommandRunnerError({ kind: "exited", executable, args, exitCode: 1, message: "refused", stderr: "Shared writer refused: another fleet is active." })
      }
      return output("updated")
    })
    const outcome = await runAllHarnessUpdates(plan, new HarnessUpdateManager({ run }, "/work/entry"), { refresh: async () => {} })
    expect(outcome.reports[0]?.outcome.results.map(({ ref, state }) => [ref, state])).toEqual([[rows[1]!.ref, "failure"], [rows[2]!.ref, "success"]])
    expect(outcome.skills?.cache).toMatchObject({ state: "failure", diagnostic: expect.stringContaining("another fleet is active") })
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ updated: 1, failed: 1, unsupported: 1, skillsCacheFailed: true, success: false })
    expect(run.mock.calls.filter(([, args]) => args[0] === "update")).toHaveLength(2)
    expect(run.mock.calls.every(([, args]) => !args.includes("--all") && !["setup", "create", "repair"].includes(args[0] ?? ""))).toBe(true)
  })

  it("does not attach a different UUID approval to an in-flight group", async () => {
    const rows = namedRows()
    const run = vi.fn<CommandRunner["run"]>().mockResolvedValue(output("updated"))
    const manager = new HarnessUpdateManager({ run }, "/work/entry")
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const first = manager.run(harnessUpdatePlanFor(rows[0]!, [rows[0]!], undefined)!, () => pending)
    await expect(manager.run(harnessUpdatePlanFor(rows[1]!, [rows[1]!], undefined)!, async () => {})).rejects.toThrow(/different instance targets/)
    finish()
    await first
    expect(run).toHaveBeenCalledTimes(1)
  })
})
