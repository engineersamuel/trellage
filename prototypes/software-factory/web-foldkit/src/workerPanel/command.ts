import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { StoredEvent } from "../../../shared/schemas"
import { mount as mountTranscript } from "../../../shared/transcript"
import { getJson, send } from "../api"
import { Worker } from "../domain"
import { Critter, mountCritter } from "../../../shared/critter"
import { toBacklogLines } from "./log"
import { Message } from "./message"

const workerUrl = (workerId: string): string => `/api/workers/${encodeURIComponent(workerId)}`

export const FetchWorkers = Command.define("FetchWorkers", {
  messages: [Message.SucceededFetchWorkers, Message.FailedFetchWorkers],
  execute: getJson("/api/workers", Schema.Array(Worker)).pipe(
    Effect.map((workers) => Message.SucceededFetchWorkers({ workers })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchWorkers({ error }))),
  ),
})

export const FetchBacklog = Command.define("FetchBacklog", {
  args: { workerId: Schema.String },
  messages: [Message.SucceededFetchBacklog, Message.FailedFetchBacklog],
  execute: ({ workerId }) =>
    getJson(`${workerUrl(workerId)}/events`, Schema.Array(StoredEvent)).pipe(
      Effect.map((events) => Message.SucceededFetchBacklog({ workerId, lines: toBacklogLines(events) })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchBacklog({ error }))),
    ),
})

export const SendToWorker = Command.define("SendToWorker", {
  args: { workerId: Schema.String, prompt: Schema.String },
  messages: [Message.SucceededSendToWorker, Message.FailedSendToWorker],
  execute: ({ workerId, prompt }) =>
    send("POST", `${workerUrl(workerId)}/message`, { prompt }).pipe(
      Effect.as(Message.SucceededSendToWorker({ prompt })),
      Effect.catch((error) => Effect.succeed(Message.FailedSendToWorker({ workerId, error }))),
    ),
})

/** Abort the worker's current run; the worker stays. */
export const AbortWorker = Command.define("AbortWorker", {
  args: { workerId: Schema.String },
  messages: [Message.SucceededAbortWorker, Message.FailedAbortWorker],
  execute: ({ workerId }) =>
    send("POST", `${workerUrl(workerId)}/abort`).pipe(
      Effect.as(Message.SucceededAbortWorker()),
      Effect.catch((error) => Effect.succeed(Message.FailedAbortWorker({ workerId, error }))),
    ),
})

/** Remove the worker: its session ends and it leaves the list. */
export const StopWorker = Command.define("StopWorker", {
  args: { workerId: Schema.String },
  messages: [Message.SucceededStopWorker, Message.FailedStopWorker],
  execute: ({ workerId }) =>
    send("DELETE", workerUrl(workerId)).pipe(
      Effect.as(Message.SucceededStopWorker()),
      Effect.catch((error) => Effect.succeed(Message.FailedStopWorker({ workerId, error }))),
    ),
})

/** shared/transcript.ts fills the element with the worker's readable transcript until the element leaves the page. */
export const MountTranscript = Mount.define("MountTranscript", {
  args: { workerId: Schema.String },
  messages: [Message.CompletedMountTranscript],
  execute: ({ element, workerId }) =>
    Effect.acquireRelease(
      Effect.sync(() => (element instanceof HTMLElement ? mountTranscript(element, workerId) : () => {})),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.as(Message.CompletedMountTranscript())),
})

/** Animates the critter of one agent row until the element leaves the page (setting `critters`). */
export const MountCritter = Mount.define("MountCritter", {
  args: Critter,
  messages: [Message.CompletedMountCritter],
  execute: ({ element, ...critter }) =>
    Effect.acquireRelease(
      Effect.sync(() => mountCritter(element, critter)),
      (stop) => Effect.sync(stop),
    ).pipe(Effect.as(Message.CompletedMountCritter())),
})
