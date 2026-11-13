import { expect, test } from "bun:test"
import { GoalBudgets, nextLimits, pauseApproval, readAnswer, raiseOption, shouldPause, STOP } from "../src/budget.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { decodeGoalOrThrow } from "../src/goals.ts"
import { draftToSpec, specToDraft, splitPending, stopReason, type Run } from "../../shared/goal.ts"

test("a goal run pauses once, only while it works and at or above its limit", () => {
  const b = { limitUsd: 250, status: "ok" as const }
  expect(shouldPause(b, 250, true)).toBe(true)
  expect(shouldPause(b, 249.99, true)).toBe(false)
  expect(shouldPause(b, 400, false)).toBe(false)
  expect(shouldPause({ ...b, status: "paused" }, 400, true)).toBe(false)
  expect(shouldPause({ ...b, status: "stopped" }, 400, true)).toBe(false)
})

test("the pause offers higher limits above the spend, and stop", () => {
  expect(nextLimits(250, 252)).toEqual([500, 1000])
  expect(nextLimits(250, 700)).toEqual([800, 1000])
  expect(nextLimits(0.01, 0.49)).toEqual([0.54, 0.98, 2])
  const card = pauseApproval("demo", { limitUsd: 250, status: "ok" }, 252.4, 3)
  expect(card.options).toEqual([raiseOption(500), raiseOption(1000), STOP])
  expect(card.optionDetails).toHaveLength(3)
  expect(card.allowText).toBe(true)
  expect(card.summary).toContain("Goal demo has spent about $252.40 over 3 runs (limit $250 for the whole goal)")
})

test("the human's answer: an offered option, a typed amount above the spend, or stop", () => {
  expect(readAnswer(raiseOption(500), 252)).toEqual({ kind: "raise", limitUsd: 500 })
  expect(readAnswer("$1,200", 252)).toEqual({ kind: "raise", limitUsd: 1200 })
  expect(readAnswer("600", 252)).toEqual({ kind: "raise", limitUsd: 600 })
  expect(readAnswer(STOP, 252)).toEqual({ kind: "stop" })
  expect(readAnswer("stop please", 252)).toEqual({ kind: "stop" })
  expect(readAnswer("200", 252).kind).toBe("invalid")
  expect(readAnswer("more", 252).kind).toBe("invalid")
})

const run = (over: Partial<Run>): Run => ({
  threadId: "t",
  status: "idle",
  branch: null,
  base: null,
  workers: [],
  steps: [],
  approvals: [],
  securityReviews: [],
  report: null,
  pr: null,
  sdlc: null,
  ...over,
})

test("a budget pause is always the human's: the runner never auto-answers it, and a stop ends the watch", () => {
  const policy = { plan: "auto", findings: "auto", ship: "auto", other: "auto" } as const
  const r = run({
    approvals: [{ id: "a", title: "Cost limit", topic: "budget", status: "pending", answer: null, options: ["x"] }],
  })
  expect(splitPending(r, policy).auto).toEqual([])
  expect(stopReason(r, policy)?.code).toBe(2)
  const stopped = run({ budget: { limitUsd: 250, spentUsd: 251, runUsd: 40, status: "stopped" } })
  expect(stopReason(stopped, policy)).toEqual({
    code: 3,
    reason: "goal stopped by the human at its cost limit ($251.00 spent by all its runs)",
  })
})

test("goal specs: $250 by default, no time limit; old minutesPerRun is ignored; the form round-trips the limit", () => {
  const spec = decodeGoalOrThrow({ id: "demo", repo: "/r", prompt: "p", limits: { runs: 3, minutesPerRun: 60 } })
  expect(spec.limits).toEqual({ usd: 250 })
  const draft = { ...specToDraft({ ...spec, limits: { usd: 400 } }) }
  expect(draft.usd).toBe("400")
  const ok = draftToSpec({ ...draft, usd: "$90.5" })
  expect(ok.ok && ok.spec.limits.usd).toBe(90.5)
  const bad = draftToSpec({ ...draft, usd: "0" })
  expect(!bad.ok && bad.problems).toContain("cost limit must be a number of dollars above 0")
})

test("the goal's budget: the spec limit, or the human's raised limit when higher; it survives a reload", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-gb-"))
  const a = new GoalBudgets(root)
  expect(a.get("g", 250)).toEqual({ limitUsd: 250, status: "ok" })
  a.set("g", { limitUsd: 600, status: "paused", approvalId: "ap1" })
  const b = new GoalBudgets(root)
  expect(b.get("g", 250)).toMatchObject({ limitUsd: 600, status: "paused" })
  // The human edited the spec to a higher limit: the spec wins.
  expect(b.get("g", 900).limitUsd).toBe(900)
  expect(b.byApproval("ap1")).toBe("g")
  expect(b.byApproval("nope")).toBeUndefined()
})
