import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { makeTodoLifecycle, type PendingTodoRelease, type TodoLifecycleActions } from "../src/todo/lifecycle.ts"
import { Threads } from "../src/threads.ts"
import type { BranchPr } from "../src/cos.ts"
import type { TodoTask } from "../src/todo/source.ts"

const task: TodoTask = { id: "task-1", projectId: "list-1", title: "Task" }

const setup = (fail?: Partial<TodoLifecycleActions>) => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-todo-lifecycle-"))
  const threads = new Threads(root)
  const folder = threads.addFolder(process.cwd())
  const thread = threads.create("Task", folder.id)
  Object.assign(thread, { branch: "topic", worktree: "/repo" })
  threads.setTodo(thread.id, {
    source: "ticktick",
    listId: "list-1",
    taskId: task.id,
    title: task.title,
    state: "claimed",
    done: [],
  })
  const calls: string[] = []
  const pending = new Map<string, PendingTodoRelease>()
  const actions: TodoLifecycleActions = {
    task: async () => task,
    claim: async (_task, url) => void calls.push(`claim ${url}`),
    note: async (_task, text) => void calls.push(text),
    release: async (_task, reason) => void calls.push(`release ${reason}`),
    complete: async (_task, url) => void calls.push(`complete ${url}`),
    ...fail,
  }
  const lifecycle = makeTodoLifecycle({
    threads,
    actions,
    pending,
    threadUrl: (id) => `http://ui/?thread=${id}`,
    onError: (_id, message) => void calls.push(message),
    changed: () => undefined,
  })
  return { root, repo: folder.path, thread, threads, calls, pending, lifecycle }
}

test("claim and run are idempotent and serialized", async () => {
  const { lifecycle, thread, calls, threads } = setup()
  await Promise.all([lifecycle.claim(thread.id), lifecycle.claim(thread.id)])
  Object.assign(
    (threads.get(thread.id)!.draft ??= {
      versions: [],
      current: "",
      reports: [],
    }),
    { startedAt: 1 },
  )
  await lifecycle.sweep(new Map())
  await lifecycle.sweep(new Map())
  expect(calls).toEqual([`claim http://ui/?thread=${thread.id}`, "🏭 Factory started work."])
  expect(threads.get(thread.id)!.todo!.done).toEqual(["claim", "run"])
})

test("first PR observation, merged comment and completion run without duplicates", async () => {
  const { lifecycle, thread, calls, repo } = setup()
  const prs = new Map([
    [
      repo,
      new Map([
        [
          "topic",
          {
            number: 1,
            url: "https://github.test/pull/1",
            state: "MERGED",
            checks: "SUCCESS",
          },
        ],
      ]),
    ],
  ])
  await lifecycle.sweep(prs)
  await lifecycle.sweep(prs)
  expect(calls).toEqual([
    `claim http://ui/?thread=${thread.id}`,
    "🏭 PR: https://github.test/pull/1",
    "🏭 Merged: https://github.test/pull/1",
    "complete https://github.test/pull/1",
  ])
})

test("a failed complete retries without repeating the merged comment", async () => {
  let fail = true
  const observed: string[] = []
  const { lifecycle, thread, calls, repo } = setup({
    complete: async (_task, url) => {
      if (fail) throw new Error("secret upstream token")
      observed.push(`complete ${url}`)
    },
  } as Partial<TodoLifecycleActions>)
  const pr = { number: 1, url: "https://github.test/pull/1", state: "MERGED", checks: "SUCCESS" }
  const prs = new Map([[repo, new Map([["topic", pr]])]])
  const result = await lifecycle.sweep(prs)
  void result
  fail = false
  await lifecycle.sweep(prs)
  expect(calls).toEqual([
    `claim http://ui/?thread=${thread.id}`,
    "🏭 PR: https://github.test/pull/1",
    "🏭 Merged: https://github.test/pull/1",
    "TickTick action failed",
  ])
  expect(observed).toEqual(["complete https://github.test/pull/1"])
})

test("closed PR releases claimed threads including archived and cleaned threads", async () => {
  const { lifecycle, thread, calls, threads, repo } = setup()
  Object.assign(threads.get(thread.id)!, { archivedAt: 1, cleanedAt: 1 })
  const pr: BranchPr = {
    number: 1,
    url: "https://github.test/pull/1",
    state: "CLOSED",
    checks: "NONE",
  }
  await lifecycle.sweep(new Map([[repo, new Map([["topic", pr]])]]))
  expect(calls).toContain("release PR closed without merge")
  expect(threads.get(thread.id)!.todo!.state).toBe("released")
})

test("discard timeout records a persistent release and the next sweep clears it", async () => {
  const { lifecycle, thread, calls, pending, threads } = setup({
    release: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      }),
  })
  await lifecycle.discard(thread, "draft discarded", 5)
  expect(pending.get(thread.id)).toMatchObject({ taskId: task.id, reason: "draft discarded" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  threads.delete(thread.id)
  await lifecycle.retryReleases()
  expect(pending.has(thread.id)).toBe(false)
  expect(calls).toEqual(["TickTick action failed"])
})
