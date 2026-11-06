import { expect, test } from "bun:test"
import { SELECTABLE_STEPS, stepById, stepSetup } from "../src/steps.ts"
import { FANOUT_CATALOG, MAX_FANOUT, OPTIMIZE_SKILLS, optimizeTask, researchTask, selectWorkflows } from "../src/workflows.ts"

test("independent probabilities allow multiple workflows or no match", () => {
  expect(selectWorkflows({ council: 0.9, "six-hats": 0.65, hyperresearch: 0.95 }).selected).toEqual([
    "council",
    "six-hats",
    "hyperresearch",
  ])
  expect(selectWorkflows({ council: 0.2, "six-hats": 0.1, hyperresearch: 0.3 }).selected).toEqual([])
  for (const invalid of [NaN, Infinity, -0.1, 1.1])
    expect(() => selectWorkflows({ council: invalid, "six-hats": 0.5, hyperresearch: 0.9 })).toThrow("Invalid Jev")
  expect(() => selectWorkflows({ council: 0.9 })).toThrow("six-hats")
})

test("Claude-built workflows run in the Claude harness with their trx profile and entry command", () => {
  expect(stepById("council").harness).toEqual({ kind: "claude", profiles: ["council"], entry: "/council" })
  expect(stepById("six-hats").harness?.entry).toBe("/six-hats:decide")
  expect(stepById("hyperresearch").harness).toEqual({ kind: "claude", profiles: ["research"], entry: "/hyperresearch:deep-research" })
  expect(stepById("implement").harness).toBeUndefined()
})

test("one fan-out catalog holds research workflows and optimize lenses, each bound to a step", () => {
  expect(FANOUT_CATALOG.map((e) => [e.id, e.kind, e.step])).toEqual([
    ["council", "research", "council"],
    ["six-hats", "research", "six-hats"],
    ["hyperresearch", "research", "hyperresearch"],
    ...OPTIMIZE_SKILLS.map((s) => [s.id, "optimize", `optimize-${s.id}`]),
  ])
  for (const e of FANOUT_CATALOG) expect(() => stepById(e.step)).not.toThrow()
  expect(FANOUT_CATALOG[0]!.task("q")).toContain("reports/council.md")
})

test("researchTask names its report file", () => {
  expect(researchTask("council", "x", "draft-council")).toContain("reports/draft-council.md")
  expect(researchTask("council", "x")).toContain("reports/council.md")
})

test(`selection keeps at most ${MAX_FANOUT} workers, the most probable first`, () => {
  const p = Object.fromEntries(FANOUT_CATALOG.map((e, i) => [e.id, 0.66 + i * 0.01]))
  const { selected } = selectWorkflows(p, FANOUT_CATALOG)
  expect(selected).toEqual(FANOUT_CATALOG.slice(-MAX_FANOUT).map((e) => e.id))
})

test("Optimize selection uses the trx guide --optimize catalog", () => {
  const all = { "first-principles": 0.9, "behavior-preservation": 0.7, "improve-codebase-architecture": 0.8, "ui-css": 0.1 }
  expect(selectWorkflows(all, OPTIMIZE_SKILLS).selected).toEqual([
    "first-principles",
    "behavior-preservation",
    "improve-codebase-architecture",
  ])
  expect(() => selectWorkflows({ "first-principles": 0.9 }, OPTIMIZE_SKILLS)).toThrow("behavior-preservation")
})

test("Optimize tasks are read-only, lens-specific and name their report", () => {
  const task = optimizeTask("first-principles", "top 3 optimizations")
  expect(task).toStartWith("top 3 optimizations")
  expect(task).toContain("Prefer deleting over simplifying")
  expect(task).toContain("Do not edit, stage, commit, or push")
  expect(task).toContain("reports/optimize-first-principles.md")
  expect(() => optimizeTask("nope", "x")).toThrow("Unknown Optimize skill")
})

test("each Optimize skill is a factory-only step that loads its managed skills", () => {
  const arch = stepById("optimize-improve-codebase-architecture")
  expect(arch.factoryOnly).toBe(true)
  expect(arch.skills).toEqual(["improve-codebase-architecture", "codebase-design"])
  expect(stepSetup(arch, "/s", "/t")).toMatchObject({
    skillDirectories: ["/s/mattpocock-skills/skills/engineering"],
    extraPath: [],
  })
  expect(stepById("optimize-first-principles").skills).toEqual([])
  expect(SELECTABLE_STEPS.some((s) => s.id.startsWith("optimize-"))).toBe(false)
})
