import { describe, expect, it } from "vitest"
import type { ProfileGuideWorkflow } from "@trellage/guide-core"
import {
  createGuideCustomerPanel,
  customerFieldMaximum,
  customerPromptProjection,
  customerQuestions,
  customerUnknown,
  guideCustomerPanelReducer,
  reviewedCustomerContext,
  renderCustomerContext,
  parseApprovedCustomerContext,
} from "../src/guide-customer-context.ts"
import { completeSinglePromptArtifact, guideModelBodyCandidate, guidePromptBodyBudget } from "../src/guide-context.ts"
import {
  augmentOptions,
  createInitialGuideUiState,
  guideUiReducer,
  GuideUiActionType,
  GuideUiStage,
  type GuideUiState,
} from "../src/guide-ui.tsx"
import { GuideAugmentKind } from "../src/guide-augment.ts"
import { prepareGuideGoal } from "../src/guide-goal-execution.ts"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.ts"
import { renderGuideGoalProposal } from "../src/guide-goal-augment.ts"

const answerAll = (values: ReadonlyArray<string> = []) => {
  let panel = createGuideCustomerPanel()
  for (const [index] of customerQuestions.entries()) {
    panel = guideCustomerPanelReducer(panel, { type: "append", text: values[index] ?? "" })
    panel = guideCustomerPanelReducer(panel, { type: "next" })
  }
  return panel
}

const start = (source = "Build a support chatbot.", initial?: GuideUiState): GuideUiState => {
  let state = initial ?? createInitialGuideUiState()
  state = guideUiReducer(state, { type: GuideUiActionType.IntentChange, text: source })
  state = guideUiReducer(state, { type: GuideUiActionType.AugmentOpen })
  for (let index = 0; index < augmentOptions.indexOf(GuideAugmentKind.CustomerContext); index++) {
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentMove, delta: 1 })
  }
  return guideUiReducer(state, { type: GuideUiActionType.AugmentConfirm })
}

const finishQuestions = (initial: GuideUiState): GuideUiState => {
  let state = initial
  const runId = state.augmentJob!.runId
  for (const _ of customerQuestions) {
    state = guideUiReducer(state, { type: GuideUiActionType.AugmentCustomerPanel, runId, action: { type: "next" } })
  }
  return state
}

