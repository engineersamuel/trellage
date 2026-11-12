// Cost of a sub-coordinator run (GET /api/costs/<thread>) or of the whole factory (GET /api/costs), drawn as a
// one-line summary and a table. USD, GitHub AI Credits (AIC) and tokens. `~` marks AIC partly estimated from tokens.
import { Schema } from "effect"
import { json, runOr } from "./http"

const Totals = Schema.Struct({
  calls: Schema.Number,
  totalTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  aicEstimated: Schema.Number,
  aic: Schema.Number,
  usd: Schema.Number,
  unpricedCalls: Schema.Number,
})
type Totals = typeof Totals.Type
const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: Schema.String,
  step: Schema.optional(Schema.NullOr(Schema.String)),
  own: Totals,
})
const Run = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  agent: Schema.String,
  total: Totals,
  agents: Schema.optional(Schema.Array(Agent)),
})
const Report = Schema.Struct({ global: Totals, goalPage: Totals, runs: Schema.Array(Run) })

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n))
const aic = (t: Totals) => `${t.aicEstimated > 0 ? "~" : ""}${t.aic.toFixed(1)}${t.unpricedCalls ? "+?" : ""}`
const usd = (t: Totals) => `$${t.usd.toFixed(2)}`

/** "$83.36 · ~8335.9 AIC · 66.0M tokens · 1028 calls" */
export const costLine = (t: Totals): string =>
  `${usd(t)} · ${aic(t)} AIC · ${tok(t.totalTokens)} tokens · ${t.calls} calls`

const NOTE =
  "AIC = GitHub AI Credits as Copilot reports them per call. ~ = part estimated from tokens at Copilot's rates (Claude/Pi workers, proxy calls). +? = calls with no known rate, left out."

type Summary = { at: number; text: string | null }
const summaries = new Map<string, Summary>()
const FRESH_MS = 15_000

/** Cached one-line cost of a run (`threadId`) or of the factory (`null`). Fetches when stale; `onLoad` fires on new data. */
export const costSummary = (threadId: string | null, onLoad: () => void): string | null => {
  const key = threadId ?? ""
  const c = summaries.get(key)
  if (c && Date.now() - c.at < FRESH_MS) return c.text
  summaries.set(key, { at: Date.now(), text: c?.text ?? null })
  const load = threadId
    ? runOr(json(`/api/costs/${encodeURIComponent(threadId)}`, Run), null).then((r) => r && r.total)
    : runOr(json("/api/costs", Report), null).then((r) => r && r.global)
  void load.then((t) => {
    if (!t) return
    summaries.set(key, { at: Date.now(), text: costLine(t) })
    onLoad()
  })
  return c?.text ?? null
}

const table = (head: string[], rows: string[][]): HTMLTableElement => {
  const t = document.createElement("table")
  t.className = "sf-cost"
  const tr = (cells: string[], tag: "th" | "td") => {
    const r = document.createElement("tr")
    cells.forEach((c, i) => {
      const x = document.createElement(tag)
      x.textContent = c
      if (i > 0) x.style.textAlign = "right"
      r.append(x)
    })
    return r
  }
  t.append(tr(head, "th"), ...rows.map((r) => tr(r, "td")))
  return t
}
const cols = (t: Totals) => [usd(t), aic(t), tok(t.totalTokens), tok(t.outputTokens), String(t.calls)]
const HEAD = ["USD", "AIC", "tokens", "output", "calls"]

/** Mount the cost table of a run (one row per agent, own calls) or of the factory (one row per run); refreshes every 15 s. */
export const mountCost = (box: HTMLElement, threadId: string | null): (() => void) => {
  const draw = async () => {
    if (threadId) {
      const r = await runOr(json(`/api/costs/${encodeURIComponent(threadId)}`, Run), null)
      if (!r) return void box.replaceChildren("No cost data for this run.")
      const depth = new Map<string, number>()
      const rows = (r.agents ?? []).map((a) => {
        const d = a.id === r.agent ? 0 : (depth.get(a.owner) ?? 0) + 1
        depth.set(a.id, d)
        return [`${"  ".repeat(d)}${a.name}${a.step ? ` [${a.step}]` : ""}`, ...cols(a.own)]
      })
      box.replaceChildren(table(["Agent (own calls)", ...HEAD], [["RUN TOTAL", ...cols(r.total)], ...rows]), note())
    } else {
      const r = await runOr(json("/api/costs", Report), null)
      if (!r) return void box.replaceChildren("No cost data.")
      const rows = r.runs.map((x) => [`${x.threadId.slice(0, 8)} ${x.title}`.slice(0, 60), ...cols(x.total)])
      box.replaceChildren(
        table(
          ["Sub-coordinator run", ...HEAD],
          [["GLOBAL (all agents)", ...cols(r.global)], ["Goal page", ...cols(r.goalPage)], ...rows],
        ),
        note(),
      )
    }
  }
  const note = () => Object.assign(document.createElement("p"), { className: "sf-cost-note", textContent: NOTE })
  void draw()
  const timer = setInterval(() => void draw(), FRESH_MS)
  return () => clearInterval(timer)
}
