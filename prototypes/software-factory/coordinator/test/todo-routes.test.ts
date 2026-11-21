import { afterEach, expect, test } from "bun:test"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { makeDrafts } from "../src/drafts.ts"
import { Threads, type Thread } from "../src/threads.ts"
import { CosState } from "../src/cos.ts"
import { createTodoDraft } from "../src/todo/draft.ts"
import { makeTodoLifecycle, type PendingTodoRelease, type TodoLifecycleActions } from "../src/todo/lifecycle.ts"
import { makeTodoRoutes } from "../src/todo/routes.ts"
import { makeTodoPrSweep } from "../src/todo/pr-sweep.ts"
import { prEvent, prState, type PrState } from "../src/cos.ts"
import type { TodoTask, TodoTaskWithComments } from "../src/todo/source.ts"
import { inMemoryTokenStore } from "../src/todo/ticktick-auth.ts"
import { makeTickTickTodoSource } from "../src/todo/ticktick.ts"

const roots: string[] = []
const servers: SdkMcpServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const root = () => {
  const value = mkdtempSync(path.join(process.cwd(), ".todo-routes-test-"))
  roots.push(value)
  return value
}

const task: TodoTask = {
  id: "task-1",
  projectId: "list-1",
  title: "Ship AC-3",
  content: "Implement the proof",
}

type ToolCall = { name: string; arguments: Record<string, unknown> }
type ToolReply = { structuredContent: Record<string, unknown> } | { isError: true; text: string } | undefined
type DraftSource = {
  lists(): Promise<{ id: string; name: string }[]>
  task(id: string): Promise<TodoTaskWithComments>
}

const fakeTickTick = async (handle?: (call: ToolCall, index: number) => ToolReply | Promise<ToolReply>) => {
  const calls: ToolCall[] = []
  const server = new SdkMcpServer({ name: "todo-routes", version: "1" })
  for (const name of [
    "list_projects",
    "get_project_with_undone_tasks",
    "get_task_by_id",
    "get_comment",
    "add_comment",
    "update_task",
    "complete_task",
  ]) {
    server.registerTool(name, { inputSchema: z.looseObject({}) }, async (args) => {
      const call = { name, arguments: args as Record<string, unknown> }
      calls.push(call)
      const reply = (await handle?.(call, calls.length - 1)) ?? {
        structuredContent:
          name === "list_projects"
            ? { projects: [{ id: "list-1", name: "Work" }] }
            : name === "get_task_by_id"
              ? { task }
              : name === "get_comment"
                ? { comments: [{ content: "Keep the checklist" }] }
                : {},
      }
      if ("isError" in reply) {
        return { isError: true as const, content: [{ type: "text" as const, text: reply.text }] }
      }
      return {
        structuredContent: reply.structuredContent,
        content: [{ type: "text" as const, text: JSON.stringify(reply.structuredContent) }],
      }
    })
  }
  const [client, remote] = InMemoryTransport.createLinkedPair()
  await server.connect(remote)
  servers.push(server)
  const store = inMemoryTokenStore()
  await store.set({
    clientId: "client",
    redirectUri: "http://factory.test/callback",
    accessToken: "offline-fixture-token",
  })
  const source = makeTickTickTodoSource({
    accessToken: async () => (await store.get())?.accessToken ?? "",
    transportFactory: () => client,
  })
  return { source, calls }
}

const eventually = async (check: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("condition was not reached")
}

type HarnessOptions = {
  actions?: Partial<TodoLifecycleActions>
  createDraft?: (folderId: string, link: { source: "ticktick"; listId: string; taskId: string }) => Promise<Thread>
  draftSource?: DraftSource
  discardTimeout?: number
}

