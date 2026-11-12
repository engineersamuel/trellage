import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeStream, patchOf, toEvents, TurnTracker, type HarnessEvent } from "../src/claude.ts"

/** A partial SDK message as a fixture: tests build only the fields the mapper reads. */
const sdk = (m: object): SDKMessage => m as unknown as SDKMessage

const at = "t"
test("Claude SDK messages map to the Copilot event names the feed and UIs read", () => {
  const assistant = sdk({
    type: "assistant",
    uuid: "u1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
      ],
    },
  })
  expect(toEvents(assistant, at).map((e) => [e.type, e.data])).toEqual([
    ["assistant.message", { messageId: "u1:0", content: "hi" }],
    ["tool.execution_start", { toolCallId: "c1", toolName: "Bash", arguments: { command: "ls" } }],
  ])
  const result = sdk({
    type: "user",
    parent_tool_use_id: "task-1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: [{ type: "text", text: "no" }] }],
    },
  })
  expect(toEvents(result, at)).toEqual([
    {
      type: "tool.execution_complete",
      timestamp: at,
      agentId: "task-1",
      data: { toolCallId: "c1", success: false, result: { content: "no" } },
    },
  ])
  expect(toEvents(sdk({ type: "result", subtype: "success" }), at).map((e) => e.type)).toEqual(["session.idle"])
  expect(
    toEvents(sdk({ type: "result", subtype: "error_max_turns", errors: [] }), at).map((e) => [e.type, e.data]),
  ).toEqual([
    ["session.error", { message: "error_max_turns" }],
    ["session.idle", {}],
  ])
})

test("the Claude gate denies merge, push and delete, and allows other tools", async () => {
  const { claudeGate } = await import("../src/claude.ts")
  const opts = { signal: new AbortController().signal, toolUseID: "x" } as Parameters<
    typeof import("../src/claude.ts").claudeGate
  >[2]
  expect((await claudeGate("Bash", { command: "git push origin main" }, opts))!.behavior).toBe("deny")
  expect((await claudeGate("Bash", { command: "cd x && git worktree remove y" }, opts))!.behavior).toBe("deny")
  expect(await claudeGate("Bash", { command: "git status" }, opts)).toEqual({
    behavior: "allow",
    updatedInput: { command: "git status" },
  })
  expect((await claudeGate("Edit", { file_path: "a" }, opts))!.behavior).toBe("allow")
})

test("the Claude init message reports skills, MCP servers and plugins like the Copilot runtime", () => {
  const init = sdk({
    type: "system",
    subtype: "init",
    cwd: "/wt",
    skills: ["six-hats:decide"],
    mcp_servers: [{ name: "ctx", status: "connected" }],
    plugins: [{ name: "six-hats", path: "/p" }],
  })
  expect(toEvents(init, "t").map((e) => [e.type, e.data])).toEqual([
    ["session.start", { context: { cwd: "/wt" } }],
    ["session.skills_loaded", { skills: [{ name: "six-hats:decide", source: "claude", enabled: true }] }],
    ["session.mcp_servers_loaded", { servers: [{ name: "ctx", status: "connected", source: null }] }],
    ["session.plugins_loaded", { plugins: ["six-hats"] }],
  ])
})

test("a turn that ends with background subagents running stays busy until they finish and the session resumes", () => {
  const t = new TurnTracker()
  t.busy = true
  const idle = [{ type: "session.idle", timestamp: "t", data: {} }]
  const say = (text: string) => [{ type: "assistant.message", timestamp: "t", data: { content: text } }]
  t.map(sdk({ type: "system", subtype: "task_started", task_id: "white" }), [])
  // The turn ends while the white hat runs: no idle.
  expect(t.map(sdk({ type: "result" }), idle, "t").map((e: HarnessEvent) => e.type)).toEqual(["session.info"])
  expect(t.busy).toBe(true)
  // The white hat finishes; the session resumes on its own and ends cleanly.
  t.map(sdk({ type: "system", subtype: "task_notification", task_id: "white", status: "completed" }), [])
  expect(t.map(sdk({ type: "assistant" }), say("hat done"), "t").map((e: HarnessEvent) => e.type)).toEqual([
    "assistant.message",
  ])
  expect(t.map(sdk({ type: "result" }), idle, "t").map((e: HarnessEvent) => e.type)).toEqual(["session.idle"])
  expect(t.busy).toBe(false)
  // A later self-resume from idle starts a new turn.
  expect(t.map(sdk({ type: "assistant" }), say("more"), "t").map((e: HarnessEvent) => e.type)).toEqual([
    "assistant.turn_start",
    "assistant.message",
  ])
})

