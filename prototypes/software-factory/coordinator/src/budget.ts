// Cost limit of a goal (shared/goal.ts `limits.usd`): the spend of every run of the goal together. There is no time
// limit: a goal may run for days. When the goal's spend reaches its limit, the factory pauses its running runs (stops
// their agents, as a restart would) and asks the human: stop, or go on to a new limit they pick. Going on resumes each
// paused run with a handoff turn (resume.ts). A stopped goal starts no new run until the human raises its limit.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

type Agent = { id: string; name: string; owner: string | null; step: string | null; task: string | null }

export type Budget = {
  limitUsd: number
  status: "ok" | "paused" | "stopped"
  /** The open approval of the current pause. */
  approvalId?: string
  pausedAt?: number
  /** The runs the pause stopped, with their stopped agents, for the handoff turns. */
  paused?: { threadId: string; lost: Agent[] }[]
}

/** What the human changed per goal (`$SF_STATE_DIR/goal-budgets.json`): a raised limit, a pause or a stop. */
export class GoalBudgets {
  private doc: Record<string, Budget> = {}
  private readonly file: string
  constructor(root: string) {
    this.file = path.join(root, "goal-budgets.json")
    try {
      if (existsSync(this.file)) this.doc = JSON.parse(readFileSync(this.file, "utf8"))
    } catch (e) {
      console.error(`goal budgets unreadable, starting empty: ${e}`)
    }
  }
  /** The goal's budget: its spec limit, or the human's raised limit when that is higher. */
  get(goalId: string, specUsd: number): Budget {
    const b = this.doc[goalId]
    return b ? { ...b, limitUsd: Math.max(b.limitUsd, specUsd) } : { limitUsd: specUsd, status: "ok" }
  }
  set(goalId: string, b: Budget): void {
    this.doc[goalId] = b
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2))
    renameSync(tmp, this.file)
  }
  /** The goal whose open pause is approval `id`. */
  byApproval(id: string): string | undefined {
    return Object.entries(this.doc).find(([, b]) => b.approvalId === id)?.[0]
  }
}

/** The error the stopped agents end with; gates that fail with it run again when the run goes on. */
export const PAUSE_REASON = "paused at cost limit"

export const STOP = "Stop the goal"

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`

/** Pause only a goal with a run that still works, when the goal has reached its limit. */
export const shouldPause = (b: Budget, spentUsd: number, busy: boolean): boolean =>
  b.status === "ok" && busy && spentUsd >= b.limitUsd

/** A round amount at or above `x`: whole $50 from $100, whole dollars from $1, else cents. */
const niceUp = (x: number) => (x >= 100 ? Math.ceil(x / 50) * 50 : x >= 1 ? Math.ceil(x) : Math.ceil(x * 100) / 100)

/**
 * Next limits to offer, each at least 10% above the spend: the limit plus $250 (limits from $100), twice and four
 * times the limit; when that gives fewer than two, twice and four times the spend. At most three.
 */
export const nextLimits = (limitUsd: number, spentUsd: number): number[] => {
  const floor = niceUp(spentUsd * 1.1)
  const pick = (xs: number[]) => [...new Set(xs.map((n) => Math.max(niceUp(n), floor)))].sort((a, b) => a - b)
  const fromLimit = pick([...(limitUsd >= 100 ? [limitUsd + 250] : []), limitUsd * 2, limitUsd * 4])
  return (fromLimit.length >= 2 ? fromLimit : pick([...fromLimit, spentUsd * 2, spentUsd * 4])).slice(0, 3)
}

export const raiseOption = (n: number) => `Continue to ${usd(n)}`

/** The decision card of a pause. The human may also type an amount, e.g. "600" or "$600". */
export const pauseApproval = (goalId: string, b: Budget, spentUsd: number, runs: number) => {
  const limits = nextLimits(b.limitUsd, spentUsd)
  return {
    title: `Cost limit reached: goal ${goalId}`.slice(0, 120),
    summary: `Goal ${goalId} has spent about ${usd(Math.round(spentUsd * 100) / 100)} over ${runs} run${runs === 1 ? "" : "s"} (limit ${usd(b.limitUsd)} for the whole goal). Its running agents are paused.\n\nPick a new limit for the goal to go on (or type an amount in dollars), or stop the goal. Going on resumes the paused run where it stopped.`,
    options: [...limits.map(raiseOption), STOP],
    optionDetails: [
      ...limits.map((n) => `Resume; pause again when the goal reaches ${usd(n)}`),
      "Keep it stopped; no new run starts until you raise the limit",
    ],
    allowText: true,
  }
}

/** The human's answer as an action. A typed amount must be above the spend; anything else is not understood. */
export const readAnswer = (
  answer: string,
  spentUsd: number,
): { kind: "stop" } | { kind: "raise"; limitUsd: number } | { kind: "invalid"; why: string } => {
  if (answer === STOP || /^\s*stop\b/i.test(answer)) return { kind: "stop" }
  const m = answer.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)/)
  const n = m ? Number(m[1]) : NaN
  if (!(n > 0)) return { kind: "invalid", why: `no dollar amount in "${answer}"` }
  if (n <= spentUsd)
    return { kind: "invalid", why: `${usd(n)} is not above the ${usd(Math.round(spentUsd))} already spent` }
  return { kind: "raise", limitUsd: n }
}
