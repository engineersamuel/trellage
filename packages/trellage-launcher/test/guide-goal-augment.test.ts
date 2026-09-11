import { describe, expect, it } from "vitest"

import {
  GuideGoalCancelledError,
  GuideGoalInteractionController,
  recommendedGuideGoalAnswer,
  renderGuideGoalProposal,
  validateGuideGoalDraft,
  validateGuideGoalQuestion,
  type GuideGoalRequest,
  type GuideGoalTurn,
} from "../src/guide-goal-augment.js"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.js"

const fixture = () => {
  const abort = new AbortController()
  const requests: Array<GuideGoalRequest | undefined> = []
  const history: GuideGoalTurn[] = []
  const controller = new GuideGoalInteractionController({
    runId: 7,
    signal: abort.signal,
    onRequest: (request) => requests.push(request),
    onTurn: (turn) => history.push(turn),
  })
  return { abort, requests, history, controller }
}

describe("goal interactions", () => {
  it("accepts the current and queued recommendations only after opt-in, without approving the goal", async () => {
    const { controller, history, requests } = fixture()
    const exact = "  Design (Recommended: smallest offline v1)  "
    const first = controller.ask({ question: "Which artifact?", choices: ["Code", exact], allowFreeform: false })
    const second = controller.ask({ question: "Which format?", choices: ["JSON", "Markdown (Recommended)"] })
    const proposal = renderGuideGoalProposal(goalMeSkill, goalDraft)
    const review = controller.review(proposal)
    expect(history).toHaveLength(0)
    expect(controller.setAutoAcceptRecommended(6, true)).toBe(false)
    expect(history).toHaveLength(0)
    expect(controller.setAutoAcceptRecommended(7, true)).toBe(true)
    await expect(first).resolves.toEqual({ answer: exact, wasFreeform: false })
    await expect(second).resolves.toEqual({ answer: "Markdown (Recommended)", wasFreeform: false })
    expect(history).toHaveLength(2)
    expect(requests.at(-1)).toMatchObject({ kind: "review", requestId: 3 })
    expect(controller.submit(7, 1, { kind: "answer", answer: { answer: exact, wasFreeform: false } })).toBe(false)
    controller.submit(7, 3, { kind: "review", review: { decision: "revise", feedback: "Use deterministic ordering." } })
    await expect(review).resolves.toEqual({ decision: "revise", feedback: "Use deterministic ordering." })
    await expect(controller.ask({ question: "Sort results?", choices: ["Yes (Recommended)", "No"] }))
      .resolves.toEqual({ answer: "Yes (Recommended)", wasFreeform: false })
    controller.close()
  })

  it("waits for manual input when no single recommendation exists, then resumes automatic answers", async () => {
    const { controller, history, requests } = fixture()
    controller.setAutoAcceptRecommended(7, true)
    const manual = controller.ask({ question: "Who will read it?" })
    const recommended = controller.ask({ question: "Keep it local?", choices: ["Yes (Recommended)", "No"] })
    expect(history).toHaveLength(0)
    expect(requests.at(-1)).toMatchObject({ requestId: 1 })
    controller.submit(7, 1, { kind: "answer", answer: { answer: "My team.", wasFreeform: true } })
    await expect(manual).resolves.toEqual({ answer: "My team.", wasFreeform: true })
    await expect(recommended).resolves.toEqual({ answer: "Yes (Recommended)", wasFreeform: false })
    for (const [index, choices] of [["First", "Second"], ["First (Recommended)", "Second (Recommended: also valid)"]].entries()) {
      const pending = controller.ask({ question: "Choose one.", choices })
      expect(history).toHaveLength(2 + index)
      const request = requests.at(-1)!
      controller.submit(7, request.requestId, { kind: "answer", answer: { answer: choices[1]!, wasFreeform: false } })
      await expect(pending).resolves.toEqual({ answer: choices[1], wasFreeform: false })
    }
    controller.close()
  })

  it("can stop automatic answers and does not carry permission into another controller", async () => {
    const { controller, history } = fixture()
    controller.setAutoAcceptRecommended(7, true)
    await controller.ask({ question: "First?", choices: ["Yes (Recommended)"] })
    controller.setAutoAcceptRecommended(7, false)
    const manual = controller.ask({ question: "Second?", choices: ["Yes (Recommended)"] })
    expect(history).toHaveLength(1)
    controller.submit(7, 2, { kind: "answer", answer: { answer: "Yes (Recommended)", wasFreeform: false } })
    await manual
    controller.close()
    expect(controller.setAutoAcceptRecommended(7, true)).toBe(false)
    const fresh = fixture()
    const pending = expect(fresh.controller.ask({ question: "Fresh?", choices: ["Yes (Recommended)"] }))
      .rejects.toBeInstanceOf(GuideGoalCancelledError)
    expect(fresh.history).toHaveLength(0)
    fresh.abort.abort()
    await pending
    expect(fresh.controller.setAutoAcceptRecommended(7, true)).toBe(false)
  })

  it("does not answer queued questions after final approval", async () => {
    const { controller, history } = fixture()
    controller.setAutoAcceptRecommended(7, true)
    const review = controller.review(renderGuideGoalProposal(goalMeSkill, goalDraft))
    const later = expect(controller.ask({ question: "After review?", choices: ["Yes (Recommended)"] }))
      .rejects.toBeInstanceOf(GuideGoalCancelledError)
    controller.submit(7, 1, { kind: "review", review: { decision: "use" } })
    await expect(review).resolves.toEqual({ decision: "use" })
    expect(controller.setAutoAcceptRecommended(7, true)).toBe(false)
    expect(history).toHaveLength(1)
    controller.close()
    await later
  })

  it.each(["queued", "late"] as const)("keeps a %s proposal from replacing the approved goal", async (timing) => {
    const { controller, requests, history } = fixture()
    const approved = renderGuideGoalProposal(goalMeSkill, goalDraft)
    const other = renderGuideGoalProposal(goalMeSkill, { ...goalDraft, artifact: "A different design document." })
    const first = controller.review(approved)
    const enqueueOther = () => expect(controller.review(other)).rejects.toBeInstanceOf(GuideGoalCancelledError)
    const queued = timing === "queued" ? enqueueOther() : undefined
    expect(controller.submit(7, 1, { kind: "review", review: { decision: "use" } })).toBe(true)
    const late = timing === "late" ? enqueueOther() : undefined
    await expect(first).resolves.toEqual({ decision: "use" })
    expect(requests).toEqual([{ kind: "review", runId: 7, requestId: 1, proposal: approved }, undefined])
    expect(controller.submit(7, 2, { kind: "review", review: { decision: "use" } })).toBe(false)
    expect(history).toHaveLength(1)
    controller.close()
    await Promise.all([queued, late])
  })

  it("stops draining recommended answers immediately on cancellation", async () => {
    const abort = new AbortController()
    const history: GuideGoalTurn[] = []
    const controller = new GuideGoalInteractionController({
      runId: 7,
      signal: abort.signal,
      onRequest: () => {},
      onTurn: (turn) => { history.push(turn); abort.abort() },
    })
    const first = controller.ask({ question: "First?", choices: ["Yes (Recommended)"] })
    const second = expect(controller.ask({ question: "Second?", choices: ["Yes (Recommended)"] }))
      .rejects.toBeInstanceOf(GuideGoalCancelledError)
    controller.setAutoAcceptRecommended(7, true)
    await expect(first).resolves.toEqual({ answer: "Yes (Recommended)", wasFreeform: false })
    await second
    expect(history).toHaveLength(1)
    expect(controller.setAutoAcceptRecommended(7, true)).toBe(false)
  })

  it("recognizes explicit recommendation markers without guessing from ordinary prose", () => {
    for (const choice of ["Tool (Recommended)", " Tool (recommended: offline v1) ", "Tool (Recommended - local)"]) {
      expect(recommendedGuideGoalAnswer({ question: "Choose.", choices: ["Other", choice], allowFreeform: false }))
        .toEqual({ answer: choice, wasFreeform: false })
    }
    for (const choice of ["Not recommended", "Tool (Not recommended)", "Use recommended defaults", "Tool (Recommended against)"]) {
      expect(recommendedGuideGoalAnswer({ question: "Choose.", choices: [choice], allowFreeform: true })).toBeUndefined()
    }
  })

  it("queues overlapping requests and delivers each answer exactly once", async () => {
    const { controller, requests, history } = fixture()
    const first = controller.ask({ question: "Which artifact?", choices: ["Design", "Code"] })
    const second = controller.ask({ question: "What is the retry limit?" })
    expect(requests).toHaveLength(1)
    expect(controller.submit(6, 1, { kind: "answer", answer: { answer: "Code", wasFreeform: false } })).toBe(false)
    expect(controller.submit(7, 1, { kind: "answer", answer: { answer: "Design", wasFreeform: false } })).toBe(true)
    expect(controller.submit(7, 1, { kind: "answer", answer: { answer: "Code", wasFreeform: false } })).toBe(false)
    expect(requests.at(-1)?.requestId).toBe(2)
    expect(controller.submit(7, 2, { kind: "answer", answer: { answer: "Three attempts", wasFreeform: true } })).toBe(true)
    await expect(first).resolves.toEqual({ answer: "Design", wasFreeform: false })
    await expect(second).resolves.toEqual({ answer: "Three attempts", wasFreeform: true })
    expect(history).toHaveLength(2)
    expect(requests.at(-1)).toBeUndefined()
    controller.close()
  })

  it("keeps a closed-choice question pending after invalid or blank answers", async () => {
    const { controller, history } = fixture()
    const answer = controller.ask({ question: "Confirm?", choices: ["Proceed", "Revise"], allowFreeform: false })
    expect(() => controller.submit(7, 1, { kind: "answer", answer: { answer: "", wasFreeform: true } })).toThrow()
    expect(() => controller.submit(7, 1, { kind: "answer", answer: { answer: "Other", wasFreeform: true } })).toThrow()
    expect(() => controller.submit(7, 1, { kind: "answer", answer: { answer: "Proceed ", wasFreeform: false } })).toThrow()
    expect(history).toHaveLength(0)
    controller.submit(7, 1, { kind: "answer", answer: { answer: "Proceed", wasFreeform: false } })
    await expect(answer).resolves.toEqual({ answer: "Proceed", wasFreeform: false })
    controller.close()
  })

  it("requires a separate review decision and preserves revision feedback", async () => {
    const { controller } = fixture()
    const review = controller.review(renderGuideGoalProposal(goalMeSkill, goalDraft))
    expect(() => controller.submit(7, 1, { kind: "answer", answer: { answer: "Use goal", wasFreeform: false } })).toThrow()
    expect(() => controller.submit(7, 1, { kind: "review", review: { decision: "revise", feedback: " " } })).toThrow()
    controller.submit(7, 1, { kind: "review", review: { decision: "revise", feedback: "Use jitter." } })
    await expect(review).resolves.toEqual({ decision: "revise", feedback: "Use jitter." })
    const final = controller.review(renderGuideGoalProposal(goalMeSkill, goalDraft))
    controller.submit(7, 2, { kind: "review", review: { decision: "use" } })
    await expect(final).resolves.toEqual({ decision: "use" })
    controller.close()
  })

  it("rejects all callbacks on cancellation and ignores late answers", async () => {
    const { controller, abort } = fixture()
    const first = expect(controller.ask({ question: "First?" })).rejects.toBeInstanceOf(GuideGoalCancelledError)
    const second = expect(controller.ask({ question: "Second?" })).rejects.toBeInstanceOf(GuideGoalCancelledError)
    abort.abort()
    await Promise.all([first, second])
    expect(controller.submit(7, 1, { kind: "answer", answer: { answer: "late", wasFreeform: true } })).toBe(false)
    await expect(controller.ask({ question: "After cancellation?" })).rejects.toBeInstanceOf(GuideGoalCancelledError)
  })

  it("rejects malformed or unanswerable questions instead of guessing", () => {
    for (const value of [
      { question: "" },
      { question: "Pick", choices: [], allowFreeform: false },
      { question: "Pick", choices: ["same", "same"] },
      { question: "Pick", choices: "one" },
      { question: "Pick", allowFreeform: "false" },
      { question: "\u001b[2J" },
    ]) expect(() => validateGuideGoalQuestion(value)).toThrow()
    expect(validateGuideGoalQuestion({ question: "Describe it." })).toEqual({
      question: "Describe it.", choices: [], allowFreeform: true,
    })
  })
})

