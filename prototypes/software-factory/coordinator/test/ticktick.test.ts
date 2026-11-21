import { expect, test } from "bun:test"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { Effect } from "effect"
import type { TodoTask } from "../src/todo/source.ts"
import { TICKTICK_MCP_URL, TodoAuthError, makeTickTickTodoSource } from "../src/todo/ticktick.ts"

type ToolCall = { name: string; arguments: Record<string, unknown> }
type ToolReply = { structuredContent: Record<string, unknown> } | { isError: true; text: string }

const task = (over: Partial<TodoTask> = {}): TodoTask => ({
  id: "task-1",
  projectId: "project-1",
  title: "Ship it",
  tags: ["owner"],
  etag: "etag-1",
  ...over,
})

const fixture = async (handler: (call: ToolCall, index: number) => ToolReply | Promise<ToolReply>) => {
  const calls: ToolCall[] = []
  const server = new SdkMcpServer({ name: "ticktick-test", version: "1" })
  const register = (name: string) => {
    server.registerTool(name, { inputSchema: z.looseObject({}) }, async (args) => {
      const call = { name, arguments: args as Record<string, unknown> }
      calls.push(call)
      const reply = await handler(call, calls.length - 1)
      if ("isError" in reply) {
        return { isError: true as const, content: [{ type: "text" as const, text: reply.text }] }
      }
      return {
        structuredContent: reply.structuredContent,
        content: [{ type: "text" as const, text: JSON.stringify(reply.structuredContent) }],
      }
    })
  }
  ;[
    "list_projects",
    "get_project_with_undone_tasks",
    "get_task_by_id",
    "get_comment",
    "add_comment",
    "update_task",
    "complete_task",
  ].forEach(register)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const source = makeTickTickTodoSource({
    accessToken: "secret",
    transportFactory: () => clientTransport,
  })
  return { source, server, calls }
}

test("TickTick source decodes structured MCP reads and uses the documented arguments", async () => {
  const { source, server, calls } = await fixture((call) => {
    if (call.name === "list_projects") {
      return { structuredContent: { projects: [{ id: "project-1", name: "Work" }] } }
    }
    if (call.name === "get_project_with_undone_tasks") {
      return { structuredContent: { project: {}, tasks: [task()] } }
    }
    if (call.name === "get_task_by_id") return { structuredContent: { task: task() } }
    return { structuredContent: { comments: [{ content: "hello" }] } }
  })

  expect(await Effect.runPromise(source.lists())).toEqual([{ id: "project-1", name: "Work" }])
  expect(await Effect.runPromise(source.tasks("project-1"))).toEqual([task()])
  expect(await Effect.runPromise(source.task("task-1"))).toEqual({
    task: task(),
    comments: [{ content: "hello" }],
  })
  expect(calls).toEqual([
    { name: "list_projects", arguments: {} },
    { name: "get_project_with_undone_tasks", arguments: { projectId: "project-1" } },
    { name: "get_task_by_id", arguments: { task_id: "task-1" } },
    { name: "get_comment", arguments: { task_id: "task-1" } },
  ])
  await server.close()
})

test("claim rereads a task, preserves tags, handles null, and comments the draft URL", async () => {
  const { source, server, calls } = await fixture((call) => {
    if (call.name === "get_task_by_id") {
      return { structuredContent: { task: task({ tags: null, etag: "fresh-etag" }) } }
    }
    return { structuredContent: {} }
  })

  await Effect.runPromise(source.claim(task({ tags: ["stale"] }), "http://ui/?thread=abc"))
  expect(calls[1]).toEqual({
    name: "update_task",
    arguments: {
      task_id: "task-1",
      task: task({ tags: ["factory"], etag: "fresh-etag" }),
    },
  })
  expect(calls[2]).toEqual({
    name: "add_comment",
    arguments: { task_id: "task-1", content: "🏭 Factory draft: http://ui/?thread=abc" },
  })
  await server.close()
})

test("tag edits preserve owner tags and retry an etag conflict once", async () => {
  let updates = 0
  const { source, server, calls } = await fixture((call) => {
    if (call.name === "get_task_by_id") {
      updates++
      return {
        structuredContent: {
          task: task({ tags: ["one", "factory", "two"], etag: `etag-${updates}` }),
        },
      }
    }
    if (call.name === "update_task" && updates === 1) {
      return { isError: true, text: "etag conflict" }
    }
    return { structuredContent: {} }
  })

  await Effect.runPromise(source.release(task(), "Draft discarded"))
  const tagUpdates = calls.filter((call) => call.name === "update_task")
  expect(tagUpdates).toHaveLength(2)
  expect(tagUpdates.map((call) => call.arguments.task)).toMatchObject([
    { tags: ["one", "two"], etag: "etag-1" },
    { tags: ["one", "two"], etag: "etag-2" },
  ])
  expect(calls.at(-1)?.arguments.content).toBe("🏭 Factory stopped: Draft discarded")
  await server.close()
})

