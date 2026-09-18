import { describe, expect, it } from "vitest"
import {
  parseFirstmateFleetReadinessV1,
  type FirstmateFleetReadinessV1,
} from "@trellage/guide-core"
import {
  CommandRunnerError,
  type CommandRunner,
  type CommandRunOptions,
  type CommandRunResult,
} from "../src/guide-launch.ts"
import {
  FirstmatePreparationError,
  ProfileReadinessKind,
  firstmateActionReadiness,
  firstmateInstallationPlan,
  firstmateMaintenanceCommand,
  firstmatePrerequisiteStatus,
  prepareFirstmateReadiness,
  type FirstmatePreparationApproval,
} from "../src/guide-preflight.ts"
import {
  missingToolsFleet,
  preparationInventory,
  preparationPlan,
  preparationProfile,
  preparationRevision,
  preparedFleet,
} from "./helpers/firstmate-preparation-fixtures.ts"

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string>; options?: CommandRunOptions }> = []

  constructor(private readonly outcomes: ReadonlyArray<CommandRunResult | Error>) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    const outcome = this.outcomes[this.calls.length - 1]
    if (outcome === undefined) throw new Error("Unexpected preparation command.")
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}

const ok = (fleet: FirstmateFleetReadinessV1 = preparedFleet()): CommandRunResult =>
  ({ stdout: preparationInventory(fleet), stderr: "", exitCode: 0 })
const selected = preparationProfile()
const approval: FirstmatePreparationApproval = {
  commandPath: selected.commandPath, profile: selected.profile,
  sourceRevision: preparationRevision, installation: preparationPlan,
}
const prepareArgs = ["prepare", "default", "--json", "--expected-source-revision", preparationRevision]

describe("Firstmate preparation client", () => {
  it("repairs only through the advertised validated command and returns actual readiness without launching work", async () => {
    const runner = new FakeRunner([ok()])
    const signal = new AbortController().signal
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller", { signal })).resolves.toEqual(preparedFleet())
    expect(runner.calls).toEqual([{
      executable: selected.commandPath, args: prepareArgs,
      options: { cwd: "/fixture/caller", timeoutMs: 300_000, terminationGraceMs: 10_000, signal },
    }])
    expect(firstmateActionReadiness(selected, preparedFleet(), "recover").kind).toBe(ProfileReadinessKind.Ready)
  })

  it("does not infer safe preparation from an fmx name on a legacy contract", async () => {
    const { preparation: _preparation, ...orchestration } = selected.orchestration!
    const runner = new FakeRunner([])
    await expect(prepareFirstmateReadiness(runner, { ...selected, orchestration }, "/fixture/caller"))
      .rejects.toThrow("does not advertise safe preparation")
    expect(runner.calls).toEqual([])
  })

  it.each([
    { profile: "default;touch unexpected" },
    { commandPath: "fmx" },
    { orchestration: { ...selected.orchestration!, sourceRevision: "--install-prerequisites" } },
    { launcher: "cdx" },
  ])("rejects an invalid selected identity before any command ($profile $launcher)", async (change) => {
    const runner = new FakeRunner([])
    await expect(prepareFirstmateReadiness(runner, { ...selected, ...change }, "/fixture/caller")).rejects.toThrow()
    expect(runner.calls).toEqual([])
  })

  it("keeps setup consent separate from exact managed-tool installation approval", async () => {
    const runner = new FakeRunner([ok(missingToolsFleet()), ok()])
    const fleet = await prepareFirstmateReadiness(runner, selected, "/fixture/caller")
    expect(fleet.consentRequired).toBe(false)
    expect(firstmateInstallationPlan(fleet)).toEqual(preparationPlan)
    expect(runner.calls[0]?.args).toEqual(prepareArgs)
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller", { approval })).resolves.toEqual(preparedFleet())
    expect(runner.calls[1]).toEqual({
      executable: selected.commandPath, args: [...prepareArgs, "--install-prerequisites", preparationPlan.identity],
      options: { cwd: "/fixture/caller", timeoutMs: 1_200_000, terminationGraceMs: 10_000 },
    })
  })

  it.each(["commandPath", "profile", "sourceRevision"] as const)("rejects approval after selected %s changes", async (field) => {
    const runner = new FakeRunner([])
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller", {
      approval: { ...approval, [field]: field === "sourceRevision" ? "a".repeat(40) : "/fixture/other" },
    })).rejects.toThrow("different profile or source revision")
    expect(runner.calls).toEqual([])
  })

  it("rejects a malformed plan without forwarding an installation argument", async () => {
    const runner = new FakeRunner([])
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller", {
      approval: { ...approval, installation: { ...preparationPlan, identity: "--yes" } },
    })).rejects.toThrow("hexadecimal")
    expect(runner.calls).toEqual([])
  })

  it.each(["missing-result", "wrong-profile", "wrong-source", "invalid-json"] as const)("rejects unsupported successful output (%s)", async (kind) => {
    const fleet = preparedFleet()
    const { preparation: _preparation, ...legacyFleet } = fleet
    const output = kind === "invalid-json" ? "Preparing..."
      : kind === "missing-result" ? preparationInventory(legacyFleet)
      : preparationInventory({
          ...fleet,
          identity: { ...fleet.identity!, [kind === "wrong-profile" ? "profile" : "sourceRevision"]: kind === "wrong-profile" ? "other" : "c".repeat(40) },
        })
    const runner = new FakeRunner([{ stdout: output, stderr: "", exitCode: 0 }])
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller")).rejects.toThrow()
    expect(runner.calls).toHaveLength(1)
  })

  it("preserves repair reports but never treats nonzero output as readiness success or retries it", async () => {
    const runner = new FakeRunner([new CommandRunnerError({
      kind: "exited", executable: selected.commandPath, args: prepareArgs, exitCode: 7,
      stdout: preparationInventory(preparedFleet()), stderr: "The managed lock changed during verification.",
      message: "Preparation command exited.",
    })])
    const error = await prepareFirstmateReadiness(runner, selected, "/fixture/caller").catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(FirstmatePreparationError)
    expect(error).toMatchObject({
      message: "Firstmate preparation failed (exit 7): The managed lock changed during verification.",
      fleet: preparedFleet(),
    })
    expect(runner.calls).toHaveLength(1)
  })

  it("reports a stale native lock refusal with the new plan, without approving it again", async () => {
    const current = parseFirstmateFleetReadinessV1({
      ...missingToolsFleet(),
      preparation: {
        ...missingToolsFleet().preparation!, diagnostic: "The prerequisite lock changed. Review the new plan.",
        installation: { ...preparationPlan, identity: "e".repeat(64) },
      },
    })
    const runner = new FakeRunner([new CommandRunnerError({
      kind: "exited", executable: selected.commandPath, args: prepareArgs, exitCode: 1,
      stdout: preparationInventory(current), message: "Native lock guard refused installation.",
    })])
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller", { approval })).rejects.toMatchObject({
      message: expect.stringContaining("lock changed"),
      fleet: current,
    })
    expect(runner.calls.map(({ args }) => args)).toEqual([[...prepareArgs, "--install-prerequisites", preparationPlan.identity]])
  })

  it("does not start a command for an already cancelled preparation", async () => {
    const abort = new AbortController()
    abort.abort()
    const runner = new FakeRunner([])
    await expect(prepareFirstmateReadiness(runner, selected, "/fixture/caller", { signal: abort.signal })).rejects.toThrow()
    expect(runner.calls).toEqual([])
  })
})

