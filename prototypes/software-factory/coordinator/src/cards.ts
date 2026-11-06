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
