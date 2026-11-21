import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer, Option, Schema } from "effect"
import {
  TodoComment,
  TodoList,
  TodoSource,
  TodoTask,
  type TodoReleaseCheckpoint,
  type TodoSourceApi,
  type TodoTask as TodoTaskValue,
} from "./source.ts"

export const TICKTICK_MCP_URL = "https://mcp.ticktick.com/"

const ProjectsResult = Schema.Struct({ projects: Schema.Array(TodoList) })
const ListsResult = Schema.Struct({ lists: Schema.Array(TodoList) })
const ProjectTasksResult = Schema.Struct({
  project: Schema.optionalKey(Schema.Unknown),
  tasks: Schema.Array(TodoTask),
})
const TaskResult = Schema.Struct({ task: TodoTask })
const CommentsResult = Schema.Struct({ comments: Schema.Array(TodoComment) })

type ToolResult = Pick<CallToolResult, "content" | "structuredContent" | "isError">

export interface TickTickMcpClient {
  connect(transport: Transport): Promise<void>
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult>
}

export interface TickTickExpiredStatus {
  expired(): Promise<void> | void
}

export interface TickTickStatusService {
  markExpired(): Promise<void> | void
}

export type TickTickToken = string | (() => string | Promise<string>)
export type TickTickExpiredMarker = (() => Promise<void> | void) | TickTickExpiredStatus | TickTickStatusService

export type TickTickTransportOptions = {
  fetch?: typeof globalThis.fetch
  requestInit?: RequestInit
}

export type TickTickTodoSourceOptions = {
  accessToken?: TickTickToken
  token?: TickTickToken
  tag?: string
  fetch?: typeof globalThis.fetch
  endpoint?: string | URL
  expired?: TickTickExpiredMarker
  onExpired?: TickTickExpiredMarker
  status?: TickTickExpiredMarker
  markExpired?: TickTickExpiredMarker
  transportFactory?: (url: URL, options: TickTickTransportOptions) => Transport
  clientFactory?: () => TickTickMcpClient
}

export class TodoAuthError extends Error {
  readonly code = 401
  readonly name = "TodoAuthError"
}

export class TodoTickTickError extends Error {
  readonly name = "TodoTickTickError"
}

class TodoTickTickConflictError extends Error {
  readonly name = "TodoTickTickConflictError"
}

const textLength = (text: string): string => text.slice(0, 1024)

const authError = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined || seen.has(value)) return false
    if (typeof value === "object" || typeof value === "function") seen.add(value)
    if (typeof value === "number") return value === 401
    if (typeof value === "string") return /\b401\b|unauthori[sz]ed/i.test(value)
    if (typeof value === "object") {
      const record = value as Record<string, unknown>
      return (
        authErrorCode(record) ||
        visit(record.code) ||
        visit(record.status) ||
        visit(record.statusCode) ||
        visit(record.message) ||
        visit(record.cause)
      )
    }
    return false
  }
  return visit(error)
}

const authErrorCode = (record: Record<string, unknown>): boolean =>
  record.code === 401 || record.status === 401 || record.statusCode === 401

const isConflict = (error: unknown): boolean => {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    if (record.code === 409 || record.status === 409 || record.statusCode === 409) return true
    current = record.cause
  }
  return error instanceof Error && /409|conflict|etag|task changed/i.test(error.message)
}

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  resultName: string,
): S["Type"] => {
  const result = Schema.decodeUnknownOption(schema)(value)
  if (Option.isNone(result)) throw new TodoTickTickError(`Invalid TickTick ${resultName} response`)
  return result.value
}

const markExpired = async (marker: TickTickExpiredMarker | undefined): Promise<void> => {
  if (!marker) return
  if (typeof marker === "function") return marker()
  if ("markExpired" in marker && marker.markExpired) return marker.markExpired()
  if ("expired" in marker && marker.expired) return marker.expired()
}

