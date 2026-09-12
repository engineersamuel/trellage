import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from "ink"
import {
  ContinuationOutcome,
  ContinuationPlacementKind,
  type ContinuationDraft,
  type NextAction,
} from "@trellage/guide-core"
import { sanitizeConversationSnapshot } from "@trellage/guide-core"
import { GuideEffort } from "./guide-api.ts"
import { describeGuideUiError, wrapGuideText } from "./guide-ui.tsx"
import { isSubmitInput } from "./input.ts"
import type { ContinuationServices, ContinuationSourceStatus } from "./continuation-services.ts"
import {
  changeContinuationAction,
  changeContinuationEditor,
  continuationAction,
  continuationActionLocked,
  continuationFieldLabel,
  continuationFieldLimit,
  continuationLaunchPlan,
  continuationNeedsReconciliation,
  continuationStatusLabel,
  continuationTextViewport,
  continuationViewKey,
  defaultContinuationPlacement,
  describeContinuationPlacement,
  describeContinuationPromptOrigin,
  hasSelectedContinuationPrerequisite,
  initialContinuationUiState,
  multilineContinuationField,
  rankedContinuationActions,
  selectContinuationCandidate,
  withContinuationPlacementDefaults,
  ContinuationField,
  ContinuationOperation,
  ContinuationSaveState,
  ContinuationScreen,
  ContinuationSplitDirection,
  ContinuationTextCommand,
  type ContinuationActionChange,
  type ContinuationEditor,
  type ContinuationUiState,
} from "./continuation-ui-state.ts"

// oxlint-disable-next-line no-control-regex -- Untrusted display text must not send terminal controls.
const displayControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu
const terminalText = (text: string): string => text.replace(/\r\n?/gu, "\n").replace(displayControls, "")
const sanitizedSnapshots = new WeakMap<object, ReturnType<typeof sanitizeConversationSnapshot>>()
const displaySnapshot = (draft: ContinuationDraft): ReturnType<typeof sanitizeConversationSnapshot> => {
  const cached = sanitizedSnapshots.get(draft.snapshot)
  if (cached !== undefined) return cached
  const sanitized = sanitizeConversationSnapshot(draft.snapshot)
  sanitizedSnapshots.set(draft.snapshot, sanitized)
  return sanitized
}

enum ContinuationErrorName {
  Abort = "AbortError",
}

const isCleanContinuationCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted || !(error instanceof Error) || error.name !== ContinuationErrorName.Abort) return false
  // SDK AbortErrors can also carry failed cleanup steps.
  return !("cleanupFailures" in error) || (Array.isArray(error.cleanupFailures) && error.cleanupFailures.length === 0)
}

const cancellableOperations = new Set([
  ContinuationOperation.Analyze,
  ContinuationOperation.Prepare,
  ContinuationOperation.Latest,
  ContinuationOperation.CheckSource,
])

const operationLabels: Readonly<Record<ContinuationOperation, string>> = {
  [ContinuationOperation.Idle]: "Ready",
  [ContinuationOperation.Save]: "Saving draft",
  [ContinuationOperation.Analyze]: "Analyzing conversation",
  [ContinuationOperation.Prepare]: "Preparing action with the guide",
  [ContinuationOperation.Latest]: "Capturing latest conversation",
  [ContinuationOperation.CheckSource]: "Checking the original source",
  [ContinuationOperation.Launch]: "Launching confirmed actions",
  [ContinuationOperation.Reload]: "Reloading saved receipts",
  [ContinuationOperation.Discard]: "Discarding the selected draft",
}

const focusedAction = (state: ContinuationUiState) => {
  const action = rankedContinuationActions(state.draft)[state.actionIndex]
  return action === undefined ? null : continuationAction(state.draft, action.id)
}

const fieldValue = (state: ContinuationUiState, field: ContinuationField): string => {
  if (field === ContinuationField.Model) return state.draft.model
  if (field === ContinuationField.Effort) return state.draft.effort
  const selected = focusedAction(state)
  if (selected === null) throw new Error("Choose an action first.")
  const placement = selected.edit.placement ?? defaultContinuationPlacement(state.draft, selected.action)
  switch (field) {
    case ContinuationField.Brief:
      return selected.edit.brief
    case ContinuationField.Prompt:
      if (selected.edit.prompt === undefined) throw new Error("Prepare and choose a prompt before editing it.")
      return selected.edit.prompt
    case ContinuationField.Branch:
      return placement.kind === ContinuationPlacementKind.NewWorktree ? placement.branch : ""
    case ContinuationField.BaseRef:
      return placement.kind === ContinuationPlacementKind.NewWorktree ? placement.baseRef : "HEAD"
    case ContinuationField.ExistingPath:
      return placement.kind === ContinuationPlacementKind.ExistingWorktree ? placement.path : state.draft.snapshot.source.cwd
  }
}

const editorDraft = (state: ContinuationUiState, editor: ContinuationEditor): ContinuationDraft => {
  const value = multilineContinuationField(editor.field) ? editor.value : editor.value.trim()
  if (!value.trim()) throw new Error(`${continuationFieldLabel[editor.field]} must not be empty. Your edit is still here.`)
  if (value.length > continuationFieldLimit[editor.field]) {
    throw new Error(`${continuationFieldLabel[editor.field]} exceeds its ${continuationFieldLimit[editor.field]} UTF-16 unit limit.`)
  }
  if (editor.field === ContinuationField.Model) return { ...state.draft, model: value }
  if (editor.field === ContinuationField.Effort) {
    if (!Object.values(GuideEffort).some((effort) => effort === value)) {
      throw new Error(`Choose an effort: ${Object.values(GuideEffort).join(", ")}.`)
    }
    return { ...state.draft, effort: value }
  }
  const selected = focusedAction(state)
  if (selected === null) throw new Error("Choose an action first.")
  return changeContinuationAction(state.draft, selected.action.id, actionTextChange(state, editor.field, value))
}

const actionTextChange = (
  state: ContinuationUiState,
  field: ContinuationField,
  value: string,
): ContinuationActionChange => {
  const selected = focusedAction(state)
  if (selected === null) throw new Error("Choose an action first.")
  const placement = selected.edit.placement ?? defaultContinuationPlacement(state.draft, selected.action)
  switch (field) {
    case ContinuationField.Brief:
      return { brief: value }
    case ContinuationField.Prompt:
      return { prompt: value }
    case ContinuationField.ExistingPath:
      return { placement: { kind: ContinuationPlacementKind.ExistingWorktree, path: value } }
    case ContinuationField.Branch:
      return { placement: { kind: ContinuationPlacementKind.NewWorktree, branch: value, baseRef: placement.kind === ContinuationPlacementKind.NewWorktree ? placement.baseRef : "HEAD" } }
    case ContinuationField.BaseRef:
      if (placement.kind !== ContinuationPlacementKind.NewWorktree) throw new Error("Choose a new worktree before changing its base.")
      return { placement: { ...placement, baseRef: value } }
    default:
      throw new Error("This field is not an action edit.")
  }
}

type ViewChange = Partial<Pick<
  ContinuationUiState,
  "screen" | "actionIndex" | "optionIndex" | "candidateIndex" | "evidenceIndex" |
  "evidenceActionId" | "evidenceReturnScreen" | "acknowledgeAdvanced"
  | "messageIndex" | "messageReturnScreen"
>>

/** All effects are explicit and serialized. React rendering never saves, infers, or launches. */
export class ContinuationUiController {
  private state: ContinuationUiState
  private savedDraft: ContinuationDraft
  private readonly listeners = new Set<() => void>()
  private abortController: AbortController | null = null
  private closeAfterSave = false
  private closed = false

  constructor(
    readonly services: ContinuationServices,
    initialDraft: ContinuationDraft,
    hasSavedDraft = false,
    private readonly onExit: (code: number) => void = () => undefined,
  ) {
    this.savedDraft = initialDraft
    this.state = initialContinuationUiState(initialDraft, hasSavedDraft)
  }