const makeHarness = (options: HarnessOptions = {}) => {
  const stateRoot = root()
  const threads = new Threads(stateRoot)
  const folder = threads.addFolder(process.cwd())
  const calls: string[] = []
  const pending = new CosState(stateRoot).map<PendingTodoRelease>("todo-release")
  const actions: TodoLifecycleActions = {
    task: async () => task,
    claim: async (_task, url) => void calls.push(`claim ${url}`),
    note: async (_task, text) => void calls.push(text),
    release: async (_task, reason) => void calls.push(`release ${reason}`),
    complete: async (_task, url) => void calls.push(`complete ${url}`),
    ...options.actions,
  }
  const lifecycle = makeTodoLifecycle({
    threads,
    pending,
    actions,
    threadUrl: (id) => `http://factory.test/?thread=${id}`,
    changed: () => undefined,
    onError: (_id, message) => void calls.push(message),
  })
  const drafts = makeDrafts({
    threads,
    createThread: (prompt, folderId) => {
      void prompt
      return threads.create("Todo draft", folderId, () => ({
        worktree: "/repo",
        branch: "topic",
        base: "main",
      }))
    },
    spawn: async () => ({ id: "worker" }),
    isRunning: () => false,
    stopOwned: async () => undefined,
    discard: async (thread) => void threads.delete(thread.id),
    deliver: async () => undefined,
    enhance: async () => [],
    changed: () => undefined,
    onRun: (id) => lifecycle.run(id),
    beforeDiscard: (thread) => lifecycle.discard(thread, "draft discarded"),
  })
  const routes = makeTodoRoutes({
    enabled: () => true,
    threads,
    drafts,
    createTodoDraft: (folderId, link) =>
      options.createDraft?.(folderId, link) ??
      createTodoDraft(
        {
          threads,
          drafts,
          source: options.draftSource ?? {
            lists: async () => [{ id: "list-1", name: "Work" }],
            task: async () => ({ task, comments: [{ content: "Keep the checklist" }] }),
          },
          claim: (id) => lifecycle.claim(id),
        },
        folderId,
        link,
      ),
    discard: (thread, reason) => lifecycle.discard(thread, reason, options.discardTimeout),
    deleteThread: async (id) => void threads.delete(id),
  })
  return { stateRoot, threads, folder, calls, pending, lifecycle, routes }
}

test("Todo draft route redacts upstream credential failures from its response", async () => {
  const token = "distinctive-draft-route-token"
  const { routes, folder } = makeHarness({
    createDraft: async () => {
      throw new Error(`upstream Authorization: Bearer ${token}`)
    },
  })
  const response = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  const body = await response.text()
  expect(response.status).toBe(500)
  expect(JSON.parse(body)).toEqual({ error: "Draft request failed" })
  expect(body).not.toContain(token)
  expect(body.toLowerCase()).not.toContain("bearer")
})

test("POST /api/drafts invokes the production handler and claims a stored Todo prompt", async () => {
  let finishClaim!: () => void
  const blocked = new Promise<void>((resolve) => void (finishClaim = resolve))
  const claims: string[] = []
  const { routes, threads, folder } = makeHarness({
    actions: {
      claim: async (_task, url) => {
        claims.push(`claim ${url}`)
        await blocked
      },
    },
  })
  const response = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string }
  expect(threads.get(created.id)?.draft?.versions[0]?.prompt).toContain("Keep the checklist")
  expect(threads.get(created.id)?.todo).toMatchObject({
    taskId: task.id,
    state: "claimed",
    done: [],
  })
  await Promise.resolve()
  expect(claims[0]).toBe(`claim http://factory.test/?thread=${created.id}`)
  finishClaim()
})

