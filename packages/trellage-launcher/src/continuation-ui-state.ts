import {
  ContinuationActionStatus,
  ContinuationPlacementKind,
  canonicalFirstmateJson,
  conversationLimits,
  parseFirstmateSubmissionRequestV1,
  parseGuideProjectTargetV1,
  parseFirstmateInstanceReferenceV1,
  type ContinuationActionDraft,
  type ContinuationDraft,
  type ContinuationPlacement,
  type FirstmateFleetReadinessV1,
  type FirstmateSubmissionRequestV1,
  type NextAction,
} from "@trellage/guide-core"
import type { ContinuationProfileOption, ContinuationSourceStatus } from "./continuation-services.ts"
import { firstmateAttemptProtected, firstmateRejectionNeedsReconciliation } from "./continuation-firstmate-state.ts"
import type { FirstmateInstanceMenuState } from "./guide-firstmate-instance-menu.ts"
import { completeSinglePromptArtifact, guideModelBodyCandidate, prepareGuidePrompt, savedLegacyFirstmateOrchestration, validateGuideOriginalIntent } from "./guide-context.ts"
import { firstmateSupervisorStatusText } from "./guide-firstmate.ts"
import {
  renderWorkflowBodyCandidate,
  validateFinalGuideCandidate,
  workflowBodyCandidate,
  workflowPromptFrame,
  workflowUsesFixedFrame,
} from "./guide-workflow-prompt.ts"

// oxlint-disable-next-line no-control-regex -- Pasted terminal controls are removed, not interpreted.
const pastedControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu

export enum ContinuationScreen {
  Setup = "setup",
  Overview = "overview",
  Action = "action",
  Editor = "editor",
  Profiles = "profiles",
  Workflows = "workflows",
  Candidates = "candidates",
  Prompt = "prompt",
  Placement = "placement",
  Target = "target",
  FirstmateActions = "firstmate-actions",
  FirstmateInstances = "firstmate-instances",
  Evidence = "evidence",
  Messages = "messages",
  LatestConfirmation = "latest-confirmation",
  DiscardConfirmation = "discard-confirmation",
  LaunchConfirmation = "launch-confirmation",
}

export enum ContinuationOperation {
  Idle = "idle",
  Save = "save",
  Analyze = "analyze",
  Prepare = "prepare",
  ResolveTarget = "resolve-target",
  InspectFirstmate = "inspect-firstmate",
  ConfirmFirstmate = "confirm-firstmate",
  FirstmateInstances = "firstmate-instances",
  ConfirmFirstmateInstance = "confirm-firstmate-instance",
  Latest = "latest",
  CheckSource = "check-source",
  Launch = "launch",
  Reload = "reload",
  Discard = "discard",
}

export enum ContinuationSaveState {
  Saved = "saved",
  Saving = "saving",
  Failed = "failed",
  RecoveryRequired = "recovery-required",
}

export enum ContinuationField {
  Model = "model",
  Effort = "effort",
  Brief = "brief",
  Prompt = "prompt",
  Branch = "branch",
  BaseRef = "base-ref",
  ExistingPath = "existing-path",
  ProjectPath = "project-path",
  ProjectName = "project-name",
}

export enum ContinuationTextCommand {
  Insert = "insert",
  Backspace = "backspace",
  Delete = "delete",
  Left = "left",
  Right = "right",
  Up = "up",
  Down = "down",
  Home = "home",
  End = "end",
  Start = "start",
  Finish = "finish",
  Clear = "clear",
}

export enum ContinuationSplitDirection {
  Right = "right",
  Down = "down",
}

export interface ContinuationEditor {
  readonly field: ContinuationField
  readonly value: string
  readonly cursor: number
  readonly returnScreen: ContinuationScreen
  readonly maximumLength?: number
}

export interface ContinuationUiState {
  readonly draft: ContinuationDraft
  readonly screen: ContinuationScreen
  readonly actionIndex: number
  readonly optionIndex: number
  readonly candidateIndex: number
  readonly evidenceIndex: number
  readonly evidenceActionId: string | null
  readonly evidenceReturnScreen: ContinuationScreen
  readonly messageIndex: number
  readonly messageReturnScreen: ContinuationScreen
  readonly editor: ContinuationEditor | null
  readonly operation: ContinuationOperation
  readonly cancelling: boolean
  readonly progress: ReadonlyArray<string>
  readonly saveState: ContinuationSaveState
  readonly error: string | null
  readonly notice: string | null
  readonly sourceStatus: ContinuationSourceStatus | null
  readonly firstmateReadiness: { readonly actionId: string; readonly fleet: FirstmateFleetReadinessV1 } | null
  readonly firstmateChoice: keyof FirstmateFleetReadinessV1["actions"] | null
  readonly firstmateInstanceMenu: { readonly actionId: string; readonly menu: FirstmateInstanceMenuState } | null
  readonly acknowledgeAdvanced: boolean
  readonly hasSavedDraft: boolean
  readonly scroll: Readonly<Record<string, number>>
}

