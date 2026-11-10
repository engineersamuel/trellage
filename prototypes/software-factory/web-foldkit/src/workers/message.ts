import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Worker } from "../domain"

export const Message = defineMessageUnion({
  SucceededFetchWorkers: { workers: Schema.Array(Worker) },
  FailedFetchWorkers: { error: Schema.String },
  ReceivedWorkerUpdate: { worker: Worker },
  ReceivedWorkerStopped: { workerId: Schema.String },
  ReceivedFeedGap: {},
  SucceededAbortWorker: {},
  FailedAbortWorker: { workerId: Schema.String, error: Schema.String },
})
export type Message = typeof Message.Type