test("draft discard and thread DELETE both release before deletion through production handlers", async () => {
  let tags = ["owner", "factory", "other"]
  const fake = await fakeTickTick((call) => {
    if (call.name === "get_task_by_id")
      return { structuredContent: { task: { ...task, tags: [...tags], etag: "etag-1" } } }
    if (call.name === "update_task") {
      tags = (call.arguments.task as { tags?: string[] }).tags ?? []
      return { structuredContent: {} }
    }
    return undefined
  })
  const { source, calls } = fake
  const { routes, threads, folder } = makeHarness({
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      claim: (value, url) => Effect.runPromise(source.claim(value, url)),
      release: (value, reason) => Effect.runPromise(source.release(value, reason)),
    },
  })
  const first = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  const draft = (await first.json()) as { id: string }
  await Promise.resolve()
  await routes.discardDraft(draft.id)
  expect(threads.get(draft.id)).toBeUndefined()
  expect(calls.filter((call) => call.name === "add_comment")).toContainEqual({
    name: "add_comment",
    arguments: { task_id: "task-1", content: "🏭 Factory stopped: draft discarded" },
  })
  expect(calls.filter((call) => call.name === "update_task").at(-1)?.arguments.task).toMatchObject({
    tags: ["owner", "other"],
  })

  const second = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  const conversation = (await second.json()) as { id: string }
  await Promise.resolve()
  const deleted = await routes.deleteThread(conversation.id)
  expect(deleted.status).toBe(204)
  expect(threads.get(conversation.id)).toBeUndefined()
  expect(calls.filter((call) => call.name === "add_comment")).toContainEqual({
    name: "add_comment",
    arguments: { task_id: "task-1", content: "🏭 Factory stopped: conversation deleted" },
  })
  expect(calls.filter((call) => call.name === "update_task").at(-1)?.arguments.task).toMatchObject({
    tags: ["owner", "other"],
  })
})

test("production PR sweep shares repo reads, emits closed, and reconciles archived Todo threads", async () => {
  const fake = await fakeTickTick((call) => {
    if (call.name === "get_task_by_id")
      return {
        structuredContent: {
          task: { ...task, tags: ["owner", "factory", "other"], etag: "etag-1" },
        },
      }
    return undefined
  })
  const { source, calls } = fake
  const { threads, folder, lifecycle } = makeHarness({
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      release: (value, reason) => Effect.runPromise(source.release(value, reason)),
    },
  })
  const thread = threads.create("Task", folder.id, () => ({
    worktree: "/repo",
    branch: "closed",
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
  const live = threads.create("Live", folder.id, () => ({
    worktree: "/repo",
    branch: "live",
    base: "main",
  }))
  const states = new Map<string, PrState>([
    [thread.id, "pending"],
    [live.id, "pending"],
  ])
  const reads: string[] = []
  const events: string[] = []
  const sweep = makeTodoPrSweep({
    threads,
    prStates: states,
    repoPrs: async (repo) => {
      reads.push(repo)
      return new Map([
        ["closed", { number: 7, url: "https://github.test/pull/7", state: "CLOSED", checks: "NONE" }],
        ["live", { number: 8, url: "https://github.test/pull/8", state: "CLOSED", checks: "NONE" }],
      ])
    },
    onPr: (value, pr) => {
      const before = states.get(value.id)
      const now = prState(pr.state, pr.checks)
      states.set(value.id, now)
      events.push(prEvent(before, now) ?? "none")
    },
    todoEnabled: () => true,
    todoSweep: (prs) => lifecycle.sweep(prs),
    onError: (_id, error) => {
      throw error
    },
  })

  await sweep()
  expect(reads).toEqual([folder.path])
  expect(events).toEqual(["closed"])
  expect(threads.get(thread.id)?.todo?.state).toBe("released")
  expect(calls.filter((call) => call.name === "update_task").at(-1)?.arguments.task).toMatchObject({
    tags: ["owner", "other"],
  })
  expect(calls.filter((call) => call.name === "add_comment")).toContainEqual({
    name: "add_comment",
    arguments: { task_id: "task-1", content: "🏭 Factory stopped: PR closed without merge" },
  })
})

test("timed-out release survives deletion, retries once, and ignores the late answer", async () => {
  let finishFirstUpdate!: () => void
  const firstUpdate = new Promise<void>((resolve) => void (finishFirstUpdate = resolve))
  let firstUpdateStarted!: () => void
  const started = new Promise<void>((resolve) => void (firstUpdateStarted = resolve))
  let updateAttempts = 0
  const fake = await fakeTickTick(async (call) => {
    if (call.name === "get_task_by_id")
      return {
        structuredContent: {
          task: { ...task, tags: ["owner", "factory", "other"], etag: "etag-1" },
        },
      }
    if (call.name === "update_task" && updateAttempts++ === 0) {
      firstUpdateStarted()
      await firstUpdate
    }
    return undefined
  })
  const { source, calls } = fake
  const { routes, threads, folder, pending, lifecycle } = makeHarness({
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      release: (value, reason, checkpoint) => Effect.runPromise(source.release(value, reason, checkpoint)),
    },
    discardTimeout: 5,
  })
  const thread = threads.create("Task", folder.id)
  threads.setTodo(thread.id, {
    source: "ticktick",
    listId: task.projectId,
    taskId: task.id,
    title: task.title,
    state: "claimed",
    done: ["claim"],
  })
  const beforeDelete = performance.now()
  const deleted = await routes.deleteThread(thread.id)
  expect(performance.now() - beforeDelete).toBeLessThan(100)
  expect(deleted.status).toBe(204)
  expect(pending.get(thread.id)).toMatchObject({ taskId: task.id, reason: "conversation deleted" })
  expect(threads.get(thread.id)).toBeUndefined()
  await started
  expect(calls.filter((call) => call.name === "update_task")).toHaveLength(1)
  expect(calls.filter((call) => call.name === "add_comment")).toHaveLength(0)

  const sweep = makeTodoPrSweep({
    threads,
    prStates: new Map(),
    repoPrs: async () => new Map(),
    onPr: () => undefined,
    todoEnabled: () => true,
    todoSweep: (prs) => lifecycle.sweep(prs),
    onError: (_id, error) => {
      throw error
    },
  })
  finishFirstUpdate()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await sweep()
  expect(pending.get(thread.id)).toBeUndefined()
  expect(calls.filter((call) => call.name === "update_task")).toHaveLength(2)
  for (const update of calls.filter((call) => call.name === "update_task")) {
    expect(update.arguments.task).toMatchObject({ tags: ["owner", "other"] })
  }
  expect(calls.filter((call) => call.name === "add_comment")).toEqual([
    {
      name: "add_comment",
      arguments: { task_id: "task-1", content: "🏭 Factory stopped: conversation deleted" },
    },
  ])
  await sweep()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls.filter((call) => call.name === "add_comment")).toHaveLength(1)
})

