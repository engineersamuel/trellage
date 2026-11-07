import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { draftToSpec, emptyDraft, goalProblems, goalUnmet, specToDraft, splitPending, stopReason, type GoalSpec, type Run } from "../../shared/goal.ts"
import { checksState, pastWorkers, runWorkers } from "../src/run.ts"
import { decodeGoalOrThrow, loopPrompt, makeGoals } from "../src/goals.ts"
import { parseSteps, scoreCard } from "../goal-cli.ts"

describe("runWorkers", () => {
  const started = [
    { id: "sub-1", name: "sub", owner: "gen-1", step: null },
    { id: "w-a", name: "impl", owner: "sub-1", step: "implement" },
    { id: "w-b", name: "other", owner: "sub-2", step: "verify" },
    { id: "w-c", name: "nested", owner: "w-a", step: "security" },
    { id: "w-a", name: "impl", owner: "sub-1", step: "implement" },
  ]
  test("keeps agents under the root, transitively, once each", () => {
    const ws = runWorkers(started, "sub-1", (id) => (id === "w-a" ? "idle" : undefined))
    expect(ws.map((w) => [w.id, w.step, w.status])).toEqual([
      ["w-a", "implement", "idle"],
      ["w-c", "security", "stopped"],
    ])
  })
})

describe("checksState", () => {
  test("none, success, pending, failure", () => {
    expect(checksState([])).toBe("NONE")
    expect(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("SUCCESS")
    expect(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("PENDING")
    expect(checksState([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("FAILURE")
  })
})

const worker = (step: string, skills: string[] = []) => ({ id: step, name: step, step, skills, harness: "copilot", owner: "sub", status: "idle" })
const run: Run = {
  threadId: "t",
  status: "idle",
  branch: "factory/x",
  base: null,
  workers: [worker("implement", ["ub-mode"]), worker("verify"), worker("verify"), worker("security", ["security-audit"])],
  steps: ["implement", "verify", "security"],
  approvals: [],
  securityReviews: [],
  report: null,
  pr: { number: 7, url: "u", state: "OPEN", head: "h", base: "main", body: "proof 18080", files: ["a.ts", "compose.yaml"], checks: "PENDING" },
}
const spec = decodeGoalOrThrow({ id: "demo", repo: "/r", prompt: "p", expect: { steps: { implement: {}, verify: { max: 1 }, finish: {} }, skills: ["security-audit", "council"], pr: { checks: "SUCCESS", bodyIncludes: ["18080", "OK"], untouched: ["compose.yaml"] } } })

describe("goal spec", () => {
  test("defaults fill approvals, limits, base and PR state", () => {
    expect(spec.base).toBe("main")
    expect(spec.approvals).toEqual({ plan: "auto", findings: "auto", ship: "auto", other: "human" })
    expect(spec.limits).toEqual({ runs: 5, minutesPerRun: 90 })
    expect(spec.expect.steps.implement).toEqual({ min: 1 })
    expect(spec.expect.pr?.state).toBe("OPEN")
  })
  test("problems: id, prompt, repo, unknown step, bad counts", () => {
    const bad = { ...spec, id: "Bad Id", prompt: " ", repo: "rel", expect: { ...spec.expect, steps: { nope: { min: 2, max: 1 } } } } as GoalSpec
    expect(goalProblems(bad, ["implement"])).toEqual([
      "id: lowercase letters, digits and dashes, 2-64 chars",
      "prompt is empty",
      "repo must be an absolute path",
      "unknown step nope",
      "step nope: need 0 <= min <= max",
    ])
    expect(() => decodeGoalOrThrow({ id: "x" })).toThrow("invalid goal")
  })
})

describe("goalUnmet", () => {
  test("step counts, skills, PR checks, base, body and untouched files", () => {
    expect(goalUnmet(run, spec.expect, spec.base)).toEqual([
      "step verify ran 2x, expected at most 1",
      "step finish never ran",
      "skill council never invoked",
      "PR #7 checks PENDING, expected SUCCESS",
      'PR #7 body lacks "OK"',
      "PR #7 changes compose.yaml, expected untouched",
    ])
  })
  test("PR base defaults to the goal base", () => {
    expect(goalUnmet(run, { steps: {}, skills: [], pr: { state: "OPEN", bodyIncludes: [], untouched: [] } }, "dev")).toEqual(["PR #7 targets main, expected dev"])
    expect(goalUnmet({ ...run, pr: null }, { steps: {}, skills: [], pr: { state: "OPEN", bodyIncludes: [], untouched: [] } })).toEqual(["no PR for the branch"])
  })
})

describe("approval policy", () => {
  const a = (id: string, topic: "plan" | "ship" | "other", options = ["Yes", "No"]) => ({ id, title: id, topic, status: "pending", answer: null, options })
  const withPending = { ...run, approvals: [a("p", "plan"), a("s", "ship"), a("o", "other"), a("q", "plan", [])] }
  test("auto topics go to the runner; human topics and free-text questions stop", () => {
    const { auto, human } = splitPending(withPending, spec.approvals)
    expect(auto.map((x) => x.id)).toEqual(["p", "s"])
    expect(human.map((x) => x.id)).toEqual(["o", "q"])
    expect(stopReason(withPending, spec.approvals)?.code).toBe(2)
    expect(stopReason({ ...withPending, approvals: [a("p", "plan")] }, spec.approvals)).toBeNull()
  })
  test("blocked report stops with 3", () => {
    expect(stopReason({ ...run, report: { status: "blocked", summary: "x", gaps: [] } }, spec.approvals)).toEqual({ code: 3, reason: "reported blocked: x" })
  })
})

describe("goal store", () => {
  test("save validates, list and runs round-trip, log appends", () => {
    const g = makeGoals(path.join(mkdtempSync(path.join(tmpdir(), "sf-goals-")), "goals"), ["implement", "verify", "finish"])
    expect(() => g.save({ id: "demo", repo: "/r", prompt: "p", expect: { steps: { bogus: {} } } })).toThrow("unknown step bogus")
    g.save({ id: "demo", repo: "/r", prompt: "p", expect: { steps: { implement: {} } } })
    expect(g.get("demo")?.prompt).toBe("p")
    expect(g.get("none")).toBeNull()
    g.appendRun("demo", { at: 1, factoryCommit: "abc", threadId: "t1", outcome: "fail", unmet: ["x"] })
    g.appendRun("demo", { at: 2, factoryCommit: "def", threadId: "t2", outcome: "pass", prUrl: "u" })
    expect(g.runs("demo").map((r) => [r.factoryCommit, r.outcome])).toEqual([["abc", "fail"], ["def", "pass"]])
    expect(g.list().map((x) => [x.spec.id, x.runs, x.last?.outcome])).toEqual([["demo", 2, "pass"]])
    expect(() => g.appendRun("none", { at: 1, factoryCommit: "a", threadId: "t", outcome: "pass" })).toThrow("no goal none")
    expect(() => g.get("../x")).toThrow("bad goal id")
  })
})

describe("goal cli helpers", () => {
  test("parseSteps", () => {
    expect(parseSteps("implement, finish=1,verify=1..2,review=2..")).toEqual({ implement: { min: 1 }, finish: { min: 1, max: 1 }, verify: { min: 1, max: 2 }, review: { min: 2 } })
  })
  test("scoreCard marks each expectation", () => {
    const card = scoreCard(run, spec, goalUnmet(run, spec.expect, spec.base))
    expect(card).toContain("✓ step implement: 1 (want 1+)")
    expect(card).toContain("✗ step verify: 2 (want 1..1)")
    expect(card).toContain("✓ skill security-audit")
    expect(card).toContain("✗ PR u OPEN checks PENDING")
  })
})

test("loopPrompt drops the skill frontmatter and appends the spec", () => {
  const p = loopPrompt("---\nname: factory-loop\ndescription: x\n---\n\n# Factory loop\nbody", spec)
  expect(p.startsWith("# Factory loop\nbody")).toBe(true)
  expect(p).toContain("Goal id: `demo`")
  expect(p).toContain('"repo": "/r"')
})

describe("goal form draft", () => {
  test("empty draft names its problems", () => {
    const r = draftToSpec(emptyDraft(), ["implement", "verify", "security", "finish"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems).toEqual(["id: lowercase letters, digits and dashes, 2-64 chars", "prompt is empty", "repo must be an absolute path"])
  })
  test("filled draft becomes a spec and round-trips", () => {
    const d = { ...emptyDraft(), id: "x-1", repo: "/r", prompt: "do it", bodyIncludes: "18080, OK", steps: { ...emptyDraft().steps, review: { on: true, min: "2", max: "" }, verify: { on: false, min: "1", max: "" } } }
    const r = draftToSpec(d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.expect.steps).toEqual({ implement: { min: 1 }, security: { min: 1 }, finish: { min: 1, max: 1 }, review: { min: 2 } })
    expect(r.spec.expect.pr).toEqual({ state: "OPEN", checks: "SUCCESS", bodyIncludes: ["18080", "OK"], untouched: [] })
    const again = draftToSpec(specToDraft(r.spec))
    expect(again.ok && again.spec).toEqual(r.spec)
  })
  test("bad counts are reported", () => {
    const d = { ...emptyDraft(), id: "x-1", repo: "/r", prompt: "p", steps: { implement: { on: true, min: "one", max: "" } } }
    const r = draftToSpec(d)
    expect(!r.ok && r.problems).toEqual(["step implement: counts must be whole numbers"])
  })
})

test("pastWorkers: stopped non-coordinators, newest summary, first start time", () => {
  const w = (id: string, role: string, name = id) => ({ id, role, name })
  const rows = [
    { ts: 10, data: w("pc-impl", "worker") },
    { ts: 20, data: w("sub-1", "coordinator") },
    { ts: 30, data: w("live", "worker") },
    { ts: 40, data: w("pc-impl", "worker", "pc-impl v2") },
  ]
  expect(pastWorkers(rows, (id) => id === "live")).toEqual([{ id: "pc-impl", role: "worker", name: "pc-impl v2", status: "stopped", startedAt: 10 }])
})
