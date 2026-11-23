import { expect, test } from "bun:test"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { Effect } from "effect"
import type { TodoTask } from "../src/todo/source.ts"
import { inMemoryTokenStore, makeTickTickAuth } from "../src/todo/ticktick-auth.ts"
import { TICKTICK_MCP_URL, TodoAuthError, makeTickTickTodoSource } from "../src/todo/ticktick.ts"
import { TOOL_INPUTS, toWire, type ToolName } from "./ticktick-wire.ts"

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

const fixture = async (
  handler: (call: ToolCall, index: number) => ToolReply | Promise<ToolReply>,
  options: { token?: string; tag?: string } = {},
) => {
  const calls: ToolCall[] = []
  const server = new SdkMcpServer({ name: "ticktick-test", version: "1" })
  const register = (name: ToolName) => {
    server.registerTool(name, { inputSchema: TOOL_INPUTS[name] }, async (args: Record<string, unknown>) => {
      const call = { name, arguments: args as Record<string, unknown> }
      calls.push(call)
      const reply = await handler(call, calls.length - 1)
      if ("isError" in reply) {
        return { isError: true as const, content: [{ type: "text" as const, text: reply.text }] }
      }
      const structuredContent = toWire(
        name,
        name === "get_comment" && !("comments" in reply.structuredContent) ? { comments: [] } : reply.structuredContent,
      )
      return { structuredContent, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }] }
    })
  }
  ;(Object.keys(TOOL_INPUTS) as ToolName[]).forEach(register)
  void [
    "list_projects",
    "get_project_with_undone_tasks",
    "get_task_by_id",
    "get_comment",
    "add_comment",
    "update_task",
    "complete_task",
  ]
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const tokenStore = inMemoryTokenStore()
  if (options.token !== undefined) {
    await tokenStore.set({
      clientId: "client-1",
      redirectUri: "http://localhost/callback",
      accessToken: options.token,
    })
  }
  const auth = makeTickTickAuth({ store: tokenStore })
  const source = makeTickTickTodoSource({
    accessToken: async () => {
      const token = await auth.accessToken()
      if (!token) throw new Error("TickTick source is disconnected")
      return token
    },
    markExpired: () => auth.markUnauthorized(),
    tag: options.tag,
    transportFactory: () => clientTransport,
  })
  return { source, auth, tokenStore, server, calls }
}

test("TickTick source proves structured MCP lists, tasks, and task plus comments", async () => {
  const { source, server, calls } = await fixture(
    (call) => {
      if (call.name === "list_projects") {
        return { structuredContent: { projects: [{ id: "project-1", name: "Work" }] } }
      }
      if (call.name === "get_project_with_undone_tasks") {
        return { structuredContent: { project: {}, tasks: [task()] } }
      }
      if (call.name === "get_task_by_id") return { structuredContent: { task: task() } }
      return { structuredContent: { comments: [{ content: "hello" }] } }
    },
    { token: "secret" },
  )

  expect(await Effect.runPromise(source.lists())).toEqual([{ id: "project-1", name: "Work" }])
  expect(await Effect.runPromise(source.tasks("project-1"))).toEqual([task()])
  expect(await Effect.runPromise(source.task("task-1"))).toEqual({
    task: task(),
    comments: [{ content: "hello" }],
  })
  expect(calls).toEqual([
    { name: "list_projects", arguments: {} },
    { name: "get_project_with_undone_tasks", arguments: { project_id: "project-1" } },
    { name: "get_task_by_id", arguments: { task_id: "task-1" } },
    { name: "get_comment", arguments: { project_id: "project-1", task_id: "task-1" } },
  ])
  await server.close()
})

test("claim preserves tags, handles null and empty tags, and posts once with the fresh etag", async () => {
  for (const [freshTags, expectedTags] of [
    [
      ["owner", "two"],
      ["owner", "two", "factory"],
    ],
    [null, ["factory"]],
    [[], ["factory"]],
  ] as const) {
    const { source, server, calls } = await fixture(
      (call) => {
        if (call.name === "get_task_by_id") {
          return { structuredContent: { task: task({ tags: freshTags, etag: "fresh-etag" }) } }
        }
        return { structuredContent: {} }
      },
      { token: "secret" },
    )

    await Effect.runPromise(source.claim(task({ tags: ["stale"] }), "http://ui/?thread=abc"))
    expect(calls).toEqual([
      { name: "get_task_by_id", arguments: { task_id: "task-1" } },
      {
        name: "update_task",
        arguments: {
          task_id: "task-1",
          task: { id: "task-1", projectId: "project-1", tags: [...expectedTags], etag: "fresh-etag" },
        },
      },
      { name: "get_comment", arguments: { project_id: "project-1", task_id: "task-1" } },
      {
        name: "add_comment",
        arguments: {
          project_id: "project-1",
          task_id: "task-1",
          title: "🏭 Factory draft: http://ui/?thread=abc 🏭 [sf:abc:claim]",
        },
      },
    ])
    await server.close()
  }
})