  getSnapshot = (): ContinuationUiState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private patch(change: Partial<ContinuationUiState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  fail(error: unknown): void {
    const message = terminalText(describeGuideUiError(error))
    if (this.state.saveState === ContinuationSaveState.Failed && this.state.error !== null) {
      this.patch({ notice: message })
      return
    }
    this.patch({ error: message, notice: null })
  }

  view(change: ViewChange): void {
    if (this.state.operation !== ContinuationOperation.Idle) return
    this.patch(change)
  }

  scroll(startLine: number): void {
    this.patch({ scroll: { ...this.state.scroll, [continuationViewKey(this.state)]: Math.max(0, startLine) } })
  }

  resume(): void {
    if (this.state.operation !== ContinuationOperation.Idle) return
    this.patch({
      screen: this.state.draft.assessment === undefined ? ContinuationScreen.Setup : ContinuationScreen.Overview,
      notice: "Saved draft resumed. No model call was made.",
    })
  }

  private canEdit(): boolean {
    if (this.closed) return false
    if (this.state.operation !== ContinuationOperation.Idle) return false
    if (this.state.saveState === ContinuationSaveState.RecoveryRequired) {
      this.fail(new Error("Saved state is not known. Reload receipts before editing or launching."))
      return false
    }
    return true
  }

  private canRun(): boolean {
    if (!this.canEdit()) return false
    if (this.state.saveState !== ContinuationSaveState.Saved || this.state.editor !== null) {
      this.fail(new Error("Save your edits before this operation. Unsaved changes remain in this window."))
      return false
    }
    return true
  }

  private accept(draft: ContinuationDraft, change: Partial<ContinuationUiState> = {}): void {
    this.savedDraft = draft
    this.patch({ draft, saveState: ContinuationSaveState.Saved, hasSavedDraft: true, ...change })
  }

  private async persist(draft: ContinuationDraft, change: Partial<ContinuationUiState> = {}): Promise<boolean> {
    if (!this.canEdit()) return false
    this.patch({ draft, operation: ContinuationOperation.Save, saveState: ContinuationSaveState.Saving, error: null })
    try {
      const saved = await this.services.save(draft)
      this.accept(saved, { error: null, notice: "Draft saved.", ...change })
      return true
    } catch (error) {
      this.patch({ saveState: ContinuationSaveState.Failed, error: `Save failed. ${terminalText(describeGuideUiError(error))}`, notice: "Changes remain here. Closing, inference, and launch are blocked until saved." })
      this.closeAfterSave = false
      return false
    } finally {
      this.patch({ operation: ContinuationOperation.Idle })
      if (this.closeAfterSave && this.state.saveState === ContinuationSaveState.Saved) this.finish()
    }
  }

  async save(): Promise<boolean> {
    if (this.state.editor !== null) return this.commitEditor()
    return this.persist(this.state.draft)
  }

  async changeAction(actionId: string, change: ContinuationActionChange): Promise<boolean> {
    if (!this.canEdit()) return false
    try {
      if (change.prerequisitesConfirmed && hasSelectedContinuationPrerequisite(this.state.draft, actionId)) {
        throw new Error("A prerequisite is selected in this batch. Keep this action waiting; verify the prerequisite results before confirming them.")
      }
      const next = withContinuationPlacementDefaults(changeContinuationAction(this.state.draft, actionId, change))
      return await this.persist(next, { sourceStatus: null, acknowledgeAdvanced: false })
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  edit(field: ContinuationField): void {
    if (!this.canEdit()) return
    try {
      const selected = focusedAction(this.state)
      if (field !== ContinuationField.Model && field !== ContinuationField.Effort && selected !== null && continuationActionLocked(selected.edit)) {
        throw new Error("This action has a launch receipt. Inspect it instead of editing or resending.")
      }
      const value = fieldValue(this.state, field)
      this.patch({
        screen: ContinuationScreen.Editor,
        editor: { field, value, cursor: [...value].length, returnScreen: this.state.screen },
      })
    } catch (error) {
      this.fail(error)
    }
  }

  text(command: ContinuationTextCommand, insertion = ""): void {
    if (!this.canEdit() || this.state.editor === null) return
    try {
      const editor = changeContinuationEditor(this.state.editor, command, insertion)
      this.patch({
        editor,
        ...(this.state.saveState === ContinuationSaveState.Failed ? {} : { error: null }),
      })
    } catch (error) {
      this.fail(error)
    }
  }

  async commitEditor(): Promise<boolean> {
    const editor = this.state.editor
    if (editor === null || !this.canEdit()) return false
    try {
      return await this.persist(withContinuationPlacementDefaults(editorDraft(this.state, editor)), {
        editor: null,
        screen: editor.returnScreen,
        sourceStatus: null,
        acknowledgeAdvanced: false,
      })
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  private progress = (message: string): void => {
    this.patch({ progress: [...this.state.progress, terminalText(message)].slice(-8) })
  }

  private async recover(draft: ContinuationDraft, error: unknown, cancelled: boolean): Promise<void> {
    const failure = cancelled ? null : terminalText(describeGuideUiError(error))
    try {
      this.accept(await this.services.reload(draft), {
        screen: ContinuationScreen.Overview,
        error: failure,
        notice: cancelled ? "Cancelled. Saved work is kept; nothing was launched automatically." : "Saved state reloaded. Review the error and receipts before retrying.",
      })
    } catch (reloadError) {
      this.patch({
        screen: ContinuationScreen.Overview,
        saveState: ContinuationSaveState.RecoveryRequired,
        error: [failure, `Cannot reload saved state. ${terminalText(describeGuideUiError(reloadError))}`]
          .filter((message) => message !== null)
          .join("\n"),
        notice: "Needs reconciliation. Reload receipts before editing or launch. No automatic resend.",
      })
    }
  }

  private async run(
    operation: ContinuationOperation,
    work: (draft: ContinuationDraft, signal: AbortSignal) => Promise<ContinuationDraft>,
    screen: (draft: ContinuationDraft) => ContinuationScreen,
  ): Promise<void> {
    if (!this.canRun()) return
    const before = this.state.draft
    const controller = new AbortController()
    this.abortController = controller
    this.patch({ operation, cancelling: false, progress: [], error: null, notice: null })
    try {
      const result = await work(before, controller.signal)
      if (controller.signal.aborted) {
        await this.recover(result, controller.signal.reason, true)
      } else {
        this.accept(result, { screen: screen(result), sourceStatus: null, acknowledgeAdvanced: false })
      }
    } catch (error) {
      await this.recover(before, error, isCleanContinuationCancellation(error, controller.signal))
    } finally {
      this.abortController = null
      this.patch({ operation: ContinuationOperation.Idle, cancelling: false })
    }
  }

  async analyze(): Promise<void> {
    if (this.state.draft.assessment !== undefined) {
      this.fail(new Error("This assessment is saved. Resume it, or choose Analyze latest to keep the old draft."))
      return
    }
    try {
      this.services.estimate(this.state.draft.snapshot)
      await this.run(ContinuationOperation.Analyze,
        (draft, signal) => this.services.analyze(draft, signal, this.progress),
        () => ContinuationScreen.Overview)
    } catch (error) {
      this.fail(error)
    }
  }

  async prepare(actionId: string): Promise<void> {
    try {
      const { edit } = continuationAction(this.state.draft, actionId)
      if (continuationActionLocked(edit)) throw new Error("This action needs receipt inspection, not another preparation or launch.")
      await this.run(ContinuationOperation.Prepare,
        (draft, signal) => this.services.prepare(draft, actionId, signal, this.progress),
        (draft) => continuationAction(draft, actionId).edit.candidates?.length ? ContinuationScreen.Candidates : ContinuationScreen.Prompt)
      if (this.getSnapshot().screen === ContinuationScreen.Candidates) this.patch({ candidateIndex: 0 })
    } catch (error) {
      this.fail(error)
    }
  }

  async chooseCandidate(actionId: string, candidateId: string): Promise<boolean> {
    if (!this.canEdit()) return false
    try {
      const draft = selectContinuationCandidate(this.state.draft, actionId, candidateId)
      return await this.persist(draft, { screen: ContinuationScreen.Prompt, sourceStatus: null, acknowledgeAdvanced: false })
    } catch (error) {
      this.fail(error)
      return false
    }
  }

  async latest(): Promise<void> {
    if (this.state.screen !== ContinuationScreen.LatestConfirmation) return
    await this.run(ContinuationOperation.Latest,
      (draft, signal) => this.services.latest(draft, signal),
      () => ContinuationScreen.Setup)
    if (this.getSnapshot().screen === ContinuationScreen.Setup) {
      this.patch({
        hasSavedDraft: false,
        actionIndex: 0,
        optionIndex: 0,
        candidateIndex: 0,
        evidenceIndex: 0,
        evidenceActionId: null,
        messageIndex: 0,
        messageReturnScreen: ContinuationScreen.Setup,
        scroll: {},
        notice: "Latest snapshot saved. Review model and call count, then explicitly Analyze. The previous draft was kept.",
      })
    }
  }

  async reload(): Promise<void> {
    if (this.state.operation !== ContinuationOperation.Idle) return
    if (this.state.saveState === ContinuationSaveState.Failed || this.state.editor !== null) {
      this.fail(new Error("Reload would replace unsaved edits. Save them first."))
      return
    }
    this.patch({ operation: ContinuationOperation.Reload })
    try {
      this.accept(await this.services.reload(this.state.draft), { error: null, notice: "Saved receipts reloaded. Uncertain actions were not resent." })
    } catch (error) {
      this.patch({ saveState: ContinuationSaveState.RecoveryRequired })
      this.fail(error)
    } finally {
      this.patch({ operation: ContinuationOperation.Idle })
    }
  }

  private sourceAllowsReview(status: ContinuationSourceStatus): boolean {
    this.patch({ sourceStatus: status, acknowledgeAdvanced: false })
    if (status.sameSource) return true
    this.patch({ screen: ContinuationScreen.Overview })
    this.fail(new Error("Launch blocked: the original focused pane is missing or contains a different conversation. Nothing was launched."))
    return false
  }

  async reviewLaunch(): Promise<void> {
    if (!this.canRun()) return
    if (!await this.persist(withContinuationPlacementDefaults(this.state.draft))) return
    if (this.closed) return
    const plan = continuationLaunchPlan(this.state.draft, this.services.profiles)
    if (plan.blocked.length > 0) {
      this.fail(new Error(plan.blocked.join("\n")))
      return
    }
    if (plan.ready.length === 0) {
      this.fail(new Error(plan.waiting.length > 0 ? "Selected actions are waiting for prerequisite results. No jobs will be launched." : "Select and prepare at least one unlaunched action."))
      return
    }
    const before = this.state.draft
    const controller = new AbortController()
    this.abortController = controller
    this.patch({ operation: ContinuationOperation.CheckSource, progress: [], error: null })
    try {
      const status = await this.services.checkSource(before, controller.signal)
      controller.signal.throwIfAborted()
      if (this.sourceAllowsReview(status)) this.patch({ screen: ContinuationScreen.LaunchConfirmation })
    } catch (error) {
      await this.recover(before, error, isCleanContinuationCancellation(error, controller.signal))
    } finally {
      this.abortController = null
      this.patch({ operation: ContinuationOperation.Idle, cancelling: false })
    }
  }

  private needsNewAcknowledgement(status: ContinuationSourceStatus, previous: ContinuationSourceStatus | null): boolean {
    return status.advanced && (!this.state.acknowledgeAdvanced || status.revision !== previous?.revision)
  }

  async confirmLaunch(): Promise<void> {
    if (this.state.screen !== ContinuationScreen.LaunchConfirmation || !this.canRun()) return
    const previousStatus = this.state.sourceStatus
    if (!previousStatus?.sameSource) return
    if (previousStatus.advanced && !this.state.acknowledgeAdvanced) {
      this.fail(new Error("The conversation advanced. Press a to acknowledge the older snapshot, or analyze latest."))
      return
    }
    const before = this.state.draft
    const controller = new AbortController()
    this.abortController = controller
    this.patch({ operation: ContinuationOperation.CheckSource, progress: [], error: null })
    try {
      const status = await this.services.checkSource(before, controller.signal)
      controller.signal.throwIfAborted()
      if (!status.sameSource) {
        this.sourceAllowsReview(status)
        return
      }
      if (this.needsNewAcknowledgement(status, previousStatus)) {
        this.patch({ sourceStatus: status, acknowledgeAdvanced: false })
        this.fail(new Error("The conversation advanced again. Review and acknowledge the new source warning before launch."))
        return
      }
      this.patch({ operation: ContinuationOperation.Launch })
      const result = await this.services.launch(before, status.advanced && this.state.acknowledgeAdvanced)
      this.accept(result, {
        screen: ContinuationScreen.Overview,
        sourceStatus: null,
        acknowledgeAdvanced: false,
        notice: result.actions.some(continuationNeedsReconciliation)
          ? "Needs reconciliation. Inspect saved pane receipts. Uncertain actions will not be resent."
          : "Launch results saved. Prompt delivery is not proof that any task completed.",
      })
    } catch (error) {
      await this.recover(before, error, isCleanContinuationCancellation(error, controller.signal))
    } finally {
      this.abortController = null
      this.patch({ operation: ContinuationOperation.Idle, cancelling: false })
    }
  }

  async discard(): Promise<void> {
    if (this.state.screen !== ContinuationScreen.DiscardConfirmation || this.state.operation !== ContinuationOperation.Idle) return
    this.patch({ operation: ContinuationOperation.Discard, error: null })
    try {
      await this.services.discard(this.savedDraft)
      this.finish()
    } catch (error) {
      this.fail(error)
    } finally {
      this.patch({ operation: ContinuationOperation.Idle })
    }
  }

  cancel(): void {
    if (!cancellableOperations.has(this.state.operation) || this.abortController === null) {
      this.patch({ notice: "Wait for this operation to finish. Delivery and saves cannot be safely interrupted." })
      return
    }
    this.patch({ cancelling: true, notice: "Cancellation requested. Waiting for abort and saved-state recovery." })
    this.abortController.abort()
  }

  async close(): Promise<void> {
    if (this.state.operation === ContinuationOperation.Save) {
      this.closeAfterSave = true
      this.patch({ notice: "Close requested. Waiting for a successful save." })
      return
    }
    if (this.state.operation !== ContinuationOperation.Idle) {
      this.cancel()
      return
    }
    if (this.state.editor !== null) {
      if (await this.commitEditor()) this.finish()
      return
    }
    if (this.state.saveState === ContinuationSaveState.Failed) {
      this.patch({ notice: "Close blocked: changes are not saved. Press s to retry, or explicitly discard this draft." })
      return
    }
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.onExit(0)
  }

  dispose(): void {
    this.abortController?.abort()
    this.listeners.clear()
  }
}

interface ContinuationDocument {
  readonly title: string
  readonly body: string
  readonly controls: ReadonlyArray<string>
  readonly focus?: string
  readonly cursorPrefix?: string
}

const sourceLines = (draft: ContinuationDraft): ReadonlyArray<string> => {
  const { snapshot } = draft
  const { source } = snapshot
  return [
    `Source: ${source.surface} / ${source.agent} / session ${source.sessionId}`,
    `Server: ${source.serverId}; workspace ${source.workspaceId}; pane ${source.paneId}${source.tabId === undefined ? "" : `; tab ${source.tabId}`}`,
    `Working directory: ${source.cwd}`,
    ...(source.profile === undefined ? [] : [`Source profile: ${source.profile}`]),
    ...(source.containerId === undefined ? [] : [`Container: ${source.containerId}; invocation ${source.invocationId ?? "not recorded"}`]),
    `Snapshot: ${snapshot.id}; captured ${snapshot.capturedAt}`,
    `Cutoff: ${snapshot.cutoff.messageId}, record ${snapshot.cutoff.recordIndex}; revision ${snapshot.revision}`,
    `Coverage: ${snapshot.coverage.complete ? "complete filtered history" : "INCOMPLETE SOURCE HISTORY"}; ${snapshot.messages.length} messages.`,
    ...snapshot.coverage.notices.map((notice) => `Coverage notice: ${notice}`),
    "Only completed, user-visible conversation messages are included.",
  ]
}

const setupDocument = (state: ContinuationUiState, services: ContinuationServices): ContinuationDocument => {
  let callPlan: string
  try {
    const plan = services.estimate(state.draft.snapshot)
    callPlan = `Planned calls: ${plan.summarizationCalls} summary + ${plan.assessmentCalls} assessment; maximum ${plan.maxCalls} including bounded repairs.`
  } catch (error) {
    callPlan = `Analysis blocked: cannot plan calls. ${describeGuideUiError(error)}`
  }
  const summaryLines = state.draft.summaries.map((summary) =>
    `Saved summary ${summary.key}; evidence: ${summary.evidenceIds.join(", ")}`,
  )
  return {
    title: state.hasSavedDraft && state.draft.assessment !== undefined ? "Resume saved continuation" : "Review source before analysis",
    body: [
      ...sourceLines(state.draft), "",
      `Model: ${state.draft.model}`,
      `Effort: ${state.draft.effort}`,
      "Model and effort can be changed before inference. No model call starts when this screen opens.",
      "New settings apply to the next inference call; saved prompts are not silently regenerated.",
      callPlan,
      `Saved summaries: ${state.draft.summaries.length}. Recent messages remain verbatim; summary evidence stays inspectable.`,
      ...summaryLines,
      state.draft.assessment === undefined
        ? "Analyze is explicit. Nothing is prepared or launched automatically."
        : "An assessment is already saved. Resume makes zero inference calls. Analyze latest keeps this draft.",
      "Analysis reports conversation claims. It does not inspect or verify repository work.",
    ].join("\n"),
    controls: [
      state.draft.assessment === undefined ? "a Analyze | r Resume saved state" : "r Resume assessment | n Analyze latest",
      "m Model | e Effort | v Evidence",
      "n Analyze latest | D Discard draft",
    ],
  }
}

const section = (heading: string, entries: ReadonlyArray<string>): ReadonlyArray<string> =>
  [heading, ...(entries.length > 0 ? entries.map((entry) => `- ${entry}`) : ["- None reported."])]

const actionCard = (draft: ContinuationDraft, action: NextAction, focused: boolean): ReadonlyArray<string> => {
  const { edit } = continuationAction(draft, action.id)
  return [
    `${focused ? ">" : " "} [${edit.selected ? "x" : " "}] ${action.rank}. ${action.title}`,
    `  ${action.importance.toLocaleUpperCase("en")} | ${continuationStatusLabel(draft, edit)}`,
    `  Why now: ${action.whyNow}`,
    `  Expected output: ${action.expectedOutput}`,
    `  Profile: ${edit.profileRef ?? action.profileRef}; workflow: ${edit.workflowId ?? action.workflowId}`,
    `  Evidence: ${action.evidenceIds.join(", ")}`,
    `  Prerequisites: ${action.dependsOn.join(", ") || "None"}${action.dependsOn.length > 0 ? `; results ${edit.prerequisitesConfirmed ? "explicitly confirmed" : "NOT confirmed"}` : ""}`,
    `  Access suggestion: ${action.access}. Read-only access is NOT enforced; shared writable access needs your confirmation.`,
  ]
}

const overviewDocument = (state: ContinuationUiState): ContinuationDocument => {
  const { assessment } = state.draft
  if (assessment === undefined) {
    return {
      title: "Continuation overview",
      body: ["No assessment is saved yet.", `Saved summaries: ${state.draft.summaries.length}.`, "Cancellation and errors do not discard the snapshot.", ...sourceLines(state.draft)].join("\n"),
      controls: ["r Source and model settings | a Analyze", "n Analyze latest | v Evidence | D Discard"],
    }
  }
  const actions = rankedContinuationActions(state.draft)
  const focused = actions[state.actionIndex]
  const cards = actions.flatMap((action) => ["", ...actionCard(state.draft, action, action.id === focused?.id)])
  const outcome = assessment.outcome === ContinuationOutcome.NeedsClarification
    ? "Needs clarification - no actions will be manufactured."
    : assessment.outcome === ContinuationOutcome.NoFurtherAction
      ? "No further action is recommended."
      : `${actions.length} distinct ranked actions. Choose any subset; none launch automatically.`
  return {
    title: "Continuation assessment",
    body: [
      `Goal: ${assessment.goal}`, outcome, "",
      ...section("Reported progress - not independently verified:", assessment.reportedProgress),
      ...section("Unresolved work:", assessment.unresolvedWork),
      ...section("Blockers:", assessment.blockers),
      ...section("Clarification questions:", assessment.questions),
      ...cards,
    ].join("\n"),
    controls: [
      "1-5/Up/Down Focus | Space Select | Enter Details",
      "v Evidence | l Review launch | u Reload receipts",
      "r Source/model | n Analyze latest | D Discard",
    ],
    ...(focused === undefined ? {} : { focus: `> [${continuationAction(state.draft, focused.id).edit.selected ? "x" : " "}] ${focused.rank}.` }),
  }
}

const actionDocument = (state: ContinuationUiState): ContinuationDocument => {
  const selected = focusedAction(state)
  if (selected === null) return overviewDocument(state)
  const { action, edit } = selected
  const placement = edit.placement ?? defaultContinuationPlacement(state.draft, action)
  const receipt = edit.launch
  return {
    title: `Action ${action.rank}: ${action.title}`,
    body: [
      ...actionCard(state.draft, action, true), "",
      `Goal: ${state.draft.assessment?.goal ?? "Not assessed"}`,
      "Action-specific brief:", edit.brief, "",
      `Destination: ${describeContinuationPlacement(placement, state.draft.snapshot.source.cwd)}`,
      `Prerequisite results: [${edit.prerequisitesConfirmed ? "x" : " "}] I have checked the required results.`,
      "A launched prerequisite is not completed work. A prerequisite selected in this batch keeps this action waiting.",
      `Shared writable access: [${edit.sharedWriteConfirmed ? "x" : " "}] explicitly confirmed for this destination.`,
      "Readiness: checked by the launch service before allocation; not verified by the assessor.",
      ...(receipt === undefined ? [] : [
        "", `Launch attempt: ${receipt.attemptId}; status ${receipt.status}`,
        `Saved pane: ${receipt.paneId ?? "not recorded"}; workspace: ${receipt.workspaceId ?? "not recorded"}`,
        `Saved destination: ${receipt.cwd ?? "not recorded"}`,
        `Receipt: ${receipt.message ?? "No additional message."}`,
      ]),
      ...(continuationNeedsReconciliation(edit) ? ["Inspect the saved pane and delivery before retrying elsewhere. Reload receipts; this action cannot be reset or resent here."] : []),
    ].join("\n"),
    controls: [
      "b Brief | p Profile | w Workflow | g Prepare",
      "o Full prompt | d Destination | v Evidence",
      "x Prerequisites | Space Select | l Review launch",
    ],
  }
}

const committedOnlyConfirmation = (confirmed: boolean | undefined): string =>
  `[${confirmed ? "x" : " "}] New worktree uses committed files only; exclude uncommitted source changes.`

const promptDocument = (state: ContinuationUiState): ContinuationDocument => {
  const selected = focusedAction(state)
  if (selected === null) return overviewDocument(state)
  const placement = selected.edit.placement ?? defaultContinuationPlacement(state.draft, selected.action)
  const newWorktree = placement.kind === ContinuationPlacementKind.NewWorktree
  return {
    title: `Full outgoing prompt - action ${selected.action.rank}`,
    body: [
      `Profile: ${selected.edit.profileRef ?? selected.action.profileRef}; workflow: ${selected.edit.workflowId ?? selected.action.workflowId}`,
      `Status: ${continuationStatusLabel(state.draft, selected.edit)}`,
      ...(selected.edit.candidates === undefined ? [] : [describeContinuationPromptOrigin(selected.edit)]),
      ...(newWorktree ? [committedOnlyConfirmation(selected.edit.uncommittedChangesConfirmed)] : []),
      "Full outgoing workflow/guide prompt. Scroll to inspect every line.",
      `Prompt characters: ${[...(selected.edit.prompt ?? "")].length}`,
      "", selected.edit.prompt ?? "No outgoing prompt is selected. Prepare this action first.",
    ].join("\n"),
    controls: [
      "e Edit prompt | g Prepare | c Choices",
      `d Destination | ${newWorktree ? "t Committed-only | " : ""}Space Select | l Review launch`,
    ],
  }
}

const candidateDocument = (state: ContinuationUiState): ContinuationDocument => {
  const selected = focusedAction(state)
  if (selected === null) return overviewDocument(state)
  const candidates = selected.edit.candidates ?? []
  const candidate = candidates[state.candidateIndex]
  return {
    title: `Prompt choice ${candidate === undefined ? 0 : state.candidateIndex + 1} of ${candidates.length} - action ${selected.action.rank}`,
    body: candidate === undefined ? "No saved guide choices. Press g to prepare this action." : [
      `Candidate: ${candidate.title}`,
      describeContinuationPromptOrigin(selected.edit),
      `Notes: ${candidate.notes}`,
      "The full workflow, generation, and optimization result is below. Nothing launches when a choice is selected.",
      `Prompt characters: ${[...candidate.prompt].length}`, "",
      candidate.prompt,
    ].join("\n"),
    controls: ["Left/Right Choice | Enter Use this prompt", "g Prepare again | Esc Action details"],
  }
}

const placementDocument = (state: ContinuationUiState): ContinuationDocument => {
  const selected = focusedAction(state)
  if (selected === null) return overviewDocument(state)
  const placement = selected.edit.placement ?? defaultContinuationPlacement(state.draft, selected.action)
  return {
    title: `Destination - action ${selected.action.rank}`,
    body: [
      describeContinuationPlacement(placement, state.draft.snapshot.source.cwd), "",
      `${placement.kind === ContinuationPlacementKind.NewWorktree ? ">" : " "} 1 New worktree - default; a separate branch for each writer`,
      `${placement.kind === ContinuationPlacementKind.CurrentWorkspacePane ? ">" : " "} 2 Current workspace - new pane, shared writable files`,
      `${placement.kind === ContinuationPlacementKind.NewTab ? ">" : " "} 3 New tab - shared writable source worktree`,
      `${placement.kind === ContinuationPlacementKind.ExistingWorktree ? ">" : " "} 4 Existing worktree - enter an explicit path`,
      "",
      "A model's read-only label is not an access boundary. These launchers can write.",
      placement.kind === ContinuationPlacementKind.NewWorktree
        ? committedOnlyConfirmation(selected.edit.uncommittedChangesConfirmed)
        : `[${selected.edit.sharedWriteConfirmed ? "x" : " "}] I explicitly allow this action to write in this shared destination.`,
      "No automatic stash, commit, merge, or copying of dirty files.",
      "Changing the destination clears shared writable confirmation.",
      "The launch service checks branch collisions, base refs, dirty source state, and profile readiness.",
    ].join("\n"),
    controls: ["1-4 Destination | b Branch | f Base | t Committed-only", "p Existing path | r Split direction | s Shared write"],
  }
}

const profileDocument = (state: ContinuationUiState, services: ContinuationServices): ContinuationDocument => {
  const selected = focusedAction(state)
  const workflowMode = state.screen === ContinuationScreen.Workflows
  const profile = services.profiles.find(({ ref }) => ref === (selected?.edit.profileRef ?? selected?.action.profileRef))
  const choices = workflowMode
    ? (profile?.workflows ?? []).map(({ id, description }) => `${id} - ${description}`)
    : services.profiles.map(({ ref, name, workflows }) => `${name} (${ref}); ${workflows.length} known workflows`)
  return {
    title: workflowMode ? "Choose workflow" : "Choose profile",
    body: [
      "Only catalog options are accepted. Changing a profile or workflow invalidates only this action's prepared prompt.",
      "",
      ...choices.map((choice, index) => `${index === state.optionIndex ? ">" : " "} ${choice}`),
      ...(choices.length === 0 ? ["No valid options are available. Return without changing this action."] : []),
    ].join("\n"),
    controls: ["Up/Down Choose | Enter Save selection"],
    focus: `> ${choices[state.optionIndex] ?? ""}`,
  }
}

const evidenceMessages = (state: ContinuationUiState) => {
  const ids = state.evidenceActionId === null ? null : continuationAction(state.draft, state.evidenceActionId).action.evidenceIds
  return displaySnapshot(state.draft).messages.filter(({ id }) => ids === null || ids.includes(id))
}

const evidenceDocument = (state: ContinuationUiState): ContinuationDocument => {
  const messages = evidenceMessages(state)
  const message = messages[state.evidenceIndex]
  return {
    title: `Evidence ${messages.length === 0 ? 0 : state.evidenceIndex + 1} of ${messages.length}`,
    body: message === undefined ? "No referenced messages are available." : [
      `Message ID: ${message.id}; ${message.role}; record ${message.recordIndex}`,
      `Snapshot cutoff: ${state.draft.snapshot.cutoff.messageId}; original source revision ${state.draft.snapshot.revision}`,
      "Evidence is conversation content, not independently verified results.",
      "This is a bounded viewport; no text is dropped from the saved message.",
      "", message.text,
    ].join("\n"),
    controls: ["Left/Right Previous/next message", "Up/Down Scroll | a All snapshot evidence"],
  }
}

const transcriptDocument = (state: ContinuationUiState): ContinuationDocument => {
  const snapshot = displaySnapshot(state.draft)
  const selected = snapshot.messages[state.messageIndex]
  return {
    title: `Messages ${selected === undefined ? 0 : state.messageIndex + 1} of ${snapshot.messages.length}`,
    body: selected?.text ?? "No extracted messages are available. Press Esc to return to the source review.",
    controls: ["Up/Down or k/j Previous/next | { / } First/last", "Home/End Start/end of message"],
  }
}

const editorDocument = (state: ContinuationUiState): ContinuationDocument => {
  const editor = state.editor
  if (editor === null) return overviewDocument(state)
  const chars = [...editor.value]
  const prefix = [
    `Buffer: ${editor.value.length}/${continuationFieldLimit[editor.field]} UTF-16 units. Saves on Enter, Ctrl+S, or Esc.`,
    "Ctrl+C saves before closing. A failed save keeps this buffer.",
    "",
  ]
  const beforeCursor = chars.slice(0, editor.cursor).join("")
  return {
    title: `Edit ${continuationFieldLabel[editor.field]}`,
    body: [
      ...prefix,
      `${beforeCursor}▌${chars.slice(editor.cursor).join("")}`,
    ].join("\n"),
    cursorPrefix: [...prefix, `${beforeCursor}▌`].join("\n"),
    controls: [
      "Arrows/Home/End Move | Ctrl+U Clear",
      multilineContinuationField(editor.field) ? "Alt+Enter Newline | Enter/Ctrl+S Save" : "Enter/Ctrl+S Save | Esc Save and return",
    ],
  }
}

const launchDocument = (state: ContinuationUiState, services: ContinuationServices): ContinuationDocument => {
  const plan = continuationLaunchPlan(state.draft, services.profiles)
  const readyLines = plan.ready.flatMap((edit) => {
    const { action } = continuationAction(state.draft, edit.actionId)
    return [
      "", `ACTION ${action.rank}: ${action.title}`,
      `Profile: ${edit.profileRef ?? action.profileRef}; workflow: ${edit.workflowId ?? action.workflowId}`,
      ...(edit.candidates === undefined ? [] : [describeContinuationPromptOrigin(edit)]),
      `Destination: ${edit.placement === undefined ? "not selected" : describeContinuationPlacement(edit.placement, state.draft.snapshot.source.cwd)}`,
      `Shared writable access confirmed: ${edit.sharedWriteConfirmed ? "yes" : "no"}`,
      ...(edit.placement?.kind === ContinuationPlacementKind.NewWorktree ? [committedOnlyConfirmation(edit.uncommittedChangesConfirmed)] : []),
      "FULL OUTGOING PROMPT:", edit.prompt ?? "not prepared", "END OF PROMPT",
    ]
  })
  return {
    title: "Confirm launch - nothing sent yet",
    body: [
      ...sourceLines(state.draft), "",
      state.sourceStatus?.advanced
        ? `WARNING: The same conversation advanced to ${state.sourceStatus.revision}. This assessment uses the older cutoff above.`
        : "Original source identity and revision checked. The launch service checks again before allocation.",
      ...(state.sourceStatus?.message === undefined ? [] : [state.sourceStatus.message]),
      `[${state.acknowledgeAdvanced ? "x" : " "}] I acknowledge newer conversation messages and want to use this older snapshot.`,
      `Ready to launch: ${plan.ready.length}. Waiting: ${plan.waiting.length}.`,
      ...plan.waiting.map((edit) => `WAITING: ${continuationAction(state.draft, edit.actionId).action.title}; prerequisite results are required. It will NOT be sent.`),
      ...plan.blocked.map((problem) => `BLOCKED: ${problem}`),
      "Review every destination and complete outgoing prompt below. Delivery is not task completion.",
      ...readyLines,
    ].join("\n"),
    controls: ["a Acknowledge advanced source | n Analyze latest", "Enter/l LAUNCH reviewed actions | Esc Keep draft"],
  }
}

const confirmationDocument = (state: ContinuationUiState): ContinuationDocument => {
  const discard = state.screen === ContinuationScreen.DiscardConfirmation
  return {
    title: discard ? "Confirm discard - draft not deleted" : "Analyze latest - keep previous draft",
    body: discard ? [
      `Draft: ${state.draft.id}; snapshot ${state.draft.snapshot.id}`,
      "Discard removes only this draft and its owned saved snapshot state.",
      "This also abandons edits still held in this window. This is not a way to stop any already launched job.",
      "Launched or uncertain jobs may still need receipt inspection before discarding.",
      "Press uppercase D only if you intend to discard. Esc keeps the draft.",
    ].join("\n") : [
      "Capture latest asks the source service for the same exact focused conversation.",
      "The previous assessment, action edits, prompts, and launch receipts remain saved in the previous draft.",
      "The new snapshot opens model and call-plan review. It will not run a model until you explicitly select Analyze.",
      "Press y to capture latest. Esc keeps working on the current draft.",
    ].join("\n"),
    controls: [discard ? "D DISCARD this draft | Esc Keep it" : "y Capture latest | Esc Keep current draft"],
  }
}

const screenDocuments: Readonly<Record<
  ContinuationScreen,
  (state: ContinuationUiState, services: ContinuationServices) => ContinuationDocument
>> = {
  [ContinuationScreen.Setup]: setupDocument,
  [ContinuationScreen.Overview]: overviewDocument,
  [ContinuationScreen.Action]: actionDocument,
  [ContinuationScreen.Editor]: editorDocument,
  [ContinuationScreen.Profiles]: profileDocument,
  [ContinuationScreen.Workflows]: profileDocument,
  [ContinuationScreen.Prompt]: promptDocument,
  [ContinuationScreen.Candidates]: candidateDocument,
  [ContinuationScreen.Placement]: placementDocument,
  [ContinuationScreen.Evidence]: evidenceDocument,
  [ContinuationScreen.Messages]: transcriptDocument,
  [ContinuationScreen.LaunchConfirmation]: launchDocument,
  [ContinuationScreen.LatestConfirmation]: confirmationDocument,
  [ContinuationScreen.DiscardConfirmation]: confirmationDocument,
}

const continuationDocument = (state: ContinuationUiState, services: ContinuationServices): ContinuationDocument => {
  if (state.operation !== ContinuationOperation.Idle && state.operation !== ContinuationOperation.Save) {
    return {
      title: state.cancelling ? "Cancelling - waiting for abort" : operationLabels[state.operation],
      body: [
        `Model: ${state.draft.model}; effort ${state.draft.effort}`,
        "The draft stays private. No other action's input is changed by this operation.",
        ...state.progress,
        state.cancelling ? "The AbortSignal was sent. This view stays open until the service finishes cancellation and saved-state recovery." : "",
      ].join("\n"),
      controls: [cancellableOperations.has(state.operation) ? "Esc/q/Ctrl+C Cancel and wait" : "Wait for durable results. Do not resend."],
    }
  }
  return screenDocuments[state.screen](state, services)
}

const openEvidence = (controller: ContinuationUiController, actionId: string | null): void => {
  controller.view({
    screen: ContinuationScreen.Evidence,
    evidenceIndex: 0,
    evidenceActionId: actionId,
    evidenceReturnScreen: controller.getSnapshot().screen,
  })
}

const openMessages = (controller: ContinuationUiController): void => {
  const state = controller.getSnapshot()
  if (state.screen === ContinuationScreen.Messages) return
  controller.view({ screen: ContinuationScreen.Messages, messageReturnScreen: state.screen })
}

const openProfileChoices = (controller: ContinuationUiController, workflows: boolean): void => {
  const state = controller.getSnapshot()
  const selected = focusedAction(state)
  if (selected === null) return
  const ref = selected.edit.profileRef ?? selected.action.profileRef
  const profile = controller.services.profiles.find((candidate) => candidate.ref === ref)
  const optionIndex = workflows
    ? profile?.workflows.findIndex(({ id }) => id === (selected.edit.workflowId ?? selected.action.workflowId)) ?? 0
    : controller.services.profiles.findIndex((candidate) => candidate.ref === ref)
  controller.view({
    screen: workflows ? ContinuationScreen.Workflows : ContinuationScreen.Profiles,
    optionIndex: Math.max(0, optionIndex),
  })
}

const toggleAction = (controller: ContinuationUiController): void => {
  const selected = focusedAction(controller.getSnapshot())
  if (selected !== null) void controller.changeAction(selected.action.id, { selected: !selected.edit.selected })
}

const step = (index: number, delta: number, count: number): number =>
  Math.min(Math.max(0, count - 1), Math.max(0, index + delta))

const movement = (input: string, key: Key): number => {
  if (key.upArrow || input === "k" || (key.tab && key.shift)) return -1
  if (key.downArrow || input === "j" || key.tab) return 1
  return 0
}

const setupInput = (controller: ContinuationUiController, input: string): void => {
  switch (input) {
    case "a": void controller.analyze(); break
    case "r": controller.resume(); break
    case "m": controller.edit(ContinuationField.Model); break
    case "e": controller.edit(ContinuationField.Effort); break
    case "v": openEvidence(controller, null); break
    case "n": controller.view({ screen: ContinuationScreen.LatestConfirmation }); break
    case "D": controller.view({ screen: ContinuationScreen.DiscardConfirmation }); break
  }
}

const overviewInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  const state = controller.getSnapshot()
  const actions = rankedContinuationActions(state.draft)
  const delta = movement(input, key)
  if (delta !== 0) {
    controller.view({ actionIndex: step(state.actionIndex, delta, actions.length) })
    return
  }
  const ordinal = /^[1-5]$/u.test(input) ? Number(input) - 1 : -1
  if (ordinal >= 0 && ordinal < actions.length) {
    controller.view({ actionIndex: ordinal })
    return
  }
  if (isSubmitInput(input, key) && actions.length > 0) controller.view({ screen: ContinuationScreen.Action })
  else if (input === " ") toggleAction(controller)
  else if (input === "l") void controller.reviewLaunch()
  else if (input === "r") controller.view({ screen: ContinuationScreen.Setup })
  else if (input === "v") openEvidence(controller, actions[state.actionIndex]?.id ?? null)
  else setupInput(controller, input)
}

const actionInput = (controller: ContinuationUiController, input: string): void => {
  const selected = focusedAction(controller.getSnapshot())
  if (selected === null) return
  const handlers: Readonly<Record<string, () => void>> = {
    b: () => controller.edit(ContinuationField.Brief),
    p: () => openProfileChoices(controller, false),
    w: () => openProfileChoices(controller, true),
    g: () => { void controller.prepare(selected.action.id) },
    o: () => controller.view({ screen: ContinuationScreen.Prompt }),
    d: () => controller.view({ screen: ContinuationScreen.Placement }),
    v: () => openEvidence(controller, selected.action.id),
    x: () => { void controller.changeAction(selected.action.id, { prerequisitesConfirmed: !selected.edit.prerequisitesConfirmed }) },
    " ": () => toggleAction(controller),
    l: () => { void controller.reviewLaunch() },
  }
  handlers[input]?.()
}

const chooseProfileOption = async (controller: ContinuationUiController): Promise<void> => {
  const state = controller.getSnapshot()
  const selected = focusedAction(state)
  if (selected === null) return
  const workflowMode = state.screen === ContinuationScreen.Workflows
  const profile = workflowMode
    ? controller.services.profiles.find(({ ref }) => ref === (selected.edit.profileRef ?? selected.action.profileRef))
    : controller.services.profiles[state.optionIndex]
  const workflow = workflowMode ? profile?.workflows[state.optionIndex] : profile?.workflows[0]
  if (profile === undefined || workflow === undefined) {
    controller.fail(new Error("Choose a catalog profile with a known workflow."))
    return
  }
  const changed = await controller.changeAction(selected.action.id, { profileRef: profile.ref, workflowId: workflow.id })
  if (changed) controller.view({ screen: ContinuationScreen.Action })
}

const profileInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  const state = controller.getSnapshot()
  const selected = focusedAction(state)
  const profile = controller.services.profiles.find(({ ref }) => ref === (selected?.edit.profileRef ?? selected?.action.profileRef))
  const count = state.screen === ContinuationScreen.Workflows ? profile?.workflows.length ?? 0 : controller.services.profiles.length
  const delta = movement(input, key)
  if (delta !== 0) controller.view({ optionIndex: step(state.optionIndex, delta, count) })
  else if (isSubmitInput(input, key)) void chooseProfileOption(controller)
}

const placementChoice = (controller: ContinuationUiController, input: string): void => {
  const state = controller.getSnapshot()
  const selected = focusedAction(state)
  if (selected === null) return
  const placement = selected.edit.placement ?? defaultContinuationPlacement(state.draft, selected.action)
  switch (input) {
    case "1":
      void controller.changeAction(selected.action.id, { placement: placement.kind === ContinuationPlacementKind.NewWorktree ? placement : defaultContinuationPlacement(state.draft, selected.action) })
      break
    case "2":
      void controller.changeAction(selected.action.id, { placement: { kind: ContinuationPlacementKind.CurrentWorkspacePane, direction: ContinuationSplitDirection.Right } })
      break
    case "3":
      void controller.changeAction(selected.action.id, { placement: { kind: ContinuationPlacementKind.NewTab } })
      break
    case "4":
      controller.edit(ContinuationField.ExistingPath)
      break
  }
}

const placementInput = (controller: ContinuationUiController, input: string): void => {
  const state = controller.getSnapshot()
  const selected = focusedAction(state)
  if (selected === null) return
  const placement = selected.edit.placement ?? defaultContinuationPlacement(state.draft, selected.action)
  if (/^[1-4]$/u.test(input)) placementChoice(controller, input)
  else if (input === "b") controller.edit(ContinuationField.Branch)
  else if (input === "f") controller.edit(ContinuationField.BaseRef)
  else if (input === "p") controller.edit(ContinuationField.ExistingPath)
  else if (input === "t" && placement.kind === ContinuationPlacementKind.NewWorktree) {
    void controller.changeAction(selected.action.id, { uncommittedChangesConfirmed: !selected.edit.uncommittedChangesConfirmed })
  }
  else if (input === "s" && placement.kind !== ContinuationPlacementKind.NewWorktree) {
    void controller.changeAction(selected.action.id, { sharedWriteConfirmed: !selected.edit.sharedWriteConfirmed })
  } else if (input === "r" && placement.kind === ContinuationPlacementKind.CurrentWorkspacePane) {
    void controller.changeAction(selected.action.id, {
      placement: { ...placement, direction: placement.direction === ContinuationSplitDirection.Right ? ContinuationSplitDirection.Down : ContinuationSplitDirection.Right },
    })
  }
}

const promptInput = (controller: ContinuationUiController, input: string): void => {
  if (input === "e") controller.edit(ContinuationField.Prompt)
  else if (input === "c") openCandidates(controller)
  else if (input === "t") placementInput(controller, input)
  else actionInput(controller, input)
}

const openCandidates = (controller: ContinuationUiController): void => {
  const selected = focusedAction(controller.getSnapshot())
  const index = selected?.edit.candidates?.findIndex(({ id }) => id === selected.edit.selectedCandidateId) ?? 0
  controller.view({ screen: ContinuationScreen.Candidates, candidateIndex: Math.max(0, index) })
}

const candidateInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  const state = controller.getSnapshot()
  const selected = focusedAction(state)
  if (selected === null) return
  const candidates = selected.edit.candidates ?? []
  const delta = key.leftArrow ? -1 : key.rightArrow ? 1 : movement(input, key)
  if (delta !== 0) controller.view({ candidateIndex: step(state.candidateIndex, delta, candidates.length) })
  else if (isSubmitInput(input, key)) {
    const candidate = candidates[state.candidateIndex]
    if (candidate !== undefined) void controller.chooseCandidate(selected.action.id, candidate.id)
  } else actionInput(controller, input)
}

interface ContinuationViewport {
  readonly startLine: number
  readonly maximumStartLine: number
  readonly height: number
}

const evidenceInput = (controller: ContinuationUiController, input: string, key: Key, viewport: ContinuationViewport): void => {
  const state = controller.getSnapshot()
  const count = evidenceMessages(state).length
  if (key.leftArrow || input === "[") controller.view({ evidenceIndex: step(state.evidenceIndex, -1, count) })
  else if (key.rightArrow || input === "]") controller.view({ evidenceIndex: step(state.evidenceIndex, 1, count) })
  else if (input === "a") controller.view({ evidenceActionId: null, evidenceIndex: 0 })
  else {
    const delta = movement(input, key)
    if (delta !== 0) controller.scroll(Math.min(viewport.maximumStartLine, Math.max(0, viewport.startLine + delta)))
  }
}

const messageInput = (controller: ContinuationUiController, input: string, key: Key, viewport: ContinuationViewport): void => {
  const state = controller.getSnapshot()
  const count = state.draft.snapshot.messages.length
  if (key.upArrow || input === "k" || key.leftArrow || input === "[") controller.view({ messageIndex: step(state.messageIndex, -1, count) })
  else if (key.downArrow || input === "j" || key.rightArrow || input === "]") controller.view({ messageIndex: step(state.messageIndex, 1, count) })
  else if (input === "{") controller.view({ messageIndex: 0 })
  else if (input === "}") controller.view({ messageIndex: Math.max(0, count - 1) })
  else {
    const delta = movement(input, key)
    if (delta !== 0) controller.scroll(Math.min(viewport.maximumStartLine, Math.max(0, viewport.startLine + delta)))
  }
}

const editorCursorCommand = (input: string, key: Key): ContinuationTextCommand | null => {
  if (key.ctrl) {
    const commands: Readonly<Record<string, ContinuationTextCommand>> = {
      u: ContinuationTextCommand.Clear,
      a: ContinuationTextCommand.Start,
      e: ContinuationTextCommand.Finish,
    }
    return commands[input] ?? null
  }
  const commands: ReadonlyArray<readonly [boolean, ContinuationTextCommand]> = [
    [key.backspace, ContinuationTextCommand.Backspace],
    [key.delete, ContinuationTextCommand.Delete],
    [key.leftArrow, ContinuationTextCommand.Left],
    [key.rightArrow, ContinuationTextCommand.Right],
    [key.upArrow, ContinuationTextCommand.Up],
    [key.downArrow, ContinuationTextCommand.Down],
    [key.home, ContinuationTextCommand.Home],
    [key.end, ContinuationTextCommand.End],
  ]
  return commands.find(([active]) => active)?.[1] ?? null
}

const editorInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  const editor = controller.getSnapshot().editor
  if (editor === null) return
  if (key.ctrl && input === "c") {
    void controller.close()
  } else if (key.return && (key.meta || key.shift) && multilineContinuationField(editor.field)) {
    controller.text(ContinuationTextCommand.Insert, "\n")
  } else if (isSubmitInput(input, key) || key.escape || (key.ctrl && input === "s")) {
    void controller.commitEditor()
  } else editTextInput(controller, input, key)
}

const editTextInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  const command = editorCursorCommand(input, key)
  if (command !== null) controller.text(command)
  else if (!key.ctrl && !key.meta && input.length > 0) controller.text(ContinuationTextCommand.Insert, input)
}

