// Report files that workers save in a conversation worktree, read by the UI's report viewer.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { Thread } from "./threads.ts"
import { loadPrompt } from "./prompt.ts"

export type ReportFile = {
  threadId: string
  folderId: string
  title: string
  path: string
  file: string
  content: string
}

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * Find a Markdown or JSON report. `ref` is a path relative to a worktree ("reports/synthesis.md") or an absolute
 * path inside one. With `threadId`, only that conversation's worktree is searched; else the newest worktree that
 * has the file. Symlinks resolve first, so a link cannot reach outside the worktree.
 */
export const findReport = (threads: readonly Thread[], ref: string, threadId?: string | null): ReportFile | null => {
  if (!/\.(md|mdx|json)$/i.test(ref)) return null
  const candidates = threads
    .filter((t) => t.worktree && !t.cleanedAt && existsSync(t.worktree) && (!threadId || t.id === threadId))
    .sort((a, b) => b.createdAt - a.createdAt)
  for (const t of candidates) {
    const root = realpathSync(t.worktree!)
    const raw = path.isAbsolute(ref) ? ref : path.join(t.worktree!, ref)
    if (!existsSync(raw)) continue
    const file = realpathSync(raw)
    if (!inside(root, file) || !statSync(file).isFile()) continue
    return {
      threadId: t.id,
      folderId: t.folderId,
      title: t.title,
      path: path.relative(root, file),
      file,
      content: readFileSync(file, "utf8"),
    }
  }
  return null
}

/** Task for a new conversation that implements one finding from a report. */
export const findingTask = (
  r: { path: string; file: string; title: string },
  finding: { title: string; body: string },
) =>
  loadPrompt("tasks/finding", { file: r.file, conversation: r.title, title: finding.title, body: finding.body.trim() })

/** Ranked `## <rank>. <title>` headings outside code fences. */
const rankedHeadings = (md: string): string[] => {
  let fence = false
  const out: string[] = []
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const m = !fence && line.match(/^##\s+(\d+[.)]\s+.+?)\s*$/)
    if (m) out.push(m[1]!)
  }
  return out
}

/**
 * Why reports/synthesis.brief.md does not match reports/synthesis.md, or null. Only checked when the
 * synthesis has ranked findings; a research synthesis needs no brief.
 */
export const briefProblem = (workdir: string): string | null => {
  const read = (f: string) => {
    try {
      return readFileSync(path.join(workdir, "reports", f), "utf8")
    } catch {
      return null
    }
  }
  const full = read("synthesis.md")
  if (full === null) return null
  const want = rankedHeadings(full)
  if (!want.length) return null
  const brief = read("synthesis.brief.md")
  if (brief === null) return "reports/synthesis.brief.md is missing"
  const got = rankedHeadings(brief)
  if (got.join("\n") !== want.join("\n"))
    return `reports/synthesis.brief.md headings differ from synthesis.md. Want: ${JSON.stringify(want)}. Got: ${JSON.stringify(got)}`
  const missing = want.filter((_, i) => !brief.split(/^##\s+\d+[.)]/m)[i + 1]?.includes("**TL;DR:**"))
  return missing.length ? `reports/synthesis.brief.md lacks a **TL;DR:** line under: ${missing.join("; ")}` : null
}
