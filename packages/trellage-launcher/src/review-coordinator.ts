import { randomUUID } from "node:crypto"
import { runRestrictedGuideModelRequest } from "./copilot-guide-provider.ts"
import {
  type ReviewClientFactory,
  type ReviewSynthesis,
} from "./copilot-review-provider.ts"
import type { CommandRunner } from "./guide-launch.ts"
import { optimizeDigest } from "./review-source.ts"
import type { OptimizeModelCall } from "./review-findings.ts"
import { assertGuideReviewTargetCurrent } from "./review-target.ts"
import {
  reviewExecutionPolicy,
  type ReviewArtifact,
  type ReviewCheckResult,
  type ReviewEvent,
  type ReviewFindingDecision,
  type ReviewFailure,
  type ReviewRequest,
  type ReviewRun,
} from "./review-contracts.ts"
import { captureSharedReviewEvidence } from "./review-evidence.ts"
import { SkillReviewOperation, type ReviewSkillOptions } from "./review-skills.ts"
import { SharedReviewStore } from "./review-store.ts"

export interface SharedReviewOptions {
  readonly request: ReviewRequest
  readonly confirmed: true
  readonly runner: CommandRunner
  readonly signal: AbortSignal
  readonly onEvent?: (event: ReviewEvent) => void
  readonly env?: NodeJS.ProcessEnv
  readonly modelCall?: OptimizeModelCall
  readonly clientFactory?: ReviewClientFactory
  readonly skills?: ReviewSkillOptions
  readonly save?: (run: ReviewRun) => Promise<void>
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const timedOut = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === "TimeoutError" :
    error instanceof Error && (error.name === "TimeoutError" || /operation timed out/u.test(error.message))
const classifyFailure = (
  error: unknown,
  signal: AbortSignal,
  phase: ReviewFailure["phase"],
): ReviewFailure => {
  const message = errorText(error)
  if (signal.aborted && timedOut(signal.reason)) return { kind: "overall-timeout", phase, message: errorText(signal.reason) }
  if (signal.aborted) return { kind: "user-cancelled", phase, message: errorText(signal.reason ?? error) }
  if (/restricted model request timed-out|Review (?:model|request) deadline exceeded/u.test(message))
    return { kind: "request-timeout", phase, message }
  if (/invalid JSON|validation|citation|did not (?:read|inspect)|coverage|must address every finding/u.test(message))
    return { kind: "validation-failure", phase, message }
  return { kind: "provider-failure", phase, message }
}
const synthesisSummary = (run: ReviewRun, debateIncomplete: boolean): string => {
  if (run.results.some((result) => result.status !== "complete"))
    return "Synthesis complete; review incomplete. No findings can authorize implementation."
  return debateIncomplete
    ? "Review completed with unresolved peer objections."
    : "Review completed. Read source findings and decisions before approval."
}
const artifact = (id: ReviewArtifact["checkId"], content: string, suffix = "report"): ReviewArtifact => ({
  id: `${id}:${suffix}`,
  checkId: id,
  name: `${id}-${suffix}.md`,
  content,
  digest: optimizeDigest(content),
})

const skillOptions = (options: SharedReviewOptions): ReviewSkillOptions => {
  if (options.skills) return options.skills
  const env = options.env ?? process.env
  const managerPath = env.TRELLAGE_GUIDE_SKILLS_MANAGER
  const catalogPath = env.TRELLAGE_GUIDE_SKILLS_CATALOG
  const cachePath = env.TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE
  if (!managerPath || !catalogPath || !cachePath)
    throw new Error("Review skill runtime paths are missing. Reinstall trx.")
  return { managerPath, catalogPath, cachePath, runner: options.runner }
}

const decisionsFromMaster = (run: ReviewRun, synthesis: ReviewSynthesis): ReviewFindingDecision[] =>
  run.results.flatMap((result) =>
    result.findings.map((finding) => {
      const decision = synthesis.decisions.find((entry) => entry.source === finding.id)
      if (!decision) throw new Error(`Synthesis omitted source finding ${finding.id}.`)
      const unresolved = synthesis.challengeDecisions?.some(
        (entry) =>
          entry.disposition === "unresolved" &&
          [finding.id, finding.checkId, `${finding.checkId}:standards`].some(
            (source) => entry.source === source || entry.opposingSource === source,
          ),
      )
      const group = synthesis.findings.find((entry) => entry.sources.includes(finding.id))
      const primary = group?.sources.find((id) =>
        run.results.some((checkResult) =>
          checkResult.findings.some((source) => source.id === id && source.grounded && source.proposal),
        ),
      )
      const duplicateOf = decision.disposition === "combined" && primary && primary !== finding.id ? primary : undefined
      return {
        findingId: finding.id,
        disposition:
          unresolved || !finding.grounded || !finding.proposal
            ? ("unresolved" as const)
            : decision.disposition === "rejected" || duplicateOf
              ? ("rejected" as const)
              : ("recommended" as const),
        reason: decision.reason,
        ...(duplicateOf ? { duplicateOf } : {}),
      }
    }),
  )

class SharedReviewExecution {
  private run: ReviewRun
  private writes: Promise<void> = Promise.resolve()
  private calls = 0
  private skills: SkillReviewOperation | undefined
  private phase: ReviewFailure["phase"] = "evidence-capture"

