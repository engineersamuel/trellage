import { randomUUID } from "node:crypto"
import path from "node:path"
import type { CompositionCatalog } from "../../src/composition-catalog.ts"
import { defaultGuideModelRouting } from "../../src/guide-model-routing.ts"
import { optimizeDigest } from "../../src/review-source.ts"
import {
  buildGuideReviewPrompt,
  reviewAgentProfiles,
  type GuideReviewServices,
} from "../../src/review-services.ts"
import type { ReviewRun } from "../../src/review-contracts.ts"
import { sharedReviewApproval } from "../../src/review-store.ts"
import { FixtureMode, fixtureHead, type RecordFixtureEvent } from "./guide-integration-data.ts"
import { assignReviewModels } from "../../src/review-catalog.ts"
import { displayReviewers } from "../../src/review-view-model.ts"

export const createFixtureOptimizeServices = (
  root: string,
  mode: FixtureMode,
  catalog: CompositionCatalog,
  record: RecordFixtureEvent,
): GuideReviewServices => {
  const reviews = new Map<string, ReviewRun>()
  const reviewers = displayReviewers(assignReviewModels(["ponytail", "fleet", "matt-code-review"]))
  const coordinator = defaultGuideModelRouting.optimize
  const getReview = (id: string) => {
    const review = reviews.get(id)
    if (review === undefined) throw new Error("Saved review is missing.")
    return review
  }
  return {
    herdr: mode !== FixtureMode.Terminal,
    profiles: reviewAgentProfiles(catalog),
    reviewers,
    coordinator,
    destinations: mode === FixtureMode.Terminal ? ["terminal"] : ["pane", "tab", "terminal"],
    async history(signal) {
      signal.throwIfAborted()
      await record({ kind: "optimize-history" })
      return [...reviews.values()]
    },
    async readReview(id, signal) {
      signal.throwIfAborted()
      await record({ kind: "optimize-history", reviewId: id })
      return getReview(id)
    },
    async approve(id, ids, signal) {
      signal.throwIfAborted()
      const review = getReview(id)
      const approval = sharedReviewApproval(review, ids)
      reviews.set(id, { ...review, approvedIds: ids })
      await record({ kind: "optimize-approval", reviewId: id, ids })
      return approval
    },
    async review(input, signal, progress, events) {
      await record({ kind: "optimize-review", input })
      for (const id of input.reviewerIds) {
        events?.({ kind: "status", checkId: id, status: "running" })
        events?.({ kind: "text", checkId: id, text: `Unverified fixture output from ${id}.` })
      }
      if (mode === FixtureMode.OptimizeCancel) {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        )
      }
      signal.throwIfAborted()
      const sources = input.paths.map((id) => ({ id, content: "return value\n" }))
      const source = { sources, excluded: [], fingerprint: optimizeDigest({ sources, excluded: [] }) }
      const checks = assignReviewModels(input.reviewerIds)
      const noChange = mode === FixtureMode.OptimizeNoChange
      const incomplete = mode === FixtureMode.OptimizeIncomplete
      const results = checks.map((check) => ({
        id: check.id,
        status: incomplete ? "partial" as const : "complete" as const,
        reportId: `${check.id}:report`,
        limitations: [],
        findings: noChange ? [] : [{
          id: `${check.id}:1`, checkId: check.id, reportId: `${check.id}:report`, sourceId: "1",
          title: `Simplify login from ${check.id}`, proposal: "Return the value directly.",
          benefit: "Less code.", risk: "None found.", verification: "Run the login tests.",
          paths: [input.paths[0]!], citations: [{ source: input.paths[0]!, startLine: 1, endLine: 1, quote: "return value" }],
          grounded: true,
        }],
      }))
      const run: ReviewRun = {
        schemaVersion: 2, id: randomUUID(), createdAt: new Date().toISOString(),
        policy: { maximumCalls: 30, maximumFindings: 100, maximumPeerRounds: 2, maximumQuestionsPerRound: 4 },
        request: { target: input.target, paths: input.paths, checks, coordinator,
          ...(input.originalIntent === undefined ? {} : { originalIntent: input.originalIntent }),
          ...(input.intent === undefined ? {} : { intent: input.intent }) },
        evidence: { fingerprint: optimizeDigest({ source }), source },
        status: incomplete ? "incomplete" : "complete", synthesisStatus: incomplete ? "not-run" : "complete",
        results,
        artifacts: checks.map((check) => ({ id: `${check.id}:report`, checkId: check.id, name: `${check.id}.md`,
          content: `${check.id} saved report`, digest: optimizeDigest(`${check.id} saved report`) })),
        challenges: [],
        decisions: incomplete ? [] : results.flatMap((result) => result.findings.map((finding) => ({
          findingId: finding.id, disposition: "recommended" as const, reason: "Fixture evidence supports it.",
        }))),
        summary: noChange ? "Keep this code." : incomplete ? "Review incomplete." : "Saved fixture",
        error: incomplete ? "One or more checks have incomplete coverage." : null,
        calls: 0, approvedIds: [], execution: "not-started",
      }
      for (const check of checks) events?.({ kind: "status", checkId: check.id, status: incomplete ? "partial" : "complete" })
      progress("Fixture review complete.")
      reviews.set(run.id, run)
      return run
    },
    async inspect(scope, signal) {
      signal.throwIfAborted()
      await record({ kind: "optimize-target", scope })
      if (scope.kind === "current-branch") scope = { kind: "branch", baseRef: "main" }
      if (scope.kind === "branch" && scope.baseRef === "missing-base")
        throw new Error("Comparison base missing-base is not an existing commit.")
      return {
        cwd: root,
        gitDirectory: path.join(root, ".git"),
        head: fixtureHead,
        scope,
        fingerprint: "fixture-target",
        ...(scope.kind === "uncommitted"
          ? {}
          : { base: { ref: scope.baseRef, commit: fixtureHead, mergeBase: fixtureHead } }),
        changes:
          scope.kind === "branch" && scope.baseRef === "unchanged"
            ? []
            : [
                {
                  path: "src/login.ts",
                  kind: "file",
                  staged: true,
                  unstaged: true,
                  untracked: false,
                  committed: scope.kind === "branch",
                  fingerprint: "login",
                },
                {
                  path: "notes.txt",
                  kind: "file",
                  staged: false,
                  unstaged: false,
                  untracked: true,
                  committed: false,
                  fingerprint: "notes",
                },
              ],
      }
    },
    async execute(request, profileRef, signal) {
      signal.throwIfAborted()
      if (!request.otherEditorsStopped) throw new Error("Confirm that other editors have stopped.")
      const review = getReview(request.approval.reviewId)
      if (optimizeDigest(request.approval) !== optimizeDigest(sharedReviewApproval(review, review.approvedIds)))
        throw new Error("Approval does not match the saved fixture.")
      const prompt = buildGuideReviewPrompt(request)
      await record({ kind: "optimize-changes", request, profileRef, prompt })
      reviews.set(review.id, { ...review, execution: "launched" })
      return { paneId: "9-optimize", message: "Optimization launched; completion is not verified." }
    },
  }
}
