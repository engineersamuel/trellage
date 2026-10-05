import { describe, expect, it } from "vitest"
import { renderGuideGoalProposal } from "../src/guide-goal-augment.ts"
import { prepareGuideGoal } from "../src/guide-goal-execution.ts"
import { createInitialGuideUiState, guideUiReducer, GuideUiActionType, GuideUiStage } from "../src/guide-ui.tsx"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.ts"

const recommendations = (intent = "Keep the current request.") =>
  guideUiReducer(createInitialGuideUiState(intent), { type: GuideUiActionType.MatchSucceeded, recommendations: [] })

describe("Optimize change-flow isolation", () => {
  it("opens and returns without replacing, rematching, or detaching the current goal", () => {
    const goal = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, goalDraft))
    const state = { ...recommendations(goal.prompt), goal, matchedGoalFingerprint: goal.fingerprint }
    const opened = guideUiReducer(state, { type: GuideUiActionType.OptimizeOpen })
    expect(opened).toMatchObject({
      stage: GuideUiStage.Optimize,
      intent: goal.prompt,
      originalIntent: goal.prompt,
      goal,
    })
    expect(opened.queue).toBe(state.queue)
    expect(opened.forks).toBe(state.forks)
    const returned = guideUiReducer(opened, { type: GuideUiActionType.OptimizeBack })
    expect(returned).toEqual(state)
  })

  it("does not treat Optimize actions as shortcuts in the intent editor", () => {
    const state = createInitialGuideUiState()
    expect(guideUiReducer(state, { type: GuideUiActionType.OptimizeOpen })).toBe(state)
    expect(guideUiReducer(state, { type: GuideUiActionType.OptimizeBack })).toBe(state)
  })

  it("keeps a background augmentation pending instead of replacing the optimization context", () => {
    let state = guideUiReducer(recommendations(), { type: GuideUiActionType.PromptReviewOpen })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentOpen })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentConfirm })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewBack })
    state = guideUiReducer(state, { type: GuideUiActionType.OptimizeOpen })
    const settled = guideUiReducer(state, {
      type: GuideUiActionType.AugmentSucceeded,
      runId: 1,
      text: "Completed research.",
    })
    expect(settled).toMatchObject({
      stage: GuideUiStage.Optimize,
      intent: state.intent,
      originalIntent: state.originalIntent,
      augmentJob: { status: "ready", text: "Completed research." },
    })
    const returned = guideUiReducer(settled, { type: GuideUiActionType.OptimizeBack })
    expect(returned.augmentJob).toBe(settled.augmentJob)
    expect(guideUiReducer(returned, { type: GuideUiActionType.AugmentApply })).toMatchObject({
      stage: GuideUiStage.PromptReview,
      textDraft: "Completed research.",
      augmentJob: undefined,
    })
  })
})
