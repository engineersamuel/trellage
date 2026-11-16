import { Schema } from "effect"
import { Dialog } from "@foldkit/ui"
import { TournamentListAsyncData, TournamentViewAsyncData } from "./domain"

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  tournaments: TournamentListAsyncData.schema,
  /** The tournament shown in detail. */
  maybeSelectedId: Schema.Option(Schema.String),
  selected: TournamentViewAsyncData.schema,
  /** The variant whose builds and screenshots are open. */
  maybeExpandedRow: Schema.Option(Schema.String),
  /** New tournament form: one source per line, and the cost limit. */
  /** ui-skills: one source URL per line; prototypes: the idea. */
  preset: Schema.Literals(["ui-skills", "prototypes"]),
  sourcesText: Schema.String,
  limitText: Schema.String,
  limitDialogText: Schema.String,
  maybeError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
