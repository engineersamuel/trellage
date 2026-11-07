// What each chat card shows, as plain data. Shared by the coordinator (OpenUI programs and GET /api/cards for
// UIs that draw OpenUI only) and the CopilotKit UI (React cards), so both UIs show the same rows and labels.
// Pure: no DOM, no React, no Effect.

export type TagVariant = "neutral" | "info" | "success" | "warning" | "danger"

// ---------- worker board ----------

type W = { id: string; name: string; role: string; status: string; model: string; rssKb: number | null; contextTokens?: number | null; contextLimit?: number | null }
const STATUS: Record<string, TagVariant> = { running: "info", idle: "success", error: "danger", stopped: "neutral" }

/** Role tag and display name (same rule as shared/tree.ts agentLabel, kept here so this file has no imports). */
const label = (w: W): { tag: string; name: string } => {
  if (w.id === "coordinator") return { tag: "🌐 Factory desk", name: "Factory desk" }
  if (w.id.startsWith("gen-")) return { tag: "💬 General chat", name: w.name.replace(/^General · /, "") }
  if (w.role === "coordinator") {
    const [folder, ...rest] = w.name.split(" · ")
    return { tag: `⎇ Sub-coordinator · ${folder}`, name: rest.join(" · ") || w.name }
  }
  return { tag: "Worker", name: w.name }
}

export type BoardRow = { id: string; name: string; kind: string; status: string; variant: TagVariant; model: string; memory: string; context: string }
export type Board = { total: number; running: number; errors: number; rows: BoardRow[] }

/** Workers → board. Coordinator first, then by name. */
export const toBoard = (workers: readonly W[]): Board => {
  const sorted = [...workers].sort((a, b) => (a.role === "coordinator" && a.id === "coordinator" ? -1 : b.id === "coordinator" ? 1 : a.name.localeCompare(b.name)))
  return {
    total: sorted.length,
    running: sorted.filter((w) => w.status === "running").length,
    errors: sorted.filter((w) => w.status === "error").length,
    rows: sorted.map((w) => ({
      id: w.id,
      name: label(w).name,
      kind: label(w).tag,
      status: w.status,
      variant: STATUS[w.status] ?? "neutral",
      model: w.model,
      memory: w.rssKb ? `${Math.round(w.rssKb / 1024)} MB` : "–",
      context: w.contextLimit ? `${Math.round((100 * (w.contextTokens ?? 0)) / w.contextLimit)}%` : "–",
    })),
  }
}

// ---------- security review ----------

type F = { title: string; severity: string; file: string; verdict: string; reason: string }
const SEVERITY: Record<string, TagVariant> = { critical: "danger", high: "danger", medium: "warning", low: "info" }

export type ReviewView = {
  status: string
  statusVariant: TagVariant
  total: number
  kept: number
  discarded: number
  rows: { title: string; severity: string; variant: TagVariant; file: string; verdict: string; reason: string }[]
}

/** Review → card. Kept findings first, then by severity. */
export const toReview = (r: { status: string; findings: readonly F[] }): ReviewView => {
  const order = ["critical", "high", "medium", "low"]
  const rank = (s: string) => {
    const i = order.indexOf(s.toLowerCase())
    return i < 0 ? order.length : i
  }
  const rows = r.findings
    .map((f) => ({ title: f.title, severity: f.severity || "unknown", variant: SEVERITY[(f.severity || "").toLowerCase()] ?? "neutral", file: f.file, verdict: f.verdict || "pending", reason: f.reason }))
    .sort((a, b) => Number(b.verdict === "keep") - Number(a.verdict === "keep") || rank(a.severity) - rank(b.severity))
  return {
    status: r.status,
    statusVariant: r.status === "done" ? "success" : r.status === "failed" ? "danger" : "info",
    total: r.findings.length,
    kept: r.findings.filter((f) => f.verdict === "keep").length,
    discarded: r.findings.filter((f) => f.verdict && f.verdict !== "keep").length,
    rows,
  }
}

// ---------- delivery run ----------

type Step = { step?: string; confidence?: number; moreWork?: number; request?: string; scopeId?: string }
export type RunView = { branch: string | null; done: string; current: string; percent: number | null; steps: { title: string; details: string }[] }

