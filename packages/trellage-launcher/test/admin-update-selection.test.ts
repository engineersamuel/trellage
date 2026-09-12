import { describe, expect, it } from "vitest"
import type { AdminProfileEntry } from "../src/admin-model.ts"
import type { AdminHarnessVersionResult } from "../src/admin-harness-version.ts"
import type { AdminSkillsCheckResult } from "../src/admin-skills-check.ts"
import { harnessUpdateAllPlanFor, harnessUpdateAllSummary, runAllHarnessUpdates } from "../src/admin-harness-update-all.ts"
import { HarnessUpdateManager } from "../src/admin-harness-update.ts"
import { hasSelectedAdminUpdates, selectAvailableAdminUpdates } from "../src/admin-update-selection.ts"

const container = (name: string, selector = "latest"): AdminProfileEntry => ({
  ref: `sandbox:${name}`,
  surface: "sandbox",
  harness: "claude",
  name,
  description: name,
  commandPath: "/fixture/trellage",
  doctorSupported: false,
  inventorySupported: false,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
  harnessVersionSelector: selector,
})
const native = (name = "default"): AdminProfileEntry => ({
  ...container(name),
  ref: `native:cldx/${name}`,
  surface: "native",
  launcher: "cldx",
  commandPath: "/fixture/cldx",
})
const known = (installed = "2.0.0", latest = "3.0.0"): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "known", version: latest },
})
const checks = (entries: ReadonlyArray<AdminProfileEntry>, kind: AdminSkillsCheckResult["kind"] = "current") =>
  new Map(entries.map((entry) => [entry.ref, { kind }]))

describe("updates-only Admin selection", () => {
  it("selects only changed Container targets, preserving pins and exact commands", () => {
    const entries = [container("new"), container("current"), container("pinned", "2.0.0")]
    const selection = selectAvailableAdminUpdates(
      harnessUpdateAllPlanFor(entries),
      (entry) => known(entry.name === "current" ? "3.0.0" : "2.0.0"),
      checks(entries),
    )
    expect(selection.plan.profileCount).toBe(1)
    expect(selection.plan.groups[0]?.steps.map((step) => step.command.args)).toEqual([["upgrade", "new", "--strict-harness"]])
    expect(selection.issues).toEqual([])
    expect(selection.plan.skills).toBeUndefined()
  })

  it("keeps required final skill copies for changed shared Native runtimes", () => {
    const entries = [native("one"), native("two")]
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known(), checks(entries))
    expect(selection.plan.nativeUpdateCount).toBe(1)
    expect(selection.plan.groups[0]?.targets.map((entry) => entry.ref)).toEqual(entries.map((entry) => entry.ref))
    expect(selection.plan.skills?.targets).toEqual(entries)
    expect(selection.skillUpdateRefs.size).toBe(0)
    expect([...selection.dependentSkillRefs]).toEqual(entries.map((entry) => entry.ref))
  })

  it("selects Native skill changes without running an already-current harness updater", () => {
    const entries = [native()]
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), checks(entries, "available"))
    expect(selection.plan.groups).toEqual([])
    expect(selection.plan.profileCount).toBe(0)
    expect(selection.plan.skills?.targets).toEqual(entries)
    expect(hasSelectedAdminUpdates(selection.plan)).toBe(true)
  })

  it("rebuilds a current Container only when its skills have a known update", () => {
    const entries = [container("changed-skills"), container("current")]
    const skills = checks(entries)
    skills.set(entries[0]!.ref, { kind: "available" })
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), skills)
    expect(selection.plan.groups[0]?.targets).toEqual([entries[0]])
    expect(selection.plan.containerUpdateCount).toBe(1)
  })

  it("keeps unknown checks separate without selecting them or claiming they are current", () => {
    const entries = [native(), container("unknown")]
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => undefined, checks(entries, "unknown"))
    expect(hasSelectedAdminUpdates(selection.plan)).toBe(false)
    expect(selection.issues).toHaveLength(4)
    expect(selection.issues.map((issue) => issue.ref)).toEqual(expect.arrayContaining(entries.map((entry) => entry.ref)))
  })

  it("does not select any work when all known versions and skills match", () => {
    const entries = [native(), container("current")]
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), checks(entries))
    expect(hasSelectedAdminUpdates(selection.plan)).toBe(false)
    expect(selection.issues).toEqual([])
  })

  it("allows a shared-cache-only update without profile copies", () => {
    const entries = [native()]
    const skills = checks(entries)
    skills.set("skills:shared", { kind: "available" })
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), skills)
    expect(selection.plan.groups).toEqual([])
    expect(selection.plan.skills?.targets).toEqual([])
    expect(selection.sharedSkillsUpdate).toBe(true)
    expect(hasSelectedAdminUpdates(selection.plan)).toBe(true)
  })

  it("preserves the selected router path for cache-only updates in a Container-only catalog", () => {
    const entries = [container("current")]
    const skills = checks(entries)
    skills.set("skills:shared", { kind: "available" })
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), skills, "/fixture/worktree/trx")
    expect(selection.plan.skills).toEqual({
      refresh: { executable: "/fixture/worktree/trx", args: ["skills", "update"] },
      targets: [],
    })
    expect(selection.plan.groups).toEqual([])
  })

  it("retains partial check failures alongside a confirmed shared-cache update", () => {
    const entries = [native()]
    const skills: Map<string, AdminSkillsCheckResult> = checks(entries)
    skills.set("skills:shared", { kind: "available", diagnostic: "Guide cache source check failed." })
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), skills)
    expect(selection.sharedSkillsUpdate).toBe(true)
    expect(hasSelectedAdminUpdates(selection.plan)).toBe(true)
    expect(selection.issues).toContainEqual({ ref: "skills:shared", diagnostic: "Guide cache source check failed." })
  })

  it("reports a skill-only run as complete without inventing unrun harness profiles", async () => {
    const entries = [native()]
    const selection = selectAvailableAdminUpdates(harnessUpdateAllPlanFor(entries), () => known("3.0.0"), checks(entries, "available"))
    const commands: Array<ReadonlyArray<string>> = []
    const manager = new HarnessUpdateManager(
      {
        run: async (_executable, args) => {
          commands.push(args)
          return { stdout: args[0] === "--help" ? "trx skills update\ncldx skills-update PROFILE" : "done", stderr: "", exitCode: 0 }
        },
      },
      "/fixture",
    )
    const outcome = await runAllHarnessUpdates(selection.plan, manager, { refresh: async () => {} })
    expect(harnessUpdateAllSummary(outcome)).toMatchObject({ success: true, updated: 0, notRun: 0, nativeSkillsUpdated: 1 })
    expect(commands.filter((args) => args[0] !== "--help")).toEqual([
      ["skills", "update"],
      ["skills-update", "default"],
    ])
  })
})
