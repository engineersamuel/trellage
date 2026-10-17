import { describe, expect, it } from "vitest"

import {
  buildHarnessVersionCommand,
  harnessVersionColumnsFor,
  harnessVersionEntriesForForceResync,
  harnessVersionLatestLookupSupported,
  harnessVersionOperationKeyFor,
  harnessVersionReleaseKeyFor,
  parseHarnessVersionOutput,
  reconcileHarnessVersionResults,
  type AdminHarnessVersionResult,
} from "../src/admin-harness-version.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"

const nativeEntry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "native:omp/local",
  surface: "native",
  launcher: "omp",
  harness: "oh-my-pi",
  name: "local",
  description: "Oh My Pi native profile.",
  commandPath: "/usr/local/bin/trx",
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


const known = (installed: string, latest: string): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "known", version: latest },
})

const unsupported = (installed: string): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "unsupported" },
})

describe("buildHarnessVersionCommand", () => {
  it("builds a launcher-scoped native command", () => {
    expect(buildHarnessVersionCommand(nativeEntry())).toEqual({
      executable: "/usr/local/bin/trx",
      args: ["harness-version", "omp", "local"],
    })
  })

})

describe("parseHarnessVersionOutput", () => {
  it("preserves installed while representing an intentionally unsupported latest", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: "1.0.82",
          latest: null,
          latestKnown: false,
        }),
      ),
    ).toEqual(unsupported("1.0.82"))
  })

  it("preserves installed and a retryable latest diagnostic", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: "1.0.3",
          latest: null,
          latestKnown: false,
          latestDiagnostic: "grok latest-version check failed",
        }),
      ),
    ).toEqual({
      installed: { kind: "known", version: "1.0.3" },
      latest: { kind: "failed", diagnostic: "grok latest-version check failed" },
    })
  })

  it("retains a known latest when installed is unavailable", () => {
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({
          schemaVersion: 1,
          installed: null,
          latest: "2.1.259",
          latestKnown: true,
        }),
      ),
    ).toEqual({
      installed: {
        kind: "unavailable",
        diagnostic: "harness-version could not determine the installed harness version",
      },
      latest: { kind: "known", version: "2.1.259" },
    })
  })

  it("fails malformed top-level and contradictory latest fields closed", () => {
    expect(parseHarnessVersionOutput("not json").latest.kind).toBe("failed")
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({ schemaVersion: 1, installed: "1.0.0", latest: null, latestKnown: true }),
      ).latest.kind,
    ).toBe("failed")
    expect(
      parseHarnessVersionOutput(
        JSON.stringify({ schemaVersion: 1, installed: "1.0.0", latest: "2.0.0", latestKnown: false }),
      ).latest.kind,
    ).toBe("failed")
  })
})

describe("harnessVersionColumnsFor", () => {
  it("renders unsupported or unsettled checks as unknown dashes", () => {
    expect(harnessVersionColumnsFor(false, known("1.0.0", "1.0.0"))).toEqual({
      installed: "—",
      latest: "—",
      status: "unknown",
    })
    expect(harnessVersionColumnsFor(true, undefined)).toEqual({
      installed: "—",
      latest: "—",
      status: "unknown",
    })
  })

  it("renders each independently known value without fabricating its peer", () => {
    expect(harnessVersionColumnsFor(true, unsupported("1.0.82"))).toEqual({
      installed: "1.0.82",
      latest: "N/A",
      status: "unknown",
    })
    expect(
      harnessVersionColumnsFor(true, {
        installed: { kind: "unavailable", diagnostic: "not installed" },
        latest: { kind: "known", version: "2.1.259" },
      }),
    ).toEqual({ installed: "—", latest: "2.1.259", status: "unknown" })
  })

  it("reports match and mismatch only when both values are known", () => {
    expect(harnessVersionColumnsFor(true, known("18.1.1", "18.1.1")).status).toBe("match")
    expect(harnessVersionColumnsFor(true, known("18.1.1", "18.1.2")).status).toBe("mismatch")
  })
})

describe("operation and release identities", () => {
  it("distinguishes latest-capable native producers and fails unsupported aliases closed", () => {
    expect(harnessVersionLatestLookupSupported(nativeEntry())).toBe(true)
    expect(
      harnessVersionLatestLookupSupported(
        nativeEntry({ launcher: "copilot", harness: "copilot", ref: "native:copilot/default" }),
      ),
    ).toBe(false)
    expect(
      harnessVersionOperationKeyFor(
        nativeEntry({
          launcher: "agency",
          harness: "agency",
          ref: "native:agency/default",
          harnessVersionSupported: false,
        }),
      ),
    ).toBeUndefined()
  })
})

describe("reconcileHarnessVersionResults", () => {
  it("shares a known latest across rows of one Native release without copying installed", () => {
    const first = nativeEntry({ ref: "native:copilot/default", launcher: "copilot", harness: "copilot", name: "default" })
    const second = nativeEntry({ ref: "native:copilot/hve", launcher: "copilot", harness: "copilot", name: "hve" })
    expect(harnessVersionReleaseKeyFor(first)).toBe("copilot-cli")
    const raw = new Map<string, AdminHarnessVersionResult>([["native:copilot", known("1.0.82", "1.0.90")]])
    const results = reconcileHarnessVersionResults([first, second], (key) => raw.get(key))
    expect(results.get(first.ref)).toEqual(known("1.0.82", "1.0.90"))
    expect(results.get(second.ref)).toEqual(known("1.0.82", "1.0.90"))
  })
})

describe("harnessVersionEntriesForForceResync", () => {
  it("refreshes every row that shares a Native release", () => {
    const first = nativeEntry({ ref: "native:copilot/default", launcher: "copilot", harness: "copilot", name: "default" })
    const second = nativeEntry({ ref: "native:copilot/hve", launcher: "copilot", harness: "copilot", name: "hve" })
    expect(harnessVersionEntriesForForceResync(first, [first, second, nativeEntry()])).toEqual([first, second])
  })
})
