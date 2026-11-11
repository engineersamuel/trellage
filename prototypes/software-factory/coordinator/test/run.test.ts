import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  buildGrade,
  decodeGoal,
  decodeGoalRun,
  draftToSpec,
  emptyDraft,
  goalProblems,
  goalUnmet,
  GRADING_VERSION,
  gradeStatus,
  nextImprovementAction,
  parseBenchmarks,
  parseQuality,
  proposeImprovement,
  specToDraft,
  splitPending,
  stopReason,
  type GoalSpec,
  type Grade,
  type GradeInputs,
  type Run,
} from "../../shared/goal.ts"
import { checksState, parsePrList, pastWorkers, runWorkers } from "../src/run.ts"
import { decodeGoalOrThrow, goalsDir, loopPrompt, makeGoals } from "../src/goals.ts"
import { criteriaResults, unprovenCriteria } from "../src/sdlc.ts"
import { Threads } from "../src/threads.ts"
import { goalCommand, parseSteps, runLine, scoreCard } from "../goal-cli.ts"

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
    expect(
      checksState([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toBe("SUCCESS")
    expect(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("PENDING")
    expect(checksState([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("FAILURE")
  })
})

const worker = (step: string, skills: string[] = []) => ({
  id: step,
  name: step,
  step,
  skills,
  harness: "copilot",
  owner: "sub",
  status: "idle",
})
const run: Run = {
  threadId: "t",
  status: "idle",
  branch: "factory/x",
  base: null,
  workers: [
    worker("implement", ["ub-mode"]),
    worker("verify"),
    worker("verify"),
    worker("security", ["security-audit"]),
  ],
  steps: ["implement", "verify", "security"],
  approvals: [],
  securityReviews: [],
  report: null,
  sdlc: null,
  pr: {
    number: 7,
    url: "u",
    state: "OPEN",
    head: "h",
    base: "main",
    body: "proof 18080",
    files: ["a.ts", "compose.yaml"],
    checks: "PENDING",
  },
}
const spec = decodeGoalOrThrow({
  id: "demo",
  repo: "/r",
  prompt: "p",
  expect: {
    steps: { implement: {}, verify: { max: 1 }, finish: {} },
    skills: ["security-audit", "council"],
    pr: { checks: "SUCCESS", bodyIncludes: ["18080", "OK"], untouched: ["compose.yaml"] },
  },
})

describe("goal spec", () => {
  test("defaults fill approvals, limits, base and PR state", () => {
    expect(spec.base).toBe("main")
    expect(spec.approvals).toEqual({ plan: "auto", findings: "auto", ship: "auto", other: "human" })
    expect(spec.limits).toEqual({ runs: 5, minutesPerRun: 720 })
    expect(spec.expect.steps.implement).toEqual({ min: 1 })
    expect(spec.expect.pr?.state).toBe("OPEN")
  })
  test("problems: id, prompt, repo, unknown step, bad counts", () => {
    const bad = {
      ...spec,
      id: "Bad Id",
      prompt: " ",
      repo: "rel",
      expect: { ...spec.expect, steps: { nope: { min: 2, max: 1 } } },
    } as GoalSpec
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
  test("untouched entries ending in / match a folder", () => {
    const pr = { ...run.pr!, files: ["src/a.rs", "reports/x/y.json"] }
    const want = { ...spec.expect, pr: { ...spec.expect.pr!, untouched: ["reports/", "src/b.rs"] } }
    expect(goalUnmet({ ...run, pr }, want, spec.base).filter((u) => u.includes("untouched"))).toEqual([
      "PR #7 changes reports/, expected untouched",
    ])
  })
  test("PR base defaults to the goal base", () => {
    expect(
      goalUnmet(run, { steps: {}, skills: [], pr: { state: "OPEN", bodyIncludes: [], untouched: [] } }, "dev"),
    ).toEqual(["PR #7 targets main, expected dev"])
    expect(
      goalUnmet(
        { ...run, pr: null },
        { steps: {}, skills: [], pr: { state: "OPEN", bodyIncludes: [], untouched: [] } },
      ),
    ).toEqual(["no PR for the branch"])
  })
})

describe("approval policy", () => {
  const a = (id: string, topic: "plan" | "ship" | "other", options = ["Yes", "No"]) => ({
    id,
    title: id,
    topic,
    status: "pending",
    answer: null,
    options,
  })
  const withPending = { ...run, approvals: [a("p", "plan"), a("s", "ship"), a("o", "other"), a("q", "plan", [])] }
  test("auto topics go to the runner; human topics and free-text questions stop", () => {
    const { auto, human } = splitPending(withPending, spec.approvals)
    expect(auto.map((x) => x.id)).toEqual(["p", "s"])
    expect(human.map((x) => x.id)).toEqual(["o", "q"])
    expect(stopReason(withPending, spec.approvals)?.code).toBe(2)
    expect(stopReason({ ...withPending, approvals: [a("p", "plan")] }, spec.approvals)).toBeNull()
  })
  test("blocked report stops with 3", () => {
    expect(stopReason({ ...run, report: { status: "blocked", summary: "x", gaps: [] } }, spec.approvals)).toEqual({
      code: 3,
      reason: "reported blocked: x",
    })
    const blocked = { ...run, status: "idle", report: { status: "blocked", summary: "x", gaps: [] } }
    expect(stopReason({ ...blocked, status: "running" }, spec.approvals)).toBeNull()
    expect(stopReason(blocked, spec.approvals, "x")).toBeNull()
    expect(stopReason(blocked, spec.approvals, "older")?.code).toBe(3)
  })
})

describe("goal store", () => {
  test("save validates, list and runs round-trip, log appends", () => {
    const g = makeGoals(path.join(mkdtempSync(path.join(tmpdir(), "sf-goals-")), "goals"), [
      "implement",
      "verify",
      "finish",
    ])
    expect(() => g.save({ id: "demo", repo: "/r", prompt: "p", expect: { steps: { bogus: {} } } })).toThrow(
      "unknown step bogus",
    )
    g.save({ id: "demo", repo: "/r", prompt: "p", expect: { steps: { implement: {} } } })
    expect(g.get("demo")?.prompt).toBe("p")
    expect(g.get("none")).toBeNull()
    g.appendRun("demo", { at: 1, factoryCommit: "abc", threadId: "t1", outcome: "fail", unmet: ["x"] })
    g.appendRun("demo", { at: 2, factoryCommit: "def", threadId: "t2", outcome: "pass", prUrl: "u" })
    expect(g.runs("demo").map((r) => [r.factoryCommit, r.outcome])).toEqual([
      ["abc", "fail"],
      ["def", "pass"],
    ])
    expect(g.list().map((x) => [x.spec.id, x.runs, x.last?.outcome])).toEqual([["demo", 2, "pass"]])
    expect(() => g.appendRun("none", { at: 1, factoryCommit: "a", threadId: "t", outcome: "pass" })).toThrow(
      "no goal none",
    )
    expect(() => g.get("../x")).toThrow("bad goal id")
  })
})

describe("goal cli helpers", () => {
  test("run numbering counts runner records, not appended grades", async () => {
    const saved = decodeGoalOrThrow({ id: "demo", repo: "/r", prompt: "p" })
    const calls: string[] = []
    const json: Parameters<typeof goalCommand>[0] = <A>(url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      const payload =
        url === "/api/goals/demo"
          ? saved
          : url === "/api/runs/t"
            ? run
            : url === "/api/goals/demo/runs" && !init
              ? [
                  { threadId: "old", outcome: "pass" },
                  { threadId: "old", grade: { key: "old-grade" } },
                  { threadId: "old", grade: { key: "later-grade" } },
                ]
              : {}
      return Effect.succeed(payload as A)
    }
    const log = spyOn(console, "log").mockImplementation(() => {})
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(
        await Effect.runPromise(
          goalCommand(json, () => Effect.die("unexpected launch"), ["run", "demo", "--thread", "t"]),
        ),
      ).toBe(0)
      expect(error).toHaveBeenCalledWith("goal demo: run 2 (limit 5 per loop)")
      expect(calls).toContain("POST /api/goals/demo/runs")
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })
  test("parseSteps", () => {
    expect(parseSteps("implement, finish=1,verify=1..2,review=2..")).toEqual({
      implement: { min: 1 },
      finish: { min: 1, max: 1 },
      verify: { min: 1, max: 2 },
      review: { min: 2 },
    })
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
  test.each([0.5, -1, Infinity])(
    "invalid improvement retry count %s is rejected with the same form problem",
    (maxRetries) => {
      const invalid = { ...spec, improve: { approval: "human" as const, maxRetries } }
      const problem = "improve.maxRetries must be a whole number >= 0"
      expect(goalProblems(invalid)).toContain(problem)
      expect(() => decodeGoalOrThrow(invalid)).toThrow(problem)
      expect(draftToSpec(specToDraft(invalid))).toEqual({ ok: false, problems: [problem] })
    },
  )
  test("an unrelated title edit preserves benchmarks and zero retries", () => {
    const saved = decodeGoalOrThrow({
      id: "latency",
      repo: "/r",
      prompt: "Keep latency low",
      expect: { benchmarks: [{ id: "latency", baseline: 25, higherIsBetter: false, tolerance: 2 }] },
      improve: { maxRetries: 0 },
    })
    expect(draftToSpec({ ...specToDraft(saved), title: "Edited" })).toEqual({
      ok: true,
      spec: { ...saved, title: "Edited" },
    })
  })
  test("empty draft names its problems", () => {
    const r = draftToSpec(emptyDraft(), ["implement", "verify", "security", "finish"])
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.problems).toEqual([
        "id: lowercase letters, digits and dashes, 2-64 chars",
        "prompt is empty",
        "repo must be an absolute path",
      ])
  })
  test("filled draft becomes a spec and round-trips", () => {
    const d = {
      ...emptyDraft(),
      id: "x-1",
      repo: "/r",
      prompt: "do it",
      bodyIncludes: "18080, OK",
      steps: {
        ...emptyDraft().steps,
        review: { on: true, min: "2", max: "" },
        verify: { on: false, min: "1", max: "" },
      },
    }
    const r = draftToSpec(d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.spec.expect.steps).toEqual({
      implement: { min: 1 },
      security: { min: 1 },
      finish: { min: 1, max: 1 },
      review: { min: 2 },
    })
    expect(r.spec.expect.pr).toEqual({ state: "OPEN", checks: "SUCCESS", bodyIncludes: ["18080", "OK"], untouched: [] })
    const again = draftToSpec(specToDraft(r.spec))
    expect(again.ok && again.spec).toEqual(r.spec)
  })
  test("bad counts are reported", () => {
    const d = {
      ...emptyDraft(),
      id: "x-1",
      repo: "/r",
      prompt: "p",
      steps: { implement: { on: true, min: "one", max: "" } },
    }
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
  expect(pastWorkers(rows, (id) => id === "live")).toEqual([
    { id: "pc-impl", role: "worker", name: "pc-impl v2", status: "stopped", startedAt: 10 },
  ])
})

describe("sdlc expectations", () => {
  const gate = (id: string, chosen: boolean, status: string) => ({
    id,
    chosen,
    probability: 0.5,
    threshold: 0.5,
    reason: "r",
    status,
  })
  const sdlc = {
    tier: "T2",
    criteria: ["a", "b"],
    unproven: ["AC-2"],
    gates: [gate("codeReview", true, "done"), gate("supplyChain", true, "failed"), gate("design", false, "skipped")],
    codeReviews: [],
    metrics: { minutes: 1, workers: 1, findingsKept: 0, findingsDropped: 0 },
  }
  test("criteria, gates run and skipped, tier", () => {
    const e = {
      steps: {},
      skills: [],
      sdlc: {
        criteriaProven: true,
        gatesRun: ["codeReview", "supplyChain", "design"],
        gatesSkipped: ["codeReview"],
        maxTier: "T1" as const,
      },
    }
    expect(goalUnmet({ ...run, sdlc }, e)).toEqual([
      "criteria without PASS evidence: AC-2",
      "gate supplyChain is failed, expected done",
      "gate design was skipped (r), expected to run",
      "gate codeReview ran, expected skipped",
      "tier T2, expected at most T1",
    ])
    expect(goalUnmet(run, e)).toEqual(["no SDLC record (sdlc_plan never ran)"])
  })
})

// ---- Grading (AC-1, AC-3, AC-4, AC-6, AC-7, AC-8) ----

const inputs = (over: Partial<GradeInputs> = {}): GradeInputs => ({
  at: 10,
  factoryCommit: "f00d",
  subject: { kind: "goal", id: "demo" },
  report: { status: "done", commit: "c0ffee" },
  criteria: { "AC-1": "pass", "AC-2": "pass" },
  benchmarks: null,
  evidence: [{ kind: "file", ref: ".factory/evidence.md", sha256: "abc" }],
  quality: [],
  errors: [],
  ...over,
})
const greenRun: Run = { ...run, pr: { ...run.pr!, checks: "SUCCESS" } }
const goalSpec = decodeGoalOrThrow({
  id: "demo",
  repo: "/r",
  prompt: "p",
  expect: { pr: { checks: "SUCCESS" }, benchmarks: [{ id: "latency", baseline: 100, higherIsBetter: false }] },
})

describe("criteriaResults", () => {
  test("a FAIL wins over a conflicting PASS in either order", () => {
    for (const evidence of ["AC-1: PASS\nAC-1: FAIL", "AC-1: FAIL\nAC-1: PASS"]) {
      expect(criteriaResults(["a"], evidence)).toEqual({ "AC-1": "fail" })
      expect(unprovenCriteria(["a"], evidence)).toEqual(["AC-1"])
    }
  })
  test("pass, fail and missing per criterion; unprovenCriteria keeps its output", () => {
    const evidence = "AC-1: PASS — make test — ok\nAC-2: FAIL — make lint — 3 errors\n"
    expect(criteriaResults(["a", "b", "c"], evidence)).toEqual({ "AC-1": "pass", "AC-2": "fail", "AC-3": "missing" })
    expect(criteriaResults(["a"], null)).toEqual({ "AC-1": "missing" })
    expect(unprovenCriteria(["a", "b", "c"], evidence)).toEqual(["AC-2", "AC-3"])
  })
})

describe("grade evidence files", () => {
  test("gh output: no PR, a PR, and bad JSON as a grading error", () => {
    expect(parsePrList("[]")).toEqual({ pr: null })
    expect(
      parsePrList(
        '[{"number":3,"url":"u","state":"OPEN","headRefOid":"h","baseRefName":"main","body":null,"files":null,"statusCheckRollup":null}]',
      ),
    ).toEqual({
      pr: { number: 3, url: "u", state: "OPEN", head: "h", base: "main", body: "", files: [], checks: "NONE" },
    })
    expect("error" in parsePrList("<html>rate limited")).toBe(true)
    expect("error" in parsePrList("{}")).toBe(true)
  })
  test("benchmarks.json: absent, values, malformed is a grading error", () => {
    expect(parseBenchmarks(null)).toEqual({ values: null })
    expect(parseBenchmarks('{"latency": 90}')).toEqual({ values: { latency: 90 } })
    expect("error" in parseBenchmarks('{"latency": "fast"}')).toBe(true)
    expect("error" in parseBenchmarks("nope")).toBe(true)
  })
  test("quality.json: entries without a judge are dropped; a malformed file is only a note", () => {
    const judged = { score: 7, scale: "0-10", judge: { model: "m", harness: "h" }, evidence: "e" }
    expect(parseQuality(null)).toEqual({ entries: [] })
    expect(parseQuality(JSON.stringify([judged, { score: 9, scale: "0-10", evidence: "e" }]))).toEqual({
      entries: [judged],
    })
    expect(parseQuality("{").entries).toEqual([])
    expect(parseQuality("{").note).toContain("quality.json")
    expect(parseQuality("{}").note).toContain("quality.json")
  })
})

describe("gradeStatus", () => {
  const base = {
    criteria: { "AC-1": "pass" as const },
    prChecks: { required: true, state: "SUCCESS" as const },
    benchmarks: [],
    errors: [],
    prRequired: true,
    prFound: true,
  }
  test.each([
    ["all required results pass", {}, "pass"],
    ["a failed criterion fails", { criteria: { "AC-1": "fail", "AC-2": "missing" } }, "fail"],
    ["a failed PR check fails", { prChecks: { required: false, state: "FAILURE" } }, "fail"],
    ["a regressed benchmark fails", { benchmarks: [{ value: 120, regressed: true }] }, "fail"],
    ["fail beats a grader error", { criteria: { "AC-1": "fail" }, errors: ["gh: timeout"] }, "fail"],
    [
      "a grader error is error, not fail",
      { errors: ["gh: timeout"], prFound: false, prChecks: { required: true, state: "missing" } },
      "error",
    ],
    ["a missing criterion is unknown", { criteria: { "AC-1": "pass", "AC-2": "missing" } }, "unknown"],
    ["no criteria is unknown", { criteria: {} }, "unknown"],
    ["pending required checks are unknown", { prChecks: { required: true, state: "PENDING" } }, "unknown"],
    [
      "no PR when one is required is unknown",
      { prFound: false, prChecks: { required: false, state: "missing" } },
      "unknown",
    ],
    ["a benchmark that did not run is unknown", { benchmarks: [{ value: null, regressed: null }] }, "unknown"],
    ["NONE checks that are not required pass", { prChecks: { required: false, state: "NONE" } }, "pass"],
  ] as const)("%s", (_name, over, want) => {
    expect(gradeStatus({ ...base, ...over } as Parameters<typeof gradeStatus>[0])).toBe(want)
  })
})

describe("buildGrade", () => {
  test("goal subject: linked to thread, factory commit, grading version and evidence; results reported separately", () => {
    const g = buildGrade(greenRun, inputs({ benchmarks: { latency: 90 } }), goalSpec)
    expect(g.key).toBe(`t|c0ffee|done|${GRADING_VERSION}`)
    expect([g.threadId, g.factoryCommit, g.gradingVersion, g.subject]).toEqual([
      "t",
      "f00d",
      GRADING_VERSION,
      { kind: "goal", id: "demo" },
    ])
    expect(g.evidence).toEqual([
      { kind: "file", ref: ".factory/evidence.md", sha256: "abc" },
      { kind: "pr", ref: "u" },
      { kind: "commit", ref: "c0ffee" },
    ])
    expect(g.criteria).toEqual({
      results: { "AC-1": "pass", "AC-2": "pass" },
      passed: 2,
      evaluated: 2,
      total: 2,
      rate: 1,
    })
    expect(g.prChecks).toEqual({ required: true, state: "SUCCESS", url: "u" })
    expect(g.benchmarks).toEqual([{ id: "latency", baseline: 100, value: 90, regressed: false }])
    expect(g.status).toBe("pass")
  })
  test("criteria rate is passed / evaluated; a regression against the fixed baseline fails", () => {
    const g = buildGrade(
      greenRun,
      inputs({ criteria: { "AC-1": "pass", "AC-2": "fail", "AC-3": "missing" }, benchmarks: { latency: 130 } }),
      goalSpec,
    )
    expect(g.criteria).toMatchObject({ passed: 1, evaluated: 2, total: 3, rate: 0.5 })
    expect(g.benchmarks[0]?.regressed).toBe(true)
    expect(g.status).toBe("fail")
  })
  test("a benchmark regresses only beyond its tolerance, in its direction; 0 is a value", () => {
    const specFor = (higherIsBetter: boolean) =>
      decodeGoalOrThrow({
        id: "demo",
        repo: "/r",
        prompt: "p",
        expect: { benchmarks: [{ id: "b", baseline: 100, higherIsBetter, tolerance: 5 }] },
      })
    const regressedAt = (higherIsBetter: boolean, value: number) =>
      buildGrade(greenRun, inputs({ benchmarks: { b: value } }), specFor(higherIsBetter)).benchmarks[0]?.regressed
    expect([95, 94].map((v) => regressedAt(true, v))).toEqual([false, true])
    expect([105, 106].map((v) => regressedAt(false, v))).toEqual([false, true])
    expect(buildGrade(greenRun, inputs({ benchmarks: { b: 0 } }), specFor(true)).benchmarks[0]?.value).toBe(0)
  })
  test("a goal without a PR expectation requires neither PR nor checks", () => {
    const g = buildGrade({ ...run, pr: null }, inputs(), decodeGoalOrThrow({ id: "demo", repo: "/r", prompt: "p" }))
    expect(g.prChecks).toEqual({ required: false, state: "missing", url: null })
    expect(g.status).toBe("pass")
  })
  test("history marks grade lines with status, criteria and grading version", () => {
    const g = buildGrade(
      greenRun,
      inputs({ criteria: { "AC-1": "pass", "AC-2": "fail", "AC-3": "missing" } }),
      goalSpec,
    )
    const base = { at: g.at, factoryCommit: "abc1234", threadId: "thread-1", unmet: [], prUrl: null }
    expect(runLine({ ...base, outcome: "fail", grade: g })).toContain("grade fail")
    expect(runLine({ ...base, outcome: "fail", grade: g })).toContain("AC 1/2 g1")
    expect(runLine({ ...base, outcome: "pass" })).not.toContain("grade")
  })
  test("prompt subject: PR required when done, checks required only when CI reported", () => {
    const prompt = inputs({ subject: { kind: "prompt", id: "0123456789ab" } })
    const g = buildGrade({ ...run, pr: { ...run.pr!, checks: "NONE" } }, prompt)
    expect([g.subject.kind, g.threadId, g.factoryCommit, g.gradingVersion]).toEqual([
      "prompt",
      "t",
      "f00d",
      GRADING_VERSION,
    ])
    expect(g.prChecks).toEqual({ required: false, state: "NONE", url: "u" })
    expect(g.benchmarks).toEqual([])
    expect(g.status).toBe("pass")
    expect(buildGrade({ ...run, pr: null }, prompt).status).toBe("unknown")
    expect(
      buildGrade(
        { ...run, pr: null },
        inputs({ subject: prompt.subject, report: { status: "blocked", commit: "c0ffee" } }),
      ).status,
    ).toBe("pass")
  })
  test("a gh error is a grading error, not a failed grade or 'no PR'", () => {
    const g = buildGrade({ ...run, pr: null, prError: "gh: HTTP 502" }, inputs(), goalSpec)
    expect(g.status).toBe("error")
    expect(g.errors).toEqual(["PR lookup failed: gh: HTTP 502"])
    expect(goalUnmet({ ...run, pr: null, prError: "gh: HTTP 502" }, goalSpec.expect)).toContain(
      "PR lookup failed: gh: HTTP 502",
    )
    expect(goalUnmet({ ...run, pr: null, prError: "gh: HTTP 502" }, goalSpec.expect)).not.toContain(
      "no PR for the branch",
    )
  })
  test("a model-judged quality score never changes the status", () => {
    const judged = [{ score: 0, scale: "0-10", judge: { model: "m", harness: "h" }, evidence: "quality.json" }]
    for (const over of [{}, { criteria: { "AC-1": "fail" as const } }, { criteria: { "AC-1": "missing" as const } }]) {
      const plain = buildGrade(greenRun, inputs(over), goalSpec)
      const withScore = buildGrade(greenRun, inputs({ ...over, quality: judged }), goalSpec)
      expect(withScore.status).toBe(plain.status)
      expect(withScore.quality).toEqual(judged)
    }
  })
})

describe("grade persistence", () => {
  test.each(["unknown", "pass", "fail", "error"] as const)(
    "only an explicit regrade replaces an unknown grade, not a %s grade otherwise",
    (status) => {
      const root = mkdtempSync(path.join(tmpdir(), "sf-regrade-"))
      try {
        const goals = makeGoals(root, [])
        goals.save({ id: "demo", repo: "/r", prompt: "p" })
        const threads = new Threads(root)
        const t = threads.create("do it")
        const original = { ...buildGrade(greenRun, inputs(), goalSpec), status, threadId: t.id }
        const settled = { ...original, status: "pass" as const, at: original.at + 1 }
        const line = {
          at: original.at,
          factoryCommit: "factory",
          threadId: t.id,
          outcome: status,
          unmet: [],
          prUrl: null,
          grade: original,
        }
        const replacement = { ...line, at: settled.at, outcome: settled.status, grade: settled }
        const other = { ...line, grade: { ...original, key: "another-report" } }
        const file = path.join(root, "demo.runs.jsonl")
        const before = ' { "at":1,"factoryCommit":"old","threadId":"t","outcome":"blocked" }\r\n\n'
        const after = `\n ${JSON.stringify(other)} \r\n{"legacy":"unrecognized"}\n`
        const bytes = `${before}${JSON.stringify(line)}${after}`
        writeFileSync(file, bytes)
        expect(threads.addGrade(t.id, original)).toBe(true)
        const warn = spyOn(console, "warn").mockImplementation(() => {})
        try {
          expect(goals.appendGrade("demo", replacement)).toBeNull()
          expect(threads.addGrade(t.id, settled)).toBe(false)
          expect(readFileSync(file, "utf8")).toBe(bytes)
          expect(new Threads(root).get(t.id)!.grades).toEqual([original])
          const replaced = status === "unknown"
          expect(goals.appendGrade("demo", replacement, true)).toEqual(replaced ? replacement : null)
          expect(threads.addGrade(t.id, settled, true)).toBe(replaced)
          expect(readFileSync(file, "utf8")).toBe(replaced ? `${before}${JSON.stringify(replacement)}${after}` : bytes)
          expect(new Threads(root).get(t.id)!.grades).toEqual([replaced ? settled : original])
          expect(readdirSync(root).sort()).toEqual(["demo.json", "demo.runs.jsonl", "threads.json"])
        } finally {
          warn.mockRestore()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test("goal: appendGrade round-trips, a replayed completion adds no second grade, run counts ignore grade lines", () => {
    const g = makeGoals(path.join(mkdtempSync(path.join(tmpdir(), "sf-grades-")), "goals"), ["implement"])
    g.save({ id: "demo", repo: "/r", prompt: "p" })
    g.appendRun("demo", { at: 1, factoryCommit: "abc", threadId: "t", outcome: "blocked" })
    const grade = buildGrade(greenRun, inputs(), goalSpec)
    const line = {
      at: grade.at,
      factoryCommit: grade.factoryCommit,
      threadId: grade.threadId,
      outcome: grade.status,
      grade,
    }
    expect(g.appendGrade("demo", line)?.grade?.key).toBe(grade.key)
    expect(g.appendGrade("demo", line)).toBeNull()
    expect(
      g
        .runs("demo")
        .filter((r) => r.grade)
        .map((r) => r.grade!.key),
    ).toEqual([grade.key])
    const [listed] = g.list()
    expect([listed?.runs, listed?.last?.outcome, listed?.grades.map((x) => x.key)]).toEqual([1, "blocked", [grade.key]])
    // The same thread and commit reporting again with another status is a second, real grading.
    const later = buildGrade(greenRun, inputs({ report: { status: "blocked", commit: "c0ffee" } }), goalSpec)
    expect(g.appendGrade("demo", { ...line, grade: later })).not.toBeNull()
    expect(g.list()[0]?.grades).toHaveLength(2)
    expect(() => g.appendGrade("demo", { at: 2, factoryCommit: "abc", threadId: "t", outcome: "pass" })).toThrow(
      "a grade line needs a grade",
    )
  })
  test("prompt: Threads.addGrade stores one grade per key, across a restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-thread-grades-"))
    const th = new Threads(root)
    const t = th.create("do it")
    const grade = buildGrade(greenRun, inputs({ subject: { kind: "prompt", id: "abc" } }))
    expect(th.addGrade(t.id, grade)).toBe(true)
    expect(th.addGrade(t.id, grade)).toBe(false)
    expect(new Threads(root).addGrade(t.id, grade)).toBe(false)
    expect(new Threads(root).get(t.id)?.grades?.map((x) => x.key)).toEqual([grade.key])
  })
})

describe("improvement proposals", () => {
  const failed: Grade = buildGrade(greenRun, inputs({ criteria: { "AC-1": "fail" } }), goalSpec)
  const policy = goalSpec.improve
  const approval = (over: Partial<{ status: string; answer: string | null; answeredBy: string | null }> = {}) => ({
    status: "answered",
    answer: "Launch improvement run",
    options: ["Launch improvement run", "Reject"],
    answeredBy: null,
    ...over,
  })
  const proposal = proposeImprovement(failed, "ap1", false)!

  test("a failed grade proposes; other grades and improvement runs never do", () => {
    expect(proposal).toEqual({
      sourceKey: failed.key,
      sourceThreadId: "t",
      approvalId: "ap1",
      status: "proposed",
      approvedBy: null,
      attempts: 0,
      launchedThreadId: null,
      lastError: null,
    })
    expect(proposeImprovement(buildGrade(greenRun, inputs(), goalSpec), "ap1", false)).toBeNull()
    expect(proposeImprovement({ ...failed, status: "error" }, "ap1", false)).toBeNull()
    expect(proposeImprovement(failed, "ap1", true)).toBeNull()
  })
  test("no improvement run starts before a human approval", () => {
    expect(nextImprovementAction(proposal, policy, undefined, false).kind).toBe("wait")
    expect(nextImprovementAction(proposal, policy, approval({ status: "pending", answer: null }), false).kind).toBe(
      "wait",
    )
    expect(nextImprovementAction(proposal, policy, approval(), false).kind).toBe("launch")
  })
  test("the goal auto-approval policy cannot answer it", () => {
    expect(
      nextImprovementAction(proposal, policy, approval({ answeredBy: "goal demo (policy other=auto)" }), false).kind,
    ).toBe("refuse")
    expect(nextImprovementAction(proposal, policy, approval({ answer: "Reject" }), false).kind).toBe("refuse")
    expect(Exit.isFailure(decodeGoal({ id: "demo", repo: "/r", prompt: "p", improve: { approval: "auto" } }))).toBe(
      true,
    )
  })
  test("retries stop at 1 + maxRetries launch attempts; launched proposals never relaunch", () => {
    expect(policy).toEqual({ approval: "human", maxRetries: 1 })
    expect(
      nextImprovementAction({ ...proposal, status: "launch-failed", attempts: 1 }, policy, approval(), false).kind,
    ).toBe("launch")
    expect(
      nextImprovementAction({ ...proposal, status: "launch-failed", attempts: 2 }, policy, approval(), false).kind,
    ).toBe("refuse")
    expect(
      nextImprovementAction(
        { ...proposal, status: "launch-failed", attempts: 1 },
        { approval: "human", maxRetries: 0 },
        approval(),
        false,
      ).kind,
    ).toBe("refuse")
    expect(
      nextImprovementAction({ ...proposal, status: "launched", attempts: 1 }, policy, approval(), false).kind,
    ).toBe("refuse")
    expect(nextImprovementAction({ ...proposal, status: "rejected" }, policy, approval(), false).kind).toBe("refuse")
  })
  test.each([0, 0.5, 1, 1.5, 2.9])(
    "launches cannot exceed the retry budget %s, even for an unvalidated policy",
    (maxRetries) => {
      let current = proposal
      for (let attempt = 0; attempt < 6; attempt++) {
        const action = nextImprovementAction(current, { ...policy, maxRetries }, approval(), false)
        if (action.kind !== "launch") break
        current = { ...current, status: "launch-failed", attempts: current.attempts + 1 }
      }
      expect(current.attempts).toBe(1 + Math.floor(maxRetries))
      expect(current.attempts).toBeLessThanOrEqual(1 + maxRetries)
      expect(nextImprovementAction(current, { ...policy, maxRetries }, approval(), false).kind).toBe("refuse")
    },
  )
  test("an improvement thread's own grade never launches more work", () => {
    expect(nextImprovementAction(proposal, policy, approval(), true).kind).toBe("refuse")
    expect(nextImprovementAction(null, policy, approval(), false).kind).toBe("refuse")
  })
})

describe("backward compatibility", () => {
  test("verbatim pre-change run lines decode", () => {
    const lines = [
      '{"at":1794170801542,"factoryCommit":"6703f38185db","threadId":"a63a0a8b-ffeb-4778-b4ef-dfec57c93731","outcome":"blocked","unmet":["step security never ran","step finish never ran","skill security-audit never invoked","gate supplyChain is failed, expected done","no PR for the branch"],"prUrl":null}',
      '{"at":1794153034077,"factoryCommit":"0d84ca9b93d0","threadId":"732d73de-74be-43e6-8d09-3dd04dd5ed1d","outcome":"timeout","unmet":["step finish ran 2x, expected at most 1"],"prUrl":"https://github.com/engineersamuel/copilot-proxy-rs/pull/60"}',
    ]
    for (const l of lines) {
      const exit = decodeGoalRun(JSON.parse(l))
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value.grade).toBeUndefined()
    }
  })
  test("every saved spec and run log in docs/goals/factory decodes", () => {
    const dir = goalsDir({})
    const names = readdirSync(dir)
    expect(names.filter((n) => n.endsWith(".json")).length).toBeGreaterThan(0)
    for (const n of names.filter((f) => f.endsWith(".json"))) {
      const saved = decodeGoalOrThrow(JSON.parse(readFileSync(path.join(dir, n), "utf8")))
      expect(saved.improve).toEqual({ approval: "human", maxRetries: 1 })
      expect(saved.expect.benchmarks).toEqual([])
    }
    for (const n of names.filter((f) => f.endsWith(".runs.jsonl")))
      for (const l of readFileSync(path.join(dir, n), "utf8")
        .split("\n")
        .filter((x) => x.trim()))
        expect(Exit.isSuccess(decodeGoalRun(JSON.parse(l)))).toBe(true)
  })
})
