// Goal loops (docs/adr/0007-factory-goal-loops.md). A goal is one objective in one repo. Each loop is a fresh
// sub-coordinator session in the goal's one conversation (same worktree, branch and PR). After every report_up the
// coordinator updates the goal state and decides, in code: done, wait for checks, ask the human, or the next loop.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { GoalState, GoalLoop, Verdict } from "../../shared/goal.ts"
import { loadPrompt } from "./prompt.ts"

export type { GoalState, GoalLoop }

/** Loops in a row with no progress before the goal pauses and asks the human. */
export const NO_PROGRESS_LIMIT = 2

/** One file per goal under `$SF_STATE_DIR/goal-state/`, written atomically. */
export class GoalStates {
  private readonly dir: string
  constructor(root: string) {
    this.dir = path.join(root, "goal-state")
    mkdirSync(this.dir, { recursive: true })
  }
  private file(id: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new Error(`bad goal id ${id}`)
    return path.join(this.dir, `${id}.json`)
  }
  get(id: string): GoalState | null {
    const file = this.file(id)
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GoalState) : null
    } catch (e) {
      console.error(`goal state ${id} unreadable: ${e}`)
      return null
    }
  }
  set(s: GoalState): GoalState {
    const next = { ...s, updatedAt: Date.now() }
    const tmp = `${this.file(s.goalId)}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameSync(tmp, this.file(s.goalId))
    return next
  }
  list(): GoalState[] {
    return readdirSync(this.dir)
      .filter((n) => n.endsWith(".json"))
      .flatMap((n) => {
        const s = this.get(n.slice(0, -5))
        return s ? [s] : []
      })
  }
  /** The goal whose open human decision is approval `id`. */
  byApproval(id: string): GoalState | undefined {
    return this.list().find((s) => s.approvalId === id)
  }
  /** The goal whose conversation is `threadId`. */
  byThread(threadId: string): GoalState | undefined {
    return this.list().find((s) => s.threadId === threadId)
  }
}

export const newGoalState = (goalId: string, threadId: string, parentGoalId?: string): GoalState => ({
  goalId,
  threadId,
  status: "running",
  loop: 1,
  next: false,
  acs: {},
  acSource: null,
  pr: null,
  loops: [],
  noProgress: 0,
  ...(parentGoalId ? { parentGoalId } : {}),
  updatedAt: Date.now(),
})

const passed = (acs: Record<string, Verdict>) => Object.values(acs).filter((v) => v === "pass").length

/** The goal is done when every AC passes and the PR is green (or the repo has no checks). */
export const goalVerdict = (acs: Record<string, Verdict>, pr: GoalState["pr"]): "done" | "checking" | "not-done" => {
  const all = Object.keys(acs).length > 0 && passed(acs) === Object.keys(acs).length
  if (!all || !pr) return "not-done"
  if (pr.checks === "SUCCESS" || pr.checks === "NONE") return "done"
  return pr.checks === "PENDING" ? "checking" : "not-done"
}

/** Progress: more ACs pass than in any earlier loop, or the branch has a commit no earlier loop ended on. */
export const madeProgress = (earlier: GoalLoop[], loop: Pick<GoalLoop, "acPassed" | "commit">): boolean =>
  !earlier.length ||
  loop.acPassed > Math.max(...earlier.map((l) => l.acPassed)) ||
  !earlier.some((l) => l.commit === loop.commit)

export type ReportFacts = {
  at: number
  status: string
  summary: string
  gaps: string[]
  commit: string
  factoryDefect?: string
  acs: Record<string, Verdict>
  acSource: GoalState["acSource"]
  pr: GoalState["pr"]
  usd: number
}

export type Decision =
  | { kind: "done" }
  | { kind: "checking" }
  | { kind: "wait-human" }
  | { kind: "factory-defect"; defect: string }
  | { kind: "no-progress" }
  | { kind: "next-loop" }

/** Record one loop's report in the goal state and decide what comes next. Pure. */
export const afterReport = (s: GoalState, r: ReportFacts): { state: GoalState; decision: Decision } => {
  const loop: GoalLoop = {
    n: s.loop,
    at: r.at,
    status: r.status,
    summary: r.summary.slice(0, 600),
    gaps: r.gaps.slice(0, 10),
    commit: r.commit,
    acPassed: passed(r.acs),
    acTotal: Object.keys(r.acs).length,
    usd: r.usd,
    progress: false,
  }
  const earlier = s.loops.filter((l) => l.n !== s.loop)
  loop.progress = madeProgress(earlier, loop)
  const loops = [...earlier, loop]
  const base: GoalState = { ...s, acs: r.acs, acSource: r.acSource, pr: r.pr, loops, next: false, reason: undefined }
  const verdict = goalVerdict(r.acs, r.pr)
  if (verdict === "done") return { state: { ...base, status: "done" }, decision: { kind: "done" } }
  if (verdict === "checking") return { state: { ...base, status: "checking" }, decision: { kind: "checking" } }
  if (r.status === "needs-decision") return { state: base, decision: { kind: "wait-human" } }
  if (r.factoryDefect?.trim())
    return {
      state: { ...base, status: "paused", reason: "factory defect" },
      decision: { kind: "factory-defect", defect: r.factoryDefect.trim() },
    }
  const noProgress = loop.progress ? 0 : s.noProgress + 1
  if (noProgress >= NO_PROGRESS_LIMIT)
    return {
      state: { ...base, noProgress, status: "paused", reason: `no progress in ${noProgress} loops` },
      decision: { kind: "no-progress" },
    }
  return { state: { ...base, noProgress, status: "running", next: true }, decision: { kind: "next-loop" } }
}

/** Session id of a loop: loop 1 keeps the plain id; later loops get a fresh session (a fresh context). */
export const loopSessionId = (subId: string, loop: number) => `sf-${subId}${loop > 1 ? `-l${loop}` : ""}`

/** The first turn of loop n > 1: the goal and its state, so a fresh session continues the work. */
export const goalLoopPrompt = (
  s: GoalState,
  goal: { id: string; prompt: string; usd: number },
  note?: string,
): string => {
  const acs = Object.entries(s.acs)
  return loadPrompt("goal-loop", {
    goal: goal.id,
    loop: String(s.loop),
    prompt: goal.prompt,
    acs: acs.length ? acs.map(([id, v]) => `- ${id}: ${v}`).join("\n") : "- none recorded yet (sdlc_plan has not run)",
    acSource:
      s.acSource === "evaluator"
        ? "the independent evaluator"
        : s.acSource === "evidence"
          ? "the run's own evidence"
          : "nobody yet",
    pr: s.pr ? `${s.pr.url} (checks ${s.pr.checks})` : "none yet",
    history:
      s.loops
        .slice(-5)
        .map(
          (l) =>
            `- loop ${l.n}: ${l.status}, ${l.acPassed}/${l.acTotal} AC, commit ${l.commit.slice(0, 8)}, $${l.usd.toFixed(2)}: ${l.summary.replace(/\s+/g, " ").slice(0, 300)}${l.gaps.length ? ` Gaps: ${l.gaps.join("; ").slice(0, 300)}` : ""}`,
        )
        .join("\n") || "- none",
    note: note ?? "",
    usd: String(goal.usd),
  })
}

/** A child goal's id: `<parent>-fix-<n>`, the first n not taken. */
export const childGoalId = (parent: string, taken: (id: string) => boolean): string => {
  const stem = parent.slice(0, 56)
  for (let n = 1; ; n++) if (!taken(`${stem}-fix-${n}`)) return `${stem}-fix-${n}`
}

export const childGoalPrompt = (parent: { id: string; repo: string }, defect: string, threadId: string): string =>
  loadPrompt("goal-child", { parent: parent.id, repo: parent.repo, defect, thread: threadId })

/** Human decision cards of the goal loop (topic `goal`: never auto-answered). */
export const RUN_AGAIN = "Run another loop"
export const STOP_GOAL = "Stop the goal"
export const OPEN_CHILD = "Open a child goal to fix the factory"
export const LOOP_ANYWAY = "Loop again without a fix"
export const RESUME = "Resume the goal"

export const noProgressCard = (s: GoalState) => ({
  title: `No progress: goal ${s.goalId}`.slice(0, 120),
  summary: `Goal ${s.goalId} made no progress in its last ${s.noProgress} loops (no AC newly passing, no new commit). AC: ${passed(s.acs)}/${Object.keys(s.acs).length} pass.\n\nRun another loop (type direction for it, if you like), or stop the goal.`,
  options: [RUN_AGAIN, STOP_GOAL],
  optionDetails: ["Start the next loop; your typed text goes into its handoff", "Stop; nothing more is spent"],
  allowText: true,
})

export const defectCard = (s: GoalState, defect: string) => ({
  title: `Factory defect blocks goal ${s.goalId}`.slice(0, 120),
  summary: `Loop ${s.loop} of goal ${s.goalId} reports a defect in the software factory itself:\n\n> ${defect.slice(0, 1500)}\n\nOpen a child goal on the factory repo to fix it (this goal waits), loop again without a fix, or stop the goal.`,
  options: [OPEN_CHILD, LOOP_ANYWAY, STOP_GOAL],
  optionDetails: [
    "A new goal on the factory repo; when it is done, merge its PR, restart the factory, and resume this goal",
    "Start the next loop as if nothing happened",
    "Stop; nothing more is spent",
  ],
  allowText: false,
})

export const childDoneCard = (s: GoalState, child: GoalState) => ({
  title: `Child goal ${child.goalId} is done: resume ${s.goalId}?`.slice(0, 120),
  summary: `The factory fix ${child.goalId} is done${child.pr ? ` (${child.pr.url})` : ""}. Merge its PR and restart the factory (\`mise run factory:restart coordinator\`), then resume goal ${s.goalId}.`,
  options: [RESUME, STOP_GOAL],
  optionDetails: ["Start the next loop of this goal", "Stop; nothing more is spent"],
  allowText: false,
})