test("Claude text and thinking stream as deltas; the full message reuses their ids", () => {
  const s = new ClaudeStream()
  const se = (event: unknown) => sdk({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u" })
  s.map(se({ type: "message_start", message: { id: "msg1" } }), at)
  s.map(se({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }), at)
  const think = s.map(
    se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }),
    at,
  )
  s.map(se({ type: "content_block_stop", index: 0 }), at)
  s.map(se({ type: "content_block_start", index: 1, content_block: { type: "text" } }), at)
  const text = s.map(se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } }), at)
  s.map(se({ type: "content_block_stop", index: 1 }), at)
  expect(think.map((e) => [e.type, e.data])).toEqual([
    ["assistant.reasoning_delta", { reasoningId: "msg1:0", deltaContent: "hm" }],
  ])
  expect(text.map((e) => [e.type, e.data])).toEqual([
    ["assistant.message_delta", { messageId: "msg1:1", deltaContent: "hi" }],
  ])
  const full = sdk({
    type: "assistant",
    uuid: "u2",
    parent_tool_use_id: null,
    message: {
      id: "msg1",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "hi" },
      ],
    },
  })
  expect(s.map(full, at).map((e) => e.data)).toEqual([
    { content: "hm", reasoningId: "msg1:0" },
    { messageId: "msg1:1", content: "hi" },
  ])
})

test("patchOf: Claude Edit/Write structuredPatch becomes a unified diff", () => {
  const patch = patchOf({
    type: "update",
    filePath: "/r/a.ts",
    structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [" x", "-a", "+b"] }],
  })
  expect(patch).toBe("--- a//r/a.ts\n+++ b//r/a.ts\n@@ -3,2 +3,2 @@\n x\n-a\n+b")
  expect(
    patchOf({
      type: "create",
      filePath: "/n",
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+1"] }],
    }),
  ).toStartWith("--- /dev/null\n")
  expect(patchOf({ filePath: "/r", structuredPatch: [] })).toBeUndefined()
  const msg = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "c", content: "ok" }] },
    tool_use_result: {
      filePath: "/r",
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    },
  }
  expect((toEvents(sdk(msg), "t")[0]!.data.result as { detailedContent: string }).detailedContent).toContain(
    "@@ -1,1 +1,1 @@",
  )
})

test("Claude tool_use input streams as tool_call_delta", () => {
  const s = new ClaudeStream()
  const se = (event: unknown) =>
    sdk({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" })
  s.map(se({ type: "message_start", message: { id: "m1" } }))
  s.map(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "Write" } }))
  const out = s.map(
    se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a' } }),
    "t",
  )
  expect(out).toEqual([
    {
      type: "assistant.tool_call_delta",
      timestamp: "t",
      data: { toolCallId: "tu1", toolName: "Write", inputDelta: '{"file_path":"a' },
    },
  ])
  s.map(se({ type: "content_block_stop", index: 0 }))
  expect(
    s.map(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "x" } })),
  ).toEqual([])
})

test("Claude Skill tool use is a skill.invoked event", () => {
  const m = sdk({
    type: "assistant",
    uuid: "u",
    parent_tool_use_id: null,
    message: {
      id: "m",
      content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "factory-step:ub-mode" } }],
    },
  })
  expect(toEvents(m, "t").map((e) => [e.type, e.data.name ?? e.data.toolName])).toEqual([
    ["tool.execution_start", "Skill"],
    ["skill.invoked", "ub-mode"],
  ])
})
