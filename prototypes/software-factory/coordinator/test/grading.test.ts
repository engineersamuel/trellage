import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Approvals } from "../src/approvals.ts"
import { makeGoals } from "../src/goals.ts"
import { makeGrading, type GradingDependencies } from "../src/grading.ts"
import type { Report } from "../src/report.ts"
import { Threads } from "../src/threads.ts"
import type { Run } from "../../shared/goal.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const report: Report = {
  status: "done",
  branch: "factory/test",
  commit: "c0ffee",
  summary: "Complete",
  checks: [],
  gaps: [],
  nextSteps: [],
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

const fixture = (saved = true) => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-grading-"))
  roots.push(root)
  const worktree = path.join(root, "worktree")
  mkdirSync(path.join(worktree, ".factory"), { recursive: true })
  const threads = new Threads(root)
  const t = threads.create("Keep latency low", undefined, () => ({
    worktree,
    branch: report.branch,
    base: "main",
  }))
  threads.append(t.id, { id: "prompt", role: "user", content: "Keep latency low" })
  const goals = makeGoals(path.join(root, "goals"), [])
  const spec = goals.save({
    id: "latency",
    repo: worktree,
    prompt: "Keep latency low",
    expect: {
      benchmarks: [{ id: "latency", baseline: 25, higherIsBetter: false, tolerance: 2 }],
      pr: { checks: "SUCCESS" },
    },
  })
  if (saved) threads.setMeta(t.id, { goalId: spec.id })
  const approvals = new Approvals(root)
  const events: { type: string; data: object }[] = []
  const launches: { folder: string; task: string; meta: object }[] = []
  const run: Run = {
    threadId: t.id,
    status: "idle",
    branch: report.branch,
    base: "main",
    workers: [],
    steps: [],
    approvals: [],
    securityReviews: [],
    report: null,
    sdlc: null,
    pr: {
      number: 1,
      url: "https://example.test/pr/1",
      state: "OPEN",
      head: report.branch,
      base: "main",
      body: "",
      files: [],
      checks: "SUCCESS",
    },
  }
  const deps: GradingDependencies = {
    threads,
    goals,
    approvals,
    factoryDir: process.cwd(),
    env: {},
    runRecord: async (threadId) => ({ ...run, threadId }),
    criteria: () => ["Latency stays low"],
    deskThreadId: () => "desk",
    publish: (type, data) => events.push({ type, data }),
    openConversation: async (folder, task, meta) => {
      launches.push({ folder, task, meta })
      return { info: { threadId: "improvement-run" }, sent: { sent: Promise.resolve() } }
    },
  }
  const write = (name: string, text: string) => writeFileSync(path.join(worktree, ".factory", name), text)
  write("evidence.md", "AC-1: PASS\n")
  write("benchmarks.json", '{"latency":26}')
  const grading = makeGrading(deps)
  const answer = (value = "Launch improvement run", by: string | null = null) =>
    approvals.answer(t.improvement!.approvalId, value, null, by)
  return {
    root,
    worktree,
    threads,
    t,
    goals,
    spec,
    approvals,
    events,
    launches,
    run,
    deps,
    write,
    grading,
    answer,
  }
}

