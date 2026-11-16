import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Dialog } from "@foldkit/ui"
import { TournamentList, TournamentView } from "./domain"

export const Message = defineMessageUnion({
  // Loading
  SucceededFetchTournaments: { tournaments: TournamentList },
  FailedFetchTournaments: { error: Schema.String },
  SucceededFetchTournament: { tournament: TournamentView },
  FailedFetchTournament: { error: Schema.String },
  /** A tournament changed on the coordinator (feed event factory.tournament). */
  ReceivedTournamentChange: { id: Schema.String },
  // Dialog
  ClickedOpenTournaments: {},
  GotDialogMessage: { message: Dialog.Message },
  ClickedTournament: { id: Schema.String },
  ClickedBackToList: {},
  ClickedRow: { id: Schema.String },
  // New tournament
  UpdatedSources: { value: Schema.String },
  ClickedPreset: { preset: Schema.Literals(["ui-skills", "prototypes"]) },
  UpdatedLimit: { value: Schema.String },
  SubmittedTournament: {},
  SucceededCreateTournament: { tournament: TournamentView },
  FailedCreateTournament: { error: Schema.String },
  // Control
  UpdatedResumeLimit: { value: Schema.String },
  ClickedResume: { id: Schema.String },
  ClickedStop: { id: Schema.String },
  SucceededControl: { tournament: TournamentView },
  FailedControl: { error: Schema.String },
})
export type Message = typeof Message.Type
