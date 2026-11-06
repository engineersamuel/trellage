// Decisions the human must make before the factory continues: approvals (plan, review findings)
// and questions (missing context). The coordinator opens one with request_approval or ask_user;
// any UI or the sf CLI answers it.
import { Database } from "bun:sqlite"
import { existsSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { decodeDecision } from "../../shared/approvals.ts"
import type { Shadow } from "./shadow.ts"

export type Approval = {
  id: string
  /** approval: pick one option. question: pick an option or answer in free text. */
  kind: "approval" | "question"
  /** Conversation the request belongs to, so a UI can open it. */
  threadId: string | null
  title: string
  /** Markdown body: what was done and what happens on each choice. */
  summary: string
  options: string[]
  /** Optional one-line consequence per option ("what happens next"), same order as options. */
  optionDetails: string[]
  /** Free-text answers are allowed (always true for questions). */
  allowText: boolean
  /** Short label of who asks and why, e.g. "coordinator · review of b39040eb". */
  context: string
  status: "pending" | "answered"
  answer: string | null
  note: string | null
  createdAt: number
  /** Conversation whose report this decision answers; the answer is relayed to it. */
  reportThreadId?: string
  /** Shadow mode: what Jev predicted the human would answer. */
  shadow?: Shadow | null
}

/**
 * Decode stored rows with the same Schema the UIs use. Older rows get defaults (kind, context, ...);
 * a row that cannot be decoded is dropped with a warning instead of losing the whole file.
 */
export const decodeStored = (rows: unknown): Approval[] => {
  if (!Array.isArray(rows)) return []
  const out: Approval[] = []
  for (const row of rows) {
    const exit = decodeDecision(row)
    if (exit._tag === "Success") out.push(exit.value as Approval)
    else console.warn(`approvals: dropped a stored row that does not match the schema: ${JSON.stringify(row).slice(0, 200)}`)
  }
  return out
}

/** An accepted ship approval: the branch a finish worker may push, and the pushes made under it so far. */
export type ShipGrant = { id: string; scopeId: string; branch: string; pushes: number }

const KEEP = 200

/** Decisions and ship grants in SQLite (approvals.db), so both survive a restart. */
export class Approvals {
  private items: Approval[] = []
  private readonly db: Database

  constructor(root: string) {
    this.db = new Database(path.join(root, "approvals.db"), { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL)")
    this.db.run(
      "CREATE TABLE IF NOT EXISTS ship_grants (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, branch TEXT NOT NULL, pushes INTEGER NOT NULL DEFAULT 0)",
    )
    this.importJson(path.join(root, "approvals.json"))
    const rows = this.db.query("SELECT data FROM approvals ORDER BY created_at, rowid").all() as { data: string }[]
    this.items = decodeStored(rows.map((r) => JSON.parse(r.data)))
  }

  /** Move an approvals.json from before SQLite into the table once, then rename it. */
  private importJson(file: string) {
    if (!existsSync(file)) return
    try {
      const rows = decodeStored(JSON.parse(readFileSync(file, "utf8")))
      const insert = this.db.prepare("INSERT OR IGNORE INTO approvals (id, created_at, data) VALUES (?, ?, ?)")
      this.db.transaction(() => rows.forEach((a) => insert.run(a.id, a.createdAt, JSON.stringify(a))))()
    } catch (e) {
      console.warn(`approvals: ${file} is not valid JSON, not imported: ${e}`)
    }
    renameSync(file, `${file}.imported`)
  }

  private save(a: Approval) {
    this.db.run("INSERT OR REPLACE INTO approvals (id, created_at, data) VALUES (?, ?, ?)", [a.id, a.createdAt, JSON.stringify(a)])
  }

  /** Keep the newest KEEP decisions; an older one's ship grant goes with it. */
  private prune() {
    if (this.items.length <= KEEP) return
    const old = this.items.splice(0, this.items.length - KEEP).map((a) => a.id)
    const marks = old.map(() => "?").join(",")
    this.db.run(`DELETE FROM approvals WHERE id IN (${marks})`, old)
    this.db.run(`DELETE FROM ship_grants WHERE id IN (${marks})`, old)
  }

  /** Mark approval `id` as a request to ship `branch` from conversation `scopeId`. */
  addShip(id: string, scopeId: string, branch: string): void {
    this.db.run("INSERT OR IGNORE INTO ship_grants (id, scope_id, branch) VALUES (?, ?, ?)", [id, scopeId, branch])
  }

  /** Ship grants whose approval the human answered with the first option, oldest first. */
  acceptedShips(scopeId: string, branch: string): ShipGrant[] {
    const rows = this.db
      .query("SELECT id, scope_id AS scopeId, branch, pushes FROM ship_grants WHERE scope_id = ? AND branch = ? ORDER BY rowid")
      .all(scopeId, branch) as ShipGrant[]
    return rows.filter((g) => {
      const a = this.get(g.id)
      return a?.status === "answered" && a.answer === a.options[0]
    })
  }

  /** Save a grant's push count. */
  setPushes(g: ShipGrant): void {
    this.db.run("UPDATE ship_grants SET pushes = ? WHERE id = ?", [g.pushes, g.id])
  }

  list(): Approval[] {
    return this.items
  }

  pending(): Approval[] {
    return this.items.filter((a) => a.status === "pending")
  }

  get(id: string): Approval | undefined {
    return this.items.find((x) => x.id === id)
  }

  open(a: Pick<Approval, "threadId" | "title" | "summary" | "options"> & Partial<Pick<Approval, "kind" | "allowText" | "context" | "optionDetails" | "reportThreadId">>): Approval {
    const kind = a.kind ?? "approval"
    if (a.optionDetails && a.optionDetails.length && a.optionDetails.length !== a.options.length)
      throw new Error("optionDetails must have one entry per option")
    const item: Approval = { kind, allowText: kind === "question" || (a.allowText ?? false), context: a.context ?? "coordinator", ...a, optionDetails: a.optionDetails ?? [], id: crypto.randomUUID().slice(0, 8), status: "pending", answer: null, note: null, createdAt: Date.now() }
    this.items.push(item)
    this.save(item)
    this.prune()
    return item
  }

  setShadow(id: string, shadow: Shadow | null): Approval | undefined {
    const a = this.get(id)
    if (a) (a.shadow = shadow), this.save(a)
    return a
  }

  /** Record the answer. Throws on an unknown id, a closed approval, or an option that was not offered. */
  answer(id: string, answer: string, note: string | null): Approval {
    const a = this.items.find((x) => x.id === id)
    if (!a) throw new Error(`unknown approval ${id}`)
    if (a.status !== "pending") throw new Error(`approval ${id} is already answered: ${a.answer}`)
    if (!answer.trim()) throw new Error("answer is empty")
    if (!a.allowText && !a.options.includes(answer)) throw new Error(`answer must be one of ${JSON.stringify(a.options)}`)
    Object.assign(a, { status: "answered", answer, note })
    this.save(a)
    return a
  }
}

/** The prompt the coordinator gets when the user answers, so it continues the delivery loop. */
export const answerPrompt = (a: Approval): string => {
  const relayTo = a.reportThreadId?.replace(/[^\w-]/g, "")
  return `[${a.kind} ${a.id} answered] "${a.title}": ${a.answer}${a.note ? `\nUser note: ${a.note}` : ""}\nContinue the delivery loop accordingly.${relayTo ? `\nRelay this answer to conversation ${relayTo} with message_conversation.` : ""}`
}