describe("local customer preparation", () => {
  it("keeps missing facts unknown and preserves supplied source vocabulary exactly", () => {
    const context = reviewedCustomerContext(
      answerAll([
        "Support staff report repeat work.",
        "",
        "Reported: note-12@r3; sponsor says fast, user observation says slow.",
        "Scope approved by sponsor in decision-4. User need not validated.",
      ]),
    )
    expect(context.fields.outcome).toBe(customerUnknown)
    expect(context.fields.evidence).toContain("Reported: note-12@r3")
    expect(context.fields.evidence).toContain("user observation says slow")
    expect(context.approval).toBe("guide-context-only")
    expect(() => parseApprovedCustomerContext({ ...context, approval: "customer-approved" })).toThrow(
      "requires explicit Guide-context approval",
    )
    expect(() => reviewedCustomerContext(createGuideCustomerPanel())).toThrow("Review")
  })

  it("rejects oversize or control-character paste without truncating the answer", () => {
    const panel = guideCustomerPanelReducer(createGuideCustomerPanel(), { type: "append", text: "Source" })
    for (const text of ["x".repeat(customerFieldMaximum), "\u001b[31m"]) {
      const result = guideCustomerPanelReducer(panel, { type: "append", text })
      expect(result.draft).toBe("Source")
      expect(result.error).toBeDefined()
    }
    const emoji = guideCustomerPanelReducer(panel, { type: "append", text: "👩🏽‍💻" })
    expect(guideCustomerPanelReducer(emoji, { type: "backspace" }).draft).toBe("Source")
  })

  it("keeps the draft local and unchanged until explicit review approval, with pause and discard", () => {
    const running = start()
    expect(running.stage).toBe(GuideUiStage.Augmenting)
    const runId = running.augmentJob!.runId
    expect(guideUiReducer(running, { type: GuideUiActionType.AugmentSucceeded, runId, text: "Fabricated" })).toBe(
      running,
    )
    expect(guideUiReducer(running, { type: GuideUiActionType.AugmentCustomerApprove, runId })).toBe(running)
    const review = finishQuestions(running)
    expect(review.textDraft).toBe("Build a support chatbot.")
    expect(review.customerContext).toBeUndefined()
    const parked = guideUiReducer(review, { type: GuideUiActionType.AugmentBack })
    expect(parked.stage).toBe(GuideUiStage.Intent)
    expect(parked.augmentJob?.customerPanel?.reviewing).toBe(true)
    const resumed = guideUiReducer(parked, { type: GuideUiActionType.AugmentOpen })
    const applied = guideUiReducer(resumed, { type: GuideUiActionType.AugmentCustomerApprove, runId })
    expect(applied.originalIntent).toBe("Build a support chatbot.")
    expect(applied.customerContext?.fields.outcome).toBe(customerUnknown)
    expect(applied.textDraft).toContain("not customer signoff")
    expect(applied.augmentJob).toBeUndefined()
    const discarded = guideUiReducer(review, { type: GuideUiActionType.AugmentDiscard, runId })
    expect(discarded.textDraft).toBe("Build a support chatbot.")
    expect(discarded.customerContext).toBeUndefined()
  })

  it("rejects approval against a changed source, stale run, or active approved goal", () => {
    const review = finishQuestions(start())
    const runId = review.augmentJob!.runId
    expect(guideUiReducer(review, { type: GuideUiActionType.AugmentCustomerApprove, runId: runId + 1 })).toBe(review)
    const changed = { ...review, textDraft: "Different scope" }
    const rejected = guideUiReducer(changed, { type: GuideUiActionType.AugmentCustomerApprove, runId })
    expect(rejected.textDraft).toBe("Different scope")
    expect(rejected.augmentJob?.customerPanel?.error).toContain("request changed")
    const goal = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, goalDraft))
    const withGoal = { ...review, goal }
    const blocked = guideUiReducer(withGoal, { type: GuideUiActionType.AugmentCustomerApprove, runId })
    expect(blocked.goal).toBe(goal)
    expect(blocked.customerContext).toBeUndefined()
    expect(blocked.augmentJob?.customerPanel?.error).toContain("approved goal")
  })

  it("replaces the prior brief rather than compounding it and keeps code fences inside JSON", () => {
    const first = reviewedCustomerContext(answerAll())
    const next = reviewedCustomerContext(answerAll(["Need with ``` markers"]))
    const projected = customerPromptProjection(customerPromptProjection("Original", first), next, first)
    expect(projected.match(/## Customer context/g)).toHaveLength(1)
    expect(renderCustomerContext(next)).toContain("\\u0060\\u0060\\u0060")
    expect(next.fields.problem).toBe("Need with ``` markers")
  })

  it("retains context when prompt-review edits are cancelled, but clears it on an explicit source edit", () => {
    const review = finishQuestions(start())
    const approved = guideUiReducer(review, {
      type: GuideUiActionType.AugmentCustomerApprove,
      runId: review.augmentJob!.runId,
    })
    const matching = guideUiReducer(approved, { type: GuideUiActionType.IntentSubmit })
    const opened = guideUiReducer(matching, { type: GuideUiActionType.PromptReviewOpen })
    const editing = guideUiReducer(opened, { type: GuideUiActionType.PromptReviewEdit, editing: true })
    const changed = guideUiReducer(editing, {
      type: GuideUiActionType.PromptReviewChange,
      text: "A different request.",
    })
    const cancelled = guideUiReducer(changed, { type: GuideUiActionType.PromptReviewBack })
    expect(cancelled.customerContext).toEqual(approved.customerContext)
    expect(cancelled.textDraft).toBe(approved.textDraft)
    const submitted = guideUiReducer(changed, { type: GuideUiActionType.PromptReviewSubmit })
    expect(submitted.intent).toBe("A different request.")
    expect(submitted.customerContext).toBeUndefined()
  })

  it("does not silently convert an approved customer brief into an execution goal", () => {
    const review = finishQuestions(start())
    const approved = guideUiReducer(review, {
      type: GuideUiActionType.AugmentCustomerApprove,
      runId: review.augmentJob!.runId,
    })
    let chooser = guideUiReducer(approved, { type: GuideUiActionType.AugmentOpen })
    for (let index = 0; index < augmentOptions.indexOf(GuideAugmentKind.GoalMe); index++) {
      chooser = guideUiReducer(chooser, { type: GuideUiActionType.AugmentMove, delta: 1 })
    }
    const blocked = guideUiReducer(chooser, { type: GuideUiActionType.AugmentConfirm })
    expect(blocked.augmentJob).toBeUndefined()
    expect(blocked.customerContext).toBe(approved.customerContext)
    expect(blocked.errorMessage).toContain("not an execution goal")
  })

  it("restores the complete approved context after model rewriting within the real prompt budget", () => {
    const customerContext = reviewedCustomerContext(answerAll(["Unvalidated need", "", "Reported: note-1"]))
    const context = { originalIntent: "Original request", customerContext }
    const workflow: ProfileGuideWorkflow = {
      id: "test",
      description: "Test",
      frame: "fixed",
      examples: ["One", "Two"],
      promptTemplate: "Bounded workflow.\n{{intent}}",
    }
    const candidate = { title: "Approach", prompt: "Bounded workflow.\nAsk about evidence.", notes: "" }
    const complete = completeSinglePromptArtifact(workflow, candidate, context)
    expect(complete.prompt).toContain(renderCustomerContext(customerContext))
    expect(complete.prompt).toContain("Original request")
    expect(completeSinglePromptArtifact(workflow, complete, context)).toEqual(complete)
    expect(guideModelBodyCandidate(workflow, complete, context).prompt).toBe("Ask about evidence.")
    const budget = guidePromptBodyBudget(workflow, context)
    expect(
      completeSinglePromptArtifact(
        workflow,
        { ...candidate, prompt: `Bounded workflow.\n${"x".repeat(budget)}` },
        context,
      ).prompt.length,
    ).toBe(8000)
    expect(() =>
      completeSinglePromptArtifact(
        workflow,
        { ...candidate, prompt: `Bounded workflow.\n${"x".repeat(budget + 1)}` },
        context,
      ),
    ).toThrow(/8000/u)
  })
})
