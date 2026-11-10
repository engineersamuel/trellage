import { Array, Equal, Option, Result, String } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import type { Worker } from "../domain"
import { AbortWorker, FetchBacklog, FetchWorkers, SendToWorker, StopWorker } from "./command"
import { mergeLines, toEventLines } from "./log"
import { Message, OutMessage } from "./message"
import { type Model, WorkersAsyncData } from "./model"

export const init = (selectedWorkerId: string): Update.Return<Model, Message> => ({
  model: {
    workers: WorkersAsyncData.Loading(),
    selectedWorkerId,
    logLines: [],
    messageDraft: "",
    isRawLogVisible: false,
    areCrittersVisible: false,
    maybeError: Option.none(),
    removeDialog: Dialog.init({ id: "remove-worker" }),
    maybePendingRemoval: Option.none(),
  },
  commands: [FetchWorkers(), FetchBacklog({ workerId: selectedWorkerId })],
})

const upsertWorker = (workers: ReadonlyArray<Worker>, worker: Worker): ReadonlyArray<Worker> =>
  Array.some(workers, ({ id }) => id === worker.id)
    ? Array.map(workers, (current) => (current.id === worker.id ? worker : current))
    : Array.append(workers, worker)

const listedWorkers = (model: Model): ReadonlyArray<Worker> =>
  AsyncData.getOrElse(model.workers, (): ReadonlyArray<Worker> => [])

const refreshWorkers = Update.refresh<Model, Message, ReadonlyArray<Worker>, string>({
  read: (model) => Option.some(model.workers),
  revalidate: AsyncData.revalidateOrLoad,
  write: (model, workers) => modifyFields(model, { workers: () => workers }),
  load: FetchWorkers(),
})

const showError = (model: Model, error: string): Model => modifyFields(model, { maybeError: () => Option.some(error) })

/** The name the list shows for a worker; its id when it is not in the list. */
export const workerName = (model: Model, workerId: string): string =>
  Option.match(
    Array.findFirst(listedWorkers(model), ({ id }) => id === workerId),
    { onNone: () => workerId, onSome: ({ name }) => name },
  )

const removeDialogFold = {
  read: (model: Model) => Option.some(model.removeDialog),
  write: (model: Model, removeDialog: Dialog.Model) =>
    removeDialog === model.removeDialog ? model : modifyFields(model, { removeDialog: () => removeDialog }),
  toParentMessage: (message: Dialog.Message) => Message.GotRemoveDialogMessage({ message }),
  // However the dialog closes (Cancel, Escape, backdrop, confirm), nothing waits for removal any more.
  foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model: modifyFields(model, { maybePendingRemoval: () => Option.none() }) }),
  }),
}

const foldRemoveDialog = Update.foldChild({ ...removeDialogFold, update: Dialog.update })
const openRemoveDialog = Update.foldChildStep({ ...removeDialogFold, update: Dialog.open })
const closeRemoveDialog = Update.foldChildStep({ ...removeDialogFold, update: Dialog.close })

/** Ask before removing: the remove ends the worker's session for good. */
const requestRemoval = (model: Model, workerId: string) =>
  Update.combine(model, [
    (stepModel) => ({ model: modifyFields(stepModel, { maybePendingRemoval: () => Option.some(workerId) }) }),
    openRemoveDialog,
  ])

const confirmRemoval = (model: Model) =>
  Option.match(model.maybePendingRemoval, {
    onNone: () => closeRemoveDialog(model),
    onSome: (workerId) =>
      Update.combine(model, [
        (stepModel) => ({ model: stepModel, commands: [StopWorker({ workerId })] }),
        closeRemoveDialog,
      ]),
  })

/** Abort a worker's current run. The parent calls this for the abort hotkey. */
export const abort =
  (workerId: string) =>
  (model: Model): Update.Return<Model, Message> => ({ model, commands: [AbortWorker({ workerId })] })

/** Select a worker: reset the log and the error, and load its backlog. The parent calls this when the focus setting changes. */
export const focus =
  (workerId: string) =>
  (model: Model): Update.Return<Model, Message> =>
    workerId === model.selectedWorkerId
      ? { model }
      : {
          model: modifyFields(model, {
            selectedWorkerId: () => workerId,
            logLines: () => [],
            maybeError: () => Option.none(),
          }),
          commands: [FetchBacklog({ workerId })],
        }

