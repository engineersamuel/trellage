import type { GuideModelConfig } from "./guide-model-routing.ts"
import type { OptimizeCitation, OptimizeChallenge } from "./guide-optimize-review.ts"
import type { OptimizeEvidence } from "./guide-optimize-evidence.ts"
import type { GuideOptimizeTarget } from "./guide-optimize-target.ts"
import { selectReviewChecks, type ReviewCheckAssignment, type ReviewCheckId } from "./review-catalog.ts"
import type { ReviewSnapshot } from "./review-run.ts"

export interface ReviewRequest {
  readonly target: GuideOptimizeTarget
  readonly paths: ReadonlyArray<string>
  readonly checks: ReadonlyArray<ReviewCheckAssignment>
  readonly coordinator: GuideModelConfig
  readonly originalIntent?: string
  readonly intent?: string
}

export interface ReviewEvidence {
  readonly fingerprint: string
  readonly source: OptimizeEvidence
  readonly patch?: ReviewSnapshot
}

export interface ReviewFinding {
  readonly id: string
  readonly checkId: ReviewCheckId
  readonly reportId: string
  readonly sourceId: string
  readonly sourceExcerpt?: string
  readonly title: string
  readonly proposal?: string
  readonly benefit?: string
  readonly risk?: string
  readonly verification?: string
  readonly severity?: "critical" | "high" | "medium" | "low"
  readonly paths: ReadonlyArray<string>
  readonly citations: ReadonlyArray<OptimizeCitation>
  readonly grounded: boolean
  readonly limitation?: string
  readonly code?: {
    readonly current: string
    readonly suggested: string
    readonly kind: "exact" | "illustrative"
  }
}

export interface ReviewArtifact {
  readonly id: string
  readonly checkId: ReviewCheckId | "synthesis"
  readonly name: string
  readonly content: string
  readonly digest: string
}

export interface ReviewCheckResult {
  readonly id: ReviewCheckId
  readonly status: "complete" | "partial" | "failed"
  readonly reportId: string
  readonly findings: ReadonlyArray<ReviewFinding>
  readonly limitations: ReadonlyArray<string>
  readonly error?: string
}

export interface ReviewFindingDecision {
  readonly findingId: string
  readonly disposition: "recommended" | "rejected" | "unresolved"
  readonly reason: string
  readonly duplicateOf?: string
}

export interface ReviewRun {
  readonly schemaVersion: 2
  readonly policy: ReviewExecutionPolicy
  readonly id: string
  readonly createdAt: string
  readonly request: ReviewRequest
  readonly evidence: ReviewEvidence
  readonly status: "running" | "complete" | "incomplete" | "cancelled"
  readonly synthesisStatus?: "queued" | "running" | "complete" | "failed" | "not-run"
  readonly failure?: ReviewFailure
  readonly results: ReadonlyArray<ReviewCheckResult>
  readonly artifacts: ReadonlyArray<ReviewArtifact>
  readonly challenges: ReadonlyArray<OptimizeChallenge>
  readonly decisions: ReadonlyArray<ReviewFindingDecision>
  readonly summary: string
  readonly error: string | null
  readonly calls: number
  readonly approvedIds: ReadonlyArray<string>
  readonly execution: "not-started" | "launching" | "launched" | "unknown"
}

export interface ReviewFailure {
  readonly kind: "user-cancelled" | "request-timeout" | "overall-timeout" | "validation-failure" | "provider-failure"
  readonly phase: "evidence-capture" | "independent-reviews" | "final-synthesis" | "cleanup"
  readonly message: string
}

export const reviewFailureKindLabel = (kind: ReviewFailure["kind"]): string => ({
  "user-cancelled": "User cancellation",
  "request-timeout": "Request timeout",
  "overall-timeout": "Overall timeout",
  "validation-failure": "Validation failure",
  "provider-failure": "Provider failure",
})[kind]

export const reviewFailurePhaseLabel = (phase: ReviewFailure["phase"]): string => ({
  "evidence-capture": "Evidence capture",
  "independent-reviews": "Independent reviews",
  "final-synthesis": "Final synthesis",
  cleanup: "Cleanup",
})[phase]

export const reviewSynthesisStatus = (run: ReviewRun): NonNullable<ReviewRun["synthesisStatus"]> =>
  run.synthesisStatus ?? (
    run.status === "complete" || run.artifacts.some((entry) => entry.id === "synthesis:synthesis")
      ? "complete" : run.status === "running" ? "queued" : "not-run"
  )

export interface ReviewExecutionPolicy {
  readonly maximumCalls: number
  readonly maximumFindings: number
  readonly maximumPeerRounds: 2
  readonly maximumQuestionsPerRound: 4
}

export { maximumReviewCalls, reviewExecutionPolicy, reviewIncompatibilities } from "./review-evidence.ts"

export type ReviewEvent =
  | {
      readonly kind: "status"
      readonly checkId: string
      readonly status: "queued" | "running" | "complete" | "partial" | "failed"
    }
  | { readonly kind: "activity" | "text"; readonly checkId: string; readonly text: string; readonly source?: string }
  | { readonly kind: "artifact"; readonly artifact: ReviewArtifact }
  | { readonly kind: "synthesis"; readonly status: "running" | "complete" | "failed" | "not-run" }

export const reviewFindingLimit = (request: ReviewRequest): number =>
  selectReviewChecks(request.checks.map((check) => check.id)).reduce((count, check) => count + check.maximumFindings, 0)

export const reviewApprovedFindings = (run: ReviewRun, ids: ReadonlyArray<string>): ReadonlyArray<ReviewFinding> => {
  if (
    run.status !== "complete" ||
    run.execution !== "not-started" ||
    run.results.length !== run.request.checks.length ||
    run.results.some((result) => result.status !== "complete")
  )
    throw new Error("Only a complete, unlaunched review can authorize implementation.")
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("Select distinct recommended findings.")
  const findings = run.results.flatMap((result) => result.findings)
  return ids.map((id) => {
    const finding = findings.find((entry) => entry.id === id)
    if (
      !finding?.grounded ||
      finding.citations.length === 0 ||
      !finding.proposal ||
      !run.decisions.some((entry) => entry.findingId === id && entry.disposition === "recommended")
    )
      throw new Error(`Finding cannot authorize implementation: ${id}`)
    return finding
  })
}