describe("report grading orchestration", () => {
  test("legacy goal history returns only this thread's grades, not runner lines or other threads", async () => {
    const f = fixture()
    await f.grading.gradeThread(f.t.id, report)
    const [grade] = f.grading.gradesOf(f.t)
    f.goals.appendRun(f.spec.id, { at: 1, factoryCommit: "factory", threadId: f.t.id, outcome: "pass" })
    f.goals.appendGrade(f.spec.id, {
      at: 2,
      factoryCommit: "factory",
      threadId: "other",
      outcome: "pass",
      grade: { ...grade!, key: "other|commit|done|g1", threadId: "other" },
    })
    const { grades: _grades, ...legacy } = f.t
    expect(f.grading.gradesOf(legacy)).toEqual([grade!])
    expect(f.grading.gradesOf({ ...legacy, goalId: undefined })).toEqual([])
  })

  test("a corrupt goal log leaves a visible durable grade and does not duplicate its proposal", async () => {
    const f = fixture()
    writeFileSync(path.join(f.goals.dir, `${f.spec.id}.runs.jsonl`), "{")
    f.write("evidence.md", "AC-1: FAIL\n")
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      await f.grading.gradeThread(f.t.id, report)
      const restored = new Threads(f.root).get(f.t.id)!
      const grades = f.grading.gradesOf(restored)
      expect(grades).toHaveLength(1)
      expect(grades[0]).toMatchObject({ status: "fail", subject: { kind: "goal", id: f.spec.id } })
      expect(error.mock.calls.flat().join("\n")).toContain("saved on thread but not goal log")
      await f.grading.gradeThread(f.t.id, report)
      expect(f.approvals.list()).toHaveLength(1)
    } finally {
      error.mockRestore()
    }
  })

  test("missing artifacts are unknown, malformed benchmarks are errors, malformed quality is only a note", async () => {
    const f = fixture()
    rmSync(path.join(f.worktree, ".factory/evidence.md"))
    await f.grading.gradeThread(f.t.id, report)
    expect(f.grading.gradesOf(f.t)[0]).toMatchObject({ status: "unknown", errors: [] })
    f.write("evidence.md", "AC-1: PASS\n")
    f.write("benchmarks.json", "bad JSON")
    f.write("quality.json", "{}")
    await f.grading.gradeThread(f.t.id, { ...report, commit: "malformed" })
    const grade = f.grading.gradesOf(f.t)[1]!
    expect(grade.status).toBe("error")
    expect(grade.errors[0]).toContain("benchmarks.json is not")
    expect(grade.evidence).toContainEqual({ kind: "note", ref: "quality.json is not a list; ignored" })
    expect(grade.quality).toEqual([])
    expect(f.approvals.list()).toHaveLength(0)
  })

  test("non-completion reports and unknown threads do not grade", async () => {
    const f = fixture()
    await f.grading.gradeThread(f.t.id, { ...report, status: "needs-decision" })
    await f.grading.gradeThread("unknown", report)
    expect(f.grading.gradesOf(f.t)).toEqual([])
    expect(f.events).toEqual([])
  })

  test("plain-prompt identity uses the first user message, or the thread title when absent", async () => {
    const f = fixture(false)
    const t = f.threads.create("Fallback title")
    f.threads.append(t.id, { id: "assistant", role: "assistant", content: "Not the prompt" })
    await f.grading.gradeThread(t.id, report)
    expect(f.grading.gradesOf(t)[0]).toMatchObject({
      subject: { kind: "prompt", id: hash(t.title).slice(0, 12) },
      status: "unknown",
      evidence: expect.any(Array),
    })
    const empty = f.threads.create("Not the empty prompt")
    f.threads.append(empty.id, { id: "user", role: "user", content: "" })
    await f.grading.gradeThread(empty.id, report)
    expect(f.grading.gradesOf(empty)[0]!.subject.id).toBe(hash("").slice(0, 12))
  })

  test("a failed thread save logs the error; a replay reuses its already-persisted proposal", async () => {
    const f = fixture()
    f.write("evidence.md", "AC-1: FAIL\n")
    const add = spyOn(f.threads, "addGrade").mockImplementationOnce(() => {
      throw new Error("disk full")
    })
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      await f.grading.gradeThread(f.t.id, report)
      expect(error.mock.calls.flat().join("\n")).toContain("not saved: disk full")
      const approvalId = f.t.improvement!.approvalId
      await f.grading.gradeThread(f.t.id, report)
      expect(f.grading.gradesOf(f.t)[0]!.proposalId).toBe(approvalId)
      expect(f.approvals.list()).toHaveLength(1)
    } finally {
      add.mockRestore()
      error.mockRestore()
    }
  })
  test("reads and hashes worktree evidence, attaches a goal grade, and persists it across restart", async () => {
    const f = fixture()
    f.write(
      "quality.json",
      '[{"score":7,"scale":"0-10","judge":{"model":"judge","harness":"test"},"evidence":"review"}]',
    )
    await f.grading.gradeThread(f.t.id, report)
    const [g] = f.grading.gradesOf(f.t)
    expect(g).toMatchObject({
      subject: { kind: "goal", id: f.spec.id },
      status: "pass",
      report: { status: "done", commit: "c0ffee" },
      criteria: { results: { "AC-1": "pass" }, rate: 1 },
      benchmarks: [{ id: "latency", baseline: 25, value: 26, regressed: false }],
      errors: [],
      proposalId: null,
    })
    expect(g!.factoryCommit).toMatch(/^[a-f0-9]{12}(\+dirty)?$/)
    expect(g!.evidence).toContainEqual({
      kind: "file",
      ref: path.join(f.worktree, ".factory/evidence.md"),
      sha256: hash("AC-1: PASS\n"),
    })
    expect(g!.quality).toHaveLength(1)
    expect(f.goals.runs(f.spec.id)[0]?.grade).toEqual(g)
    expect(makeGrading({ ...f.deps, threads: new Threads(f.root) }).gradesOf(new Threads(f.root).get(f.t.id)!)).toEqual(
      [g!],
    )
    expect(f.approvals.list()).toHaveLength(0)
    expect(f.events.map((e) => e.type)).toContain("factory.graded")
  })

  test("unreadable evidence is an error, never a successful grade", async () => {
    const f = fixture()
    rmSync(path.join(f.worktree, ".factory/evidence.md"))
    mkdirSync(path.join(f.worktree, ".factory/evidence.md"))
    await f.grading.gradeThread(f.t.id, report)
    const [g] = f.grading.gradesOf(f.t)
    expect(g!.status).toBe("error")
    expect(g!.errors[0]).toContain("evidence.md unreadable:")
    expect(g!.criteria.results).toEqual({ "AC-1": "missing" })
  })

  test("unreadable optional quality is only a note and never changes grade status", async () => {
    const f = fixture()
    mkdirSync(path.join(f.worktree, ".factory/quality.json"))
    await f.grading.gradeThread(f.t.id, report)
    const [g] = f.grading.gradesOf(f.t)
    expect(g!.status).toBe("pass")
    expect(g!.errors).toEqual([])
    expect(g!.quality).toEqual([])
    expect(g!.evidence).toContainEqual({
      kind: "note",
      ref: expect.stringContaining("quality.json unreadable:"),
    })
  })

  test.each(["invalid", "missing"] as const)(
    "a %s saved goal retains its identity and visible error grade",
    async (failure) => {
      const f = fixture()
      const file = path.join(f.goals.dir, `${f.spec.id}.json`)
      if (failure === "invalid") writeFileSync(file, "{")
      else rmSync(file)
      await f.grading.gradeThread(f.t.id, report)
      const restored = new Threads(f.root).get(f.t.id)!
      const [g] = f.grading.gradesOf(restored)
      expect(g).toMatchObject({
        subject: { kind: "goal", id: f.spec.id },
        status: "error",
        proposalId: null,
      })
      expect(g!.errors.join("\n")).toContain(`goal ${f.spec.id}:`)
      await f.grading.gradeThread(f.t.id, report)
      expect(f.grading.gradesOf(restored)).toHaveLength(1)
    },
  )

  test("run lookup failures persist a grading error", async () => {
    const f = fixture()
    f.deps.runRecord = async () => {
      throw new Error("run offline")
    }
    await f.grading.gradeThread(f.t.id, report)
    expect(f.grading.gradesOf(f.t)[0]).toMatchObject({ status: "error" })
  })

  test("a validated goal snapshot keeps benchmarks and zero retries after the saved spec becomes invalid", async () => {
    const f = fixture()
    f.threads.setMeta(f.t.id, {
      goalSpec: { ...f.spec, improve: { approval: "human", maxRetries: 0 } },
    })
    writeFileSync(path.join(f.goals.dir, `${f.spec.id}.json`), "{")
    f.write("benchmarks.json", '{"latency":30}')
    await f.grading.gradeThread(f.t.id, report)
    expect(f.grading.gradesOf(f.t)[0]).toMatchObject({
      status: "fail",
      benchmarks: [{ id: "latency", baseline: 25, value: 30, regressed: true }],
      errors: [],
    })
    f.deps.openConversation = async () => {
      throw new Error("launch unavailable")
    }
    await f.grading.advanceImprovement(f.t, f.answer())
    expect(f.t.improvement?.status).toBe("launch-failed")
    await f.grading.retryImprovements()
    expect(f.t.improvement).toMatchObject({ status: "exhausted", attempts: 1 })
    expect(new Threads(f.root).get(f.t.id)?.goalSpec?.improve.maxRetries).toBe(0)
  })

  test("replayed and concurrent completions open exactly one proposal with the persisted grade", async () => {
    const f = fixture()
    f.write("benchmarks.json", '{"latency":30}')
    await Promise.all([f.grading.gradeThread(f.t.id, report), f.grading.gradeThread(f.t.id, report)])
    const [g] = f.grading.gradesOf(f.t)
    expect(g!.status).toBe("fail")
    expect(g!.proposalId).toBe(f.t.improvement!.approvalId)
    expect(f.t.improvement).toMatchObject({ sourceKey: g!.key, status: "proposed", attempts: 0 })
    expect(f.approvals.list()).toHaveLength(1)
    expect(f.approvals.list()[0]?.threadId).toBe("desk")
    expect(f.approvals.list()[0]?.reportThreadId).toBeUndefined()
    expect(f.goals.runs(f.spec.id)).toHaveLength(1)
    const restored = new Threads(f.root)
    await makeGrading({ ...f.deps, threads: restored }).gradeThread(f.t.id, report)
    expect(f.approvals.list()).toHaveLength(1)
    expect(f.launches).toHaveLength(0)
  })

  test("a new failed completion after rejection opens another independently routed approval", async () => {
    const f = fixture()
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, { ...report, status: "blocked" })
    const rejected = f.answer("Reject")
    await f.grading.advanceImprovement(f.t, rejected)
    expect(f.t.improvement?.status).toBe("rejected")
    await f.grading.gradeThread(f.t.id, { ...report, commit: "new-commit" })
    const grades = f.grading.gradesOf(f.t)
    expect(grades).toHaveLength(2)
    expect(grades[1]!.proposalId).not.toBeNull()
    expect(grades[1]!.proposalId).not.toBe(grades[0]!.proposalId)
    expect(f.approvals.list()).toHaveLength(2)
    expect(f.grading.improvementAnswered(rejected)).toBe(true)
    expect(f.t.improvement?.status).toBe("proposed")
    await f.grading.advanceImprovement(f.t, f.answer())
    expect(f.t.improvement?.status).toBe("launched")
    expect(f.launches).toHaveLength(1)
  })

  test("plain prompts persist on the thread and improvement runs never propose recursively", async () => {
    const f = fixture(false)
    f.threads.setMeta(f.t.id, { improvementOf: "source" })
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, report)
    expect(new Threads(f.root).get(f.t.id)?.grades?.[0]).toMatchObject({
      subject: { kind: "prompt", id: hash("Keep latency low").slice(0, 12) },
      status: "fail",
      proposalId: null,
    })
    expect(f.approvals.list()).toHaveLength(0)
  })

  test("SF_GRADING=off disables grading and pending retries", async () => {
    const f = fixture()
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, report)
    const approval = f.answer()
    f.threads.setMeta(f.t.id, { improvement: { ...f.t.improvement!, status: "launch-failed" } })
    const off = makeGrading({ ...f.deps, env: { SF_GRADING: "off" } })
    await off.gradeThread(f.t.id, { ...report, commit: "disabled" })
    await off.retryImprovements()
    await off.advanceImprovement(f.t, approval)
    expect(f.grading.gradesOf(f.t)).toHaveLength(1)
    expect(f.launches).toHaveLength(0)
  })
})

