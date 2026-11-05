import { expect, test } from "bun:test"
import { piEvents } from "../src/pi.ts"

test("Pi session events map to the Copilot event names the feed and UIs read", () => {
  const msg: any = {
    type: "message_end",
    message: { role: "assistant", responseId: "r1", stopReason: "error", errorMessage: "boom", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }] },
  }
  expect(piEvents(msg, "t").map((e) => [e.type, e.data])).toEqual([
    ["assistant.reasoning", { content: "hm" }],
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
