import {
  ContinuationActionStatus,
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  parseFirstmateOrchestrationV1,
  parseFirstmateFleetReadinessV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  parseGuideProjectTargetV1,
  type ContinuationDraft,
  type FirstmateFleetReadinessV1,
  type FirstmateSubmissionRequestV1,
  type ProfileGuideV1,
} from "@trellage/guide-core"
import type { ContinuationProfileOption } from "../../src/continuation-services.ts"
import type { FirstmateJournalEntry, FirstmateSubmissionJournal } from "../../src/guide-firstmate-journal.ts"
import { firstmateOutcomeFromReceipt } from "../../src/guide-firstmate.ts"
import { prepareGuidePrompt } from "../../src/guide-context.ts"
import { renderWorkflowBodyCandidate } from "../../src/guide-workflow-prompt.ts"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../../src/guide-catalog.ts"
import { runtimeCatalog } from "./continuation-runtime-fixtures.ts"
import { continuationFixtureDraft, continuationFixtureProfiles } from "./continuation-ui-fixtures.ts"

export const firstmateOriginalIntent = "  Review project C.\r\nKeep all checks. Do not merge. 😀  "

export const firstmateProjectC = () => parseGuideProjectTargetV1({
  schemaVersion: 1,
  projectName: null,
  source: { kind: "local", location: "/fixture/project-c" },
  entryWorktree: "/fixture/project-c",
  baseRevision: "c".repeat(40),
  dirty: true,
  dirtyChanges: "excluded",
})

export const firstmateOrchestration = parseFirstmateOrchestrationV1({
  schemaVersion: 1,
  kind: "firstmate",
  sourceRevision: "b".repeat(40),
  taskIdPrefix: "fmd",
  workerPolicy: null,
  workerHarness: "claude",
  workerEfforts: ["low", "medium", "high"],
  dispatchRules: "claude-single",
  submission: { schemaVersion: 1, maxRequestBytes: 512 * 1024 },
})

export const firstmateGuide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["firstmate-fleet-orchestration"],
  bestFor: ["Review a confirmed project", "Read fleet status"],
  avoidFor: ["Changing permissions", "Unbounded worker launches"],
  prerequisites: [],
  workflows: [
    {
      id: "review-project",
      description: "Review the confirmed project.",
      examples: ["Review project C", "Find defects in this project", "Inspect the selected revision"],
      frame: "fixed",
      scope: "project",
      promptTemplate: "Review the confirmed project with supported Claude controls.\n\nSpecification:\n{{intent}}\n\nReport evidence. Do not merge.",
    },
    {
      id: "review-fleet-status",
      description: "Read fleet status without starting work.",
      examples: ["Report fleet status", "Review pending decisions", "Inspect fleet reports"],
      frame: "fixed",
      scope: "fleet",
      promptTemplate: "Read the fleet status. Do not start implementation workers.\n\nSpecification:\n{{intent}}\n\nReport observations only.",
    },
  ],
}

export const firstmateProfile: ContinuationProfileOption = {
  ref: "native:fmx/default",
  name: "Firstmate",
  guide: firstmateGuide,
  orchestration: firstmateOrchestration,
  workflows: firstmateGuide.workflows.map(({ id, description }) => ({ id, description })),
}

export type ContinuationFirstmateProfile = "default" | "pstack-workers"

export const firstmatePstackProfile: ContinuationProfileOption = {
  ...firstmateProfile,
  ref: "native:fmx/pstack-workers",
  name: "Firstmate pstack workers",
  orchestration: parseFirstmateOrchestrationV1({
    ...firstmateOrchestration,
    taskIdPrefix: "fmp",
    workerPolicy: { name: "pstack-workers", digest: "d".repeat(64) },
  }),
}

export const firstmateProfiles = [...continuationFixtureProfiles, firstmateProfile, firstmatePstackProfile]

const profileOption = (name: ContinuationFirstmateProfile): ContinuationProfileOption =>
  name === "default" ? firstmateProfile : firstmatePstackProfile