const back = (controller: ContinuationUiController): void => {
  const state = controller.getSnapshot()
  if (state.screen === ContinuationScreen.Setup) {
    if (state.draft.assessment === undefined) void controller.close()
    else controller.view({ screen: ContinuationScreen.Overview })
  } else if (state.screen === ContinuationScreen.Evidence) {
    controller.view({ screen: state.evidenceReturnScreen })
  } else if (state.screen === ContinuationScreen.Messages) {
    controller.view({ screen: state.messageReturnScreen })
  } else if (state.screen === ContinuationScreen.Action || state.screen === ContinuationScreen.Overview) {
    controller.view({ screen: state.screen === ContinuationScreen.Action ? ContinuationScreen.Overview : ContinuationScreen.Setup })
  } else if (state.screen === ContinuationScreen.LatestConfirmation || state.screen === ContinuationScreen.DiscardConfirmation || state.screen === ContinuationScreen.LaunchConfirmation) {
    controller.view({ screen: state.draft.assessment === undefined ? ContinuationScreen.Setup : ContinuationScreen.Overview })
  } else controller.view({ screen: ContinuationScreen.Action })
}

const launchInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  const state = controller.getSnapshot()
  if (input === "a" && state.sourceStatus?.advanced) controller.view({ acknowledgeAdvanced: !state.acknowledgeAdvanced })
  else if (input === "n") controller.view({ screen: ContinuationScreen.LatestConfirmation })
  else if (input === "l" || isSubmitInput(input, key)) void controller.confirmLaunch()
}

