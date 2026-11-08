import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Dialog } from "@foldkit/ui";
import { WorktreeDiff } from "./domain";

export const Message = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  ClickedRefresh: {},
  /** The feed reported a finished tool call or a cleaned worktree while the panel is open. */
  ReceivedFileChange: {},
  SucceededFetchDiff: { diff: WorktreeDiff },
  FailedFetchDiff: { error: Schema.String },
  ClickedFile: { path: Schema.String },
  PressedNextFile: {},
  PressedPreviousFile: {},
  CompletedMountNativeDiff: {},
});
export type Message = typeof Message.Type;
