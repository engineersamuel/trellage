import assert from "node:assert/strict"
import { GUIDE_MAX_GENERATED_SPEC } from "@trellage/guide-core"
import {
  defaultGuideModelRouting,
  parseGuideHeadlessArgv,
  type GuideGenerationResponse,
  type GuideMatchResponse,
} from "../../packages/trellage-launcher/src/guide-api.ts"
import { GuideValidationError } from "../../packages/trellage-launcher/src/guide-text.ts"
import { GuideGoalError } from "../../packages/trellage-launcher/src/guide-goal-augment.ts"
import { guideJsonRequestInput } from "./guide-request-fields.ts"
import { installGuideModelFixture } from "./guide-model-fixture.ts"
import type { guideWorld } from "./guide-world.ts"

type GuideWorld = Awaited<ReturnType<typeof guideWorld>>
type GuideFixture = Awaited<ReturnType<typeof installGuideModelFixture>>
type ParsedGuide = ReturnType<typeof parseGuideHeadlessArgv>
type GuideInput = ReturnType<typeof guideJsonRequestInput>

interface GuideCase {
  readonly id: string
  readonly argv: readonly string[]
  readonly values: Readonly<Record<string, string>>
}

interface JsonExpectations {
  readonly input: GuideInput
  readonly profile?: string
  readonly model?: string
  readonly effort?: string
  readonly workflow?: string
  readonly originalIntent?: string
  readonly goal?: NonNullable<GuideInput["goal"]>
}

interface JsonCaseContext {
  readonly world: GuideWorld
  readonly fixture: GuideFixture
  readonly entry: GuideCase
  readonly parsed: ParsedGuide
  readonly expectations: JsonExpectations
  readonly knownProfiles: ReadonlySet<string>
  readonly profileWorkflows: ReadonlyMap<string, ReadonlySet<string>>
}

const expectedJsonValues = (entry: GuideCase, parsed: ParsedGuide): JsonExpectations => {
  const input = guideJsonRequestInput(entry.values)
  const fromStdin = parsed.intent === undefined
  return {
    input,
    profile: parsed.profile ?? (fromStdin ? input.profile : undefined),
    model: parsed.model ?? (fromStdin ? input.model : undefined),
    effort: parsed.effort ?? (fromStdin ? input.effort : undefined),
    workflow: fromStdin ? input.workflowId : undefined,
    originalIntent: fromStdin ? input.originalIntent : undefined,
    goal: fromStdin ? input.goal : undefined,
  }
}

const assertNoModelCalls = (
  context: JsonCaseContext,
  before: Readonly<Record<string, number>>,
  message: string,
): void => {
  for (const operation of ["copilot.generate", "copilot.optimize", "jev.systemOne"])
    assert.equal(context.fixture.audit.snapshot()[operation], before[operation], `${context.entry.id}: ${message}`)
}

const verifyRejectedInputError = (
  context: JsonCaseContext,
  error: unknown,
  before: Readonly<Record<string, number>>,
): string | undefined => {
  const { parsed, expectations } = context
  const { input } = expectations
  const rejectsInput =
    parsed.intent === undefined &&
    (input.rejected || (input.workflowId !== undefined && expectations.profile === undefined))
  if (!rejectsInput || !(error instanceof GuideValidationError || error instanceof GuideGoalError)) return undefined
  assert.deepEqual(
    context.fixture.audit.snapshot(),
    before,
    `${context.entry.id}: invalid JSON request reached a model boundary`,
  )
  return "json-input-rejected"
}

const expectedGoalPolicy = (context: JsonCaseContext) => {
  const { parsed, expectations, world, knownProfiles } = context
  const { profile, goal, workflow } = expectations
  if (parsed.intent !== undefined || goal === undefined || profile === undefined || !knownProfiles.has(profile))
    return undefined
  const selected = world.catalog.native.find((entry) => `native:${entry.launcher}/${entry.name}` === profile)!
  return { goal, policy: selected.guide.goalExecution, workflow }
}

const verifyExpectedGoalError = (
  context: JsonCaseContext,
  error: unknown,
  before: Readonly<Record<string, number>>,
): string | undefined => {
  const expected = expectedGoalPolicy(context)
  if (expected === undefined) return undefined
  const { goal, policy, workflow } = expected
  const incompatible = policy === undefined || (workflow !== undefined && !policy.workflowIds.includes(workflow))
  if (incompatible) {
    assert.ok(
      error instanceof Error && error.message.includes("cannot execute this goal:"),
      `${context.entry.id}: ${error}`,
    )
    assertNoModelCalls(context, before, "incompatible goal reached")
    return "goal-incompatible"
  }
  if (policy.controller === "claude-goal" && goal.task.length > 4000) {
    assert.ok(
      error instanceof Error && error.message.includes("4,000-character condition limit"),
      `${context.entry.id}: ${error}`,
    )
    assertNoModelCalls(context, before, "oversized goal reached")
    return "goal-too-large"
  }
  return undefined
}

