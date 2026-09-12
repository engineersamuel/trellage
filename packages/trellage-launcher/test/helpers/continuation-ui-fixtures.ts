import {
  ActionAccess,
  ActionImportance,
  ContinuationActionStatus,
  ContinuationOutcome,
  ContinuationPlacementKind,
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  validateContinuationDraft,
  type ContinuationAssessment,
  type ContinuationDraft,
} from "@trellage/guide-core"
import type { ContinuationServices, ContinuationSourceStatus } from "../../src/continuation-services.ts"

export enum ContinuationFixtureMode {
  Fresh = "fresh",
  Resume = "resume",
  CancelAnalysis = "cancel-analysis",
  CancelPreparation = "cancel-preparation",
  CancelSaveFailure = "cancel-save-failure",
  CancelCleanupFailure = "cancel-cleanup-failure",
  SaveFailure = "save-failure",
  Advanced = "advanced",
  Different = "different",
  Unknown = "unknown",
  Clarification = "clarification",
  NoAction = "no-action",
  LongEvidence = "long-evidence",
  ManyMessages = "many-messages",
  RedactedMessages = "redacted-messages",
  LongPrompt = "long-prompt",
  DirtySource = "dirty-source",
}

export const continuationFixtureProfiles = [
  { ref: "native:cpx/reviewer", name: "Review specialist", workflows: [{ id: "review", description: "Review the reported changes" }, { id: "explain", description: "Explain the design" }] },
  { ref: "native:cdx/builder", name: "Implementation specialist", workflows: [{ id: "implement", description: "Implement the scoped brief" }, { id: "verify", description: "Verify the result" }] },
] as const

export const continuationFixtureAssessment = (
  outcome = ContinuationOutcome.Recommendations,
): ContinuationAssessment => ({
  schemaVersion: 1,
  outcome,
  goal: "Make the synthetic export reliable",
  reportedProgress: ["The assistant reported that the export code was updated."],
  unresolvedWork: ["Boundary checks are not yet verified."],
  blockers: ["No test evidence has been reported."],
  questions: outcome === ContinuationOutcome.NeedsClarification ? ["Which export format is required?"] : [],
  actions: outcome === ContinuationOutcome.Recommendations
    ? ["Review reported changes", "Visualize the design", "Check failure cases", "Compare alternatives", "Implement the checked next step"].map((title, index) => ({
      id: `action-${index + 1}`,
      rank: index + 1,
      title,
      brief: `Independent brief ${index + 1}: ${title}.`,
      whyNow: `Resolve evidence gap ${index + 1}.`,
      expectedOutput: `A concrete result for action ${index + 1}.`,
      evidenceIds: ["message-1", "message-2"],
      importance: index === 0 ? ActionImportance.Required : ActionImportance.Optional,
      profileRef: continuationFixtureProfiles[0].ref,
      workflowId: continuationFixtureProfiles[0].workflows[0].id,
      dependsOn: index === 4 ? ["action-1"] : [],
      access: index === 4 ? ActionAccess.Write : ActionAccess.ReadOnly,
    }))
    : [],
})

export const continuationFixtureDraft = (
  assessed = true,
  outcome = ContinuationOutcome.Recommendations,
): ContinuationDraft => {
  const assessment = continuationFixtureAssessment(outcome)
  return {
    schemaVersion: 1,
    id: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    snapshot: {
      schemaVersion: 1,
      id: "20000000-0000-4000-8000-000000000001",
      source: {
        serverId: "fixture-server",
        surface: ConversationSurface.Native,
        agent: ConversationAgent.Copilot,
        sessionId: "fixture-session",
        workspaceId: "fixture-workspace",
        paneId: "fixture-pane",
        tabId: "fixture-tab",
        profile: "reviewer",
        cwd: "/fixture/repository",
      },
      capturedAt: "2026-09-10T01:00:00.000Z",
      cutoff: { messageId: "message-2", recordIndex: 2 },
      revision: "a".repeat(64),
      messages: [
        { id: "message-1", role: ConversationRole.User, recordIndex: 1, text: "Make the synthetic export reliable.\nKeep all boundary checks." },
        { id: "message-2", role: ConversationRole.Assistant, recordIndex: 2, text: "I updated the export. I did not run tests.\nNo verification has been performed." },
      ],
      coverage: { complete: false, notices: ["An earlier attachment is unavailable. No missing text was invented."] },
    },
    model: "gpt-5.4",
    effort: "high",
    summaries: [],
    ...(assessed ? { assessment } : {}),
    actions: assessed ? assessment.actions.map((action) => ({
      actionId: action.id,
      brief: action.brief,
      selected: false,
      status: ContinuationActionStatus.Draft,
      profileRef: action.profileRef,
      workflowId: action.workflowId,
      placement: {
        kind: ContinuationPlacementKind.NewWorktree,
        branch: `next-steps/fixture-${action.rank}`,
        baseRef: "HEAD",
      },
    })) : [],
  }
}

export enum ContinuationFixtureEventKind {
  Save = "save",
  Analyze = "analyze",
  Prepare = "prepare",
  CheckSource = "check-source",
  Launch = "launch",
  Latest = "latest",
  Reload = "reload",
  Discard = "discard",
  Abort = "abort",
  Input = "input",
}

export interface ContinuationFixtureEvent {
  readonly kind: ContinuationFixtureEventKind
  readonly draft?: ContinuationDraft
  readonly actionId?: string
  readonly acknowledgeAdvanced?: boolean
  readonly input?: string
}

