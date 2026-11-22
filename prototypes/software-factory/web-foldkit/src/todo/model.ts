import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
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
  listRequestId: Schema.Number,
  detailRequestId: Schema.Number,
  detailListId: Schema.String,
  error: Schema.String,
  drafting: Schema.Boolean,
})
export type Model = typeof Model.Type
export const canDraft = (model: Model): boolean => {
  const detail = Option.getOrUndefined(AsyncData.getData(model.detail))
  return Boolean(
    !model.drafting &&
    model.folderId &&
    model.listId &&
    model.taskId &&
    model.detailListId === model.listId &&
    detail?.task.id === model.taskId,
  )
}
