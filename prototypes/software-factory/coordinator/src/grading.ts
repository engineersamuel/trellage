import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  buildGrade,
  DEFAULT_IMPROVE,
  goalUnmet,
  nextImprovementAction,
  parseBenchmarks,
  parseQuality,
  proposeImprovement,
  type GoalSpec,
  type Grade,
  type GradeInputs,
  type ImprovePolicy,
  type ImprovementProposal,
  type Run,
} from "../../shared/goal.ts"
import type { Approval, Approvals } from "./approvals.ts"
import { checkoutCommit, type Goals } from "./goals.ts"
import type { Report } from "./report.ts"
import { artifact, criteriaResults } from "./sdlc.ts"
import type { Thread, Threads } from "./threads.ts"

export type GradingDependencies = {
  threads: Pick<Threads, "get" | "list" | "messages" | "addGrade" | "setMeta">
  goals: Pick<Goals, "get" | "runs" | "appendGrade">
  approvals: Pick<Approvals, "open" | "get">
  runRecord: (threadId: string) => Promise<Run | null>
  openConversation: (
    folder: string,
    task: string,
    meta: Pick<Thread, "improvementOf">,
  ) => Promise<{ info: { threadId: string }; sent: { sent: Promise<unknown> } }>
  criteria: (threadId: string) => string[]
  deskThreadId: () => string
  factoryDir: string
  publish: (type: string, data: object) => void
  env?: { SF_GRADING?: string }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const proposalsOf = (t: Thread): ImprovementProposal[] => t.improvements ?? (t.improvement ? [t.improvement] : [])

const orNull = async <A>(what: string, errors: string[], read: () => A | Promise<A>): Promise<A | null> => {
  try {
    return await read()
  } catch (e) {
    const message = `${what}: ${errorMessage(e)}`
    errors.push(message)
    console.error(`grading: ${message}`)
    return null
  }
}

const readArtifact = (t: Thread, name: string, input: GradeInputs): string | null => {
  if (!t.worktree) return null
  const file = artifact(t.worktree, name)
  try {
    const text = readFileSync(file, "utf8")
    input.evidence = [...input.evidence, { kind: "file", ref: file, sha256: sha256(text) }]
    return text
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null
    const message = `${name} unreadable: ${errorMessage(e)}`
    if (name === "quality.json") input.evidence = [...input.evidence, { kind: "note", ref: message }]
    else input.errors.push(message)
    return null
  }
}

const improvementTask = (t: Thread, p: ImprovementProposal): string =>
  `Improve the Software Factory (prototypes/software-factory) so conversation ${t.id} ("${t.title}") would pass its grade \`${p.sourceKey}\`. Read GET /api/runs/${t.id} for the grade, its evidence and errors. Find the Factory cause, fix it with tests, and open a PR. A human merges.`

class Grading {
  readonly enabled: boolean
  private readonly launching = new Set<string>()

  constructor(private readonly d: GradingDependencies) {
    this.enabled = (d.env ?? process.env).SF_GRADING !== "off"
  }

  gradesOf(t: Thread): Grade[] {
    const grades = new Map(this.goalGrades(t).map((g) => [g.key, g]))
    for (const g of t.grades ?? []) grades.set(g.key, g)
    return [...grades.values()]
  }

  private goalGrades(t: Thread): Grade[] {
    if (!t.goalId) return []
    try {
      return this.d.goals.runs(t.goalId).flatMap((r) => (r.grade && r.threadId === t.id ? [r.grade] : []))
    } catch (e) {
      console.error(`grading: goal log ${t.goalId}: ${errorMessage(e)}`)
      return []
    }
  }

  private gradeBase(t: Thread, r: Report): GradeInputs {
    return {
      at: Date.now(),
      factoryCommit: checkoutCommit(this.d.factoryDir),
      subject: t.goalId
        ? { kind: "goal", id: t.goalId }
        : {
            kind: "prompt",
            id: sha256(this.d.threads.messages(t.id).find((m) => m.role === "user")?.content ?? t.title).slice(0, 12),
          },
      report: { status: r.status, commit: r.commit },
      criteria: {},
      benchmarks: null,
      evidence: [],
      quality: [],
      errors: [],
    }
  }

  private readEvidence(t: Thread, base: GradeInputs): GradeInputs {
    const input = { ...base, evidence: [...base.evidence], errors: [...base.errors] }
    input.criteria = criteriaResults(this.d.criteria(t.id), readArtifact(t, "evidence.md", input))
    const benchmarks = parseBenchmarks(readArtifact(t, "benchmarks.json", input))
    const quality = parseQuality(readArtifact(t, "quality.json", input))
    if ("error" in benchmarks) input.errors.push(benchmarks.error)
    if (quality.note) input.evidence.push({ kind: "note", ref: quality.note })
    input.benchmarks = "error" in benchmarks ? null : benchmarks.values
    input.quality = quality.entries
    return input
  }

  private goalOf(t: Thread): GoalSpec | null {
    if (!t.goalId) return null
    if (t.goalSpec) return t.goalSpec
    const spec = this.d.goals.get(t.goalId)
    if (!spec) throw new Error("saved goal not found")
    this.d.threads.setMeta(t.id, { goalSpec: spec })
    return spec
  }

  private async evaluate(t: Thread, r: Report): Promise<{ grade: Grade; unmet: string[] }> {
    const base = this.gradeBase(t, r)
    const spec = await orNull(`goal ${t.goalId}`, base.errors, () => this.goalOf(t))
    const run = await orNull(`run ${t.id}`, base.errors, () => this.d.runRecord(t.id))
    if (!run) base.errors.push("grader could not read the run record")
    const evidence = await orNull(`evidence ${t.id}`, base.errors, () => this.readEvidence(t, base))
    return {
      grade: buildGrade(run ?? { threadId: t.id, pr: null }, evidence ?? base, spec),
      unmet: run && spec ? goalUnmet(run, spec.expect, spec.base) : [],
    }
  }

  async gradeThread(threadId: string, r: Report): Promise<void> {
    const t = this.d.threads.get(threadId)
    if (!this.enabled || !t || (r.status !== "done" && r.status !== "blocked")) return
    const { grade, unmet } = await this.evaluate(t, r)
    try {
      this.recordGrade(this.d.threads.get(t.id) ?? t, grade, unmet)
    } catch (e) {
      console.error(`grade ${grade.key} not saved: ${errorMessage(e)}`)
    }
  }

  private openProposal(t: Thread, g: Grade): string {
    const item = this.d.approvals.open({
      threadId: this.d.deskThreadId(),
      title: `Improve the Factory after a failed grade of "${t.title}"`.slice(0, 120),
      summary: `Grade \`${g.key}\` failed: criteria ${g.criteria.passed}/${g.criteria.evaluated} passed, PR checks ${g.prChecks.state}, ${g.benchmarks.filter((b) => b.regressed).length} benchmark regressions.\n\nOnly a human may answer. Launching starts one Factory improvement conversation in the factory checkout; it never merges.`,
      options: ["Launch improvement run", "Reject"],
      optionDetails: ["Start one improvement conversation for the Factory", "Do nothing"],
      context: "factory grader · human only",
    })
    this.d.publish("factory.approval_requested", item)
    return item.id
  }

  private recordGrade(t: Thread, g: Grade, unmet: string[]): void {
    if (this.gradesOf(t).some((x) => x.key === g.key)) return
    const previous = proposalsOf(t).find((p) => p.sourceKey === g.key)
    const draft = proposeImprovement(g, "", !!t.improvementOf)
    const proposal = previous ?? (draft && { ...draft, approvalId: this.openProposal(t, g) })
    const graded = proposal ? { ...g, proposalId: proposal.approvalId } : g
    if (proposal) this.setProposal(t, proposal)
    this.d.threads.addGrade(t.id, graded)
    this.appendGoalGrade(t, graded, unmet)
    this.d.publish("factory.graded", { threadId: t.id, key: g.key, status: g.status })
    this.d.publish("factory.thread_updated", { threadId: t.id })
  }

  private appendGoalGrade(t: Thread, g: Grade, unmet: string[]): void {
    if (!t.goalId) return
    try {
      this.d.goals.appendGrade(t.goalId, {
        at: g.at,
        factoryCommit: g.factoryCommit,
        threadId: t.id,
        outcome: g.status,
        unmet,
        prUrl: g.prChecks.url,
        grade: g,
      })
    } catch (e) {
      console.error(`grade ${g.key} saved on thread but not goal log: ${errorMessage(e)}`)
    }
  }

  private setProposal(t: Thread, p: ImprovementProposal): void {
    const current = this.d.threads.get(t.id) ?? t
    const all = proposalsOf(current)
    const exists = all.some((x) => x.sourceKey === p.sourceKey)
    this.d.threads.setMeta(t.id, {
      improvements: exists ? all.map((x) => (x.sourceKey === p.sourceKey ? p : x)) : [...all, p],
      ...(!exists || current.improvement?.sourceKey === p.sourceKey ? { improvement: p } : {}),
    })
    this.d.publish("factory.thread_updated", { threadId: t.id })
  }

  private async launchImprovement(t: Thread, p: ImprovementProposal): Promise<void> {
    const attempt: ImprovementProposal = {
      ...p,
      status: "approved",
      approvedBy: "human",
      attempts: p.attempts + 1,
    }
    this.setProposal(t, attempt)
    this.launching.add(p.approvalId)
    try {
      const { info, sent } = await this.d.openConversation(this.d.factoryDir, improvementTask(t, p), {
        improvementOf: t.id,
      })
      await sent.sent
      this.setProposal(t, {
        ...attempt,
        status: "launched",
        launchedThreadId: info.threadId,
        lastError: null,
      })
    } catch (e) {
      this.setProposal(t, { ...attempt, status: "launch-failed", lastError: errorMessage(e) })
    } finally {
      this.launching.delete(p.approvalId)
    }
  }

  private improvePolicy(t: Thread, p: ImprovementProposal): ImprovePolicy | null {
    try {
      return this.goalOf(t)?.improve ?? DEFAULT_IMPROVE
    } catch (e) {
      const lastError = `improvement policy: ${errorMessage(e)}`
      console.error(lastError)
      this.setProposal(t, { ...p, lastError })
      return null
    }
  }

  async advanceImprovement(t: Thread, a: Approval | undefined): Promise<void> {
    if (!this.enabled) return
    const current = this.d.threads.get(t.id) ?? t
    const p = a ? proposalsOf(current).find((x) => x.approvalId === a.id) : current.improvement
    if (!p || p.status === "approved") return
    const policy = this.improvePolicy(current, p)
    if (policy) await this.applyAnswer(current, p, policy, a)
  }

  private async applyAnswer(
    t: Thread,
    p: ImprovementProposal,
    policy: ImprovePolicy,
    a: Approval | undefined,
  ): Promise<void> {
    const next = nextImprovementAction(p, policy, a, !!t.improvementOf)
    if (next.kind === "launch") await this.launchImprovement(t, p)
    else if (next.kind === "refuse" && p.status !== "launched")
      this.setProposal(t, {
        ...p,
        status: p.attempts >= 1 + policy.maxRetries ? "exhausted" : "rejected",
        lastError: next.reason,
      })
  }

  improvementAnswered(a: Approval): boolean {
    const t = this.d.threads.list().find((x) => proposalsOf(x).some((p) => p.approvalId === a.id))
    if (t) void this.advanceImprovement(t, a).catch((e) => console.error(`improvement: ${errorMessage(e)}`))
    return !!t
  }

  /** An 'approved' proposal nobody is launching was interrupted by a restart; it re-enters the bounded retry path. */
  private recoverStale(t: Thread, p: ImprovementProposal): ImprovementProposal {
    if (p.status !== "approved" || p.launchedThreadId || this.launching.has(p.approvalId)) return p
    const failed: ImprovementProposal = { ...p, status: "launch-failed", lastError: "launch interrupted" }
    this.setProposal(t, failed)
    return failed
  }

  /** CI is usually PENDING when a run reports; re-grade such threads so the settled check state is recorded. */
  async regradePending(): Promise<void> {
    if (!this.enabled) return
    for (const t of this.d.threads.list()) {
      const latest = this.gradesOf(t).reduce<Grade | null>((a, g) => (!a || g.at >= a.at ? g : a), null)
      if (latest?.status === "unknown" && latest.prChecks.state === "PENDING")
        await this.gradeThread(t.id, latest.report)
    }
  }

  async retryImprovements(): Promise<void> {
    if (!this.enabled) return
    for (const t of this.d.threads.list())
      for (const p of proposalsOf(t))
        if (this.recoverStale(t, p).status === "launch-failed")
          await this.advanceImprovement(t, this.d.approvals.get(p.approvalId))
  }
}

export const makeGrading = (d: GradingDependencies) => {
  const grading = new Grading(d)
  return {
    enabled: grading.enabled,
    gradesOf: grading.gradesOf.bind(grading),
    gradeThread: grading.gradeThread.bind(grading),
    advanceImprovement: grading.advanceImprovement.bind(grading),
    improvementAnswered: grading.improvementAnswered.bind(grading),
    retryImprovements: grading.retryImprovements.bind(grading),
    regradePending: grading.regradePending.bind(grading),
  }
}
