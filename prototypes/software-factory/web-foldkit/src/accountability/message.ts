import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Dialog } from "@foldkit/ui"
import { Bucket, CalibrationList, ControlId, Dimension, Series, Table, WorkerPage } from "./domain"

export const Message = defineMessageUnion({
  ClickedOpenAccountability: {},
  ClickedWorker: { worker: Schema.String, thread: Schema.String },
  GotDialogMessage: { message: Dialog.Message },
  // Pickers
  SelectedDimension: { value: Dimension },
  SelectedBucket: { value: Bucket },
  UpdatedFrom: { value: Schema.String },
  UpdatedTo: { value: Schema.String },
  SelectedControl: { value: Schema.String },
  // Loading
  SucceededFetchSeries: { series: Series },
  FailedFetchSeries: { error: Schema.String },
  SucceededFetchTable: { table: Table },
  FailedFetchTable: { error: Schema.String },
  SucceededFetchWorst: { page: WorkerPage },
  FailedFetchWorst: { error: Schema.String },
  SucceededFetchCalibration: { calibration: CalibrationList },
  FailedFetchCalibration: { error: Schema.String },
  // Human labels for calibration
  ClickedLabel: {
    worker: Schema.String,
    control: ControlId,
    label: Schema.Literals(["pass", "fail"]),
  },
  SucceededLabel: {},
  FailedLabel: { error: Schema.String },
})
export type Message = typeof Message.Type
