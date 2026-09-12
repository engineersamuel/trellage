import { describe, expect, it } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.ts"
import { buildUpdateCheckCommand, parseUpdateCheckOutput, versionColumnsFor } from "../src/admin-version-check.ts"

const entry: AdminProfileEntry = {
  ref: "native:prx:default",
  surface: "native",
  launcher: "prx",
  harness: "prime",
  name: "default",
  description: "Prime native profile.",
  commandPath: "/usr/local/bin/prx",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
  version: "0.8.1",
}

describe("buildUpdateCheckCommand", () => {
  it("builds `update --check PROFILE` against the entry's own command path", () => {
    expect(buildUpdateCheckCommand(entry)).toEqual({
      executable: "/usr/local/bin/prx",
      args: ["update", "--check", "default"],
    })
  })
})

describe("parseUpdateCheckOutput", () => {
  it("parses the prx/jcx/omp/picx 'is current' message family", () => {
    expect(parseUpdateCheckOutput("prx update: 0.8.1 is current", "0.8.1")).toEqual({ current: true, installed: "0.8.1" })
  })

  it("parses the prx/jcx/omp/picx '-> available' message family", () => {
    expect(parseUpdateCheckOutput("prx update: 0.8.1 -> 0.9.0 available", "0.8.1")).toEqual({
      current: false,
      installed: "0.8.1",
      latest: "0.9.0",
    })
  })

  it("parses the cpx/grx 'current (X)' message family", () => {
    expect(parseUpdateCheckOutput("default: current (1.2.3)", "1.2.3")).toEqual({ current: true, installed: "1.2.3" })
  })

  it("parses the cpx/grx 'update available (X -> Y)' message family", () => {
    expect(parseUpdateCheckOutput("default: update available (1.2.3 -> 1.3.0)", "1.2.3")).toEqual({
      current: false,
      installed: "1.2.3",
      latest: "1.3.0",
    })
  })

  it("parses the cpx/grx 'not installed' message as malformed rather than a version result", () => {
    const result = parseUpdateCheckOutput("default: not installed", undefined)
    expect(result).toMatchObject({ malformed: true })
  })

  it("parses the fmx 'is current (COMMIT)' message family", () => {
    expect(parseUpdateCheckOutput("fmx update: default is current (abc123def456)", "abc123def456")).toEqual({
      current: true,
      installed: "abc123def456",
    })
  })

  it("parses the fmx 'is stale (installed X, catalog pin Y)' message family", () => {
    expect(
      parseUpdateCheckOutput(
        "fmx update: default is stale (installed abc123def456, catalog pin 789abc012def)",
        "abc123def456",
      ),
    ).toEqual({ current: false, installed: "abc123def456", latest: "789abc012def" })
  })

  it("parses the fmx 'is not set up' message as malformed rather than a version result", () => {
    const result = parseUpdateCheckOutput("fmx update: default is not set up (catalog pin 789abc012def)", undefined)
    expect(result).toMatchObject({ malformed: true })
  })

  it("reports empty output as malformed", () => {
    expect(parseUpdateCheckOutput("", "0.8.1")).toMatchObject({ malformed: true, diagnostic: expect.stringContaining("no output") })
  })

  it("reports unrecognized output as malformed rather than guessing a version", () => {
    const result = parseUpdateCheckOutput("some completely unrelated banner text", "0.8.1")
    expect(result).toMatchObject({ malformed: true })
    if ("malformed" in result) expect(result.diagnostic).toContain("unrecognized")
  })

  it("parses cdx's skill-only 'PROFILE: current' message with no version to name (e.g. youtube)", () => {
    expect(parseUpdateCheckOutput("youtube: current", undefined)).toEqual({ current: true })
  })

  it("parses cdx's skill-only 'PROFILE: update available' message with no version to name", () => {
    expect(parseUpdateCheckOutput("youtube: update available", undefined)).toEqual({ current: false, latest: "—" })
  })
})

describe("versionColumnsFor", () => {
  it("shows the installed version for an unsupported launcher with an unknown latest, ignoring any stray result", () => {
    expect(versionColumnsFor("1.0.0", false, { current: false, latest: "2.0.0" })).toEqual({
      installed: "1.0.0",
      latest: "—",
      status: "unknown",
    })
  })

  it("marks both columns as matching once a check confirms the installed version is current", () => {
    expect(versionColumnsFor("0.8.1", true, { current: true })).toEqual({
      installed: "0.8.1",
      latest: "0.8.1",
      status: "match",
    })
  })

  it("marks both columns as mismatched once a check finds a newer release", () => {
    expect(versionColumnsFor("0.8.1", true, { current: false, latest: "0.9.0" })).toEqual({
      installed: "0.8.1",
      latest: "0.9.0",
      status: "mismatch",
    })
  })

  it("shows an unknown latest when no check result is available yet", () => {
    expect(versionColumnsFor("0.8.1", true, undefined)).toEqual({ installed: "0.8.1", latest: "—", status: "unknown" })
  })

  it("shows an unknown latest when the check result is malformed", () => {
    expect(versionColumnsFor("0.8.1", true, { malformed: true, diagnostic: "boom" })).toEqual({
      installed: "0.8.1",
      latest: "—",
      status: "unknown",
    })
  })

  it("shows an em dash for both columns when neither the installed version nor a result is known", () => {
    expect(versionColumnsFor(undefined, true, undefined)).toEqual({ installed: "—", latest: "—", status: "unknown" })
  })
})