export const initialContinuationUiState = (
  draft: ContinuationDraft,
  hasSavedDraft = false,
): ContinuationUiState => ({
  draft,
  screen: hasSavedDraft || draft.assessment === undefined ? ContinuationScreen.Setup : ContinuationScreen.Overview,
  actionIndex: 0,
  optionIndex: 0,
  candidateIndex: 0,
  evidenceIndex: 0,
  evidenceActionId: null,
  evidenceReturnScreen: ContinuationScreen.Setup,
  messageIndex: 0,
  messageReturnScreen: ContinuationScreen.Setup,
  editor: null,
  operation: ContinuationOperation.Idle,
  cancelling: false,
  progress: [],
  saveState: ContinuationSaveState.Saved,
  error: null,
  notice: null,
  sourceStatus: null,
  firstmateReadiness: null,
  firstmateChoice: null,
  firstmateInstanceMenu: null,
  acknowledgeAdvanced: false,
  hasSavedDraft,
  scroll: {},
})

export const rankedContinuationActions = (draft: ContinuationDraft): ReadonlyArray<NextAction> =>
  [...(draft.assessment?.actions ?? [])].sort((left, right) => left.rank - right.rank)

export const continuationAction = (
  draft: ContinuationDraft,
  actionId: string,
): { readonly action: NextAction; readonly edit: ContinuationActionDraft } => {
  const action = draft.assessment?.actions.find(({ id }) => id === actionId)
  const edit = draft.actions.find((candidate) => candidate.actionId === actionId)
  if (action === undefined || edit === undefined) throw new Error("The action is not part of this saved assessment.")
  return { action, edit }
}

export const continuationActionLocked = (edit: ContinuationActionDraft): boolean =>
  edit.status === ContinuationActionStatus.Launched ||
  edit.status === ContinuationActionStatus.Launching ||
  edit.status === ContinuationActionStatus.Unknown ||
  firstmateAttemptProtected(edit)

export const continuationNeedsReconciliation = (edit: ContinuationActionDraft): boolean =>
  edit.status === ContinuationActionStatus.Launching ||
  edit.status === ContinuationActionStatus.Unknown ||
  edit.status === ContinuationActionStatus.Submitting ||
  edit.status === ContinuationActionStatus.SubmissionUnknown ||
  firstmateRejectionNeedsReconciliation(edit)

export const continuationProfile = (
  draft: ContinuationDraft,
  actionId: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): ContinuationProfileOption | undefined => {
  const { action, edit } = continuationAction(draft, actionId)
  return profiles.find(({ ref }) => ref === (edit.profileRef ?? action.profileRef))
}

const unsupportedContinuationProjectTargetProblem = (edit: ContinuationActionDraft): string | null =>
  edit.projectTargetConfirmed === true && edit.projectTarget !== undefined && edit.projectTarget !== null
    ? "this profile cannot carry a confirmed Firstmate project target. Change the profile or remove the target confirmation before preparing work."
    : null

export const continuationProjectTargetProblem = (
  draft: ContinuationDraft,
  actionId: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): string | null => {
  const { action, edit } = continuationAction(draft, actionId)
  const profile = continuationProfile(draft, actionId, profiles)
  if (!profile?.orchestration && !(edit.profileRef ?? action.profileRef).startsWith("native:fmx/")) {
    return unsupportedContinuationProjectTargetProblem(edit)
  }
  if (edit.projectTargetConfirmed !== true || edit.projectTarget === undefined) {
    return "confirm a project target before preparing or submitting Firstmate work. The source pane is not the project."
  }
  const workflow = profile?.guide?.workflows.find(({ id }) => id === (edit.workflowId ?? action.workflowId))
  if (edit.projectTarget === null && workflow?.scope !== "fleet") {
    return "this workflow requires a confirmed project; fleet scope is not allowed."
  }
  return null
}

export const continuationPreparedGuidePrompt = (
  draft: ContinuationDraft,
  actionId: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
) => {
  const profile = continuationProfile(draft, actionId, profiles)
  if (profile === undefined || (profile.orchestration === undefined && !profile.ref.startsWith("native:fmx/"))) return undefined
  if (profile.guide === undefined) throw new Error("The authored Firstmate guide is unavailable. Reload the catalog before editing.")
  const { action, edit } = continuationAction(draft, actionId)
  const problem = continuationProjectTargetProblem(draft, actionId, profiles)
  if (problem !== null) throw new Error(problem)
  const orchestration = profile.orchestration === undefined ? undefined
    : edit.firstmateInstance === undefined && edit.firstmateSubmission !== undefined
      ? savedLegacyFirstmateOrchestration(edit.firstmateSubmission.request.generatedSpec, profile.orchestration) : profile.orchestration
  return prepareGuidePrompt(profile.guide, edit.workflowId ?? action.workflowId, profile.ref, edit.brief, {
    originalIntent: edit.originalIntent ?? edit.brief,
    projectTarget: edit.projectTarget ?? null,
    ...(orchestration === undefined ? {} : { orchestration }),
  })
}

