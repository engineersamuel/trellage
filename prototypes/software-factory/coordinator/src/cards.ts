// Data for the chat cards (show_* tools). Each tool returns a small JSON snapshot; the CopilotKit UI draws it
// as a typed card and keeps it live from the factory feed. Pure helpers here, so tests need no git or factory.
import { execFileSync } from "node:child_process"

export type DiffFile = { path: string; added: number; removed: number; binary: boolean }
export type DiffSummary = { base: string; files: DiffFile[]; added: number; removed: number; truncated: boolean }

/** Files shown at most; the totals still count every file. */
export const MAX_DIFF_FILES = 60

/** `git diff --numstat` output → per-file counts. Binary files show "-" for both counts. */
export const parseNumstat = (out: string, base: string): DiffSummary => {
  const files: DiffFile[] = []
  for (const line of out.split("\n")) {
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/)
    if (!m) continue
    const binary = m[1] === "-"
    files.push({ path: m[3]!, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary })
  }
  files.sort((a, b) => b.added + b.removed - (a.added + a.removed))
  return {
    base,
    files: files.slice(0, MAX_DIFF_FILES),
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    truncated: files.length > MAX_DIFF_FILES,
  }
}

/** Committed and uncommitted changes of `workdir` against `base`. */
export const diffSummary = (workdir: string, base: string): DiffSummary =>
  parseNumstat(execFileSync("git", ["diff", "--numstat", base], { cwd: workdir, encoding: "utf8", maxBuffer: 8 << 20 }), base)

