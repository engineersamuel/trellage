import { Schema } from "effect"
import { DraftError } from "../drafts.ts"
import type { Thread, Threads } from "../threads.ts"
import type { TodoDraftLink } from "./draft.ts"

const TodoLinkBody = Schema.Struct({
  source: Schema.Literal("ticktick"),
  listId: Schema.String,
  taskId: Schema.String,
})
const CreateBody = Schema.Struct({
  folderId: Schema.String,
  prompt: Schema.optionalKey(Schema.String),
  todo: Schema.optionalKey(TodoLinkBody),
})

const json = (value: unknown, status = 200): Response => Response.json(value, { status })
const empty = (status: number): Response => new Response(null, { status })

const draftBody = async (req: Request): Promise<typeof CreateBody.Type> => {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new DraftError(400, "body is not JSON")
  }
  try {
    return Schema.decodeUnknownSync(CreateBody)(raw)
  } catch {
    throw new DraftError(400, "invalid draft request")
  }
}

const draftReply = async (run: () => unknown): Promise<Response> => {
  try {
    const value = await run()
    return value === undefined ? empty(204) : json(value)
  } catch (error) {
    if (error instanceof DraftError) return json({ error: error.message }, error.status)
    return json({ error: "Draft request failed" }, 500)
  }
}

export type TodoRouteDeps = {
  enabled(): boolean
  threads: Threads
  drafts: {
    create(folderId: string, prompt: string): Thread
    run(id: string): unknown
    remove(id: string): Promise<void>
  }
  createTodoDraft(folderId: string, link: TodoDraftLink): Promise<Thread>
  discard(thread: Thread, reason: string): Promise<void>
  deleteThread(id: string): Promise<void>
}

/** Production HTTP handlers for the draft and conversation routes which integrate Todo lifecycle actions. */
export const makeTodoRoutes = (d: TodoRouteDeps) => ({
  create: (req: Request): Promise<Response> =>
    draftReply(async () => {
      const body = await draftBody(req)
      if (!body.todo) {
        if (!body.prompt) throw new DraftError(400, "prompt is required")
        return d.drafts.create(body.folderId, body.prompt)
      }
      if (!d.enabled()) throw new DraftError(404, "Todo sources are disabled")
      return d.createTodoDraft(body.folderId, body.todo)
    }),
  run: (id: string): Promise<Response> => draftReply(() => d.drafts.run(id)),
  discardDraft: (id: string): Promise<Response> => draftReply(() => d.drafts.remove(id)),
  deleteThread: async (id: string): Promise<Response> => {
    const thread = d.threads.get(id)
    if (thread?.todo && d.enabled()) await d.discard(thread, "conversation deleted")
    await d.deleteThread(id)
    return empty(204)
  },
})
