import path from "node:path"
import type { CombinedGuideCatalog } from "../../src/guide-catalog.ts"
import { defaultGuideModelRouting } from "../../src/guide-model-routing.ts"
import { optimizeDigest } from "../../src/guide-optimize-evidence.ts"
import {
  newOptimizeReview,
  optimizeApproval,
  optimizeReviewersFor,
  runOptimizeReview,
  type OptimizeReview,
} from "../../src/guide-optimize-review.ts"
import {
  buildGuideOptimizePrompt,
  guideOptimizeProfiles,
  type GuideOptimizeServices,
} from "../../src/guide-optimize.ts"
import { FixtureMode, fixtureHead, type RecordFixtureEvent } from "./guide-integration-data.ts"
import { fixtureOptimizeModel, readReviewEvidence } from "./guide-optimize-model.ts"
import { record as parseRecord } from "../../src/guide-text.ts"

export const createFixtureOptimizeServices = (
  root: string,
  mode: FixtureMode,
  catalog: CombinedGuideCatalog,
  record: RecordFixtureEvent,
): GuideOptimizeServices => {
  const reviews = new Map<string, OptimizeReview>()
  const reviewers = optimizeReviewersFor(defaultGuideModelRouting)
  const coordinator = defaultGuideModelRouting.optimize
  const getReview = (id: string) => {
    const review = reviews.get(id)
    if (review === undefined) throw new Error("Saved review is missing.")
    return review
  }
  return {
    herdr: mode !== FixtureMode.Terminal,
    profiles: guideOptimizeProfiles(catalog),
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
      const approval = optimizeApproval(review, ids)
      reviews.set(id, { ...review, approvedIds: ids })
      await record({ kind: "optimize-approval", reviewId: id, ids })
      return approval
    },
    async review(input, signal, progress) {
      await record({ kind: "optimize-review", input })
      const sources = [
        ...input.paths.map((id) => ({ id, content: "return value\n" })),
        { id: "@diff/staged", content: "+return value\n" },
        ...["improve-codebase-architecture", "codebase-design"].map((name) => ({
          id: `@skill/${name}`,
          content: `---\nname: ${name}\n---\nRead-only fixture criteria.\n`,
        })),
      ]
      const evidence = { sources, excluded: [], fingerprint: optimizeDigest({ sources, excluded: [] }) }
      const initial = newOptimizeReview(input, evidence, reviewers, coordinator)
      return runOptimizeReview(
        initial,
        async (review) => {
          reviews.set(review.id, review)
        },
        signal,
        progress,
        async (request) => {
          request.signal?.throwIfAborted()
          if (
            mode === FixtureMode.OptimizeIncomplete &&
            request.systemPrompt.includes("Defend or withdraw your findings")
          ) {
            const valid = JSON.parse(await fixtureOptimizeModel(request)) as { responses: ReadonlyArray<unknown> }
            return JSON.stringify({ ...valid, responses: [] })
          }
          if (mode === FixtureMode.OptimizeCancel) {
            await new Promise<void>((_resolve, reject) =>
              request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }),
            )
          }
          if (mode === FixtureMode.OptimizeNoChange && !request.systemPrompt.includes("Reconcile these reports")) {
            await readReviewEvidence(request)
            return JSON.stringify({ summary: "Keep this code.", limitations: [], findings: [] })
          }
          const response = await fixtureOptimizeModel(request)
          if (
            input.reviewerIds.includes("improve-codebase-architecture") &&
            request.systemPrompt.includes("Reconcile these reports")
          ) {
            return JSON.stringify({
              ...parseRecord(JSON.parse(response), "verdict"),
              summary: `${"Architecture review: focus on module depth without changing behavior.\n".repeat(16)}Architecture review tail: preserve the retry contract.`,
            })
          }
          return response
        },
      )
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
      if (optimizeDigest(request.approval) !== optimizeDigest(optimizeApproval(review, review.approvedIds)))
        throw new Error("Approval does not match the saved fixture.")
      const prompt = buildGuideOptimizePrompt(request)
      await record({ kind: "optimize-changes", request, profileRef, prompt })
      reviews.set(review.id, { ...review, execution: "launched" })
      return { paneId: "9-optimize", message: "Optimization launched; completion is not verified." }
    },
  }
}
