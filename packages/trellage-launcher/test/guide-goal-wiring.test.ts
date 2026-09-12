import { describe, expect, it } from "vitest"
import { GuideAugmentKind } from "../src/guide-augment.ts"
import { enqueueGuideJob } from "../src/guide-batch.ts"
import { renderGuideGoalProposal, type GuideGoalRequest } from "../src/guide-goal-augment.ts"
import {
  augmentOptions,
  createInitialGuideUiState,
  GuideUiActionType,
  GuideUiStage,
  guideUiReducer,
  type GuideUiState,
} from "../src/guide-ui.tsx"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.ts"

const intent = "Explain the API retry policy."
const proposal = renderGuideGoalProposal(goalMeSkill, goalDraft)

const selectGoal = (state: GuideUiState): GuideUiState => {
  let next = guideUiReducer(state, { type: GuideUiActionType.PromptReviewOpen })
  next = guideUiReducer(next, { type: GuideUiActionType.AugmentOpen })
  for (let index = 0; index < augmentOptions.indexOf(GuideAugmentKind.GoalMe); index += 1) {
    next = guideUiReducer(next, { type: GuideUiActionType.AugmentMove, delta: 1 })
  }
  return guideUiReducer(next, { type: GuideUiActionType.AugmentConfirm })
}

const started = (): GuideUiState => selectGoal(createInitialGuideUiState(intent))

const reviewGoal = (state: GuideUiState) => {
  const request = { kind: "review" as const, runId: state.augmentJob?.runId ?? 0, requestId: 1, proposal }
  return {
    request,
    state: guideUiReducer(state, { type: GuideUiActionType.AugmentGoalRequest, runId: request.runId, request }),
  }
}

const approveGoal = (state: GuideUiState): GuideUiState => {
  const review = reviewGoal(state)
  return guideUiReducer(review.state, {
    type: GuideUiActionType.AugmentGoalTurn,
    runId: review.request.runId,
    turn: { request: review.request, response: { kind: "review", review: { decision: "use" } } },
  })
}