const containsAuthoredContinuationFrame = (
  profile: ContinuationProfileOption | undefined,
  workflowId: string,
  body: string,
): boolean => {
  const workflow = profile?.guide?.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) return false
  const frame = workflowPromptFrame(workflow)
  if (frame.beforeBody.trim().length === 0) return false
  const prefix = body.indexOf(frame.beforeBody)
  return prefix >= 0 && (
    frame.afterBody.trim().length === 0 || body.indexOf(frame.afterBody, prefix + frame.beforeBody.length) >= 0
  )
}

export const continuationRenderedPrompt = (
  draft: ContinuationDraft,
  actionId: string,
  prompt: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): string => {
  const prepared = continuationPreparedGuidePrompt(draft, actionId, profiles)
  if (prepared === undefined || !workflowUsesFixedFrame(prepared.workflow)) return prompt
  const candidate = { title: "Continuation action", prompt, notes: "Human-edited specification." }
  const body = guideModelBodyCandidate(prepared.workflow, candidate, prepared.context)
  if (
    workflowBodyCandidate(prepared.workflow, body).prompt !== body.prompt ||
    containsAuthoredContinuationFrame(continuationProfile(draft, actionId, profiles), prepared.workflow.id, body.prompt)
  ) {
    throw new Error("The specification contains a repeated fixed frame. Keep only the editable body.")
  }
  validateFinalGuideCandidate(body)
  return completeSinglePromptArtifact(
    prepared.workflow, renderWorkflowBodyCandidate(prepared.workflow, body), prepared.context,
  ).prompt
}

export const validateContinuationFinalPrompt = (
  draft: ContinuationDraft,
  actionId: string,
  prompt: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): void => {
  if (continuationRenderedPrompt(draft, actionId, prompt, profiles) !== prompt) {
    throw new Error("The saved prompt does not match the confirmed target and workflow frame. Prepare it again.")
  }
}

export const reframeContinuationInstanceEdit = (
  before: ContinuationDraft, next: ContinuationDraft, actionId: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): ContinuationDraft => {
  const previous = continuationPreparedGuidePrompt(before, actionId, profiles)
  const current = continuationPreparedGuidePrompt(next, actionId, profiles)
  if (previous === undefined || current === undefined || previous.workflow.promptTemplate === current.workflow.promptTemplate) return next
  const render = (candidate: { readonly title: string; readonly prompt: string; readonly notes: string }) =>
    renderWorkflowBodyCandidate(current.workflow, guideModelBodyCandidate(previous.workflow, candidate, previous.context), { preserveBody: true })
  const { edit } = continuationAction(next, actionId)
  const reframed = {
    ...edit,
    ...(edit.prompt === undefined ? {} : {
      prompt: render({ title: "Retained specification", prompt: edit.prompt, notes: "Only unsubmitted framing changed." }).prompt,
    }),
    ...(edit.candidates === undefined ? {} : { candidates: edit.candidates.map((candidate) => ({ ...candidate, ...render(candidate) })) }),
  }
  return { ...next, actions: next.actions.map((action) => action.actionId === actionId ? reframed : action) }
}

export const continuationFirstmateActionLabels: Readonly<Record<keyof FirstmateFleetReadinessV1["actions"], string>> = {
  start: "Start fleet",
  recover: "Recover fleet",
  submit: "Send work",
}

const firstmateRequestMatchesAction = (
  request: FirstmateSubmissionRequestV1,
  saved: FirstmateSubmissionRequestV1,
  edit: ContinuationActionDraft,
  action: NextAction,
  profile: ContinuationProfileOption,
): boolean =>
  canonicalFirstmateJson(request) === canonicalFirstmateJson(saved) &&
  request.originalIntent === edit.originalIntent &&
  request.generatedSpec === edit.prompt &&
  request.workflowId === (edit.workflowId ?? action.workflowId) &&
  `native:fmx/${request.expectedFleet.profile}` === profile.ref &&
  request.expectedFleet.sourceRevision === profile.orchestration?.sourceRevision &&
  JSON.stringify(request.projectTarget) === JSON.stringify(edit.projectTarget)

export const continuationConfirmedFirstmateSubmission = (
  draft: ContinuationDraft,
  actionId: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
) => {
  const { action, edit } = continuationAction(draft, actionId)
  const profile = continuationProfile(draft, actionId, profiles)
  if (profile?.orchestration === undefined) throw new Error("The Firstmate control contract is unavailable.")
  const submission = edit.firstmateSubmission
  if (edit.firstmateAction === undefined || submission === undefined) {
    throw new Error("Explicitly confirm Start fleet, Recover fleet, or Send work after choosing the specification and target.")
  }
  if (edit.status === ContinuationActionStatus.SubmissionRejected) {
    throw new Error("This request was rejected. Edit or prepare a new specification, then confirm a new request explicitly.")
  }
  const request = parseFirstmateSubmissionRequestV1(submission.request)
  if (!firstmateRequestMatchesAction(request, submission.request, edit, action, profile)) {
    throw new Error("The confirmed Firstmate request no longer matches its exact prompt, intent, target, workflow, and owned fleet.")
  }
  const targetProblem = continuationProjectTargetProblem(draft, actionId, profiles)
  if (targetProblem !== null) throw new Error(targetProblem)
  validateContinuationFinalPrompt(draft, actionId, request.generatedSpec, profiles)
  if (Buffer.byteLength(canonicalFirstmateJson(request), "utf8") > profile.orchestration.submission.maxRequestBytes) {
    throw new Error("The Firstmate request exceeds the profile's whole-request byte limit. Nothing was sent.")
  }
  return { action: edit.firstmateAction, request }
}

