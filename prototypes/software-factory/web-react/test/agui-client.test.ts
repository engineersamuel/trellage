import { describe, expect, test } from "bun:test"
import { subagentLine } from "../src/chat/ActivityCards"
import { coverInterrupts, interruptsOf } from "../src/state/chat"

describe("coverInterrupts", () => {
  test("answers open interrupts, abandons the unanswered, drops answers to closed ones", () => {
    const resume = [
      { interruptId: "a", status: "resolved" as const, payload: { answer: "Yes" } },
      { interruptId: "gone", status: "resolved" as const, payload: { answer: "No" } },
    ]
    expect(coverInterrupts(["a", "b"], resume)).toEqual([
      { interruptId: "a", status: "resolved", payload: { answer: "Yes" } },
      { interruptId: "b", status: "cancelled" },
    ])
    expect(coverInterrupts([], resume)).toEqual([])
  })
})

describe("subagentLine", () => {
  test("model, tool calls, time and tokens; missing parts are left out", () => {
    expect(subagentLine({ name: "r", status: "done", model: "m", toolCalls: 1, durationMs: 2500, totalTokens: 40_200 })).toBe("m · 1 tool call · 2.5 s · 40k tokens")
    expect(subagentLine({ name: "r", status: "running" })).toBe("")
  })
})

describe("interruptsOf", () => {
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })
  const msgs = (result: string) => [
    { id: "u", role: "user" as const, content: "hi" },
    { id: "a", role: "assistant" as const, content: "", toolCalls: [call("c1", "ask_user", { title: "Pick" }), call("c2", "view", {})] },
    { id: "t1", role: "tool" as const, toolCallId: "c1", content: result },
    { id: "t2", role: "tool" as const, toolCallId: "c2", content: "x" },
  ]
  test("the last run's open decision is restored as an interrupt", () => {
    expect(interruptsOf(msgs(JSON.stringify({ id: "d1", status: "pending" })), () => true)).toEqual([{ id: "d1", reason: "question", toolCallId: "c1", message: "Pick" }])
  })
  test("answered, failed, or older decisions are not", () => {
    expect(interruptsOf(msgs(JSON.stringify({ id: "d1", status: "pending" })), () => false)).toEqual([])
    expect(interruptsOf(msgs("not json"), () => true)).toEqual([])
    expect(interruptsOf([...msgs(JSON.stringify({ id: "d1", status: "pending" })), { id: "u2", role: "user", content: "next" }], () => true)).toEqual([])
  })
})
