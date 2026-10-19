import { describe, expect, it, vi } from "vitest"
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk"
import stringWidth from "string-width"
import {
  runGuideOptimizeSdk,
  updateGuideOptimizeLog,
  type GuideOptimizeActivity,
  type GuideOptimizeSdkSession,
} from "../src/guide-optimize.ts"
import { guideOptimizeDisplayLines } from "../src/guide-optimize-ui.tsx"

const metadata = { id: "event", parentId: null, timestamp: "2026-10-19T13:00:00Z" }
const run = async (events: ReadonlyArray<SessionEvent>) => {
  let handler: (event: SessionEvent) => void = () => {}
  let log: ReadonlyArray<GuideOptimizeActivity> = []
  const activity: GuideOptimizeActivity[] = []
  const session: GuideOptimizeSdkSession = {
    on: (listener) => { handler = listener; return () => {} },
    sendAndWait: async () => { for (const event of events) handler(event) },
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
  const client = {
    start: vi.fn(async () => {}),
    createSession: vi.fn(async (_config: SessionConfig) => session),
    stop: vi.fn(async () => []),
  }
  await runGuideOptimizeSdk({
    cwd: "/repository", prompt: "Optimize", model: { model: "gpt-5", effort: "medium" },
    signal: new AbortController().signal, clientFactory: () => client,
    onActivity: (entry) => { activity.push(entry); log = updateGuideOptimizeLog(log, entry) },
  })
  return { log, activity, client, session }
}

describe("Optimize SDK output", () => {
  it("streams messages and parallel tool output, then replaces final content without duplicates", async () => {
    const result = await run([
      { ...metadata, type: "assistant.message_delta", ephemeral: true, data: { messageId: "message", deltaContent: "Reading " } },
      { ...metadata, type: "assistant.message_delta", ephemeral: true, data: { messageId: "message", deltaContent: "the repository." } },
      { ...metadata, type: "assistant.message", data: { messageId: "message", content: "Reading the repository." } },
      { ...metadata, type: "tool.execution_start", data: { toolCallId: "shell", toolName: "bash", arguments: { command: "git status" } } },
      { ...metadata, type: "tool.execution_start", data: { toolCallId: "read", toolName: "view", arguments: { path: "AGENTS.md" } } },
      { ...metadata, type: "tool.execution_partial_result", ephemeral: true, data: { toolCallId: "shell", partialOutput: "working " } },
      { ...metadata, type: "tool.execution_partial_result", ephemeral: true, data: { toolCallId: "shell", partialOutput: "tree clean" } },
      { ...metadata, type: "tool.execution_progress", ephemeral: true, data: { toolCallId: "read", progressMessage: "Loading instructions" } },
      { ...metadata, type: "tool.execution_complete", data: { toolCallId: "read", success: true, result: { content: "Instructions", detailedContent: "Full instructions" } } },
      { ...metadata, type: "tool.execution_complete", data: { toolCallId: "shell", success: true, result: { content: "working tree clean" } } },
    ])
    expect(result.client.createSession.mock.calls[0]?.[0].streaming).toBe(true)
    expect(result.activity[1]).toMatchObject({ text: "the repository.", append: true })
    expect(result.activity).toContainEqual(expect.objectContaining({ id: "shell", output: "working tree clean", status: "running" }))
    expect(result.log).toEqual([
      { kind: "assistant", id: "message", text: "Reading the repository." },
      { kind: "tool", id: "shell", text: 'bash\n{\n  "command": "git status"\n}', status: "done", output: "working tree clean" },
      { kind: "tool", id: "read", text: 'view\n{\n  "path": "AGENTS.md"\n}', status: "done", output: "Full instructions" },
    ])
    expect(result.session.disconnect).toHaveBeenCalledOnce()
    expect(result.client.stop).toHaveBeenCalledOnce()
  })

  it("shows tool errors, session errors, and bounded output even without a start event", async () => {
    const result = await run([
      { ...metadata, type: "tool.execution_partial_result", ephemeral: true, data: { toolCallId: "shell", partialOutput: "x".repeat(20_000) } },
      { ...metadata, type: "tool.execution_complete", data: { toolCallId: "shell", success: false, error: { message: "Command failed" } } },
      { ...metadata, type: "session.error", data: { errorType: "test", message: "Session failed" } },
    ])
    expect(result.log[0]).toMatchObject({ status: "failed", output: expect.stringContaining("Command failed") })
    const tool = result.log[0]
    expect(tool?.kind === "tool" && tool.output.length).toBeLessThan(16_100)
    expect(tool?.kind === "tool" && tool.output).toContain("[Earlier output omitted]")
    expect(result.log[1]).toMatchObject({ kind: "error", text: "Error: Session failed" })
  })

  it("wraps full text and indents tool details without terminal control codes", () => {
    const text = "A long agent message that must wrap instead of losing its final words."
    const lines = guideOptimizeDisplayLines([
      { kind: "assistant", id: "message", text },
      { kind: "tool", id: "read", text: 'view\n{"path":"src/example.ts"}', status: "done", output: "\u001b[31mLoaded source\u001b[0m" },
    ], 30)
    expect(lines.filter((line) => line.kind === "assistant").map((line) => line.text).join("").replaceAll(" ", ""))
      .toBe(text.replaceAll(" ", ""))
    expect(lines.map((line) => line.text)).toContain("> view [done]")
    expect(lines.map((line) => line.text)).toContain("  | Loaded source")
    expect(lines.every((line) => stringWidth(line.text) <= 30 && !line.text.includes("\u001b"))).toBe(true)
  })
})
