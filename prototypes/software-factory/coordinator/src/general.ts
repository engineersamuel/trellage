// General chats and the Factory desk.
// Each General chat has its own coordinator session ("gen-<id>"), so a new chat starts with a clean memory.
// The Factory desk ("coordinator") owns events no chat owns: crons, supervisor issues, reports whose chat is gone.
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

/** Where a repo conversation's report goes: the General chat that started it, else the desk. */
export const reportTarget = (t: Thread, all: readonly Thread[], deskThreadId: string): string =>
  (t.parentThreadId && all.some((x) => x.id === t.parentThreadId) && t.parentThreadId) || deskThreadId

export const deletedNotice = (t: Thread) =>
  `[conversation ${t.id} deleted by the human] "${t.title}" (${t.folderId}${t.branch ? `, branch ${t.branch}` : ""}) and its worktree are gone. Ignore it: do not wait for it, quote it, or reuse it. If the same request comes again, start a new run.`
