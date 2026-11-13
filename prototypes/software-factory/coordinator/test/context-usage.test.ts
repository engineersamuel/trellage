import { expect, mock, test } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"

// A fake Claude query: yields the given messages and answers getContextUsage.
const messages: unknown[] = []
let asked = 0
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...sdk,
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    getContextUsage: async () => (asked++, { totalTokens: 42_000, maxTokens: 200_000 }),
    close() {},
  }),
}))
const { ClaudeSession } = await import("../src/claude.ts")

const assistant = (parent: string | null) => ({
  type: "assistant",
  uuid: "u",
  parent_tool_use_id: parent,
  message: { id: "m", content: [] },
})

test("a Claude session reports its context fill after main-loop model calls, as session.usage_info", async () => {
  messages.push(assistant("sub"), assistant(null))
  const out: { type: string; data: Record<string, unknown> }[] = []
  const session = new ClaudeSession({}, (ev) => out.push(ev))
  await new Promise((r) => setTimeout(r, 20))
  await session.disconnect()
  // The subagent's call does not count: its context is not the session's.
  expect(asked).toBe(1)
  expect(out.filter((e) => e.type === "session.usage_info").map((e) => e.data)).toEqual([
    { currentTokens: 42_000, tokenLimit: 200_000 },
  ])
})
