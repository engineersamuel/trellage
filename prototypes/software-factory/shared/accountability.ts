import { Schema } from "effect"

export const ControlId = Schema.Literals(["3.1", "3.5", "4.2", "4.6", "4.7", "4.8", "4.9", "5.2/6.3", "5.5"])
export type ControlId = typeof ControlId.Type

export const Result = Schema.Literals(["pass", "fail", "n/a", "unknown"])
export type Result = typeof Result.Type

export const ControlResult = Schema.Struct({
  result: Result,
  p: Schema.optionalKey(Schema.Number),
  value: Schema.optionalKey(Schema.Number),
})
export type ControlResult = typeof ControlResult.Type

export const CONTROLS = [
  { id: "3.1", title: "Documented, scoped purpose", kind: "decision" },
  { id: "3.5", title: "Defined budget", kind: "code" },
  { id: "4.2", title: "Role-derived least privilege", kind: "metric" },
  { id: "4.6", title: "Authority is not content", kind: "decision" },
  { id: "4.7", title: "Intent-bounded authorization", kind: "decision" },
  { id: "4.8", title: "Bounded egress", kind: "code" },
  { id: "4.9", title: "Execution containment", kind: "code" },
  { id: "5.2/6.3", title: "Runtime deviation surfacing, Pre-defined escalation", kind: "decision" },
  { id: "5.5", title: "Performance against role", kind: "code" },
] as const satisfies ReadonlyArray<{ id: ControlId; title: string; kind: "code" | "decision" | "metric" }>

export const Grade = Schema.Struct({
  worker: Schema.String,
  owner: Schema.String,
  thread: Schema.NullOr(Schema.String),
  goal: Schema.NullOr(Schema.String),
  folderId: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  step: Schema.NullOr(Schema.String),
  model: Schema.String,
  harness: Schema.String,
  modelSource: Schema.String,
  roleCardSha256: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  stoppedAt: Schema.Number,
  costUsd: Schema.Number,
  budgetUsd: Schema.Number,
  controls: Schema.Record(ControlId, ControlResult),
  score: Schema.NullOr(Schema.Number),
  engine: Schema.String,
  graderVersion: Schema.String,
  gradedAt: Schema.Number,
  extract: Schema.String,
})
export type Grade = typeof Grade.Type

export const Calibration = Schema.Struct({
  control: ControlId,
  labels: Schema.Number,
  agree: Schema.Number,
  agreement: Schema.Number,
  calibrated: Schema.Boolean,
})
export type Calibration = typeof Calibration.Type

export const SeriesPoint = Schema.Struct({
  bucket: Schema.String,
  value: Schema.String,
  score: Schema.NullOr(Schema.Number),
  n: Schema.Number,
})
export type SeriesPoint = typeof SeriesPoint.Type

export const WorkerPage = Schema.Struct({
  rows: Schema.Array(Grade),
  total: Schema.Number,
})
export type WorkerPage = typeof WorkerPage.Type