test("sweep waits for an outstanding late release response without posting another comment", async () => {
  let finishComment!: () => void
  const firstComment = new Promise<void>((resolve) => void (finishComment = resolve))
  let firstCommentStarted!: () => void
  const started = new Promise<void>((resolve) => void (firstCommentStarted = resolve))
  const fake = await fakeTickTick(async (call) => {
    if (call.name === "get_task_by_id")
      return {
        structuredContent: {
          task: { ...task, tags: ["owner", "factory", "other"], etag: "etag-1" },
        },
      }
    if (call.name === "add_comment") {
      firstCommentStarted()
      await firstComment
    }
    return undefined
  })
  const { source, calls } = fake
  const { routes, threads, folder, pending, lifecycle } = makeHarness({
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      release: (value, reason, checkpoint) => Effect.runPromise(source.release(value, reason, checkpoint)),
    },
    discardTimeout: 5,
  })
  const thread = threads.create("Task", folder.id)
  threads.setTodo(thread.id, {
    source: "ticktick",
    listId: task.projectId,
    taskId: task.id,
    title: task.title,
    state: "claimed",
    done: ["claim"],
  })

  expect((await routes.deleteThread(thread.id)).status).toBe(204)
  await started
  expect(pending.get(thread.id)).toMatchObject({ taskId: task.id, reason: "conversation deleted" })

  const retry = lifecycle.sweep(new Map())
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.name === "add_comment")).toHaveLength(1)
  } finally {
    finishComment()
    await retry
  }
  await eventually(() => pending.get(thread.id) === undefined)

  expect(calls.filter((call) => call.name === "update_task")).toHaveLength(1)
  expect(calls.filter((call) => call.name === "add_comment")).toEqual([
    {
      name: "add_comment",
      arguments: { task_id: "task-1", content: "🏭 Factory stopped: conversation deleted" },
    },
  ])
})

