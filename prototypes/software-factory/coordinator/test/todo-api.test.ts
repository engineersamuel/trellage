import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
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

const setup = () => {
  const threads = new Threads(mkdtempSync(path.join(tmpdir(), "sf-todo-api-")))
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
      status: async () => ({ state: "disconnected" as const }),
      connect: async () => new URL("https://ticktick.test/auth?state=s"),
      callback: async () => undefined,
      disconnect: async () => undefined,
    },
    source: {
      lists: async () => [{ id: "list-1", name: "Work" }],
      tasks: async () => [task.task],
      task: async () => task,
    },
  })
  return { api, linked }
}

const request = (api: ReturnType<typeof makeTodoApi>, pathname: string, init?: RequestInit) =>
  api.handle(new Request(`http://factory.test${pathname}`, init), new URL(`http://factory.test${pathname}`))

test("Todo API exposes safe auth status and redirects connect", async () => {
  const { api } = setup()
  const status = await request(api, "/api/todo/status")
  expect(await status.json()).toEqual({ state: "disconnected" })
  const connect = await request(api, "/api/todo/ticktick/connect")
  expect(connect.status).toBe(302)
  expect(connect.headers.get("location")).toBe("https://ticktick.test/auth?state=s")
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
