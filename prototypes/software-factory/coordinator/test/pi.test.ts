import { expect, test } from "bun:test"
import { piEvents } from "../src/pi.ts"

test("Pi session events map to the Copilot event names the feed and UIs read", () => {
  const msg: any = {
    type: "message_end",
    message: { role: "assistant", responseId: "r1", stopReason: "error", errorMessage: "boom", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }] },
  }
  expect(piEvents(msg, "t").map((e) => [e.type, e.data])).toEqual([
    ["assistant.reasoning", { reasoningId: "r1:0", content: "hm" }],
    ["assistant.message", { messageId: "r1:1", content: "hi" }],
    ["session.error", { message: "boom" }],
  ])
  expect(piEvents({ type: "message_end", message: { role: "user", content: [] } } as any, "t")).toEqual([])
  expect(piEvents({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "ls" }, parentToolCallId: "p" } as any, "t")).toEqual([
    { type: "tool.execution_start", timestamp: "t", agentId: "p", data: { toolCallId: "c", toolName: "bash", arguments: { command: "ls" } } },
  ])
  expect(piEvents({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "no" }] } } as any, "t")[0]!.data).toEqual({
    toolCallId: "c",
    success: false,
    result: { content: "no" },
  })
  expect(piEvents({ type: "agent_settled", aborted: false } as any, "t").map((e) => e.type)).toEqual(["session.idle"])
})

test("Pi text and thinking stream as deltas with the ids of the final message", () => {
  const m = { role: "assistant", timestamp: 7, content: [] }
  const upd = (a: unknown) => piEvents({ type: "message_update", message: m, assistantMessageEvent: a } as any, "t")
  expect(upd({ type: "text_delta", contentIndex: 1, delta: "he" })[0]!.data).toEqual({ messageId: "7:1", deltaContent: "he" })
  expect(upd({ type: "thinking_delta", contentIndex: 0, delta: "hm" })[0]!.data).toEqual({ reasoningId: "7:0", deltaContent: "hm" })
  const end = piEvents({ type: "message_end", message: { ...m, content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hey" }] } } as any, "t")
  expect(end.map((e) => e.data)).toEqual([{ reasoningId: "7:0", content: "hm" }, { messageId: "7:1", content: "hey" }])
})
