import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { Dialog } from "@foldkit/ui"
import { AsyncDetail, AsyncFolders, AsyncLists, AsyncStatus, Tasks } from "./domain"
export const Model = Schema.Struct({
  dialog: Dialog.Model,
  status: AsyncStatus.schema,
  lists: AsyncLists.schema,
  /** Tasks per list id, as loaded; a list missing here is not loaded yet. */
  tasks: Schema.Record(Schema.String, Tasks),
  /** Lists whose tasks failed to load. */
  failedLists: Schema.Array(Schema.String),
  detail: AsyncDetail.schema,
  folders: AsyncFolders.schema,
  /** List shown in the timeline; "" is All lists. */
  listId: Schema.String,
  taskId: Schema.String,
  folderId: Schema.String,
  query: Schema.String,
  /** The prompt as the human edited it; "" until the detail loads. */
  prompt: Schema.String,
  /** Timeline groups opened past their first GROUP_LIMIT rows. */
  expanded: Schema.Array(Schema.String),
  /** When the dialog opened; ages and Today/Yesterday groups are relative to it. */
  now: Schema.Number,
  detailRequestId: Schema.Number,
  error: Schema.String,
  drafting: Schema.Boolean,
})
export type Model = typeof Model.Type
export const detailOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.detail))
export const canDraft = (model: Model): boolean => {
  const detail = detailOf(model)
  return Boolean(!model.drafting && model.folderId && model.taskId && detail?.task.id === model.taskId)
}
/** The list a task belongs to, from the loaded lists. */
export const listOfTask = (model: Model, taskId: string): string =>
  Object.entries(model.tasks).find(([, ts]) => ts.some((t) => t.id === taskId))?.[0] ?? ""
