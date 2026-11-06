// One record of a repo conversation's delivery: which agents ran (with their step), decisions, security
// reviews and the branch's PR. `sf verify` checks it against an expectation file.
import { execFile } from "node:child_process"

export type RunWorker = { id: string; name: string; step: string | null; harness: string; owner: string; status: string }
export type RunPr = { number: number; url: string; state: string; head: string; checks: ChecksState }
export type ChecksState = "SUCCESS" | "PENDING" | "FAILURE" | "NONE"
export type Run = {
  threadId: string
  status: string
  branch: string | null
  base: string | null
  workers: RunWorker[]
  steps: string[]
  approvals: { id: string; title: string; status: string; answer: string | null }[]
  securityReviews: { id: string; status: string }[]
  /** Newest report_up of the conversation: done, blocked or needs-decision. */
  report: { status: string; summary: string; gaps: string[] } | null
  pr: RunPr | null
}

/** Every agent started under `root` (directly or through an agent it started), newest summary per id. */
export const runWorkers = (
  started: { id: string; name: string; step?: string | null; harness?: string; owner: string }[],
  root: string,
  liveStatus: (id: string) => string | undefined,
): RunWorker[] => {
  const byId = new Map(started.map((w) => [w.id, w]))
  const owners = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const w of byId.values()) if (owners.has(w.owner) && !owners.has(w.id)) owners.add(w.id), (grew = true)
  }
  return [...byId.values()]
    .filter((w) => w.id !== root && owners.has(w.owner))
    .map((w) => ({ id: w.id, name: w.name, step: w.step ?? null, harness: w.harness ?? "copilot", owner: w.owner, status: liveStatus(w.id) ?? "stopped" }))
}

type Check = { status?: string; conclusion?: string; state?: string }

/** gh's statusCheckRollup as one state: any failure fails, any unfinished check is pending. */
export const checksState = (rollup: Check[]): ChecksState => {
  if (!rollup.length) return "NONE"
  const results = rollup.map((c) => (c.state ?? (c.status === "COMPLETED" ? c.conclusion : "PENDING") ?? "PENDING").toUpperCase())
  if (results.some((r) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(r))) return "FAILURE"
  return results.every((r) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(r)) ? "SUCCESS" : "PENDING"
}

/** The newest PR of `branch`, from the GitHub CLI in `repo`. Null when there is none or gh fails. */
export const branchPr = (repo: string, branch: string): Promise<RunPr | null> =>
  new Promise((resolve) =>
    execFile(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state,headRefOid,statusCheckRollup"],
      { cwd: repo, timeout: 20_000 },
      (err, out) => {
        if (err) return resolve(null)
        const pr = (JSON.parse(out) as { number: number; url: string; state: string; headRefOid: string; statusCheckRollup: Check[] }[])[0]
        resolve(pr ? { number: pr.number, url: pr.url, state: pr.state, head: pr.headRefOid, checks: checksState(pr.statusCheckRollup ?? []) } : null)
      },
    ),
  )

/** What `sf verify` expects: steps that must have run at least once, and the PR's state and checks. */
export type Expectation = { steps?: string[]; pr?: { state?: string; checks?: ChecksState } }

/** Each unmet expectation as one line; empty when the run meets them all. */
export const unmet = (run: Run, expect: Expectation): string[] => {
  const out = (expect.steps ?? []).filter((s) => !run.steps.includes(s)).map((s) => `step ${s} never ran`)
  if (expect.pr) {
    if (!run.pr) out.push("no PR for the branch")
    else {
      if (expect.pr.state && run.pr.state !== expect.pr.state) out.push(`PR #${run.pr.number} is ${run.pr.state}, expected ${expect.pr.state}`)
      if (expect.pr.checks && run.pr.checks !== expect.pr.checks) out.push(`PR #${run.pr.number} checks ${run.pr.checks}, expected ${expect.pr.checks}`)
    }
  }
  return out
}

/** Why polling should stop before the expectation is met: the run waits for a human, or it reported blocked. */
export const stopReason = (run: Run): { code: 2 | 3; reason: string } | null => {
  const pending = run.approvals.filter((a) => a.status === "pending")
  if (pending.length) return { code: 2, reason: `waiting for an answer: ${pending.map((a) => `${a.id} ${a.title}`).join("; ")}` }
  if (run.report?.status === "blocked") return { code: 3, reason: `reported blocked: ${run.report.summary}` }
  return null
}
