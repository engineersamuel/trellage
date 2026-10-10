import { describe, expect, test } from "bun:test"
import { nativeHarnessPresets, nativePresetProfile, nativePresetProfiles } from "../../src/native-run/presets.ts"
import { adapters } from "../../src/native-run/adapters.ts"
import { canonicalRunArguments } from "../../src/native-run/cli.ts"

describe("native harness presets", () => {
  test("every public preset has a canonical built-in profile", () => {
    expect(Object.keys(nativeHarnessPresets).sort()).toEqual([
      "agency", "claude", "codex", "copilot", "firstmate", "fx", "jcode", "omp", "pi", "prime",
    ])
    expect(nativePresetProfile("agency", "azure")).toBe("preset-agency-azure")
    expect(nativePresetProfile("omp", "default")).toBe("preset-omp-default")
    expect(nativePresetProfile("fx", "default")).toBe("preset-fx-default")
  })
  test("unknown presets never acquire an alias translation", () => {
    expect(nativePresetProfile("fx", "ask")).toBeUndefined()
    expect(nativePresetProfile("unknown", "default")).toBeUndefined()
    expect(nativePresetProfiles("fx")).toEqual(["default"])
  })
  test("every canonical harness launches through an adapter", () => {
    expect(Object.keys(adapters).sort()).toEqual([
      "agency", "claude", "codex", "copilot", "firstmate", "fx", "grok", "jcode", "omp", "pi", "prime",
    ])
  })
  test("Fx keeps its zero-profile shorthand without inventing a launcher alias", () => {
    expect(canonicalRunArguments(["fx"])).toEqual(["fx", "default"])
    expect(canonicalRunArguments(["fx", "ask", "hello"])).toEqual(["fx", "default", "--", "ask", "hello"])
    expect(canonicalRunArguments(["fx", "--plan", "ask", "hello"])).toEqual(["fx", "default", "--plan", "--", "ask", "hello"])
    expect(canonicalRunArguments(["fx", "default", "--", "ask", "hello"])).toEqual(["fx", "default", "--", "ask", "hello"])
  })
})
