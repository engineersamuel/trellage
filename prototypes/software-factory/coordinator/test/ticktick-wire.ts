// The TickTick MCP server's real contract, as seen live on 2026-11-22 (mcp.ticktick.com): the required arguments of
// each tool and the shape of its structuredContent. Test fakes register their tools with these schemas, so a call
// with a wrong argument name fails as it does on the real server, and wrap their replies with `toWire`.
import { z } from "zod"

export const TOOL_INPUTS = {
  list_projects: z.looseObject({}),
  get_project_with_undone_tasks: z.looseObject({ project_id: z.string() }),
  get_task_by_id: z.looseObject({ task_id: z.string() }),
  get_comment: z.looseObject({ project_id: z.string(), task_id: z.string() }),
  add_comment: z.looseObject({ project_id: z.string(), task_id: z.string(), title: z.string() }),
  update_task: z.looseObject({
    task_id: z.string(),
    task: z.looseObject({ id: z.string(), projectId: z.string() }),
  }),
  complete_task: z.looseObject({ project_id: z.string(), task_id: z.string() }),
} as const

export type ToolName = keyof typeof TOOL_INPUTS

/** Fields the real server always sends on a task, as null when unset. */
const taskNulls = { content: null, desc: null, dueDate: null, items: null, startDate: null, reminders: null }

const wireTask = (task: Record<string, unknown>) => ({ ...taskNulls, ...task })

/**
 * The real structuredContent for a test-friendly reply: `{projects}` → `{result: [...]}`, `{task}` →
 * `{result: task}`, `{comments: [{content}]}` → `{result: [{title}]}`, tasks with the server's null fields.
 */
export const toWire = (name: ToolName, reply: Record<string, unknown>): Record<string, unknown> => {
  if (name === "list_projects" && "projects" in reply) return { result: reply.projects }
  if (name === "get_task_by_id" && "task" in reply) return { result: wireTask(reply.task as Record<string, unknown>) }
  if (name === "get_comment" && "comments" in reply)
    return {
      result: (reply.comments as { id?: string; content: string }[]).map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        title: c.content,
      })),
    }
  if (name === "get_project_with_undone_tasks" && "tasks" in reply)
    return {
      project: reply.project ?? {},
      tasks: (reply.tasks as Record<string, unknown>[]).map(wireTask),
      columns: [],
    }
  return reply
}
