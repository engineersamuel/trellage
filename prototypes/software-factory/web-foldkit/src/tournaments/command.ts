import { Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { getJson, postJson } from "../api"
import { TournamentList, TournamentView } from "./domain"
import { Message } from "./message"

export const FetchTournaments = Command.define("FetchTournaments", {
  messages: [Message.SucceededFetchTournaments, Message.FailedFetchTournaments],
  execute: getJson("/api/tournaments", TournamentList).pipe(
    Effect.map((tournaments) => Message.SucceededFetchTournaments({ tournaments })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchTournaments({ error }))),
  ),
})

export const FetchTournament = Command.define("FetchTournament", {
  args: { id: Schema.String },
  messages: [Message.SucceededFetchTournament, Message.FailedFetchTournament],
  execute: ({ id }) =>
    getJson(`/api/tournaments/${encodeURIComponent(id)}`, TournamentView).pipe(
      Effect.map((tournament) => Message.SucceededFetchTournament({ tournament })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchTournament({ error }))),
    ),
})

export const CreateTournament = Command.define("CreateTournament", {
  args: {
    preset: Schema.Literals(["ui-skills", "prototypes"]),
    sources: Schema.Array(Schema.String),
    idea: Schema.String,
    maybeLimitUsd: Schema.Option(Schema.Number),
  },
  messages: [Message.SucceededCreateTournament, Message.FailedCreateTournament],
  execute: ({ preset, sources, idea, maybeLimitUsd }) =>
    postJson(
      "/api/tournaments",
      {
        preset,
        ...(preset === "ui-skills" ? { sources } : { idea }),
        ...Option.match(maybeLimitUsd, { onNone: () => ({}), onSome: (limitUsd) => ({ limitUsd }) }),
      },
      TournamentView,
    ).pipe(
      Effect.map((tournament) => Message.SucceededCreateTournament({ tournament })),
      Effect.catch((error) => Effect.succeed(Message.FailedCreateTournament({ error }))),
    ),
})

export const ControlTournament = Command.define("ControlTournament", {
  args: {
    id: Schema.String,
    action: Schema.Literals(["resume", "stop"]),
    maybeLimitUsd: Schema.Option(Schema.Number),
  },
  messages: [Message.SucceededControl, Message.FailedControl],
  execute: ({ id, action, maybeLimitUsd }) =>
    postJson(
      `/api/tournaments/${encodeURIComponent(id)}/${action}`,
      Option.match(maybeLimitUsd, { onNone: () => ({}), onSome: (limitUsd) => ({ limitUsd }) }),
      TournamentView,
    ).pipe(
      Effect.map((tournament) => Message.SucceededControl({ tournament })),
      Effect.catch((error) => Effect.succeed(Message.FailedControl({ error }))),
    ),
})