describe("goal completion", () => {
  it("fills only the mutable template blocks and keeps the installed protocol intact", () => {
    const { prompt, draft } = renderGuideGoalProposal(goalMeSkill, goalDraft)
    expect(draft).toEqual(goalDraft)
    expect(prompt).toContain(`TASK:\nArtifact: ${goalDraft.artifact}\n${goalDraft.task}`)
    for (const criterion of goalDraft.criteria) {
      expect(prompt).toContain(`- ${criterion}\n`)
      expect(prompt).toContain(`- ${criterion}: _`)
    }
    expect(prompt).not.toContain("[criterion")
    expect(prompt.slice(prompt.indexOf("Weakest:"))).toBe(
      goalMeSkill.slice(goalMeSkill.indexOf("Weakest:"), goalMeSkill.lastIndexOf("\n```")),
    )
  })

  it("rejects missing criteria, duplicate criteria, and unsupported skill templates", () => {
    expect(() => validateGuideGoalDraft({ ...goalDraft, criteria: ["One", "Two"] })).toThrow()
    expect(() => validateGuideGoalDraft({ ...goalDraft, criteria: ["One", "Two", " one "] })).toThrow()
    expect(() => validateGuideGoalDraft({ ...goalDraft, artifact: "One\nTwo" })).toThrow()
    expect(() => renderGuideGoalProposal(goalMeSkill.replace("TASK:", "WORK:"), goalDraft)).toThrow()
    expect(() => renderGuideGoalProposal("No template", goalDraft)).toThrow()
  })

  it("rejects an oversized complete goal rather than cutting off its rules", () => {
    expect(() => renderGuideGoalProposal(goalMeSkill, {
      ...goalDraft,
      task: "t".repeat(30_000),
      criteria: Array.from({ length: 20 }, (_, index) => `${index}: ${"c".repeat(1900)}`),
    })).toThrow(/complete goal/u)
  })
})
