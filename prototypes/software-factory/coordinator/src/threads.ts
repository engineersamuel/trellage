// Saved chat threads, so a conversation started in one place (a browser, the sf CLI)
// shows its messages everywhere. Messages use agent-interface's ChatMessage shape.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { addFolder, GENERAL, type Folder, type Worktree } from "./folders.ts"
import type { GoalSpec, Grade, ImprovementProposal } from "../../shared/goal.ts"

export type DraftAction = "council" | "debate" | "research" | "hyperresearch" | "deep-research"
export type DraftVersion = {
  id: string
  prompt: string
  source: "human" | "enhance"
  title?: string
  notes?: string
  at: number
}
export type Candidate = { title: string; prompt: string; notes: string }
export type Draft = {
  versions: DraftVersion[]
  current: string
  pending?: { kind: "enhance"; candidates: Candidate[]; at: number }
  reports: { action: DraftAction; workerId: string; path: string; versionId: string }[]
  startedAt?: number
}

/** folderId is "general" or a repo folder id; repo conversations also have their own worktree. */
export type Thread = {
  id: string
  title: string
  createdAt: number
  folderId: string
  /** Set when the merged worktree was removed. */ cleanedAt?: number
  /** Set when hidden from the org canvas. */ archivedAt?: number
  /** General chat that started this repo conversation; its report goes back there. */ parentThreadId?: string
  /** The Factory desk thread. */ desk?: boolean
  draft?: Draft
  /** Saved goal this run belongs to; its grades go to the goal's run log. */ goalId?: string
  /** Validated goal configuration captured before launch. */ goalSpec?: GoalSpec
  /** Durable grades, including saved-goal grades if the goal log is unavailable. */ grades?: Grade[]
  /** Latest proposal, retained for existing API clients. */ improvement?: ImprovementProposal
  /** All proposals, keyed by source grade; older approvals must remain routable. */ improvements?: ImprovementProposal[]
  /** Source thread when this is a Factory improvement run. */ improvementOf?: string
} & Partial<Worktree>
type Meta = Pick<
  Thread,
  "parentThreadId" | "desk" | "goalId" | "goalSpec" | "improvement" | "improvements" | "improvementOf"
>
export type ChatMessage =
  | { id: string; role: "user"; content: string }
  | {
      id: string
      role: "assistant"
      content: string | null
      toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
    }
  | { id: string; role: "tool"; content: string; toolCallId: string; error?: string }
  | { id: string; role: "reasoning"; content: string }
  /** AG-UI activity: a progress card (subagent, worker). One per id; a later snapshot replaces it in place. */
  | { id: string; role: "activity"; activityType: string; content: Record<string, unknown> }

/** The AG-UI events a saved run is built from; other event types are ignored. */
type RunEvent =
  | { type: "TEXT_MESSAGE_START" | "REASONING_MESSAGE_END" }
  | { type: "TEXT_MESSAGE_CONTENT" | "REASONING_MESSAGE_CONTENT"; delta: string }
  | { type: "REASONING_MESSAGE_START"; messageId: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "ACTIVITY_SNAPSHOT"; messageId: string; activityType: string; content: Record<string, unknown> }
  | { type: "TOOL_CALL_RESULT"; messageId: string; toolCallId: string; content: string; error?: string }

type Doc = { threads: Thread[]; messages: Record<string, ChatMessage[]>; folders: Folder[] }

export class Threads {
  private doc: Doc = { threads: [], messages: {}, folders: [] }
  private readonly file: string

  constructor(root: string) {
    this.file = path.join(root, "threads.json")
    try {
      if (existsSync(this.file)) this.doc = { ...this.doc, ...JSON.parse(readFileSync(this.file, "utf8")) }
    } catch {}
    for (const t of this.doc.threads) t.folderId ??= GENERAL.id
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.doc))
  }

  list(): Thread[] {
    return this.doc.threads
  }

  get(id: string): Thread | undefined {
    return this.doc.threads.find((t) => t.id === id)
  }

  folders(): Folder[] {
    return [GENERAL, ...this.doc.folders]
  }

  folder(id: string): Folder | undefined {
    return this.folders().find((f) => f.id === id)
  }

  /** Add the repo that contains `p` as a folder; the same repo always maps to the same folder. */
  addFolder(p: string): Folder {
    const f = addFolder(this.doc.folders, p)
    if (!this.doc.folders.includes(f)) {
      this.doc.folders.push(f)
      this.save()
    }
    return f
  }

  messages(id: string): ChatMessage[] {
    return this.doc.messages[id] ?? []
  }

  /** `worktree` makes the folder's worktree for the new thread id (repo folders only). */
  create(firstText: string | null, folderId = GENERAL.id, worktree?: (id: string) => Worktree): Thread {
    if (!this.folder(folderId)) throw new Error(`unknown folder ${folderId}`)
    const title = firstText ? [...firstText].slice(0, 48).join("") : "New chat"
    const id = crypto.randomUUID()
    const t: Thread = { id, title, createdAt: Date.now(), folderId, ...worktree?.(id) }
    this.doc.threads.unshift(t)
    this.save()
    return t
  }

  /** Make sure a thread exists for a run, e.g. a browser that did not call create. */
  ensure(id: string, firstText: string, folderId = GENERAL.id, worktree?: (id: string) => Worktree): void {
    if (this.doc.threads.some((t) => t.id === id)) return
    this.doc.threads.unshift({
      id,
      title: [...firstText].slice(0, 48).join(""),
      createdAt: Date.now(),
      folderId,
      ...worktree?.(id),
    })
    this.save()
  }

  update(id: string, patch: Partial<Thread>): Thread | undefined {
    const t = this.doc.threads.find((x) => x.id === id)
    if (t) Object.assign(t, { title: patch.title ?? t.title }, patch.cleanedAt ? { cleanedAt: patch.cleanedAt } : {})
    if (t && "archivedAt" in patch) {
      if (patch.archivedAt) t.archivedAt = patch.archivedAt
      else delete t.archivedAt
    }
    this.save()
    return t
  }

  /** Set routing metadata that the UI never edits. */
  setMeta(id: string, meta: Meta): void {
    const t = this.doc.threads.find((x) => x.id === id)
    if (t) {
      Object.assign(t, meta)
      this.save()
    }
  }

  /** Replays are no-ops; only an explicit regrade may replace an unknown grade with the same key. */
  addGrade(id: string, g: Grade, regrade = false): boolean {
    const t = this.doc.threads.find((x) => x.id === id)
    if (!t) return false
    const grades = (t.grades ??= [])
    const index = grades.findIndex((x) => x.key === g.key)
    if (index >= 0) {
      if (!regrade || grades[index]!.status !== "unknown") return false
      grades[index] = g
    } else grades.push(g)
    this.save()
    return true
  }

  setDraft(id: string, draft: Draft): void {
    const t = this.doc.threads.find((x) => x.id === id)
    if (t) {
      Object.assign(t, { draft })
      this.save()
    }
  }

  delete(id: string): void {
    this.doc.threads = this.doc.threads.filter((t) => t.id !== id)
    delete this.doc.messages[id]
    this.save()
  }

  append(id: string, ...msgs: ChatMessage[]): void {
    const list = (this.doc.messages[id] ??= [])
    for (const m of msgs) {
      const at = m.role === "activity" ? list.findIndex((x) => x.id === m.id) : -1
      if (at >= 0) list[at] = m
      else list.push(m)
    }
    this.save()
  }
}

