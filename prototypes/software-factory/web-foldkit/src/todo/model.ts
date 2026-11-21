import { Schema } from "effect"
import { Dialog } from "@foldkit/ui"
import { AsyncDetail, AsyncFolders, AsyncLists, AsyncStatus, AsyncTasks } from "./domain"
export const Model = Schema.Struct({
  dialog: Dialog.Model,
  status: AsyncStatus.schema,
  lists: AsyncLists.schema,
  tasks: AsyncTasks.schema,
  detail: AsyncDetail.schema,
  folders: AsyncFolders.schema,
  listId: Schema.String,
  taskId: Schema.String,
  folderId: Schema.String,
  error: Schema.String,
})
export type Model = typeof Model.Type