export const makeTickTickTodoSource = (options: TickTickTodoSourceOptions): TodoSourceApi => {
  const endpoint = options.endpoint instanceof URL ? options.endpoint : new URL(options.endpoint ?? TICKTICK_MCP_URL)
  const configuredTag = options.tag ?? "factory"
  const expired = options.expired ?? options.onExpired ?? options.status ?? options.markExpired
  let connection: Promise<TickTickMcpClient> | undefined

  const fail = async (error: unknown): Promise<never> => {
    if (error instanceof TodoTickTickConflictError) throw error
    if (authError(error)) {
      connection = undefined
      try {
        await markExpired(expired)
      } catch {
        // The original authentication failure remains the useful result.
      }
      throw new TodoAuthError("TickTick authorization expired")
    }
    if (isConflict(error)) throw new TodoTickTickConflictError("TickTick task changed")
    throw new TodoTickTickError("TickTick MCP request failed")
  }

  const connect = (): Promise<TickTickMcpClient> => {
    if (!connection) {
      const opening = (async () => {
        const tokenOption = options.accessToken ?? options.token
        if (tokenOption === undefined) return fail(new Error("No TickTick token"))
        const token = typeof tokenOption === "function" ? await tokenOption() : tokenOption
        const transportOptions: TickTickTransportOptions = {
          fetch: options.fetch,
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }
        const transport = options.transportFactory
          ? options.transportFactory(endpoint, transportOptions)
          : new StreamableHTTPClientTransport(endpoint, transportOptions)
        const client = options.clientFactory
          ? options.clientFactory()
          : (new Client({ name: "trellage-factory", version: "1.0.0" }) as TickTickMcpClient)
        try {
          await client.connect(transport)
          return client
        } catch (error) {
          return fail(error)
        }
      })()
      connection = opening
      void opening.catch(() => {
        if (connection === opening) connection = undefined
      })
    }
    return connection
  }

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    try {
      const result = await (await connect()).callTool({ name, arguments: args })
      if (result.isError) {
        const detail = result.content
          .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
          .join(" ")
        if (/409|conflict|etag/i.test(detail)) throw new TodoTickTickConflictError("TickTick task changed")
        if (authError(detail)) throw new TodoAuthError("TickTick authorization expired")
        throw new TodoTickTickError("TickTick MCP request failed")
      }
      return result.structuredContent
    } catch (error) {
      return fail(error)
    }
  }

  const listProjects = async (): Promise<readonly TodoList[]> => {
    const value = await call("list_projects")
    const projects = Schema.decodeUnknownOption(ProjectsResult)(value)
    if (Option.isSome(projects)) return projects.value.projects
    const lists = decode(ListsResult, value, "project list")
    return lists.lists
  }

  const projectTasks = async (listId: string): Promise<readonly TodoTaskValue[]> =>
    decode(ProjectTasksResult, await call("get_project_with_undone_tasks", { projectId: listId }), "task list").tasks

  const taskById = async (id: string): Promise<TodoTaskValue> => {
    const value = await call("get_task_by_id", { task_id: id })
    const wrapped = Schema.decodeUnknownOption(TaskResult)(value)
    return Option.isSome(wrapped) ? wrapped.value.task : decode(TodoTask, value, "task")
  }

  const commentsById = async (id: string): Promise<readonly (typeof TodoComment.Type)[]> =>
    decode(CommentsResult, await call("get_comment", { task_id: id }), "comments").comments

  const addComment = async (task: TodoTaskValue, content: string, marker?: string): Promise<void> => {
    const existingMarker = /🏭 \[sf:[^\]]+\]/.exec(content)?.[0]
    const stableMarker = existingMarker ?? (marker ? `🏭 [sf:${marker}]` : undefined)
    const body = existingMarker ? content.replace(existingMarker, "").trimEnd() : content
    const text = stableMarker ? `${body.slice(0, 1024 - stableMarker.length - 1)} ${stableMarker}` : textLength(body)
    if (stableMarker) {
      const existing = await commentsById(task.id)
      if (existing.some((comment) => comment.content.includes(stableMarker))) return
    }
    await call("add_comment", { task_id: task.id, content: text })
  }

  const updateTags = async (
    task: TodoTaskValue,
    change: (tags: readonly string[]) => string[],
  ): Promise<TodoTaskValue> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await taskById(task.id)
      const tags = change(fresh.tags ?? [])
      const updated = { ...fresh, tags }
      try {
        await call("update_task", {
          task_id: fresh.id,
          task: { ...updated, etag: fresh.etag },
        })
        return updated
      } catch (error) {
        if (attempt === 0 && isConflict(error)) continue
        throw error
      }
    }
    throw new TodoTickTickError("TickTick task changed; retry failed")
  }

  return {
    lists: () => Effect.promise(() => listProjects().then((lists) => [...lists])),
    tasks: (listId) => Effect.promise(() => projectTasks(listId).then((tasks) => [...tasks])),
    task: (id) =>
      Effect.promise(async () => ({
        task: await taskById(id),
        comments: [...(await commentsById(id))],
      })),
    note: (task, text, marker) => Effect.promise(() => addComment(task, text, marker)),
    claim: (task, threadUrl, marker) =>
      Effect.promise(async () => {
        const threadId = /(?:^|[?&])thread=([^&]+)/.exec(threadUrl)?.[1]?.slice(0, 8)
        const commentMarker = marker ?? (threadId ? `${threadId}:claim` : undefined)
        const updated = await updateTags(task, (tags) =>
          tags.includes(configuredTag) ? [...tags] : [...tags, configuredTag],
        )
        await addComment(updated, `🏭 Factory draft: ${threadUrl}`, commentMarker)
      }),
    release: (task: TodoTaskValue, reason: string, checkpoint?: TodoReleaseCheckpoint, marker?: string) =>
      Effect.promise(async () => {
        if (checkpoint && !checkpoint.active()) throw new Error("TickTick release canceled")
        const updated = await updateTags(task, (tags) => tags.filter((tag) => tag !== configuredTag))
        if (checkpoint && !checkpoint.active()) throw new Error("TickTick release canceled")
        checkpoint?.commentStarted?.()
        await addComment(updated, `🏭 Factory stopped: ${reason}`, checkpoint?.marker ?? marker)
      }),
    complete: (task, prUrl, checkpoint) =>
      Effect.promise(async () => {
        if (!checkpoint?.commentPosted) {
          await addComment(task, `🏭 Merged: ${prUrl}`, checkpoint?.marker)
          checkpoint?.onCommented()
        }
        await call("complete_task", { project_id: task.projectId, task_id: task.id })
      }),
  }
}

export const tickTickTodoLayer = (options: TickTickTodoSourceOptions) =>
  Layer.succeed(TodoSource, makeTickTickTodoSource(options))

export const tickTickLayer = tickTickTodoLayer

export const makeTickTick = makeTickTickTodoSource
