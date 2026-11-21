import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { getJson, postJson } from "../api"
import { Detail, Folders, Lists, Status, Tasks } from "./domain"
import { Message } from "./message"
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
  messages: [Message.LoadedTasks, Message.Failed],
  execute: ({ id }) =>
    getJson(`/api/todo/lists/${encodeURIComponent(id)}/tasks`, Tasks).pipe(
      Effect.map((value) => Message.LoadedTasks({ value })),
      Effect.catch((error) => Effect.succeed(Message.Failed({ error }))),
    ),
})
export const LoadDetail = Command.define("LoadDetail", {
  args: { id: Schema.String },
  messages: [Message.LoadedDetail, Message.Failed],
  execute: ({ id }) =>
    getJson(`/api/todo/tasks/${encodeURIComponent(id)}`, Detail).pipe(
      Effect.map((value) => Message.LoadedDetail({ value })),
      Effect.catch((error) => Effect.succeed(Message.Failed({ error }))),
    ),
})
export const Draft = Command.define("Draft", {
  args: { folderId: Schema.String, listId: Schema.String, taskId: Schema.String },
  messages: [Message.Drafted, Message.Failed],
  execute: (args) =>
    postJson(
      "/api/drafts",
      {
        folderId: args.folderId,
        todo: { source: "ticktick", listId: args.listId, taskId: args.taskId },
      },
      Schema.Struct({ id: Schema.String }),
    ).pipe(
      Effect.map(({ id }) => {
        window.dispatchEvent(new CustomEvent("sf:select-worker", { detail: `draft-${id.slice(0, 8)}` }))
        return Message.Drafted({ id })
      }),
      Effect.catch((error) => Effect.succeed(Message.Failed({ error }))),
    ),
})
