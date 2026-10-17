import { describe, expect, it } from "vitest"
import { harnessUpgradeVersionPreview } from "../src/admin-harness-update-preview.ts"
import type { AdminHarnessVersionResult } from "../src/admin-harness-version.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"

const entry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "native:claude/default",
  surface: "native",
  launcher: "claude",
  harness: "claude",
  name: "claude",
  description: "Claude profile",
  commandPath: "/fixture/trellage",
  doctorSupported: true,
  inventorySupported: false,
  health: "healthy",
  install: "installed",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: true,
  updateCheckStale: false,
  ...overrides,
})

const known = (installed: string, latest: string): AdminHarnessVersionResult => ({
  installed: { kind: "known", version: installed },
  latest: { kind: "known", version: latest },
})

describe("harnessUpgradeVersionPreview", () => {
  it("shows the current version and the latest known target", () => {
    expect(
      harnessUpgradeVersionPreview(entry({ version: "unrelated profile version" }), known("2.1.259", "2.1.260")),
    ).toEqual({ isCurrent: false, text: "2.1.259 -> 2.1.260" })
  })

  it("shows an already-current version without inventing an upgrade", () => {
    expect(harnessUpgradeVersionPreview(entry(), known("2.1.260", "2.1.260"))).toEqual({
      isCurrent: true,
      text: "2.1.260",
    })
  })

  it("keeps unknown installed and target observations explicit", () => {
    const profile = entry({ surface: "native", launcher: "claude", version: "not a harness observation" })
    expect(harnessUpgradeVersionPreview(profile, undefined)).toEqual({ isCurrent: false, text: "unknown -> unknown" })
    expect(
      harnessUpgradeVersionPreview(profile, {
        installed: { kind: "unavailable", diagnostic: "not installed" },
        latest: { kind: "known", version: "2.1.260" },
      }),
    ).toEqual({ isCurrent: false, text: "unknown -> 2.1.260" })
    expect(
      harnessUpgradeVersionPreview(profile, {
        installed: { kind: "known", version: "2.1.252" },
        latest: { kind: "unsupported" },
      }),
    ).toEqual({ isCurrent: false, text: "2.1.252 -> unknown" })
  })

  it("reports a latest lookup failure", () => {
    const failed: AdminHarnessVersionResult = {
      installed: { kind: "known", version: "2.1.252" },
      latest: { kind: "failed", diagnostic: "release source unavailable" },
    }
    expect(harnessUpgradeVersionPreview(entry(), failed)).toEqual({
      isCurrent: false,
      text: "2.1.252 -> unknown (lookup failed)",
    })
  })
})
