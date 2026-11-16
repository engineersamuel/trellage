// Payloads of /api/tournaments (coordinator src/tournament.ts): the list and one tournament with its leaderboard.
import { Schema } from "effect"
import { AsyncData } from "foldkit"

export const TournamentSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
  variants: Schema.Number,
  spentUsd: Schema.Number,
  limitUsd: Schema.Number,
  leader: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
})
export type TournamentSummary = typeof TournamentSummary.Type
export const TournamentList = Schema.Array(TournamentSummary)
export type TournamentList = typeof TournamentList.Type

const Shot = Schema.Struct({ page: Schema.String, viewport: Schema.String, file: Schema.String })
export type Shot = typeof Shot.Type

const Build = Schema.Struct({
  n: Schema.Number,
  status: Schema.String,
  error: Schema.optional(Schema.String),
  checks: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  shots: Schema.Array(Shot),
})

export const Row = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.String,
  generation: Schema.Number,
  rating: Schema.Number,
  vsBaseline: Schema.Number,
  games: Schema.Number,
  wins: Schema.Number,
  losses: Schema.Number,
  ties: Schema.Number,
  rubric: Schema.Record(Schema.String, Schema.Number),
  builds: Schema.Array(Build),
  skills: Schema.Array(Schema.String),
  sources: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
})
export type Row = typeof Row.Type

const Card = Schema.Struct({
  source: Schema.String,
  status: Schema.String,
  reason: Schema.optional(Schema.String),
})
export type Card = typeof Card.Type

/** One tournament as the detail view reads it; other fields of the payload are ignored. */
export const TournamentView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  threadId: Schema.optional(Schema.String),
  status: Schema.String,
  reason: Schema.NullOr(Schema.String),
  spentUsd: Schema.Number,
  limitUsd: Schema.Number,
  running: Schema.Boolean,
  cards: Schema.Record(Schema.String, Card),
  leaderboard: Schema.Array(Row),
  checks: Schema.Record(Schema.String, Schema.String),
  log: Schema.Array(Schema.Struct({ at: Schema.Number, text: Schema.String })),
})
export type TournamentView = typeof TournamentView.Type

export const TournamentListAsyncData = AsyncData.Schema(TournamentList, Schema.String)
export const TournamentViewAsyncData = AsyncData.Schema(TournamentView, Schema.String)

/** A screenshot through the coordinator's image route (it serves files under the state folder). */
export const shotUrl = (file: string): string => `/api/files/image?path=${encodeURIComponent(file)}`

/** Sources from the textarea: one per line; `#` comments and list bullets dropped. */
export const parseSources = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) =>
      line
        .replace(/\s#.*$|^#.*$/, "")
        .replace(/^[\s*-]+/, "")
        .trim(),
    )
    .filter((line) => line !== "")

export const usd = (n: number): string => `$${n.toFixed(2)}`
export const pct = (n: number): string => `${Math.round(n * 100)}%`