test("a failed claim keeps its warning while a later stage succeeds", async () => {
  const { threads, folder, lifecycle } = makeHarness({
    actions: {
      claim: async () => {
        throw new Error("TickTick unavailable")
      },
    },
  })
  const thread = threads.create("Task", folder.id)
  threads.setDraft(thread.id, { versions: [], current: "", reports: [], startedAt: 1 })
  threads.setTodo(thread.id, {
    source: "ticktick",
    listId: task.projectId,
    taskId: task.id,
    title: task.title,
    state: "claimed",
    done: [],
  })
  await lifecycle.sweep(new Map())
  expect(threads.get(thread.id)?.todo).toMatchObject({
    done: ["run"],
    error: "TickTick action failed",
  })
})

test("production routes and PR sweep reconcile TickTick through an in-memory MCP server", async () => {
  let completeAttempts = 0
  const fake = await fakeTickTick((call) => {
    if (call.name === "complete_task" && completeAttempts++ === 0)
      return { isError: true, text: "completion failed once" }
    return undefined
  })
  const { source, calls } = fake
  const draftSource = {
    lists: async () => [...(await Effect.runPromise(source.lists()))],
    task: async (id: string) => Effect.runPromise(source.task(id)),
  }
  const { routes, threads, folder, lifecycle } = makeHarness({
    draftSource,
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      claim: (value, url) => Effect.runPromise(source.claim(value, url)),
      note: (value, text) => Effect.runPromise(source.note(value, text)),
      release: (value, reason) => Effect.runPromise(source.release(value, reason)),
      complete: (value, url, onCommented, commentPosted) =>
        Effect.runPromise(source.complete(value, url, { commentPosted, onCommented })),
    },
  })
  const response = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string }
  await eventually(() =>
    calls.some(
      (call) =>
        call.name === "add_comment" &&
        call.arguments.content === `🏭 Factory draft: http://factory.test/?thread=${created.id}`,
    ),
  )

  expect((await routes.run(created.id)).status).toBe(200)
  await eventually(() =>
    calls.some((call) => call.name === "add_comment" && call.arguments.content === "🏭 Factory started work."),
  )

  const pr = {
    number: 7,
    url: "https://github.test/pull/7",
    state: "OPEN",
    checks: "SUCCESS",
  }
  const states = new Map<string, PrState>()
  const sweep = makeTodoPrSweep({
    threads,
    prStates: states,
    repoPrs: async () => new Map([["topic", pr]]),
    onPr: (thread, value) => void states.set(thread.id, prState(value.state, value.checks)),
    todoEnabled: () => true,
    todoSweep: (prs) => lifecycle.sweep(prs),
    onError: (_id, error) => {
      throw error
    },
  })
  await sweep()
  expect(
    calls.filter(
      (call) => call.name === "add_comment" && call.arguments.content === "🏭 PR: https://github.test/pull/7",
    ),
  ).toHaveLength(1)

  pr.state = "MERGED"
  await sweep()
  expect(threads.get(created.id)?.todo?.state).toBe("claimed")
  await sweep()
  expect(threads.get(created.id)?.todo?.state).toBe("completed")
  expect(
    calls.filter(
      (call) => call.name === "add_comment" && call.arguments.content === "🏭 Merged: https://github.test/pull/7",
    ),
  ).toHaveLength(1)
})

