import { describe, expect, it } from "vitest"
import { harnessUpgradeVersionPreview } from "../src/admin-harness-update-preview.ts"
import type { AdminHarnessVersionResult } from "../src/admin-harness-version.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"

const entry = (overrides: Partial<AdminProfileEntry> = {}): AdminProfileEntry => ({
  ref: "sandbox:claude",
  surface: "sandbox",
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
  it("shows the current version and the latest known floating target", () => {
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "latest" }), known("2.1.252", "2.1.260"))).toEqual({
      isCurrent: false,
      text: "2.1.252 -> 2.1.260",
    })
    expect(
      harnessUpgradeVersionPreview(
        entry({ surface: "native", launcher: "cldx", version: "unrelated profile version" }),
        known("2.1.259", "2.1.260"),
      ),
    ).toEqual({ isCurrent: false, text: "2.1.259 -> 2.1.260" })
  })

  it.each([
    { installed: "2.1.252", isCurrent: false, text: "2.1.252 -> 2.1.260 (pinned)" },
    { installed: "2.1.260", isCurrent: true, text: "2.1.260 (pinned)" },
    { installed: "2.1.270", isCurrent: false, text: "2.1.270 -> 2.1.260 (pinned)" },
  ])("compares $installed against the configured pin, not upstream latest", ({ installed, isCurrent, text }) => {
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "2.1.260" }), known(installed, "2.1.280"))).toEqual({
      isCurrent,
      text,
    })
  })

  it("shows a Container source pin without substituting upstream HEAD", () => {
    const pin = "b".repeat(40)
    expect(
      harnessUpgradeVersionPreview(entry({ harness: "headlong", harnessVersionSelector: pin }), known("a".repeat(40), "c".repeat(40))),
    ).toEqual({ isCurrent: false, text: `${"a".repeat(40)} -> ${pin} (pinned)` })
  })

  it("labels Firstmate's profile-specific catalog target as a pin", () => {
    expect(
      harnessUpgradeVersionPreview(
        entry({ surface: "native", launcher: "fmx", harness: "firstmate" }),
        known("a".repeat(40), "b".repeat(40)),
      ),
    ).toEqual({ isCurrent: false, text: `${"a".repeat(40)} -> ${"b".repeat(40)} (catalog pin)` })
  })

  it("shows a matching Firstmate catalog pin once", () => {
    const pin = "a".repeat(40)
    expect(harnessUpgradeVersionPreview(entry({ surface: "native", launcher: "fmx", harness: "firstmate" }), known(pin, pin))).toEqual({
      isCurrent: true,
      text: `${pin} (catalog pin)`,
    })
  })

  it("shows an already-current floating version without inventing an upgrade", () => {
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "latest" }), known("2.1.260", "2.1.260"))).toEqual({
      isCurrent: true,
      text: "2.1.260",
    })
  })

  it("keeps unknown installed and target observations explicit", () => {
    const profile = entry({ surface: "native", launcher: "cldx", version: "not a harness observation" })
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

  it("reports a latest lookup failure but still shows a configured Container pin", () => {
    const failed: AdminHarnessVersionResult = {
      installed: { kind: "known", version: "2.1.252" },
      latest: { kind: "failed", diagnostic: "release source unavailable" },
    }
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "latest" }), failed)).toEqual({
      isCurrent: false,
      text: "2.1.252 -> unknown (lookup failed)",
    })
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "2.1.260" }), failed)).toEqual({
      isCurrent: false,
      text: "2.1.252 -> 2.1.260 (pinned)",
    })
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "2.1.252" }), failed)).toEqual({
      isCurrent: true,
      text: "2.1.252 (pinned)",
    })
  })

  it("does not treat an absent selector or a version range as a resolved target", () => {
    expect(harnessUpgradeVersionPreview(entry(), known("2.1.252", "2.1.260"))).toEqual({
      isCurrent: false,
      text: "2.1.252 -> unknown (target selector unavailable)",
    })
    expect(harnessUpgradeVersionPreview(entry({ harnessVersionSelector: "^2.1.0" }), known("2.1.252", "2.1.260"))).toEqual({
      isCurrent: false,
      text: "2.1.252 -> unknown (selector: ^2.1.0)",
    })
  })
})