const screenInputs: Readonly<Record<
  ContinuationScreen,
  (controller: ContinuationUiController, input: string, key: Key, viewport: ContinuationViewport) => void
>> = {
  [ContinuationScreen.Setup]: setupInput,
  [ContinuationScreen.Overview]: overviewInput,
  [ContinuationScreen.Action]: actionInput,
  [ContinuationScreen.Editor]: editorInput,
  [ContinuationScreen.Profiles]: profileInput,
  [ContinuationScreen.Workflows]: profileInput,
  [ContinuationScreen.Prompt]: promptInput,
  [ContinuationScreen.Candidates]: candidateInput,
  [ContinuationScreen.Placement]: placementInput,
  [ContinuationScreen.Evidence]: evidenceInput,
  [ContinuationScreen.Messages]: messageInput,
  [ContinuationScreen.LaunchConfirmation]: launchInput,
  [ContinuationScreen.LatestConfirmation]: (controller, input) => { if (input === "y") void controller.latest() },
  [ContinuationScreen.DiscardConfirmation]: (controller, input) => { if (input === "D") void controller.discard() },
}

const globalInput = (controller: ContinuationUiController, input: string, key: Key): boolean => {
  const state = controller.getSnapshot()
  if (key.ctrl && input === "c" || input === "q") void controller.close()
  else if (key.escape) back(controller)
  else if (key.ctrl && input === "s" || (input === "s" && state.saveState === ContinuationSaveState.Failed)) void controller.save()
  else if (input === "u") void controller.reload()
  else if (input === "t" && state.screen !== ContinuationScreen.Placement && state.screen !== ContinuationScreen.Prompt) openMessages(controller)
  else return false
  return true
}

