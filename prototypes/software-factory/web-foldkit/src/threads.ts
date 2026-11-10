// The chat's thread list. The coordinator lists drafts too; the chat hides the ones not started yet.
import type { Thread } from "@plana-solutions/agent-interface"
import { Effect } from "effect"
import { type Thread as FactoryThread, Threads } from "../../shared/schemas"
import { getJson } from "./api"

/** An unstarted draft is not a conversation yet: it runs from its draft detail in the Inbox. */
export const isUnstartedDraft = (thread: FactoryThread): boolean => !!thread.draft && !thread.draft.startedAt

/** The conversations the chat's thread list shows. */
export const chatThreads = (threads: ReadonlyArray<FactoryThread>): ReadonlyArray<Thread> =>
  threads.filter((t) => !isUnstartedDraft(t)).map(({ id, title, createdAt }) => ({ id, title, createdAt }))

/** GET /api/threads/get, decoded with the factory schema (it keeps `draft`), as the chat's thread list. */
export const fetchChatThreads: Effect.Effect<ReadonlyArray<Thread>, string> = getJson("/api/threads/get", Threads).pipe(
  Effect.map(({ threads }) => chatThreads(threads)),
)
