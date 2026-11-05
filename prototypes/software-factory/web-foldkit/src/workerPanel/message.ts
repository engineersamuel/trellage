import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { StoredEvent } from "../../../shared/schemas";
import { Worker } from "../domain";
import { LogLine } from "./model";

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
  FailedSendToWorker: { error: Schema.String },
  ClickedStop: { workerId: Schema.String },
  SucceededStopWorker: {},
  FailedStopWorker: { error: Schema.String },
  ToggledRawLog: { isChecked: Schema.Boolean },
  ClickedDismissError: {},
  CompletedMountTranscript: {},
});
export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  /** The user picked a worker. The parent owns the focus setting and decides. */
  SelectedWorker: { workerId: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;
