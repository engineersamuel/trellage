import { expect, it } from "vitest"
import { parseProfileGuideIdentity, profileGuideIdentityKey } from "@trellage/guide-core"
import { buildGuideLaunchCommand, parseSelectedProfile } from "../src/guide-launch.ts"
import { initialRunSelectorState, runSelectorReducer, runSelectorChoice } from "../src/run-select-state.ts"

it("preserves canonical native identities", () => {
  expect(profileGuideIdentityKey(parseProfileGuideIdentity("native/agency/azure.md"))).toBe("native:agency/azure")
  expect(profileGuideIdentityKey(parseProfileGuideIdentity("native/omp/default.md"))).toBe("native:omp/default")
  expect(profileGuideIdentityKey(parseProfileGuideIdentity("native/omp/local.md"))).toBe("native:omp/local")
  const selected = parseSelectedProfile({ surface: "native", launcher: "codex", profile: "pstack", commandPath: "/bin/codex", headlessPrompt: true })
  expect(selected).toMatchObject({ launcher: "codex", commandPath: "/bin/trx" })
  expect(buildGuideLaunchCommand(selected).command).toEqual({ executable: "/bin/trx", args: ["run", "codex", "pstack"] })
})

it("drops incompatible restored and selected profiles when changing harness", () => {
  const catalog = { harnesses: [{ harness: "pi", label: "Pi", efforts: [], defaultModel: undefined, planModel: "none" }, { harness: "claude", label: "Claude", efforts: [], defaultModel: undefined, planModel: "none" }], profiles: ["office", "shared"], profileHarnesses: { office: ["claude"] }, models: [] }
  const restored = initialRunSelectorState(catalog, { harness: "pi", profiles: ["office", "shared"] })
  expect(restored.profiles).toEqual(["shared"])
  const selected = initialRunSelectorState(catalog, { harness: "claude", profiles: ["office", "shared"] })
  const next = runSelectorReducer(selected, { kind: "change", delta: 1 }, catalog)
  expect(runSelectorChoice(next, catalog).profiles).toEqual(["shared"])
})