export const firstmateFixtureDraft = (name: ContinuationFirstmateProfile = "default"): ContinuationDraft => {
  const initial = continuationFixtureDraft()
  const profile = profileOption(name)
  if (initial.assessment === undefined) throw new Error("The fixture needs an assessment.")
  return {
    ...initial,
    snapshot: { ...initial.snapshot, source: { ...initial.snapshot.source, cwd: "/fixture/source-a" } },
    assessment: {
      ...initial.assessment,
      actions: initial.assessment.actions.map((action, index) => index > 0 ? action : {
        ...action, profileRef: profile.ref, workflowId: "review-project", brief: firstmateOriginalIntent,
      }),
    },
    actions: initial.actions.map((edit, index) => index > 0 ? edit : {
      ...edit, profileRef: profile.ref, workflowId: "review-project",
      brief: firstmateOriginalIntent, originalIntent: firstmateOriginalIntent,
    }),
  }
}

export const confirmedFirstmateFixtureDraft = (name: ContinuationFirstmateProfile = "default"): ContinuationDraft => {
  const initial = firstmateFixtureDraft(name)
  return {
    ...initial,
    actions: initial.actions.map((edit, index) => index > 0 ? edit : {
      ...edit, projectTarget: firstmateProjectC(), projectTargetConfirmed: true,
    }),
  }
}

export const firstmatePreparedPrompt = (draft: ContinuationDraft) => {
  const edit = draft.actions[0]
  if (edit === undefined) throw new Error("The fixture needs an action.")
  const profile = profileOption(edit.profileRef === firstmatePstackProfile.ref ? "pstack-workers" : "default")
  return prepareGuidePrompt(firstmateGuide, edit.workflowId ?? "review-project", profile.ref, edit.brief, {
    originalIntent: edit.originalIntent ?? edit.brief,
    projectTarget: edit.projectTarget ?? null,
    ...(profile.orchestration === undefined ? {} : { orchestration: profile.orchestration }),
  })
}

export const preparedFirstmateFixtureDraft = (name: ContinuationFirstmateProfile = "default"): ContinuationDraft => {
  const draft = confirmedFirstmateFixtureDraft(name)
  const { workflow } = firstmatePreparedPrompt(draft)
  const candidates = ["Inspect boundaries.", "Trace failure paths.", "Check focused evidence."].map((body, index) => ({
    id: `candidate-${index + 1}`,
    ...renderWorkflowBodyCandidate(workflow, { title: `Choice ${index + 1}`, prompt: body, notes: "Synthetic independent approach." }),
  }))
  return {
    ...draft,
    actions: draft.actions.map((edit, index) => index > 0 ? edit : {
      ...edit, candidates, selectedCandidateId: "candidate-2", prompt: candidates[1]!.prompt,
      selected: true, status: ContinuationActionStatus.Prepared,
      prerequisitesConfirmed: true, sharedWriteConfirmed: true, uncommittedChangesConfirmed: true,
    }),
  }
}

export const firstmateRequest = (draft = preparedFirstmateFixtureDraft()) => {
  const edit = draft.actions[0]
  if (edit === undefined) throw new Error("The fixture needs an action.")
  return parseFirstmateSubmissionRequestV1({
    schemaVersion: 1,
    requestId: "487921de-3110-44ae-9d7c-060ce10c07e0",
    expectedFleet: firstmateFleetIdentity(edit.profileRef === firstmatePstackProfile.ref ? "pstack-workers" : "default"),
    originalIntent: edit.originalIntent,
    generatedSpec: edit.prompt,
    workflowId: edit.workflowId,
    projectTarget: edit.projectTarget,
  })
}

export const firstmateReceipt = (request: FirstmateSubmissionRequestV1, state: "saved" | "handled" = "saved") =>
  parseFirstmateSubmissionReceiptV1({
    schemaVersion: 1,
    requestId: request.requestId,
    digest: firstmateSubmissionDigest(request),
    fleet: request.expectedFleet,
    state,
    noteId: "captain-note-1",
    announcement: "failed",
    supervisorState: "running",
    error: { code: "wake-failed", message: "The note is saved. Announcement failed." },
  })

export const firstmateRuntimeCatalog = () => {
  const catalog = runtimeCatalog()
  const base = catalog.native[0]
  if (base === undefined) throw new Error("The fixture needs a native profile.")
  return parseGuideCatalog(JSON.stringify({
    ...catalog,
    native: [...catalog.native, ...([firstmateProfile, firstmatePstackProfile].map((profile) => ({
      ...base, name: profile.ref.split("/")[1], launcher: "fmx", harness: "firstmate", commandPath: "/profiles/fmx",
      headless: { ...base.headless, prompt: false }, guide: firstmateGuide, orchestration: profile.orchestration,
    })))],
  }))
}

