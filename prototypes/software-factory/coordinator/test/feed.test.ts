import { expect, test } from "bun:test"
import { appendCompact } from "../../shared/feed.ts"

test("streaming fragments are dropped once complete, so the first message survives the cap", () => {
  const log: { type: string; data: any }[] = []
  const add = (type: string, data: any = {}) => appendCompact(log, { type, data }, 5)
  add("user.message", { content: "task" })
  for (let i = 0; i < 50; i++) add("assistant.streaming_delta")
  add("assistant.reasoning_delta", { reasoningId: "r" })
  add("assistant.reasoning", { reasoningId: "r" })
  add("assistant.message_delta", { messageId: "m" })
  add("assistant.message", { messageId: "m" })
  for (let i = 0; i < 30; i++) add("assistant.tool_call_delta", { toolCallId: "c1" })
  add("tool.execution_start", { toolCallId: "c1" })
  expect(log.map((e) => e.type)).toEqual(["user.message", "assistant.reasoning", "assistant.message", "tool.execution_start"])
})
