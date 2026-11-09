import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Dialog } from "@foldkit/ui";
import { Report } from "../../../shared/schemas";
import { View } from "./model";

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  SucceededFetchReport: { ref: Schema.String, report: Report },
  FailedFetchReport: { ref: Schema.String, error: Schema.String },
  SucceededFetchBrief: { ref: Schema.String, content: Schema.String },
  FailedFetchBrief: { ref: Schema.String },
  ClickedView: { view: View },
  ClickedStart: { rank: Schema.Number },
  SucceededStart: { rank: Schema.Number, threadId: Schema.String, branch: Schema.NullOr(Schema.String) },
  FailedStart: { rank: Schema.Number, error: Schema.String },
  ClickedOpenHtml: {},
  ClickedDownloadMdx: {},
  CompletedOpenBlob: {},
  CompletedOpenThread: {},
});
export type Message = typeof Message.Type;
