import { Schema } from "effect"
import { Dialog } from "@foldkit/ui"
import { Bucket, CalibrationAsyncData, Dimension, SeriesAsyncData, TableAsyncData, WorkerPageAsyncData } from "./domain"

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  dimension: Dimension,
  bucket: Bucket,
  /** Date range as YYYY-MM-DD; empty is no bound. */
  from: Schema.String,
  to: Schema.String,
  /** "score" or a control id. */
  control: Schema.String,
  series: SeriesAsyncData.schema,
  table: TableAsyncData.schema,
  /** The lowest-scoring workers in the range. */
  worst: WorkerPageAsyncData.schema,
  calibration: CalibrationAsyncData.schema,
  /** Why the last label was not saved. */
  maybeLabelError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
