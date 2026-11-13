import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { stopReason, type Run } from "../../shared/goal.ts"
import {
  afterReport,
  childGoalId,
  goalLoopPrompt,
  goalVerdict,
  GoalStates,
  loopSessionId,
  madeProgress,
  newGoalState,
  type ReportFacts,
} from "../src/goalLoop.ts"

const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  at: 1,
  status: "blocked",
  summary: "s",
  gaps: [],
  commit: "c1",
  acs: { "AC-1": "pass", "AC-2": "fail" },
  acSource: "evaluator",
  pr: { url: "u", checks: "SUCCESS" },
  usd: 3,
  ...over,
})

test("done needs every AC passing and a green PR; pending checks wait; no PR or a fail is not done", () => {
  const all = { "AC-1": "pass", "AC-2": "pass" } as const
  expect(goalVerdict(all, { url: "u", checks: "SUCCESS" })).toBe("done")
  expect(goalVerdict(all, { url: "u", checks: "NONE" })).toBe("done")
  expect(goalVerdict(all, { url: "u", checks: "PENDING" })).toBe("checking")
  expect(goalVerdict(all, { url: "u", checks: "FAILURE" })).toBe("not-done")
  expect(goalVerdict(all, null)).toBe("not-done")
  expect(goalVerdict({ "AC-1": "pass", "AC-2": "missing" }, { url: "u", checks: "SUCCESS" })).toBe("not-done")
  expect(goalVerdict({}, { url: "u", checks: "SUCCESS" })).toBe("not-done")
})

test("a loop that is not done starts the next loop; done ends the goal", () => {
  const s = newGoalState("g", "t")
  const next = afterReport(s, facts())
  expect(next.decision).toEqual({ kind: "next-loop" })
  expect(next.state).toMatchObject({ status: "running", next: true, noProgress: 0 })
  expect(next.state.loops).toHaveLength(1)
  expect(next.state.loops[0]).toMatchObject({ n: 1, acPassed: 1, acTotal: 2, progress: true })
  const done = afterReport({ ...next.state, loop: 2 }, facts({ commit: "c2", acs: { "AC-1": "pass", "AC-2": "pass" } }))
  expect(done.decision).toEqual({ kind: "done" })
  expect(done.state.status).toBe("done")
})

test("two loops in a row without progress pause the goal; progress resets the count", () => {
  let s = afterReport(newGoalState("g", "t"), facts()).state
  s = afterReport({ ...s, loop: 2 }, facts()).state
  expect(s).toMatchObject({ noProgress: 1, next: true })
  const paused = afterReport({ ...s, loop: 3 }, facts())
  expect(paused.decision).toEqual({ kind: "no-progress" })
  expect(paused.state).toMatchObject({ status: "paused", noProgress: 2, next: false })
  const moved = afterReport({ ...s, loop: 3 }, facts({ commit: "c9" }))
  expect(moved.state.noProgress).toBe(0)
  expect(madeProgress([{ acPassed: 1, commit: "a" } as never], { acPassed: 2, commit: "a" })).toBe(true)
})

test("a factory defect and needs-decision stop the loop for the human", () => {
  const s = newGoalState("g", "t")
  expect(afterReport(s, facts({ factoryDefect: "spawn_worker drops the harness" })).decision).toEqual({
    kind: "factory-defect",
    defect: "spawn_worker drops the harness",
  })
  const wait = afterReport(s, facts({ status: "needs-decision" }))
  expect(wait.decision).toEqual({ kind: "wait-human" })
  expect(wait.state.next).toBe(false)
})

test("a repeated report of one loop does not count twice toward no progress", () => {
  let s = afterReport(newGoalState("g", "t"), facts()).state
  s = afterReport({ ...s, loop: 2 }, facts()).state
  expect(s.noProgress).toBe(1)
  // Loop 2 reports again (a retry inside it): still 1, not 2, so the goal does not pause.
  const again = afterReport(s, facts({ summary: "retry" }))
  expect(again.state.noProgress).toBe(1)
  expect(again.decision).toEqual({ kind: "next-loop" })
  // Loop 3 without progress is the second loop in a row: it pauses.
  expect(afterReport({ ...again.state, loop: 3 }, facts()).decision).toEqual({ kind: "no-progress" })
})

test("a repeated report of the same loop replaces its entry", () => {
  const s = afterReport(newGoalState("g", "t"), facts()).state
  const again = afterReport({ ...s, loop: 1 }, facts({ summary: "second" })).state
  expect(again.loops.map((l) => [l.n, l.summary])).toEqual([[1, "second"]])
})

test("loop sessions: loop 1 keeps the old id, later loops get a fresh one", () => {
  expect(loopSessionId("sub-1", 1)).toBe("sf-sub-1")
  expect(loopSessionId("sub-1", 3)).toBe("sf-sub-1-l3")
})

test("the handoff names the loop, the AC status, the PR, earlier loops and the human's direction", () => {
  const s = { ...afterReport(newGoalState("g", "t"), facts({ gaps: ["AC-2 stub"] })).state, loop: 2 }
  const text = goalLoopPrompt(s, { id: "g", prompt: "Build X", usd: 250 }, "try the other API")
  expect(text).toContain("[goal loop 2]")
  expect(text).toContain("Build X")
  expect(text).toContain("- AC-2: fail")
  expect(text).toContain("the independent evaluator")
  expect(text).toContain("u (checks SUCCESS)")
  expect(text).toContain("loop 1: blocked, 1/2 AC")
  expect(text).toContain("Gaps: AC-2 stub")
  expect(text).toContain("try the other API")
  expect(goalLoopPrompt(s, { id: "g", prompt: "p", usd: 1 })).not.toContain("Direction from the human")
  expect(text).toContain("may have changed things since")
  expect(text).not.toContain("Human decisions since")
  const decided = goalLoopPrompt(s, { id: "g", prompt: "p", usd: 1 }, undefined, [
    { title: "Fix main checkout?", answer: "Fixed; ship", note: "core.bare is false" },
  ])
  expect(decided).toContain("Human decisions since the last loop ended")
  expect(decided).toContain("- Fix main checkout?: Fixed; ship (note: core.bare is false)")
})

test("goal states persist per goal, found by thread and by open approval; child ids do not collide", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-gs-"))
  const a = new GoalStates(root)
  a.set({ ...newGoalState("g", "t1"), approvalId: "ap" })
  const b = new GoalStates(root)
  expect(b.get("g")?.threadId).toBe("t1")
  expect(b.byThread("t1")?.goalId).toBe("g")
  expect(b.byApproval("ap")?.goalId).toBe("g")
  expect(() => b.get("../x")).toThrow("bad goal id")
  expect(childGoalId("g", (id) => id === "g-fix-1")).toBe("g-fix-2")
})

test("a stopped goal ends the watch even while a question is open; a goal's blocked loop does not", () => {
  const run = {
    threadId: "t",
    status: "idle",
    branch: null,
    base: null,
    workers: [],
    steps: [],
    securityReviews: [],
    pr: null,
    sdlc: null,
    approvals: [{ id: "q", title: "merge?", topic: "other", status: "pending", answer: null, options: ["a"] }],
    report: { status: "blocked", summary: "x", gaps: [] },
  } as Run
  expect(stopReason({ ...run, goal: { ...newGoalState("g", "t"), status: "stopped", reason: "by you" } })).toEqual({
    code: 3,
    reason: "goal stopped: by you",
  })
  expect(stopReason({ ...run, approvals: [], goal: newGoalState("g", "t") })).toBeNull()
})
