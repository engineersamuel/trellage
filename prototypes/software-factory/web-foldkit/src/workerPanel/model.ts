import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { Dialog } from "@foldkit/ui";
import { Worker } from "../domain";

export const WorkersAsyncData = AsyncData.Schema(Schema.Array(Worker), Schema.String);

export const LogLine = Schema.Struct({ seq: Schema.Number, type: Schema.String, text: Schema.String });
export type LogLine = typeof LogLine.Type;

export const Model = Schema.Struct({
  workers: WorkersAsyncData.schema,
  selectedWorkerId: Schema.String,
  /** Raw-event log of the selected worker, ordered by seq. */
  logLines: Schema.Array(LogLine),
  messageDraft: Schema.String,
  isRawLogVisible: Schema.Boolean,
  maybeError: Schema.Option(Schema.String),
  removeDialog: Dialog.Model,
  /** The worker the remove dialog asks about, while it is open. */
  maybePendingRemoval: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;