/** Only one coordinator's decisions. Untagged (older) ones belong to the Factory desk. */
export const ownSteps = <S extends Step>(all: readonly S[], scopeId: string | undefined): S[] =>
  scopeId === undefined ? [...all] : all.filter((d) => (d.scopeId ?? "coordinator") === scopeId)

/** Branch + Jev decisions → run. Fan-out decisions (no step) are skipped; at most the last 6 steps. */
export const toRun = (branch: string | null, decisions: readonly Step[]): RunView => {
  const steps = decisions.filter((d) => d.step).slice(-6)
  const more = [...decisions].reverse().find((d) => d.moreWork !== undefined)?.moreWork
  const percent = more === undefined ? null : Math.round((1 - more) * 100)
  return {
    branch,
    percent,
    done: percent === null ? "–" : `${percent}%`,
    current: steps.at(-1)?.step ?? "–",
    steps: steps.map((s) => ({ title: `${s.step} · ${Math.round((s.confidence ?? 0) * 100)}%`, details: (s.request ?? "").slice(0, 160) })),
  }
}

// ---------- decisions ----------

type D = { id: string; title: string; kind: string; context: string; options: readonly string[]; createdAt?: number }
export type DecisionRow = { id: string; title: string; kind: string; variant: TagVariant; context: string; options: string[] }

/** Pending decisions → rows, oldest first. */
export const toDecisions = (pending: readonly D[]): DecisionRow[] =>
  [...pending]
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map((d) => ({ id: d.id, title: d.title, kind: d.kind, variant: d.kind === "question" ? "warning" : "info", context: d.context, options: [...d.options] }))

// ---------- report findings ----------

