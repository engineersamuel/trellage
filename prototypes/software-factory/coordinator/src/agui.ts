// Copilot SDK session events -> AG-UI events, for one run.
import type { SessionEvent } from "@github/copilot-sdk"
import { hasUnified } from "../../shared/diff.ts"
import { mergeCards } from "./cards.ts"

/** AG-UI 1.0 token usage, one entry per model. */
type TokenUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  reasoningTokens: number
}

/** A decision the run opened, sent as an AG-UI interrupt when the run ends with it still open. */
export type DecisionInterrupt = {
  id: string
  reason: "approval" | "question"
  message: string
  toolCallId: string
  responseSchema: Record<string, unknown>
  metadata: { summary: string; options: string[] }
}

export type TranslatorOptions = {
  /** The consumer answers interrupts (forwardedProps.interrupts). The Foldkit UI does not: it answers through POST /api/approvals, which delivers the answer to the coordinator. */
  interrupts?: boolean
  /** A decision is still waiting for its answer. */
  pending?: (decisionId: string) => boolean
  /** A tool the consumer runs itself (AG-UI frontend tool): the run ends at its call. */
  clientTool?: (name: string) => boolean
  /**
   * For UIs that draw only OpenUI Lang (Foldkit): a card tool's result as an OpenUI program. The run's cards are
   * merged into one program and sent as the run's last assistant message, so that UI shows them as the answer.
   */
  card?: (toolName: string, result: string, args: Record<string, unknown>, prefix: string) => string | null
}

type Subagent = { name: string; description: string; model: string | undefined; toolCalls: number }

const DECISION_TOOLS: Record<string, DecisionInterrupt["reason"]> = { request_approval: "approval", ask_user: "question" }

