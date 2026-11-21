import { DraftError } from "../drafts.ts"
import type { Thread, Threads } from "../threads.ts"
import { draftPrompt, type TodoList, type TodoTaskWithComments } from "./source.ts"

export type TodoDraftLink = {
  source: "ticktick"
  listId: string
  taskId: string
}

export type TodoDraftDeps = {
  threads: Threads
  drafts: { create(folderId: string, prompt: string): Thread }
  source: {
    lists(): Promise<TodoList[]>
    task(id: string): Promise<TodoTaskWithComments>
  }
  claim(threadId: string): Promise<void>
}

const readWithTimeout = async <A>(read: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DraftError(502, "Todo source timed out")), 10_000)
      }),
    ])
  } catch (error) {
    if (error instanceof DraftError) throw error
    throw new DraftError(502, "Todo source unavailable")
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const createTodoDraft = async (d: TodoDraftDeps, folderId: string, link: TodoDraftLink): Promise<Thread> => {
  const [detail, lists] = await readWithTimeout(Promise.all([d.source.task(link.taskId), d.source.lists()]))
  const list = lists.find((item) => item.id === link.listId)
  if (!list || detail.task.projectId !== list.id) throw new DraftError(502, "Todo list unavailable")
  const thread = d.drafts.create(folderId, draftPrompt(detail.task, list, detail.comments))
  d.threads.setTodo(thread.id, {
    source: link.source,
    listId: list.id,
    taskId: detail.task.id,
    title: detail.task.title,
    state: "claimed",
    done: [],
  })
  void d.claim(thread.id).catch(() => undefined)
  return d.threads.get(thread.id) ?? thread
}
