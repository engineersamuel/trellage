import { describe, expect, test } from "bun:test"
import { nativeHarnessRegistry, backendArguments, nativeHarness } from "../../src/native-run/registry.ts"

describe("native backend registry", () => {
  test("every canonical harness has one backend registration", () => {
    expect(new Set(nativeHarnessRegistry.map((entry) => entry.id)).size).toBe(9)
    expect(nativeHarness("agency")?.presets.azure).toBe("trellage-azure")
    expect(nativeHarness("omp")?.presets.default).toBe("copilot")
    expect(nativeHarness("omp")?.presets.local).toBe("local")
  })
  test("upgrade inspection cannot silently become a mutating update", () => {
    for (const harness of ["codex", "copilot", "claude"]) {
      expect(() => backendArguments("upgrade", harness, ["--harness-only", "--check"])).toThrow("not supported")
      expect(backendArguments("upgrade", harness, ["--harness-only", "--dry-run"])).toEqual(["harness-update", "--dry-run"])
    }
  })
  test("checks preserve presets and launch payloads preserve option-looking text", () => {
    for (const harness of ["prime", "jcode", "pi", "omp", "copilot", "codex"]) {
      const preset = harness === "omp" ? "copilot" : "default"
      expect(backendArguments("upgrade", harness, ["default", "--check"])).toEqual(["update", "--check", preset])
      expect(backendArguments("upgrade", harness, ["--check", "default"])).toEqual(["update", "--check", preset])
    }
    expect(backendArguments("run", "codex", ["superpowers", "--native-auth", "--", "exec", "review"])).toEqual(["--native-auth", "superpowers", "exec", "review"])
    expect(backendArguments("run", "codex", ["superpowers", "--", "-p", "--native-auth"])).toEqual(["superpowers", "-p", "--native-auth"])
    expect(backendArguments("run", "codex", ["pstack", "--", "-p", "--interactive"])).toEqual(["pstack", "-p", "--interactive"])
    expect(backendArguments("run", "copilot", ["hve", "--interactive", "--", "-p", "--interactive"])).toEqual(["interactive", "hve", "-p", "--interactive"])
  })
  test("launch and lifecycle arguments preserve provider identity and passthrough", () => {
    expect(backendArguments("run", "omp", ["default", "--", "--resume", "session"])).toEqual(["copilot", "--resume", "session"])
    expect(backendArguments("inventory", "agency", ["azure", "--json"])).toEqual(["inventory", "trellage-azure", "--json"])
    expect(backendArguments("instances", "firstmate", ["list", "--json"])).toEqual(["instances", "list", "--json"])
    expect(() => backendArguments("run", "omp", ["unknown"])).toThrow("unknown preset")
  })
})
