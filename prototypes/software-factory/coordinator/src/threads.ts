// Saved chat threads (SQLite, threads.db), so a conversation started in one place (a browser, the sf CLI)
// shows its messages everywhere. Messages use agent-interface's ChatMessage shape.
import { Database } from "bun:sqlite"
import { existsSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { addFolder, GENERAL, type Folder, type Worktree } from "./folders.ts"
import { eventKind, type EventKind } from "./turnKind.ts"
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

export type ThreadTodo = {
  source: "ticktick"
  listId: string
  taskId: string
  title: string
  state: "drafted" | "claimed" | "started" | "pr-opened" | "completed" | "released"
  done: string[]
  error?: string
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
  /** Outside task that led to this factory conversation. */
  todo?: ThreadTodo
  /** Durable grades, including saved-goal grades if the goal log is unavailable. */ grades?: Grade[]
  /** Latest proposal, retained for existing API clients. */ improvement?: ImprovementProposal
  /** All proposals, keyed by source grade; older approvals must remain routable. */ improvements?: ImprovementProposal[]
  /** Source thread when this is a Factory improvement run. */ improvementOf?: string
  /** The tournament this conversation runs; its sub-coordinator has the tournament tools. */ tournamentId?: string
} & Partial<Worktree>
type Meta = Pick<
  Thread,
  "parentThreadId" | "desk" | "goalId" | "goalSpec" | "improvement" | "improvements" | "improvementOf" | "tournamentId"
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

/** Which messages of a conversation to read. */
export type MessageQuery = {
  /** Only turns the human started, plus event turns of these kinds (src/turnKind.ts). Unset: every message. */
  show?: ReadonlySet<EventKind>
  /** The newest `limit` messages (after the filter). */
  limit?: number
}

/**
 * Conversations and their messages in SQLite (threads.db): one row per message, so an append writes one row, not the
 * whole store. Each message keeps the kind of the turn it belongs to (null: a turn the human started), so the human's
 * view of the Chief of Staff conversation is a query. The thread list is small and stays in memory too.
 */
export class Threads {
  private readonly db: Database
  private threads: Thread[]
  private folderList: Folder[]
  /** Turn kind of the newest user message per conversation: the turn that later messages belong to. */
  private readonly turn = new Map<string, EventKind | null>()

  constructor(root: string) {
    this.db = new Database(path.join(root, "threads.db"))
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    this.db.run("CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    this.db.run(
      "CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT, data TEXT NOT NULL)",
    )
    this.db.run("CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, seq)")
    this.importJson(path.join(root, "threads.json"))
    // Newest first: a new conversation is inserted last.
    this.threads = (this.db.query("SELECT data FROM threads ORDER BY rowid DESC").all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Thread,
    )
    for (const t of this.threads) t.folderId ??= GENERAL.id
    this.folderList = (this.db.query("SELECT data FROM folders ORDER BY rowid").all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as Folder,
    )
  }

  /** Move the old threads.json into the database once; the file is kept as threads.json.imported. */
  private importJson(file: string): void {
    if (!existsSync(file)) return
    let doc: { threads?: Thread[]; messages?: Record<string, ChatMessage[]>; folders?: Folder[] }
    try {
      doc = JSON.parse(readFileSync(file, "utf8"))
    } catch (e) {
      console.warn(`threads: ${file} is not valid JSON, not imported: ${e}`)
      return
    }
    this.db.transaction(() => {
      for (const t of [...(doc.threads ?? [])].reverse()) this.writeThread(t)
      for (const f of doc.folders ?? [])
        this.db.run("INSERT OR REPLACE INTO folders VALUES (?, ?)", [f.id, JSON.stringify(f)])
      for (const [id, msgs] of Object.entries(doc.messages ?? {})) this.insert(id, msgs)
    })()
    renameSync(file, `${file}.imported`)
  }

  private writeThread(t: Thread): void {
    this.db.run(
      "INSERT OR REPLACE INTO threads (rowid, id, data) VALUES ((SELECT rowid FROM threads WHERE id = ?), ?, ?)",
      [t.id, t.id, JSON.stringify(t)],
    )
  }

  private save(t: Thread | undefined): void {
    if (t) this.writeThread(t)
  }

  list(): Thread[] {
    return this.threads
  }

  get(id: string): Thread | undefined {
    return this.threads.find((t) => t.id === id)
  }

  folders(): Folder[] {
    return [GENERAL, ...this.folderList]
  }

  folder(id: string): Folder | undefined {
    return this.folders().find((f) => f.id === id)
  }

  /** Add the repo that contains `p` as a folder; the same repo always maps to the same folder. */
  addFolder(p: string): Folder {
    const f = addFolder(this.folderList, p)
    if (!this.folderList.includes(f)) {
      this.folderList.push(f)
      this.db.run("INSERT OR REPLACE INTO folders VALUES (?, ?)", [f.id, JSON.stringify(f)])
    }
    return f
  }

  /** Messages of a conversation, oldest first. */
  messages(id: string, q: MessageQuery = {}): ChatMessage[] {
    const where = ["thread_id = ?"]
    const args: (string | number)[] = [id]
    if (q.show) {
      const kinds = [...q.show]
      where.push(`(kind IS NULL${kinds.length ? ` OR kind IN (${kinds.map(() => "?").join(",")})` : ""})`)
      args.push(...kinds)
    }
    const limit = q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : ""
    const rows = this.db
      .query(
        `SELECT data FROM (SELECT data, seq FROM messages WHERE ${where.join(" AND ")} ORDER BY seq DESC${limit}) ORDER BY seq`,
      )
      .all(...args) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as ChatMessage)
  }

  /** How many messages a conversation has. */
  count(id: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(id) as { n: number }).n
  }

  /** The first message the human (or code) sent in a conversation. */
  firstUser(id: string): string | undefined {
    const r = this.db
      .query(
        "SELECT data FROM messages WHERE thread_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY seq LIMIT 1",
      )
      .get(id) as { data: string } | null
    return r ? (JSON.parse(r.data) as { content: string }).content : undefined
  }

  /** `worktree` makes the folder's worktree for the new thread id (repo folders only). */
  create(firstText: string | null, folderId = GENERAL.id, worktree?: (id: string) => Worktree): Thread {
    if (!this.folder(folderId)) throw new Error(`unknown folder ${folderId}`)
    const title = firstText ? [...firstText].slice(0, 48).join("") : "New chat"
    const id = crypto.randomUUID()
    const t: Thread = { id, title, createdAt: Date.now(), folderId, ...worktree?.(id) }
    this.threads.unshift(t)
    this.save(t)
    return t
  }

  /** Make sure a thread exists for a run, e.g. a browser that did not call create. */
  ensure(id: string, firstText: string, folderId = GENERAL.id, worktree?: (id: string) => Worktree): void {
    if (this.threads.some((t) => t.id === id)) return
    const t: Thread = {
      id,
      title: [...firstText].slice(0, 48).join(""),
      createdAt: Date.now(),
      folderId,
      ...worktree?.(id),
    }
    this.threads.unshift(t)
    this.save(t)
  }

  update(id: string, patch: Partial<Thread>): Thread | undefined {
    const t = this.get(id)
    if (t) Object.assign(t, { title: patch.title ?? t.title }, patch.cleanedAt ? { cleanedAt: patch.cleanedAt } : {})
    if (t && "archivedAt" in patch) {
      if (patch.archivedAt) t.archivedAt = patch.archivedAt
      else delete t.archivedAt
    }
    this.save(t)
    return t
  }

  /** Set routing metadata that the UI never edits. */
  setMeta(id: string, meta: Meta): void {
    const t = this.get(id)
    if (t) {
      Object.assign(t, meta)
      this.save(t)
    }
  }

  /** Replays are no-ops; only an explicit regrade may replace an unknown grade with the same key. */
  addGrade(id: string, g: Grade, regrade = false): boolean {
    const t = this.get(id)
    if (!t) return false
    const grades = (t.grades ??= [])
    const index = grades.findIndex((x) => x.key === g.key)
    if (index >= 0) {
      if (!regrade || grades[index]!.status !== "unknown") return false
      grades[index] = g
    } else grades.push(g)
    this.save(t)
    return true
  }

  setDraft(id: string, draft: Draft): void {
    const t = this.get(id)
    if (t) {
      Object.assign(t, { draft })
      this.save(t)
    }
  }

  setTodo(id: string, todo: ThreadTodo): void {
    const t = this.get(id)
    if (t) {
      Object.assign(t, { todo })
      this.save(t)
    }
  }

  delete(id: string): void {
    this.threads = this.threads.filter((t) => t.id !== id)
    this.db.transaction(() => {
      this.db.run("DELETE FROM threads WHERE id = ?", [id])
      this.db.run("DELETE FROM messages WHERE thread_id = ?", [id])
    })()
    this.turn.delete(id)
  }

  /**
   * Save messages. A user message starts a turn; the others belong to the newest turn. `kind` sets the turn kind of
   * every message in this call (a run's answer may land after a later prompt, e.g. parallel CoS events). A note that
   * code wrote (an assistant message with an event prefix) has its own kind.
   */
  append(id: string, ...msgs: ChatMessage[]): void
  append(id: string, opts: { kind: EventKind | null }, ...msgs: ChatMessage[]): void
  append(id: string, ...rest: (ChatMessage | { kind: EventKind | null })[]): void {
    const opts = rest[0] && !("role" in rest[0]) ? (rest.shift() as { kind: EventKind | null }) : null
    this.db.transaction(() => this.insert(id, rest as ChatMessage[], opts ? opts.kind : undefined))()
  }

  private insert(id: string, msgs: readonly ChatMessage[], fixed?: EventKind | null): void {
    for (const m of msgs) {
      const own = m.role === "user" || m.role === "assistant" ? eventKind(m.content) : null
      const kind =
        m.role === "assistant" && own ? own : fixed !== undefined ? fixed : m.role === "user" ? own : this.turnOf(id)
      if (m.role === "user") this.turn.set(id, kind)
      const data = JSON.stringify(m)
      // An activity card is one per id: a later snapshot replaces it in place.
      if (m.role === "activity" && this.db.query("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(id, m.id))
        this.db.run("UPDATE messages SET data = ? WHERE thread_id = ? AND id = ?", [data, id, m.id])
      else this.db.run("INSERT INTO messages (thread_id, id, kind, data) VALUES (?, ?, ?, ?)", [id, m.id, kind, data])
    }
  }

  private turnOf(id: string): EventKind | null {
    if (!this.turn.has(id)) {
      const r = this.db
        .query(
          "SELECT kind FROM messages WHERE thread_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY seq DESC LIMIT 1",
        )
        .get(id) as { kind: EventKind | null } | null
      this.turn.set(id, r?.kind ?? null)
    }
    return this.turn.get(id)!
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
