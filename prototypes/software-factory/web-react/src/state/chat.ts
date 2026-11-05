// The coordinator chat agent and the thread actions that drive it.
// Thread ownership: the store holds the open thread id and CopilotChat receives it as `threadId`.
// CopilotChat then sets `agent.threadId` and calls connect(), which loads the saved messages here.
// No other code writes `coordinator.threadId` or calls `setMessages`.
import { MessageSchema } from "@ag-ui/core/schemas"
import { EventType, HttpAgent, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client"
import { Effect, Schema } from "effect"
import { defer, from, mergeMap, of, type Observable } from "rxjs"
import { syncThreadUrl } from "../../../shared/folders"
import { json, type HttpError } from "../../../shared/http"
import type { OpenUiAction } from "../../../shared/protos/core"
import { Action } from "./model"
import { agentOfThread, dispatch, loadToolTimes, useApp } from "./store"

/** One AG-UI message, checked with AG-UI's own schema (zod), so a bad stored row fails at the boundary. */
const AgUiMessage = Schema.declare((u: unknown): u is Message => MessageSchema.safeParse(u).success)

/** Saved messages of a thread; an unknown (new) thread has none. */
const savedMessages = (threadId: string): Effect.Effect<readonly Message[]> =>
  json(`/api/threads/get/${encodeURIComponent(threadId)}`, Schema.Array(AgUiMessage)).pipe(
    // Durations first, so the cards never flash without them.
    Effect.tap(() => loadToolTimes(agentOfThread(useApp.getState().threads.find((t) => t.id === threadId)))),
    Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`).pipe(Effect.as([] as readonly Message[]))),
  )

/**
 * AG-UI agent for the coordinator. Runs go to /api/agui (HttpAgent). connect() is the AG-UI "restore a thread"
 * hook: it replays the saved messages as one MESSAGES_SNAPSHOT, so CopilotKit hydrates history itself.
 */
export class FactoryAgent extends HttpAgent {
  protected override connect(input: RunAgentInput): Observable<BaseEvent> {
    const runId = crypto.randomUUID()
    const { threadId } = input
    return defer(() => from(Effect.runPromise(savedMessages(threadId)))).pipe(
      mergeMap((messages) =>
        of<BaseEvent[]>(
          { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
          { type: EventType.MESSAGES_SNAPSHOT, messages: [...messages] } as BaseEvent,
          { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
        ),
      ),
    )
  }
}

/** CopilotKit talks AG-UI straight to the coordinator (no CopilotKit runtime server in between). */
export const coordinator = new FactoryAgent({ url: "/api/agui", agentId: "coordinator" })

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