const handleContinuationInput = (
  controller: ContinuationUiController,
  input: string,
  key: Key,
  viewport: ContinuationViewport,
): void => {
  const state = controller.getSnapshot()
  if (state.operation !== ContinuationOperation.Idle) {
    busyInput(controller, input, key)
    return
  }
  if (key.pageUp || key.pageDown) {
    const delta = Math.max(1, viewport.height - 1) * (key.pageUp ? -1 : 1)
    controller.scroll(Math.min(viewport.maximumStartLine, Math.max(0, viewport.startLine + delta)))
    return
  }
  if (state.screen === ContinuationScreen.Editor) {
    editorInput(controller, input, key)
    return
  }
  if (globalInput(controller, input, key)) return
  if (key.home || key.end) controller.scroll(key.home ? 0 : viewport.maximumStartLine)
  else screenInputs[state.screen](controller, input, key, viewport)
}

const busyInput = (controller: ContinuationUiController, input: string, key: Key): void => {
  if (input === "q" || key.escape || (key.ctrl && input === "c")) void controller.close()
}

const saveStatusText = (state: ContinuationUiState): string => {
  if (state.saveState === ContinuationSaveState.Failed) return "SAVE FAILED - edits kept here. s Retry save; q is blocked."
  if (state.saveState === ContinuationSaveState.RecoveryRequired) return "NEEDS RECONCILIATION - saved state unknown. u Reload; no resend."
  if (state.operation === ContinuationOperation.Save) return "Saving draft - wait for a durable save."
  if (state.editor !== null) return "EDIT BUFFER - Enter/Ctrl+S saves. Failures keep all edits."
  if (state.error !== null) return "ERROR - review the message at the top (Home). Draft kept."
  return `Draft saved - revision ${state.draft.revision}. No automatic launch.`
}