test("claim keeps a configured tag unique", async () => {
  const { source, server, calls } = await fixture(
    (call) => {
      if (call.name === "get_task_by_id")
        return {
          structuredContent: { task: task({ tags: ["owner", "work"], etag: "fresh-etag" }) },
        }
      return { structuredContent: {} }
    },
    { tag: "work", token: "secret" },
  )

  await Effect.runPromise(source.claim(task(), "http://ui/?thread=abc"))
  expect(calls[1]).toMatchObject({
    name: "update_task",
    arguments: { task: { tags: ["owner", "work"], etag: "fresh-etag" } },
  })
  await server.close()
})

test("release preserves owner tags and posts the stopped transcript once", async () => {
  const { source, server, calls } = await fixture(
    (call) => {
      if (call.name === "get_task_by_id")
        return {
          structuredContent: {
            task: task({ tags: ["one", "factory", "two"], etag: "fresh-etag" }),
          },
        }
      return { structuredContent: {} }
    },
    { token: "secret" },
  )

  await Effect.runPromise(source.release(task(), "Draft discarded"))
  expect(calls).toEqual([
    { name: "get_task_by_id", arguments: { task_id: "task-1" } },
    {
      name: "update_task",
      arguments: {
        task_id: "task-1",
        task: { id: "task-1", projectId: "project-1", tags: ["one", "two"], etag: "fresh-etag" },
      },
    },
    {
      name: "add_comment",
      arguments: { project_id: "project-1", task_id: "task-1", title: "🏭 Factory stopped: Draft discarded" },
    },
  ])
  await server.close()
})

test("claim retries a conflict once with newly observed owner tags and surfaces a second conflict", async () => {
  let reads = 0
  const { source, server, calls } = await fixture(
    (call) => {
      if (call.name === "get_task_by_id") {
        reads++
        return {
          structuredContent: {
            task: task({
              tags: reads === 1 ? ["one"] : ["one", "new-owner"],
              etag: `etag-${reads}`,
            }),
          },
        }
      }
      if (call.name === "update_task") return { isError: true, text: "etag conflict" }
      return { structuredContent: {} }
    },
    { token: "secret" },
  )

  await expect(Effect.runPromise(source.claim(task(), "http://ui/?thread=abc"))).rejects.toThrow(
    "TickTick task changed",
  )
  const tagUpdates = calls.filter((call) => call.name === "update_task")
  expect(tagUpdates).toHaveLength(2)
  expect(tagUpdates.map((call) => call.arguments.task)).toMatchObject([
    { tags: ["one", "factory"], etag: "etag-1" },
    { tags: ["one", "new-owner", "factory"], etag: "etag-2" },
  ])
  expect(calls.filter((call) => call.name === "get_task_by_id")).toHaveLength(2)
  expect(calls.filter((call) => call.name === "add_comment")).toEqual([])
  await server.close()
})

test("tag edits retry an etag conflict once and then comment on success", async () => {
  let reads = 0
  const { source, server, calls } = await fixture(
    (call) => {
      if (call.name === "get_task_by_id") {
        reads++
        return {
          structuredContent: {
            task: task({ tags: ["one", "factory", "two"], etag: `etag-${reads}` }),
          },
        }
      }
      if (call.name === "update_task" && reads === 1) return { isError: true, text: "etag conflict" }
      return { structuredContent: {} }
    },
    { token: "secret" },
  )

  await Effect.runPromise(source.release(task(), "Draft discarded"))
  expect(calls.filter((call) => call.name === "update_task").map((call) => call.arguments.task)).toMatchObject([
    { tags: ["one", "two"], etag: "etag-1" },
    { tags: ["one", "two"], etag: "etag-2" },
  ])
  expect(calls.at(-1)).toEqual({
    name: "add_comment",
    arguments: { project_id: "project-1", task_id: "task-1", title: "🏭 Factory stopped: Draft discarded" },
  })
  await server.close()
})

test("a note is plain text truncated to 1024 characters", async () => {
  const { source, server, calls } = await fixture(() => ({ structuredContent: {} }), {
    token: "secret",
  })
  await Effect.runPromise(source.note(task(), "x".repeat(1100)))
  expect(calls).toEqual([
    { name: "add_comment", arguments: { project_id: "project-1", task_id: "task-1", title: "x".repeat(1024) } },
  ])
  await server.close()
})

test("a marked note keeps the marker intact inside the 1024 character limit", async () => {
  const { source, server, calls } = await fixture(() => ({ structuredContent: {} }), {
    token: "secret",
  })
  await Effect.runPromise(source.note(task(), "x".repeat(1100), "thread-1:run"))
  const posted = calls.find((call) => call.name === "add_comment")?.arguments.title
  expect(String(posted)).toHaveLength(1024)
  expect(String(posted).endsWith("🏭 [sf:thread-1:run]")).toBe(true)
  await server.close()
})