/** The first prose line of a finding, markdown and `File:line` lists removed, for a one-line subtitle. */
export const plainLine = (body: string, max = 140): string => {
  const lines = body.split("\n").map((l) => l.replace(/[*_`>#-]/g, "").trim()).filter(Boolean)
  const prose = lines.find((l) => !/^(file:?line|files?|evidence|risk|impact)\s*:/i.test(l)) ?? lines[0] ?? ""
  return prose.length > max ? `${prose.slice(0, max - 1)}…` : prose
}

// ---------- card view (what GET /api/cards and the OpenUI programs read) ----------

export type Metric = { value: string; label: string }
export type CardView = {
  title: string
  subtitle: string
  metrics: Metric[]
  /** A message instead of (or above) the rows: nothing yet, an error. */
  note: string | null
  noteVariant: "neutral" | "info" | "warning" | "error" | "success"
  rows: Record<string, unknown>[]
  /** The metrics as one markdown line ("**2** agents · **0** running"), for UIs that draw one text block. */
  metricsText: string
  path?: string
}

const view = (title: string, subtitle: string, metrics: Metric[], rows: Record<string, unknown>[], note: string | null = null, noteVariant: CardView["noteVariant"] = "neutral"): CardView => ({
  title,
  subtitle,
  metrics,
  rows,
  note,
  noteVariant,
  // Wide spaces, as the CopilotKit card spaces its metrics (no separators).
  metricsText: metrics.map((m) => `**${m.value}**\u00a0${m.label}`).join("\u2003\u2003"),
})

// ---------- SDLC gates ----------

type G = { id: string; chosen: boolean; probability: number | null; threshold: number; reason: string; status: string; detail?: string }
const GATE_STATUS: Record<string, TagVariant> = { done: "success", running: "info", pending: "warning", failed: "danger", skipped: "neutral" }

export type SdlcRow = { gate: string; status: string; variant: TagVariant; why: string }

/** Gates → rows: floors (security, verify) first, then each gate with Jev's probability against its threshold. */
export const toSdlc = (d: { gates?: G[]; security?: string | null; verified?: boolean }): SdlcRow[] => [
  { gate: "verify", status: d.verified ? "done" : "pending", variant: d.verified ? "success" : "warning", why: "floor: after every implement" },
  { gate: "security", status: d.security ?? "pending", variant: GATE_STATUS[d.security ?? "pending"] ?? "info", why: "floor: every code change" },
  ...(d.gates ?? []).map((g) => {
    const status = g.chosen ? g.status : "skipped"
    return { gate: g.id, status, variant: GATE_STATUS[status] ?? "neutral", why: `${g.reason}${g.detail ? ` · ${g.detail}` : ""}` }
  }),
]

/** A show_* tool's data → the card's view. Same rows as the CopilotKit React cards. */
export const cardView = (name: string, data: any): CardView => {
  const d = data ?? {}
  switch (name) {
    case "show_worker_board": {
      const b = toBoard(d.workers ?? [])
      return view("Worker board", "Live", [{ value: String(b.total), label: "agents" }, { value: String(b.running), label: "running" }, { value: String(b.errors), label: "errors" }], b.rows, b.rows.length ? null : "No agents are running.")
    }
    case "show_delivery_run": {
      const r = toRun(d.branch ?? null, d.decisions ?? [])
      const rows = r.steps
      return view("Delivery run", r.branch ? `⎇ ${r.branch}` : "", [{ value: r.done, label: "done (Jev)" }, { value: r.current, label: "current step" }], rows, rows.length ? null : (d.note ?? "No delivery run in this conversation yet."))
    }
    case "show_security_review": {
      if (!d.status) return view("Security review", "", [], [], d.note ?? "No security review yet.")
      const v = toReview({ status: d.status, findings: d.findings ?? [] })
      return view(
        "Security review",
        `${v.status}${d.model ? ` · ${d.model}` : ""}`,
        [{ value: String(v.total), label: "findings" }, { value: String(v.kept), label: "kept (fixed)" }, { value: String(v.discarded), label: "discarded" }],
        v.rows,
        d.error ?? (v.rows.length ? null : "No findings."),
        d.error ? "error" : "success",
      )
    }
    case "show_sdlc": {
      if (!d.criteria) return view("SDLC gates", "", [], [], d.note ?? "No SDLC plan yet (sdlc_plan).")
      const rows = toSdlc(d)
      const proven = d.criteria.length - (d.unproven?.length ?? 0)
      return view(
        "SDLC gates",
        `tier ${d.tier ?? "?"}${d.reasons?.length ? ` · ${d.reasons.join("; ")}` : ""}`,
        [
          { value: `${proven}/${d.criteria.length}`, label: "criteria proven" },
          { value: String(rows.filter((r) => r.status !== "skipped").length), label: "gates on" },
          { value: `${d.kept ?? 0}/${(d.kept ?? 0) + (d.dropped ?? 0)}`, label: "review findings kept" },
        ],
        rows,
        d.blockers?.length ? `Not ready to ship: ${d.blockers.join("; ")}` : "Ready to ship.",
        d.blockers?.length ? "warning" : "success",
      )
    }
    case "show_diff_summary": {
      if (d.error) return view("Changes", "", [], [], d.error, "warning")
      const files = (d.files ?? []) as { path: string; added: number; removed: number; binary: boolean }[]
      return view(
        "Changes",
        d.base ? `against ${String(d.base).slice(0, 8)}` : "",
        [{ value: `${files.length}${d.truncated ? "+" : ""}`, label: "files" }, { value: `+${d.added ?? 0}`, label: "added" }, { value: `−${d.removed ?? 0}`, label: "removed" }],
        files.map((f) => ({ path: f.path, added: f.binary ? "binary" : `+${f.added}`, removed: f.binary ? "" : `−${f.removed}` })),
        files.length ? null : "No changes yet.",
      )
    }
    case "show_report_findings": {
      const fs = (d.findings ?? []) as { rank: number; title: string; body: string }[]
      return {
        ...view("Report findings", d.path ?? "", [], fs.map((f) => ({ rank: f.rank, title: `#${f.rank} · ${f.title}`, subtitle: plainLine(f.body, 90) })), d.error ?? (fs.length ? null : "No ranked findings in this report."), d.error ? "warning" : "neutral"),
        path: d.path ?? "",
      }
    }
    case "show_decisions": {
      const rows = toDecisions(d.pending ?? [])
      return view("Waiting for you", `${rows.length} decision${rows.length === 1 ? "" : "s"}`, [], rows, rows.length ? null : "Nothing is waiting.", "success")
    }
    default:
      return view(name, "", [], [], `Unknown card ${name}`, "warning")
  }
}
