import type { BranchPr } from "../cos.ts"
import { prState } from "../cos.ts"
import type { Thread, Threads, ThreadTodo } from "../threads.ts"
import type { TodoReleaseCheckpoint, TodoTask } from "./source.ts"

const ACTION_FAILED = "TickTick action failed"
const FACTORY_STARTED = "🏭 Factory started work."

type TodoState = ThreadTodo["state"]
export type TodoAction = "claim" | "run" | "pr-opened" | "complete" | "release"

const TRANSITIONS: Readonly<Record<TodoState, Partial<Record<TodoAction, TodoState>>>> = {
  drafted: { claim: "claimed", release: "released" },
  claimed: { run: "started", release: "released" },
  started: { "pr-opened": "pr-opened", release: "released" },
  "pr-opened": { complete: "completed", release: "released" },
  completed: {},
  released: {},
}

const TERMINAL = new Set<TodoState>(["completed", "released"])
const isTerminal = (todo: ThreadTodo): boolean => TERMINAL.has(todo.state)

const transition = (todo: ThreadTodo, action: TodoAction): TodoState | undefined => TRANSITIONS[todo.state][action]

export type TodoLifecycleActions = {
  task(id: string): Promise<TodoTask>
  claim(task: TodoTask, threadUrl: string, marker: string): Promise<void>
  note(task: TodoTask, text: string, marker: string): Promise<void>
  release(task: TodoTask, reason: string, checkpoint?: TodoReleaseCheckpoint, marker?: string): Promise<void>
  complete(
    task: TodoTask,
    prUrl: string,
    onCommented: () => void,
    commentPosted: boolean,
    marker: string,
  ): Promise<void>
}