describe("settling grades and interrupted launches", () => {
  test.each([true, false])("regrades a persisted report summary after restart (saved goal: %s)", async (saved) => {
    const f = fixture(saved)
    f.run.pr!.checks = "PENDING"
    await f.grading.gradeThread(f.t.id, report)
    const threads = new Threads(f.root)
    const restarted = makeGrading({ ...f.deps, threads })
    const t = threads.get(f.t.id)!
    const summary = restarted.gradesOf(t)[0]!.report
    expect(summary).toEqual({ status: "done", commit: report.commit })

    f.run.pr!.checks = "SUCCESS"
    await restarted.gradeThread(t.id, summary)
    await restarted.gradeThread(t.id, summary)
    const grades = new Threads(f.root).get(t.id)!.grades!
    expect(grades.map((g) => g.status)).toEqual(["unknown", "pass"])
    expect(grades[1]!.report).toEqual(summary)
    expect(f.approvals.list()).toHaveLength(0)
    expect(f.launches).toHaveLength(0)
  })

  test("a grade taken while checks are PENDING is superseded when they fail", async () => {
    const f = fixture()
    f.run.pr!.checks = "PENDING"
    await f.grading.gradeThread(f.t.id, report)
    await f.grading.regradePending()
    expect(f.grading.gradesOf(f.t)).toHaveLength(1)
    expect(f.grading.gradesOf(f.t)[0]).toMatchObject({ status: "unknown" })
    f.run.pr!.checks = "FAILURE"
    await f.grading.regradePending()
    const grades = f.grading.gradesOf(f.t)
    expect(grades.map((g) => g.status)).toEqual(["unknown", "fail"])
    expect(f.threads.get(f.t.id)?.improvement?.sourceKey).toBe(grades[1]!.key)
    await f.grading.regradePending()
    expect(f.grading.gradesOf(f.t)).toHaveLength(2)
  })

  test("an approved proposal left by a restart is retried, then launches", async () => {
    const f = fixture()
    f.write("benchmarks.json", '{"latency":30}')
    await f.grading.gradeThread(f.t.id, report)
    const p = f.threads.get(f.t.id)!.improvement!
    f.approvals.answer(p.approvalId, "Launch improvement run", null, null)
    const stale = { ...p, status: "approved" as const, approvedBy: "human" as const, attempts: 1 }
    f.threads.setMeta(f.t.id, { improvement: stale, improvements: [stale] })
    await f.grading.retryImprovements()
    expect(f.launches).toHaveLength(1)
    expect(f.threads.get(f.t.id)?.improvement).toMatchObject({ status: "launched", attempts: 2 })
  })
})

