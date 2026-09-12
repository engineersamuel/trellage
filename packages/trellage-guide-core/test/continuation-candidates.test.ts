import { describe, expect, it } from "vitest"
import {
  ActionAccess,
  ActionImportance,
  ContinuationActionStatus,
  ContinuationOutcome,
  ContinuationPlacementKind,
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  ConversationValidationError,
  conversationLimits,
  validateContinuationDraft,
  type ContinuationDraft,
  type ContinuationPromptCandidate,
} from "../src/conversation.ts"

const candidates = (): ReadonlyArray<ContinuationPromptCandidate> => [
  {
    id: "candidate-1",
    title: "Precise",
    prompt: "WORKFLOW START\nReview the exact change.\nWORKFLOW END",
    notes: "A narrow, optimized review.",
  },
  {
    id: "candidate-2",
    title: "Evidence first",
    prompt: "WORKFLOW START\nCheck the evidence before reviewing.\nWORKFLOW END",
    notes: "Use reported results only as claims.",
  },
  {
    id: "candidate-3",
    title: "Bounded",
    prompt: "WORKFLOW START\nReview the selected boundaries only.\nWORKFLOW END",
    notes: "Do not expand the scope.",
  },
]

const draft = (): ContinuationDraft => {
  const actions = ["Review", "Explain", "Visualize", "Compare", "Verify"].map((title, index) => ({
    id: `action-${index + 1}`,
    rank: index + 1,
    title: `${title} the export`,
    brief: `${title} the reported export change.`,
    whyNow: "The assistant reported a change without evidence.",
    expectedOutput: `${title} results for the export.`,
    evidenceIds: ["message-1", "message-2"],
    importance: ActionImportance.Optional,
    profileRef: "native:cdx/default",
    workflowId: "review",
    dependsOn: [],
    access: ActionAccess.Unknown,
  }))
  return {
    schemaVersion: 1,
    id: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    snapshot: {
      schemaVersion: 1,
      id: "20000000-0000-4000-8000-000000000001",
      source: {
        serverId: "fixture-server",
        surface: ConversationSurface.Host,
        agent: ConversationAgent.Copilot,
        sessionId: "fixture-session",
        workspaceId: "fixture-workspace",
        paneId: "fixture-pane",
        cwd: "/work/export",
      },
      capturedAt: "2026-09-10T01:00:00.000Z",
      cutoff: { messageId: "message-2", recordIndex: 1 },
      revision: "a".repeat(64),
      messages: [
        { id: "message-1", role: ConversationRole.User, recordIndex: 0, text: "Make the export reliable." },
        {
          id: "message-2",
          role: ConversationRole.Assistant,
          recordIndex: 1,
          text: "The export was changed. Tests have not been run.",
        },
      ],
      coverage: { complete: true, notices: [] },
    },
    model: "gpt-5.5",
    effort: "high",
    summaries: [],
    assessment: {
      schemaVersion: 1,
      outcome: ContinuationOutcome.Recommendations,
      goal: "Make the export reliable.",
      reportedProgress: ["An export change was reported."],
      unresolvedWork: ["Review the change."],
      blockers: [],
      questions: [],
      actions,
    },
    actions: actions.map((action) => ({
      actionId: action.id,
      brief: action.brief,
      selected: false,
      status: ContinuationActionStatus.Draft,
      placement: { kind: ContinuationPlacementKind.NewWorktree, branch: `next/action-${action.rank}`, baseRef: "HEAD" },
    })),
  }
}

const withFirstAction = (change: Readonly<Record<string, unknown>>) => {
  const original = draft()
  return {
    ...original,
    actions: original.actions.map((action, index) => (index === 0 ? { ...action, ...change } : action)),
  }
}

