import { describe, expect, it } from "vitest"

import type { AdminProfileEntry } from "../src/admin-model.js"
import type { AdminStatus } from "../src/admin-status.js"
import { adminProfileType, adminTableColumnWidths, filterAdminProfiles, resolveAdminViewState, sortAdminProfiles } from "../src/admin-table.js"

const entry = (overrides: Partial<AdminProfileEntry>): AdminProfileEntry => ({
  ref: overrides.ref ?? "native:cpx/hve",
  surface: "native",
  launcher: "cpx",
  harness: "copilot",
  name: "hve",
  description: "Copilot native launcher.",
  commandPath: "/opt/trellage/cpx/bin/cpx",
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

const fixture: ReadonlyArray<AdminProfileEntry> = [
  entry({ ref: "native:cpx/hve", name: "hve", launcher: "cpx", health: "healthy" }),
  entry({
    ref: "native:example-unsupported/pstack",
    name: "pstack",
    launcher: "example-unsupported",
    harness: "example",
    doctorSupported: false,
    health: "unsupported",
  }),
  entry({
    ref: "sandbox:prime-agent",
    surface: "sandbox",
    harness: "copilot",
    name: "prime-agent",
    description: "Sandboxed prime agent.",
    health: "unhealthy",
  }),
]

describe("filterAdminProfiles", () => {
  it("is a pure, case-insensitive substring match with no false positives or negatives", () => {
    expect(filterAdminProfiles(fixture, "hve").map((e) => e.ref)).toEqual(["native:cpx/hve"])
    expect(filterAdminProfiles(fixture, "PSTACK").map((e) => e.ref)).toEqual(["native:example-unsupported/pstack"])
    expect(filterAdminProfiles(fixture, "sandbox").map((e) => e.ref)).toEqual(["sandbox:prime-agent"])
    expect(filterAdminProfiles(fixture, "nonexistent")).toEqual([])
  })

  it("returns all entries unchanged for an empty query", () => {
    expect(filterAdminProfiles(fixture, "  ")).toEqual(fixture)
  })

  it("matches on description as well as name", () => {
    expect(filterAdminProfiles(fixture, "sandboxed prime").map((e) => e.ref)).toEqual(["sandbox:prime-agent"])
  })
})

describe("sortAdminProfiles", () => {
  it("sorts stably by name, ascending and descending, without mutating the input", () => {
    const copy = [...fixture]
    const ascending = sortAdminProfiles(fixture, "name", "asc")
    expect(ascending.map((e) => e.name)).toEqual(["hve", "prime-agent", "pstack"])
    const descending = sortAdminProfiles(fixture, "name", "desc")
    expect(descending.map((e) => e.name)).toEqual(["pstack", "prime-agent", "hve"])
    expect(fixture).toEqual(copy)
  })

  it("preserves relative order for equal sort keys (stability)", () => {
    const tied: ReadonlyArray<AdminProfileEntry> = [
      entry({ ref: "a", health: "healthy" }),
      entry({ ref: "b", health: "healthy" }),
    ]
    expect(sortAdminProfiles(tied, "health", "asc").map((e) => e.ref)).toEqual(["a", "b"])
  })
})

describe("resolveAdminViewState", () => {
  it("returns discovering while loading regardless of entry counts", () => {
    expect(resolveAdminViewState([], [], true)).toBe("discovering")
    expect(resolveAdminViewState(fixture, fixture, true)).toBe("discovering")
  })

  it("returns empty-no-profiles when discovery found nothing", () => {
    expect(resolveAdminViewState([], [], false)).toBe("empty-no-profiles")
  })

  it("returns empty-no-match when profiles exist but the filter matched none", () => {
    expect(resolveAdminViewState(fixture, [], false)).toBe("empty-no-match")
  })

  it("returns ready when profiles exist and at least one matches", () => {
    expect(resolveAdminViewState(fixture, fixture, false)).toBe("ready")
  })
})

describe("adminProfileType", () => {
  it("maps native surfaces to Native and sandbox surfaces to Container", () => {
    expect(adminProfileType(entry({ surface: "native" }))).toBe("Native")
    expect(adminProfileType(entry({ surface: "sandbox" }))).toBe("Container")
  })
})

describe("adminTableColumnWidths", () => {
  const statuses = (pairs: ReadonlyArray<readonly [string, AdminStatus]>): ReadonlyMap<string, AdminStatus> => new Map(pairs)

  it("reserves at least enough width for each column header", () => {
    const widths = adminTableColumnWidths([], new Map(), 120)
    expect(widths.harness).toBeGreaterThanOrEqual("HARNESS".length)
    expect(widths.name).toBeGreaterThanOrEqual("PROFILE NAME".length)
    expect(widths.type).toBeGreaterThanOrEqual("TYPE".length)
    expect(widths.status).toBeGreaterThanOrEqual("STATUS".length)
    expect(widths.version).toBeGreaterThanOrEqual("VERSION".length)
    expect(widths.latestVersion).toBeGreaterThanOrEqual("LATEST VERSION".length)
  })

  it("widens a column to fit its longest value plus the header", () => {
    const wide = entry({ ref: "native:cpx/very-long-harness-name", harness: "an-unusually-long-harness-name" })
    const widths = adminTableColumnWidths([wide], statuses([[wide.ref, "idle"]]), 200)
    expect(widths.harness).toBeGreaterThan("an-unusually-long-harness-name".length)
  })

  it("sums to at most the available width bounded by the terminal width", () => {
    const widths = adminTableColumnWidths(fixture, statuses(fixture.map((e) => [e.ref, "idle"] as const)), 100)
    expect(widths.harness + widths.name + widths.type + widths.status + widths.version + widths.latestVersion).toBeLessThanOrEqual(
      100,
    )
  })

  it("widens the version and latest-version columns to fit a longer checked value", () => {
    const checked = entry({ ref: "native:cpx/hve" })
    const widths = adminTableColumnWidths(
      [checked],
      statuses([[checked.ref, "idle"]]),
      200,
      new Map([[checked.ref, { installed: "1.2.3-longer", latest: "1.3.0-longer", status: "mismatch" as const }]]),
    )
    expect(widths.version).toBeGreaterThan("1.2.3-longer".length)
    expect(widths.latestVersion).toBeGreaterThan("1.3.0-longer".length)
  })

  it("never collapses the name column even for a very narrow terminal", () => {
    const widths = adminTableColumnWidths(fixture, statuses(fixture.map((e) => [e.ref, "idle"] as const)), 10)
    expect(widths.name).toBeGreaterThanOrEqual(10)
  })

  it("bounds status column width even for a long malformed-output/unsupported-style label", () => {
    const withUnsupported = entry({ ref: "native:x/y", doctorSupported: false })
    const widths = adminTableColumnWidths([withUnsupported], statuses([[withUnsupported.ref, "unsupported"]]), 60)
    expect(widths.status).toBeGreaterThanOrEqual("STATUS".length)
    expect(widths.status).toBeLessThanOrEqual(60)
  })
})
