import { describe, expect, test } from "bun:test"
import { Translator } from "../src/agui.ts"
import { RunRecorder } from "../src/threads.ts"

const ev = (type: string, data: Record<string, unknown>) => ({ type, data }) as never
const run = (events: never[]) => {
  const t = new Translator("t", "r")
  return events.flatMap((e) => t.translate(e)) as any[]
}

describe("agui Translator", () => {
  test("a failed tool call sends its message as `error`; a success sends none", () => {
    const out = run([
      ev("tool.execution_start", { toolCallId: "a", toolName: "view", arguments: {} }),
      ev("tool.execution_complete", { toolCallId: "a", success: false, error: { message: "no such file" } }),
      ev("tool.execution_start", { toolCallId: "b", toolName: "view", arguments: {} }),
      ev("tool.execution_complete", { toolCallId: "b", success: true, result: { content: "ok" } }),
    ])
    const results = out.filter((e) => e.type === "TOOL_CALL_RESULT")
    expect(results[0]).toMatchObject({ toolCallId: "a", content: "no such file", error: "no such file" })
    expect("error" in results[1]).toBe(false)
  })

  test("streamed reasoning becomes one reasoning message, closed before the reply", () => {
    const out = run([
      ev("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "Let me " }),
      ev("assistant.reasoning_delta", { reasoningId: "r1", deltaContent: "think." }),
      ev("assistant.reasoning", { reasoningId: "r1", content: "Let me think." }),
      ev("assistant.message_delta", { messageId: "m1", deltaContent: "Hi" }),
    ])
    expect(out.map((e) => e.type)).toEqual([
      "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END", "REASONING_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
    ])
    expect(out.filter((e) => e.type === "REASONING_MESSAGE_CONTENT").map((e) => e.delta).join("")).toBe("Let me think.")
  })

  test("non-streamed reasoning is sent whole; empty reasoning sends nothing", () => {
    expect(run([ev("assistant.reasoning", { reasoningId: "r2", content: "" })])).toEqual([])
    const out = run([ev("assistant.reasoning", { reasoningId: "r3", content: "Plan." }), ev("session.idle", {})])
    expect(out.find((e) => e.type === "REASONING_MESSAGE_CONTENT")?.delta).toBe("Plan.")
    expect(out.map((e) => e.type)).toContain("REASONING_END")
  })

  test("sub-agent reasoning is skipped", () => {
    expect(run([ev("assistant.reasoning", { reasoningId: "r", content: "x", parentToolCallId: "p" })])).toEqual([])
  })
})

describe("RunRecorder", () => {
  test("saves reasoning before the reply and the tool error", () => {
    const t = new Translator("t", "r")
    const rec = new RunRecorder()
    const events = [
      ev("assistant.reasoning", { reasoningId: "r1", content: "Check the file." }),
      ev("tool.execution_start", { toolCallId: "a", toolName: "view", arguments: { path: "x" } }),
      ev("tool.execution_complete", { toolCallId: "a", success: false, error: { message: "missing" } }),
      ev("assistant.message", { messageId: "m", content: "It is missing." }),
    ]
    for (const e of events) for (const a of t.translate(e)) rec.add(a)
    const msgs = rec.messages()
    expect(msgs.map((m) => m.role)).toEqual(["reasoning", "assistant", "tool", "assistant"])
    expect(msgs[0]).toMatchObject({ content: "Check the file." })
    expect(msgs[2]).toMatchObject({ toolCallId: "a", error: "missing" })
  })
})