const parse = (s: string): any => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export class Translator {
  private openText: string | null = null
  private openReasoning: string | null = null
  /** Copilot reasoning ids that already streamed deltas. */
  private streamedReasoning = new Set<string>()
  /** Copilot message ids that already streamed deltas. */
  private streamed = new Set<string>()
  /** Open AG-UI steps: one per model turn. */
  private steps = new Set<string>()
  /** Active subagent invocations by subagentRunId. */
  private subagents = new Map<string, Subagent>()
  private usage = new Map<string, TokenUsage>()
  private decisionCalls = new Map<string, Record<string, any>>()
  private decisions: DecisionInterrupt[] = []
  /** Tool names and arguments by call id, for `card`. */
  private toolNames = new Map<string, string>()
  private toolArgs = new Map<string, Record<string, unknown>>()
  /** Card programs from this run's card tools, sent as the run's last message (see `card`). */
  private cards: string[] = []
  /** Calls of consumer-run tools; their results come from the consumer, so none is sent. */
  readonly clientCalls = new Set<string>()
  /** Set by a stop request: the run ends with the cancelled outcome. */
  cancelled = false
  done = false

  constructor(
    readonly threadId: string,
    readonly runId: string,
    private readonly opts: TranslatorOptions = {},
  ) {}

  /** No STATE_SNAPSHOT: no client reads agent state; worker status reaches the UIs through the factory feed. */
  started(): unknown[] {
    return [{ type: "RUN_STARTED", threadId: this.threadId, runId: this.runId }]
  }

  /** Close everything still open, then RUN_FINISHED with the outcome and the run's token usage. */
  finish(out: unknown[], outcome?: Record<string, unknown>): void {
    this.closeReasoning(out)
    this.closeText(out)
    if (this.cards.length) {
      // Last message of the run: an OpenUI-only UI shows a turn's last message as the answer, earlier ones as steps.
      const messageId = `cards-${this.runId}`
      out.push({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" })
      out.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: mergeCards(this.cards) })
      out.push({ type: "TEXT_MESSAGE_END", messageId })
      this.cards = []
    }
    for (const stepName of this.steps) out.push({ type: "STEP_FINISHED", stepName })
    this.steps.clear()
    for (const [id, s] of this.subagents) {
      // AG-UI requires every invocation closed before the run ends; this one still runs in the session.
      out.push({ type: "SUBAGENT_ERROR", subagentRunId: id, message: "The run ended before this subagent finished.", code: "detached" })
      this.subagentActivity(out, id, s, "background")
    }
    this.subagents.clear()
    const usage = [...this.usage.values()]
    out.push({
      type: "RUN_FINISHED",
      threadId: this.threadId,
      runId: this.runId,
      ...(outcome ? { outcome } : {}),
      ...(usage.length ? { usage } : {}),
    })
    this.done = true
  }

  finished(): unknown {
    const out: unknown[] = []
    this.finish(out)
    return out.at(-1)
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

  /** Thinking text as an AG-UI reasoning message (agent-interface ignores it). */
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

  /** The subagent's progress card: an AG-UI activity message, replaced in place as it changes. */
  private subagentActivity(out: unknown[], id: string, s: Subagent, status: string, extra: Record<string, unknown> = {}) {
    out.push({
      type: "ACTIVITY_SNAPSHOT",
      messageId: `subagent-${id}`,
      activityType: "subagent",
      content: { name: s.name, description: s.description, status, toolCalls: s.toolCalls, ...(s.model ? { model: s.model } : {}), ...extra },
    })
  }

  /** An activity card from outside the session (a worker this run started). Nothing once the run ended. */
  activity(messageId: string, activityType: string, content: Record<string, unknown>): unknown[] {
    return this.done ? [] : [{ type: "ACTIVITY_SNAPSHOT", messageId, activityType, content }]
  }

  private addUsage(d: Record<string, any>) {
    const n = (k: string) => (typeof d[k] === "number" ? d[k] : 0)
    const model = typeof d.model === "string" ? d.model : "unknown"
    const u = this.usage.get(model) ?? { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 }
    u.inputTokens += n("inputTokens")
    u.outputTokens += n("outputTokens")
    u.totalTokens += n("inputTokens") + n("outputTokens")
    u.cachedInputTokens += n("cacheReadTokens")
    u.cacheWriteInputTokens += n("cacheWriteTokens")
    u.reasoningTokens += n("reasoningTokens")
    this.usage.set(model, u)
  }

  /** Subagent lifecycle and usage, which arrive with the subagent's agentId. */
  private subagentEvent(out: unknown[], ev: SessionEvent, d: Record<string, any>): boolean {
    const id = (ev as { agentId?: string }).agentId ?? (typeof d.toolCallId === "string" ? d.toolCallId : "")
    switch (ev.type) {
      case "assistant.usage":
        this.addUsage(d)
        return true
      case "subagent.started": {
        if (!id || this.subagents.has(id)) return true
        this.closeReasoning(out)
        this.closeText(out)
        const s: Subagent = { name: String(d.agentDisplayName || d.agentName || "subagent"), description: String(d.agentDescription ?? ""), model: d.model, toolCalls: 0 }
        this.subagents.set(id, s)
        out.push({ type: "SUBAGENT_STARTED", subagentRunId: id, name: s.name, ...(s.description ? { description: s.description } : {}) })
        this.subagentActivity(out, id, s, "running")
        return true
      }
      case "subagent.completed":
      case "subagent.failed": {
        const s = this.subagents.get(id)
        if (!s) return true
        this.subagents.delete(id)
        if (typeof d.totalToolCalls === "number") s.toolCalls = d.totalToolCalls
        if (typeof d.model === "string") s.model = d.model
        const failed = ev.type === "subagent.failed" || d.cancelled === true
        const extra = { ...(typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {}), ...(typeof d.totalTokens === "number" ? { totalTokens: d.totalTokens } : {}) }
        if (failed) {
          const message = ev.type === "subagent.failed" ? String(d.error || "The subagent failed.") : "The subagent was cancelled."
          out.push({ type: "SUBAGENT_ERROR", subagentRunId: id, message, ...(d.cancelled ? { code: "cancelled" } : {}) })
          this.subagentActivity(out, id, s, d.cancelled ? "cancelled" : "failed", { ...extra, error: message })
        } else {
          out.push({ type: "SUBAGENT_FINISHED", subagentRunId: id })
          this.subagentActivity(out, id, s, "done", extra)
        }
        return true
      }
      case "tool.execution_start": {
        const s = this.subagents.get(id)
        if (!s) return false
        s.toolCalls++
        this.subagentActivity(out, id, s, "running")
        return true
      }
    }
    return false
  }

  /** Decisions this run opened that still wait for the human. */
  private openDecisions(): DecisionInterrupt[] {
    return this.decisions.filter((x) => this.opts.pending?.(x.id) ?? true)
  }

  private decisionResult(callId: string, content: string) {
    const args = this.decisionCalls.get(callId)
    if (!args) return
    const r = parse(content)
    if (typeof r?.id !== "string" || r.status !== "pending") return
    const options: string[] = Array.isArray(args.options) && args.options.length ? args.options.map(String) : args.reason === "approval" ? ["Approve", "Reject"] : []
    this.decisions.push({
      id: r.id,
      reason: args.reason,
      message: String(args.title ?? ""),
      toolCallId: callId,
      responseSchema: {
        type: "object",
        properties: { answer: options.length && args.reason === "approval" ? { type: "string", enum: options } : { type: "string" }, note: { type: "string" } },
        required: ["answer"],
      },
      metadata: { summary: String(args.summary ?? ""), options },
    })
  }

  /** Translate one session event. Sub-agent content is left to the raw worker stream; its lifecycle is sent. */
  translate(ev: SessionEvent): unknown[] {
    const out: unknown[] = []
    if (this.done) return out
    const d = ((ev as { data?: any }).data ?? {}) as Record<string, any>
    if (this.subagentEvent(out, ev, d)) return out
    if ((ev as { agentId?: string }).agentId) return out
    const s = (k: string): string => (typeof d[k] === "string" ? d[k] : "")
    const top = d.parentToolCallId === undefined || d.parentToolCallId === null
    switch (ev.type) {
      case "assistant.turn_start": {
        if (!top) break
        const stepName = `turn ${s("turnId") || this.steps.size + 1}`
        if (!this.steps.has(stepName)) (this.steps.add(stepName), out.push({ type: "STEP_STARTED", stepName }))
        break
      }
      case "assistant.turn_end": {
        if (!top) break
        const stepName = `turn ${s("turnId")}`
        if (this.steps.delete(stepName)) {
          this.closeReasoning(out)
          this.closeText(out)
          out.push({ type: "STEP_FINISHED", stepName })
        }
        break
      }
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
        const name = s("toolName")
        this.toolNames.set(id, name)
        this.toolArgs.set(id, (d.arguments ?? {}) as Record<string, unknown>)
        out.push({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name })
        out.push({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(d.arguments ?? {}) })
        out.push({ type: "TOOL_CALL_END", toolCallId: id })
        if (DECISION_TOOLS[name]) this.decisionCalls.set(id, { ...(d.arguments ?? {}), reason: DECISION_TOOLS[name] })
        if (this.opts.clientTool?.(name)) {
          // A frontend tool: the consumer runs it and sends the result in the next run's messages.
          this.clientCalls.add(id)
          this.finish(out, { type: "success", pendingToolCallIds: [id] })
        }
        break
      }
      case "tool.execution_complete": {
        if (!top || this.clientCalls.has(s("toolCallId"))) break
        const content = d.result?.content ?? d.error?.message ?? ""
        const short = typeof content === "string" ? content : JSON.stringify(content)
        // The Copilot SDK (and Claude, see claude.ts) put an edit's unified diff in `detailedContent`; the chat draws it.
        const diff = d.result?.detailedContent
        const text = typeof diff === "string" && hasUnified(diff) && !short.includes(diff) ? `${short}\n${diff}` : short
        out.push({
          type: "TOOL_CALL_RESULT",
          messageId: `tr-${s("toolCallId")}`,
          toolCallId: s("toolCallId"),
          content: text,
          role: "tool",
          // A failed call carries its message in `error` (AG-UI ToolMessage.error), so clients can show it as failed.
          ...(d.success === false ? { error: String(d.error?.message ?? text) || "The tool call failed." } : {}),
        })
        if (d.success !== false) this.decisionResult(s("toolCallId"), text)
        const tcid = s("toolCallId")
        const program = d.success === false ? null : (this.opts.card?.(this.toolNames.get(tcid) ?? "", text, this.toolArgs.get(tcid) ?? {}, `k${this.cards.length}`) ?? null)
        if (program) this.cards.push(program)
        break
      }
      case "abort":
        this.cancelled = true
        this.finish(out, { type: "cancelled" })
        break
      case "session.error":
        this.closeReasoning(out)
        this.closeText(out)
        out.push({ type: "RUN_ERROR", message: s("message") })
        this.done = true
        break
      case "session.idle": {
        const open = this.opts.interrupts ? this.openDecisions() : []
        this.finish(
          out,
          this.cancelled ? { type: "cancelled" } : open.length ? { type: "interrupt", interrupts: open } : undefined,
        )
        break
      }
    }
    return out
  }
}
