// Payloads of the coordinator's /api/accountability/* routes. The schemas are shared/accountability.ts.
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { CONTROLS, Calibration, ControlId, SeriesPoint, WorkerPage } from "../../../shared/accountability"

export { CONTROLS, Calibration, ControlId, SeriesPoint, WorkerPage }
export type { Grade } from "../../../shared/accountability"

export const DIMENSIONS = ["model", "harness", "step", "repo", "goal", "modelSource"] as const
export const Dimension = Schema.Literals(DIMENSIONS)
export type Dimension = typeof Dimension.Type
export const Bucket = Schema.Literals(["day", "week"])
export type Bucket = typeof Bucket.Type
/** The chart plots the mean score, or the pass rate of one control. */
export const SCORE = "score"

export const Series = Schema.Array(SeriesPoint)
export const CalibrationList = Schema.Array(Calibration)
export type CalibrationList = typeof CalibrationList.Type

/** Pass rate of one control for one dimension value over the whole range. `rate` is null when n is 0. */
export const TableCell = Schema.Struct({
  control: ControlId,
  value: Schema.String,
  rate: Schema.NullOr(Schema.Number),
  n: Schema.Number,
})
export type TableCell = typeof TableCell.Type
export const Table = Schema.Array(TableCell)

export const LabelReply = Schema.Struct({
  worker: Schema.String,
  control: ControlId,
  label: Schema.String,
})

export const SeriesAsyncData = AsyncData.Schema(Series, Schema.String)
export const TableAsyncData = AsyncData.Schema(Table, Schema.String)
export const WorkerPageAsyncData = AsyncData.Schema(WorkerPage, Schema.String)
export const CalibrationAsyncData = AsyncData.Schema(CalibrationList, Schema.String)

/** Pass rates per bucket and value, merged to one rate per value: each point's rate counts n times. */
export const toCells = (control: ControlId, points: ReadonlyArray<SeriesPoint>): ReadonlyArray<TableCell> => {
  const sums = new Map<string, { pass: number; n: number }>()
  for (const { value, score, n } of points) {
    const sum = sums.get(value) ?? { pass: 0, n: 0 }
    if (score !== null) sums.set(value, { pass: sum.pass + score * n, n: sum.n + n })
    else sums.set(value, sum)
  }
  return [...sums].map(([value, { pass, n }]) => ({
    control,
    value,
    rate: n ? pass / n : null,
    n,
  }))
}
