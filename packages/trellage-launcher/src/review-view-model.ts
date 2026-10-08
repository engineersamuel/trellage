import { optimizeDigest, captureOptimizeEvidence } from "./guide-optimize-evidence.ts"
import {
  builtinReport,
  optimizeApproval,
  optimizeReviewDocument,
  parseOptimizeReport,
  parseOptimizeVerdict,
  type OptimizeApproval,
  type OptimizeReview,
  type OptimizeReviewer,
} from "./guide-optimize-review.ts"
import { OptimizeReviewStore } from "./guide-optimize-store.ts"
import { reviewCheckCatalog, selectReviewChecks, type ReviewCheckAssignment } from "./review-catalog.ts"
import { reviewExecutionPolicy, type ReviewRun } from "./review-contracts.ts"
import { SharedReviewStore, type SharedReviewApproval } from "./review-store.ts"
import { captureSharedReviewEvidence } from "./review-evidence.ts"
import type { CommandRunner } from "./guide-launch.ts"

export const displayReviewers = (assignments: ReadonlyArray<ReviewCheckAssignment>): ReadonlyArray<OptimizeReviewer> =>
  assignments.map((assignment) => {
    const check = reviewCheckCatalog.find((entry) => entry.id === assignment.id)!
    return { id: check.id, title: check.label, description: check.purpose, prompt: "", model: assignment.model }
  })

export const legacyReviewRun = (review: OptimizeReview): ReviewRun => {
  const checks = review.reviewers.map((reviewer): ReviewCheckAssignment => ({
    id: selectReviewChecks([reviewer.id])[0]!.id,
    model: reviewer.model,
    workers: [],
  }))
  const reports = review.reports.map(builtinReport)
  const content = optimizeReviewDocument(review)
  const evidence = { source: review.evidence }
  return {
    schemaVersion: 2,
    id: review.id,
    createdAt: review.createdAt,
    request: {
      target: review.input.target,
      paths: review.input.paths,
      checks,
      coordinator: review.coordinator,
      ...(review.input.originalIntent === undefined ? {} : { originalIntent: review.input.originalIntent }),
      ...(review.input.intent === undefined ? {} : { intent: review.input.intent }),
    },
    evidence: { ...evidence, fingerprint: optimizeDigest(evidence) },
    policy: reviewExecutionPolicy(
      checks.map((check) => check.id),
      review.evidence,
    ),
    status: review.status,
    results: reports.map((entry) => entry.result),
    artifacts: [
      ...reports.map((entry) => entry.artifact),
      {
        id: "synthesis:legacy-document",
        checkId: "synthesis",
        name: "legacy-review.md",
        content,
        digest: optimizeDigest(content),
      },
    ],
    challenges: review.challenges,
    decisions: review.decisions.map(({ findingId, disposition, reason }) => ({ findingId, disposition, reason })),
    summary: review.summary,
    error: review.error,
    calls: review.calls,
    approvedIds: review.approvedIds,
    execution: review.execution,
  }
}

export const legacyReviewState = (initial: OptimizeReview, run: ReviewRun): OptimizeReview => {
  const reports = run.results.map((result) => {
    const artifact = run.artifacts.find((entry) => entry.id === result.reportId)
    if (!artifact) throw new Error("Legacy review report is missing.")
    return parseOptimizeReport(JSON.parse(artifact.content), result.id, initial.input, initial.evidence)
  })
  const verdict = run.artifacts.find((entry) => entry.id === "synthesis:builtin-verdict")
  return {
    ...initial,
    reports,
    challenges: run.challenges,
    status: run.status,
    error: run.error,
    calls: run.calls,
    summary: run.summary,
    ...(verdict ? parseOptimizeVerdict(JSON.parse(verdict.content), { evidence: initial.evidence, reports }) : {}),
    approvedIds: run.approvedIds,
    execution: run.execution,
  }
}

export const legacyReviewApproval = (review: OptimizeReview, approval: OptimizeApproval): SharedReviewApproval => {
  const findings = legacyReviewRun(review).results.flatMap((result) => result.findings)
  return {
    reviewId: approval.reviewId,
    reviewDigest: approval.reviewDigest,
    findings: approval.findings.map((finding) => {
      const saved = findings.find((entry) => entry.id === finding.id)
      if (!saved) throw new Error("Legacy approval has no saved finding.")
      return saved
    }),
  }
}

export class LegacyReviewAdapter {
  readonly namespace = "legacy"
  private readonly store: OptimizeReviewStore
  constructor(gitDirectory: string) {
    this.store = new OptimizeReviewStore(gitDirectory)
  }
  async read(id: string): Promise<ReviewRun> {
    return legacyReviewRun(await this.store.read(id))
  }
  async approve(id: string, ids: ReadonlyArray<string>): Promise<SharedReviewApproval> {
    const approval = await this.store.approve(id, ids)
    return legacyReviewApproval(await this.store.read(id), approval)
  }
  private async checked(approval: SharedReviewApproval): Promise<OptimizeApproval> {
    const review = await this.store.read(approval.reviewId)
    const original = optimizeApproval(review, review.approvedIds)
    if (optimizeDigest(legacyReviewApproval(review, original)) !== optimizeDigest(approval))
      throw new Error("Approval differs from saved findings.")
    return original
  }
  async approved(approval: SharedReviewApproval): Promise<ReviewRun> {
    return legacyReviewRun(await this.store.approved(await this.checked(approval)))
  }
  async beginExecution(approval: SharedReviewApproval): Promise<void> {
    await this.store.beginExecution(await this.checked(approval))
  }
  finishExecution(id: string, execution: "launched" | "unknown"): Promise<void> {
    return this.store.finishExecution(id, execution)
  }
}

export type ReviewAuthority = SharedReviewStore | LegacyReviewAdapter
export type ReviewNamespace = ReviewAuthority["namespace"]

export const reviewAuthority = async (gitDirectory: string, id: string): Promise<ReviewAuthority> => {
  const shared = new SharedReviewStore(gitDirectory)
  const legacy = new OptimizeReviewStore(gitDirectory)
  const [hasShared, hasLegacy] = await Promise.all([shared.hasRecord(id), legacy.hasRecord(id)])
  if (hasShared && hasLegacy) throw new Error("Review ID is ambiguous across record namespaces.")
  if (hasShared) return shared
  if (hasLegacy) return new LegacyReviewAdapter(gitDirectory)
  throw new Error("Saved review is missing.")
}

export const assertReviewEvidenceCurrent = async (
  store: ReviewAuthority,
  approval: SharedReviewApproval,
  runner: CommandRunner,
  signal: AbortSignal,
): Promise<void> => {
  const run = await store.approved(approval)
  const expected = optimizeDigest({
    sources: run.evidence.source.sources.filter((entry) => !entry.id.startsWith("@skill/")),
    excluded: run.evidence.source.excluded,
  })
  if (store.namespace === "legacy") {
    const current = await captureOptimizeEvidence(runner, run.request.target, run.request.paths, signal)
    if (current.fingerprint !== expected)
      throw new Error("Review context changed. Run a new review before implementation.")
  } else {
    const current = await captureSharedReviewEvidence(runner, run.request, signal)
    if (
      current.source.fingerprint !== expected ||
      optimizeDigest(current.patch ?? null) !== optimizeDigest(run.evidence.patch ?? null)
    )
      throw new Error("Review context changed. Run a new review before implementation.")
  }
}
