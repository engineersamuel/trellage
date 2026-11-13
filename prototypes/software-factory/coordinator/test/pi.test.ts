import { expect, test } from "bun:test"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { piContext, piEvents, withProxyModel } from "../src/pi.ts"

/** Test fixtures carry only the fields the mapping reads. */
const E = (x: unknown) => x as AgentSessionEvent

test("Pi session events map to the Copilot event names the feed and UIs read", () => {
  const msg = E({
    type: "message_end",
    message: {
      role: "assistant",
      responseId: "r1",
      stopReason: "error",
      errorMessage: "boom",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "hi" },
      ],
    },
  })
  expect(piEvents(msg, "t").map((e) => [e.type, e.data])).toEqual([
    ["assistant.reasoning", { reasoningId: "r1:0", content: "hm" }],
    ["assistant.message", { messageId: "r1:1", content: "hi" }],
    ["session.error", { message: "boom" }],
  ])
  expect(piEvents(E({ type: "message_end", message: { role: "user", content: [] } }), "t")).toEqual([])
  expect(
    piEvents(
      E({
        type: "tool_execution_start",
        toolCallId: "c",
        toolName: "bash",
        args: { command: "ls" },
        parentToolCallId: "p",
      }),
      "t",
    ),
  ).toEqual([
    {
      type: "tool.execution_start",
      timestamp: "t",
      agentId: "p",
      data: { toolCallId: "c", toolName: "bash", arguments: { command: "ls" } },
    },
  ])
  expect(
    piEvents(
      E({
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "no" }] },
      }),
      "t",
    )[0]!.data,
  ).toEqual({
    toolCallId: "c",
    success: false,
    result: { content: "no" },
  })
  expect(piEvents(E({ type: "agent_settled", aborted: false }), "t").map((e) => e.type)).toEqual(["session.idle"])
})

test("Pi text and thinking stream as deltas with the ids of the final message", () => {
  const m = { role: "assistant", timestamp: 7, content: [] }
  const upd = (a: unknown) => piEvents(E({ type: "message_update", message: m, assistantMessageEvent: a }), "t")
  expect(upd({ type: "text_delta", contentIndex: 1, delta: "he" })[0]!.data).toEqual({
    messageId: "7:1",
    deltaContent: "he",
  })
  expect(upd({ type: "thinking_delta", contentIndex: 0, delta: "hm" })[0]!.data).toEqual({
    reasoningId: "7:0",
    deltaContent: "hm",
  })
  const end = piEvents(
    E({
      type: "message_end",
      message: {
        ...m,
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "hey" },
        ],
      },
    }),
    "t",
  )
  expect(end.map((e) => e.data)).toEqual([
    { reasoningId: "7:0", content: "hm" },
    { messageId: "7:1", content: "hey" },
  ])
})

test("Pi skill use is skill.invoked: a read of a loaded SKILL.md, or a /skill:name prompt", () => {
  const skills = [{ name: "ub-mode", filePath: "/h/skills/ub-mode/SKILL.md" }]
  const read = (p: string) =>
    piEvents(
      E({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: p } }),
      "t",
      skills,
      "/h",
    ).map((e) => [e.type, e.data.name])
  expect(read("/h/skills/ub-mode/SKILL.md")).toEqual([
    ["tool.execution_start", undefined],
    ["skill.invoked", "ub-mode"],
  ])
  expect(read("skills/ub-mode/SKILL.md")).toEqual([
    ["tool.execution_start", undefined],
    ["skill.invoked", "ub-mode"],
  ])
  expect(read("/h/skills/ub-mode/notes.md")).toEqual([["tool.execution_start", undefined]])
  const user = (text: string) =>
    piEvents(E({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } }), "t", skills)
  expect(
    user('<skill name="ub-mode" location="/h/skills/ub-mode/SKILL.md">\nbody\n</skill>\n\ndo it').map((e) => [
      e.type,
      e.data,
    ]),
  ).toEqual([["skill.invoked", { name: "ub-mode" }]])
  expect(user("plain prompt")).toEqual([])
})

test("withProxyModel adds a model id to the proxy provider in a worker-owned copy", () => {
  const { mkdtempSync, writeFileSync, readFileSync } = require("node:fs")
  const { tmpdir } = require("node:os")
  const path = require("node:path")
  const dir = mkdtempSync(path.join(tmpdir(), "sf-pi-agent-"))
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "copilot-proxy-rs": {
          baseUrl: "http://x/v1",
          api: "openai-responses",
          models: [{ id: "gpt-6-astra", name: "GPT", reasoning: true }],
        },
      },
    }),
  )
  const launch = {
    agentDir: dir,
    skills: [],
    extensions: [],
    provider: "copilot-proxy-rs",
    model: "gpt-6-astra",
    thinking: "",
  }
  const dest = path.join(mkdtempSync(path.join(tmpdir(), "sf-pi-dest-")), "a")
  const out = withProxyModel(launch, "gemini-4-argon", dest)
  expect(out.agentDir).toBe(dest)
  expect(out.model).toBe("gemini-4-argon")
  expect(
    JSON.parse(readFileSync(path.join(dest, "models.json"), "utf8")).providers["copilot-proxy-rs"].models.map(
      (m: { id: string }) => m.id,
    ),
  ).toEqual(["gpt-6-astra", "gemini-4-argon"])
  // The shared composed dir is untouched; a listed model needs no copy.
  expect(
    JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8")).providers["copilot-proxy-rs"].models,
  ).toHaveLength(1)
  expect(withProxyModel(launch, "gpt-6-astra", dest).agentDir).toBe(dir)
})

test("a Pi session reports its context fill after each model call, as session.usage_info", () => {
  const end = (role: string) => E({ type: "message_end", message: { role, content: [] } })
  const usage = (tokens: number | null) => () => ({ tokens, contextWindow: 128_000 })
  expect(piContext(end("assistant"), usage(9_000), "t")).toEqual([
    { type: "session.usage_info", timestamp: "t", data: { currentTokens: 9_000, tokenLimit: 128_000 } },
  ])
  // Unknown right after a compaction; a user message is not a model call.
  expect(piContext(end("assistant"), usage(null), "t")).toEqual([])
  expect(piContext(end("user"), usage(9_000), "t")).toEqual([])
})
