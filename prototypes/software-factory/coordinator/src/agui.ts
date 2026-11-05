// Copilot SDK session events -> AG-UI events, for one run.
import type { SessionEvent } from "@github/copilot-sdk"

export class Translator {
  private openText: string | null = null
  private openReasoning: string | null = null
  /** Copilot reasoning ids that already streamed deltas. */
  private streamedReasoning = new Set<string>()
  /** Copilot message ids that already streamed deltas. */
  private streamed = new Set<string>()
  done = false

  constructor(
    readonly threadId: string,
    readonly runId: string,
  ) {}

  /** No STATE_SNAPSHOT: no client reads agent state; worker status reaches the UIs through the factory feed. */
  started(): unknown[] {
    return [{ type: "RUN_STARTED", threadId: this.threadId, runId: this.runId }]
  }

  finished(): unknown {
    return { type: "RUN_FINISHED", threadId: this.threadId, runId: this.runId }
  }

  private closeText(out: unknown[]) {
    if (this.openText === null) return
    out.push({ type: "TEXT_MESSAGE_END", messageId: this.openText })
    this.openText = null
  }

  private closeReasoning(out: unknown[]) {
    if (this.openReasoning === null) return
    out.push({ type: "REASONING_MESSAGE_END", messageId: this.openReasoning })
    out.push({ type: "REASONING_END", messageId: this.openReasoning })
    this.openReasoning = null
  }

  /** Thinking text as an AG-UI reasoning message (shown by CopilotKit; agent-interface ignores it). */
  private reasoning(out: unknown[], sourceId: string, delta: string) {
    if (!delta) return
    if (this.openReasoning === null) {
      this.closeText(out)
      this.openReasoning = `r-${sourceId || "x"}-${crypto.randomUUID().slice(0, 6)}`
      out.push({ type: "REASONING_START", messageId: this.openReasoning })
      out.push({ type: "REASONING_MESSAGE_START", messageId: this.openReasoning, role: "reasoning" })
    }
    out.push({ type: "REASONING_MESSAGE_CONTENT", messageId: this.openReasoning, delta })
  }

  private text(out: unknown[], sourceId: string, delta: string) {
    if (!delta) return
    this.closeReasoning(out)
    if (this.openText === null) {
      this.openText = `${sourceId}-${crypto.randomUUID().slice(0, 6)}`
      out.push({ type: "TEXT_MESSAGE_START", messageId: this.openText, role: "assistant" })
    }
    out.push({ type: "TEXT_MESSAGE_CONTENT", messageId: this.openText, delta })
  }

  /** Translate one session event. Sub-agent events are left to the raw worker stream. */
  translate(ev: SessionEvent): unknown[] {
    const out: unknown[] = []
    if (this.done || (ev as { agentId?: string }).agentId) return out
    const d = ((ev as { data?: any }).data ?? {}) as Record<string, any>
    const s = (k: string): string => (typeof d[k] === "string" ? d[k] : "")
    const top = d.parentToolCallId === undefined || d.parentToolCallId === null
    switch (ev.type) {
      case "assistant.reasoning_delta":
        if (!top) break
        this.streamedReasoning.add(s("reasoningId"))
        this.reasoning(out, s("reasoningId"), s("deltaContent"))
        break
      case "assistant.reasoning":
        if (!top) break
        if (!this.streamedReasoning.has(s("reasoningId"))) this.reasoning(out, s("reasoningId"), s("content"))
        this.closeReasoning(out)
        break
      case "assistant.message_delta":
        if (!top) break
        this.streamed.add(s("messageId"))
        this.text(out, s("messageId"), s("deltaContent"))
        break
      case "assistant.message":
        if (!top) break
        // Non-streamed message: emit it whole. Streamed: deltas already sent.
        if (!this.streamed.has(s("messageId"))) this.text(out, s("messageId"), s("content"))
        this.closeText(out)
        break
      case "tool.execution_start": {
        if (!top) break
        this.closeReasoning(out)
        this.closeText(out)
        const id = s("toolCallId")
        out.push({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: s("toolName") })
        out.push({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(d.arguments ?? {}) })
        out.push({ type: "TOOL_CALL_END", toolCallId: id })
        break
      }
      case "tool.execution_complete": {
        if (!top) break
        const content = d.result?.content ?? d.error?.message ?? ""
        const text = typeof content === "string" ? content : JSON.stringify(content)
        out.push({
          type: "TOOL_CALL_RESULT",
          messageId: `tr-${s("toolCallId")}`,
          toolCallId: s("toolCallId"),
          content: text,
          role: "tool",
          // A failed call carries its message in `error` (AG-UI ToolMessage.error), so clients can show it as failed.
          ...(d.success === false ? { error: String(d.error?.message ?? text) || "The tool call failed." } : {}),
        })
        break
      }
      case "session.error":
        this.closeReasoning(out)
        this.closeText(out)
        out.push({ type: "RUN_ERROR", message: s("message") })
        this.done = true
        break
      case "session.idle":
        this.closeReasoning(out)
        this.closeText(out)
        out.push(this.finished())
        this.done = true
        break
    }
    return out
  }
}
