import { describe, expect, it } from "vitest"

import {
  buildHarnessVersionCommand,
  harnessVersionColumnsFor,
  harnessVersionLauncherFor,
  parseHarnessVersionOutput,
  type AdminHarnessVersionResult,
} from "../src/admin-harness-version.js"
import type { AdminProfileEntry } from "../src/admin-model.js"

const nativeEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "native:omp/local",
  surface: "native",
  launcher: "omp",
  harness: "oh-my-pi",
  name: "local",
  description: "Oh My Pi native profile.",
  commandPath: "/usr/local/bin/omp",
  doctorSupported: true,
  inventorySupported: true,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: true,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

describe("buildHarnessVersionCommand", () => {
  it("builds a bare launcher-scoped command, never taking a profile name", () => {
    expect(buildHarnessVersionCommand("/usr/local/bin/omp")).toEqual({
      executable: "/usr/local/bin/omp",
      args: ["harness-version"],
    })
  })
})

describe("parseHarnessVersionOutput", () => {
  it("parses a known-latest (mise-managed) result", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      launcher: "omp",
      harness: "oh-my-pi",
      installed: "18.1.1",
      latest: "18.1.2",
      latestKnown: true,
    })
    expect(parseHarnessVersionOutput(stdout)).toEqual({ kind: "known-latest", installed: "18.1.1", latest: "18.1.2" })
  })

  it("parses an unknown-latest (host-installed CLI) result", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      launcher: "cpx",
      harness: "copilot",
      installed: "1.0.82",
      latest: null,
      latestKnown: false,
    })
    expect(parseHarnessVersionOutput(stdout)).toEqual({ kind: "unknown-latest", installed: "1.0.82" })
  })

  it("treats latestKnown true with a null latest as unknown-latest rather than fabricating a value", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      launcher: "prx",
      harness: "prime",
      installed: "0.8.1",
      latest: null,
      latestKnown: true,
    })
    expect(parseHarnessVersionOutput(stdout)).toEqual({ kind: "unknown-latest", installed: "0.8.1" })
  })

  it("reports unavailable for empty output", () => {
    expect(parseHarnessVersionOutput("")).toMatchObject({ kind: "unavailable" })
    expect(parseHarnessVersionOutput("   \n")).toMatchObject({ kind: "unavailable" })
  })

  it("reports unavailable for non-JSON output", () => {
    expect(parseHarnessVersionOutput("not json at all")).toMatchObject({ kind: "unavailable" })
  })

  it("reports unavailable for an unrecognized schemaVersion", () => {
    expect(parseHarnessVersionOutput(JSON.stringify({ schemaVersion: 2, installed: "1.0.0" }))).toMatchObject({
      kind: "unavailable",
    })
  })

  it("reports unavailable when installed is null (the launcher itself could not determine its own version)", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      launcher: "cldx",
      harness: "claude",
      installed: null,
      latest: null,
      latestKnown: false,
    })
    expect(parseHarnessVersionOutput(stdout)).toMatchObject({ kind: "unavailable" })
  })

  it("reports unavailable for malformed JSON that parses to a non-object", () => {
    expect(parseHarnessVersionOutput("42")).toMatchObject({ kind: "unavailable" })
    expect(parseHarnessVersionOutput("[1,2,3]")).toMatchObject({ kind: "unavailable" })
  })
})

describe("harnessVersionColumnsFor", () => {
  it("renders unknown/dashes when the launcher doesn't support harness-version", () => {
    expect(harnessVersionColumnsFor(false, { kind: "known-latest", installed: "1.0.0", latest: "1.0.0" })).toEqual({
      installed: "—",
      latest: "—",
      status: "unknown",
    })
  })

  it("renders unknown/dashes when no result has settled yet", () => {
    expect(harnessVersionColumnsFor(true, undefined)).toEqual({ installed: "—", latest: "—", status: "unknown" })
  })

  it("renders unknown/dashes for an unavailable result", () => {
    const result: AdminHarnessVersionResult = { kind: "unavailable", diagnostic: "boom" }
    expect(harnessVersionColumnsFor(true, result)).toEqual({ installed: "—", latest: "—", status: "unknown" })
  })

  it("shows the real installed version with latest dashed for an unknown-latest result, never blanking a known value", () => {
    const result: AdminHarnessVersionResult = { kind: "unknown-latest", installed: "1.0.82" }
    expect(harnessVersionColumnsFor(true, result)).toEqual({ installed: "1.0.82", latest: "—", status: "unknown" })
  })

  it("reports a match when installed equals latest", () => {
    const result: AdminHarnessVersionResult = { kind: "known-latest", installed: "18.1.1", latest: "18.1.1" }
    expect(harnessVersionColumnsFor(true, result)).toEqual({ installed: "18.1.1", latest: "18.1.1", status: "match" })
  })

  it("reports a mismatch when installed differs from latest", () => {
    const result: AdminHarnessVersionResult = { kind: "known-latest", installed: "18.1.1", latest: "18.1.2" }
    expect(harnessVersionColumnsFor(true, result)).toEqual({ installed: "18.1.1", latest: "18.1.2", status: "mismatch" })
  })
})

describe("harnessVersionLauncherFor", () => {
  it("returns the launcher for a native entry", () => {
    expect(harnessVersionLauncherFor(nativeEntry())).toBe("omp")
  })

  it("returns undefined for a sandbox entry (harness-version is native-only)", () => {
    expect(
      harnessVersionLauncherFor({
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
        harnessVersionSupported: false,
        updateCheckStale: false,
      }),
    ).toBeUndefined()
  })
})
