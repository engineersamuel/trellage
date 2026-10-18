import { expect, test } from "vitest"
import { toRunListCatalog } from "../src/run-list-catalog.ts"
import type { RunCatalogSnapshot, RunProfileEntry } from "../src/run-catalog.ts"
const selection = {
  description: "Review a patch",
  strengths: null,
  weaknesses: null,
  bestFor: ["Patch review"],
  avoidFor: null,
  capabilities: null,
}
const readiness = { status: "ready" as const, reasons: [], automaticSetup: [], unverified: ["credential-validity"] }
const eligibility = { eligible: true, reasons: [] }
const profile = (harnessId: string): RunProfileEntry => ({
  ref: `native:${harnessId}/review`,
  definitionId: "review",
  harnessId,
  name: "review",
  selection,
  metadataStatus: "complete",
  readiness,
  guideEligibility: eligibility,
  command: ["trx", "run", harnessId, "review"],
  prerequisites: [],
  workflows: [],
  headless: null,
  sandbox: false,
  herdrCompatibility: { status: "untested" },
})
const snapshot = (): RunCatalogSnapshot => ({
  catalog: {
    schemaVersion: 2,
    harnesses: ["pi", "claude"].map((id) => ({
      id,
      selection,
      metadataStatus: "complete",
      readiness,
      guideEligibility: eligibility,
      profiles: [profile(id)],
    })),
    unavailable: { harnesses: [], profiles: [] },
  },
  guides: new Map(),
  revision: "revision",
  source: {
    cwd: "/work",
    shippedRoot: "/work",
    guideRoot: "/work/profile-guides",
    routerCommandPath: "/work/trx",
    home: "/home/test",
    configPath: null,
    configHome: null,
  },
})
test("lists separate harness and profile sets, not their Cartesian product", () => {
  const result = toRunListCatalog(snapshot())
  expect(result.harnesses.map((h) => h.id)).toEqual(["claude", "pi"])
  expect(result.harnesses.every((h) => !("profiles" in h))).toBe(true)
  expect(result.profiles).toHaveLength(1)
  expect(result.profiles[0]?.id).toBe("review")
  expect(result.profiles[0]?.harnesses).toEqual(["claude", "pi"])
  expect(result.profiles[0]?.selection.description).toBe("Review a patch")
  expect("command" in result.profiles[0]!).toBe(false)
})
test("keeps different definitions distinct even if their short names match", () => {
  const input = snapshot()
  const harnesses = input.catalog.harnesses.map((h) => ({
    ...h,
    profiles: h.profiles.map((p) => ({ ...p, name: "default", definitionId: `preset-${h.id}-default` })),
  }))
  expect(toRunListCatalog({ ...input, catalog: { ...input.catalog, harnesses } }).profiles.map((p) => p.id)).toEqual([
    "preset-claude-default",
    "preset-pi-default",
  ])
})
test("a profile appears once even if only some compatible harnesses are available", () => {
  const input = snapshot(),
    failed = {
      ...profile("codex"),
      readiness: {
        ...readiness,
        status: "unavailable" as const,
        reasons: [{ code: "missing-executable", message: "Codex missing", prerequisite: "codex" }],
      },
    }
  const result = toRunListCatalog({
    ...input,
    catalog: { ...input.catalog, unavailable: { harnesses: [], profiles: [failed] } },
  })
  expect(result.profiles).toHaveLength(1)
  expect(result.profiles[0]?.harnesses).toEqual(["claude", "codex", "pi"])
  expect(result.profiles[0]?.readyHarnesses).toEqual(["claude", "pi"])
  expect(result.unavailable.profiles).toEqual([])
})
