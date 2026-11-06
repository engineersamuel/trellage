import { describe, expect, test } from "bun:test"
import { toReview, toRun } from "../src/genui/Cards"

const finding = (title: string, severity: string, verdict: string) => ({ id: title, title, severity, file: "a.ts", verdict, reason: `${verdict} because` })

describe("genui/Cards view models", () => {
  test("security review: kept first, then by severity; counts", () => {
    const v = toReview({ id: "sr", status: "done", model: "m", findings: [finding("low kept", "low", "keep"), finding("high fp", "high", "false_positive"), finding("crit kept", "critical", "keep")] } as never)
    expect(v.rows.map((r) => r.title)).toEqual(["crit kept", "low kept", "high fp"])
    expect([v.kept, v.discarded, v.statusVariant, v.rows[0]!.variant]).toEqual([2, 1, "success", "danger"])
  })
  test("delivery run: steps only, last moreWork wins, at most 6", () => {
    const ds = [{ selected: ["x"], request: "fan" }, ...Array.from({ length: 7 }, (_, i) => ({ step: `s${i}`, confidence: 0.5, moreWork: 1 - i / 10, request: "r" }))] as never
    const v = toRun("b", ds)
    expect([v.steps.length, v.steps[0]!.step, v.moreWork, v.branch]).toEqual([6, "s1", 0.4, "b"])
  })
  test("delivery run: no decisions", () => {
    expect(toRun(null, [])).toEqual({ branch: null, moreWork: null, steps: [] })
  })
})