export const continuationPromptEditText = (
  draft: ContinuationDraft,
  actionId: string,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): string => {
  const { edit } = continuationAction(draft, actionId)
  if (edit.prompt === undefined) throw new Error("Prepare and choose a prompt before editing it.")
  const prepared = continuationPreparedGuidePrompt(draft, actionId, profiles)
  if (prepared === undefined) return edit.prompt
  validateContinuationFinalPrompt(draft, actionId, edit.prompt, profiles)
  return guideModelBodyCandidate(prepared.workflow, {
    title: "Continuation action", prompt: edit.prompt, notes: "Human-reviewed specification.",
  }, prepared.context).prompt
}

export const describeContinuationProjectTarget = (edit: ContinuationActionDraft, active = true): ReadonlyArray<string> => {
  const target = edit.projectTarget
  const state = !active ? "INACTIVE - not used by this profile"
    : edit.projectTargetConfirmed === true ? "CONFIRMED" : "PROPOSED - not confirmed"
  if (target === undefined) return ["Project target: NOT CONFIRMED. Source and destination directories are not a target."]
  if (target === null) return [`Project target: ${state}; fleet scope, no project.`, "Dirty changes: excluded. No working files are copied."]
  return [
    `Project target: ${state}`,
    `Registered project: ${target.projectName ?? "none"}`,
    `Source: ${target.source === null ? "registered project only" : `${target.source.kind} ${target.source.location}`}`,
    `Entry worktree: ${target.entryWorktree ?? "not applicable"}`,
    `Exact base revision: ${target.baseRevision ?? "not inspected; registered project only"}`,
    `Dirty source: ${target.dirty === null ? "not inspected" : target.dirty ? "yes" : "no"}`,
    "Dirty changes: excluded. No working files are copied.",
  ]
}

export const describeContinuationSubmission = (edit: ContinuationActionDraft): ReadonlyArray<string> => {
  const submission = edit.firstmateSubmission
  if (submission === undefined) return []
  const { request, receipt } = submission
  return [
    `Firstmate request: ${request.requestId}`,
    `Owned fleet: ${request.expectedFleet.profile}; instance ${request.expectedFleet.instanceId}`,
    `Receipt: ${receipt?.state ?? "not received"}; note ${receipt?.noteId ?? "not recorded"}`,
    `Announcement: ${receipt?.announcement ?? "not known"}`,
    ...(receipt === null ? [] : [`Fleet at receipt: ${firstmateSupervisorStatusText(receipt.supervisorState)} (receipt snapshot).`]),
    ...(edit.firstmateAction === undefined ? [] : [`Confirmed action: ${continuationFirstmateActionLabels[edit.firstmateAction]}`]),
    ...(edit.firstmateDiagnostic === undefined ? [] : [`Delivery diagnostic: ${edit.firstmateDiagnostic}`]),
    ...(receipt?.error === undefined || receipt.error === null ? [] : [`Control diagnostic: ${receipt.error.message}`]),
    "Acceptance or a handled note does not verify dispatch, completion, or prerequisite results.",
  ]
}

export const defaultContinuationPlacement = (
  draft: ContinuationDraft,
  action: NextAction,
): ContinuationPlacement => ({
  kind: ContinuationPlacementKind.NewWorktree,
  branch: `next-steps/${draft.id.replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 12) || "draft"}-${action.rank}`,
  baseRef: "HEAD",
})

export const hasSelectedContinuationPrerequisite = (draft: ContinuationDraft, actionId: string): boolean => {
  const { action } = continuationAction(draft, actionId)
  return draft.actions.some((other) =>
    other.selected && other.status !== ContinuationActionStatus.Launched &&
    other.status !== ContinuationActionStatus.Accepted && action.dependsOn.includes(other.actionId),
  )
}

export const continuationDependenciesWaiting = (draft: ContinuationDraft, actionId: string): boolean => {
  const { action, edit } = continuationAction(draft, actionId)
  return action.dependsOn.length > 0 && (
    edit.prerequisitesConfirmed !== true || hasSelectedContinuationPrerequisite(draft, actionId)
  )
}

const setEditableContinuationStatus = (
  edit: ContinuationActionDraft,
  status: ContinuationActionStatus.Draft | ContinuationActionStatus.Prepared | ContinuationActionStatus.Waiting,
): ContinuationActionDraft => {
  const next = { ...edit, status }
  if (edit.status !== ContinuationActionStatus.Failed || edit.launch === undefined) return next
  // A new draft must not relabel the receipt of a confirmed failed attempt.
  const { launch: _launch, ...draft } = next
  return draft
}