/** Collect one run's AG-UI events into the assistant and tool messages to save. */
export class RunRecorder {
  private readonly out: ChatMessage[] = []
  private current: Extract<ChatMessage, { role: "assistant" }> | null = null
  private thinking: Extract<ChatMessage, { role: "reasoning" }> | null = null

  private assistant() {
    if (!this.current) {
      this.current = { id: crypto.randomUUID(), role: "assistant", content: "" }
      this.out.push(this.current)
    }
    return this.current
  }

  add(event: unknown): void {
    const e = event as RunEvent
    switch (e.type) {
      case "TEXT_MESSAGE_START":
        // A new text message after text is its own saved message (e.g. the run's card after the answer).
        if (this.current?.content) this.current = null
        break
      case "TEXT_MESSAGE_CONTENT":
        this.assistant().content += e.delta
        break
      case "REASONING_MESSAGE_START":
        // Thinking comes before the reply or the tool calls it leads to.
        this.thinking = { id: e.messageId, role: "reasoning", content: "" }
        this.out.push(this.thinking)
        this.current = null
        break
      case "REASONING_MESSAGE_CONTENT":
        if (this.thinking) this.thinking.content += e.delta
        break
      case "REASONING_MESSAGE_END":
        this.thinking = null
        break
      case "TOOL_CALL_START":
        ;(this.assistant().toolCalls ??= []).push({
          id: e.toolCallId,
          type: "function",
          function: { name: e.toolCallName, arguments: "" },
        })
        break
      case "TOOL_CALL_ARGS": {
        const call = this.current?.toolCalls?.find((c) => c.id === e.toolCallId)
        if (call) call.function.arguments += e.delta
        break
      }
      case "ACTIVITY_SNAPSHOT": {
        const m = { id: e.messageId, role: "activity" as const, activityType: e.activityType, content: e.content }
        const at = this.out.findIndex((x) => x.id === e.messageId)
        if (at >= 0) this.out[at] = m
        else this.out.push(m)
        break
      }
      case "TOOL_CALL_RESULT":
        this.out.push({
          id: e.messageId,
          role: "tool",
          content: e.content,
          toolCallId: e.toolCallId,
          ...(e.error ? { error: e.error } : {}),
        })
        this.current = null
        break
    }
  }

  messages(): ChatMessage[] {
    return this.out.filter((m) =>
      m.role === "assistant" ? m.content || m.toolCalls?.length : m.role === "reasoning" ? m.content.trim() : true,
    )
  }
}

/** Agent id of a repo conversation's sub-coordinator. */
export const subId = (threadId: string) => `sub-${threadId.slice(0, 8)}`

/**
 * The conversation a prompt to agent `agentId` is saved in. `named` (the conversation of the card the
 * prompt answers) wins only when it belongs to that agent; else the global coordinator's last-used
 * conversation, then the newest General one; a sub-coordinator's own conversation. undefined: a worker.
 */
export const messageThread = (
  list: readonly Thread[],
  agentId: string,
  named: string | undefined,
  current: string | null,
): string | undefined => {
  const n = named ? list.find((t) => t.id === named) : undefined
  if (n && (n.worktree ? subId(n.id) : "coordinator") === agentId) return n.id
  if (agentId === "coordinator")
    return list.find((t) => t.desk)?.id ?? current ?? list.find((t) => t.folderId === GENERAL.id && !t.cleanedAt)?.id
  if (agentId.startsWith("gen-")) return list.find((t) => !t.worktree && `gen-${t.id.slice(0, 8)}` === agentId)?.id
  return list.find((t) => subId(t.id) === agentId)?.id
}