  constructor(
    private readonly options: SharedReviewOptions,
    initial: ReviewRun,
    private readonly save: (run: ReviewRun) => Promise<void>,
  ) {
    this.run = initial
  }

  private emit(event: ReviewEvent): void {
    this.options.onEvent?.(event)
  }

  private persist(update: Partial<ReviewRun> = {}): Promise<void> {
    this.run = { ...this.run, ...update, calls: this.calls }
    const current = this.run
    this.writes = this.writes.then(() => this.save(current))
    return this.writes
  }

  private call: OptimizeModelCall = async (request) => {
    this.countCall()
    await this.persist()
    return (this.options.modelCall ?? runRestrictedGuideModelRequest)(request)
  }

  private countCall(): void {
    if (this.calls >= this.run.policy.maximumCalls) throw new Error("The consented review request budget is exhausted.")
    this.calls += 1
  }

  private async synthesize(): Promise<void> {
    await this.persist({ synthesisStatus: "running" })
    this.emit({ kind: "synthesis", status: "running" })
    if (!this.skills) throw new Error("Review has no selected checks.")
    const { markdown, result, debateIncomplete } = await this.skills.synthesize([])
    const saved = artifact("synthesis", markdown, "synthesis")
    await this.persist({
      decisions: decisionsFromMaster(this.run, result),
      artifacts: [...this.run.artifacts, saved],
      summary: synthesisSummary(this.run, debateIncomplete),
    })
    await this.persist({ synthesisStatus: "complete" })
    this.emit({ kind: "synthesis", status: "complete" })
  }

  private async runPhases(): Promise<void> {
    this.phase = "independent-reviews"
    const settled = await Promise.allSettled(
      this.skills?.assignments.map((assignment) => this.skills!.review(assignment)) ?? [],
    )
    const failed = settled.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    this.phase = "final-synthesis"
    await this.synthesize()
  }

  private async recordFailure(error: unknown): Promise<ReviewFailure> {
    const diagnostic = classifyFailure(error, this.options.signal, this.phase)
    if (this.run.synthesisStatus === "running") {
      await this.persist({ synthesisStatus: "failed" })
      this.emit({ kind: "synthesis", status: "failed" })
    } else if (this.run.synthesisStatus === "queued") {
      await this.persist({ synthesisStatus: "not-run" })
      this.emit({ kind: "synthesis", status: "not-run" })
    }
    return diagnostic
  }

  private completed(failure: unknown): boolean {
    return !failure &&
      this.run.results.length === this.run.request.checks.length &&
      this.run.results.every((result) => result.status === "complete")
  }

  async execute(): Promise<ReviewRun> {
    let failure: unknown
    let diagnostic: ReviewFailure | undefined
    try {
      if (this.run.request.checks.length) {
        this.skills = new SkillReviewOperation({
          run: this.run, skills: skillOptions(this.options), signal: this.options.signal,
          ...(this.options.clientFactory ? { clientFactory: this.options.clientFactory } : {}),
          call: this.call, onCall: () => this.countCall(),
          onEvent: (event) => this.emit(event),
          retain: (artifacts, result) => this.retainSkillResults(artifacts, result),
          externalReplies: new Map(),
          onCleanup: () => { this.phase = "cleanup" },
        })
        await this.skills.execute(() => this.runPhases())
      } else await this.runPhases()
    } catch (error) {
      failure = error
      diagnostic = await this.recordFailure(error)
    }
    const complete = this.completed(failure)
    await this.persist({
      status: diagnostic?.kind === "user-cancelled" ? "cancelled" : complete ? "complete" : "incomplete",
      error: failure ? errorText(failure) : complete ? null : "One or more checks have incomplete coverage.",
      ...(diagnostic ? { failure: diagnostic } : {}),
      ...(failure ? { summary: "Review stopped before completion. No findings can authorize implementation." } : {}),
    })
    return this.run
  }

  private async retainSkillResults(artifacts: ReadonlyArray<ReviewArtifact>, result?: ReviewCheckResult): Promise<void> {
    const merged = new Map(this.run.artifacts.map((entry) => [entry.id, entry]))
    for (const entry of artifacts) {
      merged.set(entry.id, entry)
      this.emit({ kind: "artifact", artifact: entry })
    }
    await this.persist({
      artifacts: [...merged.values()],
      ...(result ? { results: [...this.run.results.filter((entry) => entry.id !== result.id), result] } : {}),
    })
  }
}

export const runSharedReview = async (options: SharedReviewOptions): Promise<ReviewRun> => {
  if (options.confirmed !== true) throw new Error("Review requires explicit model-sharing consent.")
  options.signal.throwIfAborted()
  const evidence = await captureSharedReviewEvidence(options.runner, options.request, options.signal)
  await assertGuideReviewTargetCurrent(options.runner, options.request.target, options.signal)
  const initial: ReviewRun = {
    schemaVersion: 2,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    request: options.request,
    evidence,
    policy: reviewExecutionPolicy(options.request.checks.map((check) => check.id), evidence.source),
    status: "running",
    synthesisStatus: "queued",
    results: [],
    artifacts: [],
    challenges: [],
    decisions: [],
    summary: "Review in progress. No implementation is approved.",
    error: null,
    calls: 0,
    approvedIds: [],
    execution: "not-started",
  }
  const store = new SharedReviewStore(options.request.target.gitDirectory)
  const save = options.save ?? ((run) => store.save(run))
  await save(initial)
  return new SharedReviewExecution(options, initial, save).execute()
}