export const legacyFirstmateCatalog = (catalog: CombinedGuideCatalog = firstmateRuntimeCatalog()): CombinedGuideCatalog => ({
  ...catalog,
  native: catalog.native.map((entry) => {
    if (entry.launcher !== "fmx") return entry
    const { orchestration: _orchestration, ...legacy } = entry
    return legacy
  }),
})

export const firstmateFleetIdentity = (name: ContinuationFirstmateProfile = "default") => ({
  profile: name,
  instanceId: name === "default" ? "f5c86f7e-e66d-4bb7-b8e8-f24f9242398b" : "bdfe19d1-9c2a-47e2-8dd8-99f767d35c28",
  home: name === "default" ? "/fixture/private-firstmate-home" : "/fixture/private-firstmate-home-pstack-workers",
  sourceRevision: firstmateOrchestration.sourceRevision,
})

export const firstmateFleetReadiness = (
  name: ContinuationFirstmateProfile = "default",
  action: keyof FirstmateFleetReadinessV1["actions"] = "submit",
  overrides: Partial<FirstmateFleetReadinessV1> = {},
): FirstmateFleetReadinessV1 => parseFirstmateFleetReadinessV1({
  schemaVersion: 1,
  identity: firstmateFleetIdentity(name),
  runtime: "ready",
  backend: "herdr",
  supervisor: { state: action === "submit" ? "running" : action === "recover" ? "stale" : "stopped", pid: action === "submit" ? 1234 : null },
  activeWorkers: action === "start" ? 0 : 2,
  prerequisites: [{ id: "herdr", ready: true, description: "Fixture terminal control is available." }],
  consentRequired: false,
  actions: {
    start: { allowed: action === "start", reason: action === "start" ? null : "Choose the available action explicitly." },
    recover: { allowed: action === "recover", reason: action === "recover" ? null : "Choose the available action explicitly." },
    submit: { allowed: true, reason: null },
  },
  ...overrides,
})

export const firstmateMemoryJournal = () => {
  const entries = new Map<string, FirstmateJournalEntry>()
  const events: Array<{ readonly operation: string; readonly requestId: string }> = []
  const requireSame = (entry: FirstmateJournalEntry, request: FirstmateSubmissionRequestV1): void => {
    if (canonicalFirstmateJson(entry.request) !== canonicalFirstmateJson(request)) throw new Error("Fixture journal request conflict.")
  }
  const journal: FirstmateSubmissionJournal = {
    async get(requestId) {
      events.push({ operation: "get", requestId })
      return entries.get(requestId)
    },
    async prepare(request) {
      events.push({ operation: "prepare", requestId: request.requestId })
      const saved = entries.get(request.requestId)
      if (saved !== undefined) { requireSame(saved, request); return saved }
      const entry: FirstmateJournalEntry = {
        schemaVersion: 1, request, digest: firstmateSubmissionDigest(request),
        status: "prepared", receipt: null, message: "Request saved locally. Not submitted.",
      }
      entries.set(request.requestId, entry)
      return entry
    },
    async begin(request) {
      events.push({ operation: "begin", requestId: request.requestId })
      const saved = entries.get(request.requestId)
      if (saved?.status !== "prepared") throw new Error("Fixture journal forbids another send.")
      requireSame(saved, request)
      const entry: FirstmateJournalEntry = { ...saved, status: "sending", message: "Submission in progress. Do not resend." }
      entries.set(request.requestId, entry)
      return entry
    },
    async record(request, outcome) {
      events.push({ operation: "record", requestId: request.requestId })
      const saved = entries.get(request.requestId)
      if (saved === undefined) throw new Error("Fixture request was not prepared.")
      requireSame(saved, request)
      if (saved.status === "accepted" && outcome.status !== "accepted") return saved
      if (outcome.receipt !== undefined && firstmateOutcomeFromReceipt(request, outcome.receipt).status !== outcome.status) {
        throw new Error("Fixture receipt does not match the request or outcome.")
      }
      const entry: FirstmateJournalEntry = {
        ...saved,
        status: outcome.status === "not-found" ? "unknown" : outcome.status,
        receipt: outcome.receipt ?? saved.receipt,
        message: outcome.message,
      }
      entries.set(request.requestId, entry)
      return entry
    },
    async listPending() {
      return [...entries.values()].filter(({ status }) => status !== "accepted" && status !== "rejected")
    },
  }
  return { journal, entries, events }
}