test("a note is plain text truncated to 1024 characters", async () => {
  const { source, server, calls } = await fixture(() => ({ structuredContent: {} }))
  await Effect.runPromise(source.note(task(), "x".repeat(1100)))
  expect(calls).toEqual([{ name: "add_comment", arguments: { task_id: "task-1", content: "x".repeat(1024) } }])
  await server.close()
})

test("complete completes the project task without owning the merge note", async () => {
  const { source, server, calls } = await fixture(() => ({ structuredContent: {} }))
  await Effect.runPromise(source.complete(task(), "https://github.example/pull/7"))
  expect(calls).toEqual([{ name: "complete_task", arguments: { project_id: "project-1", task_id: "task-1" } }])
  await server.close()
})

test("401 becomes TodoAuthError and marks the injected auth status expired", async () => {
  let expired = 0
  const { source, server } = await fixture(() => ({
    isError: true,
    text: "HTTP 401 Unauthorized",
  }))
  const marked = makeTickTickTodoSource({
    accessToken: "do-not-display",
    status: {
      markExpired: () => {
        expired++
      },
    },
    clientFactory: () => ({
      connect: async () => {},
      callTool: async () => ({
        content: [{ type: "text", text: "401 Unauthorized" }],
        isError: true,
      }),
    }),
    transportFactory: () => InMemoryTransport.createLinkedPair()[0],
  })

  await expect(Effect.runPromise(marked.lists())).rejects.toBeInstanceOf(TodoAuthError)
  expect(expired).toBe(1)
  await expect(Effect.runPromise(source.lists())).rejects.toThrow("TickTick authorization expired")
  await server.close()
})

test("a disconnected request reconnects after OAuth makes a token available", async () => {
  let available = false
  let connects = 0
  const source = makeTickTickTodoSource({
    accessToken: async () => {
      if (!available) throw new Error("TickTick source is disconnected")
      return "new-token"
    },
    clientFactory: () => ({
      connect: async () => {
        connects++
      },
      callTool: async () => ({
        content: [],
        structuredContent: { projects: [{ id: "project-1", name: "Work" }] },
      }),
    }),
    transportFactory: () => InMemoryTransport.createLinkedPair()[0],
  })

  await expect(Effect.runPromise(source.lists())).rejects.toThrow("TickTick MCP request failed")
  available = true
  await expect(Effect.runPromise(source.lists())).resolves.toEqual([{ id: "project-1", name: "Work" }])
  expect(connects).toBe(1)
})

test("a rejected MCP connect does not poison later requests", async () => {
  let available = false
  let connects = 0
  const source = makeTickTickTodoSource({
    accessToken: "secret",
    clientFactory: () => ({
      connect: async () => {
        connects++
        if (!available) throw new Error("offline")
      },
      callTool: async () => ({
        content: [],
        structuredContent: { projects: [{ id: "project-1", name: "Work" }] },
      }),
    }),
    transportFactory: () => InMemoryTransport.createLinkedPair()[0],
  })

  await expect(Effect.runPromise(source.lists())).rejects.toThrow("TickTick MCP request failed")
  available = true
  await expect(Effect.runPromise(source.lists())).resolves.toEqual([{ id: "project-1", name: "Work" }])
  expect(connects).toBe(2)
})

test("the HTTP transport receives the endpoint, Bearer header, and injected fetch", async () => {
  const fetch = (async () => new Response()) as unknown as typeof globalThis.fetch
  let seenUrl: URL | undefined
  let seenHeaders: HeadersInit | undefined
  const source = makeTickTickTodoSource({
    accessToken: () => "token-value",
    fetch,
    clientFactory: () => ({
      connect: async () => {
        throw { code: 401 }
      },
      callTool: async () => ({ content: [], isError: false }),
    }),
    transportFactory: (url, options) => {
      seenUrl = url
      seenHeaders = options.requestInit?.headers
      return InMemoryTransport.createLinkedPair()[0]
    },
  })

  await expect(Effect.runPromise(source.lists())).rejects.toBeInstanceOf(TodoAuthError)
  expect(seenUrl?.href).toBe(TICKTICK_MCP_URL)
  expect(new Headers(seenHeaders).get("Authorization")).toBe("Bearer token-value")
})
