// The coordinator chat agent and the thread actions that drive it.
// Thread ownership: the store holds the open thread id and CopilotChat receives it as `threadId`.
// CopilotChat then sets `agent.threadId` and calls connect(), which loads the saved messages here.
// No other code writes `coordinator.threadId` or calls `setMessages`.
import { AgentCapabilitiesSchema, MessageSchema } from "@ag-ui/core/schemas"
import {
  EventType,
  HttpAgent,
  type AgentCapabilities,
  type AgentSubscriber,
  type BaseEvent,
  type Interrupt,
  type Message,
  type ResumeEntry,
  type RunAgentInput,
  type RunAgentParameters,
  type RunAgentResult,
} from "@ag-ui/client"
import { Effect, Schema } from "effect"
import { defer, from, mergeMap, of, type Observable } from "rxjs"
import { syncThreadUrl } from "../../../shared/folders"
import { json, send, type HttpError } from "../../../shared/http"
import type { OpenUiAction } from "../../../shared/protos/core"
import { Action } from "./model"
import { agentOfThread, dispatch, loadToolTimes, useApp } from "./store"

/** One AG-UI message, checked with AG-UI's own schema (zod), so a bad stored row fails at the boundary. */
const AgUiMessage = Schema.declare((u: unknown): u is Message => MessageSchema.safeParse(u).success)

/** The coordinator's AG-UI capabilities, checked with AG-UI's own schema. */
const Capabilities = Schema.declare((u: unknown): u is AgentCapabilities => AgentCapabilitiesSchema.safeParse(u).success)

/** Saved messages of a thread; an unknown (new) thread has none. */
const savedMessages = (threadId: string): Effect.Effect<readonly Message[]> =>
  json(`/api/threads/get/${encodeURIComponent(threadId)}`, Schema.Array(AgUiMessage)).pipe(
    // Durations first, so the cards never flash without them.
    Effect.tap(() => loadToolTimes(agentOfThread(useApp.getState().threads.find((t) => t.id === threadId)))),
    Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`).pipe(Effect.as([] as readonly Message[]))),
  )

/**
 * Pure: a resume list that covers every open interrupt, as AG-UI requires. Answers to interrupts that are no
 * longer open are dropped; an open interrupt without an answer is abandoned (`cancelled`).
 */
export const coverInterrupts = (open: readonly string[], resume: readonly ResumeEntry[]): ResumeEntry[] => [
  ...resume.filter((r) => open.includes(r.interruptId)),
  ...open.filter((id) => !resume.some((r) => r.interruptId === id)).map((id): ResumeEntry => ({ interruptId: id, status: "cancelled" })),
]

const DECISION_REASON: Record<string, string> = { request_approval: "approval", ask_user: "question" }

/**
 * Pure: the interrupts the thread's last run ended with, from its saved messages: decisions the run opened
 * (after the last user message) that are still open. A reload restores them, since CopilotKit clears an agent's
 * interrupts when it connects. `isOpen` is false only for a decision known to be answered.
 */
export const interruptsOf = (messages: readonly Message[], isOpen: (id: string) => boolean): Interrupt[] => {
  const run = messages.slice(messages.map((m) => m.role).lastIndexOf("user") + 1)
  return run.flatMap((m) => {
    if (m.role !== "assistant") return []
    return (m.toolCalls ?? []).flatMap((c): Interrupt[] => {
      const reason = DECISION_REASON[c.function.name]
      const result = run.find((r) => r.role === "tool" && r.toolCallId === c.id)
      if (!reason || result?.role !== "tool" || result.error) return []
      let id: unknown, args: Record<string, unknown> = {}
      try {
        const r = JSON.parse(typeof result.content === "string" ? result.content : "") as { id?: unknown; status?: unknown }
        id = r.status === "pending" ? r.id : undefined
        args = JSON.parse(c.function.arguments) as Record<string, unknown>
      } catch {
        return []
      }
      if (typeof id !== "string" || !isOpen(id)) return []
      return [{ id, reason, toolCallId: c.id, ...(typeof args.title === "string" ? { message: args.title } : {}) }]
    })
  })
}

/**
 * AG-UI agent for the coordinator. Runs go to /api/agui (HttpAgent). connect() is the AG-UI "restore a thread"
 * hook: it replays the saved messages as one MESSAGES_SNAPSHOT, so CopilotKit hydrates history itself.
 */
export class FactoryAgent extends HttpAgent {
  /** Declared capabilities (AG-UI 1.0), read by CopilotKit's useCapabilities. Loaded by loadCapabilities. */
  capabilities: AgentCapabilities | undefined = undefined

  override async getCapabilities(): Promise<AgentCapabilities> {
    return this.capabilities ?? {}
  }

  /**
   * Stop: ask the coordinator to abort the thread's run, then close the stream. The server saves the partial
   * run and ends it with the cancelled outcome; the thread reload then shows it.
   */
  override abortRun(): void {
    if (this.isRunning) void Effect.runPromise(send("/api/agui/stop", "POST", { threadId: this.threadId }).pipe(Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`))))
    super.abortRun()
  }

  /**
   * AG-UI requires a run to answer every open interrupt. A decision answered elsewhere (decision center,
   * Foldkit, the sf CLI) is no longer open, so it is dropped; one still open that this run does not answer
   * is abandoned (`cancelled`): it stays open in the decision center and on its chat card.
   */
  override runAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber): Promise<RunAgentResult> {
    this.pendingInterrupts = this.pendingInterrupts.filter((i) => openDecision(i.id))
    const resume = coverInterrupts(this.pendingInterrupts.map((i) => i.id), parameters?.resume ?? [])
    const { resume: _, ...rest } = parameters ?? {}
    return super.runAgent(resume.length ? { ...rest, resume } : rest, subscriber)
  }

  protected override connect(input: RunAgentInput): Observable<BaseEvent> {
    const runId = crypto.randomUUID()
    const { threadId } = input
    return defer(() => from(Effect.runPromise(savedMessages(threadId)))).pipe(
      mergeMap((messages) => {
        const interrupts = interruptsOf(messages, (id) => !answeredDecision(id))
        return of<BaseEvent[]>(
          { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
          { type: EventType.MESSAGES_SNAPSHOT, messages: [...messages] } as BaseEvent,
          { type: EventType.RUN_FINISHED, threadId, runId, ...(interrupts.length ? { outcome: { type: "interrupt", interrupts } } : {}) } as BaseEvent,
        )
      }),
    )
  }
}

