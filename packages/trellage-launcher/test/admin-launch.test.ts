import { describe, expect, it, vi } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.js"
import { AdminRunManager } from "../src/admin-run-manager.js"
import type { CommandRunOptions, CommandRunner, CommandRunResult } from "../src/guide-launch.js"
import { CommandRunnerError } from "../src/guide-launch.js"
import {
  buildAdminLaunchCommand,
  buildDiagnosticCommand,
  buildRepairCommand,
  buildSetupCommand,
  isRepairSupported,
  launchAdminProfile,
  LaunchNotConfirmedError,
  repairRefFor,
  repairThenRecheckDoctor,
  setupRefFor,
  toSelectedProfile,
} from "../src/admin-launch.js"

const nativeEntry: AdminProfileEntry = {
  ref: "native:cpx:default",
  surface: "native",
  launcher: "cpx",
  harness: "copilot",
  name: "default",
  description: "Copilot native profile.",
  commandPath: "/usr/local/bin/cpx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  updateCheckStale: false,
}

const sandboxEntry: AdminProfileEntry = {
  ref: "sandbox:prime-agent",
  surface: "sandbox",
  harness: "copilot",
  name: "prime-agent",
  description: "Sandboxed prime agent.",
  commandPath: "/usr/local/bin/trellage",
  doctorSupported: false,
  inventorySupported: false,
  health: "unknown",
  install: "unknown",
  stale: false,
  updateCheckSupported: false,
  updateCheckStale: false,
}

/** A hypothetical native launcher that lacks doctor support, to exercise the generic doctorSupported=false gate — no current native launcher (including cdx) actually lacks doctor support. */
const nativeDoctorUnsupportedEntry: AdminProfileEntry = {
  ...nativeEntry,
  ref: "native:hypothetical-unsupported:default",
  launcher: "hypothetical-unsupported",
  harness: "hypothetical",
  doctorSupported: false,
}

describe("toSelectedProfile", () => {
  it("maps a native admin entry to a native SelectedProfile", () => {
    expect(toSelectedProfile(nativeEntry)).toEqual({
      surface: "native",
      launcher: "cpx",
      commandPath: "/usr/local/bin/cpx",
      profile: "default",
      headlessPrompt: false,
    })
  })

  it("maps a sandbox admin entry to a sandbox SelectedProfile", () => {
    expect(toSelectedProfile(sandboxEntry)).toEqual({
      surface: "sandbox",
      commandPath: "/usr/local/bin/trellage",
      profile: "prime-agent",
      headlessPrompt: false,
    })
  })
})

describe("buildAdminLaunchCommand", () => {
  it("delegates to the existing guide-launch command builder (no prompt argv, plain profile launch)", () => {
    expect(buildAdminLaunchCommand(nativeEntry)).toEqual({
      executable: "/usr/local/bin/cpx",
      args: ["default"],
    })
  })
})

describe("buildDiagnosticCommand", () => {
  it("builds a native `doctor PROFILE` command", () => {
    expect(buildDiagnosticCommand(nativeEntry)).toEqual({
      executable: "/usr/local/bin/cpx",
      args: ["doctor", "default"],
    })
  })

  it("builds a sandbox `validate PROFILE` command", () => {
    expect(buildDiagnosticCommand(sandboxEntry)).toEqual({
      executable: "/usr/local/bin/trellage",
      args: ["validate", "prime-agent"],
    })
  })
})

describe("isRepairSupported", () => {
  it("is true for a native profile whose launcher supports doctor", () => {
    expect(isRepairSupported(nativeEntry)).toBe(true)
  })

  it("is false for a native profile whose launcher does not support doctor", () => {
    expect(isRepairSupported(nativeDoctorUnsupportedEntry)).toBe(false)
  })

  it("is false for a sandbox profile", () => {
    expect(isRepairSupported(sandboxEntry)).toBe(false)
  })
})

describe("buildRepairCommand", () => {
  it("builds a native `repair PROFILE` command using the same shape as buildDiagnosticCommand's doctor branch", () => {
    expect(buildRepairCommand(nativeEntry)).toEqual({
      executable: "/usr/local/bin/cpx",
      args: ["repair", "default"],
    })
  })
})

describe("launchAdminProfile", () => {
  it("refuses to launch without explicit confirmation", async () => {
    const run = vi.fn()
    await expect(launchAdminProfile(nativeEntry, false, run)).rejects.toBeInstanceOf(LaunchNotConfirmedError)
    expect(run).not.toHaveBeenCalled()
  })

  it("delegates to the injected runner with the built command once confirmed", async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    await launchAdminProfile(nativeEntry, true, run)
    expect(run).toHaveBeenCalledWith({ executable: "/usr/local/bin/cpx", args: ["default"] })
  })
})

describe("buildSetupCommand", () => {
  it("builds a native `setup PROFILE` command using the same shape as buildRepairCommand", () => {
    expect(buildSetupCommand(nativeEntry)).toEqual({
      executable: "/usr/local/bin/cpx",
      args: ["setup", "default"],
    })
  })
})

describe("repairRefFor", () => {
  it("builds a distinct ref namespaced under the profile's own ref", () => {
    expect(repairRefFor(nativeEntry)).toBe("native:cpx:default::repair")
  })
})

