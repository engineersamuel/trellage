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
// The CopilotKit UI draws show_* results with its own React cards. UIs that only draw OpenUI get the same card as an
// OpenUI Lang program, built here from the tool's JSON result and sent as its own chat message (see Translator `card`).
// A snapshot: these programs do not update live.

/** A string literal in OpenUI Lang (double quotes, backslash escapes: JSON's rules). */
const q = (s: unknown): string => JSON.stringify(String(s ?? ""))
const arr = (xs: readonly unknown[]): string => `[${xs.map(q).join(", ")}]`
const time = (at: number) => new Date(at).toISOString().slice(11, 16)

type Program = { lines: string[]; children: string[] }
const program = (): Program => ({ lines: [], children: [] })
const add = (p: Program, name: string, expr: string) => (p.lines.push(`${name} = ${expr}`), p.children.push(name))
const done = (p: Program) => [`root = Card([${p.children.join(", ")}])`, ...p.lines].join("\n")
const table = (p: Program, name: string, cols: [label: string, data: readonly unknown[]][]) => {
  cols.forEach(([label, data], i) => p.lines.push(`${name}c${i} = Col(${q(label)}, ${arr(data)}, "string")`))
  add(p, name, `Table([${cols.map((_, i) => `${name}c${i}`).join(", ")}])`)
}
const callout = (p: Program, variant: string, text: string) => add(p, `note${p.children.length}`, `Callout(${q(variant)}, "", ${q(text)})`)
const metrics = (p: Program, items: [value: string, label: string][]) =>
  add(p, "metrics", `TagBlock(${arr(items.map(([v, l]) => `${v} ${l}`))}, "md")`)

type W = { id: string; name: string; status: string; model: string; rssKb: number | null; contextTokens: number | null; contextLimit: number | null }
const workerBoard = (r: { workers?: W[]; at?: number }): string => {
  const ws = r.workers ?? []
  const p = program()
  add(p, "head", `CardHeader("Worker board", ${q(`Snapshot ${r.at ? time(r.at) : ""} UTC`)})`)
  metrics(p, [[String(ws.length), "agents"], [String(ws.filter((w) => w.status === "running").length), "running"], [String(ws.filter((w) => w.status === "error").length), "errors"]])
  if (ws.length)
    table(p, "workers", [
      ["Agent", ws.map((w) => w.name)],
      ["Status", ws.map((w) => w.status)],
      ["Model", ws.map((w) => w.model)],
      ["Memory", ws.map((w) => (w.rssKb ? `${Math.round(w.rssKb / 1024)} MB` : "–"))],
      ["Context", ws.map((w) => (w.contextLimit ? `${Math.round((100 * (w.contextTokens ?? 0)) / w.contextLimit)}%` : "–"))],
    ])
  else callout(p, "neutral", "No agents are running.")
  return done(p)
}

type Step = { step?: string; confidence?: number; moreWork?: number; request?: string }
const deliveryRun = (r: { branch?: string | null; decisions?: Step[]; note?: string }): string => {
  const steps = (r.decisions ?? []).filter((d) => d.step).slice(-6)
  const p = program()
  add(p, "head", `CardHeader("Delivery run", ${q(r.branch ? `⎇ ${r.branch}` : "")})`)
  if (!steps.length) return (callout(p, "neutral", r.note ?? "No delivery run in this conversation yet."), done(p))
  const more = [...(r.decisions ?? [])].reverse().find((d) => d.moreWork !== undefined)?.moreWork
  metrics(p, [[more === undefined ? "–" : `${Math.round((1 - more) * 100)}%`, "done"], [steps.at(-1)!.step!, "current step"]])
  steps.forEach((s, i) => p.lines.push(`s${i} = StepsItem(${q(`${s.step} · ${Math.round((s.confidence ?? 0) * 100)}%`)}, ${q((s.request ?? "").slice(0, 160))})`))
  add(p, "steps", `Steps([${steps.map((_, i) => `s${i}`).join(", ")}])`)
  return done(p)
}

type F = { title: string; severity: string; file: string; verdict: string; reason: string }
const securityReview = (r: { status?: string; model?: string; error?: string; findings?: F[] | number; note?: string }): string => {
  const p = program()
  add(p, "head", `CardHeader("Security review", ${q(r.status ? `${r.status}${r.model ? ` · ${r.model}` : ""}` : "")})`)
  if (!r.status) return (callout(p, "neutral", r.note ?? "No security review yet."), done(p))
  const fs = Array.isArray(r.findings) ? r.findings : []
  metrics(p, [[String(fs.length), "findings"], [String(fs.filter((f) => f.verdict === "keep").length), "kept"], [String(fs.filter((f) => f.verdict && f.verdict !== "keep").length), "discarded"]])
  if (r.error) callout(p, "error", r.error)
  if (fs.length)
    table(p, "findings", [
      ["Finding", fs.map((f) => `${f.title} (${f.file})`)],
      ["Severity", fs.map((f) => f.severity)],
      ["Verdict", fs.map((f) => (f.reason ? `${f.verdict}: ${f.reason}` : f.verdict || "pending"))],
    ])
  return done(p)
}

