import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { z } from "zod"
import { CosState } from "../src/cos.ts"
import { makeTodoLifecycle, type PendingTodoRelease, type TodoLifecycleActions } from "../src/todo/lifecycle.ts"
import { Threads } from "../src/threads.ts"
import type { BranchPr } from "../src/cos.ts"
import type { TodoTask } from "../src/todo/source.ts"
import { makeTickTickTodoSource } from "../src/todo/ticktick.ts"
import { inMemoryTokenStore } from "../src/todo/ticktick-auth.ts"
import { makeTodoPrSweep } from "../src/todo/pr-sweep.ts"

const task: TodoTask = { id: "task-1", projectId: "list-1", title: "Task" }
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = (fail?: Partial<TodoLifecycleActions>) => {
  const root = mkdtempSync(path.join(process.cwd(), ".todo-lifecycle-test-"))
  roots.push(root)
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
    complete: async (_task, url, onCommented, commentPosted) => {
      if (!commentPosted) {
        calls.push(`🏭 Merged: ${url}`)
        onCommented()
      }
      calls.push(`complete ${url}`)
    },
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

test("completed threads retry only missing comments", async () => {
  const { lifecycle, thread, calls, threads, repo } = setup()
  threads.setTodo(thread.id, {
    ...threads.get(thread.id)!.todo!,
    state: "completed",
    done: ["claim"],
  })
  Object.assign(
    (threads.get(thread.id)!.draft ??= {
      versions: [],
      current: "",
      reports: [],
    }),
    { startedAt: 1 },
  )
  const pr = {
    number: 1,
    url: "https://github.test/pull/1",
    state: "MERGED",
    checks: "SUCCESS",
  } as const
  const prs = new Map([[repo, new Map([["topic", pr]])]])

  await lifecycle.sweep(prs)
  await lifecycle.sweep(prs)

  expect(calls).toEqual(["🏭 Factory started work.", `🏭 PR: ${pr.url}`, `🏭 Merged: ${pr.url}`])
})

test("a failed complete retries without repeating the merged comment", async () => {
  let fail = true
  const observed: string[] = []
  const { lifecycle, thread, calls, repo } = setup({
    complete: async (_task, url, onCommented, commentPosted) => {
      if (!commentPosted) {
        calls.push(`🏭 Merged: ${url}`)
        onCommented()
      }
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

test("discard waits behind an outstanding claim, keeps its intent, and retries until release succeeds", async () => {
  let finishClaim!: () => void
  const claimed = new Promise<void>((resolve) => void (finishClaim = resolve))
  let releases = 0
  const { lifecycle, thread, calls, pending, threads } = setup({
    claim: () => claimed,
    release: async () => {
      releases++
      if (releases === 1) throw new Error("release failed")
    },
  })

  const claiming = lifecycle.claim(thread.id)
  await Promise.resolve()
  const discarding = lifecycle.discard(thread, "draft discarded", 5)
  await discarding
  expect(pending.get(thread.id)).toMatchObject({ taskId: task.id, reason: "draft discarded" })
  threads.delete(thread.id)
  expect(releases).toBe(0)

  finishClaim()
  await claiming
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(releases).toBe(1)
  expect(pending.has(thread.id)).toBe(true)

  await lifecycle.retryReleases()
  expect(releases).toBe(2)
  expect(pending.has(thread.id)).toBe(false)
  expect(calls.filter((call) => call === "TickTick action failed")).toHaveLength(2)
})

test("retry does not bypass a release queued behind an outstanding claim", async () => {
  let startClaim!: () => void
  let finishClaim!: () => void
  const claimStarted = new Promise<void>((resolve) => void (startClaim = resolve))
  const claiming = new Promise<void>((resolve) => void (finishClaim = resolve))
  let startRelease!: () => void
  let finishRelease!: () => void
  const releaseStarted = new Promise<void>((resolve) => void (startRelease = resolve))
  const releasing = new Promise<void>((resolve) => void (finishRelease = resolve))
  let releases = 0
  const { lifecycle, thread } = setup({
    claim: () => {
      startClaim()
      return claiming
    },
    release: async () => {
      releases++
      startRelease()
      await releasing
    },
  })

  const claim = lifecycle.claim(thread.id)
  await claimStarted
  const discard = lifecycle.discard(thread, "draft discarded", 100)
  finishClaim()
  await releaseStarted
  const retry = lifecycle.retryReleases()
  await Promise.resolve()
  expect(releases).toBe(1)

  finishRelease()
  await Promise.all([claim, discard, retry])
  expect(releases).toBe(1)
})

test("released archived and cleaned threads never retry claim or run comments", async () => {
  const root = mkdtempSync(path.join(process.cwd(), ".todo-lifecycle-released-test-"))
  roots.push(root)
  const threads = new Threads(root)
  const folder = threads.addFolder(process.cwd())
  const thread = threads.create("Closed task", folder.id, () => ({
    worktree: "/not-used",
    branch: "topic",
    base: "main",
  }))
  threads.setTodo(thread.id, {
    source: "ticktick",
    listId: "list-1",
    taskId: task.id,
    title: task.title,
    state: "claimed",
    done: [],
  })
  threads.update(thread.id, { archivedAt: 1, cleanedAt: 1 })

  const server = new McpServer({ name: "lifecycle-regression", version: "1" })
  let available = false
  let tags = ["owner", "other"]
  const mutations: Array<{ name: string; arguments: Record<string, unknown> }> = []
  for (const name of ["get_task_by_id", "get_comment", "update_task", "add_comment", "complete_task"]) {
    server.registerTool(name, { inputSchema: z.looseObject({}) }, async (args) => {
      mutations.push({ name, arguments: args })
      if (name === "update_task") {
        const taskArgs = args as { task: { tags: string[] } }
        if (taskArgs.task.tags.includes("factory") && !available)
          return { isError: true, content: [{ type: "text", text: "temporary TickTick failure" }] }
        tags = [...taskArgs.task.tags]
      }
      const structuredContent =
        name === "get_task_by_id"
          ? { task: { ...task, projectId: "list-1", tags, etag: "current" } }
          : name === "get_comment"
            ? { comments: [] }
            : {}
      return { structuredContent, content: [{ type: "text", text: "fixture" }] }
    })
  }

  try {
    const [client, remote] = InMemoryTransport.createLinkedPair()
    await server.connect(remote)
    const tokens = inMemoryTokenStore()
    await tokens.set({
      clientId: "fixture",
      redirectUri: "http://fixture/callback",
      accessToken: "synthetic",
    })
    const source = makeTickTickTodoSource({
      accessToken: async () => (await tokens.get())?.accessToken ?? "",
      transportFactory: () => client,
    })
    const lifecycle = makeTodoLifecycle({
      threads,
      pending: new CosState(root).map("todo-release"),
      threadUrl: (id) => `http://fixture/?thread=${id}`,
      changed: () => undefined,
      onError: () => undefined,
      actions: {
        task: async (id) => (await Effect.runPromise(source.task(id))).task,
        claim: (value, url) => Effect.runPromise(source.claim(value, url)),
        note: (value, text) => Effect.runPromise(source.note(value, text)),
        release: (value, reason, checkpoint) => Effect.runPromise(source.release(value, reason, checkpoint)),
        complete: (value, prUrl, onCommented, commentPosted) =>
          Effect.runPromise(source.complete(value, prUrl, { onCommented, commentPosted })),
      },
    })
    const sweep = makeTodoPrSweep({
      threads,
      prStates: new Map(),
      repoPrs: async () =>
        new Map([
          [
            "topic",
            {
              number: 1,
              url: "https://github.test/pull/1",
              state: "CLOSED",
              checks: "NONE",
            },
          ],
        ]),
      onPr: () => undefined,
      todoEnabled: () => true,
      todoSweep: (prs) => lifecycle.sweep(prs),
      onError: (_id, error) => {
        throw error
      },
    })

    await sweep()
    expect(threads.get(thread.id)!.todo!.state).toBe("released")
    expect(tags).toEqual(["owner", "other"])
    const postReleaseMutationCount = mutations.length

    available = true
    await sweep()
    await sweep()

    expect(tags).toEqual(["owner", "other"])
    expect(
      mutations
        .slice(postReleaseMutationCount)
        .filter(
          (call) =>
            call.name === "update_task" &&
            (call.arguments as { task: { tags: string[] } }).task.tags.includes("factory"),
        ),
    ).toHaveLength(0)
    expect(
      mutations
        .slice(postReleaseMutationCount)
        .filter((call) => call.name === "add_comment" && String(call.arguments.content).startsWith("🏭 Factory draft")),
    ).toHaveLength(0)
  } finally {
    await server.close()
  }
})

test("lifecycle owns the merged comment so completion can retry without duplicating it", async () => {
  const { threads, thread, pending, repo } = setup()
  const url = "https://github.test/pull/1"
  threads.setTodo(thread.id, {
    ...threads.get(thread.id)!.todo!,
    done: ["claim", `pr:${url}`],
  })
  const calls: string[] = []
  let completions = 0
  const source = makeTickTickTodoSource({
    accessToken: "secret",
    clientFactory: () => ({
      connect: async () => {},
      callTool: async ({ name }) => {
        calls.push(name)
        if (name === "get_task_by_id") return { content: [], structuredContent: { task } }
        if (name === "get_comment") return { content: [], structuredContent: { comments: [] } }
        if (name === "complete_task" && completions++ === 0)
          return { content: [{ type: "text", text: "completion failed" }], isError: true }
        return { content: [], structuredContent: {} }
      },
    }),
    transportFactory: () => InMemoryTransport.createLinkedPair()[0],
  })
  const lifecycle = makeTodoLifecycle({
    threads,
    pending,
    threadUrl: (id) => `http://ui/?thread=${id}`,
    changed: () => undefined,
    onError: () => undefined,
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      claim: (value, threadUrl) => Effect.runPromise(source.claim(value, threadUrl)),
      note: (value, text) => Effect.runPromise(source.note(value, text)),
      release: (value, reason) => Effect.runPromise(source.release(value, reason)),
      complete: (value, prUrl, onCommented, commentPosted) =>
        Effect.runPromise(source.complete(value, prUrl, { commentPosted, onCommented })),
    },
  })
  const prs = new Map([[repo, new Map([["topic", { number: 1, url, state: "MERGED", checks: "SUCCESS" }]])]])

  await lifecycle.sweep(prs)
  expect(threads.get(thread.id)!.todo!.done).toContain("merged")
  expect(calls.filter((name) => name === "add_comment")).toHaveLength(1)
  expect(calls.filter((name) => name === "complete_task")).toHaveLength(1)
  await lifecycle.sweep(prs)

  expect(calls.filter((name) => name === "add_comment")).toHaveLength(1)
  expect(calls.filter((name) => name === "complete_task")).toHaveLength(2)
  expect(threads.get(thread.id)!.todo!.state).toBe("completed")
})

test("a timed-out accepted merged comment is reconciled before retry", async () => {
  const { threads, thread, pending, repo } = setup()
  const url = "https://github.test/pull/1"
  threads.setTodo(thread.id, {
    ...threads.get(thread.id)!.todo!,
    done: ["claim", `pr:${url}`],
  })
  const server = new McpServer({ name: "lifecycle-timeout", version: "1" })
  const client = new Client({ name: "lifecycle-timeout-client", version: "1" })
  const comments: string[] = []
  const calls: string[] = []
  const errors: string[] = []
  let restoreResponse!: () => void
  const delayedResponse = new Promise<void>((resolve) => void (restoreResponse = resolve))
  let delayMergedComment = true
  for (const name of ["get_task_by_id", "get_comment", "add_comment", "complete_task"]) {
    server.registerTool(name, { inputSchema: z.looseObject({}) }, async (args) => {
      calls.push(name)
      if (name === "add_comment") {
        const content = String(args.content)
        comments.push(content)
        if (content === `🏭 Merged: ${url}` && delayMergedComment) {
          delayMergedComment = false
          await delayedResponse
        }
      }
      const structuredContent =
        name === "get_task_by_id"
          ? { task }
          : name === "get_comment"
            ? { comments: comments.map((content) => ({ content })) }
            : {}
      return { content: [{ type: "text" as const, text: "fixture" }], structuredContent }
    })
  }

  try {
    const [local, remote] = InMemoryTransport.createLinkedPair()
    await server.connect(remote)
    const source = makeTickTickTodoSource({
      accessToken: "synthetic-token",
      transportFactory: () => local,
      clientFactory: () => ({
        connect: (transport) => client.connect(transport),
        callTool: async (params) =>
          CallToolResultSchema.parse(await client.callTool(params, CallToolResultSchema, { timeout: 20 })),
      }),
    })
    const lifecycle = makeTodoLifecycle({
      threads,
      pending,
      threadUrl: (id) => `http://ui/?thread=${id}`,
      changed: () => undefined,
      onError: (_id, message) => void errors.push(message),
      actions: {
        task: async (id) => (await Effect.runPromise(source.task(id))).task,
        claim: (value, threadUrl) => Effect.runPromise(source.claim(value, threadUrl)),
        note: (value, text) => Effect.runPromise(source.note(value, text)),
        release: (value, reason) => Effect.runPromise(source.release(value, reason)),
        complete: (value, prUrl, onCommented, commentPosted) =>
          Effect.runPromise(source.complete(value, prUrl, { commentPosted, onCommented })),
      },
    })
    const prs = new Map([[repo, new Map([["topic", { number: 1, url, state: "MERGED", checks: "SUCCESS" }]])]])

    await lifecycle.sweep(prs)
    expect(errors).toEqual(["TickTick action failed"])
    expect(threads.get(thread.id)!.todo!.state).toBe("claimed")
    expect(comments).toEqual([`🏭 Merged: ${url}`])

    restoreResponse()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await lifecycle.sweep(prs)
    expect(threads.get(thread.id)!.todo!.state).toBe("completed")
    await lifecycle.sweep(prs)

    expect(comments.filter((comment) => comment === `🏭 Merged: ${url}`)).toHaveLength(1)
    expect(calls.filter((name) => name === "complete_task")).toHaveLength(1)
  } finally {
    restoreResponse()
    await client.close()
    await server.close()
  }
})
