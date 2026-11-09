import { Schema } from "effect";
import { Dialog } from "@foldkit/ui";
import { GoalCatalogAsyncData, GoalDraft, GoalListAsyncData, LoopPrompt } from "./domain";

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  /** Saved goals with their run counts. */
  goals: GoalListAsyncData.schema,
  /** Steps, skills and folders the form offers. */
  catalog: GoalCatalogAsyncData.schema,
  draft: GoalDraft,
  /** Why the draft is not a valid goal, or why the server refused it. */
  problems: Schema.Array(Schema.String),
  /** After a save: the line and the full prompt to paste into an agent. */
  maybeSaved: Schema.Option(LoopPrompt),
  isCopied: Schema.Boolean,
});
export type Model = typeof Model.Type;
