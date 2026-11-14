// The Chief of Staff ("coordinator", ADR 0008) and the older General chats (archived; "gen-<id>" sessions).
// Every report, supervisor issue and cron goes to the Chief of Staff as a stateless event turn.
// Every coordinator sees the whole factory through factory_status: live state, never accumulated memory.
import type { Thread } from "./threads.ts"
import { DRAFT_NOTE, isUnstartedDraft } from "./drafts.ts"
import { catalogNames, loadPrompt } from "./prompt.ts"

export const DESK_ID = "coordinator"
export const genId = (threadId: string) => `gen-${threadId.slice(0, 8)}`

/** What a repo conversation's run is doing, from live state; never "pending" for a run nobody is executing. */
export type ConversationStatus = "running" | "idle" | "error" | "not started" | "stopped" | "deleted" | "merged"

export const conversationStatus = (
  t: Thread | undefined,
  worker: { status: string } | undefined,
  messageCount: number,
): ConversationStatus => {
  if (!t) return "deleted"
  if (t.cleanedAt) return "merged"
  if (worker) return worker.status === "running" ? "running" : worker.status === "error" ? "error" : "idle"
  // A conversation with a task but no live sub-coordinator: the factory restarted or it was stopped.
  return messageCount > 0 ? "stopped" : "not started"
}

/** Note shown to coordinators next to a conversation status: prompts/status/<status>.md, when there is one. */
export const statusNote = (status: ConversationStatus): string | undefined =>
  catalogNames("status").includes(status) ? loadPrompt(`status/${status}`) : undefined

type Agent = { id: string; name: string; status: string; owner: string }
type Decision = { id: string; title: string; threadId: string | null }

/** Compact live snapshot of the factory for any coordinator: one line of facts per conversation. */
export const factorySnapshot = (
  threads: readonly Thread[],
  agents: readonly Agent[],
  decisions: readonly Decision[],
  lastText: (threadId: string) => string | null,
  subOf: (threadId: string) => string,
  limit = 30,
) => {
  const live = new Map(agents.map((a) => [a.id, a]))
  const repo = threads.filter((t) => t.worktree).slice(0, limit)
  const conversations = repo.map((t) => {
    const sub = live.get(subOf(t.id))
    const status = conversationStatus(t, sub, lastText(t.id) === null ? 0 : 1)
    const workers = agents.filter((a) => a.owner === subOf(t.id))
    return {
      id: t.id,
      folder: t.folderId,
      title: t.title,
      branch: t.branch ?? null,
      status,
      ...(isUnstartedDraft(t) ? { note: DRAFT_NOTE } : statusNote(status) ? { note: statusNote(status) } : {}),
      ...(t.archivedAt ? { archived: true } : {}),
      ...(t.parentThreadId ? { startedFrom: t.parentThreadId } : {}),
      workers: { running: workers.filter((w) => w.status === "running").length, total: workers.length },
      last: (lastText(t.id) ?? "").replace(/\s+/g, " ").slice(0, 240) || null,
      pendingDecisions: decisions.filter((d) => d.threadId === t.id).length,
    }
  })
  return {
    at: new Date().toISOString(),
    conversations,
    generalChats: agents
      .filter((a) => a.id.startsWith("gen-"))
      .map((a) => ({ id: a.id, name: a.name, status: a.status })),
    pendingDecisions: decisions.map((d) => ({ id: d.id, title: d.title, conversation: d.threadId })),
    needsAttention: conversations
      .filter((c) => c.status === "stopped" || c.status === "error" || c.pendingDecisions)
      .map((c) => c.id),
  }
}

export const deletedNotice = (t: Thread) =>
  `[conversation ${t.id} deleted by the human] "${t.title}" (${t.folderId}${t.branch ? `, branch ${t.branch}` : ""}) and its worktree are gone. Ignore it: do not wait for it, quote it, or reuse it. If the same request comes again, start a new run.`

/** A General chat from before ADR 0008: no desk, no worktree, no draft. */
export const isOldChat = (t: Thread): boolean => t.folderId === "general" && !t.desk && !t.worktree && !t.draft

/**
 * Where a chat message goes (ADR 0008, one Chief of Staff): a new conversation in the General folder, or a message
 * to an old General chat, goes to the CoS thread; an old chat's message keeps a link back to it.
 */
export const cosRoute = (
  asked: Thread | undefined,
  newInGeneral: boolean,
  prompt: string | null,
  cosThreadId: string,
): { threadId: string | null; prompt: string | null } => {
  if (asked ? !isOldChat(asked) : !newInGeneral) return { threadId: null, prompt }
  return {
    threadId: cosThreadId,
    prompt: prompt !== null && asked ? `[from the archived chat "${asked.title}" (${asked.id})]\n${prompt}` : prompt,
  }
}
