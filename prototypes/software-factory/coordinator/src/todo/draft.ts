import { existsSync } from "node:fs"
import path from "node:path"
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
    state: "drafted",
    done: [],
  })
  void d.claim(thread.id).catch(() => undefined)
  return d.threads.get(thread.id) ?? thread
}

const RESEARCH = new Set(["deep-research", "research", "hyperresearch"])

/**
 * What the guided goal page starts from for a draft: the current version, the draft's folder, and the newest research
 * report whose worker has finished and whose file exists (absolute path), else null. Undefined for a thread with no draft.
 */
export const draftGoalSeed = (
  thread: Thread,
  isRunning: (workerId: string) => boolean,
): { seed: string; folderId: string; research: string | null } | undefined => {
  const draft = thread.draft
  if (!draft) return undefined
  const seed = draft.versions.find((v) => v.id === draft.current)?.prompt ?? ""
  const report = [...draft.reports]
    .reverse()
    .find(
      (r) =>
        RESEARCH.has(r.action) &&
        !isRunning(r.workerId) &&
        thread.worktree &&
        existsSync(path.join(thread.worktree, r.path)),
    )
  return {
    seed,
    folderId: thread.folderId,
    research: report && thread.worktree ? path.join(thread.worktree, report.path) : null,
  }
}

/** A goal launched from a draft takes over its Todo link (the task then follows the goal's PR); the draft is archived. */
export const adoptDraftTodo = (threads: Threads, draftId: string, goalThreadId: string, at: number): void => {
  const draft = threads.get(draftId)
  if (!draft?.draft) return
  if (draft.todo && !threads.get(goalThreadId)?.todo) threads.setTodo(goalThreadId, draft.todo)
  threads.clearTodo(draftId)
  threads.update(draftId, { archivedAt: at })
}