describe("setupRefFor", () => {
  it("builds a distinct ref namespaced under the profile's own ref, separate from repairRefFor", () => {
    expect(setupRefFor(nativeEntry)).toBe("native:cpx:default::setup")
    expect(setupRefFor(nativeEntry)).not.toBe(repairRefFor(nativeEntry))
  })
})

/** A scriptable fake runner: resolves/rejects per invocation based on a queued outcome list, in call order. */
class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{ executable: string; args: ReadonlyArray<string> }> = []
  constructor(private readonly outcomes: ReadonlyArray<{ ok: boolean; stdout?: string; stderr?: string }>) {}

  async run(executable: string, args: ReadonlyArray<string>, _options?: CommandRunOptions): Promise<CommandRunResult> {
    const index = this.calls.length
    this.calls.push({ executable, args })
    const outcome = this.outcomes[index]
    if (outcome === undefined) throw new Error(`no scripted outcome for call ${index}`)
    if (outcome.ok) return { stdout: outcome.stdout ?? "", stderr: "", exitCode: 0 }
    throw new CommandRunnerError({
      kind: "exited",
      executable,
      args,
      exitCode: 1,
      message: outcome.stderr ?? "failed",
      stderr: outcome.stderr ?? "",
    })
  }
}

describe("repairThenRecheckDoctor", () => {
  it("runs repair then rechecks doctor, recording both under distinct refs, and reports success/success", async () => {
    const runner = new ScriptedRunner([{ ok: true, stdout: "repaired" }, { ok: true, stdout: "healthy" }])
    const manager = new AdminRunManager({ runner })
    const outcome = await repairThenRecheckDoctor(nativeEntry, manager)
    expect(outcome).toEqual({ repairState: "success", doctorState: "success" })
    expect(runner.calls).toEqual([
      { executable: "/usr/local/bin/cpx", args: ["repair", "default"] },
      { executable: "/usr/local/bin/cpx", args: ["doctor", "default"] },
    ])
    expect(manager.status(repairRefFor(nativeEntry)).state).toBe("success")
    expect(manager.status(nativeEntry.ref).state).toBe("success")
  })

  it("still rechecks doctor and reports a failure state when the repair command itself fails", async () => {
    const runner = new ScriptedRunner([{ ok: false, stderr: "repair failed" }, { ok: true, stdout: "still broken but doctor ran" }])
    const manager = new AdminRunManager({ runner })
    const outcome = await repairThenRecheckDoctor(nativeEntry, manager)
    expect(outcome).toEqual({ repairState: "failure", doctorState: "success" })
    expect(runner.calls).toHaveLength(2)
  })

  it("never overwrites the profile's own doctor history with the repair run", async () => {
    const runner = new ScriptedRunner([{ ok: true }, { ok: true }])
    const manager = new AdminRunManager({ runner })
    await repairThenRecheckDoctor(nativeEntry, manager)
    expect(manager.status(nativeEntry.ref).history).toHaveLength(1)
    expect(manager.status(repairRefFor(nativeEntry)).history).toHaveLength(1)
  })

  it("escalates to setup and rechecks doctor again when repair alone does not resolve the failure", async () => {
    const runner = new ScriptedRunner([
      { ok: true, stdout: "repaired" },
      { ok: false, stderr: "OMP installed version receipt is missing; run omp setup default" },
      { ok: true, stdout: "omp setup default: ready" },
      { ok: true, stdout: "healthy" },
    ])
    const manager = new AdminRunManager({ runner })
    const outcome = await repairThenRecheckDoctor(nativeEntry, manager)
    expect(outcome).toEqual({ repairState: "success", setupState: "success", doctorState: "success" })
    expect(runner.calls).toEqual([
      { executable: "/usr/local/bin/cpx", args: ["repair", "default"] },
      { executable: "/usr/local/bin/cpx", args: ["doctor", "default"] },
      { executable: "/usr/local/bin/cpx", args: ["setup", "default"] },
      { executable: "/usr/local/bin/cpx", args: ["doctor", "default"] },
    ])
    expect(manager.status(setupRefFor(nativeEntry)).state).toBe("success")
    expect(manager.status(nativeEntry.ref).state).toBe("success")
  })

  it("reports the final failure state when neither repair nor setup resolve the failure", async () => {
    const runner = new ScriptedRunner([
      { ok: true, stdout: "repaired" },
      { ok: false, stderr: "still broken" },
      { ok: false, stderr: "setup also failed" },
      { ok: false, stderr: "still broken" },
    ])
    const manager = new AdminRunManager({ runner })
    const outcome = await repairThenRecheckDoctor(nativeEntry, manager)
    expect(outcome).toEqual({ repairState: "success", setupState: "failure", doctorState: "failure" })
    expect(runner.calls).toHaveLength(4)
  })

  it("does not overwrite repair or doctor history with the setup escalation run", async () => {
    const runner = new ScriptedRunner([{ ok: true }, { ok: false, stderr: "still broken" }, { ok: true }, { ok: true }])
    const manager = new AdminRunManager({ runner })
    await repairThenRecheckDoctor(nativeEntry, manager)
    expect(manager.status(repairRefFor(nativeEntry)).history).toHaveLength(1)
    expect(manager.status(setupRefFor(nativeEntry)).history).toHaveLength(1)
    expect(manager.status(nativeEntry.ref).history).toHaveLength(2)
  })
})
