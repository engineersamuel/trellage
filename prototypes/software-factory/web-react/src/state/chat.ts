// The coordinator chat agent and the thread actions that drive it. The store owns the open thread id;
// these functions are the only code that writes `coordinator.threadId` or its messages.
import { HttpAgent, type Message } from "@ag-ui/client"
import { Effect, Schema } from "effect"
import { syncThreadUrl } from "../../../shared/folders"
import { json, type HttpError } from "../../../shared/http"
import { Action } from "./model"
import { agentOfThread, dispatch, loadToolTimes, useApp } from "./store"

/** CopilotKit talks AG-UI straight to the coordinator (no CopilotKit runtime server in between). */
export const coordinator = new HttpAgent({ url: "/api/agui", agentId: "coordinator" })

/** Open a saved thread: load its messages into the agent, then select it. */
export const openThread = (id: string): Promise<void> =>
  Effect.runPromise(
    json(`/api/threads/get/${encodeURIComponent(id)}`, Schema.Array(Schema.Unknown)).pipe(
      // Durations first, so the cards never flash without them.
      Effect.tap(() => loadToolTimes(agentOfThread(useApp.getState().threads.find((t) => t.id === id)))),
      Effect.map((messages) => {
        coordinator.threadId = id
        coordinator.setMessages(messages as Message[])
        dispatch(Action.ThreadSelected({ threadId: id }))
        syncThreadUrl(id)
      }),
      Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`)),
    ),
  )

/** Start a new, unsaved conversation. */
export const freshThread = (): void => {
  const id = crypto.randomUUID()
  coordinator.threadId = id
  coordinator.setMessages([])
  dispatch(Action.ThreadSelected({ threadId: id }))
  syncThreadUrl(null)
}

/** Reload the open thread when another client wrote it; our own runs stream in already. */
export const refreshOpenThread = (threadId: string | null): void => {
  const id = threadId ?? coordinator.threadId
  if (id && id === useApp.getState().threadId && id === coordinator.threadId && !coordinator.isRunning) void openThread(id)
}
