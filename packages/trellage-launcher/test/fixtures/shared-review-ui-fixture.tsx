import React from "react"
import { render } from "ink"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { GuideOptimizeApp } from "../../src/guide-optimize-ui.tsx"
import { createFixtureOptimizeServices } from "./guide-optimize-services.ts"
import { FixtureMode } from "./guide-integration-data.ts"
import { newOptimizeReview } from "../../src/guide-optimize-review.ts"
import { assignReviewModels, reviewCatalog, fleetLenses, pinnedFleetModel } from "../../src/review-catalog.ts"
import { CopilotReviewProvider, type ReviewClientFactory } from "../../src/copilot-review-provider.ts"
import type { SessionEvent } from "@github/copilot-sdk"
import type { ReviewEvent } from "../../src/review-contracts.ts"
import type { GuideOptimizeServices } from "../../src/guide-optimize.ts"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.ts"

const root = process.argv[2]!
const fixtureOutcome = process.argv[3] ?? "complete"
const selectedChecks = fixtureOutcome === "all"
  ? ["fleet", "ponytail", "first-principles", "behavior-preservation", "improve-codebase-architecture", "matt-code-review"]
  : fixtureOutcome === "architecture-failed"
    ? ["improve-codebase-architecture"]
  : ["fleet", "ponytail"]
const base = createFixtureOptimizeServices(root, FixtureMode.Terminal,
  { schemaVersion: 1, sandboxCommandPath: "/unused", native: [], sandbox: [] }, async () => {})
