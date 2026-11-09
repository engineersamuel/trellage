import { expect, test } from "bun:test"
import { markdown } from "../decisions.ts"
import { timeline, type TimelineEvent } from "../timeline.ts"
import events from "./fixtures/timeline-8963188e.json"
import decisions from "./fixtures/timeline-8963188e.decisions.json"

const decision = (extra: Record<string, unknown>) =>
  ({ id: "d1", kind: "approval", threadId: "t", title: "Approve plan: X", summary: "- do X", options: ["Approve", "Revise"], optionDetails: ["Implement", "Change it"], allowText: false, context: "c", status: "answered", answer: "Approve", note: null, createdAt: 1, answeredAt: 2, answeredBy: null, topic: "plan", ...extra }) as any
const ev = (seq: number, type: string, data: any): TimelineEvent => ({ seq, workerId: "sub-1", type, timestamp: new Date(seq * 1000).toISOString(), data })
const call = (seq: number, id: string, name: string, args: any, result: any, success = true) => [
  ev(seq, "tool.execution_start", { toolCallId: id, toolName: name, arguments: args }),
  ev(seq + 1, "tool.execution_complete", { toolCallId: id, success, result: { content: JSON.stringify(result) } }),
]

test("a recorded sub-coordinator run gives plan, approvals, workers, reviews, ship check and report in time order", () => {
  const ms = timeline(events as TimelineEvent[], decisions as any, () => undefined)
  const kinds = ms.map((m) => m.kind)
  expect(kinds[0]).toBe("plan")
  expect(kinds[1]).toBe("approval")
  expect(kinds.at(-1)).toBe("report")
  expect(kinds.filter((k) => k === "worker").length).toBe(7)
  expect(kinds).toContain("ship")
  expect(kinds).toContain("check")
  expect(kinds.filter((k) => k === "review").length).toBe(4)
  expect(kinds.filter((k) => k === "security").length).toBe(4)
  expect(ms.map((m) => m.at)).toEqual([...ms.map((m) => m.at)].sort((a, b) => a - b))
  // The plan text the agent passed to sdlc_plan is readable markdown, with criteria and Jev's gates.
  const plan = ms[0]!
  expect(plan.body).toContain("### Plan\n")
  expect(plan.body).toContain("### Acceptance criteria\n1. `mise.toml` pins process-compose")
  expect(plan.body).toContain("| testFirst | yes | 68% |")
  expect(markdown(plan.body)).toContain("<table>")
  // The recorded row predates answeredBy; its note names the goal runner, so it is marked auto.
  expect(ms[1]!.badge).toEqual({ text: "Auto · goal cpr-process-compose (policy plan=auto)", tone: "auto" })
  expect(ms[1]!.link).toEqual({ decision: "5ea8a9ed" })
})

test("a goal-policy answer is marked auto; older rows are recognised by their note", () => {
  const evs = call(1, "a1", "request_approval", { title: "Approve plan: X", topic: "plan" }, { id: "d1", status: "pending" })
  const auto = timeline(evs, [decision({ answeredBy: "goal cpr-x (policy plan=auto)" })], () => undefined)[0]!
  expect(auto.badge).toEqual({ text: "Auto · goal cpr-x (policy plan=auto)", tone: "auto" })
  expect(auto.title).toBe("Plan approval: Approve plan: X")
  expect(auto.body).toContain("- **Approve** (recommended) — Implement")
  expect(auto.body).toContain("### Answer\n**Approve** — Auto · goal cpr-x (policy plan=auto)")
  const old = timeline(evs, [decision({ answeredBy: null, note: "Answered by goal cpr-x (policy plan=auto)." })], () => undefined)[0]!
  expect(old.badge?.tone).toBe("auto")
  const waiting = timeline(evs, [decision({ status: "pending", answer: null, answeredAt: null })], () => undefined)[0]!
  expect(waiting.badge).toEqual({ text: "Waiting for you", tone: "pending" })
})

test("a failed call is no milestone; a running worker shows its live status and last message", () => {
  const evs = [
    ...call(1, "s1", "request_approval", { title: "Ship", ship: true }, "refused: blockers", false),
    ...call(5, "w0", "spawn_worker", { name: "early" }, { error: "code review is verifying in this worktree" }),
    ...call(3, "w1", "spawn_worker", { name: "impl", step: "implement", task: "Do X" }, { id: "w-1", model: "m1", status: "running" }),
  ]
  const ms = timeline(evs, [], (id) => (id === "w-1" ? { status: "idle", model: "m1", lastMessage: "Committed abc" } : undefined))
  expect(ms.map((m) => m.kind)).toEqual(["worker"])
  expect(ms[0]).toMatchObject({ title: "Worker · implement · impl", sub: "m1 · Committed abc", badge: { text: "idle", tone: "ok" }, link: { worker: "w-1" } })
  expect(ms[0]!.body).toContain("### Result\nCommitted abc")
})
