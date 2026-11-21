import type { BranchPr, PrState } from "../cos.ts"
import { prState } from "../cos.ts"
import type { Thread, Threads, ThreadTodo } from "../threads.ts"
import type { TodoTask } from "./source.ts"

const ACTION_FAILED = "TickTick action failed"
const FACTORY_STARTED = "🏭 Factory started work."

export type TodoLifecycleActions = {
  task(id: string): Promise<TodoTask>
  claim(task: TodoTask, threadUrl: string): Promise<void>
  note(task: TodoTask, text: string): Promise<void>
  release(task: TodoTask, reason: string): Promise<void>
  complete(task: TodoTask, prUrl: string, onCommented: () => void, commentPosted: boolean): Promise<void>
}

export type PendingTodoRelease = ThreadTodo & {
  reason: string
}

type PendingMap = {
  get(key: string): PendingTodoRelease | undefined
  set(key: string, value: PendingTodoRelease): void
  delete(key: string): void
  keys(): Iterable<string>
}

export type TodoLifecycleDeps = {
  threads: Threads
  actions: TodoLifecycleActions
  pending: PendingMap
  threadUrl(id: string): string
  changed(id: string): void
  onError(id: string, message: string): void
}

const timeout = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(ACTION_FAILED)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

export const makeTodoLifecycle = (d: TodoLifecycleDeps) => {
  const inFlight = new Map<string, Promise<void>>()

  const serialize = (id: string, action: () => Promise<void>): Promise<void> => {
    const previous = inFlight.get(id) ?? Promise.resolve()
    const current = previous.then(action, action)
    inFlight.set(id, current)
    const clear = () => {
      if (inFlight.get(id) === current) inFlight.delete(id)
    }
    void current.then(clear, clear)
    return current
  }

  const patch = (id: string, update: (todo: ThreadTodo) => ThreadTodo): void => {
    const current = d.threads.get(id)?.todo
    if (!current) return
    d.threads.setTodo(id, update(current))
    d.changed(id)
  }

  const failure = (id: string, error?: unknown): void => {
    patch(id, (todo) => ({ ...todo, error: ACTION_FAILED }))
    d.onError(id, ACTION_FAILED)
    void error
  }

  const finish = (id: string, key: string): void =>
    patch(id, (todo) => ({
      ...todo,
      done: todo.done.includes(key) ? todo.done : [...todo.done, key],
      error: key === "claim" || todo.done.includes("claim") ? undefined : todo.error,
    }))

  const withTask = async (id: string, run: (task: TodoTask, todo: ThreadTodo) => Promise<void>): Promise<void> =>
    serialize(id, async () => {
      try {
        const todo = d.threads.get(id)?.todo
        if (!todo || todo.state !== "claimed") return
        await run(await d.actions.task(todo.taskId), todo)
      } catch (error) {
        failure(id, error)
      }
    })

  const claim = async (id: string): Promise<void> =>
    withTask(id, async (task, todo) => {
      if (todo.done.includes("claim")) return
      await d.actions.claim(task, d.threadUrl(id))
      finish(id, "claim")
    })

  const runComment = async (id: string): Promise<void> =>
    withTask(id, async (task, todo) => {
      if (todo.done.includes("run")) return
      if (!d.threads.get(id)?.draft?.startedAt) return
      await d.actions.note(task, FACTORY_STARTED)
      finish(id, "run")
    })

  const prComment = async (id: string, task: TodoTask, url: string): Promise<void> => {
    const key = `pr:${url}`
    if (!d.threads.get(id)?.todo?.done.includes(key)) {
      await d.actions.note(task, `🏭 PR: ${url}`)
      finish(id, key)
    }
  }

  const merge = async (id: string, task: TodoTask, url: string): Promise<void> => {
    const commentPosted = d.threads.get(id)?.todo?.done.includes("merged") ?? false
    if (d.threads.get(id)?.todo?.state !== "claimed") return
    await d.actions.complete(task, url, () => finish(id, "merged"), commentPosted)
    if (!commentPosted) finish(id, "merged")
    patch(id, (todo) => ({ ...todo, state: "completed", error: undefined }))
  }

  const release = async (id: string, task: TodoTask, reason: string): Promise<void> => {
    if (!d.threads.get(id)?.todo?.done.includes("released")) {
      await d.actions.release(task, reason)
      finish(id, "released")
    }
    patch(id, (todo) => ({ ...todo, state: "released", error: undefined }))
  }

  const reconcile = async (id: string, pr: BranchPr): Promise<void> =>
    withTask(id, async (task) => {
      const state: PrState = prState(pr.state, pr.checks)
      await prComment(id, task, pr.url)
      if (state === "merged") await merge(id, task, pr.url)
      if (state === "closed") await release(id, task, "PR closed without merge")
    })

  const retryReleases = async (): Promise<void> => {
    for (const id of [...d.pending.keys()]) {
      await serialize(id, async () => {
        const pending = d.pending.get(id)
        if (!pending) return
        try {
          const task = await d.actions.task(pending.taskId)
          await d.actions.release(task, pending.reason)
          d.pending.delete(id)
        } catch (error) {
          d.onError(id, ACTION_FAILED)
          void error
        }
      })
    }
  }

  const sweep = async (prs: Map<string, Map<string, BranchPr>>): Promise<void> => {
    for (const thread of d.threads.list()) {
      if (thread.todo?.state !== "claimed") continue
      await claim(thread.id)
      await runComment(thread.id)
      const repo = d.threads.folder(thread.folderId)?.path
      const pr = thread.branch && repo ? prs.get(repo)?.get(thread.branch) : undefined
      if (pr) await reconcile(thread.id, pr)
    }
    await retryReleases()
  }

  const discard = async (thread: Thread, reason: string, timeoutMs = 10_000): Promise<void> => {
    const todo = thread.todo
    if (!todo || todo.state !== "claimed") return
    const pending: PendingTodoRelease = { ...todo, reason }
    d.pending.set(thread.id, pending)
    const releasing = serialize(thread.id, async () => {
      if (!d.pending.get(thread.id)) return
      try {
        const task = await d.actions.task(pending.taskId)
        await d.actions.release(task, pending.reason)
        d.pending.delete(thread.id)
        patch(thread.id, (current) => ({ ...current, state: "released", error: undefined }))
      } catch (error) {
        d.onError(thread.id, ACTION_FAILED)
        void error
      }
    })
    try {
      await timeout(releasing, timeoutMs)
    } catch (error) {
      d.onError(thread.id, ACTION_FAILED)
      void error
    }
  }

  return { claim, run: runComment, discard, sweep, retryReleases }
}
