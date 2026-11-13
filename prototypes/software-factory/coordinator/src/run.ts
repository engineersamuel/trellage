// Delivery record of a repo conversation: which agents ran (step, skills), decisions, security reviews and
// the branch's PR. Scoring against a goal spec lives in shared/goal.ts.
import { execFile } from "node:child_process"
import type { ChecksState, RunPr, RunWorker } from "../../shared/goal.ts"
import type { SubagentInfo } from "./factory.ts"
import { trackSubagent } from "./subagents.ts"

export { goalUnmet, stopReason, type Run, type RunPr, type RunWorker } from "../../shared/goal.ts"

/** Agents the factory started that are no longer live, from their `factory.worker_started` events, as stopped summaries.
 *  Coordinators are left out: their conversation (thread) already stands for them. The first start gives the spawn time. */
export const pastWorkers = <W extends { id: string; role: string; startedAt?: number }>(
  rows: { ts: number; data: W }[],
  isLive: (id: string) => boolean,
): (W & { status: "stopped"; startedAt: number })[] => {
  const byId = new Map<string, W & { status: "stopped"; startedAt: number }>()
  for (const { ts, data } of rows) {
    if (data.role === "coordinator" || isLive(data.id)) continue
    byId.set(data.id, { ...data, status: "stopped", startedAt: byId.get(data.id)?.startedAt ?? data.startedAt ?? ts })
  }
  return [...byId.values()]
}

type SubagentEvent = { worker: string; type: string; agent: string | null; data: Record<string, unknown> }

/** Stopped agents' subagent lists, rebuilt from their stored events (the start event has none yet). */
export const withSubagents = <W extends { id: string; harness?: string }>(
  past: W[],
  events: SubagentEvent[],
): (W & { subagents: SubagentInfo[] })[] => {
  const lists = new Map<string, SubagentInfo[]>()
  const harness = new Map(past.map((w) => [w.id, w.harness ?? "copilot"]))
  for (const e of events) {
    const h = harness.get(e.worker)
    if (!h) continue
    const next = trackSubagent(lists.get(e.worker) ?? [], e.type, e.agent, e.data, h)
    if (next) lists.set(e.worker, next)
  }
  // A subagent still "running" in a stopped agent ended with it.
  return past.map((w) => ({
    ...w,
    subagents: (lists.get(w.id) ?? []).map((x) => (x.status === "running" ? { ...x, status: "failed" as const } : x)),
  }))
}

type Started = { id: string; name: string; step?: string | null; harness?: string; owner: string }

/** Every agent started under `root` (directly or through an agent it started), newest summary per id. Skills are filled in by the caller. */
export const runWorkers = (
  started: Started[],
  root: string,
  liveStatus: (id: string) => string | undefined,
): RunWorker[] => {
  const byId = new Map(started.map((w) => [w.id, w]))
  const owners = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const w of byId.values())
      if (owners.has(w.owner) && !owners.has(w.id)) {
        owners.add(w.id)
        grew = true
      }
  }
  return [...byId.values()]
    .filter((w) => w.id !== root && owners.has(w.owner))
    .map((w) => ({
      id: w.id,
      name: w.name,
      step: w.step ?? null,
      skills: [],
      harness: w.harness ?? "copilot",
      owner: w.owner,
      status: liveStatus(w.id) ?? "stopped",
    }))
}

type Check = { status?: string; conclusion?: string; state?: string }

/** gh's statusCheckRollup as one state: any failure fails, any unfinished check is pending. */
export const checksState = (rollup: Check[]): ChecksState => {
  if (!rollup.length) return "NONE"
  const results = rollup.map((c) =>
    (c.state ?? (c.status === "COMPLETED" ? c.conclusion : "PENDING") ?? "PENDING").toUpperCase(),
  )
  if (
    results.some((r) =>
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(r),
    )
  )
    return "FAILURE"
  return results.every((r) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(r)) ? "SUCCESS" : "PENDING"
}

type GhPr = {
  number: number
  url: string
  state: string
  headRefOid: string
  baseRefName: string
  body: string
  files: { path: string }[] | null
  statusCheckRollup: Check[] | null
}

/** gh's PR list output as the newest PR, null when there is none; an error for output that is not that list. */
export const parsePrList = (out: string): { pr: RunPr | null } | { error: string } => {
  let list: unknown
  try {
    list = JSON.parse(out)
  } catch (e) {
    return { error: `gh returned invalid JSON: ${e instanceof Error ? e.message : e}` }
  }
  if (!Array.isArray(list)) return { error: "gh returned no PR list" }
  const pr = list[0] as GhPr | undefined
  return {
    pr: pr
      ? {
          number: pr.number,
          url: pr.url,
          state: pr.state,
          head: pr.headRefOid,
          base: pr.baseRefName,
          body: pr.body ?? "",
          files: (pr.files ?? []).map((f) => f.path),
          checks: checksState(pr.statusCheckRollup ?? []),
        }
      : null,
  }
}

/** The newest PR of `branch`, from the GitHub CLI in `repo`. `{pr: null}` when there is none; `{error}` when gh fails. */
export const branchPr = (repo: string, branch: string): Promise<{ pr: RunPr | null } | { error: string }> =>
  new Promise((resolve) =>
    execFile(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "number,url,state,headRefOid,baseRefName,body,files,statusCheckRollup",
      ],
      { cwd: repo, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => resolve(err ? { error: `gh pr list failed: ${err.message.split("\n")[0]}` } : parsePrList(out)),
    ),
  )