test("run delivery succeeds when the started comment fails and the next sweep posts it once", async () => {
  let startedAttempts = 0
  let startedSucceeded = 0
  const fake = await fakeTickTick((call) => {
    const isStarted = call.name === "add_comment" && call.arguments.content === "🏭 Factory started work."
    if (isStarted && startedAttempts++ === 0) return { isError: true, text: "TickTick unavailable" }
    if (isStarted) startedSucceeded++
    return undefined
  })
  const { source, calls } = fake
  const draftSource = {
    lists: async () => [...(await Effect.runPromise(source.lists()))],
    task: async (id: string) => Effect.runPromise(source.task(id)),
  }
  const { routes, threads, folder, lifecycle } = makeHarness({
    draftSource,
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      claim: (value, url) => Effect.runPromise(source.claim(value, url)),
      note: (value, text) => Effect.runPromise(source.note(value, text)),
      release: (value, reason) => Effect.runPromise(source.release(value, reason)),
      complete: (value, url, onCommented, commentPosted) =>
        Effect.runPromise(source.complete(value, url, { commentPosted, onCommented })),
    },
  })
  const response = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string }
  expect((await routes.run(created.id)).status).toBe(200)
  await eventually(() => threads.get(created.id)?.todo?.error === "TickTick action failed")

  const sweep = makeTodoPrSweep({
    threads,
    prStates: new Map(),
    repoPrs: async () => new Map(),
    onPr: () => undefined,
    todoEnabled: () => true,
    todoSweep: (prs) => lifecycle.sweep(prs),
    onError: (_id, error) => {
      throw error
    },
  })
  await sweep()
  expect(startedSucceeded).toBe(1)
  expect(
    calls.filter((call) => call.name === "add_comment" && call.arguments.content === "🏭 Factory started work."),
  ).toHaveLength(2)
  expect(threads.get(created.id)?.todo).toMatchObject({ state: "claimed", error: undefined })
  await sweep()
  expect(startedSucceeded).toBe(1)
  expect(
    calls.filter((call) => call.name === "add_comment" && call.arguments.content === "🏭 Factory started work."),
  ).toHaveLength(2)
})

test("a failed claim does not reject creation and is posted by the next production sweep", async () => {
  let claimAttempts = 0
  const { source, calls } = await fakeTickTick((call) => {
    if (
      call.name === "add_comment" &&
      String(call.arguments.content).startsWith("🏭 Factory draft:") &&
      claimAttempts++ === 0
    )
      return { isError: true, text: "TickTick unavailable" }
    return undefined
  })
  const draftSource = {
    lists: async () => [...(await Effect.runPromise(source.lists()))],
    task: async (id: string) => Effect.runPromise(source.task(id)),
  }
  const { routes, threads, folder, lifecycle } = makeHarness({
    draftSource,
    actions: {
      task: async (id) => (await Effect.runPromise(source.task(id))).task,
      claim: (value, url) => Effect.runPromise(source.claim(value, url)),
      note: (value, text) => Effect.runPromise(source.note(value, text)),
      release: (value, reason) => Effect.runPromise(source.release(value, reason)),
      complete: (value, url, onCommented, commentPosted) =>
        Effect.runPromise(source.complete(value, url, { commentPosted, onCommented })),
    },
  })
  const response = await routes.create(
    new Request("http://factory.test/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        folderId: folder.id,
        todo: { source: "ticktick", listId: "list-1", taskId: task.id },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string }
  await eventually(() => threads.get(created.id)?.todo?.error === "TickTick action failed")

  const sweep = makeTodoPrSweep({
    threads,
    prStates: new Map(),
    repoPrs: async () => new Map(),
    onPr: () => undefined,
    todoEnabled: () => true,
    todoSweep: (prs) => lifecycle.sweep(prs),
    onError: (_id, error) => {
      throw error
    },
  })
  await sweep()
  expect(
    calls.filter(
      (call) => call.name === "add_comment" && String(call.arguments.content).startsWith("🏭 Factory draft:"),
    ),
  ).toHaveLength(2)
  expect(threads.get(created.id)?.todo).toMatchObject({ state: "claimed", error: undefined })
})
