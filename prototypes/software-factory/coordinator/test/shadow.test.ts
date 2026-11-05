import { expect, test } from "bun:test"
import type { Approval } from "../src/approvals.ts"
import { shadowStats, toShadow } from "../src/shadow.ts"

test("Jev option keys map back to option text", () => {
  expect(toShadow(["Approve", "Reject"], 0.8, { choice: "o1", confidence: 0.9, probabilities: { o0: 0.1, o1: 0.9 } })).toEqual({
    pick: "Reject",
    confidence: 0.9,
    covered: 0.8,
    probabilities: { Approve: 0.1, Reject: 0.9 },
  })
  expect(toShadow([], 0.2, undefined).pick).toBeNull()
})

test("stats count matches and the current streak; unscored decisions are skipped", () => {
  const a = (answer: string | null, pick: string | null) => ({ status: answer ? "answered" : "pending", answer, shadow: pick === null ? null : { pick } }) as Approval
  expect(shadowStats([a("A", "B"), a("A", "A"), a("B", null), a("B", "B"), a(null, "A")])).toEqual({ scored: 3, matched: 2, streak: 2 })
})
