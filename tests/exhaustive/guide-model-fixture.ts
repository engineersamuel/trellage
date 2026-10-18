import assert from "node:assert/strict"
import { mock } from "bun:test"
import type {
  GuideGenerateInput,
  GuideMatchInput,
  GuideOptimizeInput,
} from "../../packages/trellage-launcher/src/guide-provider.ts"
import type { JevSystemOneClient } from "../../packages/trellage-launcher/src/jev-decisions.ts"
import type { CopilotGuideProviderOptions } from "../../packages/trellage-launcher/src/copilot-guide-provider.ts"
import { MockAudit } from "./mock-audit.ts"
import type { GuideGoalDraft } from "../../packages/trellage-launcher/src/guide-goal-augment.ts"

export interface MatchExpectation {
  readonly profileRef: string
  readonly workflowId: string
  readonly confidence: number
}

export async function installGuideModelFixture() {
  if (process.env.TRELLAGE_TEST_OFFLINE !== "1")
    throw new Error("Guide model fixtures require enforced offline execution")
  const audit = new MockAudit()
  let fallback = false
  let optimize = true
  let goal: GuideGoalDraft | undefined
  let expected: MatchExpectation[] = []
  let routing: CopilotGuideProviderOptions["routing"]
  const original = await import("../../packages/trellage-launcher/src/copilot-guide-provider.ts")
  mock.module("../../packages/trellage-launcher/src/copilot-guide-provider.ts", () => ({
    ...original,
    CopilotGuideProvider: class {
      constructor(options: CopilotGuideProviderOptions) {
        audit.run("provider.configure", () => {
          assert.ok(options.routing)
          routing = options.routing
        })
      }
      async match(input: GuideMatchInput) {
        return audit.run("copilot.match", () => {
          assert.equal(fallback, true, "Unexpected Copilot matcher fallback")
          expected = input.entries.slice(0, 3).map((entry, index) => ({
            profileRef: entry.ref,
            workflowId: entry.guide.workflows[0]!.id,
            confidence: 0.9 - index * 0.1,
          }))
          return {
            candidates: input.entries.slice(0, 3).map((entry, index) => ({
              harness: entry.harness,
              profiles: entry.profiles,
              workflowId: entry.guide.workflows[0]!.id,
              confidence: 0.9 - index * 0.1,
              reason: "Deterministic model fixture",
              tradeoff: "Fixture only",
            })),
          }
        })
      }
      async generate(input: GuideGenerateInput) {
        return audit.run("copilot.generate", () => {
          assert.deepEqual(input.goal?.draft, goal)
          assert.ok(input.guideBody.length > 0)
          assert.ok(input.guide.workflows.some((workflow) => workflow.id === input.workflowId))
          return {
            candidates: [
              {
                title: "Inspect behavior",
                prompt: "Inspect the parser and trace the failing input before making the requested correction.",
                notes: "Deterministic fixture A",
              },
              {
                title: "Reproduce the defect",
                prompt: "Reproduce the reported failure, correct its cause, and verify the observable result.",
                notes: "Deterministic fixture B",
              },
              {
                title: "Check the contract",
                prompt: "Check the input contract, implement the requested behavior, and validate boundary cases.",
                notes: "Deterministic fixture C",
              },
            ],
          }
        })
      }
      async optimize(input: GuideOptimizeInput) {
        return audit.run("copilot.optimize", () => {
          assert.deepEqual(input.goal?.draft, goal)
          assert.equal(optimize, true, "Unexpected prompt optimization")
          assert.equal(input.candidates.length, 3)
          return { candidates: input.candidates }
        })
      }
    },
  }))
  const systemOne: JevSystemOneClient["systemOne"] = async (request) =>
    audit.run("jev.systemOne", () => {
      const questions = request.questions
      assert.ok(questions && Object.keys(questions).length > 0)
      const ids = Object.keys(questions)
      if (ids.every((id) => /^candidate[0-2]$/.test(id))) {
        assert.deepEqual(ids.sort(), ["candidate0", "candidate1", "candidate2"])
        return {
          answers: Object.fromEntries(
            Object.entries(questions).map(([id, question]) => {
              assert.equal(question.type, "noul")
              return [id, { type: "noul", noul: optimize ? 1 : 0 }]
            }),
          ),
        }
      }
      assert.equal(fallback, false, "Unexpected Jev request in missing-credential case")
      assert.equal(typeof request.state, "string")
      const state = JSON.parse(request.state as string) as {
        entries: GuideMatchInput["entries"]
        preferredProfileRefs?: string[]
        objective?: unknown
      }
      assert.equal(Array.isArray(state.entries), true)
      assert.ok(state.entries.length >= (goal === undefined ? 5 : 1))
      if (goal === undefined) assert.equal(state.preferredProfileRefs, undefined)
      else {
        assert.deepEqual(state.objective, goal)
        assert.equal(state.preferredProfileRefs, undefined)
        for (const entry of state.entries) {
          assert.ok(entry.goalExecution)
          assert.ok(entry.guide.workflows.every(({ id }) => entry.goalExecution!.workflowIds.includes(id)))
        }
      }
      expected = state.entries.slice(0, 5).map((entry, index) => ({
        profileRef: entry.ref,
        workflowId: entry.guide.workflows[0]!.id,
        confidence: (state.entries.length - index) / (state.entries.length + 1),
      }))
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            if (/^p[0-9]+$/.test(id)) {
              assert.equal(question.type, "noul")
              assert.ok(Number(id.slice(1)) < state.entries.length)
              return [
                id,
                {
                  type: "noul",
                  noul: (state.entries.length - Number(id.slice(1))) / (state.entries.length + 1),
                },
              ]
            }
            if (/^w[0-9]+$/.test(id)) {
              assert.equal(question.type, "choice")
              if (question.type !== "choice") throw new Error("Expected a workflow choice")
              const labels = Object.keys(question.criteria)
              assert.ok(labels.length > 1)
              return [
                id,
                {
                  type: "choice",
                  choice: labels[0],
                  confidence: 1,
                  probabilities: Object.fromEntries(labels.map((label, index) => [label, index === 0 ? 1 : 0])),
                },
              ]
            }
            assert.ok(["policyHeadlong", "policyPoteto"].includes(id), `Unknown Jev question: ${id}`)
            assert.equal(question.type, "noul")
            return [id, { type: "noul", noul: 0 }]
          }),
        ),
      }
    })
  mock.module("../../packages/trellage-launcher/src/provider-clients.ts", () => ({
    createLiveCopilotClient: () =>
      audit.run("unexpected.copilot.constructor", () => {
        throw new Error("No live Copilot client is allowed")
      }),
    createLiveTypeSafeClient: () => ({ systemOne }),
  }))
  return {
    audit,
    configure(options: { fallback: boolean; optimize: boolean; goal?: GuideGoalDraft }) {
      audit.assertClean()
      fallback = options.fallback
      optimize = options.optimize
      goal = options.goal
      expected = []
      routing = undefined
    },
    expectedMatches: () => expected,
    providerRouting: () => routing,
  }
}
