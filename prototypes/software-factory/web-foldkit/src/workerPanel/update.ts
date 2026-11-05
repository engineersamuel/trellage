import { Array, Option, Result, String } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Worker } from "../domain";
import { FetchBacklog, FetchWorkers, SendToWorker, StopWorker } from "./command";
import { mergeLines, toEventLines } from "./log";
import { Message, OutMessage } from "./message";
import { type Model, WorkersAsyncData } from "./model";

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

export const init = (selectedWorkerId: string): Update.Return<Model, Message> => ({
  model: {
    workers: WorkersAsyncData.Loading(),
    selectedWorkerId,
    logLines: [],
    messageDraft: "",
    isRawLogVisible: false,
    maybeError: Option.none(),
  },
  commands: [FetchWorkers(), FetchBacklog({ workerId: selectedWorkerId })],
});

const upsertWorker = (workers: ReadonlyArray<Worker>, worker: Worker): ReadonlyArray<Worker> =>
  Array.some(workers, ({ id }) => id === worker.id)
    ? Array.map(workers, (current) => (current.id === worker.id ? worker : current))
    : Array.append(workers, worker);

const refreshWorkers = Update.refresh<Model, Message, ReadonlyArray<Worker>, string>({
  read: (model) => Option.some(model.workers),
  revalidate: AsyncData.revalidateOrLoad,
  write: (model, workers) => modifyFields(model, { workers: () => workers }),
  load: FetchWorkers(),
});

const showError = (model: Model, error: string): Model => modifyFields(model, { maybeError: () => Option.some(error) });

/** Show an error that happened outside the panel (for example a failed abort). */
export const reportError =
  (error: string) =>
  (model: Model): Update.Return<Model, Message> => ({ model: showError(model, error) });

/** Select a worker: reset the log and load its backlog. The parent calls this when the focus setting changes. */
export const focus =
  (workerId: string) =>
  (model: Model): Update.Return<Model, Message> =>
  workerId === model.selectedWorkerId
    ? { model }
    : {
        model: modifyFields(model, { selectedWorkerId: () => workerId, logLines: () => [] }),
        commands: [FetchBacklog({ workerId })],
      };

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchWorkers: ({ workers }) => ({ model: modifyFields(model, { workers: () => AsyncData.succeed(workers) }) }),
    FailedFetchWorkers: ({ error }) => ({
      model: modifyFields(model, { workers: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    SucceededFetchBacklog: ({ workerId, lines }) =>
      workerId === model.selectedWorkerId
        ? { model: modifyFields(model, { logLines: (logLines) => mergeLines(logLines, lines) }) }
        : { model },
    FailedFetchBacklog: ({ error }) => ({ model: showError(model, error) }),
    ReceivedWorkerUpdate: ({ worker }) => ({
      model: modifyFields(model, { workers: AsyncData.map((workers) => upsertWorker(workers, worker)) }),
    }),
    ReceivedWorkerStopped: ({ workerId }) => ({
      model: modifyFields(model, { workers: AsyncData.map(Array.filter(({ id }) => id !== workerId)) }),
    }),
    ReceivedWorkerEvent: ({ event }) =>
      event.workerId === model.selectedWorkerId
        ? { model: modifyFields(model, { logLines: (logLines) => mergeLines(logLines, toEventLines(event)) }) }
        : { model },
    // After a feed gap the worker list and the log may be stale: reload both.
    ReceivedFeedGap: () =>
      Update.combine(model, [refreshWorkers, (stepModel) => ({ model: stepModel, commands: [FetchBacklog({ workerId: stepModel.selectedWorkerId })] })]),
    ClickedWorker: ({ workerId }) => ({ model, outMessage: OutMessage.SelectedWorker({ workerId }) }),
    UpdatedMessageDraft: ({ value }) => ({ model: modifyFields(model, { messageDraft: () => value }) }),
    SubmittedMessageDraft: () =>
      String.isEmpty(model.messageDraft.trim())
        ? { model }
        : { model, commands: [SendToWorker({ workerId: model.selectedWorkerId, prompt: model.messageDraft })] },
    // Clear the draft only when it still holds what was sent: the user may have typed on meanwhile.
    SucceededSendToWorker: ({ prompt }) => ({
      model: modifyFields(model, { messageDraft: (draft) => (draft === prompt ? "" : draft), maybeError: () => Option.none() }),
    }),
    FailedSendToWorker: ({ error }) => ({ model: showError(model, `Send failed: ${error}`) }),
    ClickedStop: ({ workerId }) => ({ model, commands: [StopWorker({ workerId })] }),
    SucceededStopWorker: () => ({ model }),
    FailedStopWorker: ({ error }) => ({ model: showError(model, `Stop failed: ${error}`) }),
    ToggledRawLog: ({ isChecked }) => ({ model: modifyFields(model, { isRawLogVisible: () => isChecked }) }),
    ClickedDismissError: () => ({ model: modifyFields(model, { maybeError: () => Option.none() }) }),
    CompletedMountTranscript: () => ({ model }),
  });