export type PendingTodoRelease = ThreadTodo & { reason: string }

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
  const queues = new Map<string, Promise<void>>()
  const releaseAttempts = new Map<string, symbol>()

  const serialize = (id: string, action: () => Promise<void>): Promise<void> => {
    const previous = queues.get(id) ?? Promise.resolve()
    const current = previous.then(action, action)
    queues.set(id, current)
    const clear = () => {
      if (queues.get(id) === current) queues.delete(id)
    }
    void current.then(clear, clear)
    return current
  }

  const current = (id: string): ThreadTodo | undefined => d.threads.get(id)?.todo
  const patch = (id: string, update: (todo: ThreadTodo) => ThreadTodo): void => {
    const todo = current(id)
    if (!todo) return
    d.threads.setTodo(id, update(todo))
    d.changed(id)
  }

  const read = (id: string): ThreadTodo | undefined => current(id)

  const fail = (id: string): void => {
    patch(id, (todo) => ({ ...todo, error: ACTION_FAILED }))
    d.onError(id, ACTION_FAILED)
  }

  const finish = (id: string, action: TodoAction, done: string): void =>
    patch(id, (todo) => {
      const state = transition(todo, action)
      if (!state) return todo
      return {
        ...todo,
        state,
        done: todo.done.includes(done) ? todo.done : [...todo.done, done],
        error: undefined,
      }
    })

  const marker = (id: string, action: TodoAction): string => `${id.slice(0, 8)}:${action}`
  const marked = (id: string, action: TodoAction, text: string): string =>
    `🏭 [sf:${marker(id, action)}] ${text.replace(/^🏭\s*/, "")}`

  const perform = (
    id: string,
    action: TodoAction,
    done: string,
    operation: (task: TodoTask, todo: ThreadTodo) => Promise<void>,
  ): Promise<void> =>
    serialize(id, async () => {
      const todo = read(id)
      if (!todo || isTerminal(todo) || !transition(todo, action)) return
      if (todo.done.includes(done)) {
        finish(id, action, done)
        return
      }
      try {
        await operation(await d.actions.task(todo.taskId), todo)
        finish(id, action, done)
      } catch {
        fail(id)
      }
    })

  const claim = (id: string): Promise<void> =>
    perform(id, "claim", "claim", (task) => d.actions.claim(task, d.threadUrl(id), marker(id, "claim")))

  const run = (id: string): Promise<void> =>
    serialize(id, async () => {
      const todo = read(id)
      if (!todo || isTerminal(todo) || todo.state !== "claimed") return
      if (!d.threads.get(id)?.draft?.startedAt) return
      await performQueued(id, "run", "run", FACTORY_STARTED)
    })

  const performQueued = async (id: string, action: TodoAction, done: string, text: string): Promise<void> => {
    const todo = read(id)
    if (!todo || !transition(todo, action) || todo.done.includes(done)) {
      if (todo?.done.includes(done)) finish(id, action, done)
      return
    }
    try {
      await d.actions.note(await d.actions.task(todo.taskId), marked(id, action, text), marker(id, action))
      finish(id, action, done)
    } catch {
      fail(id)
    }
  }

  const commentPr = (id: string, task: TodoTask, url: string): Promise<void> =>
    d.actions.note(task, marked(id, "pr-opened", `🏭 PR: ${url}`), marker(id, "pr-opened"))

  const reconcile = (id: string, pr: BranchPr): Promise<void> =>
    serialize(id, async () => {
      const todo = read(id)
      if (!todo || isTerminal(todo)) return
      const state = prState(pr.state, pr.checks)
      if (todo.state === "claimed") {
        await performQueued(id, "run", "run", FACTORY_STARTED)
        if (read(id)?.state !== "started") return
      }
      try {
        let currentTodo = read(id)
        if (!currentTodo || currentTodo.state === "drafted") return
        const task = await d.actions.task(currentTodo.taskId)
        if (currentTodo.state === "started") {
          const prDone = `pr:${pr.url}`
          if (!currentTodo.done.includes(prDone)) await commentPr(id, task, pr.url)
          finish(id, "pr-opened", prDone)
        }
        currentTodo = read(id)
        if (!currentTodo || currentTodo.state !== "pr-opened") return
        if (state === "merged") {
          if (!currentTodo.done.includes("merged")) {
            await d.actions.note(task, marked(id, "complete", `🏭 Merged: ${pr.url}`), marker(id, "complete"))
            patch(id, (value) => ({
              ...value,
              done: value.done.includes("merged") ? value.done : [...value.done, "merged"],
            }))
          }
          await d.actions.complete(task, pr.url, () => undefined, true, marker(id, "complete"))
          finish(id, "complete", "merged")
        } else if (state === "closed") {
          await releaseQueued(id, task, "PR closed without merge")
        }
      } catch {
        fail(id)
      }
    })

  const releaseQueued = async (id: string, task: TodoTask, reason: string): Promise<void> => {
    const todo = read(id)
    if (!todo || isTerminal(todo) || !transition(todo, "release")) return
    const checkpoint = { active: () => true, marker: marker(id, "release") }
    await d.actions.release(task, reason, checkpoint, marker(id, "release"))
    finish(id, "release", "released")
  }

  const startReleaseAttempt = (id: string) => {
    const value = Symbol(id)
    let started = false
    let commenting = false
    releaseAttempts.set(id, value)
    return {
      begin: () => void (started = true),
      started: () => started,
      commentStarted: () => void (commenting = true),
      commenting: () => commenting,
      marker: marker(id, "release"),
      active: () => releaseAttempts.get(id) === value,
      cancel: () => {
        if (releaseAttempts.get(id) === value) releaseAttempts.delete(id)
      },
    }
  }

  type ReleaseAttempt = ReturnType<typeof startReleaseAttempt>

  const retryPending = async (id: string, pending: PendingTodoRelease, attempt: ReleaseAttempt): Promise<void> => {
    attempt.begin()
    if (TERMINAL.has(pending.state)) {
      d.pending.delete(id)
      return
    }
    try {
      const task = await d.actions.task(pending.taskId)
      if (!attempt.active()) return
      await d.actions.release(task, pending.reason, attempt, marker(id, "release"))
      d.pending.delete(id)
      finish(id, "release", "released")
    } catch {
      if (attempt.active()) d.onError(id, ACTION_FAILED)
    } finally {
      attempt.cancel()
    }
  }

  const retryReleases = async (): Promise<void> => {
    for (const id of [...d.pending.keys()]) {
      const pending = d.pending.get(id)
      if (!pending) continue
      if (TERMINAL.has(pending.state)) {
        d.pending.delete(id)
        continue
      }
      if (releaseAttempts.has(id)) continue
      await serialize(id, async () => {
        const latest = d.pending.get(id)
        if (!latest || TERMINAL.has(latest.state)) {
          if (latest) d.pending.delete(id)
          return
        }
        await retryPending(id, latest, startReleaseAttempt(id))
      })
    }
  }

  const sweep = async (prs: Map<string, Map<string, BranchPr>>): Promise<void> => {
    for (const thread of d.threads.list()) {
      if (!thread.todo || isTerminal(thread.todo)) continue
      await claim(thread.id)
      await run(thread.id)
      const repo = d.threads.folder(thread.folderId)?.path
      const pr = thread.branch && repo ? prs.get(repo)?.get(thread.branch) : undefined
      if (pr) await reconcile(thread.id, pr)
    }
    await retryReleases()
  }

  const discard = async (thread: Thread, reason: string, timeoutMs = 10_000): Promise<void> => {
    const todo = thread.todo
    if (!todo || isTerminal(todo)) return
    const pending: PendingTodoRelease = { ...todo, reason }
    d.pending.set(thread.id, pending)
    const attempt = startReleaseAttempt(thread.id)
    const releasing = serialize(thread.id, () => retryPending(thread.id, pending, attempt))
    try {
      await timeout(releasing, timeoutMs)
    } catch {
      if (attempt.started() && !attempt.commenting()) attempt.cancel()
      d.onError(thread.id, ACTION_FAILED)
    }
  }

  return { claim, run, discard, sweep, retryReleases }
}
