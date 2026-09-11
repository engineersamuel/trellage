import type { ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { GuideGoalError } from "./guide-goal-augment.js"
import {
  assertGuideGoalCandidate,
  composeGuideGoalCandidate,
  guideGoalApproachBudget,
  guideGoalCandidateBody,
  resolveGuideGoalExecution,
  type GuideGoalCandidate,
  type GuideGoalExecution,
  type PreparedGuideGoal,
} from "./guide-goal-execution.js"
import type { GuideArtifactCache } from "./guide-match-cache.js"
import {
  assertGuideGenerateInput,
  validateGuideGenerateResult,
  validateGuideOptimizeResult,
  validateGuideRefineResult,
  type GuideGenerateCandidate,
  type GuideGenerateInput,
  type GuideGenerateResult,
  type GuideProvider,
  type GuideRefineInput,
  type GuideRefineResult,
} from "./guide-provider.js"
import { text } from "./guide-text.js"
import {
  GuideCandidatePromptStage,
  requireDistinctGuideCandidatePrompts,
  resolveGeneratedWorkflowBodyCandidate,
  resolveRefinedWorkflowBodyCandidate,
  resolveWorkflowBodyCandidate,
  workflowPromptFrame,
  type GuideCandidatePromptTriple,
} from "./guide-workflow-prompt.js"

export interface GuideGoalGenerationInput extends GuideGenerateInput {
  readonly goal: PreparedGuideGoal
  readonly targetTool: string
}

export interface GuideGoalRefinementInput extends GuideRefineInput {
  readonly goal: PreparedGuideGoal
  readonly targetTool: string
  readonly candidates?: ReadonlyArray<GuideGenerateCandidate>
  readonly candidateIndex?: number
}

export interface GuideGoalPipelineOptions {
  readonly cache?: GuideArtifactCache
  readonly onPhase?: (phase: "generate" | "refine" | "optimize") => void
}

export interface GuideGoalGenerationResult extends GuideGenerateResult {
  readonly candidates: GuideCandidatePromptTriple<GuideGoalCandidate>
}

export interface GuideGoalRefinementResult extends GuideRefineResult {
  readonly candidate: GuideGoalCandidate
}

const candidateTriple = <Candidate extends GuideGenerateCandidate>(
  candidates: ReadonlyArray<Candidate>,
): GuideCandidatePromptTriple<Candidate> => {
  const [first, second, third] = candidates
  if (candidates.length !== 3 || first === undefined || second === undefined || third === undefined) {
    throw new GuideGoalError("Goal generation must return exactly three approach candidates.")
  }
  return [first, second, third]
}

const modelInput = (input: GuideGoalGenerationInput): GuideGenerateInput => ({
  intent: input.intent,
  profileRef: input.profileRef,
  workflowId: input.workflowId,
  guide: input.guide,
  guideBody: input.guideBody,
  goal: input.goal,
})

const generationBodies = (
  input: GuideGoalGenerationInput,
  execution: GuideGoalExecution,
  result: GuideGenerateResult,
): GuideCandidatePromptTriple<GuideGenerateCandidate> => {
  const validated = validateGuideGenerateResult(result)
  const normalized = validated.candidates.map((candidate) =>
    resolveGeneratedWorkflowBodyCandidate(input.guide, execution.workflow, "", candidate, { bodyOnly: true }),
  )
  return requireDistinctGuideCandidatePrompts(
    candidateTriple(validateGuideGenerateResult({ candidates: normalized }, execution).candidates),
    GuideCandidatePromptStage.GeneratedBodyNormalization,
  )
}

const composeCandidates = (
  execution: GuideGoalExecution,
  candidates: ReadonlyArray<GuideGenerateCandidate>,
): GuideGoalGenerationResult => ({
  candidates: requireDistinctGuideCandidatePrompts(
    candidateTriple(candidates.map((candidate) => composeGuideGoalCandidate(execution, candidate))),
    GuideCandidatePromptStage.FinalRendering,
  ),
})

/** Models and cache artifacts carry approaches only; the host owns the goal and workflow frame. */
export const runGuideGoalGeneration = async (
  provider: GuideProvider,
  input: GuideGoalGenerationInput,
  options: GuideGoalPipelineOptions = {},
): Promise<GuideGoalGenerationResult> => {
  assertGuideGenerateInput(input)
  const execution = resolveGuideGoalExecution(input.goal, input.guide, input.workflowId)
  const fixedFrame = workflowPromptFrame(execution.workflow)
  const produce = async (): Promise<GuideGenerateResult> => {
    options.onPhase?.("generate")
    const bodies = generationBodies(input, execution, await provider.generate(modelInput(input)))
    options.onPhase?.("optimize")
    const optimized = validateGuideOptimizeResult(
      await provider.optimize({
        targetTool: input.targetTool,
        profileRef: input.profileRef,
        candidates: bodies,
        fixedFrame,
        goal: input.goal,
        goalExecution: execution,
      }),
      3,
    )
    const proposed = candidateTriple(optimized.candidates)
    const candidates = bodies.map((body, index) => {
      const candidate = proposed[index]
      if (candidate === undefined) throw new GuideGoalError("Prompt Master omitted a goal approach.")
      return resolveWorkflowBodyCandidate(input.guide, execution.workflow, body, candidate, { bodyOnly: true })
    })
    const result = { candidates: generationBodies(input, execution, { candidates }) }
    composeCandidates(execution, result.candidates)
    return result
  }
  const result = await (options.cache === undefined
    ? produce()
    : options.cache.generation({ ...input, fixedFrame, goalExecution: execution }, produce))
  return composeCandidates(execution, generationBodies(input, execution, result))
}

const assertCurrentGoalCandidate = (
  candidate: GuideGenerateCandidate,
  execution: GuideGoalExecution,
): GuideGoalCandidate => {
  const context = candidate.goalExecution
  if (context === undefined) throw new GuideGoalError("Goal refinement requires a composed goal candidate.")
  const goalCandidate = { ...candidate, goalExecution: context }
  assertGuideGoalCandidate(goalCandidate)
  if (
    context.goal.fingerprint !== execution.goal.fingerprint ||
    context.controller !== execution.controller ||
    JSON.stringify(context.workflow) !== JSON.stringify(execution.workflow)
  ) {
    throw new GuideGoalError("The candidate belongs to a different goal or workflow. Keep its original selection.")
  }
  return goalCandidate
}

const refinementSelection = (
  input: GuideGoalRefinementInput,
  execution: GuideGoalExecution,
): { readonly candidates: ReadonlyArray<GuideGenerateCandidate>; readonly candidateIndex: number } => {
  if (input.candidates === undefined && input.candidateIndex === undefined) {
    return { candidates: [assertCurrentGoalCandidate(input.candidate, execution)], candidateIndex: 0 }
  }
  if (input.candidates === undefined || input.candidateIndex === undefined) {
    throw new GuideGoalError("Supply both the goal candidate set and its selected index.")
  }
  const candidates = candidateTriple(input.candidates).map((candidate) => assertCurrentGoalCandidate(candidate, execution))
  const selected = candidates[input.candidateIndex]
  if (
    !Number.isInteger(input.candidateIndex) ||
    selected === undefined ||
    selected.prompt !== input.candidate.prompt ||
    selected.title !== input.candidate.title ||
    selected.notes !== input.candidate.notes
  ) {
    throw new GuideGoalError("The selected goal candidate does not match its candidate index.")
  }
  return { candidates, candidateIndex: input.candidateIndex }
}

/** Refines the stored approach, never the expanded protected goal prompt. */
export const runGuideGoalRefinement = async (
  provider: GuideProvider,
  input: GuideGoalRefinementInput,
  options: GuideGoalPipelineOptions = {},
): Promise<GuideGoalRefinementResult> => {
  assertGuideGenerateInput(input)
  const execution = resolveGuideGoalExecution(input.goal, input.guide, input.workflowId)
  const candidate = assertCurrentGoalCandidate(input.candidate, execution)
  const selection = refinementSelection(input, execution)
  const body = guideGoalCandidateBody(candidate)
  const fixedFrame = workflowPromptFrame(execution.workflow)
  const feedback = text(input.feedback, "goal refinement feedback", 8000, { multiline: true })
  const refineBody = (result: GuideRefineResult): GuideGenerateCandidate => {
    const validated = validateGuideRefineResult(result)
    const normalized = resolveRefinedWorkflowBodyCandidate(
      input.guide,
      execution.workflow,
      body,
      validated.candidate,
      { bodyOnly: true },
    )
    return validateGuideRefineResult({ candidate: normalized }, execution).candidate
  }
  const compose = (approach: GuideGenerateCandidate): GuideGoalRefinementResult => {
    const composed = composeGuideGoalCandidate(execution, approach)
    if (selection.candidates.length === 3) {
      requireDistinctGuideCandidatePrompts(
        candidateTriple(selection.candidates.map((prior, index) => index === selection.candidateIndex ? composed : prior)),
        GuideCandidatePromptStage.FinalRendering,
      )
    }
    return { candidate: composed }
  }
  const produce = async (): Promise<GuideRefineResult> => {
    options.onPhase?.("refine")
    const refined = refineBody(await provider.refine({ ...modelInput(input), candidate: body, feedback }))
    options.onPhase?.("optimize")
    const optimized = validateGuideOptimizeResult(
      await provider.optimize({
        targetTool: input.targetTool,
        profileRef: input.profileRef,
        candidates: [refined],
        fixedFrame,
        goal: input.goal,
        goalExecution: execution,
      }),
      1,
    )
    const proposed = optimized.candidates[0]
    if (proposed === undefined) throw new GuideGoalError("Prompt Master omitted the refined goal approach.")
    const safe = resolveWorkflowBodyCandidate(input.guide, execution.workflow, refined, proposed, { bodyOnly: true })
    const result = { candidate: refineBody({ candidate: safe }) }
    compose(result.candidate)
    return result
  }
  const result = await (options.cache === undefined
    ? produce()
    : options.cache.refinement(
        {
          ...input,
          fixedFrame,
          goalExecution: execution,
          candidates: selection.candidates.map(guideGoalCandidateBody),
          candidateIndex: selection.candidateIndex,
          feedback,
        },
        produce,
      ))
  return compose(refineBody(result))
}

export const templateGuideGoalCandidates = (
  guide: ProfileGuideV1,
  workflowId: string,
  goal: PreparedGuideGoal,
): GuideCandidatePromptTriple<GuideGoalCandidate> => {
  const execution = resolveGuideGoalExecution(goal, guide, workflowId)
  const budget = guideGoalApproachBudget(execution)
  const alternatives = [
    [
      "Implement the smallest complete change, then collect evidence for every approved criterion.",
      "Inspect the current behavior and dependencies first, then implement and verify the approved objective.",
      "Start with observable criterion evidence, address the weakest result, then verify the complete artifact.",
    ],
    ["Implement the goal.", "Inspect before changing.", "Start with criterion evidence."],
    ["Implement.", "Inspect.", "Verify."],
  ] as const
  const approaches = alternatives.find((items) => items.every((approach) => [...approach].length <= budget))
  if (approaches === undefined) {
    throw new GuideGoalError("The goal leaves too little space for template approaches. Choose another goal controller.")
  }
  const labels = ["Direct", "Inspect first", "Evidence first"] as const
  return composeCandidates(
    execution,
    ([0, 1, 2] as const).map((index) => resolveGeneratedWorkflowBodyCandidate(
      guide,
      execution.workflow,
      "",
      {
        title: labels[index],
        prompt: approaches[index],
        notes: "Uses the approved goal and the exact authored workflow without a model call.",
      },
      { bodyOnly: true },
    )),
  ).candidates
}