describe("human improvement retries", () => {
  test("older pending approvals still launch their own grade and concurrent answers do not double-launch", async () => {
    const f = fixture(false)
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, report)
    const older = f.answer()
    await f.grading.gradeThread(f.t.id, { ...report, commit: "new" })
    const latest = f.t.improvement!
    const unrelated = f.approvals.open({ threadId: "desk", title: "Other", summary: "", options: ["Yes"] })
    expect(f.grading.improvementAnswered(unrelated)).toBe(false)
    await f.grading.advanceImprovement(f.t, unrelated)
    await Promise.all([f.grading.advanceImprovement(f.t, older), f.grading.advanceImprovement(f.t, older)])
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]!.task).toContain(`\`${f.grading.gradesOf(f.t)[0]!.key}\``)
    expect(f.t.improvement).toEqual(latest)
    expect(f.t.improvements?.[0]).toMatchObject({ status: "launched", approvalId: older.id })
    const restored = new Threads(f.root)
    await makeGrading({ ...f.deps, threads: restored }).advanceImprovement(restored.get(f.t.id)!, older)
    expect(f.launches).toHaveLength(1)
    expect(f.grading.improvementAnswered(older)).toBe(true)
  })

  test("unreadable legacy retry policy blocks launching and records its reason", async () => {
    const f = fixture()
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, report)
    f.threads.setMeta(f.t.id, { goalSpec: undefined })
    writeFileSync(path.join(f.goals.dir, `${f.spec.id}.json`), "{")
    await f.grading.advanceImprovement(f.t, f.answer())
    expect(f.t.improvement!.lastError).toContain("improvement policy:")
    expect(f.launches).toHaveLength(0)
  })

  test("rejection after one failed launch is not exhaustion when a retry remains", async () => {
    const f = fixture()
    f.write("benchmarks.json", '{"latency":30}')
    await f.grading.gradeThread(f.t.id, report)
    expect(f.approvals.list()[0]!.title).toBe('Improve the Factory after a failed grade of "Keep latency low"')
    f.threads.setMeta(f.t.id, {
      improvement: { ...f.t.improvement!, status: "launch-failed", attempts: 1 },
      improvements: undefined,
    })
    await f.grading.advanceImprovement(f.t, f.answer("Reject"))
    expect(f.t.improvement!.status).toBe("rejected")
    expect(f.launches).toHaveLength(0)
  })
  test.each([false, true])("a failed launch retries to launched or exhausted (alwaysFail=%s)", async (alwaysFail) => {
    const f = fixture()
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, report)
    let attempts = 0
    const launch = f.deps.openConversation
    f.deps.openConversation = async (...args) => {
      attempts++
      const result = await launch(...args)
      return {
        ...result,
        sent: {
          sent: attempts === 1 || alwaysFail ? Promise.reject(new Error("delivery offline")) : Promise.resolve(),
        },
      }
    }
    await f.grading.advanceImprovement(f.t, f.approvals.get(f.t.improvement!.approvalId))
    expect(attempts).toBe(0)
    await f.grading.advanceImprovement(f.t, f.answer())
    expect(f.t.improvement).toMatchObject({
      status: "launch-failed",
      attempts: 1,
      approvedBy: "human",
      lastError: "delivery offline",
    })
    await f.grading.retryImprovements()
    await f.grading.retryImprovements()
    expect(attempts).toBe(2)
    expect(f.t.improvement).toMatchObject({
      status: alwaysFail ? "exhausted" : "launched",
      attempts: 2,
      launchedThreadId: alwaysFail ? null : "improvement-run",
    })
    expect(f.launches[0]).toMatchObject({
      folder: f.deps.factoryDir,
      meta: { improvementOf: f.t.id },
    })
    expect(f.launches[0]!.task).toContain(f.t.improvement!.sourceKey)
    expect(new Threads(f.root).get(f.t.id)?.improvement).toEqual(f.t.improvement)
  })

  test("non-human approvals cannot launch", async () => {
    const f = fixture()
    f.write("evidence.md", "AC-1: FAIL\n")
    await f.grading.gradeThread(f.t.id, report)
    await f.grading.advanceImprovement(f.t, f.answer("Launch improvement run", "goal runner"))
    expect(f.t.improvement?.status).toBe("rejected")
    expect(f.launches).toHaveLength(0)
  })
})