const wait = async (name: string, signal: AbortSignal) => {
  while (!signal.aborted) {
    try { await readFile(path.join(root, name)); return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
const completedFixtureState = (finish: string, aborted: boolean) => {
  if (aborted) return { result: "failed" as const, run: "cancelled" as const, synthesis: "failed" as const }
  if (finish === "architecture-failed")
    return { result: "partial" as const, run: "incomplete" as const, synthesis: "not-run" as const }
  if (finish === "partial")
    return { result: "partial" as const, run: "incomplete" as const, synthesis: "complete" as const }
  return { result: "complete" as const, run: "complete" as const, synthesis: "complete" as const }
}
const retainedFixtureFindings = (id: string, failed: boolean) => failed ? [{
  id: `${id}:partial-1`, checkId: id as "improve-codebase-architecture", reportId: `${id}:report`,
  sourceId: `${id}:batch-1`, title: "Retained partial finding", proposal: "Keep the completed batch result.",
  benefit: "Preserves completed review work.", risk: "The review remains incomplete.",
  verification: "Finish synthesis before approval.", paths: ["src/login.ts"], citations: [], grounded: false,
}] : []
  // Only the SDK transport is fake: use the production session-event routing.
  const streamReviews = async (ids: readonly string[], signal: AbortSignal, event?: (event: ReviewEvent) => void) => {
    const factory: ReviewClientFactory = () => ({
      start: async () => {}, listModels: async () => [
        ...reviewCatalog.map((review) => ({ id: review.model })),
        ...fleetLenses.map((lens) => ({ id: pinnedFleetModel(lens)! })),
      ],
      deleteSession: async () => {}, forceStop: async () => {},
      createSession: async (config) => {
        let handler: (event: SessionEvent) => void = () => {}
        return {
          sessionId: config.sessionId!, on: (next) => { handler = next; return () => {} },
          abort: async () => {}, disconnect: async () => {},
          sendAndWait: async ({ prompt }) => {
            const id = prompt.startsWith("/fleet-review") ? "fleet" : "ponytail"
            event?.({ kind: "status", checkId: id, status: "running" })
            if (id === "fleet") handler({ type: "subagent.started", agentId: "security",
              data: { agentDescription: "Security", agentType: "code-review", executionMode: "background" } } as SessionEvent)
            handler({ type: "assistant.message_delta", ...(id === "fleet" ? { agentId: "security" } : {}),
              data: { messageId: id, deltaContent: Array.from({ length: 120 }, (_, n) =>
                `${id} streamed line ${n.toString().padStart(3, "0")}`).join("\n") } } as SessionEvent)
            await wait("append", signal)
            if (id === "fleet") handler({ type: "assistant.message_delta", agentId: "security",
              data: { messageId: id, deltaContent: "\nfleet appended text" } } as SessionEvent)
            // This fixture exercises rendering, not Fleet report validation.
            throw new Error("Fixture stream finished")
          },
        }
      },
    })
    const provider = new CopilotReviewProvider({
      root, work: root, runtime: root, skills: new Map(ids.map((id) => [id, root])),
      references: new Map(), dispose: async () => {},
    }, { repository: root, baseRef: "main", baseRefSha: "a".repeat(40), base: "a".repeat(40),
      head: "b".repeat(40), diff: "+fixture", changedFiles: ["src/login.ts"], workingTreeFiles: [] },
    factory, 30000, (checkId, output) => event?.({ checkId, ...output }))
    try {
      await Promise.all(ids.map(async (id) => {
        if (id === "fleet" || id === "ponytail")
          return provider.review(reviewCatalog.find((review) => review.id === id)!, signal)
        event?.({ kind: "status", checkId: id, status: "running" })
        event?.({ kind: "text", checkId: id, text: Array.from({ length: 120 }, (_, n) =>
          `${id} streamed line ${n.toString().padStart(3, "0")}`).join("\n") })
      }))
    } finally { await provider.close() }
  }
const services: GuideOptimizeServices = {
  ...base,
  defaultReviewerIds: selectedChecks,
  assignments: assignReviewModels(selectedChecks),
  async review(input, signal, _progress, event) {
    const evidence = { sources: [], excluded: [], fingerprint: "fixture" }
    const initial = newOptimizeReview(input, evidence, base.reviewers, base.coordinator)
    await wait("stream", signal)
    await streamReviews(input.reviewerIds, signal, event)
    await wait("finish", signal)
    const finish = signal.aborted ? "cancelled" : await readFile(path.join(root, "finish"), "utf8")
    const failed = finish === "architecture-failed"
    const state = completedFixtureState(finish, signal.aborted)
    for (const id of input.reviewerIds) event?.({ kind: "status", checkId: id, status: state.result })
    event?.({ kind: "synthesis", status: state.synthesis })
    return {
        schemaVersion: 2, policy: { maximumCalls: 30, maximumFindings: 100, maximumPeerRounds: 2, maximumQuestionsPerRound: 4 },
        id: initial.id, createdAt: initial.createdAt,
        request: { ...input, checks: assignReviewModels(input.reviewerIds), coordinator: base.coordinator },
        evidence: { fingerprint: "fixture", source: evidence }, status: state.run, synthesisStatus: state.synthesis,
        ...(failed ? { failure: { kind: "request-timeout" as const, phase: "independent-reviews" as const,
          message: "Improve codebase architecture: restricted model request timed-out" } } : {}),
        results: input.reviewerIds.map((id) => ({ id: id as "fleet" | "ponytail", status: state.result,
          reportId: `${id}:report`, findings: retainedFixtureFindings(id, failed),
          limitations: failed ? ["Final synthesis did not run."] : [] })), artifacts: input.reviewerIds.map((id) => ({
          id: `${id}:report`, checkId: id as "fleet" | "ponytail", name: `${id}.md`,
          content: `${id} full saved evidence\x1b[2J\n${"w".repeat(220)}`, digest: "fixture",
        })), challenges: [], decisions: [], summary: failed ? "Review failed before final synthesis." : "Saved fixture",
        error: failed ? "Review failed during Independent reviews: Improve codebase architecture: restricted model request timed-out" : null, calls: 0,
        approvedIds: [], execution: "not-started",
      }
  },
}
const app = render(<GuideOptimizeApp services={services} initialBase="main" />,
  { exitOnCtrlC: false, onRender: createInitialGuideRenderHandler((text) => process.stdout.write(text), true) })
await app.waitUntilExit()