export const withContinuationWaitingStates = (draft: ContinuationDraft): ContinuationDraft => ({
  ...draft,
  actions: draft.actions.map((edit) => {
    if (continuationActionLocked(edit)) return edit
    const pending = hasSelectedContinuationPrerequisite(draft, edit.actionId) && edit.prerequisitesConfirmed
      ? { ...edit, prerequisitesConfirmed: false } : edit
    if (edit.status === ContinuationActionStatus.SubmissionRejected) return pending
    if (edit.selected && continuationDependenciesWaiting(draft, edit.actionId)) {
      return {
        ...setEditableContinuationStatus(pending, ContinuationActionStatus.Waiting),
        ...(hasSelectedContinuationPrerequisite(draft, edit.actionId) ? { prerequisitesConfirmed: false } : {}),
      }
    }
    if (edit.status === ContinuationActionStatus.Waiting) {
      return setEditableContinuationStatus(
        pending,
        edit.prompt === undefined ? ContinuationActionStatus.Draft : ContinuationActionStatus.Prepared,
      )
    }
    return pending
  }),
})

export const withContinuationPlacementDefaults = (draft: ContinuationDraft): ContinuationDraft =>
  withContinuationWaitingStates({
    ...draft,
    actions: draft.actions.map((edit) => {
      if (edit.placement !== undefined || edit.firstmateAction === "submit" || continuationActionLocked(edit)) return edit
      return { ...edit, placement: defaultContinuationPlacement(draft, continuationAction(draft, edit.actionId).action) }
    }),
  })

export type ContinuationActionChange = Partial<Pick<
  ContinuationActionDraft,
  "brief" | "selected" | "prompt" | "profileRef" | "workflowId" | "placement" |
  "prerequisitesConfirmed" | "sharedWriteConfirmed" | "selectedCandidateId" | "uncommittedChangesConfirmed" |
  "projectTarget" | "projectTargetConfirmed" | "firstmateInstance"
>>

export const requiresNewContinuationPrompt = (action: NextAction, edit: ContinuationActionDraft, next: ContinuationActionDraft): boolean =>
  next.brief !== edit.brief ||
  (next.profileRef ?? action.profileRef) !== (edit.profileRef ?? action.profileRef) ||
  (next.workflowId ?? action.workflowId) !== (edit.workflowId ?? action.workflowId) ||
  JSON.stringify(next.projectTarget) !== JSON.stringify(edit.projectTarget) ||
  next.projectTargetConfirmed !== edit.projectTargetConfirmed

export const invalidateContinuationPreparation = (edit: ContinuationActionDraft): ContinuationActionDraft => {
  if (continuationActionLocked(edit)) throw new Error("This action has a saved receipt or uncertain request and cannot be reset.")
  const {
    prompt: _prompt, candidates: _candidates, selectedCandidateId: _candidate,
    launch: _launch, firstmateSubmission: _submission, firstmateAction: _action,
    firstmateDiagnostic: _diagnostic, ...rest
  } = edit
  return {
    ...rest, status: ContinuationActionStatus.Draft,
    prerequisitesConfirmed: false, sharedWriteConfirmed: false, uncommittedChangesConfirmed: false,
  }
}

const changedContinuationSelection = (action: NextAction, edit: ContinuationActionDraft, change: ContinuationActionChange): boolean =>
  (change.profileRef !== undefined && change.profileRef !== (edit.profileRef ?? action.profileRef)) ||
  (change.workflowId !== undefined && change.workflowId !== (edit.workflowId ?? action.workflowId))

const editableContinuationChange = (
  action: NextAction,
  edit: ContinuationActionDraft,
  change: ContinuationActionChange,
): ContinuationActionDraft => {
  let next: ContinuationActionDraft = { ...edit, ...change }
  if (change.brief !== undefined && (change.brief !== edit.brief || edit.originalIntent === undefined)) {
    next = { ...next, originalIntent: validateGuideOriginalIntent(change.brief) }
  }
  if (change.projectTarget !== undefined) {
    next = {
      ...next,
      projectTarget: change.projectTarget === null ? null : parseGuideProjectTargetV1(change.projectTarget),
      projectTargetConfirmed: change.projectTargetConfirmed ?? false,
    }
  }
  if (changedContinuationSelection(action, edit, change) && edit.projectTarget !== undefined) {
    next = { ...next, projectTargetConfirmed: false }
  }
  if (change.profileRef !== undefined && change.profileRef !== (edit.profileRef ?? action.profileRef)) {
    const { firstmateInstance: _instance, ...unbound } = next
    next = unbound
  } else if (change.firstmateInstance !== undefined) {
    next = { ...next, firstmateInstance: parseFirstmateInstanceReferenceV1(change.firstmateInstance) }
  }
  return next
}