describe("saved continuation prompt candidates", () => {
  it("retains exactly three full guide candidates without selecting a prompt or launching", () => {
    const original = withFirstAction({ candidates: candidates() })
    const parsed = validateContinuationDraft(original)
    expect(parsed).toEqual(original)
    expect(parsed.actions[0]).toMatchObject({
      status: ContinuationActionStatus.Draft,
      selected: false,
      candidates: candidates(),
    })
    expect(parsed.actions[0]).not.toHaveProperty("prompt")
    expect(parsed.actions[0]).not.toHaveProperty("selectedCandidateId")
    expect(parsed.actions[0]!.candidates).not.toBe(original.actions[0]!.candidates)
  })

  it("accepts a chosen prompt, and retains all alternatives for later review", () => {
    const original = withFirstAction({
      candidates: candidates(),
      selectedCandidateId: "candidate-2",
      prompt: candidates()[1]!.prompt,
      status: ContinuationActionStatus.Prepared,
      selected: true,
    })
    expect(validateContinuationDraft(original)).toEqual(original)
  })

  it.each([true, false])("preserves explicit committed-only worktree confirmation: %s", (confirmed) => {
    const original = withFirstAction({ uncommittedChangesConfirmed: confirmed })
    expect(validateContinuationDraft(original).actions[0]?.uncommittedChangesConfirmed).toBe(confirmed)
  })

  it.each([ContinuationActionStatus.Prepared, ContinuationActionStatus.Waiting])(
    "retains the explicit candidate origin after editing a %s prompt",
    (status) => {
      const edited = withFirstAction({
        candidates: candidates(),
        selectedCandidateId: "candidate-2",
        prompt: "A complete user-edited outgoing workflow prompt.",
        status,
      })
      expect(validateContinuationDraft(edited)).toEqual(edited)
    },
  )

  it("does not infer a different origin when an edited prompt matches another candidate", () => {
    const edited = withFirstAction({
      candidates: candidates(),
      selectedCandidateId: "candidate-2",
      prompt: candidates()[0]!.prompt,
      status: ContinuationActionStatus.Prepared,
    })
    expect(validateContinuationDraft(edited)).toEqual(edited)
  })

  it("supports legacy candidate-free prepared prompts without inventing a choice", () => {
    const legacy = withFirstAction({
      prompt: "An existing full outgoing prompt.",
      status: ContinuationActionStatus.Prepared,
    })
    expect(validateContinuationDraft(legacy)).toEqual(legacy)
  })

  it("does not force a dependent action out of waiting after a prompt choice", () => {
    const original = withFirstAction({
      candidates: candidates(),
      selectedCandidateId: "candidate-1",
      prompt: candidates()[0]!.prompt,
      status: ContinuationActionStatus.Waiting,
    })
    expect(validateContinuationDraft(original).actions[0]?.status).toBe(ContinuationActionStatus.Waiting)
  })

  it("accepts the same local candidate IDs for independent actions", () => {
    const original = draft()
    const value = { ...original, actions: original.actions.map((action) => ({ ...action, candidates: candidates() })) }
    expect(validateContinuationDraft(value).actions).toHaveLength(5)
  })

  it.each([0, 1, 2, 4])("rejects a saved set with %s candidates", (count) => {
    const value = Array.from({ length: count }, (_, index) => ({
      ...candidates()[index % 3]!,
      id: `candidate-${index + 1}`,
    }))
    expect(() => validateContinuationDraft(withFirstAction({ candidates: value }))).toThrow(/3 and 3/u)
  })

  it.each([
    {
      candidates: candidates(),
      selectedCandidateId: "invented",
      prompt: "Reviewed output.",
      status: ContinuationActionStatus.Prepared,
    },
    { selectedCandidateId: "candidate-1", prompt: "Reviewed output.", status: ContinuationActionStatus.Prepared },
    { candidates: candidates(), selectedCandidateId: "candidate-1" },
    { candidates: candidates(), prompt: candidates()[0]!.prompt },
    { candidates: candidates(), prompt: candidates()[0]!.prompt, selectedCandidateId: "candidate-1" },
    { candidates: candidates(), status: ContinuationActionStatus.Prepared },
    { candidates: candidates(), prompt: candidates()[0]!.prompt, status: ContinuationActionStatus.Prepared },
    {
      candidates: candidates(),
      prompt: "A legacy user-edited prompt with no recorded origin.",
      status: ContinuationActionStatus.Prepared,
    },
    {
      candidates: candidates(),
      prompt: "An edited prompt waiting for a prerequisite with no recorded origin.",
      status: ContinuationActionStatus.Waiting,
    },
    { candidates: candidates(), selectedCandidateId: null },
    { uncommittedChangesConfirmed: "yes" },
  ])("rejects an invalid selection or preparation state %#", (change) => {
    expect(() => validateContinuationDraft(withFirstAction(change))).toThrow(ConversationValidationError)
  })

  it.each([
    { id: "candidate-2" },
    { id: "invalid id" },
    { title: "" },
    { title: "x".repeat(conversationLimits.promptCandidateTitleChars + 1) },
    { prompt: "" },
    { prompt: candidates()[1]!.prompt },
    { prompt: "x".repeat(conversationLimits.promptChars + 1) },
    { prompt: "do not print this text\u001b]52;clipboard" },
    { prompt: "\ud800" },
    { notes: 1 },
    { notes: "x".repeat(conversationLimits.promptCandidateNotesChars + 1) },
    { argv: ["must-not-execute"] },
  ])("rejects invalid candidate fields %#", (change) => {
    const value = candidates().map((candidate, index) => (index === 0 ? { ...candidate, ...change } : candidate))
    expect(() => validateContinuationDraft(withFirstAction({ candidates: value }))).toThrow(ConversationValidationError)
  })

  it("matches guide title/notes Unicode character limits and preserves the full prompt boundary", () => {
    const value = candidates().map((candidate, index) =>
      index === 0
        ? {
            ...candidate,
            title: "😀".repeat(conversationLimits.promptCandidateTitleChars),
            notes: "😀".repeat(conversationLimits.promptCandidateNotesChars),
            prompt: "x".repeat(conversationLimits.promptChars),
          }
        : candidate,
    )
    expect(validateContinuationDraft(withFirstAction({ candidates: value })).actions[0]?.candidates).toEqual(value)
  })

  it("rejects sparse arrays and accessors without running untrusted code", () => {
    expect(() => validateContinuationDraft(withFirstAction({ candidates: Array(3) }))).toThrow(/dense/u)
    const value = candidates().map((candidate) => ({ ...candidate }))
    Object.defineProperty(value[0], "prompt", {
      enumerable: true,
      get() {
        throw new Error("must not run")
      },
    })
    expect(() => validateContinuationDraft(withFirstAction({ candidates: value }))).toThrow(/JSON fields/u)
  })
})
