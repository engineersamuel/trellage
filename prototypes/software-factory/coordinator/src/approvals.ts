// Decisions the human must make before the factory continues: approvals (plan, review findings)
// and questions (missing context). The coordinator opens one with request_approval or ask_user;
// any UI or the sf CLI answers it.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
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

export class Approvals {
  private items: Approval[] = []
  private readonly file: string

  constructor(root: string) {
    this.file = path.join(root, "approvals.json")
    try {
      if (existsSync(this.file)) this.items = decodeStored(JSON.parse(readFileSync(this.file, "utf8")))
    } catch (e) {
      console.warn(`approvals: ${this.file} is not valid JSON, starting empty: ${e}`)
    }
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.items.slice(-200)))
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
    this.save()
    return item
  }

  setShadow(id: string, shadow: Shadow | null): Approval | undefined {
    const a = this.get(id)
    if (a) (a.shadow = shadow), this.save()
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
    this.save()
    return a
  }
}

/** The prompt the coordinator gets when the user answers, so it continues the delivery loop. */
export const answerPrompt = (a: Approval): string => {
  const relayTo = a.reportThreadId?.replace(/[^\w-]/g, "")
  return `[${a.kind} ${a.id} answered] "${a.title}": ${a.answer}${a.note ? `\nUser note: ${a.note}` : ""}\nContinue the delivery loop accordingly.${relayTo ? `\nRelay this answer to conversation ${relayTo} with message_conversation.` : ""}`
}
