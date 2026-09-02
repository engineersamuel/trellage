import { describe, expect, it, vi } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.js"
import {
  buildAdminLaunchCommand,
  buildDiagnosticCommand,
  buildRepairCommand,
  isRepairSupported,
  launchAdminProfile,
  LaunchNotConfirmedError,
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
}

const nativeDoctorUnsupportedEntry: AdminProfileEntry = {
  ...nativeEntry,
  ref: "native:cdx:default",
  launcher: "cdx",
  harness: "codex",
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
