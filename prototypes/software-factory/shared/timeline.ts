// A sub-coordinator's milestones, derived from events the factory already stores: the plan (sdlc_plan), each
// decision and its answer, each worker it spawned, code and security reviews, the ship check, and the report.
// Pure: no DOM, no fetch. Every body is markdown; the UI escapes and renders it.
import type { Decision } from "./approvals"

/** One stored event, as GET /api/events returns it. */
export type TimelineEvent = { seq: number; workerId: string; type: string; timestamp: string; data: any }
/** What the timeline needs to know about a spawned worker. */
export type TimelineWorker = { status: string; model?: string | null; lastMessage?: string | null }

export type Tone = "human" | "auto" | "pending" | "ok" | "warn" | "fail" | "info"
export type Milestone = {
  /** The tool call id, review id or event seq; stable across reloads. */
  id: string
  at: number
  kind: "plan" | "approval" | "question" | "ship" | "worker" | "review" | "security" | "check" | "report"
  title: string
  /** One short line under the title. */
  sub: string
  badge: { text: string; tone: Tone } | null
  /** Markdown the detail panel shows. */
  body: string
  link?: { worker?: string; decision?: string }
}

/** Event types the timeline reads; the UI fetches only these. */
export const TIMELINE_TYPES = ["tool.execution_start", "tool.execution_complete", "factory.code_review", "factory.security_review", "factory.report_up"] as const

const parse = (s: unknown): any => {
  if (typeof s !== "string") return s ?? null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
/** SDK events carry an ISO time; factory.* events carry epoch milliseconds as a string. */
const time = (e: TimelineEvent) => (/^\d+$/.test(e.timestamp) ? Number(e.timestamp) : Date.parse(e.timestamp) || 0)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const section = (title: string, text: string) => (text.trim() ? `### ${title}\n${text.trim()}` : "")
const join = (...parts: string[]) => parts.filter(Boolean).join("\n\n")
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n")
const pct = (p: unknown) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "–")
const oneLine = (s: unknown, n = 140) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

type Gate = { id: string; chosen: boolean; probability?: number | null; threshold?: number; reason?: string; status?: string; detail?: string }
const gateTable = (gates: Gate[]) =>
  gates.length
    ? `| Gate | On | Jev | Status | Why |\n|---|---|---|---|---|\n${gates.map((g) => `| ${g.id} | ${g.chosen ? "yes" : "no"} | ${pct(g.probability)} | ${g.status ?? ""} | ${oneLine(g.detail ?? g.reason ?? "", 120)} |`).join("\n")}`
    : ""

/** The plan as markdown, from the sdlc_plan arguments and (when done) its result. */
export const planMarkdown = (args: any, result: any): string =>
  join(
    section("Request", String(args?.request ?? "")),
    section("Plan", String(args?.plan ?? "")),
    section("Acceptance criteria", strs(args?.criteria).map((c, i) => `${i + 1}. ${c}`).join("\n")),
    section("Gates Jev chose", gateTable(Array.isArray(result?.gates) ? result.gates : [])),
    section("CI checks verify runs", bullets(strs(result?.checks).map((c) => `\`${c}\``))),
  )

/** A decision request as markdown, from the request_approval / ask_user arguments. */
export const approvalMarkdown = (args: any): string => {
  const opts = strs(args?.options)
  const details = strs(args?.optionDetails)
  return join(
    String(args?.summary ?? ""),
    section("Options", opts.map((o, i) => `- **${o}**${i === 0 ? " (recommended)" : ""}${details[i] ? ` — ${details[i]}` : ""}`).join("\n")),
  )
}

/** Who answered: the human, or a goal runner's policy. Older rows only say so in the note. */
const answerer = (d: Decision): { text: string; tone: Tone } => {
  if (d.status !== "answered") return { text: "Waiting for you", tone: "pending" }
  const by = d.answeredBy ?? d.note?.match(/^Answered by (goal .+?)\.?$/)?.[1] ?? null
  return by ? { text: `Auto · ${by}`, tone: "auto" } : { text: "You answered", tone: "human" }
}