const diff = (r: DiffSummary & { error?: string }): string => {
  const p = program()
  add(p, "head", `CardHeader("Changes", ${q(r.base ? `against ${r.base.slice(0, 8)}` : "")})`)
  if (r.error) return (callout(p, "warning", r.error), done(p))
  metrics(p, [[`${r.files.length}${r.truncated ? "+" : ""}`, "files"], [`+${r.added}`, "added"], [`−${r.removed}`, "removed"]])
  if (r.files.length)
    table(p, "files", [
      ["File", r.files.map((f) => f.path)],
      ["Added", r.files.map((f) => (f.binary ? "binary" : `+${f.added}`))],
      ["Removed", r.files.map((f) => (f.binary ? "" : `−${f.removed}`))],
    ])
  else callout(p, "neutral", "No changes yet.")
  return done(p)
}

const reportFindingsCard = (r: { path?: string; findings?: { rank: number; title: string; body: string }[]; error?: string }): string => {
  const p = program()
  add(p, "head", `CardHeader("Report findings", ${q(r.path)})`)
  if (r.error) callout(p, "warning", r.error)
  const fs = r.findings ?? []
  if (!fs.length && !r.error) callout(p, "neutral", "No ranked findings in this report.")
  // Clicking a finding asks the coordinator to start it; the coordinator plans and asks for approval as usual.
  fs.forEach((f, i) => p.lines.push(`f${i} = ListItem(${q(`${f.rank}. ${f.title}`)}, ${q(plainLine(f.body))}, null, "Start", @ToAssistant(${q(`Start finding ${f.rank} of ${r.path}: ${f.title}`)}))`))
  if (fs.length) add(p, "list", `ListBlock([${fs.map((_, i) => `f${i}`).join(", ")}], "number")`)
  return done(p)
}

/** The first prose line of a finding, markdown and `File:line` lists removed, for a one-line subtitle. */
export const plainLine = (body: string): string => {
  const lines = body.split("\n").map((l) => l.replace(/[*_`>#-]/g, "").trim()).filter(Boolean)
  const prose = lines.find((l) => !/^(file:?line|files?|evidence|risk|impact)\s*:/i.test(l)) ?? lines[0] ?? ""
  return prose.length > 140 ? `${prose.slice(0, 139)}…` : prose
}

type D = { id: string; title: string; kind: string; context: string; options: string[] }
const decisionsCard = (r: { pending?: D[] | number }): string => {
  const ds = Array.isArray(r.pending) ? r.pending : []
  const p = program()
  add(p, "head", `CardHeader("Waiting for you", ${q(`${ds.length} decision${ds.length === 1 ? "" : "s"}`)})`)
  if (!ds.length) return (callout(p, "success", "Nothing is waiting."), done(p))
  // Decisions are answered by the human in the decision center; each item opens its card there.
  ds.forEach((d, i) => p.lines.push(`d${i} = ListItem(${q(d.title)}, ${q(`${d.kind} · ${d.context} · ${d.options.join(" / ") || "free answer"}`)}, null, "Answer", @OpenUrl(${q(`#decision=${d.id}`)}))`))
  add(p, "list", `ListBlock([${ds.map((_, i) => `d${i}`).join(", ")}], "number")`)
  return done(p)
}

const BUILDERS: Record<string, (r: any) => string> = {
  show_worker_board: workerBoard,
  show_delivery_run: deliveryRun,
  show_security_review: securityReview,
  show_diff_summary: diff,
  show_report_findings: reportFindingsCard,
  show_decisions: decisionsCard,
}

/** The OpenUI program for a card tool's JSON result, or null (not a card tool, or not JSON). */
export const cardOpenUi = (toolName: string, result: string): string | null => {
  const build = BUILDERS[toolName]
  if (!build) return null
  try {
    return build(JSON.parse(result))
  } catch {
    return null
  }
}
export const CARD_TOOLS = new Set(Object.keys(BUILDERS))

const STRING = /"(?:[^"\\]|\\.)*"/g

/** Rename identifiers outside string literals. Our programs use lower-case names; components are capitalised. */
const rename = (line: string, names: Set<string>, prefix: string): string => {
  const parts = line.split(STRING)
  const strings = line.match(STRING) ?? []
  return parts.map((code, i) => code.replace(/\b[a-z][a-z0-9]*\b/g, (w) => (names.has(w) ? prefix + w : w)) + (strings[i] ?? "")).join("")
}

/**
 * Several card programs (from this module) as one: Foldkit shows only a turn's last message as the answer,
 * so a turn with two cards sends one card with both. Names are prefixed per card to keep them apart.
 */
export const mergeCards = (programs: readonly string[]): string => {
  if (programs.length === 1) return programs[0]!
  const children: string[] = []
  const lines: string[] = []
  programs.forEach((prog, i) => {
    const [rootLine, ...rest] = prog.split("\n")
    const names = new Set(rest.map((l) => l.split(" = ")[0]!))
    const prefix = `k${i}`
    children.push(...rootLine!.replace(/^root = Card\(\[|\]\)$/g, "").split(", ").map((c) => prefix + c))
    lines.push(...rest.map((l) => rename(l, names, prefix)))
  })
  return [`root = Card([${children.join(", ")}])`, ...lines].join("\n")
}
