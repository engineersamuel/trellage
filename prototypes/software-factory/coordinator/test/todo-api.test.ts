import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { makeTodoApi } from "../src/todo/api.ts"
import { Threads } from "../src/threads.ts"
import type { TodoTaskWithComments } from "../src/todo/source.ts"

const task: TodoTaskWithComments = {
  task: {
    id: "task-1",
    projectId: "list-1",
    title: "Task",
    content: "Details",
    tags: ["factory"],
  },
  comments: [{ content: "A comment" }],
}

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const setup = (
  over: {
    status?: () => Promise<
      | { status: "disconnected" }
      | { status: "connected"; expiresAt: number; store: "secrets" | "file" | "memory"; warn?: boolean }
      | { status: "expired" }
    >
    lists?: () => Promise<{ id: string; name: string }[]>
    onError?: (error: unknown) => void
  } = {},
) => {
  const root = mkdtempSync(path.join(process.cwd(), ".todo-api-test-"))
  roots.push(root)
  const threads = new Threads(root)
  const linked = threads.create("Task")
  threads.setTodo(linked.id, {
    source: "ticktick",
    listId: "list-1",
    taskId: "task-1",
    title: "Task",
    state: "claimed",
    done: ["claim"],
  })
  const api = makeTodoApi({
    enabled: true,
    threads,
    uiUrl: "http://localhost:5174/",
    auth: {
      status: over.status ?? (async () => ({ status: "disconnected" as const })),
      connect: async () => new URL("https://ticktick.test/auth?state=s"),
      callback: async () => undefined,
      disconnect: async () => undefined,
    },
    source: {
      lists: over.lists ?? (async () => [{ id: "list-1", name: "Work" }]),
      tasks: async () => [task.task],
      task: async () => task,
    },
    onError: over.onError,
  })
  return { api, linked }
}

const request = (api: ReturnType<typeof makeTodoApi>, pathname: string, init?: RequestInit) =>
  api.handle(new Request(`http://factory.test${pathname}`, init), new URL(`http://factory.test${pathname}`))

test("Todo API exposes safe auth status and redirects connect", async () => {
  const token = "distinctive-status-token"
  const { api } = setup({
    status: async () =>
      ({
        status: "connected",
        expiresAt: 2_000_000,
        store: "secrets",
        warn: true,
        accessToken: token,
        authorization: `Bearer ${token}`,
      }) as never,
  })
  const status = await request(api, "/api/todo/status")
  const body = await status.text()
  expect(JSON.parse(body)).toEqual({
    state: "connected",
    expiresAt: 2_000_000,
    store: "keychain",
    warn: true,
  })
  expect(body).not.toContain(token)
  expect(body.toLowerCase()).not.toContain("bearer")
  const connect = await request(api, "/api/todo/ticktick/connect")
  expect(connect.status).toBe(302)
  expect(connect.headers.get("location")).toBe("https://ticktick.test/auth?state=s")
})

test("Todo API sanitizes status success, fallback, and upstream failure sinks", async () => {
  const token = "distinctive-status-credential"
  const logs: string[] = []
  const events: string[] = []
  for (const [raw, expected] of [
    [{ status: "disconnected", accessToken: token }, { state: "disconnected" }],
    [
      { status: "connected", expiresAt: Date.now() + 60_000, store: "file", warn: true, accessToken: token },
      { state: "connected", expiresAt: expect.any(Number), store: "file", warn: true },
    ],
    [{ status: "expired", accessToken: token }, { state: "expired" }],
    [
      {
        state: "connected",
        expiresAt: Date.now() + 60_000,
        store: "file",
        warn: true,
        accessToken: token,
        authorization: `Bearer ${token}`,
      },
      { state: "connected", expiresAt: expect.any(Number), store: "file", warn: true },
    ],
  ] as const) {
    const { api } = setup({
      status: async () => raw as never,
      onError: (error) => {
        logs.push(String(error))
        events.push(JSON.stringify({ type: "factory.todo_error", error }))
      },
    })
    const body = await (await request(api, "/api/todo/status")).text()
    expect(JSON.parse(body)).toEqual(expected)
    expect(body).not.toContain(token)
    expect(body.toLowerCase()).not.toContain("bearer")
  }
  const upstream = new Error(`status failed: Authorization: Bearer ${token}`)
  const { api } = setup({
    status: async () => {
      throw upstream
    },
    onError: (error) => {
      logs.push(String(error))
      events.push(JSON.stringify({ type: "factory.todo_error", error }))
    },
  })
  const response = await request(api, "/api/todo/status")
  const body = await response.text()
  expect(response.status).toBe(502)
  expect(JSON.parse(body)).toEqual({ error: "Todo source unavailable" })
  for (const output of [body, logs.join("\n"), events.join("\n")]) {
    expect(output).not.toContain(token)
    expect(output.toLowerCase()).not.toContain("bearer")
  }
})

test("Todo API failure logs and events receive no upstream credential or Bearer header", async () => {
  const token = "distinctive-upstream-token"
  const logs: string[] = []
  const events: string[] = []
  const upstream = new Error(`TickTick failed: Authorization: Bearer ${token}; response ${token}`)
  const { api } = setup({
    lists: async () => {
      throw upstream
    },
    onError: (error) => {
      logs.push(String(error))
      events.push(JSON.stringify({ type: "factory.todo_error", error }))
    },
  })

  const response = await request(api, "/api/todo/lists")
  const body = await response.text()
  expect(response.status).toBe(502)
  expect(JSON.parse(body)).toEqual({ error: "Todo source unavailable" })
  for (const sink of [body, JSON.stringify(logs), JSON.stringify(events)]) {
    expect(sink).not.toContain(token)
    expect(sink.toLowerCase()).not.toContain("bearer")
  }
})

test("Todo API marks linked tasks and returns a prompt preview", async () => {
  const { api, linked } = setup()
  const tasks = await request(api, "/api/todo/lists/list-1/tasks")
  expect(await tasks.json()).toEqual([{ ...task.task, threadId: linked.id }])
  const detail = await request(api, "/api/todo/tasks/task-1")
  expect(await detail.json()).toMatchObject({
    ...task,
    listId: "list-1",
    prompt: expect.stringContaining("Source: TickTick · list Work"),
  })
})

test("OAuth callback and disconnect use the production handler", async () => {
  const { api } = setup()
  const callback = await request(api, "/api/todo/ticktick/callback?code=c&state=s")
  expect(callback.status).toBe(302)
  expect(callback.headers.get("location")).toBe("http://localhost:5174/?todo=open")
  expect((await request(api, "/api/todo/ticktick", { method: "DELETE" })).status).toBe(204)
})
