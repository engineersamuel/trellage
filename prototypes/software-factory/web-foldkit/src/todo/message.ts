import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Dialog } from "@foldkit/ui"
import { Detail, Folders, Lists, Status, Tasks } from "./domain"
export const Message = defineMessageUnion({
  ClickedOpen: {},
  GotDialogMessage: { message: Dialog.Message },
  CompletedReadTime: { now: Schema.Number },
  LoadedStatus: { value: Status },
  LoadedLists: { value: Lists },
  LoadedTasks: { value: Tasks, listId: Schema.String },
  FailedTasks: { error: Schema.String, listId: Schema.String },
  LoadedDetail: { value: Detail, taskId: Schema.String, requestId: Schema.Number },
  FailedDetail: { error: Schema.String, taskId: Schema.String, requestId: Schema.Number },
  LoadedFolders: { value: Folders },
  LoadedLastFolder: { value: Schema.String },
  Failed: { error: Schema.String },
  PickedList: { value: Schema.String },
  PickedTask: { value: Schema.String },
  PickedFolder: { value: Schema.String },
  ChangedQuery: { value: Schema.String },
  ChangedPrompt: { value: Schema.String },
  ClickedMore: { group: Schema.String },
  PressedNext: {},
  PressedPrevious: {},
  PressedSearch: {},
  PressedClear: {},
  ClickedDraft: {},
  Drafted: { id: Schema.String },
  FailedDraft: { error: Schema.String },
  Completed: {},
})
export type Message = typeof Message.Type
