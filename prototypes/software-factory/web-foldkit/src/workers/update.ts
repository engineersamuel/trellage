import { Array, Equal, Option, Result } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { Worker } from "../domain"
import { AbortWorker, FetchWorkers } from "./command"
import { Message } from "./message"
import { type Model, WorkersAsyncData } from "./model"

export const init = (): Update.Return<Model, Message> => ({
  model: { workers: WorkersAsyncData.Loading() },
  commands: [FetchWorkers()],
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

/** Abort a worker's current run. The parent calls this for the abort hotkey. */
export const abort =
  (workerId: string) =>
  (model: Model): Update.Return<Model, Message> => ({ model, commands: [AbortWorker({ workerId })] })

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededFetchWorkers: ({ workers }) => ({
      model: modifyFields(model, { workers: () => AsyncData.succeed(workers) }),
    }),
    FailedFetchWorkers: ({ error }) => ({
      model: modifyFields(model, { workers: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    // The coordinator reports a worker after every model call; an identical report keeps the same Model.
    ReceivedWorkerUpdate: ({ worker }) =>
      Array.some(listedWorkers(model), (current) => Equal.equals(current, worker))
        ? { model }
        : { model: modifyFields(model, { workers: AsyncData.map((workers) => upsertWorker(workers, worker)) }) },
    ReceivedWorkerStopped: ({ workerId }) =>
      Array.some(listedWorkers(model), ({ id }) => id === workerId)
        ? { model: modifyFields(model, { workers: AsyncData.map(Array.filter(({ id }) => id !== workerId)) }) }
        : { model },
    ReceivedFeedGap: () => refreshWorkers(model),
    SucceededAbortWorker: () => ({ model }),
    // The hotkey has no place to show an error; the Inbox shows the coordinator's state and its own Stop button.
    FailedAbortWorker: () => ({ model }),
  })