test("complete posts the exact PR URL before completing the project task", async () => {
  const { source, server, calls } = await fixture(() => ({ structuredContent: {} }), {
    token: "secret",
  })
  await Effect.runPromise(source.complete(task(), "https://github.example/pull/7"))
  expect(calls).toEqual([
    {
      name: "add_comment",
      arguments: { project_id: "project-1", task_id: "task-1", title: "🏭 Merged: https://github.example/pull/7" },
    },
    { name: "complete_task", arguments: { project_id: "project-1", task_id: "task-1" } },
  ])
  await server.close()
})

test("401 becomes TodoAuthError and marks the injected auth status expired", async () => {
  const { source, server, auth } = await fixture(() => ({ isError: true, text: "HTTP 401 Unauthorized" }), {
    token: "secret",
  })
  await expect(Effect.runPromise(source.lists())).rejects.toBeInstanceOf(TodoAuthError)
  expect(await auth.status()).toEqual({ status: "expired" })
  await server.close()
})

test("a disconnected request reconnects after OAuth makes a token available", async () => {
  const { source, server, tokenStore } = await fixture(() => ({
    structuredContent: { result: [{ id: "project-1", name: "Work" }] },
  }))

  await expect(Effect.runPromise(source.lists())).rejects.toThrow("TickTick MCP request failed")
  await tokenStore.set({
    clientId: "client-1",
    redirectUri: "http://localhost/callback",
    accessToken: "new-token",
  })
  await expect(Effect.runPromise(source.lists())).resolves.toEqual([{ id: "project-1", name: "Work" }])
  await server.close()
})

test("the HTTP transport receives the endpoint, Bearer header, and injected fetch", async () => {
  const fetch = (async () => new Response()) as unknown as typeof globalThis.fetch
  let seenUrl: URL | undefined
  let seenHeaders: HeadersInit | undefined
  const store = inMemoryTokenStore()
  await store.set({
    clientId: "client-1",
    redirectUri: "http://localhost/callback",
    accessToken: "token-value",
  })
  const auth = makeTickTickAuth({ store })
  const server = new SdkMcpServer({ name: "ticktick-test", version: "1" })
  server.registerTool("list_projects", { inputSchema: z.looseObject({}) }, async () => ({
    structuredContent: { result: [{ id: "project-1", name: "Work" }] },
    content: [{ type: "text" as const, text: "ok" }],
  }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const source = makeTickTickTodoSource({
    accessToken: async () => (await auth.accessToken())!,
    fetch,
    transportFactory: (url, options) => {
      seenUrl = url
      seenHeaders = options.requestInit?.headers
      return clientTransport
    },
  })

  await expect(Effect.runPromise(source.lists())).resolves.toEqual([{ id: "project-1", name: "Work" }])
  expect(seenUrl?.href).toBe(TICKTICK_MCP_URL)
  expect(new Headers(seenHeaders).get("Authorization")).toBe("Bearer token-value")
  await server.close()
})

test("the HTTP transport drops a disconnected or replaced account bearer", async () => {
  const store = inMemoryTokenStore()
  await store.set({
    clientId: "client-1",
    redirectUri: "http://localhost/callback",
    accessToken: "account-a",
    expiresAt: Date.now() + 60_000,
  })
  const auth = makeTickTickAuth({ store })
  const requests: Request[] = []
  const fetch = (async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.method === "GET") return new Response(null, { status: 405 })
    const message = JSON.parse(await request.text()) as { id?: string | number; method?: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "ticktick-test", version: "1" },
          }
        : {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { result: [{ id: "project-1", name: "Work" }] },
          }
    return Response.json({ jsonrpc: "2.0", id: message.id, result })
  }) as typeof globalThis.fetch
  const source = makeTickTickTodoSource({
    accessToken: async () => {
      const token = await auth.accessToken()
      if (!token) throw new Error("TickTick source is disconnected")
      return token
    },
    fetch,
  })

  await expect(Effect.runPromise(source.lists())).resolves.toEqual([{ id: "project-1", name: "Work" }])
  const connectedRequests = requests.length
  await auth.disconnect()
  await expect(Effect.runPromise(source.lists())).rejects.toThrow()
  expect(requests).toHaveLength(connectedRequests)
  await store.set({
    clientId: "client-2",
    redirectUri: "http://localhost/callback",
    accessToken: "account-b",
    expiresAt: Date.now() + 60_000,
  })
  const reconnectAt = requests.length
  await expect(Effect.runPromise(source.lists())).resolves.toEqual([{ id: "project-1", name: "Work" }])

  const toolRequests = requests.filter((request) => request.url === TICKTICK_MCP_URL && request.method === "POST")
  expect(toolRequests.map((request) => request.headers.get("authorization"))).not.toContain("Bearer ")
  expect(toolRequests.some((request) => request.headers.get("authorization") === "Bearer account-a")).toBe(true)
  expect(
    requests.slice(reconnectAt).every((request) => request.headers.get("authorization") === "Bearer account-b"),
  ).toBe(true)
})
