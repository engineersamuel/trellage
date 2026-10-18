import assert from "node:assert/strict"
import {
  ActionAccess,
  ActionImportance,
  ContinuationActionStatus,
  ContinuationOutcome,
  type ContinuationAssessment,
  type ContinuationDraft,
  type ConversationSnapshot,
} from "@trellage/guide-core"
import { guideMatchCatalogEntries } from "../packages/trellage-launcher/src/guide-catalog.ts"
import {
  createContinuationServices,
  resolveContinuationModelRouting,
} from "../packages/trellage-launcher/src/continuation-runtime.ts"
import type { ContinuationStore } from "../packages/trellage-launcher/src/continuation-store.ts"
import { jevModel } from "../packages/trellage-launcher/src/jev-decisions.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"
import { assertContinuationPreparation } from "./exhaustive-continuation-preparation.ts"

export const assertContinuationAssessment = async (
  store: ContinuationStore,
  snapshot: ConversationSnapshot,
  initial: Pick<ContinuationDraft, "model" | "effort">,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
): Promise<void> => {
  const entries = guideMatchCatalogEntries(world.catalog)
  const routing = resolveContinuationModelRouting(initial).match
  assert(entries.length >= 5, id)
  const choices = [
    ["Review correctness", "Inspect error handling in the completed changes.", "A prioritized defect report."],
    ["Visualize the flow", "Draw the implemented data flow and component boundaries.", "A labeled flow diagram."],
    ["Explain tradeoffs", "Describe the design decisions and their alternatives.", "A design explanation."],
    ["Test edge cases", "Add targeted boundary tests for the changed behavior.", "Focused regression tests."],
    ["Draft release notes", "Summarize the user-facing changes for the release.", "Release notes."],
  ] as const
  const response = (outcome: ContinuationOutcome): ContinuationAssessment => ({
    schemaVersion: 1,
    outcome,
    goal: "Review the fixture changes.",
    reportedProgress: ["The fixture changes were reported ready."],
    unresolvedWork: outcome === ContinuationOutcome.NoFurtherAction ? [] : ["Review remains."],
    blockers: [],
    questions: outcome === ContinuationOutcome.NeedsClarification ? ["Which behavior needs review first?"] : [],
    actions:
      outcome !== ContinuationOutcome.Recommendations
        ? []
        : choices.map(([title, brief, expectedOutput], index) => ({
            id: `action-${index + 1}`,
            rank: index + 1,
            title,
            brief,
            expectedOutput,
            whyNow: "The changes were reported ready for review.",
            evidenceIds: ["m2"],
            importance: ActionImportance.Optional,
            profileRef: entries[index]!.ref,
            workflowId: entries[index]!.guide.workflows[0]!.id,
            dependsOn: [],
            access: ActionAccess.ReadOnly,
          })),
  })
  const fixtures = [
    ...Object.values(ContinuationOutcome).map((outcome) => ({ outcome, probability: 0.994999, invalid: false })),
    { outcome: ContinuationOutcome.NoFurtherAction, probability: 0.995, invalid: false },
    { outcome: ContinuationOutcome.Recommendations, probability: 0, invalid: true },
  ]
  for (const fixture of fixtures) {
    const label = `${id}: ${fixture.outcome}/${fixture.probability}/${fixture.invalid}`
    const draft = await store.create(snapshot, initial.model, initial.effort)
    const calls: string[] = []
    const boundaryFailures: unknown[] = []
    const unexpected = (): never => {
      throw new Error(`${label}: unexpected model or command boundary`)
    }
    const controller = new AbortController()
    let assessmentCalls = 0
    const services = createContinuationServices({
      store,
      catalog: world.catalog,
      guideRoot: world.guideRoot,
      initialDraft: draft,
      runner: { run: unexpected },
      sourceClient: { check: unexpected, refresh: unexpected },
      preparationProvider: unexpected,
      assessmentProvider: (current) => {
        assert.deepEqual(current, draft, label)
        calls.push("provider")
        return {
          model: routing.model,
          effort: routing.effort,
          promptDigest: async () => {
            calls.push("digest")
            return "b".repeat(64)
          },
          summarize: unexpected,
          assess: async (input, options) => {
            try {
              assert.equal(options.signal, controller.signal, label)
              assert.equal(options.repair, assessmentCalls === 0 ? undefined : "invalid-assessment", label)
              assert.deepEqual(input.messages, snapshot.messages, label)
              assert.deepEqual(input.summaries, [], label)
              assert.equal(input.snapshot.id, snapshot.id, label)
              assert.deepEqual(input.snapshot.cutoff, snapshot.cutoff, label)
              assert.deepEqual(input.snapshot.coverage, snapshot.coverage, label)
              assert.equal(input.progressStatus, "reported-not-verified", label)
              assert.equal(input.readinessStatus, "not-checked", label)
              const identities = (values: typeof entries) =>
                values.map((entry) => ({
                  ref: entry.ref,
                  workflows: entry.guide.workflows.map((workflow) => workflow.id),
                }))
              assert.deepEqual(identities(input.entries), identities(entries), label)
              assert(assessmentCalls < (fixture.invalid ? 2 : 1), label)
            } catch (error) {
              boundaryFailures.push(error)
              throw error
            }
            assessmentCalls++
            calls.push("assess")
            return fixture.invalid ? { schemaVersion: 1, outcome: "malformed" } : response(fixture.outcome)
          },
        }
      },
      jevDecision: {
        cwd: snapshot.source.cwd,
        env: { TRELLAGE_ENVIRONMENT: "off" },
        client: {
          systemOne: async (request, options) => {
            try {
              assert.equal(request.model, jevModel, label)
              assert.deepEqual(JSON.parse(request.state as string), { messages: snapshot.messages }, label)
              assert.deepEqual(Object.keys(request.questions), ["decision"], label)
              assert.equal(request.questions.decision?.type, "noul", label)
              assert.equal(options.retry?.maxRetries, 0, label)
              assert.equal(options.timeout, 3_000, label)
              assert.equal(options.signal?.aborted, false, label)
            } catch (error) {
              boundaryFailures.push(error)
              throw error
            }
            calls.push("jev")
            return { answers: { decision: { type: "noul", noul: fixture.probability } } }
          },
        },
      },
    })
    assert.deepEqual(calls, [], label)
    const progress: string[] = []
    const analyze = () => services.analyze(draft, controller.signal, (message) => progress.push(message))
    if (fixture.invalid) {
      await assert.rejects(analyze(), /assessment-invalid-after-one-repair/, label)
      assert.deepEqual(await store.load(draft.id), draft, label)
      assert.deepEqual(calls, ["provider", "digest", "jev", "assess", "assess"], label)
      assert.equal(
        progress.filter((message) => message.includes("Repairing one completed invalid assessment")).length,
        1,
        label,
      )
    } else {
      const assessed = await analyze()
      const shortcut = fixture.probability >= 0.995
      assert.deepEqual(calls, ["provider", "digest", "jev", ...(shortcut ? [] : ["assess"])], label)
      assert.equal(assessed.assessment?.outcome, fixture.outcome, label)
      assert.deepEqual(assessed.snapshot, snapshot, label)
      assert.deepEqual(await store.load(assessed.id), assessed, label)
      assert(assessed.revision > draft.revision, label)
      if (!shortcut)
        assert.deepEqual(
          assessed.assessment,
          {
            ...response(fixture.outcome),
            reportedProgress: ["Reported (not verified): The fixture changes were reported ready."],
          },
          label,
        )
      assert.equal(assessed.actions.length, fixture.outcome === ContinuationOutcome.Recommendations ? 5 : 0, label)
      for (const edit of assessed.actions) {
        assert.equal(edit.status, ContinuationActionStatus.Draft, label)
        assert.equal(edit.selected, false, label)
        assert.equal(edit.prompt, undefined, label)
        assert.equal(
          edit.brief,
          assessed.assessment!.actions.find((action) => action.id === edit.actionId)!.brief,
          label,
        )
      }
      const completedCalls = [...calls]
      await assert.rejects(
        services.analyze(assessed, controller.signal, () => {}),
        /Analyze latest/,
        label,
      )
      assert.deepEqual(calls, completedCalls, label)
      if (fixture.outcome === ContinuationOutcome.Recommendations)
        await assertContinuationPreparation(store, assessed, world, label)
    }
    assert.deepEqual(boundaryFailures, [], label)
  }
}
