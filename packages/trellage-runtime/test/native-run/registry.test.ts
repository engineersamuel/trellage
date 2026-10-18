import { describe, expect, test } from "bun:test"
import { nativeHarnessPresets, nativePresetProfile, nativePresetProfiles } from "../../src/native-run/presets.ts"
import { adapters } from "../../src/native-run/adapters.ts"

describe("native harness presets", () => {
  test("every public preset has a canonical built-in profile", () => {
    expect(Object.keys(nativeHarnessPresets).sort()).toEqual([
      "agency", "claude", "codex", "copilot", "fx", "headlong", "jcode", "omp", "pi", "prime", "uji",
    ])
    expect(nativePresetProfile("agency", "azure")).toBe("preset-agency-azure")
    expect(nativePresetProfile("headlong", "default")).toBe("preset-headlong-default")
    expect(nativePresetProfile("omp", "default")).toBe("preset-omp-default")
    expect(nativePresetProfile("fx", "default")).toBe("preset-fx-default")
  })
  test("unknown presets never acquire an alias translation", () => {
    expect(nativePresetProfile("fx", "ask")).toBeUndefined()
    expect(nativePresetProfile("unknown", "default")).toBeUndefined()
    expect(nativePresetProfiles("fx")).toEqual(["default"])
    expect(nativePresetProfiles("claude")).toContain("research")
  })
  test("every canonical harness launches through an adapter", () => {
    expect(Object.keys(adapters).sort()).toEqual([
      "agency", "claude", "codex", "copilot", "fx", "grok", "headlong", "jcode", "omp", "pi", "prime", "uji",
    ])
  })
})
