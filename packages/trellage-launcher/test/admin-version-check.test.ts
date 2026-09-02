import { describe, expect, it } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.js"
import { buildUpdateCheckCommand, formatVersionCell, parseUpdateCheckOutput } from "../src/admin-version-check.js"

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
})

describe("formatVersionCell", () => {
  it("shows the installed version for an unsupported launcher, ignoring any stray result", () => {
    expect(formatVersionCell("1.0.0", false, { current: false, latest: "2.0.0" })).toBe("1.0.0")
  })

  it("shows only the installed version once a check confirms it is current", () => {
    expect(formatVersionCell("0.8.1", true, { current: true })).toBe("0.8.1")
  })

  it("shows installed and latest once a check finds an update", () => {
    expect(formatVersionCell("0.8.1", true, { current: false, latest: "0.9.0" })).toBe("0.8.1 → 0.9.0")
  })

  it("shows only the installed version when no check result is available yet", () => {
    expect(formatVersionCell("0.8.1", true, undefined)).toBe("0.8.1")
  })

  it("shows only the installed version when the check result is malformed", () => {
    expect(formatVersionCell("0.8.1", true, { malformed: true, diagnostic: "boom" })).toBe("0.8.1")
  })

  it("shows an em dash when neither the installed version nor a result is known", () => {
    expect(formatVersionCell(undefined, true, undefined)).toBe("—")
  })
})
