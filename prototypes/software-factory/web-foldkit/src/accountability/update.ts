import { Option, Result } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import { FetchCalibration, FetchSeries, FetchTable, FetchWorst, SaveLabel } from "./command"
import { SCORE } from "./domain"
import { Message } from "./message"
import type { Model } from "./model"

type UpdateReturn = Update.Return<Model, Message>
type Step = Update.Step<Model, Message>

export const DIALOG_ID = "accountability"

/** Starts on all time (no from, no to) and the mean score by model per day. */
export const init = (): UpdateReturn => ({
  model: {
    dialog: Dialog.init({ id: DIALOG_ID }),
    dimension: "model",
    bucket: "day",
    from: "",
    to: "",
    control: SCORE,
    series: AsyncData.Idle(),
    table: AsyncData.Idle(),
    worst: AsyncData.Idle(),
    calibration: AsyncData.Idle(),
    maybeLabelError: Option.none(),
  },
})

const toDialogMessage = (message: Dialog.Message) => Message.GotDialogMessage({ message })
const readDialog = (model: Model) => Option.some(model.dialog)
const writeDialog = (model: Model, dialog: Dialog.Model) =>
  dialog === model.dialog ? model : modifyFields(model, { dialog: () => dialog })
const foldOutMessage = Dialog.OutMessage.match<Step>({
  Opened: () => (model) => ({ model }),
  Closed: () => (model) => ({ model }),
})

const dialogStep = (f: (dialog: Dialog.Model) => ReturnType<typeof Dialog.open>) =>
  Update.foldChildStep({
    update: f,
    read: readDialog,
    write: writeDialog,
    toParentMessage: toDialogMessage,
    foldOutMessage,
  })

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toDialogMessage,
  foldOutMessage,
})

const reload = <A, E>(current: AsyncData.AsyncData<A, E>) =>
  Option.getOrElse(AsyncData.revalidateOrLoad(current), () => current)

const fetchSeries = (m: Model) =>
  FetchSeries({
    dimension: m.dimension,
    bucket: m.bucket,
    control: m.control,
    from: m.from,
    to: m.to,
  })
const fetchTable = (m: Model) => FetchTable({ dimension: m.dimension, from: m.from, to: m.to })
const fetchWorst = (m: Model) => FetchWorst({ from: m.from, to: m.to })

/** Every picker change fetches what it changes: the chart always, the table for dimension and range, workers for range. */
const pick = (model: Model, next: Model, what: { table: boolean; worst: boolean }): UpdateReturn => ({
  model: modifyFields(next, {
    series: reload,
    table: (current) => (what.table ? reload(current) : current),
    worst: (current) => (what.worst ? reload(current) : current),
  }),
  commands: [fetchSeries(next), ...(what.table ? [fetchTable(next)] : []), ...(what.worst ? [fetchWorst(next)] : [])],
})

/** Opening loads every panel fresh. */
const open: Step = (model) =>
  Update.combine(modifyFields(model, { series: reload, table: reload, worst: reload, calibration: reload }), [
    dialogStep(Dialog.open),
    (next) => ({
      model: next,
      commands: [fetchSeries(next), fetchTable(next), fetchWorst(next), FetchCalibration()],
    }),
  ])

const fail = <A>(current: AsyncData.AsyncData<A, string>, error: string) =>
  AsyncData.settle(current, Result.fail(error))

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedOpenAccountability: () => (model.dialog.isOpen ? dialogStep(Dialog.close)(model) : open(model)),
    ClickedWorker: () => ({ model }),
    GotDialogMessage: ({ message: dialogMessage }) => foldDialog(model, dialogMessage),
    SelectedDimension: ({ value }) =>
      pick(model, modifyFields(model, { dimension: () => value }), { table: true, worst: false }),
    SelectedBucket: ({ value }) =>
      pick(model, modifyFields(model, { bucket: () => value }), { table: false, worst: false }),
    UpdatedFrom: ({ value }) => pick(model, modifyFields(model, { from: () => value }), { table: true, worst: true }),
    UpdatedTo: ({ value }) => pick(model, modifyFields(model, { to: () => value }), { table: true, worst: true }),
    SelectedControl: ({ value }) =>
      pick(model, modifyFields(model, { control: () => value }), { table: false, worst: false }),
    SucceededFetchSeries: ({ series }) => ({
      model: modifyFields(model, { series: () => AsyncData.succeed(series) }),
    }),
    FailedFetchSeries: ({ error }) => ({
      model: modifyFields(model, { series: (c) => fail(c, error) }),
    }),
    SucceededFetchTable: ({ table }) => ({
      model: modifyFields(model, { table: () => AsyncData.succeed(table) }),
    }),
    FailedFetchTable: ({ error }) => ({
      model: modifyFields(model, { table: (c) => fail(c, error) }),
    }),
    SucceededFetchWorst: ({ page }) => ({
      model: modifyFields(model, { worst: () => AsyncData.succeed(page) }),
    }),
    FailedFetchWorst: ({ error }) => ({
      model: modifyFields(model, { worst: (c) => fail(c, error) }),
    }),
    SucceededFetchCalibration: ({ calibration }) => ({
      model: modifyFields(model, { calibration: () => AsyncData.succeed(calibration) }),
    }),
    FailedFetchCalibration: ({ error }) => ({
      model: modifyFields(model, { calibration: (c) => fail(c, error) }),
    }),
    ClickedLabel: ({ worker, control, label }) => ({
      model: modifyFields(model, { maybeLabelError: () => Option.none() }),
      commands: [SaveLabel({ worker, control, label })],
    }),
    SucceededLabel: () => ({
      model: modifyFields(model, { calibration: reload }),
      commands: [FetchCalibration()],
    }),
    FailedLabel: ({ error }) => ({
      model: modifyFields(model, { maybeLabelError: () => Option.some(error) }),
    }),
  })
