import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { Folder } from "../../../shared/schemas"
const Text = Schema.optionalKey(Schema.String)
export const Status = Schema.Struct({
  state: Text,
  status: Text,
  expiresAt: Schema.optionalKey(Schema.Number),
  store: Text,
  warn: Schema.optionalKey(Schema.Boolean),
})
export const TodoList = Schema.Struct({ id: Schema.String, name: Schema.String })
export type TodoList = typeof TodoList.Type
export const Item = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  desc: Schema.optionalKey(Schema.String),
  done: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.Number),
})
export const Task = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  content: Text,
  desc: Text,
  items: Schema.optionalKey(Schema.Array(Item)),
  tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  priority: Schema.optionalKey(Schema.Number),
  dueDate: Text,
  threadId: Text,
  prompt: Text,
})
export const Detail = Schema.Struct({
  task: Task,
  prompt: Text,
  comments: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Text, content: Text, text: Text }))),
})
export const Lists = Schema.Array(TodoList)
export const Tasks = Schema.Array(Task)
export const Folders = Schema.Array(Folder)
export type Status = typeof Status.Type
export type Task = typeof Task.Type
export type Detail = typeof Detail.Type
export const AsyncStatus = AsyncData.Schema(Status, Schema.String)
export const AsyncLists = AsyncData.Schema(Lists, Schema.String)
export const AsyncTasks = AsyncData.Schema(Tasks, Schema.String)
export const AsyncDetail = AsyncData.Schema(Detail, Schema.String)
export const AsyncFolders = AsyncData.Schema(Folders, Schema.String)
