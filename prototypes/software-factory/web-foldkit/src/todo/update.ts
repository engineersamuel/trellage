import { Option } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import { Draft, LoadDetail, LoadFolders, LoadLists, LoadStatus, LoadTasks } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
export const init = (): Update.Return<Model, Message> => ({
  model: {
    dialog: Dialog.init({ id: "todo" }),
    status: AsyncData.Idle(),
    lists: AsyncData.Idle(),
    tasks: AsyncData.Idle(),
    detail: AsyncData.Idle(),
    folders: AsyncData.Idle(),
    listId: "",
    taskId: "",
    folderId: "",
    error: "",
  },
})
const put = (m: Model, key: "status" | "lists" | "tasks" | "detail" | "folders", value: unknown): Model => ({
  ...m,
  [key]: AsyncData.succeed(value),
  error: "",
})
const fail = (m: Model, error: string): Model => modifyFields(m, { error: () => error })
const dialog = (model: Model, f: (d: Dialog.Model) => ReturnType<typeof Dialog.open>) =>
  Update.foldChildStep({
    update: f,
    read: (m: Model) => Option.some(m.dialog),
    write: (m: Model, d: Dialog.Model) => (d === m.dialog ? m : modifyFields(m, { dialog: () => d })),
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
    foldOutMessage: Dialog.OutMessage.match<Update.Step<Model, Message>>({
      Opened: () => (m) => ({ model: m }),
      Closed: () => (m) => ({ model: m }),
    }),
  })(model)
const open = (m: Model) => {
  const n = dialog(m, Dialog.open)
  const loading = modifyFields(n.model, {
    status: () => AsyncData.Loading(),
    lists: () => AsyncData.Loading(),
    folders: () => AsyncData.Loading(),
  })
  return {
    model: loading,
    commands: [LoadStatus(), LoadLists(), LoadFolders(), ...(n.commands ?? [])],
  }
}
const closed = (m: Model) => ({ model: m })
export const update = (m: Model, x: Message): Update.Return<Model, Message> =>
  Message.match(x, {
    ClickedOpen: () => (m.dialog.isOpen ? dialog(m, Dialog.close) : open(m)),
    GotDialogMessage: ({ message }) =>
      Update.foldChild({
        update: Dialog.update,
        read: (a: Model) => Option.some(a.dialog),
        write: (a: Model, b): Model => modifyFields(a, { dialog: () => b }),
        toParentMessage: (b) => Message.GotDialogMessage({ message: b }),
        foldOutMessage: Dialog.OutMessage.match({ Opened: () => closed, Closed: () => closed }),
      })(m, message),
    LoadedStatus: ({ value }) => ({ model: put(m, "status", value) }),
    LoadedLists: ({ value }) => ({ model: put(m, "lists", value) }),
    LoadedTasks: ({ value }) => ({ model: put(m, "tasks", value) }),
    LoadedDetail: ({ value }) => ({ model: put(m, "detail", value) }),
    LoadedFolders: ({ value }) => ({ model: put(m, "folders", value) }),
    Failed: ({ error }) => ({ model: fail(m, error) }),
    PickedList: ({ value }) => ({
      model: modifyFields(m, {
        listId: () => value,
        taskId: () => "",
        tasks: () => AsyncData.Loading(),
        detail: () => AsyncData.Idle(),
      }),
      commands: [LoadTasks({ id: value })],
    }),
    PickedTask: ({ value }) => ({
      model: modifyFields(m, { taskId: () => value, detail: () => AsyncData.Loading() }),
      commands: [LoadDetail({ id: value })],
    }),
    PickedFolder: ({ value }) => ({ model: modifyFields(m, { folderId: () => value }) }),
    ClickedDraft: () => ({
      model: m,
      commands:
        m.folderId && m.listId && m.taskId ? [Draft({ folderId: m.folderId, listId: m.listId, taskId: m.taskId })] : [],
    }),
    Drafted: () => dialog(m, Dialog.close),
  })
