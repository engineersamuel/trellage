import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Dialog } from "@foldkit/ui";
import { WorktreeDiff } from "./domain";

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  ClickedRefresh: {},
  SucceededFetchDiff: { diff: WorktreeDiff },
  FailedFetchDiff: { error: Schema.String },
  ClickedFile: { path: Schema.String },
  PressedNextFile: {},
  PressedPreviousFile: {},
  CompletedMountNativeDiff: {},
});
export type Message = typeof Message.Type;