const changedInstanceApproval = (
  draft: ContinuationDraft, action: NextAction, edit: ContinuationActionDraft, next: ContinuationActionDraft,
): ContinuationActionDraft => {
  if (JSON.stringify(edit.firstmateInstance) === JSON.stringify(next.firstmateInstance)) return next
  const {
    firstmateSubmission: _submission, firstmateAction: _action, firstmateDiagnostic: _diagnostic,
    launch: _launch, ...rest
  } = next
  return {
    ...rest, status: next.prompt === undefined ? ContinuationActionStatus.Draft : ContinuationActionStatus.Prepared,
    ...(next.prompt === undefined || next.placement !== undefined ? {} : { placement: defaultContinuationPlacement(draft, action) }),
    sharedWriteConfirmed: false, uncommittedChangesConfirmed: false, prerequisitesConfirmed: false,
  }
}

export const changeContinuationAction = (
  draft: ContinuationDraft,
  actionId: string,
  change: ContinuationActionChange,
): ContinuationDraft => {
  const { action, edit } = continuationAction(draft, actionId)
  if (continuationActionLocked(edit) && Object.keys(change).some((key) => key !== "selected")) {
    throw new Error("This action has a saved receipt or uncertain request. Inspect and reconcile it; it cannot be edited or resent.")
  }
  let next = continuationActionLocked(edit) ? { ...edit, ...change }
    : changedInstanceApproval(draft, action, edit, editableContinuationChange(action, edit, change))
  if (requiresNewContinuationPrompt(action, edit, next)) {
    next = invalidateContinuationPreparation(next)
  } else if (change.prompt !== undefined && !continuationActionLocked(next)) {
    next = setEditableContinuationStatus(next, ContinuationActionStatus.Prepared)
  }
  if (!continuationActionLocked(next) && (change.prompt !== undefined || change.placement !== undefined)) {
    const { firstmateSubmission: _submission, firstmateAction: _action, firstmateDiagnostic: _diagnostic, ...rest } = next
    next = rest
  }
  if (change.placement !== undefined && JSON.stringify(change.placement) !== JSON.stringify(edit.placement)) {
    next = { ...next, sharedWriteConfirmed: false, uncommittedChangesConfirmed: false }
  }
  return withContinuationWaitingStates({
    ...draft,
    actions: draft.actions.map((current) => current.actionId === actionId ? next : current),
  })
}

export const selectContinuationCandidate = (
  draft: ContinuationDraft,
  actionId: string,
  candidateId: string,
  profiles: ReadonlyArray<ContinuationProfileOption> = [],
): ContinuationDraft => {
  const { edit } = continuationAction(draft, actionId)
  if (continuationActionLocked(edit)) throw new Error("This action has a saved receipt or uncertain request and cannot be edited or resent.")
  const candidate = edit.candidates?.find(({ id }) => id === candidateId)
  if (candidate === undefined) throw new Error("Choose a saved prompt candidate for this action.")
  const problem = continuationProjectTargetProblem(draft, actionId, profiles)
  if (problem !== null) throw new Error(problem)
  validateContinuationFinalPrompt(draft, actionId, candidate.prompt, profiles)
  return changeContinuationAction(draft, actionId, {
    selectedCandidateId: candidate.id,
    prompt: candidate.prompt,
  })
}

export const describeContinuationPromptOrigin = (edit: ContinuationActionDraft): string => {
  if (edit.selectedCandidateId === undefined) {
    return edit.candidates === undefined ? "No saved guide choices." : "Saved choice: none; explicitly choose a prompt"
  }
  const candidate = edit.candidates?.find(({ id }) => id === edit.selectedCandidateId)
  if (candidate === undefined) return `Saved candidate unavailable: ${edit.selectedCandidateId}.`
  return `${edit.prompt === candidate.prompt ? "Selected candidate" : "Edited from candidate"}: ${candidate.id}`
}

export const describeContinuationPlacement = (
  placement: ContinuationPlacement,
  sourceCwd: string,
): string => {
  switch (placement.kind) {
    case ContinuationPlacementKind.NewWorktree:
      return `New worktree: branch ${placement.branch}, base ${placement.baseRef}; source ${sourceCwd}`
    case ContinuationPlacementKind.CurrentWorkspacePane:
      return `Current workspace: new ${placement.direction} pane; shared writable ${sourceCwd}`
    case ContinuationPlacementKind.NewTab:
      return `New tab: shared writable ${sourceCwd}`
    case ContinuationPlacementKind.ExistingWorktree:
      return `Existing worktree: shared writable ${placement.path}`
  }
}

export interface ContinuationLaunchPlan {
  readonly ready: ReadonlyArray<ContinuationActionDraft>
  readonly waiting: ReadonlyArray<ContinuationActionDraft>
  readonly blocked: ReadonlyArray<string>
}

const continuationPlacementProblem = (
  edit: ContinuationActionDraft,
  branches: ReadonlySet<string>,
): string | null => {
  const placement = edit.placement
  if (placement === undefined) return "choose a destination."
  if (placement.kind !== ContinuationPlacementKind.NewWorktree && !edit.sharedWriteConfirmed) {
    return "explicitly confirm shared writable access."
  }
  if (placement.kind === ContinuationPlacementKind.NewWorktree) {
    if (!placement.branch.trim() || !placement.baseRef.trim()) return "branch and base ref must not be empty."
    if (branches.has(placement.branch)) return "use a separate worktree branch for each action."
  }
  if (placement.kind === ContinuationPlacementKind.ExistingWorktree && !placement.path.trim()) {
    return "enter an existing worktree path."
  }
  return null
}

