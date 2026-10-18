import assert from "node:assert/strict"
import { canonicalProfileRef } from "@trellage/guide-core"
import { runGuideGenerate, runGuideMatch, type GuideHeadlessArgs } from "../packages/trellage-launcher/src/guide-api.ts"
import { resolveGuideRequest } from "../packages/trellage-launcher/src/guide-command.ts"
import type { GuideProvider, GuideMatchCandidate } from "../packages/trellage-launcher/src/guide-provider.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"
import { assertGuideInteractiveIntent } from "./exhaustive-guide-interactive.ts"
import { assertGuideRitualProcess } from "./exhaustive-guide-ritual.ts"
import { assertGuideContinuationAdmission } from "./exhaustive-guide-continuation.ts"
import { assertGuideReviewTarget } from "./exhaustive-guide-review.ts"

export const assertGuideJsonService = async (
  args: GuideHeadlessArgs,
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  id: string,
  argv: readonly string[] = [],
): Promise<
  | "help"
  | "non-json"
  | "interactive-intent"
  | "match"
  | "generation"
  | "unknown-profile"
  | "ritual-print"
  | "ritual-ui"
  | "ritual-copy"
  | "unknown-ritual"
  | "next-steps-launch"
  | "review-target"
> => {
  if (args.help) return "help"
  if (!args.json) {
    if (args.ritual) return assertGuideRitualProcess(args, argv, id)
    if (args.nextSteps) return assertGuideContinuationAdmission(args, argv, id, world)
    if (args.review) return assertGuideReviewTarget(args, world, id)
    if (args.engagement) return "non-json"
    await assertGuideInteractiveIntent(args, id)
    return "interactive-intent"
  }
  const { request, routing } = resolveGuideRequest(
    args,
    JSON.stringify({ schemaVersion: 1, intent: "Fixture intent from stdin" }),
    {},
  )
  const { catalog, guideRoot } = world
  const calls: string[] = []
  let selected: GuideMatchCandidate[] = [],
    workflowId: string | undefined
  const unexpected = async (): Promise<never> => {
    throw new Error(`${id}: unexpected provider boundary`)
  }
  const provider: GuideProvider = {
    refine: unexpected,
    enrich: unexpected,
    firstmate: unexpected,
    match: async (input) => {
      assert.equal(request.profile, undefined, id)
      assert.equal(input.intent, request.intent, id)
      assert(input.entries.length >= 3, id)
      calls.push("match")
      selected = input.entries.slice(0, 3).map((entry) => ({
        profileRef: entry.ref,
        workflowId: entry.guide.workflows[0]!.id,
        confidence: 0.8,
        reason: "Explicit deterministic fixture",
        tradeoff: "No model judgment",
      }))
      return { candidates: selected }
    },
    generate: async (input) => {
      assert.equal(input.profileRef, request.profile, id)
      assert.equal(input.intent, request.intent, id)
      workflowId = input.workflowId
      calls.push("generate")
      return {
        candidates: ["Focused", "Thorough", "Cautious"].map((title) => ({
          title,
          prompt: `${title}: inspect the repository and report findings.`,
          notes: "Offline fixture",
        })),
      }
    },
    optimize: async (input) => {
      assert.equal(input.profileRef, request.profile, id)
      calls.push("optimize")
      return { candidates: input.candidates }
    },
  }
  if (request.profile === undefined) {
    const result = await runGuideMatch(provider, catalog, {
      intent: request.intent,
      ...routing.match,
    })
    assert.deepEqual(calls, ["match"], id)
    assert.equal(result.intent, request.intent, id)
    assert.equal(result.model, routing.match.model, id)
    assert.equal(result.effort, routing.match.effort, id)
    assert.deepEqual(
      result.recommendations.map(({ profileRef, workflowId }) => ({ profileRef, workflowId })),
      selected.map(({ profileRef, workflowId }) => ({ profileRef, workflowId })),
      id,
    )
    return "match"
  }
  const entry = catalog.native.find(
    (entry) => `native:${entry.launcher}/${entry.name}` === canonicalProfileRef(request.profile!),
  )
  const generate = () =>
    runGuideGenerate(
      provider,
      catalog,
      guideRoot,
      {
        intent: request.intent,
        profileRef: request.profile!,
        ...routing.generate,
      },
      undefined,
      {
        shouldSkipOptimize: async () => {
          calls.push("gate")
          return false
        },
      },
    )
  if (entry === undefined) {
    await assert.rejects(generate(), /Unknown profile reference/, id)
    assert.deepEqual(calls, [], id)
    return "unknown-profile"
  }
  const result = await generate()
  assert.deepEqual(calls, ["generate", "gate", "optimize"], id)
  assert(
    entry.guide.workflows.some((workflow) => workflow.id === workflowId),
    id,
  )
  assert.equal(result.profile.workflowId, workflowId, id)
  assert.equal(result.profile.profileRef, request.profile, id)
  assert.equal(result.intent, request.intent, id)
  assert.equal(result.model, routing.generate.model, id)
  assert.equal(result.effort, routing.generate.effort, id)
  assert.equal(result.candidates.length, 3, id)
  assert.equal(new Set(result.candidates.map((candidate) => candidate.prompt)).size, 3, id)
  for (const candidate of result.candidates) {
    assert.equal(candidate.command.executable, "trx", id)
    assert.deepEqual(candidate.command.args.slice(0, 3), ["run", entry.launcher, entry.name], id)
    assert(candidate.prompt.includes(candidate.title), id)
  }
  return "generation"
}
