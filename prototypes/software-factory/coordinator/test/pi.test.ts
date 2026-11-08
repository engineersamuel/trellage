import { expect, test } from "bun:test"
import { piEvents, withProxyModel } from "../src/pi.ts"

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

test("Pi skill use is skill.invoked: a read of a loaded SKILL.md, or a /skill:name prompt", () => {
  const skills = [{ name: "ub-mode", filePath: "/h/skills/ub-mode/SKILL.md" }]
  const read = (p: string) =>
    piEvents({ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: p } } as any, "t", skills, "/h").map((e) => [e.type, e.data.name])
  expect(read("/h/skills/ub-mode/SKILL.md")).toEqual([["tool.execution_start", undefined], ["skill.invoked", "ub-mode"]])
  expect(read("skills/ub-mode/SKILL.md")).toEqual([["tool.execution_start", undefined], ["skill.invoked", "ub-mode"]])
  expect(read("/h/skills/ub-mode/notes.md")).toEqual([["tool.execution_start", undefined]])
  const user = (text: string) => piEvents({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } } as any, "t", skills)
  expect(user('<skill name="ub-mode" location="/h/skills/ub-mode/SKILL.md">\nbody\n</skill>\n\ndo it').map((e) => [e.type, e.data])).toEqual([["skill.invoked", { name: "ub-mode" }]])
  expect(user("plain prompt")).toEqual([])
})

test("withProxyModel adds a model id to the proxy provider in a worker-owned copy", () => {
  const { mkdtempSync, writeFileSync, readFileSync } = require("node:fs")
  const { tmpdir } = require("node:os")
  const path = require("node:path")
  const dir = mkdtempSync(path.join(tmpdir(), "sf-pi-agent-"))
  writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { "copilot-proxy-rs": { baseUrl: "http://x/v1", api: "openai-responses", models: [{ id: "gpt-6-astra", name: "GPT", reasoning: true }] } } }))
  const launch = { agentDir: dir, skills: [], extensions: [], provider: "copilot-proxy-rs", model: "gpt-6-astra", thinking: "" }
  const dest = path.join(mkdtempSync(path.join(tmpdir(), "sf-pi-dest-")), "a")
  const out = withProxyModel(launch, "gemini-4-argon", dest)
  expect(out.agentDir).toBe(dest)
  expect(out.model).toBe("gemini-4-argon")
  expect(JSON.parse(readFileSync(path.join(dest, "models.json"), "utf8")).providers["copilot-proxy-rs"].models.map((m: any) => m.id)).toEqual(["gpt-6-astra", "gemini-4-argon"])
  // The shared composed dir is untouched; a listed model needs no copy.
  expect(JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8")).providers["copilot-proxy-rs"].models).toHaveLength(1)
  expect(withProxyModel(launch, "gpt-6-astra", dest).agentDir).toBe(dir)
})
