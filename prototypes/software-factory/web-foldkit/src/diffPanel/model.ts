import { Schema } from "effect";
import { Dialog } from "@foldkit/ui";
import { WorktreeDiffAsyncData } from "./domain";

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  /** Conversation whose worktree is shown; "-" means the factory run worktree. */
  threadId: Schema.String,
  diff: WorktreeDiffAsyncData.schema,
  maybeSelectedPath: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;
