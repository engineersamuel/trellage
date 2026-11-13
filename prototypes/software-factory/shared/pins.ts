// The original prompt and the accepted plan of one sub-coordinator, from its stored events. Pure: no DOM, no fetch.
import type { Decision } from "./approvals"
import { planMarkdown, type TimelineEvent } from "./timeline"

/** Event types `pins` reads. */
export const PIN_TYPES = ["user.message", "tool.execution_start", "tool.execution_complete"] as const
export type Pins = {
  /** The first message the sub-coordinator got: its task. */
  prompt: string | null
  /** The newest plan; `accepted` when a plan approval after it got its first (recommended) option. */
  plan: { body: string; accepted: boolean } | null
}

const parse = (s: unknown): unknown => {
  if (typeof s !== "string") return s ?? null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const field = (v: unknown, k: string): unknown =>
  v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined

/** The original prompt and the accepted plan (else the newest plan). */
export const pins = (events: readonly TimelineEvent[], decisions: readonly Decision[]): Pins => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const first = sorted.find((e) => e.type === "user.message")
  const prompt = first
    ? String(first.data?.content ?? "")
        .replace(/<(ui-format|ui-context|user-instructions|disabled-tools)>[\s\S]*?<\/\1>/g, "")
        .trim() || null
    : null
  const results = new Map<string, unknown>()
  for (const e of sorted)
    if (e.type === "tool.execution_complete" && e.data?.toolCallId && e.data.success !== false) {
      const v = parse(e.data.result?.content)
      if (field(v, "error") === undefined) results.set(e.data.toolCallId, v)
    }
  // The answer comes from the decision store, else from the "[approval ID answered] "title": answer" message
  // (the store does not list older decisions).
  const answers = new Map<string, string>()
  for (const e of sorted) {
    const m =
      e.type === "user.message"
        ? /^\[approval (\S+) answered\] ".*?": (.*)$/m.exec(String(e.data?.content ?? ""))
        : null
    if (m) answers.set(m[1]!, m[2]!.trim())
  }
  for (const d of decisions) if (d.status === "answered" && d.answer !== null) answers.set(d.id, d.answer)
  let latest: Pins["plan"] = null
  let accepted: Pins["plan"] = null
  for (const e of sorted) {
    const id = e.type === "tool.execution_start" ? e.data?.toolCallId : undefined
    if (!id || !results.has(id)) continue
    const args = e.data.arguments ?? {}
    if (e.data.toolName === "sdlc_plan") latest = { body: planMarkdown(args, results.get(id)), accepted: false }
    else if (e.data.toolName === "request_approval" && latest && args.topic === "plan") {
      const did = field(results.get(id), "id")
      const answer = typeof did === "string" ? answers.get(did) : undefined
      const options: unknown[] = Array.isArray(args.options) ? args.options : []
      if (answer !== undefined && answer === String(options[0])) accepted = { ...latest, accepted: true }
    }
  }
  return { prompt, plan: accepted ?? latest }
}