const continuationLaunchProblem = (
  draft: ContinuationDraft,
  action: NextAction,
  edit: ContinuationActionDraft,
  profiles: ReadonlyArray<ContinuationProfileOption>,
  branches: ReadonlySet<string>,
): string | null => {
  const targetProblem = continuationProjectTargetProblem(draft, edit.actionId, profiles)
  if (targetProblem !== null) return targetProblem
  const profile = profiles.find(({ ref }) => ref === (edit.profileRef ?? action.profileRef))
  if (!profile?.workflows.some(({ id }) => id === (edit.workflowId ?? action.workflowId))) {
    return "select a known profile and workflow."
  }
  if (!edit.prompt?.trim() || edit.status === ContinuationActionStatus.Draft) {
    return "prepare and review the full outgoing prompt."
  }
  try {
    validateContinuationFinalPrompt(draft, edit.actionId, edit.prompt, profiles)
    if (profile.orchestration !== undefined) {
      const submission = continuationConfirmedFirstmateSubmission(draft, edit.actionId, profiles)
      if (submission.action === "submit") return null
    }
  } catch (error) {
    return error instanceof Error ? error.message : "invalid saved prompt"
  }
  return continuationPlacementProblem(edit, profile.orchestration === undefined ? branches : new Set())
}

export const continuationLaunchPlan = (
  draft: ContinuationDraft,
  profiles: ReadonlyArray<ContinuationProfileOption>,
): ContinuationLaunchPlan => {
  const ready: ContinuationActionDraft[] = []
  const waiting: ContinuationActionDraft[] = []
  const blocked: string[] = []
  const branches = new Set<string>()
  for (const edit of draft.actions) {
    if (!edit.selected || edit.status === ContinuationActionStatus.Launched || edit.status === ContinuationActionStatus.Accepted) continue
    const { action } = continuationAction(draft, edit.actionId)
    if (continuationNeedsReconciliation(edit)) {
      blocked.push(`${action.rank}. ${action.title}: needs reconciliation; do not resend.`)
      continue
    }
    if (continuationDependenciesWaiting(draft, edit.actionId)) {
      waiting.push(edit)
      continue
    }
    const problem = continuationLaunchProblem(draft, action, edit, profiles, branches)
    if (problem !== null) {
      blocked.push(`${action.rank}. ${action.title}: ${problem}`)
      continue
    }
    if (edit.firstmateAction !== "submit" && edit.placement?.kind === ContinuationPlacementKind.NewWorktree) {
      branches.add(edit.placement.branch)
    }
    ready.push(edit)
  }
  return { ready, waiting, blocked }
}

export const continuationFieldLabel: Readonly<Record<ContinuationField, string>> = {
  [ContinuationField.Model]: "Analysis and preparation model",
  [ContinuationField.Effort]: "Reasoning effort",
  [ContinuationField.Brief]: "Action brief",
  [ContinuationField.Prompt]: "Full outgoing prompt",
  [ContinuationField.Branch]: "New worktree branch",
  [ContinuationField.BaseRef]: "Worktree base ref",
  [ContinuationField.ExistingPath]: "Existing worktree path",
  [ContinuationField.ProjectPath]: "Local project repository path",
  [ContinuationField.ProjectName]: "Registered Firstmate project name",
}

export const continuationFieldLimit: Readonly<Record<ContinuationField, number>> = {
  [ContinuationField.Model]: conversationLimits.identifierChars,
  [ContinuationField.Effort]: 32,
  [ContinuationField.Brief]: conversationLimits.briefChars,
  [ContinuationField.Prompt]: conversationLimits.promptChars,
  [ContinuationField.Branch]: conversationLimits.identifierChars,
  [ContinuationField.BaseRef]: conversationLimits.identifierChars,
  [ContinuationField.ExistingPath]: conversationLimits.pathChars,
  [ContinuationField.ProjectPath]: conversationLimits.pathChars,
  [ContinuationField.ProjectName]: 128,
}

export const multilineContinuationField = (field: ContinuationField): boolean =>
  field === ContinuationField.Brief || field === ContinuationField.Prompt

const continuationLineCursor = (characters: ReadonlyArray<string>, cursor: number, command: ContinuationTextCommand): number => {
  const lineStart = characters.slice(0, cursor).lastIndexOf("\n") + 1
  const nextBreak = characters.indexOf("\n", cursor)
  const lineEnd = nextBreak < 0 ? characters.length : nextBreak
  switch (command) {
    case ContinuationTextCommand.Home:
      return lineStart
    case ContinuationTextCommand.End:
      return lineEnd
    case ContinuationTextCommand.Up: {
      const previousStart = characters.slice(0, Math.max(0, lineStart - 1)).lastIndexOf("\n") + 1
      return lineStart === 0 ? cursor : previousStart + Math.min(cursor - lineStart, lineStart - previousStart - 1)
    }
    case ContinuationTextCommand.Down: {
      const followingBreak = characters.indexOf("\n", lineEnd + 1)
      const followingEnd = followingBreak < 0 ? characters.length : followingBreak
      return nextBreak < 0 ? cursor : lineEnd + 1 + Math.min(cursor - lineStart, followingEnd - lineEnd - 1)
    }
    default:
      return cursor
  }
}