const verifyUnknownProfileError = (context: JsonCaseContext, error: unknown): string | undefined => {
  const { profile } = context.expectations
  if (
    profile !== undefined &&
    !context.knownProfiles.has(profile) &&
    error instanceof Error &&
    error.message === `Unknown profile reference: ${profile}`
  )
    return "unknown-profile"
  return undefined
}

const verifyUnknownWorkflowError = (context: JsonCaseContext, error: unknown): string | undefined => {
  const { profile, workflow } = context.expectations
  if (profile === undefined || !context.knownProfiles.has(profile) || workflow === undefined) return undefined
  if (context.profileWorkflows.get(profile)!.has(workflow)) return undefined
  if (!(error instanceof Error) || error.message !== `Selected workflow is unknown for ${profile}: ${workflow}`)
    return undefined
  return "unknown-workflow"
}

const verifyOriginalIntentError = (
  context: JsonCaseContext,
  error: unknown,
  before: Readonly<Record<string, number>>,
): string | undefined => {
  const { profile, originalIntent } = context.expectations
  if (
    profile === undefined ||
    !context.knownProfiles.has(profile) ||
    originalIntent === undefined ||
    !(error instanceof GuideValidationError) ||
    !["single-prompt delivery", "bodyBudget"].includes(error.path)
  )
    return undefined
  assert.ok(
    originalIntent.length >= GUIDE_MAX_GENERATED_SPEC,
    `${context.entry.id}: unexpected original intent rejection`,
  )
  const tooLarge = originalIntent.length > GUIDE_MAX_GENERATED_SPEC
  assert.equal(error.path, tooLarge ? "single-prompt delivery" : "bodyBudget")
  assertNoModelCalls(context, before, "rejected original intent reached")
  return tooLarge ? "original-intent-too-large" : "original-intent-no-room"
}

const handleGuideJsonError = (
  context: JsonCaseContext,
  error: unknown,
  before: Readonly<Record<string, number>>,
): string => {
  context.fixture.audit.assertClean()
  const rejected = verifyRejectedInputError(context, error, before)
  if (rejected !== undefined) return rejected
  const goalError = verifyExpectedGoalError(context, error, before)
  if (goalError !== undefined) return goalError
  const unknownProfile = verifyUnknownProfileError(context, error)
  if (unknownProfile !== undefined) return unknownProfile
  const unknownWorkflow = verifyUnknownWorkflowError(context, error)
  if (unknownWorkflow !== undefined) return unknownWorkflow
  const originalIntent = verifyOriginalIntentError(context, error, before)
  if (originalIntent !== undefined) return originalIntent
  throw error
}

const assertGoalCandidate = (
  context: JsonCaseContext,
  response: GuideGenerationResponse,
  candidate: GuideGenerationResponse["candidates"][number],
  profile: string,
): void => {
  const { world, entry, expectations } = context
  const goal = expectations.goal!
  const selected = world.catalog.native.find((item) => `native:${item.launcher}/${item.name}` === profile)!
  const policy = selected.guide.goalExecution
  assert.ok(policy, `${entry.id}: goal accepted without a controller`)
  assert.ok(policy.workflowIds.includes(response.profile.workflowId))
  assert.equal(response.profile.goalExecution?.controller, policy.controller)
  assert.equal(candidate.goalExecution?.controller, policy.controller)
  assert.ok(candidate.prompt.startsWith("/goal "))
  if (policy.controller === "claude-goal") assert.ok([...candidate.prompt.slice(6)].length <= 4000)
  assert.ok(candidate.prompt.includes(`ARTIFACT: ${goal.artifact}\n`))
  assert.ok(candidate.prompt.includes(`TASK:\n${goal.task}\n`))
  for (const criterion of goal.criteria) assert.ok(candidate.prompt.includes(`- ${criterion}\n`))
  const transport = candidate.command.goalTransport
  assert.ok(transport)
  assert.equal(transport.controller, policy.controller)
  const manual = policy.controller === "codex-goal" || !selected.headless.prompt
  assert.equal(transport.mode, manual ? "manual" : "argv")
  if (transport.mode === "manual") {
    assert.equal(transport.commandInput.command, "/goal")
    assert.equal(transport.commandInput.body, candidate.prompt.slice(6))
    assert.equal(candidate.command.args.includes(candidate.prompt), false)
  } else assert.ok(candidate.command.args.includes(candidate.prompt))
}

