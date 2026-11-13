import { expect, test } from "bun:test"
import type { Decision } from "../approvals.ts"
import { pins } from "../pins.ts"
import type { TimelineEvent } from "../timeline.ts"

const ev = (seq: number, type: string, data: unknown): TimelineEvent => ({
  seq,
  workerId: "sub-1",
  type,
  timestamp: new Date(seq * 1000).toISOString(),
  data,
})
const call = (seq: number, id: string, name: string, args: unknown, result: unknown) => [
  ev(seq, "tool.execution_start", { toolCallId: id, toolName: name, arguments: args }),
  ev(seq + 1, "tool.execution_complete", {
    toolCallId: id,
    success: true,
    result: { content: JSON.stringify(result) },
  }),
]
const decision = (answer: string): Decision =>
  ({
    id: "d1",
    kind: "approval",
    threadId: "t",
    title: "Approve plan: X",
    summary: "",
    options: ["Approve", "Revise"],
    optionDetails: [],
    allowText: false,
    context: "",
    status: "answered",
    answer,
    note: null,
    createdAt: 1,
    answeredAt: 2,
    answeredBy: null,
    topic: "plan",
  }) as Decision

const evs = [
  ev(1, "user.message", { content: "Fix X<ui-format>noise</ui-format>" }),
  ...call(2, "p1", "sdlc_plan", { request: "r", plan: "First plan", criteria: ["a"] }, { gates: [] }),
  ...call(4, "a1", "request_approval", { topic: "plan", options: ["Approve", "Revise"] }, { id: "d1" }),
  ev(6, "user.message", {
    content: '[approval d1 answered] "Approve plan: X": Approve\nContinue the delivery loop accordingly.',
  }),
  ...call(7, "p2", "sdlc_plan", { request: "r", plan: "Second plan", criteria: ["a"] }, { gates: [] }),
]

test("the first message is the prompt; the plan an approval accepted wins over a newer one", () => {
  const p = pins(evs, [decision("Approve")])
  expect(p.prompt).toBe("Fix X")
  expect(p.plan?.accepted).toBe(true)
  expect(p.plan?.body).toContain("First plan")
})

test("the answer message alone is enough when the store does not list the decision", () => {
  expect(pins(evs, []).plan?.accepted).toBe(true)
})

test("an answer other than the first option leaves the newest plan, not accepted", () => {
  expect(pins(evs, [decision("Revise")]).plan).toEqual({
    body: expect.stringContaining("Second plan"),
    accepted: false,
  })
  expect(pins([], []).plan).toBeNull()
})
