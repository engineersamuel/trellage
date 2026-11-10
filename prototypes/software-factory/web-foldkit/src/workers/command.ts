import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { getJson, send } from "../api"
import { Worker } from "../domain"
import { Message } from "./message"

export const FetchWorkers = Command.define("FetchWorkers", {
  messages: [Message.SucceededFetchWorkers, Message.FailedFetchWorkers],
  execute: getJson("/api/workers", Schema.Array(Worker)).pipe(
    Effect.map((workers) => Message.SucceededFetchWorkers({ workers })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchWorkers({ error }))),
  ),
})

/** Abort the worker's current run; the worker stays. */
export const AbortWorker = Command.define("AbortWorker", {
  args: { workerId: Schema.String },
  messages: [Message.SucceededAbortWorker, Message.FailedAbortWorker],
  execute: ({ workerId }) =>
    send("POST", `/api/workers/${encodeURIComponent(workerId)}/abort`).pipe(
      Effect.as(Message.SucceededAbortWorker()),
      Effect.catch((error) => Effect.succeed(Message.FailedAbortWorker({ workerId, error }))),
    ),
})