/** Ranked findings of a report: `## 1. Title` headings and their text. Same rule as the UI's report model. */
export const reportFindings = (md: string): { rank: number; title: string; body: string }[] => {
  const out: { rank: number; title: string; body: string }[] = []
  let cur: (typeof out)[number] | null = null
  let fence = false
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const m = !fence && line.match(/^##\s+(\d+)[.)]\s+(.+?)\s*$/)
    if (m) out.push((cur = { rank: Number(m[1]), title: m[2]!, body: "" }))
    else if (!fence && /^#{1,2}\s/.test(line)) cur = null
    else if (cur) cur.body += `${line}\n`
  }
  return out.map((f) => ({ ...f, body: f.body.trim().slice(0, 600) }))
}

// ---------- OpenUI programs (UIs that draw OpenUI Lang, e.g. Foldkit) ----------
// The CopilotKit UI draws show_* results with React cards. UIs that draw only OpenUI get the same card as an OpenUI
// Lang program. Its data is a live OpenUI Query ("factory_card", refreshed every few seconds from GET /api/cards);
// the tool's result is the Query's default, so the card shows at once and still renders without the live tool.
// Rows, labels and metrics come from shared/cardviews.ts, the same view the React cards use.
import { cardView } from "../../shared/cardviews.ts"

/**
 * Seconds between timed refreshes of a live card: only a safety net. Foldkit refreshes cards at once when the
 * factory feed reports a change (web-foldkit/src/subscription.ts `cardData`).
 */
export const CARD_REFRESH_SECONDS = 60

const q = (s: unknown): string => JSON.stringify(String(s ?? ""))
/** A JSON value as an OpenUI Lang literal (OpenUI accepts JSON objects and arrays). */
const lit = (v: unknown): string => JSON.stringify(v ?? null)

/** Body statements per card, reading the live view `c` (rows are objects of the card's view). */
const body = (name: string, c: string, x: string): { children: string[]; lines: string[] } => {
  const L: string[] = []
  const col = (id: string, label: string, data: string) => (L.push(`${x}${id} = Col(${q(label)}, ${data})`), `${x}${id}`)
  const table = (id: string, cols: string[]) => (L.push(`${x}${id} = Table([${cols.join(", ")}])`), `${x}${id}`)
  switch (name) {
    case "show_worker_board":
      // A row's "Show" puts that agent in the side panel (the CopilotKit card does it on row click).
      L.push(`${x}focus = Mutation("focus_agent", {id: $${x}agent})`)
      return {
        lines: L,
        children: [
          table("t", [
            col("a", "Agent", `@Each(${c}.rows, "r", Text("text", r.name, r.kind))`),
            col("s", "Status", `@Each(${c}.rows, "r", Tag(r.status, null, "sm", r.variant))`),
            col("m", "Model", `${c}.rows.model`),
            col("mem", "Memory", `${c}.rows.memory`),
            col("ctx", "Context", `${c}.rows.context`),
            col("go", "", `@Each(${c}.rows, "r", Button("Show", Action([@Set($${x}agent, r.id), @Run(${x}focus)]), "tertiary", "normal", "extra-small"))`),
          ]),
        ],
      }
    case "show_delivery_run":
      L.push(`${x}steps = Steps(@Each(${c}.rows, "s", StepsItem(s.title, s.details)))`)
      return { lines: L, children: [`${x}steps`] }
    case "show_security_review":
      return {
        lines: L,
        children: [
          table("t", [
            col("f", "Finding", `@Each(${c}.rows, "r", Text("text", r.title, r.file))`),
            col("s", "Severity", `@Each(${c}.rows, "r", Tag(r.severity, null, "sm", r.variant))`),
            col("v", "Verdict", `@Each(${c}.rows, "r", Text("text", r.verdict, r.reason))`),
          ]),
        ],
      }
    case "show_diff_summary":
      return { lines: L, children: [table("t", [col("p", "File", `${c}.rows.path`), col("a", "Added", `${c}.rows.added`), col("r", "Removed", `${c}.rows.removed`)])] }
    case "show_report_findings":
      // "Start" opens a new conversation for the finding (as the CopilotKit card's Start button does).
      L.push(`${x}start = Mutation("start_finding", {path: ${c}.path, rank: $${x}rank, scope: $${x}scope})`)
      return {
        lines: L,
        children: [
          table("t", [
            col("go", "", `@Each(${c}.rows, "r", Button("▶ Start", Action([@Set($${x}rank, r.rank), @Run(${x}start)]), "secondary", "normal", "extra-small"))`),
            col("f", "Finding", `@Each(${c}.rows, "r", Text("text", r.title, r.subtitle))`),
          ]),
        ],
      }
    case "show_decisions":
      // Each option answers in place (as in the CopilotKit decision queue), then the card refreshes.
      L.push(`${x}answer = Mutation("answer_decision", {pick: $${x}pick})`)
      return {
        lines: L,
        children: [
          table("t", [
            col("d", "Decision", `@Each(${c}.rows, "r", Text("text", r.title, r.context))`),
            col("k", "", `@Each(${c}.rows, "r", Tag(r.kind, null, "sm", r.variant))`),
            col("o", "Answer", `@Each(${c}.rows, "r", Buttons(@Each(r.options, "o", Button(o, Action([@Set($${x}pick, r.id + "|" + o), @Run(${x}answer), @Run(${x}card)]), "secondary", "normal", "extra-small"))))`),
          ]),
        ],
      }
    default:
      return { lines: L, children: [] }
  }
}

/**
 * The live OpenUI card for a show_* tool result. `scope` is the coordinator whose data it shows; `prefix` keeps the
 * names of several cards in one message apart. Null when the tool is not a card or the result is not JSON.
 */
export const cardOpenUi = (toolName: string, result: string, scope = "coordinator", args: Record<string, unknown> = {}, prefix = "x"): string | null => {
  if (!CARD_TOOLS.has(toolName)) return null
  let data: unknown
  try {
    data = JSON.parse(result)
  } catch {
    return null
  }
  const v = cardView(toolName, data)
  const x = prefix
  const c = `${x}card`
  const queryArgs = { name: toolName, scope, ...(typeof args.path === "string" ? { path: args.path } : {}) }
  const { children, lines } = body(toolName, c, x)
  const shown: string[] = [`${x}head`]
  const out = [
    `${c} = Query("factory_card", ${lit(queryArgs)}, ${lit(v)}, ${CARD_REFRESH_SECONDS})`,
    `${x}head = CardHeader(${c}.title, ${c}.subtitle)`,
  ]
  if (v.metrics.length) (out.push(`${x}metrics = TextContent(${c}.metricsText)`), shown.push(`${x}metrics`))
  // The note (nothing yet, an error) shows only while there is one; the rows show only while there are rows.
  out.push(`${x}note = ${c}.note ? Callout(${c}.noteVariant, "", ${c}.note) : null`)
  shown.push(`${x}note`)
  for (const ch of children) shown.push(`${c}.rows.length > 0 ? ${ch} : null`)
  out.push(...lines)
  return [`ROOT = Card([${shown.join(", ")}])`, ...out].join("\n")
}

export const CARD_TOOLS = new Set(["show_worker_board", "show_delivery_run", "show_security_review", "show_diff_summary", "show_report_findings", "show_decisions"])

/** Several cards (each built with its own prefix) as one program: Foldkit shows only a turn's last message as the answer. */
export const mergeCards = (programs: readonly string[]): string => {
  const children: string[] = []
  const lines: string[] = []
  for (const p of programs) {
    const [rootLine, ...rest] = p.split("\n")
    children.push(rootLine!.replace(/^ROOT = Card\(\[|\]\)$/g, ""))
    lines.push(...rest)
  }
  return [`root = Card([${children.join(", ")}])`, ...lines].join("\n")
}

export { plainLine } from "../../shared/cardviews.ts"