const continuationFeedback = (state: ContinuationUiState, width: number): ReadonlyArray<string> => {
  const message = state.error ?? state.notice
  return message === null ? [] : wrapGuideText(terminalText(message), width).slice(0, 2)
}

const continuationCommonControls = (state: ContinuationUiState): string => {
  if (state.operation === ContinuationOperation.Save) return "Wait for save | q/Ctrl+C Close after saving"
  if (cancellableOperations.has(state.operation)) return "Esc/q/Ctrl+C Cancel and wait"
  if (state.operation !== ContinuationOperation.Idle) return "Wait for saved results. No automatic resend."
  if (state.editor !== null) return "PgUp/PgDn Scroll | Esc Save/back | Ctrl+C Save/close"
  return state.screen === ContinuationScreen.Prompt || state.screen === ContinuationScreen.Placement
    ? "PgUp/PgDn Scroll | Esc Back | q/Ctrl+C Close"
    : "t View messages | PgUp/PgDn Scroll | Esc Back | q/Ctrl+C Close"
}

const useContinuationCursor = (
  controller: ContinuationUiController,
  editor: ContinuationEditor | null,
  cursorLine: number | null,
  width: number,
  viewport: ContinuationViewport,
): void => {
  const previous = useRef<{ readonly editor: ContinuationEditor | null; readonly line: number | null; readonly width: number; readonly height: number } | null>(null)
  useEffect(() => {
    const before = previous.current
    if (before?.editor === editor && before.line === cursorLine && before.width === width && before.height === viewport.height) return
    previous.current = { editor, line: cursorLine, width, height: viewport.height }
    if (cursorLine === null) return
    if (cursorLine < viewport.startLine) controller.scroll(cursorLine)
    else if (cursorLine >= viewport.startLine + viewport.height) controller.scroll(cursorLine - viewport.height + 1)
  }, [controller, editor, cursorLine, width, viewport.startLine, viewport.height])
}