/** Turn the row critters on or off (setting `critters`). */
export const showCritters =
  (isOn: boolean) =>
  (model: Model): Update.Return<Model, Message> =>
    isOn === model.areCrittersVisible ? { model } : { model: modifyFields(model, { areCrittersVisible: () => isOn }) }

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(message, {
    SucceededFetchWorkers: ({ workers }) => ({
      model: modifyFields(model, { workers: () => AsyncData.succeed(workers) }),
    }),
    FailedFetchWorkers: ({ error }) => ({
      model: modifyFields(model, { workers: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    SucceededFetchBacklog: ({ workerId, lines }) =>
      workerId === model.selectedWorkerId
        ? { model: modifyFields(model, { logLines: (logLines) => mergeLines(logLines, lines) }) }
        : { model },
    FailedFetchBacklog: ({ error }) => ({ model: showError(model, error) }),
    // The coordinator reports a worker after every model call; an identical report keeps the same Model.
    ReceivedWorkerUpdate: ({ worker }) =>
      Array.some(listedWorkers(model), (current) => Equal.equals(current, worker))
        ? { model }
        : { model: modifyFields(model, { workers: AsyncData.map((workers) => upsertWorker(workers, worker)) }) },
    ReceivedWorkerStopped: ({ workerId }) =>
      Array.some(listedWorkers(model), ({ id }) => id === workerId)
        ? { model: modifyFields(model, { workers: AsyncData.map(Array.filter(({ id }) => id !== workerId)) }) }
        : { model },
    // Deltas and events of other workers add no line: the same Model, so the page does not render again.
    ReceivedWorkerEvent: ({ event }) => {
      if (event.workerId !== model.selectedWorkerId) return { model }
      const logLines = mergeLines(model.logLines, toEventLines(event))
      return { model: logLines === model.logLines ? model : modifyFields(model, { logLines: () => logLines }) }
    },
    // After a feed gap the worker list and the log may be stale: reload both.
    ReceivedFeedGap: () =>
      Update.combine(model, [
        refreshWorkers,
        (stepModel) => ({ model: stepModel, commands: [FetchBacklog({ workerId: stepModel.selectedWorkerId })] }),
      ]),
    ClickedWorker: ({ workerId }) => ({ model, outMessage: OutMessage.SelectedWorker({ workerId }) }),
    UpdatedMessageDraft: ({ value }) => ({ model: modifyFields(model, { messageDraft: () => value }) }),
    SubmittedMessageDraft: () =>
      String.isEmpty(model.messageDraft.trim())
        ? { model }
        : { model, commands: [SendToWorker({ workerId: model.selectedWorkerId, prompt: model.messageDraft })] },
    // Clear the draft only when it still holds what was sent: the user may have typed on meanwhile.
    SucceededSendToWorker: ({ prompt }) => ({
      model: modifyFields(model, {
        messageDraft: (draft) => (draft === prompt ? "" : draft),
        maybeError: () => Option.none(),
      }),
    }),
    FailedSendToWorker: ({ workerId, error }) => ({
      model: showError(model, `Could not send to ${workerName(model, workerId)}: ${error}`),
    }),
    ClickedCancelRun: ({ workerId }) => abort(workerId)(model),
    SucceededAbortWorker: () => ({ model }),
    FailedAbortWorker: ({ workerId, error }) => ({
      model: showError(model, `Could not cancel the run of ${workerName(model, workerId)}: ${error}`),
    }),
    ClickedRemove: ({ workerId }) => requestRemoval(model, workerId),
    ConfirmedRemove: () => confirmRemoval(model),
    GotRemoveDialogMessage: ({ message: childMessage }) => foldRemoveDialog(model, childMessage),
    SucceededStopWorker: () => ({ model }),
    FailedStopWorker: ({ workerId, error }) => ({
      model: showError(model, `Could not remove ${workerName(model, workerId)}: ${error}`),
    }),
    ToggledRawLog: ({ isChecked }) => ({ model: modifyFields(model, { isRawLogVisible: () => isChecked }) }),
    ClickedDismissError: () => ({ model: modifyFields(model, { maybeError: () => Option.none() }) }),
    CompletedMountTranscript: () => ({ model }),
    CompletedMountCritter: () => ({ model }),
  })