describe("Goal me augmentation wiring", () => {
  it("keeps automatic-answer permission for the interview and retry, but not a discarded or new run", () => {
    let state = started()
    expect(state.augmentJob?.goalAutoAcceptRecommended).toBe(false)
    const enable = { type: GuideUiActionType.AugmentGoalAutoAccept, runId: 1, enabled: true } as const
    state = guideUiReducer(state, enable)
    expect(state.augmentJob?.goalAutoAcceptRecommended).toBe(true)
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentBack })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentOpen })
    expect(state.augmentJob?.goalAutoAcceptRecommended).toBe(true)
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentFailed, runId: 1, message: "Retry this interview." })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentRetry })
    expect(state.augmentJob).toMatchObject({ runId: 2, goalAutoAcceptRecommended: true, goalApprovedPrompt: undefined })
    expect(guideUiReducer(state, { ...enable, enabled: false })).toBe(state)
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentDiscard })
    state = selectGoal(state)
    expect(state.augmentJob).toMatchObject({ runId: 3, goalAutoAcceptRecommended: false })
    expect(guideUiReducer(state, enable)).toBe(state)
  })

  it("rejects stale automation controls and never enables them over an answer editor or final review", () => {
    const request: GuideGoalRequest = {
      kind: "question", runId: 1, requestId: 2,
      question: { question: "Which artifact?", choices: ["Design (Recommended)"], allowFreeform: true },
    }
    const state = guideUiReducer(started(), { type: GuideUiActionType.AugmentGoalRequest, runId: 1, request })
    const enable = { type: GuideUiActionType.AugmentGoalAutoAccept, runId: 1, requestId: 2, enabled: true } as const
    expect(guideUiReducer(state, { ...enable, requestId: 1 })).toBe(state)
    const editing = guideUiReducer(state, {
      type: GuideUiActionType.AugmentGoalPanel, runId: 1, requestId: 2, action: { type: "edit" },
    })
    expect(guideUiReducer(editing, enable)).toBe(editing)
    const reviewed = reviewGoal(started()).state
    expect(guideUiReducer(reviewed, { ...enable, requestId: 1 })).toBe(reviewed)
    expect(reviewed.augmentJob?.goalApprovedPrompt).toBeUndefined()
  })

  it("keeps prompt viewing and menu selection separate from starting the interview", () => {
    const viewing = guideUiReducer(createInitialGuideUiState(intent), { type: GuideUiActionType.PromptReviewOpen })
    expect(viewing).toMatchObject({ stage: GuideUiStage.PromptReview, textDraft: intent, augmentJob: undefined })
    const menu = guideUiReducer(viewing, { type: GuideUiActionType.AugmentOpen })
    expect(menu).toMatchObject({ stage: GuideUiStage.Augment, textDraft: intent, augmentJob: undefined })
    expect(guideUiReducer(menu, { type: GuideUiActionType.AugmentBack }).stage).toBe(GuideUiStage.PromptReview)
    expect(started()).toMatchObject({
      stage: GuideUiStage.Augmenting,
      textDraft: intent,
      augmentJob: { kind: GuideAugmentKind.GoalMe, status: "running", source: intent },
    })
  })

  it("does not apply a provider result without explicit approval of that exact prompt", () => {
    const unapproved = guideUiReducer(started(), {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    expect(unapproved.textDraft).toBe(intent)
    expect(unapproved.augmentJob?.status).toBe("failed")
    const approved = approveGoal(started())
    const mismatched = guideUiReducer(approved, {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: `${proposal.prompt}\nChanged after review.`,
    })
    expect(mismatched.textDraft).toBe(intent)
    expect(mismatched.augmentJob?.status).toBe("failed")
    const applied = guideUiReducer(approved, {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    expect(applied).toMatchObject({
      stage: GuideUiStage.PromptReview, textDraft: proposal.prompt, augmentJob: undefined,
      goal: { draft: goalDraft, prompt: proposal.prompt },
    })
    const matching = guideUiReducer(applied, { type: GuideUiActionType.PromptReviewBack })
    expect(matching).toMatchObject({
      stage: GuideUiStage.Matching, intent: proposal.prompt,
      goal: applied.goal,
      matchedGoalFingerprint: applied.goal?.fingerprint,
    })
  })

  it("rematches identical visible text when it gains approved goal provenance", () => {
    const plain = { ...createInitialGuideUiState(proposal.prompt), stage: GuideUiStage.Recommendations }
    const approved = approveGoal(selectGoal(plain))
    const applied = guideUiReducer(approved, { type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt })
    expect(applied.intent).toBe(proposal.prompt)
    expect(applied.goal?.draft).toEqual(goalDraft)
    expect(guideUiReducer(applied, { type: GuideUiActionType.PromptReviewSubmit }).stage).toBe(GuideUiStage.Matching)
  })

  it("rematches a new approval revision even when the goal content is identical", () => {
    const first = guideUiReducer(approveGoal(started()), {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    const matching = guideUiReducer(first, { type: GuideUiActionType.PromptReviewSubmit })
    const next = approveGoal(selectGoal({ ...matching, stage: GuideUiStage.Recommendations }))
    const reapplied = guideUiReducer(next, {
      type: GuideUiActionType.AugmentSucceeded, runId: 2, text: proposal.prompt,
    })
    expect(reapplied.goal?.fingerprint).toBe(first.goal?.fingerprint)
    expect(reapplied.goalRevision).toBe(first.goalRevision + 1)
    expect(guideUiReducer(reapplied, { type: GuideUiActionType.PromptReviewSubmit }).stage).toBe(GuideUiStage.Matching)
  })

  it("requires an explicit decision after editing an approved goal", () => {
    let state = guideUiReducer(approveGoal(started()), {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    const goal = state.goal
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewEdit, editing: true })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewChange, text: "A changed task." })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewSubmit })
    expect(state).toMatchObject({ stage: GuideUiStage.GoalChange, goal, textDraft: "A changed task." })
    const kept = guideUiReducer(state, { type: GuideUiActionType.GoalChangeKeep })
    expect(kept).toMatchObject({ stage: GuideUiStage.PromptReview, goal, textDraft: proposal.prompt })
    const detached = guideUiReducer(state, { type: GuideUiActionType.GoalChangeDetach })
    expect(detached).toMatchObject({ stage: GuideUiStage.Matching, goal: undefined, intent: "A changed task." })
    const revision = guideUiReducer(state, { type: GuideUiActionType.GoalChangeRevise })
    expect(revision).toMatchObject({
      stage: GuideUiStage.Augmenting,
      goal,
      augmentJob: { kind: GuideAugmentKind.GoalMe, source: "A changed task.", runId: 2, goalApprovedPrompt: undefined },
    })
  })

  it("keeps goal provenance for cancelled edits and unchanged prompt submissions", () => {
    const applied = guideUiReducer(approveGoal(started()), {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    const matched = guideUiReducer(applied, { type: GuideUiActionType.PromptReviewSubmit })
    const viewing = guideUiReducer({ ...matched, stage: GuideUiStage.Recommendations }, { type: GuideUiActionType.PromptReviewOpen })
    const editing = guideUiReducer(viewing, { type: GuideUiActionType.PromptReviewEdit, editing: true })
    const changed = guideUiReducer(editing, { type: GuideUiActionType.PromptReviewChange, text: "Unsubmitted changes." })
    const cancelled = guideUiReducer(changed, { type: GuideUiActionType.PromptReviewBack })
    expect(cancelled.goal).toBe(matched.goal)
    expect(cancelled.textDraft).toBe(proposal.prompt)
    const unchanged = guideUiReducer(cancelled, { type: GuideUiActionType.PromptReviewSubmit })
    expect(unchanged.goal).toBe(matched.goal)
    expect(unchanged.stage).toBe(GuideUiStage.Recommendations)
  })

  it("does not silently keep stale goal fields when another augmenter replaces the prompt", () => {
    let state = guideUiReducer(approveGoal(started()), {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    const goal = state.goal
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentOpen })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentConfirm })
    expect(state.augmentJob?.kind).toBe(GuideAugmentKind.Research)
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentSucceeded, runId: 2, text: "New research evidence." })
    expect(state).toMatchObject({
      stage: GuideUiStage.GoalChange,
      goal,
      goalChange: { kind: "prompt", text: "New research evidence." },
      augmentJob: undefined,
    })
    expect(guideUiReducer(state, { type: GuideUiActionType.GoalChangeKeep }).textDraft).toBe(proposal.prompt)
  })

  it("parks a pending interaction without resetting its editor or active run", () => {
    const { request, state } = reviewGoal(started())
    const edited = guideUiReducer(state, {
      type: GuideUiActionType.AugmentGoalPanel, runId: 1, requestId: 1,
      action: { type: "error", message: "Keep this panel state." },
    })
    const parked = guideUiReducer(edited, { type: GuideUiActionType.AugmentBack })
    expect(parked.stage).toBe(GuideUiStage.PromptReview)
    expect(parked.augmentJob).toBe(edited.augmentJob)
    const reopened = guideUiReducer(parked, { type: GuideUiActionType.AugmentOpen })
    expect(reopened.augmentJob?.goalPanel).toBe(edited.augmentJob?.goalPanel)
    expect(guideUiReducer(reopened, {
      type: GuideUiActionType.AugmentGoalRequest, runId: 1, request,
    })).toBe(reopened)
  })

  it("requires a second replacement decision when the source prompt changed", () => {
    let state = approveGoal(started())
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentBack })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewEdit, editing: true })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewChange, text: "A newer request." })
    const editing = guideUiReducer(state, {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    expect(editing.textDraft).toBe("A newer request.")
    expect(editing.augmentJob?.status).toBe("ready")
    const committed = guideUiReducer(state, { type: GuideUiActionType.PromptReviewSubmit })
    const ready = guideUiReducer(committed, {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    expect(ready.intent).toBe("A newer request.")
    expect(ready.augmentJob?.status).toBe("ready")
    const watching = guideUiReducer(ready, { type: GuideUiActionType.AugmentOpen })
    expect(guideUiReducer(watching, { type: GuideUiActionType.AugmentApply }).textDraft).toBe(proposal.prompt)
  })

  it("never reuses discarded run IDs, including after re-matching", () => {
    const first = reviewGoal(started())
    let state = guideUiReducer(first.state, { type: GuideUiActionType.AugmentDiscard })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewEdit, editing: true })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewChange, text: "A newer request." })
    state = guideUiReducer(state, { type: GuideUiActionType.PromptReviewSubmit })
    state = selectGoal(state)
    expect(state.augmentJob?.runId).toBe(2)
    expect(guideUiReducer(state, {
      type: GuideUiActionType.AugmentGoalRequest, runId: 1, request: first.request,
    })).toBe(state)
    expect(guideUiReducer(state, {
      type: GuideUiActionType.AugmentDiscard, runId: 1,
    })).toBe(state)
    const second = reviewGoal(state)
    expect(guideUiReducer(second.state, {
      type: GuideUiActionType.AugmentGoalTurn, runId: 2,
      turn: { request: first.request, response: { kind: "review", review: { decision: "use" } } },
    })).toBe(second.state)
  })

  it("does not interrupt a queued launch when approval cleanup finishes in the background", () => {
    const launching = { ...approveGoal(started()), stage: GuideUiStage.Launching }
    const settled = guideUiReducer(launching, {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    expect(settled.stage).toBe(GuideUiStage.Launching)
    expect(settled.queue).toBe(launching.queue)
    expect(settled.augmentJob?.status).toBe("ready")
    expect(settled.textDraft).toBe(intent)
  })

  it("preserves an unsaved queued-prompt edit while an approved goal finishes", () => {
    const approved = approveGoal(started())
    const queue = enqueueGuideJob(approved.queue, {
      surface: "native", launcher: "cpx", profile: "default", commandPath: "/fake/cpx", headlessPrompt: true,
    }, "Previously queued prompt.", { kind: "current-workspace-pane", direction: "right" })
    let state = guideUiReducer({ ...approved, queue }, { type: GuideUiActionType.AugmentBack })
    state = guideUiReducer(state, { type: GuideUiActionType.CandidatesViewQueue })
    state = guideUiReducer(state, { type: GuideUiActionType.QueueEditStart })
    state = guideUiReducer(state, { type: GuideUiActionType.EditorChange, text: "An unsaved queue edit." })
    expect(state.activeForkId).toBeUndefined()
    state = guideUiReducer(state, {
      type: GuideUiActionType.AugmentSucceeded, runId: 1, text: proposal.prompt,
    })
    expect(state.stage).toBe(GuideUiStage.QueuePromptEditor)
    expect(state.textDraft).toBe("An unsaved queue edit.")
    expect(state.queue.entries[0]?.prompt).toBe("Previously queued prompt.")
    expect(state.augmentJob?.status).toBe("ready")
    state = guideUiReducer(state, { type: GuideUiActionType.QueueEditSubmit })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentOpen })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentApply })
    expect(state.textDraft).toBe(proposal.prompt)
    expect(state.queue.entries[0]?.prompt).toBe("An unsaved queue edit.")
  })

  it("retains committed answers and the last draft on explicit retry, but clears approval", () => {
    const request: GuideGoalRequest = {
      kind: "question", runId: 1, requestId: 1,
      question: { question: "Which artifact?", choices: ["Design"], allowFreeform: true },
    }
    let state = guideUiReducer(started(), { type: GuideUiActionType.AugmentGoalRequest, runId: 1, request })
    state = guideUiReducer(state, {
      type: GuideUiActionType.AugmentGoalTurn, runId: 1,
      turn: { request, response: { kind: "answer", answer: { answer: "Design", wasFreeform: false } } },
    })
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentGoalRequest, runId: 1, request: undefined })
    state = approveGoal(state)
    const failed = guideUiReducer(state, {
      type: GuideUiActionType.AugmentFailed, runId: 1, message: "Connection failed.",
    })
    const retried = guideUiReducer(failed, { type: GuideUiActionType.AugmentRetry })
    expect(retried.augmentJob).toMatchObject({
      runId: 2, source: intent, status: "running", goalLastProposal: proposal, goalApprovedPrompt: undefined,
    })
    expect(retried.augmentJob?.goalHistory).toBe(failed.augmentJob?.goalHistory)
    expect(retried.augmentJob?.goalHistory).toHaveLength(2)
    expect(guideUiReducer(retried, { type: GuideUiActionType.AugmentDiscard }).augmentJob).toBeUndefined()
  })
})
