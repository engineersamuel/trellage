import type { Threads } from "../threads.ts"
import { draftPrompt, type TodoList, type TodoTask, type TodoTaskWithComments } from "./source.ts"

export type TodoAuthStatus =
  | { state: "disconnected" }
  | { state: "connected"; expiresAt: number; store: "keychain" | "file"; warn: boolean }
  | { state: "expired" }

type RawAuthStatus =
  | TodoAuthStatus
  | { status: "disconnected" }
  | { status: "connected"; expiresAt: number; store: "secrets" | "file" | "memory" }
  | { status: "expired"; expiresAt?: number }

export type TodoApiDeps = {
  enabled: boolean | (() => boolean)
  threads: Threads
  uiUrl: string
  coordinatorAddress?: string
  auth: {
    status(): Promise<RawAuthStatus>
    connect(): Promise<URL>
    callback(code: string, state: string): Promise<void>
    disconnect(): Promise<void>
  }
  source: {
    lists(): Promise<TodoList[]>
    tasks(listId: string): Promise<TodoTask[]>
    task(id: string): Promise<TodoTaskWithComments>
  }
  resetSource?: () => Promise<void>
  onError?: (error: unknown) => void
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } })
const unavailable = (): Response => json({ error: "Todo source unavailable" }, 502)
const safeError = (): Error => new Error("Todo source unavailable")
const authStatus = (status: RawAuthStatus): TodoAuthStatus => {
  if ("state" in status) {
    if (status.state === "connected")
      return {
        state: "connected",
        expiresAt: status.expiresAt,
        store: status.store,
        warn: status.warn,
      }
    return { state: status.state }
  }
  if (status.status === "connected")
    return {
      state: "connected",
      expiresAt: status.expiresAt,
      store: status.store === "file" ? "file" : "keychain",
      warn: status.expiresAt - Date.now() < 14 * 24 * 60 * 60 * 1000,
    }
  return { state: status.status }
}

const allowedTodoOrigins = (
  uiUrl: string,
  coordinatorAddress = process.env.SF_ADDR ?? "127.0.0.1:7700",
): Set<string> => {
  const origins = new Set([new URL(uiUrl, "http://localhost:5174/").origin])
  const coordinator = new URL(coordinatorAddress.includes("://") ? coordinatorAddress : `http://${coordinatorAddress}`)
  origins.add(coordinator.origin)
  if (coordinator.hostname === "localhost" || coordinator.hostname === "127.0.0.1") {
    origins.add(new URL(`http://localhost:${coordinator.port}`).origin)
    origins.add(new URL(`http://127.0.0.1:${coordinator.port}`).origin)
  }
  return origins
}

export const todoOriginDenied = (req: Request, uiUrl: string, coordinatorAddress?: string): Response | undefined => {
  const site = req.headers.get("Sec-Fetch-Site")?.toLowerCase()
  if (site === "cross-site") return new Response(null, { status: 403 })
  const origin = req.headers.get("Origin")
  if (origin === null) return undefined
  if (!URL.canParse(origin)) return new Response(null, { status: 403 })
  return allowedTodoOrigins(uiUrl, coordinatorAddress).has(new URL(origin).origin)
    ? undefined
    : new Response(null, { status: 403 })
}

export const makeTodoApi = (d: TodoApiDeps) => {
  const safe = async (run: () => Promise<Response>): Promise<Response> => {
    try {
      return await run()
    } catch {
      d.onError?.(safeError())
      return unavailable()
    }
  }
  const handle = async (req: Request, url: URL): Promise<Response> => {
    const denied = todoOriginDenied(req, d.uiUrl, d.coordinatorAddress)
    if (denied) return denied
    const enabled = typeof d.enabled === "function" ? d.enabled() : d.enabled
    if (!enabled || !url.pathname.startsWith("/api/todo/")) return new Response(null, { status: 404 })
    if (req.method === "GET" && url.pathname === "/api/todo/status")
      return safe(async () => json(authStatus(await d.auth.status())))
    if (req.method === "GET" && url.pathname === "/api/todo/ticktick/connect")
      return safe(async () => Response.redirect((await d.auth.connect()).toString(), 302))
    if (req.method === "GET" && url.pathname === "/api/todo/ticktick/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) return json({ error: "Missing OAuth callback parameters" }, 400)
      return safe(async () => {
        await d.auth.callback(code, state)
        await d.resetSource?.()
        const target = new URL(d.uiUrl)
        target.searchParams.set("todo", "open")
        return Response.redirect(target.toString(), 302)
      })
    }
    if (req.method === "DELETE" && url.pathname === "/api/todo/ticktick")
      return safe(async () => {
        await d.auth.disconnect()
        await d.resetSource?.()
        return new Response(null, { status: 204 })
      })
    if (req.method === "GET" && url.pathname === "/api/todo/lists")
      return safe(async () => json(await d.source.lists()))
    const tasks = /^\/api\/todo\/lists\/([^/]+)\/tasks$/.exec(url.pathname)
    if (req.method === "GET" && tasks) {
      const listId = decodeURIComponent(tasks[1]!)
      return safe(async () => {
        const rows = await d.source.tasks(listId)
        return json(
          rows.map((task) => ({
            ...task,
            threadId: d.threads.list().find((thread) => thread.todo?.taskId === task.id)?.id,
          })),
        )
      })
    }
    const detail = /^\/api\/todo\/tasks\/([^/]+)$/.exec(url.pathname)
    if (req.method === "GET" && detail) {
      const taskId = decodeURIComponent(detail[1]!)
      return safe(async () => {
        const result = await d.source.task(taskId)
        const list = (await d.source.lists()).find((row) => row.id === result.task.projectId)
        if (!list) return json({ error: "Todo list not found" }, 404)
        return json({
          ...result,
          listId: list.id,
          prompt: draftPrompt(result.task, list, result.comments),
        })
      })
    }
    return new Response(null, { status: 404 })
  }
  return { handle }
}