export interface ContinuationAppProps {
  readonly initialDraft: ContinuationDraft
  readonly services: ContinuationServices
  readonly hasSavedDraft?: boolean
  readonly onExit?: (code: number) => void
}

export const ContinuationApp = (props: ContinuationAppProps): React.ReactElement => {
  const { exit } = useApp()
  const ref = useRef<ContinuationUiController | null>(null)
  if (ref.current === null) {
    ref.current = new ContinuationUiController(props.services, props.initialDraft, props.hasSavedDraft, (code) => {
      props.onExit?.(code)
      exit()
    })
  }
  const controller = ref.current
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { columns, rows } = useWindowSize()
  const width = Math.max(12, columns - 2)
  const document = continuationDocument(state, props.services)
  const controls = [...document.controls, continuationCommonControls(state)]
  const help = controls.flatMap((line) => wrapGuideText(line, width))
  const header = wrapGuideText(`TRX conversation next steps - ${document.title}`, width)
  const status = [...wrapGuideText(saveStatusText(state), width), ...continuationFeedback(state, width)]
  const height = Math.max(1, rows - header.length - status.length - help.length - 2)
  const bodyPrefix = [
    ...(state.error === null ? [] : [`ERROR: ${state.error}`, ""]),
    ...(state.notice === null ? [] : [state.notice, ""]),
  ]
  const showingMessages = state.screen === ContinuationScreen.Messages && state.operation === ContinuationOperation.Idle
  const snapshot = showingMessages ? displaySnapshot(state.draft) : null
  const selectedMessage = snapshot?.messages[state.messageIndex]
  const sidebarWidth = showingMessages && columns >= 100 ? Math.min(40, Math.floor(width / 3)) : 0
  const readerWidth = width - (sidebarWidth > 0 ? sidebarWidth + 2 : 0)
  const paneHeading = showingMessages ? wrapGuideText(terminalText([
    `Message ${selectedMessage === undefined ? 0 : state.messageIndex + 1} of ${snapshot!.messages.length} | ${selectedMessage?.role ?? "No message"}`,
    `Coverage: ${snapshot!.coverage.complete ? "complete" : "incomplete"} | Redactions marked`,
  ].join("\n")), readerWidth).slice(0, Math.max(0, height - 1)) : []
  const paneHeight = Math.max(1, height - paneHeading.length)
  const body = terminalText([...bodyPrefix, document.body].join("\n"))
  const lines = useMemo(() => wrapGuideText(body, readerWidth), [body, readerWidth])
  const cursorLine = document.cursorPrefix === undefined
    ? null : wrapGuideText(terminalText([...bodyPrefix, document.cursorPrefix].join("\n")), width).length - 1
  const viewKey = continuationViewKey(state)
  const viewport = continuationTextViewport(lines, paneHeight, state.scroll[viewKey] ?? 0)
  const sidebarHeight = Math.max(1, height - 1)
  const sidebarStart = Math.max(0, Math.min(
    (snapshot?.messages.length ?? 0) - sidebarHeight,
    state.messageIndex - Math.floor(sidebarHeight / 2),
  ))
  useContinuationCursor(controller, state.editor, cursorLine, width, { ...viewport, height: paneHeight })

  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => {
    if (state.scroll[viewKey] !== undefined || document.focus === undefined) return
    if (state.screen === ContinuationScreen.Overview && state.actionIndex === 0) return
    const index = lines.findIndex((line) => line.trimStart().startsWith(document.focus!.trimStart()))
    if (index > 0) controller.scroll(index)
  }, [controller, state.screen, state.actionIndex, state.optionIndex, viewKey, document.focus, lines, state.scroll])

  useInput((input, key) => handleContinuationInput(controller, input, key, { ...viewport, height: paneHeight }))
  usePaste((text) => {
    if (controller.getSnapshot().screen === ContinuationScreen.Editor) controller.text(ContinuationTextCommand.Insert, text)
  })

  return (
    <Box flexDirection="column" width={Math.max(12, columns)} paddingX={1}>
      <Text bold>{header.join("\n")}</Text>
      <Box flexDirection="row" height={height} overflowY="hidden">
        {sidebarWidth > 0 && <Box flexDirection="column" width={sidebarWidth} marginRight={2} flexShrink={0}>
          <Text bold>MESSAGES</Text>
          {snapshot!.messages.slice(sidebarStart, sidebarStart + sidebarHeight).map((message, index) => {
            const ordinal = sidebarStart + index
            return <Text key={message.id} bold={ordinal === state.messageIndex} wrap="truncate-end">
              {`${ordinal === state.messageIndex ? ">" : " "} ${String(ordinal + 1).padStart(3, " ")} ${message.role.padEnd(9, " ")} ${terminalText(message.text.slice(0, 200)).replace(/\s+/gu, " ").trim()}`}
            </Text>
          })}
        </Box>}
        <Box flexDirection="column" width={readerWidth} flexShrink={0}>
          {paneHeading.length > 0 && <Text bold>{paneHeading.join("\n")}</Text>}
          <Text>{viewport.text}</Text>
        </Box>
      </Box>
      <Text>{`Lines ${viewport.startLine + 1}-${viewport.startLine + viewport.lines.length}${viewport.atEnd ? " (end)" : " (more below)"}`}</Text>
      <Text bold {...(state.saveState === ContinuationSaveState.Failed || state.error !== null ? { color: "red" } : {})}>{status.join("\n")}</Text>
      <Text>{help.join("\n")}</Text>
    </Box>
  )
}
