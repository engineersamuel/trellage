// A Perplexity budget kept in a file, so a Pi worker and all its pi-subagents children share one count.
import { mcpBudgetReason, perplexityTool } from "./mcp.ts"

/** The worker's budget file, from the env pi-subagents children inherit. */
export const budgetFile = (env = process.env): string | undefined => env.SF_PERPLEXITY_BUDGET_FILE

export type BudgetState = { max: number; maxResearch: number; calls: number; research: number }

type Fs = {
  openSync: (p: string, f: string) => number
  closeSync: (fd: number) => void
  readFileSync: (p: string, e: "utf8") => string
  writeFileSync: (p: string, d: string) => void
}

/** Count one call in the file (a lock file keeps concurrent children from double counting); returns a refusal or null. */
export const takeFromFile = (file: string, toolName: string, fs: Fs): string | null => {
  const kind = perplexityTool(toolName)
  if (!kind) return null
  const lock = `${file}.lock`
  for (let i = 0; ; i++) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"))
      break
    } catch {
      if (i > 200) break // a crashed holder: count without the lock rather than block research
      Bun.sleepSync(10)
    }
  }
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as BudgetState
    const reason = mcpBudgetReason(s, kind)
    if (!reason) {
      s.calls++
      if (kind === "research") s.research++
      fs.writeFileSync(file, JSON.stringify(s))
    }
    return reason
  } finally {
    try {
      require("node:fs").rmSync(lock, { force: true })
    } catch {}
  }
}