const decisionMilestone = (id: string, at: number, name: string, args: any, d: Decision | undefined): Milestone => {
  const ship = args?.ship === true || d?.topic === "ship"
  const kind: Milestone["kind"] = name === "ask_user" ? "question" : ship ? "ship" : "approval"
  const label = kind === "question" ? "Question" : ship ? "Ship request" : args?.topic === "plan" || d?.topic === "plan" ? "Plan approval" : args?.topic === "findings" || d?.topic === "findings" ? "Findings approval" : "Approval"
  const who = d ? answerer(d) : { text: "Not opened", tone: "fail" as Tone }
  const answer = d?.status === "answered"
    ? section("Answer", join(`**${d.answer}** — ${who.text}${d.answeredAt ? ` at ${new Date(d.answeredAt).toLocaleString()}` : ""}`, d.note ? `Note: ${d.note}` : ""))
    : ""
  return {
    id,
    at,
    kind,
    title: `${label}: ${oneLine(d?.title ?? args?.title ?? "", 90)}`,
    sub: d?.status === "answered" ? `→ ${oneLine(d.answer, 60)}` : d ? "waiting" : "",
    badge: who,
    body: join(approvalMarkdown(d ? { ...args, summary: d.summary, options: d.options, optionDetails: d.optionDetails } : args), answer),
    ...(d ? { link: { decision: d.id } } : {}),
  }
}

const workerMilestone = (id: string, at: number, args: any, result: any, w: TimelineWorker | undefined): Milestone => {
  const status = w?.status ?? (result?.status as string | undefined) ?? "started"
  const tone: Tone = status === "error" ? "fail" : status === "running" ? "info" : "ok"
  const model = w?.model ?? result?.model
  return {
    id,
    at,
    kind: "worker",
    title: `Worker ${args?.step ? `· ${args.step} ` : ""}· ${oneLine(args?.name ?? result?.name ?? "worker", 60)}`,
    sub: [model, w?.lastMessage ? oneLine(w.lastMessage, 100) : ""].filter(Boolean).join(" · "),
    badge: { text: status, tone },
    body: join(
      [args?.step && `**Step:** ${args.step}`, model && `**Model:** ${model}`, `**Status:** ${status}`].filter(Boolean).join("\n"),
      section("Result", String(w?.lastMessage ?? "")),
      section("Task", String(args?.task ?? "")),
    ),
    ...(result?.id ? { link: { worker: String(result.id) } } : {}),
  }
}

type Finding = { title?: string; file?: string; severity?: string; problem?: string; fix?: string; keep?: boolean; reason?: string }
const findingsMd = (fs: Finding[]) =>
  fs.map((f) => `- ${f.keep === false ? "*dropped*" : "**kept**"} ${f.severity ? `[${f.severity}] ` : ""}${f.title ?? ""}${f.file ? ` (\`${f.file}\`)` : ""}${f.problem ? ` — ${oneLine(f.problem, 400)}` : ""}${f.keep !== false && f.fix ? ` **Fix:** ${oneLine(f.fix, 300)}` : ""}`).join("\n")

const reviewMilestone = (first: TimelineEvent, last: TimelineEvent): Milestone => {
  const d = last.data ?? {}
  const security = last.type === "factory.security_review"
  const fs: Finding[] = Array.isArray(d.findings) ? d.findings : []
  const kept = fs.filter((f) => f.keep !== false).length
  const status = String(d.status ?? "")
  const done = status === "done"
  return {
    id: String(d.id ?? first.seq),
    at: time(first),
    kind: security ? "security" : "review",
    title: security ? "Security review" : `Code review${strs(d.lenses).length ? ` · ${strs(d.lenses).join(", ")}` : ""}`,
    sub: done ? `${kept} kept · ${fs.length - kept} dropped` : status,
    badge: { text: done ? (kept ? `${kept} to fix` : "clean") : status, tone: !done ? (status === "failed" ? "fail" : "info") : kept ? "warn" : "ok" },
    body: join(`**Status:** ${status}${d.model ? `\n**Model:** ${d.model}` : ""}`, section("Findings", fs.length ? findingsMd(fs) : "None.")),
    ...(d.workerId ? { link: { worker: String(d.workerId) } } : {}),
  }
}

const checkMilestone = (id: string, at: number, r: any): Milestone => {
  const blockers = strs(r?.blockers)
  return {
    id,
    at,
    kind: "check",
    title: "Ship check (sdlc_status)",
    sub: r?.readyToShip ? `ready · tier ${r?.tier?.tier ?? "?"}` : `${blockers.length} blocker(s)`,
    badge: r?.readyToShip ? { text: "ready", tone: "ok" } : { text: "blocked", tone: "warn" },
    body: join(
      r?.tier ? `**Risk tier:** ${r.tier.tier}${strs(r.tier.reasons).length ? ` — ${strs(r.tier.reasons).join("; ")}` : ""}` : "",
      section("Blockers", blockers.length ? bullets(blockers) : "None."),
      section("Acceptance criteria", strs(r?.criteria).map((c, i) => `${i + 1}. ${c}`).join("\n")),
      section("Gates", gateTable(Array.isArray(r?.gates) ? r.gates : [])),
    ),
  }
}

const reportMilestone = (e: TimelineEvent): Milestone => {
  const r = e.data?.report ?? {}
  const checks: { name?: string; result?: string; evidence?: string }[] = Array.isArray(r.checks) ? r.checks : []
  const status = String(r.status ?? "")
  return {
    id: `report-${e.seq}`,
    at: time(e),
    kind: "report",
    title: `Report up · ${status}`,
    sub: oneLine(r.summary, 120),
    badge: { text: status, tone: status === "done" ? "ok" : status === "blocked" ? "fail" : "warn" },
    body: join(
      String(r.summary ?? ""),
      r.branch ? `**Branch:** \`${r.branch}\`` : "",
      section("Checks", checks.map((c) => `- ${c.result === "pass" ? "✅" : "❌"} **${c.name ?? ""}** — ${c.evidence ?? ""}`).join("\n")),
      section("Gaps", bullets(strs(r.gaps))),
      section("Next steps", bullets(strs(r.nextSteps))),
    ),
  }
}

