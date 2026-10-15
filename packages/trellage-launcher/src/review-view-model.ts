import { optimizeDigest } from "./review-source.ts"
import type { OptimizeReviewer } from "./review-findings.ts"
import { reviewCheckCatalog, type ReviewCheckAssignment } from "./review-catalog.ts"
import { SharedReviewStore, type SharedReviewApproval } from "./review-store.ts"
import { captureSharedReviewEvidence } from "./review-evidence.ts"
import type { CommandRunner } from "./guide-launch.ts"

export const displayReviewers = (assignments: ReadonlyArray<ReviewCheckAssignment>): ReadonlyArray<OptimizeReviewer> =>
  assignments.map((assignment) => {
    const check = reviewCheckCatalog.find((entry) => entry.id === assignment.id)!
    return { id: check.id, title: check.label, description: check.purpose, prompt: "", model: assignment.model }
  })

export type ReviewAuthority = SharedReviewStore
export type ReviewNamespace = ReviewAuthority["namespace"]

export const reviewAuthority = async (gitDirectory: string, id: string): Promise<ReviewAuthority> => {
  const shared = new SharedReviewStore(gitDirectory)
  if (await shared.hasRecord(id)) return shared
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
  const current = await captureSharedReviewEvidence(runner, run.request, signal)
  if (
    current.source.fingerprint !== expected ||
    optimizeDigest(current.patch ?? null) !== optimizeDigest(run.evidence.patch ?? null)
  )
    throw new Error("Review context changed. Run a new review before implementation.")
}
