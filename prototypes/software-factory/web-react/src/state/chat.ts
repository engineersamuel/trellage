// The coordinator chat agent and the thread actions that drive it.
// Thread ownership: the store holds the open thread id and CopilotChat receives it as `threadId`.
// CopilotChat then sets `agent.threadId` and calls connect(), which loads the saved messages here.
// No other code writes `coordinator.threadId` or calls `setMessages`.
import { EventType, HttpAgent, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client"
import { Effect, Schema } from "effect"
import { defer, from, mergeMap, of, type Observable } from "rxjs"
import { syncThreadUrl } from "../../../shared/folders"
import { json, type HttpError } from "../../../shared/http"
import { Action } from "./model"
import { agentOfThread, dispatch, loadToolTimes, useApp } from "./store"

/** Saved messages of a thread; an unknown (new) thread has none. */
const savedMessages = (threadId: string): Effect.Effect<readonly unknown[]> =>
  json(`/api/threads/get/${encodeURIComponent(threadId)}`, Schema.Array(Schema.Unknown)).pipe(
    // Durations first, so the cards never flash without them.
    Effect.tap(() => loadToolTimes(agentOfThread(useApp.getState().threads.find((t) => t.id === threadId)))),
    Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`).pipe(Effect.as([] as readonly unknown[]))),
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
          { type: EventType.MESSAGES_SNAPSHOT, messages: messages as Message[] } as BaseEvent,
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
