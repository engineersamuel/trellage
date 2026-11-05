import { expect, test } from "bun:test"
import { activity, toolLine, toTranscript } from "../../shared/transcript.ts"

let n = 0
const ev = (type: string, data: any, agentId: string | null = null) => ({ seq: ++n, workerId: "w", type, agentId, timestamp: "", data })

test("raw SDK events fold into chat messages and one card per tool call", () => {
  const items = toTranscript([
    ev("user.message", { content: "build it\n\n<ui-format>markdown</ui-format>" }),
    ev("assistant.message_delta", { messageId: "m1", deltaContent: "Plan " }),
    ev("assistant.message_delta", { messageId: "m1", deltaContent: "ready." }),
    ev("assistant.message", { messageId: "m1", content: "Plan ready." }),
    ev("tool.execution_start", { toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } }),
    ev("tool.execution_start", { toolCallId: "t2", toolName: "view", parentToolCallId: "t1" }),
    ev("assistant.message", { messageId: "x", content: "sub-agent text" }, "agent-1"),
    ev("tool.execution_complete", { toolCallId: "t1", success: false, error: { message: "boom" } }),
  ])
  // Each item keeps the seq of the event that started it, so a view can scroll to it.
  const start = n - 7
  expect(items).toEqual([
    { kind: "user", text: "build it", seq: start },
    { kind: "assistant", text: "Plan ready.", seq: start + 1 },
    { kind: "tool", id: "t1", name: "bash", args: { command: "ls" }, done: true, ok: false, result: "boom", seq: start + 4 },
  ])
})

test("factory tools get readable lines with worker and decision links", () => {
  const t = (name: string, args: any, result?: unknown) => ({ kind: "tool" as const, id: "1", name, args, done: result !== undefined, ok: true, result: JSON.stringify(result) })
  expect(toolLine(t("spawn_worker", { name: "sec", step: "implement" }, { id: "w-1", model: "m" }))).toEqual({ icon: "▶", text: "Started worker · m · step implement", link: { worker: "w-1", label: "sec" } })
  expect(toolLine(t("request_approval", { title: "Plan" }, { id: "d1" })).link).toEqual({ decision: "d1", label: "Plan" })
  expect(toolLine(t("next_step", {}, { step: "verify", confidence: 0.91 })).text).toBe("Jev: next step verify (91%)")
  // The card shows the tool name, so the summary is only the first line of the main argument.
  expect(toolLine(t("bash", { command: "git diff\n--stat" })).text).toBe("git diff")
})

test("activity always names what a working agent is doing", () => {
  const turn = ev("assistant.turn_start", {})
  expect(activity([])).toBeNull()
  expect(activity([turn])).toEqual({ label: "Thinking", detail: "" })
  expect(activity([turn, ev("assistant.reasoning_delta", { deltaContent: "check the " }), ev("assistant.reasoning_delta", { deltaContent: "diff" })])).toEqual({ label: "Thinking", detail: "check the diff" })
  expect(activity([turn, ev("assistant.tool_call_delta", { toolName: "bash" })])!.label).toBe("Preparing bash call")
  const start = ev("tool.execution_start", { toolCallId: "t", toolName: "bash" })
  expect(activity([turn, start, ev("tool.execution_partial_result", { toolCallId: "t", partialOutput: "a\nlast line\n" })])).toEqual({ label: "Running bash", detail: "last line" })
  expect(activity([turn, start, ev("tool.execution_complete", { toolCallId: "t" })])!.label).toBe("Thinking")
  expect(activity([turn, ev("permission.requested", { permissionRequest: { kind: "shell", fullCommandText: "rm x" } })])).toEqual({ label: "Waiting for permission (shell)", detail: "rm x" })
  expect(activity([turn, ev("session.idle", {})])).toBeNull()
})
