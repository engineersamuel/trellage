import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Dialog } from "@foldkit/ui"
import { StoredEvent } from "../../../shared/schemas"
import { Worker } from "../domain"
import { LogLine } from "./model"

export const Message = defineMessageUnion({
  SucceededFetchWorkers: { workers: Schema.Array(Worker) },
  FailedFetchWorkers: { error: Schema.String },
  SucceededFetchBacklog: { workerId: Schema.String, lines: Schema.Array(LogLine) },
  FailedFetchBacklog: { error: Schema.String },
  ReceivedWorkerUpdate: { worker: Worker },
  ReceivedWorkerStopped: { workerId: Schema.String },
  ReceivedWorkerEvent: { event: StoredEvent },
  ReceivedFeedGap: {},
  ClickedWorker: { workerId: Schema.String },
  UpdatedMessageDraft: { value: Schema.String },
  SubmittedMessageDraft: {},
  SucceededSendToWorker: { prompt: Schema.String },
  FailedSendToWorker: { workerId: Schema.String, error: Schema.String },
  ClickedCancelRun: { workerId: Schema.String },
  SucceededAbortWorker: {},
  FailedAbortWorker: { workerId: Schema.String, error: Schema.String },
  ClickedRemove: { workerId: Schema.String },
  ConfirmedRemove: {},
  GotRemoveDialogMessage: { message: Dialog.Message },
  SucceededStopWorker: {},
  FailedStopWorker: { workerId: Schema.String, error: Schema.String },
  ToggledRawLog: { isChecked: Schema.Boolean },
  ClickedDismissError: {},
  CompletedMountTranscript: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** The user picked a worker. The parent owns the focus setting and decides. */
  SelectedWorker: { workerId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
