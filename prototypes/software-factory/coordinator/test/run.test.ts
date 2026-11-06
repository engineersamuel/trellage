import { describe, expect, test } from "bun:test"
import { checksState, runWorkers, stopReason, unmet, type Run } from "../src/run.ts"

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
    expect(checksState([{ state: "SUCCESS" }])).toBe("SUCCESS")
  })
})

describe("unmet", () => {
  const run: Run = {
    threadId: "t",
    status: "idle",
    branch: "factory/x",
    base: null,
    workers: [],
    steps: ["implement", "verify"],
    approvals: [],
    securityReviews: [],
    report: null,
    pr: { number: 7, url: "u", state: "OPEN", head: "h", checks: "PENDING" },
  }
  test("lists missing steps and PR mismatches", () => {
    expect(unmet(run, { steps: ["implement", "finish"], pr: { state: "OPEN", checks: "SUCCESS" } })).toEqual([
      "step finish never ran",
      "PR #7 checks PENDING, expected SUCCESS",
    ])
  })
  test("met expectation and missing PR", () => {
    expect(unmet(run, { steps: ["verify"], pr: { state: "OPEN" } })).toEqual([])
    expect(unmet({ ...run, pr: null }, { pr: { state: "OPEN" } })).toEqual(["no PR for the branch"])
  })
  test("stops early on a pending decision or a blocked report", () => {
    expect(stopReason(run)).toBeNull()
    expect(stopReason({ ...run, approvals: [{ id: "a1", title: "Ship?", status: "pending", answer: null }] })?.code).toBe(2)
    expect(stopReason({ ...run, report: { status: "blocked", summary: "tests fail", gaps: [] } })).toEqual({ code: 3, reason: "reported blocked: tests fail" })
    expect(stopReason({ ...run, report: { status: "done", summary: "ok", gaps: [] } })).toBeNull()
  })
})