describe("Firstmate preparation diagnostics and permissions", () => {
  it("keeps manual maintenance on the selected worktree backend, including paths with spaces", () => {
    const profile = { ...selected, commandPath: "/worktrees/Firstmate candidate/bin/fmx" }
    const fleet = preparedFleet()
    const blocked = { allowed: false, reason: "Setup consent is required." }
    const setupRequired = parseFirstmateFleetReadinessV1({
      ...fleet, consentRequired: true,
      actions: { ...fleet.actions, start: blocked, recover: blocked },
    })
    expect(firstmateMaintenanceCommand(profile, "doctor"))
      .toBe("'/worktrees/Firstmate candidate/bin/fmx' doctor default")
    expect(firstmateActionReadiness(profile, setupRequired, "recover")).toMatchObject({
      kind: ProfileReadinessKind.Blocked,
      diagnostic: expect.stringContaining("Run '/worktrees/Firstmate candidate/bin/fmx' setup default, then refresh."),
    })
  })

  it("names the actual missing tools, without blaming ready authentication or repeating generic native text", () => {
    const readiness = firstmateActionReadiness(selected, missingToolsFleet(), "recover")
    expect(readiness).toMatchObject({
      kind: ProfileReadinessKind.Blocked,
      diagnostic: "These prerequisites are not ready:\n  fleet-tools: Missing managed tools: herdr 0.14.0, bv 0.9.3.\nReview the managed-tool installation plan before approval.",
    })
  })

  it("uses explicit statuses first and treats old skipped checks as not checked during runtime drift", () => {
    const drift: FirstmateFleetReadinessV1 = {
      ...preparedFleet(), runtime: "drift",
      prerequisites: [
        { id: "claude", ready: false, description: "Claude authentication" },
        { id: "github", ready: false, description: "GitHub authentication", status: "blocked" },
        { id: "skills", ready: true, description: "Shared skills" },
      ],
    }
    expect(drift.prerequisites.map((item) => firstmatePrerequisiteStatus(drift, item))).toEqual(["not-checked", "blocked", "ready"])
    expect(firstmateActionReadiness(selected, drift, "start")).toMatchObject({
      kind: ProfileReadinessKind.Blocked, diagnostic: expect.stringContaining("runtime is drift"),
    })
  })

  it.each(["blocked", "repairable"] as const)("does not use %s preparation as a ban on allowed live-fleet Send work", (state) => {
    const live = parseFirstmateFleetReadinessV1({
      ...preparedFleet("default", "running"),
      activeWorkers: 3,
      preparation: { schemaVersion: 1, state, diagnostic: "Repair is not safe while workers are active.", installation: null, repairs: [] },
    })
    expect(firstmateActionReadiness(selected, live, "submit").kind).toBe(ProfileReadinessKind.Ready)
    expect(firstmateActionReadiness(selected, live, "recover").kind).toBe(ProfileReadinessKind.Blocked)
    expect(firstmateInstallationPlan(live)).toBeUndefined()
  })

  it.each(["blocked", "runtime", "supervisor", "workers"] as const)("never offers installation for a guarded plan (%s)", (guard) => {
    const fleet = missingToolsFleet()
    const guarded: FirstmateFleetReadinessV1 = {
      ...fleet,
      ...(guard === "blocked" ? { preparation: { ...fleet.preparation!, state: "blocked" as const } }
        : guard === "runtime" ? { runtime: "unsafe" as const }
        : guard === "supervisor" ? { supervisor: { state: "running" as const, pid: 312 } }
        : { activeWorkers: 1 }),
    }
    expect(firstmateInstallationPlan(guarded)).toBeUndefined()
  })
})