export const createContinuationServiceFixture = (
  initialDraft = continuationFixtureDraft(),
  record: (event: ContinuationFixtureEvent) => void = () => undefined,
  options: { readonly candidates?: boolean } = {},
) => {
  let saved = validateContinuationDraft(initialDraft)
  const drafts = new Map([[saved.id, saved]])
  const events: ContinuationFixtureEvent[] = []
  let sourceStatus: ContinuationSourceStatus = { sameSource: true, advanced: false, revision: saved.snapshot.revision }
  const emit = (event: ContinuationFixtureEvent): void => {
    events.push(event)
    record(event)
  }
  const commit = (draft: ContinuationDraft): ContinuationDraft => {
    if (drafts.get(draft.id)?.revision !== draft.revision) throw new Error("Fixture revision conflict.")
    saved = validateContinuationDraft({ ...draft, revision: draft.revision + 1 })
    drafts.set(saved.id, saved)
    return saved
  }
  const services: ContinuationServices = {
    profiles: continuationFixtureProfiles,
    estimate: () => ({ summarizationCalls: 2, assessmentCalls: 1, maxCalls: 6 }),
    async save(draft) {
      emit({ kind: ContinuationFixtureEventKind.Save, draft })
      return commit(draft)
    },
    async reload(draft) {
      emit({ kind: ContinuationFixtureEventKind.Reload, draft })
      const result = drafts.get(draft.id)
      if (result === undefined) throw new Error("Fixture draft is not saved.")
      if (!result.actions.some((edit) => edit.status === ContinuationActionStatus.Launching)) return result
      return commit({
        ...result,
        actions: result.actions.map((edit) => {
          if (edit.status !== ContinuationActionStatus.Launching) return edit
          if (edit.launch === undefined) throw new Error("An interrupted action needs a saved launch attempt.")
          return {
            ...edit,
            status: ContinuationActionStatus.Unknown,
            launch: { ...edit.launch, status: ContinuationActionStatus.Unknown },
          }
        }),
      })
    },
    async analyze(draft, signal, onProgress) {
      signal.throwIfAborted()
      emit({ kind: ContinuationFixtureEventKind.Analyze, draft })
      onProgress("Assessment call 1: using synthetic evidence only.")
      const assessed = continuationFixtureDraft()
      return commit({ ...draft, assessment: assessed.assessment!, actions: assessed.actions })
    },
    async prepare(draft, actionId, signal, onProgress) {
      signal.throwIfAborted()
      emit({ kind: ContinuationFixtureEventKind.Prepare, draft, actionId })
      onProgress(`Generating an independent prompt for ${actionId}.`)
      const edit = draft.actions.find((action) => action.actionId === actionId)
      if (edit === undefined) throw new Error("Fixture action not found.")
      const prompt = `WORKFLOW START\n${edit.brief}\nGuide-added instructions for ${edit.profileRef}/${edit.workflowId}.\nOptimize: check the reported evidence.\nWORKFLOW END`
      const { prompt: _prompt, selectedCandidateId: _candidate, ...rest } = edit
      return commit({
        ...draft,
        actions: draft.actions.map((action) => action.actionId === actionId
          ? options.candidates ? {
            ...rest,
            status: ContinuationActionStatus.Draft,
            candidates: ["Precise", "Evidence first", "Bounded"].map((title, index) => ({
              id: `candidate-${index + 1}`,
              title,
              notes: `${title} guide-generated and optimized approach.`,
              prompt: `${prompt}\nChoice: ${title}.`,
            })),
          } : { ...action, prompt, status: ContinuationActionStatus.Prepared }
          : action),
      })
    },
    async checkSource(draft, signal) {
      signal?.throwIfAborted()
      emit({ kind: ContinuationFixtureEventKind.CheckSource, draft })
      return sourceStatus
    },
    async launch(draft, acknowledgeAdvanced) {
      emit({ kind: ContinuationFixtureEventKind.Launch, draft, acknowledgeAdvanced })
      return commit({
        ...draft,
        actions: draft.actions.map((edit, index) =>
          edit.selected && edit.status === ContinuationActionStatus.Prepared
            ? { ...edit, status: ContinuationActionStatus.Launched, launch: { attemptId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, status: ContinuationActionStatus.Launched, paneId: `pane-${edit.actionId}`, workspaceId: "destination-workspace", cwd: `/fixture/${edit.actionId}` } }
            : edit,
        ),
      })
    },
    async latest(draft, signal) {
      signal?.throwIfAborted()
      emit({ kind: ContinuationFixtureEventKind.Latest, draft })
      const fresh = continuationFixtureDraft(false)
      saved = validateContinuationDraft({
        ...fresh,
        id: "10000000-0000-4000-8000-000000000002",
        model: draft.model,
        effort: draft.effort,
        snapshot: { ...fresh.snapshot, id: "20000000-0000-4000-8000-000000000002", revision: "b".repeat(64) },
      })
      drafts.set(saved.id, saved)
      return saved
    },
    async discard(draft) {
      emit({ kind: ContinuationFixtureEventKind.Discard, draft })
      drafts.delete(draft.id)
    },
  }
  return {
    services,
    events,
    drafts,
    commit,
    emit,
    saved: () => saved,
    setSource: (status: ContinuationSourceStatus) => { sourceStatus = status },
  }
}
