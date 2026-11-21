import { Context, Effect, Schema } from "effect"

export const TodoList = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
export type TodoList = typeof TodoList.Type

export const TodoTaskItem = Schema.Struct({
  title: Schema.String,
  status: Schema.Number,
})

export const TodoTask = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  content: Schema.optionalKey(Schema.String),
  desc: Schema.optionalKey(Schema.String),
  items: Schema.optionalKey(Schema.Array(TodoTaskItem)),
  tags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  priority: Schema.optionalKey(Schema.Number),
  dueDate: Schema.optionalKey(Schema.String),
  etag: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
})
export type TodoTask = typeof TodoTask.Type

export const TodoComment = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  content: Schema.String,
  createdAt: Schema.optionalKey(Schema.String),
})
export type TodoComment = typeof TodoComment.Type

export const TodoTaskWithComments = Schema.Struct({
  task: TodoTask,
  comments: Schema.Array(TodoComment),
})
export type TodoTaskWithComments = typeof TodoTaskWithComments.Type

export type TodoReleaseCheckpoint = {
  active(): boolean
  commentStarted?(): void
}

export type TodoSourceApi = {
  lists(): Effect.Effect<TodoList[]>
  tasks(listId: string): Effect.Effect<TodoTask[]>
  task(id: string): Effect.Effect<TodoTaskWithComments>
  claim(task: TodoTask, threadUrl: string): Effect.Effect<void>
  note(task: TodoTask, text: string): Effect.Effect<void>
  release(task: TodoTask, reason: string, checkpoint?: TodoReleaseCheckpoint): Effect.Effect<void>
  complete(
    task: TodoTask,
    prUrl: string,
    checkpoint?: { commentPosted: boolean; onCommented(): void },
  ): Effect.Effect<void>
}

export class TodoSource extends Context.Service<TodoSource, TodoSourceApi>()("TodoSource") {}

const priorityName = (priority: number | undefined): string =>
  priority === 1 ? "low" : priority === 3 ? "medium" : priority === 5 ? "high" : "none"

const dueDate = (value: string | undefined): string => {
  if (!value) return "none"
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  return match?.[1] ?? value
}

export const draftPrompt = (task: TodoTask, list: TodoList, comments: readonly TodoComment[]): string => {
  const sections = [task.title]
  const body = [task.content?.trim(), task.desc?.trim()].filter(Boolean).join("\n\n")
  if (body) sections.push(body)
  if (task.items?.length)
    sections.push(
      ["Checklist:", ...task.items.map((item) => `- [${item.status === 2 ? "x" : " "}] ${item.title}`)].join("\n"),
    )
  const ordinary = comments.map((comment) => comment.content.trim()).filter((text) => text && !text.startsWith("🏭"))
  if (ordinary.length) sections.push(["Comments:", ...ordinary.map((text) => `- ${text}`)].join("\n"))
  const tags = task.tags?.length ? task.tags.join(", ") : "none"
  const metadata = [
    `Source: TickTick`,
    `list ${list.name}`,
    `tags ${tags}`,
    `priority ${priorityName(task.priority)}`,
    `due ${dueDate(task.dueDate)}`,
  ]
  sections.push(metadata.join(" · "))
  return sections.join("\n\n")
}