const verifyGeneratedResponse = (context: JsonCaseContext, value: unknown): string => {
  const { entry, expectations, knownProfiles } = context
  const { profile, model, effort, workflow, originalIntent, goal } = expectations
  assert.ok(profile !== undefined && knownProfiles.has(profile), `${entry.id}: accepted unknown profile`)
  const response = value as GuideGenerationResponse
  assert.equal(response.profile.ref, profile)
  assert.equal(response.model, model ?? defaultGuideModelRouting.generate.model)
  assert.equal(response.effort, effort ?? defaultGuideModelRouting.generate.effort)
  if (workflow !== undefined) assert.equal(response.profile.workflowId, workflow)
  assert.equal(response.originalIntent, originalIntent)
  assert.equal(response.candidates.length, 3)
  assert.equal(new Set(response.candidates.map((candidate) => candidate.prompt)).size, 3)
  const [harness, selectedProfile] = profile.slice("native:".length).split("/")
  for (const candidate of response.candidates) {
    if (originalIntent !== undefined && goal === undefined)
      assert.ok(candidate.prompt.includes(originalIntent), `${entry.id}: original intent was removed`)
    assert.equal(candidate.command.executable, "trx")
    assert.deepEqual(candidate.command.args.slice(0, 3), ["run", harness, selectedProfile])
    if (goal !== undefined) assertGoalCandidate(context, response, candidate, profile)
  }
  return goal === undefined ? "generated" : "goal-generated"
}

const verifyMatchResponse = (context: JsonCaseContext, value: unknown): string => {
  const { fixture, expectations, world } = context
  const response = value as GuideMatchResponse
  assert.equal(Object.hasOwn(response, "originalIntent"), false)
  assert.equal(response.model, expectations.model ?? defaultGuideModelRouting.match.model)
  assert.equal(response.effort, expectations.effort ?? defaultGuideModelRouting.match.effort)
  assert.deepEqual(
    response.recommendations.map(({ ref, workflowId, confidence }) => ({
      profileRef: ref,
      workflowId,
      confidence,
    })),
    fixture.expectedMatches(),
  )
  if (expectations.goal !== undefined) {
    for (const recommendation of response.recommendations) {
      const selected = world.catalog.native.find(
        (entry) => `native:${entry.launcher}/${entry.name}` === recommendation.ref,
      )!
      assert.ok(selected.guide.goalExecution)
      assert.ok(selected.guide.goalExecution.workflowIds.includes(recommendation.workflowId))
      assert.equal(recommendation.goalExecution?.controller, selected.guide.goalExecution.controller)
    }
  }
  return expectations.goal === undefined ? "matched" : "goal-matched"
}

const verifyGuideJsonResponse = (context: JsonCaseContext, response: unknown): string => {
  const { entry, parsed, expectations } = context
  const rejectsInput =
    parsed.intent === undefined &&
    (expectations.input.rejected || (expectations.input.workflowId !== undefined && expectations.profile === undefined))
  assert.equal(rejectsInput, false, `${entry.id}: accepted invalid JSON stdin`)
  assert.equal(
    (response as GuideMatchResponse | GuideGenerationResponse).intent,
    parsed.intent ?? expectations.input.intent,
  )
  return expectations.profile === undefined
    ? verifyMatchResponse(context, response)
    : verifyGeneratedResponse(context, response)
}

export const verifyGuideJsonCase = async (options: {
  readonly world: GuideWorld
  readonly fixture: GuideFixture
  readonly entry: GuideCase
  readonly parsed: ParsedGuide
  readonly knownProfiles: ReadonlySet<string>
  readonly profileWorkflows: ReadonlyMap<string, ReadonlySet<string>>
  readonly ordinal: bigint
  readonly runGuideJsonCommand: typeof import("../../packages/trellage-launcher/src/guide-command.ts").runGuideJsonCommand
}): Promise<string> => {
  const { world, fixture, entry, parsed, knownProfiles, profileWorkflows, ordinal, runGuideJsonCommand } = options
  const expectations = expectedJsonValues(entry, parsed)
  const context = { world, fixture, entry, parsed, expectations, knownProfiles, profileWorkflows }
  return world.withCase(ordinal, async (cwd) => {
    fixture.configure({
      fallback: false,
      optimize: true,
      ...(expectations.goal === undefined ? {} : { goal: expectations.goal }),
    })
    const before = fixture.audit.snapshot()
    let response: unknown
    try {
      response = await runGuideJsonCommand({
        argv: entry.argv,
        catalog: world.catalog,
        guideRoot: world.guideRoot,
        promptMasterSkillDirectory: world.promptMasterSkillDirectory,
        cwd,
        stdinRequest: expectations.input.source,
        env: { HOME: world.root, TYPESAFE_API_KEY: "fixture-not-a-secret" },
      })
    } catch (error) {
      return handleGuideJsonError(context, error, before)
    }
    fixture.audit.assertClean()
    return verifyGuideJsonResponse(context, response)
  })
}