/** Milestones of one sub-coordinator, oldest first. `events` are its stored events (any order, any types). */
export const timeline = (events: readonly TimelineEvent[], decisions: readonly Decision[], workers: (id: string) => TimelineWorker | undefined): Milestone[] => {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const starts = new Map<string, TimelineEvent>()
  const results = new Map<string, { ok: boolean; value: any }>()
  const reviews = new Map<string, { first: TimelineEvent; last: TimelineEvent }>()
  for (const e of sorted) {
    const d = e.data ?? {}
    if (e.type === "tool.execution_start" && d.toolCallId) starts.set(d.toolCallId, e)
    else if (e.type === "tool.execution_complete" && d.toolCallId) results.set(d.toolCallId, { ok: d.success !== false, value: parse(d.result?.content) })
    else if ((e.type === "factory.code_review" || e.type === "factory.security_review") && d.id) {
      const got = reviews.get(d.id)
      reviews.set(d.id, { first: got?.first ?? e, last: e })
    }
  }
  const byId = new Map(decisions.map((d) => [d.id, d]))
  const out: Milestone[] = []
  for (const [id, e] of starts) {
    const name = String(e.data.toolName ?? "")
    const args = e.data.arguments ?? {}
    const res = results.get(id)
    const r = res?.value ?? null
    // A failed or refused call changed nothing (e.g. a ship request with blockers), so it is no milestone.
    if (res && (!res.ok || (r && typeof r === "object" && "error" in r))) continue
    const at = time(e)
    if (name === "sdlc_plan") out.push({ id, at, kind: "plan", title: "Plan recorded", sub: `${strs(args.criteria).length} acceptance criteria`, badge: null, body: planMarkdown(args, r) })
    else if (name === "request_approval" || name === "ask_user") out.push(decisionMilestone(id, at, name, args, typeof r?.id === "string" ? byId.get(r.id) : undefined))
    else if (name === "spawn_worker") out.push(workerMilestone(id, at, args, r, typeof r?.id === "string" ? workers(r.id) : undefined))
    else if (name === "sdlc_status" && r && Array.isArray(r.gates)) out.push(checkMilestone(id, at, r))
  }
  for (const { first, last } of reviews.values()) out.push(reviewMilestone(first, last))
  for (const e of sorted) if (e.type === "factory.report_up") out.push(reportMilestone(e))
  return out.sort((a, b) => a.at - b.at)
}
