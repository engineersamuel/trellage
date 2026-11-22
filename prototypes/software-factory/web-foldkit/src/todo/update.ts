import { Array, Option } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import {
  Draft,
  FocusSearch,
  LoadDetail,
  LoadFolders,
  LoadLastFolder,
  LoadLists,
  LoadStatus,
  LoadTasks,
  ReadTime,
  SaveLastFolder,
  ScrollToTask,
} from "./command"
import { Message } from "./message"
import { canDraft, detailOf, listOfTask } from "./model"
import type { Model } from "./model"
import { atList, groupOf, rows } from "./timeline"
export const init = (): Update.Return<Model, Message> => ({
  model: {
    dialog: Dialog.init({ id: "todo" }),
    status: AsyncData.Idle(),
    lists: AsyncData.Idle(),
    tasks: {},
    failedLists: [],
    detail: AsyncData.Idle(),
    folders: AsyncData.Idle(),
    listId: "",
    taskId: "",
    folderId: "",
    query: "",
    prompt: "",
    expanded: [],
    now: 0,
    detailRequestId: 0,
    error: "",
    drafting: false,
  },
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
  return {
    model: modifyFields(n.model, {
      status: () => AsyncData.Loading(),
      lists: () => AsyncData.Loading(),
      folders: () => AsyncData.Loading(),
      tasks: () => ({}),
      failedLists: () => [],
      taskId: () => "",
      detail: () => AsyncData.Idle(),
      prompt: () => "",
      query: () => "",
      expanded: () => [],
      error: () => "",
    }),
    commands: [
      ReadTime(),
      LoadStatus(),
      LoadLists(),
      LoadFolders(),
      LoadLastFolder(),
      FocusSearch(),
      ...(n.commands ?? []),
    ],
  }
}
const closed = (m: Model) => ({ model: m })
/** Select a task: load its detail (the draft prompt) and scroll it into view. */
const pick = (m: Model, taskId: string): Update.Return<Model, Message> => {
  if (!taskId || (taskId === m.taskId && !AsyncData.isFailure(m.detail))) return { model: m }
  const requestId = m.detailRequestId + 1
  return {
    model: modifyFields(m, {
      taskId: () => taskId,
      detail: () => AsyncData.Loading(),
      prompt: () => "",
      detailRequestId: () => requestId,
    }),
    commands: [LoadDetail({ id: taskId, requestId }), ScrollToTask({ id: taskId })],
  }
}
/** The task before or after the selected one in the timeline; moving into a collapsed group opens it. */
const step = (m: Model, by: 1 | -1): Update.Return<Model, Message> => {
  const lists = Option.getOrElse(AsyncData.getData(m.lists), () => [])
  const shown = rows(lists, m.tasks, atList(lists, m.query)?.id ?? m.listId, m.query)
  const at = shown.findIndex((r) => r.task.id === m.taskId)
  const next = at < 0 ? (by === 1 ? shown.at(0) : shown.at(-1)) : shown.at(at + by)
  if (!next) return { model: m }
  const group = groupOf(next, m.now)
  const opened = m.expanded.includes(group) ? m : modifyFields(m, { expanded: (e) => [...e, group] })
  return pick(opened, next.task.id)
}
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
    CompletedReadTime: ({ now }) => ({ model: modifyFields(m, { now: () => now }) }),
    LoadedStatus: ({ value }) => ({
      model: modifyFields(m, { status: () => AsyncData.succeed(value) }),
    }),
    // Every list loads at once, so search and All lists cover every task.
    LoadedLists: ({ value }) => ({
      model: modifyFields(m, { lists: () => AsyncData.succeed(value) }),
      commands: value.map((l) => LoadTasks({ id: l.id })),
    }),
    LoadedTasks: ({ value, listId }) => ({
      model: modifyFields(m, {
        tasks: (t) => ({ ...t, [listId]: value }),
        failedLists: Array.filter((id) => id !== listId),
      }),
    }),
    FailedTasks: ({ error, listId }) => ({
      model: modifyFields(fail(m, error), {
        failedLists: (f) => (f.includes(listId) ? f : [...f, listId]),
      }),
    }),
    LoadedDetail: ({ value, taskId, requestId }) => ({
      model:
        m.taskId === taskId && m.detailRequestId === requestId
          ? modifyFields(m, {
              detail: () => AsyncData.succeed(value),
              prompt: () => value.prompt ?? "",
            })
          : m,
    }),
    FailedDetail: ({ error, taskId, requestId }) => ({
      model:
        m.taskId === taskId && m.detailRequestId === requestId
          ? modifyFields(fail(m, error), { detail: () => AsyncData.fail(error) })
          : m,
    }),
    LoadedFolders: ({ value }) => ({
      model: modifyFields(m, { folders: () => AsyncData.succeed(value) }),
    }),
    LoadedLastFolder: ({ value }) => ({
      model: m.folderId ? m : modifyFields(m, { folderId: () => value }),
    }),
    Failed: ({ error }) => ({ model: fail(m, error) }),
    PickedList: ({ value }) => ({
      model: modifyFields(m, { listId: () => value, query: (q) => q.replace(/@\S*\s?/g, "") }),
    }),
    PickedTask: ({ value }) => pick(m, value),
    PickedFolder: ({ value }) => ({ model: modifyFields(m, { folderId: () => value }) }),
    ChangedQuery: ({ value }) => ({ model: modifyFields(m, { query: () => value }) }),
    ChangedPrompt: ({ value }) => ({ model: modifyFields(m, { prompt: () => value }) }),
    ClickedMore: ({ group }) => ({ model: modifyFields(m, { expanded: (e) => [...e, group] }) }),
    PressedNext: () => step(m, 1),
    PressedPrevious: () => step(m, -1),
    PressedSearch: () => ({ model: m, commands: [FocusSearch()] }),
    PressedClear: () => ({ model: modifyFields(m, { query: () => "" }) }),
    ClickedDraft: () => {
      const detail = detailOf(m)
      if (!canDraft(m) || !detail) return { model: m }
      const listId = detail.task.projectId ?? listOfTask(m, m.taskId)
      const edited = m.prompt.trim() && m.prompt !== detail.prompt ? m.prompt : undefined
      return {
        model: modifyFields(m, { drafting: () => true, error: () => "" }),
        commands: [
          Draft({
            folderId: m.folderId,
            listId,
            taskId: m.taskId,
            ...(edited ? { prompt: edited } : {}),
          }),
          SaveLastFolder({ id: m.folderId }),
        ],
      }
    },
    Drafted: () => dialog(modifyFields(m, { drafting: () => false }), Dialog.close),
    FailedDraft: ({ error }) => ({
      model: modifyFields(fail(m, error), { drafting: () => false }),
    }),
    Completed: () => ({ model: m }),
  })
