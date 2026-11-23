import { Clock, Effect, Schema } from "effect"
import { Command, Dom } from "foldkit"
import { getJson, postJson } from "../api"
import { Detail, Folders, Lists, Status, Tasks } from "./domain"
import { Message } from "./message"
export const SEARCH_ID = "todo-search"
const LAST_FOLDER = "sf.todo.folder"
export const LoadStatus = Command.define("LoadStatus", {
  messages: [Message.LoadedStatus, Message.Failed],
  execute: getJson("/api/todo/status", Status).pipe(
    Effect.map((value) => Message.LoadedStatus({ value })),
    Effect.catch((error) => Effect.succeed(Message.Failed({ error }))),
  ),
})
export const LoadLists = Command.define("LoadLists", {
  messages: [Message.LoadedLists, Message.Failed],
  execute: getJson("/api/todo/lists", Lists).pipe(
    Effect.map((value) => Message.LoadedLists({ value })),
    Effect.catch((error) => Effect.succeed(Message.Failed({ error }))),
  ),
})
export const LoadFolders = Command.define("LoadFolders", {
  messages: [Message.LoadedFolders, Message.Failed],
  execute: getJson("/api/folders", Folders).pipe(
    Effect.map((value) => Message.LoadedFolders({ value })),
    Effect.catch((error) => Effect.succeed(Message.Failed({ error }))),
  ),
})
export const LoadTasks = Command.define("LoadTasks", {
  args: { id: Schema.String },
  messages: [Message.LoadedTasks, Message.FailedTasks],
  execute: ({ id }) =>
    getJson(`/api/todo/lists/${encodeURIComponent(id)}/tasks`, Tasks).pipe(
      Effect.map((value) => Message.LoadedTasks({ value, listId: id })),
      Effect.catch((error) => Effect.succeed(Message.FailedTasks({ error, listId: id }))),
    ),
})
export const LoadDetail = Command.define("LoadDetail", {
  args: { id: Schema.String, requestId: Schema.Number },
  messages: [Message.LoadedDetail, Message.FailedDetail],
  execute: ({ id, requestId }) =>
    getJson(`/api/todo/tasks/${encodeURIComponent(id)}`, Detail).pipe(
      Effect.map((value) => Message.LoadedDetail({ value, taskId: id, requestId })),
      Effect.catch((error) => Effect.succeed(Message.FailedDetail({ error, taskId: id, requestId }))),
    ),
})
export const ReadTime = Command.define("ReadTime", {
  messages: [Message.CompletedReadTime],
  execute: Clock.currentTimeMillis.pipe(Effect.map((now) => Message.CompletedReadTime({ now }))),
})
/** The repo the human last drafted into, from localStorage ("" when none). */
export const LoadLastFolder = Command.define("LoadLastFolder", {
  messages: [Message.LoadedLastFolder],
  execute: Effect.sync(() => Message.LoadedLastFolder({ value: globalThis.localStorage?.getItem(LAST_FOLDER) ?? "" })),
})
export const SaveLastFolder = Command.define("SaveLastFolder", {
  args: { id: Schema.String },
  messages: [Message.Completed],
  execute: ({ id }) =>
    Effect.sync(() => {
      globalThis.localStorage?.setItem(LAST_FOLDER, id)
      return Message.Completed()
    }),
})
export const FocusSearch = Command.define("FocusSearch", {
  messages: [Message.Completed],
  execute: Dom.focus(`#${SEARCH_ID}`).pipe(Effect.ignore, Effect.as(Message.Completed())),
})
export const ScrollToTask = Command.define("ScrollToTask", {
  args: { id: Schema.String },
  messages: [Message.Completed],
  execute: ({ id }) =>
    Dom.scrollIntoView(`[data-task="${id}"]`, { block: "nearest" }).pipe(Effect.ignore, Effect.as(Message.Completed())),
})
export const Draft = Command.define("Draft", {
  args: {
    folderId: Schema.String,
    prompt: Schema.optionalKey(Schema.String),
    listId: Schema.String,
    taskId: Schema.String,
  },
  messages: [Message.Drafted, Message.FailedDraft],
  execute: (args) =>
    postJson(
      "/api/drafts",
      {
        folderId: args.folderId,
        ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        todo: { source: "ticktick", listId: args.listId, taskId: args.taskId },
      },
      Schema.Struct({ id: Schema.String }),
    ).pipe(
      Effect.map(({ id }) => {
        window.dispatchEvent(new CustomEvent("sf:select-worker", { detail: `draft-${id.slice(0, 8)}` }))
        return Message.Drafted({ id })
      }),
      Effect.catch((error) => Effect.succeed(Message.FailedDraft({ error }))),
    ),
})
