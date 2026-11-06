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

  test("an edit's unified diff (detailedContent) goes after the short result, so the chat can draw it", () => {
    const diff = "\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n"
    const out = run([
      ev("tool.execution_start", { toolCallId: "e", toolName: "edit", arguments: {} }),
      ev("tool.execution_complete", { toolCallId: "e", success: true, result: { content: "File f updated.", detailedContent: diff } }),
      ev("tool.execution_start", { toolCallId: "v", toolName: "view", arguments: {} }),
      ev("tool.execution_complete", { toolCallId: "v", success: true, result: { content: "1. a", detailedContent: "1. a\n2. b" } }),
    ])
    const results = out.filter((e) => e.type === "TOOL_CALL_RESULT")
    expect(results[0].content).toBe(`File f updated.\n${diff}`)
    expect(results[1].content).toBe("1. a")
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

const sub = (type: string, agentId: string, data: Record<string, unknown>) => ({ type, agentId, data }) as never

describe("agui Translator: AG-UI 1.0 features", () => {
  test("a subagent is announced, shown as an activity card, and closed; its content stays out of the chat", () => {
    const out = run([
      sub("subagent.started", "s1", { toolCallId: "c1", agentName: "research", agentDisplayName: "Research", agentDescription: "finds", model: "m" }),
      sub("tool.execution_start", "s1", { toolCallId: "x", toolName: "grep" }),
      sub("assistant.message", "s1", { messageId: "m", content: "inner" }),
      sub("subagent.completed", "s1", { toolCallId: "c1", agentName: "research", agentDisplayName: "Research", totalToolCalls: 4, durationMs: 9 }),
    ])
    expect(out.map((e) => e.type)).toEqual(["SUBAGENT_STARTED", "ACTIVITY_SNAPSHOT", "ACTIVITY_SNAPSHOT", "SUBAGENT_FINISHED", "ACTIVITY_SNAPSHOT"])
    expect(out[0]).toMatchObject({ subagentRunId: "s1", name: "Research", description: "finds" })
    expect(out.at(-1)).toMatchObject({ messageId: "subagent-s1", activityType: "subagent", content: { status: "done", toolCalls: 4, durationMs: 9 } })
  })

  test("a failed subagent sends SUBAGENT_ERROR, not RUN_ERROR; one still running is closed before RUN_FINISHED", () => {
    const failed = run([
      sub("subagent.started", "s1", { agentDisplayName: "A" }),
      sub("subagent.failed", "s1", { agentDisplayName: "A", error: "boom" }),
    ])
    expect(failed.at(-2)).toMatchObject({ type: "SUBAGENT_ERROR", subagentRunId: "s1", message: "boom" })
    const open = run([sub("subagent.started", "s2", { agentDisplayName: "B" }), ev("session.idle", {})])
    expect(open.map((e) => e.type).slice(-3)).toEqual(["SUBAGENT_ERROR", "ACTIVITY_SNAPSHOT", "RUN_FINISHED"])
  })

  test("turns are steps, and RUN_FINISHED carries the run's token usage per model, subagents included", () => {
    const out = run([
      ev("assistant.turn_start", { turnId: "1" }),
      ev("assistant.usage", { model: "a", inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 }),
      sub("assistant.usage", "s1", { model: "a", inputTokens: 5, outputTokens: 1 }),
      ev("assistant.message", { messageId: "m", content: "hi" }),
      ev("assistant.turn_end", { turnId: "1" }),
      ev("session.idle", {}),
    ])
    expect(out.map((e) => e.type)).toEqual(["STEP_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "STEP_FINISHED", "RUN_FINISHED"])
    expect(out.at(-1).usage).toEqual([{ model: "a", inputTokens: 15, outputTokens: 3, totalTokens: 18, cachedInputTokens: 4, cacheWriteInputTokens: 0, reasoningTokens: 0 }])
    expect("outcome" in out.at(-1)).toBe(false)
  })

  test("an open decision ends the run with the interrupt outcome, only for a client that answers interrupts", () => {
    const events = [
      ev("tool.execution_start", { toolCallId: "c", toolName: "request_approval", arguments: { title: "Ship?", summary: "s", options: ["Yes", "No"] } }),
      ev("tool.execution_complete", { toolCallId: "c", success: true, result: { content: JSON.stringify({ id: "d1", status: "pending" }) } }),
      ev("session.idle", {}),
    ] as never[]
    const t = new Translator("t", "r", { interrupts: true, pending: () => true })
    const end = events.flatMap((e) => t.translate(e)).at(-1) as any
    expect(end.outcome).toMatchObject({ type: "interrupt", interrupts: [{ id: "d1", reason: "approval", message: "Ship?", toolCallId: "c", metadata: { options: ["Yes", "No"] } }] })
    expect((run(events).at(-1) as any).outcome).toBeUndefined()
    const answered = new Translator("t", "r", { interrupts: true, pending: () => false })
    expect((events.flatMap((e) => answered.translate(e)).at(-1) as any).outcome).toBeUndefined()
  })

  test("a stop ends the run with the cancelled outcome and closes open messages", () => {
    const out = run([ev("assistant.message_delta", { messageId: "m", deltaContent: "par" }), ev("abort", { reason: "user_initiated" }), ev("session.idle", {})])
    expect(out.map((e) => e.type)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"])
    expect(out.at(-1).outcome).toEqual({ type: "cancelled" })
  })

  test("a client tool call ends the run with it pending; its later completion is not sent again", () => {
    const t = new Translator("t", "r", { clientTool: (n) => n === "focus_agent" })
    const out = [ev("tool.execution_start", { toolCallId: "c", toolName: "focus_agent", arguments: { id: "w" } })].flatMap((e) => t.translate(e as never)) as any[]
    expect(out.map((e) => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"])
    expect(out.at(-1).outcome).toEqual({ type: "success", pendingToolCallIds: ["c"] })
    const next = new Translator("t", "r2")
    next.clientCalls.add("c")
    expect(next.translate(ev("tool.execution_complete", { toolCallId: "c", success: true, result: { content: "ok" } }))).toEqual([])
  })
})

describe("RunRecorder activity", () => {
  test("an activity card is saved once, with its last content", () => {
    const rec = new RunRecorder()
    rec.add({ type: "ACTIVITY_SNAPSHOT", messageId: "w", activityType: "worker", content: { status: "running" } })
    rec.add({ type: "TEXT_MESSAGE_CONTENT", delta: "hi" })
    rec.add({ type: "ACTIVITY_SNAPSHOT", messageId: "w", activityType: "worker", content: { status: "idle" } })
    expect(rec.messages()).toEqual([
      { id: "w", role: "activity", activityType: "worker", content: { status: "idle" } },
      expect.objectContaining({ role: "assistant", content: "hi" }),
    ])
  })
})
