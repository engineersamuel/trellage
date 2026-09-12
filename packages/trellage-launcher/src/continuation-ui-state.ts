import {
  ContinuationActionStatus,
  ContinuationPlacementKind,
  conversationLimits,
  type ContinuationActionDraft,
  type ContinuationDraft,
  type ContinuationPlacement,
  type NextAction,
} from "@trellage/guide-core"
import type { ContinuationProfileOption, ContinuationSourceStatus } from "./continuation-services.ts"

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
  edit.status === ContinuationActionStatus.Unknown

export const continuationNeedsReconciliation = (edit: ContinuationActionDraft): boolean =>
  edit.status === ContinuationActionStatus.Launching || edit.status === ContinuationActionStatus.Unknown

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
    other.selected && other.status !== ContinuationActionStatus.Launched && action.dependsOn.includes(other.actionId),
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
      if (edit.placement !== undefined || continuationActionLocked(edit)) return edit
      return { ...edit, placement: defaultContinuationPlacement(draft, continuationAction(draft, edit.actionId).action) }
    }),
  })

export type ContinuationActionChange = Partial<Pick<
  ContinuationActionDraft,
  "brief" | "selected" | "prompt" | "profileRef" | "workflowId" | "placement" |
  "prerequisitesConfirmed" | "sharedWriteConfirmed" | "selectedCandidateId" | "uncommittedChangesConfirmed"
>>

const requiresNewContinuationPrompt = (action: NextAction, edit: ContinuationActionDraft, change: ContinuationActionChange): boolean =>
  (change.brief !== undefined && change.brief !== edit.brief) ||
  (change.profileRef !== undefined && change.profileRef !== (edit.profileRef ?? action.profileRef)) ||
  (change.workflowId !== undefined && change.workflowId !== (edit.workflowId ?? action.workflowId))

export const changeContinuationAction = (
  draft: ContinuationDraft,
  actionId: string,
  change: ContinuationActionChange,
): ContinuationDraft => {
  const { action, edit } = continuationAction(draft, actionId)
  if (continuationActionLocked(edit) && Object.keys(change).some((key) => key !== "selected")) {
    throw new Error("This action has a launch receipt. Inspect and reconcile it; it cannot be edited or resent.")
  }
  let next: ContinuationActionDraft = { ...edit, ...change }
  if (requiresNewContinuationPrompt(action, edit, change)) {
    const { prompt: _prompt, candidates: _candidates, selectedCandidateId: _candidate, launch: _launch, ...rest } = next
    next = { ...rest, status: ContinuationActionStatus.Draft }
  } else if (change.prompt !== undefined && !continuationActionLocked(next)) {
    next = setEditableContinuationStatus(next, ContinuationActionStatus.Prepared)
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
): ContinuationDraft => {
  const { edit } = continuationAction(draft, actionId)
  const candidate = edit.candidates?.find(({ id }) => id === candidateId)
  if (candidate === undefined) throw new Error("Choose a saved prompt candidate for this action.")
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
  action: NextAction,
  edit: ContinuationActionDraft,
  profiles: ReadonlyArray<ContinuationProfileOption>,
  branches: ReadonlySet<string>,
): string | null => {
  const profile = profiles.find(({ ref }) => ref === (edit.profileRef ?? action.profileRef))
  if (!profile?.workflows.some(({ id }) => id === (edit.workflowId ?? action.workflowId))) {
    return "select a known profile and workflow."
  }
  if (!edit.prompt?.trim() || edit.status === ContinuationActionStatus.Draft) {
    return "prepare and review the full outgoing prompt."
  }
  return continuationPlacementProblem(edit, branches)
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
    if (!edit.selected || edit.status === ContinuationActionStatus.Launched) continue
    const { action } = continuationAction(draft, edit.actionId)
    if (continuationNeedsReconciliation(edit)) {
      blocked.push(`${action.rank}. ${action.title}: needs reconciliation; do not resend.`)
      continue
    }
    if (continuationDependenciesWaiting(draft, edit.actionId)) {
      waiting.push(edit)
      continue
    }
    const problem = continuationLaunchProblem(action, edit, profiles, branches)
    if (problem !== null) {
      blocked.push(`${action.rank}. ${action.title}: ${problem}`)
      continue
    }
    if (edit.placement?.kind === ContinuationPlacementKind.NewWorktree) branches.add(edit.placement.branch)
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
}

export const continuationFieldLimit: Readonly<Record<ContinuationField, number>> = {
  [ContinuationField.Model]: conversationLimits.identifierChars,
  [ContinuationField.Effort]: 32,
  [ContinuationField.Brief]: conversationLimits.briefChars,
  [ContinuationField.Prompt]: conversationLimits.promptChars,
  [ContinuationField.Branch]: conversationLimits.identifierChars,
  [ContinuationField.BaseRef]: conversationLimits.identifierChars,
  [ContinuationField.ExistingPath]: conversationLimits.pathChars,
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
      if (editor.value.length + added.length > continuationFieldLimit[editor.field]) {
        throw new Error(`${continuationFieldLabel[editor.field]} is limited to ${continuationFieldLimit[editor.field]} UTF-16 units. Nothing was truncated.`)
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
  if (continuationNeedsReconciliation(edit)) return "NEEDS RECONCILIATION - no automatic resend"
  if (edit.status === ContinuationActionStatus.Launched) return "LAUNCHED - prompt delivered, work not verified"
  if (edit.selected && continuationDependenciesWaiting(draft, edit.actionId)) return "WAITING - prerequisite results not confirmed or selected in this batch"
  return edit.status.toLocaleUpperCase("en")
}