/** A decision is known to be answered (an unknown one, before the store loaded, is not). */
const answeredDecision = (id: string): boolean => useApp.getState().decisions.some((d) => d.id === id && d.status !== "pending")

/** A decision is still waiting for the human (the shared approvals store, kept in the app store). */
const openDecision = (id: string): boolean => useApp.getState().decisions.some((d) => d.id === id && d.status === "pending")

/** CopilotKit talks AG-UI straight to the coordinator (no CopilotKit runtime server in between). */
export const coordinator = new FactoryAgent({ url: "/api/agui", agentId: "coordinator" })

/** Load the coordinator's declared capabilities once. */
export const loadCapabilities: Effect.Effect<void> = json("/api/agui/capabilities", Capabilities).pipe(
  Effect.map((c) => void (coordinator.capabilities = c)),
  Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`)),
)

/**
 * Answer a decision the last run ended with (an AG-UI interrupt): resume the run with the answer.
 * Returns false when the decision is not an open interrupt of the chat; the caller then answers it through
 * the approvals API, and the coordinator gets the answer as a new turn.
 */
export const answerInterrupt = (
  copilotkit: { runAgent: (p: { agent: typeof coordinator; resume: ResumeEntry[] }) => Promise<unknown> },
  decisionId: string,
  answer: string,
  note: string | null,
): Promise<unknown> | false => {
  if (coordinator.isRunning || !coordinator.pendingInterrupts.some((i) => i.id === decisionId)) return false
  return copilotkit.runAgent({ agent: coordinator, resume: [{ interruptId: decisionId, status: "resolved", payload: { answer, ...(note ? { note } : {}) } }] })
}

/** Open a saved thread. CopilotChat sees the new id and loads its messages through connect(). */
export const openThread = (id: string): void => {
  dispatch(Action.ThreadSelected({ threadId: id }))
  syncThreadUrl(id)
}

/** Start a new, unsaved conversation. */
export const freshThread = (): void => {
  dispatch(Action.ThreadSelected({ threadId: crypto.randomUUID() }))
  syncThreadUrl(null)
}

/** Reload the open thread when another client wrote it; our own runs stream in already. */
export const refreshOpenThread = (threadId: string | null): void => {
  const open = useApp.getState().threadId
  if ((threadId === null || threadId === open) && !coordinator.isRunning) dispatch(Action.ThreadReloaded())
}

/**
 * A button inside an agent-designed (OpenUI) card in the chat: "continue" buttons send their text as the next
 * user message of the open thread (through CopilotKit, so the chat shows the run); links open in a new tab.
 */
export const openUiChatAction = (copilotkit: { runAgent: (p: { agent: typeof coordinator }) => Promise<unknown> }) =>
  (a: OpenUiAction): void => {
    if (a.type === "open_url" && typeof a.params.url === "string") return void window.open(a.params.url, "_blank", "noopener")
    if (a.type !== "continue_conversation" || !a.humanFriendlyMessage || coordinator.isRunning) return
    coordinator.addMessage({ id: crypto.randomUUID(), role: "user", content: a.humanFriendlyMessage })
    void copilotkit.runAgent({ agent: coordinator }).catch((e: unknown) => console.warn("OpenUI action run failed", e))
  }
