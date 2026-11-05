// Supervisor: a periodic check that finds workers that are stuck, failing, off track,
// or done but never collected, and hands the list to the coordinator to resolve.
import type { Worker } from "./factory.ts"

export type Issue = {
  worker: string
  name: string
  kind: "error" | "stalled" | "failing-tools" | "off-track" | "uncollected"
  detail: string
}

export type Limits = { stallSeconds: number; uncollectedSeconds: number; failedToolsInARow: number }

/** Pure check over worker snapshots. The coordinator itself is never reported. */
export const findIssues = (workers: Worker[], nowMs: number, l: Limits): Issue[] => {
  const out: Issue[] = []
  for (const w of workers) {
    if (w.role === "coordinator") continue
    const quietS = Math.round((nowMs - w.lastActivity) / 1000)
    const add = (kind: Issue["kind"], detail: string) => out.push({ worker: w.id, name: w.name, kind, detail })
    if (w.status === "error") add("error", w.lastError ?? "session error")
    else if (w.status === "running" && quietS >= l.stallSeconds) add("stalled", `no events for ${quietS}s`)
    if (w.failedTools >= l.failedToolsInARow) add("failing-tools", `${w.failedTools} tool calls failed in a row; last: ${w.lastError ?? "?"}`)
    if (w.status === "idle" && w.task && !w.collected && quietS >= l.uncollectedSeconds)
      add("uncollected", `finished ${quietS}s ago; result not read with read_worker`)
  }
  return out
}

/** The prompt the coordinator gets when issues exist. */
export const supervisorPrompt = (issues: Issue[]): string =>
  `[supervisor] Periodic worker check found ${issues.length} issue(s):\n` +
  issues.map((i) => `- ${i.name} (${i.worker}) ${i.kind}: ${i.detail}`).join("\n") +
  `\nResolve each one now: read_worker to see what it did, then message_worker with a concrete correction to keep it on its task, ` +
  `or stop_worker and spawn a replacement with a better task. For uncollected workers, read the result and continue the delivery loop. ` +
  `Do not ask the user unless the fix needs their decision. Report what you did in one line per worker.`