const moveContinuationCursor = (characters: ReadonlyArray<string>, cursor: number, command: ContinuationTextCommand): number => {
  switch (command) {
    case ContinuationTextCommand.Left:
      return Math.max(0, cursor - 1)
    case ContinuationTextCommand.Right:
      return Math.min(characters.length, cursor + 1)
    case ContinuationTextCommand.Start:
      return 0
    case ContinuationTextCommand.Finish:
      return characters.length
    default:
      return continuationLineCursor(characters, cursor, command)
  }
}

export const changeContinuationEditor = (
  editor: ContinuationEditor,
  command: ContinuationTextCommand,
  insertion = "",
): ContinuationEditor => {
  const characters = [...editor.value]
  const cursor = Math.min(characters.length, Math.max(0, editor.cursor))
  switch (command) {
    case ContinuationTextCommand.Insert: {
      const normalized = insertion.replace(/\r\n?/gu, "\n").replace(pastedControls, "")
      const added = multilineContinuationField(editor.field) ? normalized : normalized.replace(/[\n\t]/gu, " ")
      const limit = editor.maximumLength ?? continuationFieldLimit[editor.field]
      if (editor.value.length + added.length > limit) {
        throw new Error(`${continuationFieldLabel[editor.field]} is limited to ${limit} UTF-16 units. Nothing was truncated.`)
      }
      const incoming = [...added]
      return {
        ...editor,
        value: [...characters.slice(0, cursor), ...incoming, ...characters.slice(cursor)].join(""),
        cursor: cursor + incoming.length,
      }
    }
    case ContinuationTextCommand.Backspace:
      return { ...editor, value: [...characters.slice(0, Math.max(0, cursor - 1)), ...characters.slice(cursor)].join(""), cursor: Math.max(0, cursor - 1) }
    case ContinuationTextCommand.Delete:
      return { ...editor, value: [...characters.slice(0, cursor), ...characters.slice(cursor + 1)].join(""), cursor }
    case ContinuationTextCommand.Clear:
      return { ...editor, value: "", cursor: 0 }
    default:
      return { ...editor, cursor: moveContinuationCursor(characters, cursor, command) }
  }
}

export const continuationViewKey = (state: ContinuationUiState): string => {
  if (state.screen === ContinuationScreen.Messages) {
    return `${state.screen}:${state.draft.snapshot.id}:${state.draft.snapshot.messages[state.messageIndex]?.id ?? "empty"}`
  }
  if (state.screen === ContinuationScreen.Evidence) {
    return `${state.screen}:${state.draft.snapshot.id}:${state.evidenceActionId ?? "all"}:${state.evidenceIndex}`
  }
  return `${state.screen}:${state.actionIndex}:${state.optionIndex}:${state.candidateIndex}:${state.evidenceIndex}:${state.editor?.field ?? ""}`
}

export const continuationTextViewport = (lines: ReadonlyArray<string>, height: number, requestedStartLine: number) => {
  const viewportHeight = Math.max(1, height)
  const maximumStartLine = Math.max(0, lines.length - viewportHeight)
  const startLine = Math.max(0, Math.min(maximumStartLine, requestedStartLine))
  const visible = lines.slice(startLine, startLine + viewportHeight)
  return {
    text: visible.join("\n"),
    lines: visible,
    startLine,
    maximumStartLine,
    atStart: startLine === 0,
    atEnd: startLine === maximumStartLine,
  }
}

export const continuationStatusLabel = (draft: ContinuationDraft, edit: ContinuationActionDraft): string => {
  if (firstmateRejectionNeedsReconciliation(edit)) return "SUBMISSION UNKNOWN - rejection not verified; inspect the same request ID"
  if (edit.status === ContinuationActionStatus.Submitting) return "SUBMITTING - receipt not confirmed; do not resend"
  if (edit.status === ContinuationActionStatus.SubmissionUnknown) return "SUBMISSION UNKNOWN - NEEDS RECONCILIATION; do not resend"
  if (edit.status === ContinuationActionStatus.Accepted) return "ACCEPTED - note saved; work not verified"
  if (edit.status === ContinuationActionStatus.SubmissionRejected) return "SUBMISSION REJECTED - no accepted note reported"
  if (continuationNeedsReconciliation(edit)) return "NEEDS RECONCILIATION - no automatic resend"
  if (edit.status === ContinuationActionStatus.Launched) return "LAUNCHED - prompt delivered, work not verified"
  if (edit.selected && continuationDependenciesWaiting(draft, edit.actionId)) return "WAITING - prerequisite results not confirmed or selected in this batch"
  return edit.status.toLocaleUpperCase("en")
}
