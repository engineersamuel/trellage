import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Dialog } from "@foldkit/ui"
import { Detail, Folders, Lists, Status, Tasks } from "./domain"
export const Message = defineMessageUnion({
  ClickedOpen: {},
  GotDialogMessage: { message: Dialog.Message },
  LoadedStatus: { value: Status },
  LoadedLists: { value: Lists },
  LoadedTasks: { value: Tasks },
  LoadedDetail: { value: Detail },
  LoadedFolders: { value: Folders },
  Failed: { error: Schema.String },
  PickedList: { value: Schema.String },
  PickedTask: { value: Schema.String },
  PickedFolder: { value: Schema.String },
  ClickedDraft: {},
  Drafted: { id: Schema.String },
})
export type Message = typeof Message.Type
