/**
 * Interactive Ink state machine for `trx guide`.
 *
 * `GuideApp` walks a user from a free-text intent through model-backed
 * profile matching, prompt generation/refinement, and destination selection,
 * then exits (via Ink's `useApp().exit`) with a single, fully validated
 * `GuideUiResult`. It never launches a command, creates a Herdr pane or
 * worktree, or mutates anything itself — the outer CLI performs the
 * confirmed side effect after this component exits, using only the plain
 * data (`profile`, `command`, `prompt`, IDs/paths) carried on the result.
 *
 * The reducer (`guideUiReducer`) and every state-derived helper in this file
 * are pure and exported so they can be unit tested without rendering Ink.
 */
import React, { useEffect, useReducer } from "react"
import { Box, Text, useApp, useInput, type Key } from "ink"

import { profileGuideIdentityKey, type ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { compactProfileGuide, type CombinedGuideCatalog } from "./guide-catalog.js"
import {
  applyWorkflowPromptTemplate,
  literalGuideMatch,
  publicGuideLaunchCommand,
  runGuideMatch,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
  type GuideEffort,
  type GuideRecommendation,
  type PublicGuideCommand,
} from "./guide-api.js"
import type { GuideGenerateCandidate, GuideProvider } from "./guide-provider.js"
import { loadSelectedGuide, type SelectedGuideDocument } from "./guide-selected.js"
import {
  buildGuideLaunchCommand,
  defaultWorktreeBranch,
  getHerdrContext,
  inspectGitWorktreeIntent,
  renderCommandPreview,
  type CommandRunner,
  type CommandSpec,
  type GitInspectionReady,
  type HerdrContext,
  type HerdrEnvironment,
  type HerdrSplitDirection,
  type PromptHandlingMode,
  type SelectedProfile,
  type WorktreeCollisionResult,
} from "./guide-launch.js"
import { checkSelectedProfileReadiness, ProfileReadinessKind, type ProfileReadinessResult } from "./guide-preflight.js"

// ---------------------------------------------------------------------------
// Shared small helpers.
// ---------------------------------------------------------------------------

type Triple<T> = readonly [T, T, T]

const intentMaxLength = 4000
const feedbackMaxLength = 2000
const branchMaxLength = 200
/** Mirrors guide-provider.ts's `validateGenerateCandidate` inline 8000-character prompt bound. */
const promptMaxLength = 8000
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u

/** True when appending `addition` to `current` would stay within `maxLength`. Shared by every bounded text editor. */
export const isWithinTextBound = (current: string, addition: string, maxLength: number): boolean =>
  current.length + addition.length <= maxLength

/** Surfaces a safe, non-leaky message for any thrown value. Never rethrows raw non-Error values. */
export const describeGuideUiError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "An unknown error occurred."

const isPrintableInput = (input: string, key: Key): boolean =>
  !key.ctrl && !key.meta && input.length > 0 && !controlCharacters.test(input)

/** Reads element `index` (0, 1, or 2) of a fixed-length triple without triggering `noUncheckedIndexedAccess`. */
const tripleAt = <T,>(items: Triple<T>, index: number): T => {
  const [first, second, third] = items
  if (index === 1) return second
  if (index === 2) return third
  return first
}

const replaceCandidateAt = <T,>(items: Triple<T>, index: number, value: T): Triple<T> => {
  const [first, second, third] = items
  if (index === 1) return [first, value, third]
  if (index === 2) return [first, second, value]
  return [value, second, third]
}

// ---------------------------------------------------------------------------
// Stage discriminant (string enum per repository convention).
// ---------------------------------------------------------------------------

export enum GuideUiStage {
  Intent = "intent",
  Matching = "matching",
  MatchFailed = "match-failed",
  Recommendations = "recommendations",
  Generating = "generating",
  GenerateFailed = "generate-failed",
  Candidates = "candidates",
  RefineEditor = "refine-editor",
  Refining = "refining",
  RefineFailed = "refine-failed",
  DirectEditor = "direct-editor",
  CheckingReadiness = "checking-readiness",
  ReadinessBlocked = "readiness-blocked",
  Destination = "destination",
  WorktreeBranchEditor = "worktree-branch-editor",
  InspectingWorktree = "inspecting-worktree",
  WorktreeCollision = "worktree-collision",
  WorktreeReady = "worktree-ready",
}

const editingStages: ReadonlySet<GuideUiStage> = new Set([
  GuideUiStage.RefineEditor,
  GuideUiStage.DirectEditor,
  GuideUiStage.WorktreeBranchEditor,
])

export enum GuideUiDestination {
  CurrentTerminal = "current-terminal",
  CurrentHerdrWorkspace = "current-herdr-workspace",
  NewHerdrWorktree = "new-herdr-worktree",
}

/** The destination choices offered, in display order. Herdr choices only appear when `herdrEnabled`. */
export const destinationOptions = (herdrEnabled: boolean): ReadonlyArray<GuideUiDestination> =>
  herdrEnabled
    ? [
        GuideUiDestination.CurrentTerminal,
        GuideUiDestination.CurrentHerdrWorkspace,
        GuideUiDestination.NewHerdrWorktree,
      ]
    : [GuideUiDestination.CurrentTerminal]

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

export interface GuideUiState {
  readonly stage: GuideUiStage
  /** The confirmed intent used for match/generate calls; `undefined` until the intent editor is submitted. */
  readonly intent: string | undefined
  /** Shared free-text editing buffer for the intent editor, refine feedback, direct edit, and worktree branch editors. */
  readonly textDraft: string
  readonly errorMessage: string | undefined
  readonly recommendations: Triple<GuideRecommendation> | undefined
  readonly recommendationIndex: number
  readonly usedLiteralFallback: boolean
  readonly selectedRecommendation: GuideRecommendation | undefined
  readonly selectedProfile: SelectedProfile | undefined
  readonly guideDocument: SelectedGuideDocument | undefined
  readonly candidates: Triple<GuideGenerateCandidate> | undefined
  readonly candidateIndex: number
  readonly usedTemplateFallback: boolean
  readonly selectedCandidate: GuideGenerateCandidate | undefined
  readonly readiness: ProfileReadinessResult | undefined
  readonly destinationIndex: number
  readonly worktreeBranch: string | undefined
  readonly worktreeInspection: GitInspectionReady | WorktreeCollisionResult | undefined
  readonly worktreeConfirmations: number
}

const emptyState: GuideUiState = {
  stage: GuideUiStage.Intent,
  intent: undefined,
  textDraft: "",
  errorMessage: undefined,
  recommendations: undefined,
  recommendationIndex: 0,
  usedLiteralFallback: false,
  selectedRecommendation: undefined,
  selectedProfile: undefined,
  guideDocument: undefined,
  candidates: undefined,
  candidateIndex: 0,
  usedTemplateFallback: false,
  selectedCandidate: undefined,
  readiness: undefined,
  destinationIndex: 0,
  worktreeBranch: undefined,
  worktreeInspection: undefined,
  worktreeConfirmations: 0,
}

/** Builds the initial state: goes straight to `Matching` when a non-empty `initialIntent` is supplied, otherwise `Intent`. */
export const createInitialGuideUiState = (initialIntent?: string): GuideUiState => {
  const trimmed = initialIntent?.trim()
  if (trimmed !== undefined && trimmed.length > 0) {
    return { ...emptyState, stage: GuideUiStage.Matching, intent: trimmed }
  }
  return { ...emptyState }
}

/** Number of distinct confirmations required before a new worktree may be created: two for a dirty source, one for clean. */
export const requiredWorktreeConfirmations = (dirty: boolean): number => (dirty ? 2 : 1)

export const isWorktreeConfirmed = (confirmations: number, dirty: boolean): boolean =>
  confirmations >= requiredWorktreeConfirmations(dirty)

const worktreeDirtyWarningMessage =
  "Uncommitted changes in the current working tree will not be included in the new worktree."

/** Explicit consequence text for a dirty source working tree; `undefined` when clean (nothing to warn about). */
export const worktreeDirtyWarning = (dirty: boolean): string | undefined =>
  dirty ? worktreeDirtyWarningMessage : undefined

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

/** String enum for every `GuideUiAction` discriminant, per repository TypeScript convention. */
export enum GuideUiActionType {
  IntentChange = "intent/change",
  IntentBackspace = "intent/backspace",
  IntentSubmit = "intent/submit",
  MatchRetry = "match/retry",
  MatchSucceeded = "match/succeeded",
  MatchFailed = "match/failed",
  MatchLiteral = "match/literal",
  MatchLiteralFailed = "match/literal-failed",
  RecommendationsMove = "recommendations/move",
  RecommendationsConfirm = "recommendations/confirm",
  GenerateGuideLoaded = "generate/guide-loaded",
  GenerateRetry = "generate/retry",
  GenerateSucceeded = "generate/succeeded",
  GenerateFailed = "generate/failed",
  GenerateTemplateFallback = "generate/template-fallback",
  GenerateTemplateFallbackFailed = "generate/template-fallback-failed",
  GenerateBack = "generate/back",
  CandidatesMove = "candidates/move",
  CandidatesConfirm = "candidates/confirm",
  CandidatesRefineStart = "candidates/refine-start",
  CandidatesDirectEditStart = "candidates/direct-edit-start",
  EditorChange = "editor/change",
  EditorBackspace = "editor/backspace",
  RefineSubmit = "refine/submit",
  RefineSucceeded = "refine/succeeded",
  RefineFailed = "refine/failed",
  RefineRetry = "refine/retry",
  RefineBack = "refine/back",
  DirectEditSubmit = "direct-edit/submit",
  DirectEditBack = "direct-edit/back",
  ReadinessReady = "readiness/ready",
  ReadinessBlocked = "readiness/blocked",
  ReadinessRetry = "readiness/retry",
  ReadinessBack = "readiness/back",
  DestinationMove = "destination/move",
  DestinationBack = "destination/back",
  DestinationStartWorktree = "destination/start-worktree",
  WorktreeSubmitBranch = "worktree/submit-branch",
  WorktreeInvalidBranch = "worktree/invalid-branch",
  WorktreeInspectFailed = "worktree/inspect-failed",
  WorktreeCollision = "worktree/collision",
  WorktreeReady = "worktree/ready",
  WorktreeConfirm = "worktree/confirm",
  WorktreeEditBranch = "worktree/edit-branch",
  WorktreeBack = "worktree/back",
}

export type GuideUiAction =
  | { readonly type: GuideUiActionType.IntentChange; readonly text: string }
  | { readonly type: GuideUiActionType.IntentBackspace }
  | { readonly type: GuideUiActionType.IntentSubmit }
  | { readonly type: GuideUiActionType.MatchRetry }
  | { readonly type: GuideUiActionType.MatchSucceeded; readonly recommendations: Triple<GuideRecommendation> }
  | { readonly type: GuideUiActionType.MatchFailed; readonly message: string }
  | { readonly type: GuideUiActionType.MatchLiteral; readonly recommendations: Triple<GuideRecommendation> }
  | { readonly type: GuideUiActionType.MatchLiteralFailed; readonly message: string }
  | { readonly type: GuideUiActionType.RecommendationsMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.RecommendationsConfirm; readonly selectedProfile: SelectedProfile }
  | { readonly type: GuideUiActionType.GenerateGuideLoaded; readonly guideDocument: SelectedGuideDocument }
  | { readonly type: GuideUiActionType.GenerateRetry }
  | { readonly type: GuideUiActionType.GenerateSucceeded; readonly candidates: Triple<GuideGenerateCandidate> }
  | { readonly type: GuideUiActionType.GenerateFailed; readonly message: string }
  | { readonly type: GuideUiActionType.GenerateTemplateFallback; readonly candidates: Triple<GuideGenerateCandidate> }
  | { readonly type: GuideUiActionType.GenerateTemplateFallbackFailed; readonly message: string }
  | { readonly type: GuideUiActionType.GenerateBack }
  | { readonly type: GuideUiActionType.CandidatesMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.CandidatesConfirm }
  | { readonly type: GuideUiActionType.CandidatesRefineStart }
  | { readonly type: GuideUiActionType.CandidatesDirectEditStart }
  | { readonly type: GuideUiActionType.EditorChange; readonly text: string }
  | { readonly type: GuideUiActionType.EditorBackspace }
  | { readonly type: GuideUiActionType.RefineSubmit }
  | { readonly type: GuideUiActionType.RefineSucceeded; readonly candidate: GuideGenerateCandidate }
  | { readonly type: GuideUiActionType.RefineFailed; readonly message: string }
  | { readonly type: GuideUiActionType.RefineRetry }
  | { readonly type: GuideUiActionType.RefineBack }
  | { readonly type: GuideUiActionType.DirectEditSubmit }
  | { readonly type: GuideUiActionType.DirectEditBack }
  | { readonly type: GuideUiActionType.ReadinessReady; readonly result: ProfileReadinessResult }
  | { readonly type: GuideUiActionType.ReadinessBlocked; readonly result: ProfileReadinessResult }
  | { readonly type: GuideUiActionType.ReadinessRetry }
  | { readonly type: GuideUiActionType.ReadinessBack }
  | { readonly type: GuideUiActionType.DestinationMove; readonly delta: 1 | -1; readonly optionCount: number }
  | { readonly type: GuideUiActionType.DestinationBack }
  | { readonly type: GuideUiActionType.DestinationStartWorktree }
  | { readonly type: GuideUiActionType.WorktreeSubmitBranch }
  | { readonly type: GuideUiActionType.WorktreeInvalidBranch }
  | { readonly type: GuideUiActionType.WorktreeInspectFailed; readonly message: string }
  | { readonly type: GuideUiActionType.WorktreeCollision; readonly inspection: WorktreeCollisionResult }
  | { readonly type: GuideUiActionType.WorktreeReady; readonly inspection: GitInspectionReady }
  | { readonly type: GuideUiActionType.WorktreeConfirm }
  | { readonly type: GuideUiActionType.WorktreeEditBranch }
  | { readonly type: GuideUiActionType.WorktreeBack }

// ---------------------------------------------------------------------------
// Reducer. Pure: every transition is guarded by the stage it applies to, and
// an action that does not apply to the current stage is a no-op.
// ---------------------------------------------------------------------------

/**
 * Each domain reducer below only handles its own slice of `GuideUiActionType`
 * and keeps every transition guarded by the stage it applies to (a no-op
 * otherwise). Splitting by domain keeps each function's cyclomatic and
 * cognitive complexity low; `guideUiReducer` itself is a plain table lookup
 * so it stays trivially simple regardless of how many action types exist.
 */

const reduceIntent = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.IntentChange:
      return state.stage === GuideUiStage.Intent ? { ...state, textDraft: action.text } : state

    case GuideUiActionType.IntentBackspace:
      return state.stage === GuideUiStage.Intent ? { ...state, textDraft: state.textDraft.slice(0, -1) } : state

    case GuideUiActionType.IntentSubmit: {
      if (state.stage !== GuideUiStage.Intent) return state
      const trimmed = state.textDraft.trim()
      if (trimmed.length === 0) return state
      return { ...emptyState, stage: GuideUiStage.Matching, intent: trimmed }
    }

    default:
      return state
  }
}

const recommendationsState = (
  state: GuideUiState,
  recommendations: Triple<GuideRecommendation>,
  usedLiteralFallback: boolean,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Recommendations,
  recommendations,
  recommendationIndex: 0,
  usedLiteralFallback,
  errorMessage: undefined,
})

const reduceMatch = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.MatchRetry:
      return state.stage === GuideUiStage.MatchFailed
        ? { ...state, stage: GuideUiStage.Matching, errorMessage: undefined }
        : state

    case GuideUiActionType.MatchSucceeded:
      return state.stage === GuideUiStage.Matching
        ? recommendationsState(state, action.recommendations, false)
        : state

    case GuideUiActionType.MatchFailed:
      return state.stage === GuideUiStage.Matching
        ? { ...state, stage: GuideUiStage.MatchFailed, errorMessage: action.message }
        : state

    case GuideUiActionType.MatchLiteral:
      return state.stage === GuideUiStage.MatchFailed
        ? recommendationsState(state, action.recommendations, true)
        : state

    case GuideUiActionType.MatchLiteralFailed:
      return state.stage === GuideUiStage.MatchFailed ? { ...state, errorMessage: action.message } : state

    default:
      return state
  }
}

const reduceRecommendations = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.RecommendationsMove:
      return state.stage === GuideUiStage.Recommendations
        ? { ...state, recommendationIndex: (state.recommendationIndex + action.delta + 3) % 3 }
        : state

    case GuideUiActionType.RecommendationsConfirm: {
      if (state.stage !== GuideUiStage.Recommendations || state.recommendations === undefined) return state
      return {
        ...state,
        stage: GuideUiStage.Generating,
        selectedRecommendation: tripleAt(state.recommendations, state.recommendationIndex),
        selectedProfile: action.selectedProfile,
        guideDocument: undefined,
        candidates: undefined,
        usedTemplateFallback: false,
        errorMessage: undefined,
      }
    }

    default:
      return state
  }
}

const candidatesState = (
  state: GuideUiState,
  candidates: Triple<GuideGenerateCandidate>,
  usedTemplateFallback: boolean,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Candidates,
  candidates,
  candidateIndex: 0,
  usedTemplateFallback,
  errorMessage: undefined,
})

const reduceGenerate = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.GenerateGuideLoaded:
      return state.stage === GuideUiStage.Generating ? { ...state, guideDocument: action.guideDocument } : state

    case GuideUiActionType.GenerateRetry:
      return state.stage === GuideUiStage.GenerateFailed
        ? { ...state, stage: GuideUiStage.Generating, errorMessage: undefined }
        : state

    case GuideUiActionType.GenerateSucceeded:
      return state.stage === GuideUiStage.Generating
        ? candidatesState(state, action.candidates, false)
        : state

    case GuideUiActionType.GenerateFailed:
      return state.stage === GuideUiStage.Generating
        ? { ...state, stage: GuideUiStage.GenerateFailed, errorMessage: action.message }
        : state

    case GuideUiActionType.GenerateTemplateFallback:
      return state.stage === GuideUiStage.GenerateFailed
        ? candidatesState(state, action.candidates, true)
        : state

    case GuideUiActionType.GenerateTemplateFallbackFailed:
      return state.stage === GuideUiStage.GenerateFailed ? { ...state, errorMessage: action.message } : state

    case GuideUiActionType.GenerateBack:
      return state.stage === GuideUiStage.GenerateFailed
        ? { ...state, stage: GuideUiStage.Recommendations, errorMessage: undefined }
        : state

    default:
      return state
  }
}

const reduceCandidateSelection = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.CandidatesMove:
      return state.stage === GuideUiStage.Candidates
        ? { ...state, candidateIndex: (state.candidateIndex + action.delta + 3) % 3 }
        : state

    case GuideUiActionType.CandidatesConfirm:
      return state.stage === GuideUiStage.Candidates && state.candidates !== undefined
        ? {
            ...state,
            stage: GuideUiStage.CheckingReadiness,
            selectedCandidate: tripleAt(state.candidates, state.candidateIndex),
            readiness: undefined,
          }
        : state

    case GuideUiActionType.CandidatesRefineStart:
      return state.stage === GuideUiStage.Candidates
        ? { ...state, stage: GuideUiStage.RefineEditor, textDraft: "", errorMessage: undefined }
        : state

    case GuideUiActionType.CandidatesDirectEditStart:
      return state.stage === GuideUiStage.Candidates && state.candidates !== undefined
        ? {
            ...state,
            stage: GuideUiStage.DirectEditor,
            textDraft: tripleAt(state.candidates, state.candidateIndex).prompt,
            errorMessage: undefined,
          }
        : state

    default:
      return state
  }
}

const reduceDirectEdit = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.DirectEditSubmit:
      return state.stage === GuideUiStage.DirectEditor &&
        state.candidates !== undefined &&
        state.textDraft.trim().length > 0
        ? {
            ...state,
            stage: GuideUiStage.Candidates,
            candidates: replaceCandidateAt(state.candidates, state.candidateIndex, {
              ...tripleAt(state.candidates, state.candidateIndex),
              prompt: state.textDraft,
            }),
          }
        : state

    case GuideUiActionType.DirectEditBack:
      return state.stage === GuideUiStage.DirectEditor ? { ...state, stage: GuideUiStage.Candidates } : state

    default:
      return state
  }
}

const reduceEditor = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.EditorChange:
      return editingStages.has(state.stage) ? { ...state, textDraft: action.text } : state

    case GuideUiActionType.EditorBackspace:
      return editingStages.has(state.stage) ? { ...state, textDraft: state.textDraft.slice(0, -1) } : state

    default:
      return state
  }
}

const reduceRefine = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.RefineSubmit:
      return state.stage === GuideUiStage.RefineEditor && state.textDraft.trim().length > 0
        ? { ...state, stage: GuideUiStage.Refining, errorMessage: undefined }
        : state

    case GuideUiActionType.RefineSucceeded:
      return state.stage === GuideUiStage.Refining && state.candidates !== undefined
        ? {
            ...state,
            stage: GuideUiStage.Candidates,
            candidates: replaceCandidateAt(state.candidates, state.candidateIndex, action.candidate),
            errorMessage: undefined,
          }
        : state

    case GuideUiActionType.RefineFailed:
      return state.stage === GuideUiStage.Refining
        ? { ...state, stage: GuideUiStage.RefineFailed, errorMessage: action.message }
        : state

    case GuideUiActionType.RefineRetry:
      return state.stage === GuideUiStage.RefineFailed
        ? { ...state, stage: GuideUiStage.Refining, errorMessage: undefined }
        : state

    case GuideUiActionType.RefineBack:
      return state.stage === GuideUiStage.RefineFailed || state.stage === GuideUiStage.RefineEditor
        ? { ...state, stage: GuideUiStage.Candidates, errorMessage: undefined }
        : state

    default:
      return state
  }
}

const reduceReadiness = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.ReadinessReady:
      return state.stage === GuideUiStage.CheckingReadiness
        ? { ...state, stage: GuideUiStage.Destination, readiness: action.result, destinationIndex: 0 }
        : state

    case GuideUiActionType.ReadinessBlocked:
      return state.stage === GuideUiStage.CheckingReadiness
        ? { ...state, stage: GuideUiStage.ReadinessBlocked, readiness: action.result }
        : state

    case GuideUiActionType.ReadinessRetry:
      return state.stage === GuideUiStage.ReadinessBlocked
        ? { ...state, stage: GuideUiStage.CheckingReadiness, readiness: undefined }
        : state

    case GuideUiActionType.ReadinessBack:
      return state.stage === GuideUiStage.ReadinessBlocked
        ? { ...state, stage: GuideUiStage.Candidates, readiness: undefined }
        : state

    default:
      return state
  }
}

const reduceDestination = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.DestinationMove:
      return state.stage === GuideUiStage.Destination && action.optionCount > 0
        ? {
            ...state,
            destinationIndex: (state.destinationIndex + action.delta + action.optionCount) % action.optionCount,
          }
        : state

    case GuideUiActionType.DestinationBack:
      return state.stage === GuideUiStage.Destination ? { ...state, stage: GuideUiStage.Candidates } : state

    case GuideUiActionType.DestinationStartWorktree:
      return state.stage === GuideUiStage.Destination
        ? {
            ...state,
            stage: GuideUiStage.WorktreeBranchEditor,
            textDraft: defaultWorktreeBranch(state.intent ?? ""),
            worktreeInspection: undefined,
            errorMessage: undefined,
          }
        : state

    default:
      return state
  }
}

const reduceWorktreeBranch = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.WorktreeSubmitBranch:
      return state.stage === GuideUiStage.WorktreeBranchEditor && state.textDraft.trim().length > 0
        ? {
            ...state,
            stage: GuideUiStage.InspectingWorktree,
            worktreeBranch: state.textDraft.trim(),
            errorMessage: undefined,
          }
        : state

    case GuideUiActionType.WorktreeInvalidBranch:
      return state.stage === GuideUiStage.InspectingWorktree
        ? {
            ...state,
            stage: GuideUiStage.WorktreeBranchEditor,
            textDraft: state.worktreeBranch ?? state.textDraft,
            errorMessage: "Invalid branch name.",
          }
        : state

    case GuideUiActionType.WorktreeInspectFailed:
      return state.stage === GuideUiStage.InspectingWorktree
        ? {
            ...state,
            stage: GuideUiStage.WorktreeBranchEditor,
            textDraft: state.worktreeBranch ?? state.textDraft,
            errorMessage: action.message,
          }
        : state

    default:
      return state
  }
}

const reduceWorktreeInspection = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.WorktreeCollision:
      return state.stage === GuideUiStage.InspectingWorktree
        ? { ...state, stage: GuideUiStage.WorktreeCollision, worktreeInspection: action.inspection }
        : state

    case GuideUiActionType.WorktreeReady:
      return state.stage === GuideUiStage.InspectingWorktree
        ? {
            ...state,
            stage: GuideUiStage.WorktreeReady,
            worktreeInspection: action.inspection,
            worktreeConfirmations: 0,
          }
        : state

    default:
      return state
  }
}

const reduceWorktreeResolution = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.WorktreeConfirm:
      return state.stage === GuideUiStage.WorktreeReady
        ? { ...state, worktreeConfirmations: state.worktreeConfirmations + 1 }
        : state

    case GuideUiActionType.WorktreeEditBranch:
      return state.stage === GuideUiStage.WorktreeCollision
        ? {
            ...state,
            stage: GuideUiStage.WorktreeBranchEditor,
            textDraft: state.worktreeBranch ?? "",
            errorMessage: undefined,
          }
        : state

    case GuideUiActionType.WorktreeBack:
      return state.stage === GuideUiStage.WorktreeBranchEditor ||
        state.stage === GuideUiStage.WorktreeCollision ||
        state.stage === GuideUiStage.WorktreeReady
        ? { ...state, stage: GuideUiStage.Destination, worktreeInspection: undefined, worktreeConfirmations: 0 }
        : state

    default:
      return state
  }
}

type GuideUiDomainReducer = (state: GuideUiState, action: GuideUiAction) => GuideUiState

/** Routes every action type to the single domain reducer that owns it. A plain table lookup, so this stays O(1) and trivially simple regardless of how many action types exist. */
const domainReducerByActionType: Record<GuideUiActionType, GuideUiDomainReducer> = {
  [GuideUiActionType.IntentChange]: reduceIntent,
  [GuideUiActionType.IntentBackspace]: reduceIntent,
  [GuideUiActionType.IntentSubmit]: reduceIntent,
  [GuideUiActionType.MatchRetry]: reduceMatch,
  [GuideUiActionType.MatchSucceeded]: reduceMatch,
  [GuideUiActionType.MatchFailed]: reduceMatch,
  [GuideUiActionType.MatchLiteral]: reduceMatch,
  [GuideUiActionType.MatchLiteralFailed]: reduceMatch,
  [GuideUiActionType.RecommendationsMove]: reduceRecommendations,
  [GuideUiActionType.RecommendationsConfirm]: reduceRecommendations,
  [GuideUiActionType.GenerateGuideLoaded]: reduceGenerate,
  [GuideUiActionType.GenerateRetry]: reduceGenerate,
  [GuideUiActionType.GenerateSucceeded]: reduceGenerate,
  [GuideUiActionType.GenerateFailed]: reduceGenerate,
  [GuideUiActionType.GenerateTemplateFallback]: reduceGenerate,
  [GuideUiActionType.GenerateTemplateFallbackFailed]: reduceGenerate,
  [GuideUiActionType.GenerateBack]: reduceGenerate,
  [GuideUiActionType.CandidatesMove]: reduceCandidateSelection,
  [GuideUiActionType.CandidatesConfirm]: reduceCandidateSelection,
  [GuideUiActionType.CandidatesRefineStart]: reduceCandidateSelection,
  [GuideUiActionType.CandidatesDirectEditStart]: reduceCandidateSelection,
  [GuideUiActionType.DirectEditSubmit]: reduceDirectEdit,
  [GuideUiActionType.DirectEditBack]: reduceDirectEdit,
  [GuideUiActionType.EditorChange]: reduceEditor,
  [GuideUiActionType.EditorBackspace]: reduceEditor,
  [GuideUiActionType.RefineSubmit]: reduceRefine,
  [GuideUiActionType.RefineSucceeded]: reduceRefine,
  [GuideUiActionType.RefineFailed]: reduceRefine,
  [GuideUiActionType.RefineRetry]: reduceRefine,
  [GuideUiActionType.RefineBack]: reduceRefine,
  [GuideUiActionType.ReadinessReady]: reduceReadiness,
  [GuideUiActionType.ReadinessBlocked]: reduceReadiness,
  [GuideUiActionType.ReadinessRetry]: reduceReadiness,
  [GuideUiActionType.ReadinessBack]: reduceReadiness,
  [GuideUiActionType.DestinationMove]: reduceDestination,
  [GuideUiActionType.DestinationBack]: reduceDestination,
  [GuideUiActionType.DestinationStartWorktree]: reduceDestination,
  [GuideUiActionType.WorktreeSubmitBranch]: reduceWorktreeBranch,
  [GuideUiActionType.WorktreeInvalidBranch]: reduceWorktreeBranch,
  [GuideUiActionType.WorktreeInspectFailed]: reduceWorktreeBranch,
  [GuideUiActionType.WorktreeCollision]: reduceWorktreeInspection,
  [GuideUiActionType.WorktreeReady]: reduceWorktreeInspection,
  [GuideUiActionType.WorktreeConfirm]: reduceWorktreeResolution,
  [GuideUiActionType.WorktreeEditBranch]: reduceWorktreeResolution,
  [GuideUiActionType.WorktreeBack]: reduceWorktreeResolution,
}

export const guideUiReducer = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  const domainReducer = (domainReducerByActionType as Partial<Record<string, GuideUiDomainReducer>>)[action.type]
  return domainReducer === undefined ? state : domainReducer(state, action)
}

// ---------------------------------------------------------------------------
// Deterministic literal-match enrichment. `literalGuideMatch` (guide-api.ts)
// returns bare candidates (profileRef/workflowId/confidence/reason/tradeoff);
// this mirrors guide-api.ts's private `enrichRecommendation` using only
// exported catalog data, since the model-match path already gets fully
// enriched `GuideRecommendation`s from `runGuideMatch`.
// ---------------------------------------------------------------------------

const findCombinedCatalogEntry = (
  catalog: CombinedGuideCatalog,
  ref: string,
):
  | {
      readonly native: boolean
      readonly entry: CombinedGuideCatalog["native"][number] | CombinedGuideCatalog["sandbox"][number]
    }
  | undefined => {
  const native = catalog.native.find(
    (entry) => profileGuideIdentityKey({ surface: "native", launcher: entry.launcher, profile: entry.name }) === ref,
  )
  if (native !== undefined) return { native: true, entry: native }
  const sandbox = catalog.sandbox.find(
    (entry) => profileGuideIdentityKey({ surface: "sandbox", profile: entry.name }) === ref,
  )
  if (sandbox !== undefined) return { native: false, entry: sandbox }
  return undefined
}

/** Enriches a deterministic literal-match candidate into the same `GuideRecommendation` shape the model-match path produces. */
export const enrichLiteralCandidate = (
  catalog: CombinedGuideCatalog,
  candidate: {
    readonly profileRef: string
    readonly workflowId: string
    readonly confidence: number
    readonly reason: string
    readonly tradeoff: string
  },
): GuideRecommendation => {
  const found = findCombinedCatalogEntry(catalog, candidate.profileRef)
  if (found === undefined) throw new Error(`Literal match references an unknown profile: ${candidate.profileRef}`)
  const { entry, native } = found
  const workflow = compactProfileGuide(entry.guide).workflows.find(({ id }) => id === candidate.workflowId)
  if (workflow === undefined) {
    throw new Error(`Literal match references an unknown workflow of ${candidate.profileRef}: ${candidate.workflowId}`)
  }
  return {
    profileRef: candidate.profileRef,
    workflowId: candidate.workflowId,
    confidence: candidate.confidence,
    reason: candidate.reason,
    tradeoff: candidate.tradeoff,
    surface: native ? "native" : "sandbox",
    name: entry.name,
    ...(native
      ? { launcher: (entry as CombinedGuideCatalog["native"][number]).launcher }
      : { harness: (entry as CombinedGuideCatalog["sandbox"][number]).harness.kind }),
    description: entry.description,
    sandbox: entry.sandbox,
    workflow,
    prerequisites: entry.guide.prerequisites,
    headless: entry.headless,
    herdrCompatibility: entry.herdrCompatibility,
  }
}

/** Computes the three deterministic, model-free literal-match recommendations, fully enriched for display. */
export const literalGuideRecommendations = (
  catalog: CombinedGuideCatalog,
  intent: string,
): Triple<GuideRecommendation> => {
  const [first, second, third] = literalGuideMatch(catalog, intent)
  return [
    enrichLiteralCandidate(catalog, first),
    enrichLiteralCandidate(catalog, second),
    enrichLiteralCandidate(catalog, third),
  ]
}

/** Computes deterministic template-based prompt candidates for the generate-failure fallback. */
export const templateGuideCandidates = (
  guide: ProfileGuideV1,
  workflowId: string,
  intent: string,
): Triple<GuideGenerateCandidate> => templatePromptCandidates(guide, workflowId, intent)

// ---------------------------------------------------------------------------
// Generation / refinement orchestration. Extracted as plain async functions
// (no React) so the "use the match-selected workflow, never re-match" and
// "refine stays constrained to the same intent/profile/workflow/guide/body"
// requirements are directly unit-testable with a fake `GuideProvider`.
// ---------------------------------------------------------------------------

export interface GuideGenerationStepResult {
  readonly guideDocument: SelectedGuideDocument
  readonly candidates: Triple<GuideGenerateCandidate>
}

/**
 * Loads only the recommendation's own guide, then calls `provider.generate`
 * with the recommendation's own `workflowId` and the loaded Markdown body.
 * Never re-runs matching and never recomputes the workflow.
 */
export const runGuideGenerationStep = async (
  catalog: CombinedGuideCatalog,
  guideRoot: string,
  provider: GuideProvider,
  intent: string,
  recommendation: GuideRecommendation,
  /**
   * Invoked synchronously right after the guide document loads, before
   * `provider.generate` is called. Lets the caller store the loaded guide
   * in state even when generation itself later fails, so template fallback
   * (which only needs the guide, not a successful generation) stays
   * available in that scenario.
   */
  onGuideLoaded?: (guideDocument: SelectedGuideDocument) => void,
): Promise<GuideGenerationStepResult> => {
  const guideDocument = await loadSelectedGuide(catalog, guideRoot, recommendation.profileRef)
  onGuideLoaded?.(guideDocument)
  const generated = await provider.generate({
    intent,
    profileRef: recommendation.profileRef,
    workflowId: recommendation.workflowId,
    guide: guideDocument.guide,
    guideBody: guideDocument.body,
  })
  const [first, second, third] = generated.candidates
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("Generation must return exactly three prompt candidates")
  }
  return {
    guideDocument,
    candidates: [
      applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, first),
      applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, second),
      applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, third),
    ],
  }
}

/**
 * Calls `provider.refine` constrained by the same intent, profile,
 * workflow, guide, and guide body as the original generation, plus the
 * candidate being refined and the user's feedback.
 */
export const runGuideRefinementStep = async (
  provider: GuideProvider,
  intent: string,
  recommendation: GuideRecommendation,
  guideDocument: SelectedGuideDocument,
  candidate: GuideGenerateCandidate,
  feedback: string,
): Promise<GuideGenerateCandidate> => {
  const refined = await provider.refine({
    intent,
    profileRef: recommendation.profileRef,
    workflowId: recommendation.workflowId,
    guide: guideDocument.guide,
    guideBody: guideDocument.body,
    candidate,
    feedback,
  })
  return applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, refined.candidate)
}

// ---------------------------------------------------------------------------
// Final result union. Every `command` here is built exclusively by
// application code (`buildGuideLaunchCommand`) from the selected internal
// `SelectedProfile` — never anything the model produced.
// ---------------------------------------------------------------------------

export interface GuideUiCancelResult {
  readonly action: "cancel"
  readonly exitCode: 130
}

export interface GuideUiPrintResult {
  readonly action: "print"
  readonly prompt: string
}

export interface GuideUiCurrentTerminalResult {
  readonly action: "current-terminal"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly promptHandling: PromptHandlingMode
  readonly prompt: string
  readonly cwd: string
}

export interface GuideUiCurrentHerdrWorkspaceResult {
  readonly action: "current-herdr-workspace"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly cwd: string
  readonly callerPaneId: string
  readonly direction: HerdrSplitDirection
}

export interface GuideUiNewHerdrWorktreeResult {
  readonly action: "herdr-worktree-create"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly primaryCheckoutPath: string
  readonly branch: string
  readonly baseRef: string
}

export interface GuideUiExistingHerdrWorktreeResult {
  readonly action: "herdr-worktree-open"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly primaryCheckoutPath: string
  readonly path: string
}

export type GuideUiResult =
  | GuideUiCancelResult
  | GuideUiPrintResult
  | GuideUiCurrentTerminalResult
  | GuideUiCurrentHerdrWorkspaceResult
  | GuideUiNewHerdrWorktreeResult
  | GuideUiExistingHerdrWorktreeResult

export const buildCancelResult = (): GuideUiCancelResult => ({ action: "cancel", exitCode: 130 })

export const buildPrintResult = (prompt: string): GuideUiPrintResult => ({ action: "print", prompt })

export const buildCurrentTerminalResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
): GuideUiCurrentTerminalResult => {
  const built = buildGuideLaunchCommand(profile, { mode: "argv", prompt })
  return {
    action: "current-terminal",
    profile,
    command: built.command,
    promptHandling: built.promptHandling,
    prompt,
    cwd,
  }
}

export const buildCurrentHerdrWorkspaceResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
  herdrContext: HerdrContext,
  direction: HerdrSplitDirection = "right",
): GuideUiCurrentHerdrWorkspaceResult => {
  const built = buildGuideLaunchCommand(profile)
  return {
    action: "current-herdr-workspace",
    profile,
    command: built.command,
    prompt,
    cwd,
    callerPaneId: herdrContext.paneId,
    direction,
  }
}

export const buildNewHerdrWorktreeResult = (
  profile: SelectedProfile,
  prompt: string,
  primaryCheckoutPath: string,
  branch: string,
  baseRef: string,
): GuideUiNewHerdrWorktreeResult => {
  const built = buildGuideLaunchCommand(profile)
  return {
    action: "herdr-worktree-create",
    profile,
    command: built.command,
    prompt,
    primaryCheckoutPath,
    branch,
    baseRef,
  }
}

export const buildExistingHerdrWorktreeResult = (
  profile: SelectedProfile,
  prompt: string,
  primaryCheckoutPath: string,
  path: string,
): GuideUiExistingHerdrWorktreeResult => {
  const built = buildGuideLaunchCommand(profile)
  return { action: "herdr-worktree-open", profile, command: built.command, prompt, primaryCheckoutPath, path }
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export interface GuideUiProps {
  readonly catalog: CombinedGuideCatalog
  readonly guideRoot: string
  readonly provider: GuideProvider
  readonly model: string
  readonly effort: GuideEffort
  readonly runner: CommandRunner
  readonly cwd: string
  /** Raw Herdr environment used to derive `HerdrContext` via `getHerdrContext`. */
  readonly herdrEnv: HerdrEnvironment
  /** Whether a Herdr availability probe (e.g. `probeHerdrAvailability`) succeeded, checked before rendering. */
  readonly herdrAvailabilityProbe: boolean
  readonly initialIntent?: string
}

const Spinner = ({ label, detail }: { readonly label: string; readonly detail?: string }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text color="cyan">{label}…</Text>
    {detail === undefined ? null : <Text dimColor>{detail}</Text>}
  </Box>
)

const IntentEditor = ({ textDraft }: { readonly textDraft: string }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">
      What do you want to do?
    </Text>
    <Text>
      {textDraft}
      <Text color="yellow">█</Text>
    </Text>
    <Text dimColor>Type your intent · ↵ submit · Ctrl-C cancel</Text>
  </Box>
)

const ErrorPanel = ({
  title,
  message,
  keys,
}: {
  readonly title: string
  readonly message: string | undefined
  readonly keys: string
}) => (
  <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="red">
    <Text bold color="red">
      {title}
    </Text>
    {message === undefined ? null : <Text wrap="wrap">{message}</Text>}
    <Text dimColor>{keys}</Text>
  </Box>
)

const RecommendationsView = ({
  intent,
  model,
  effort,
  recommendations,
  index,
  usedLiteralFallback,
}: {
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly recommendations: Triple<GuideRecommendation>
  readonly index: number
  readonly usedLiteralFallback: boolean
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">
      Recommendations for: {intent}
    </Text>
    <Text dimColor>
      Model: {model} · Effort: {effort}
    </Text>
    {usedLiteralFallback ? <Text color="yellow">Deterministic literal match (no model call).</Text> : null}
    {recommendations.map((recommendation, itemIndex) => {
      const active = itemIndex === index
      return (
        <Box key={recommendation.profileRef} flexDirection="column" marginTop={1}>
          <Text bold={active} {...(active ? { color: "green" as const } : {})}>
            {active ? "❯ " : "  "}
            {recommendation.profileRef} · confidence {(recommendation.confidence * 100).toFixed(0)}%
          </Text>
          <Text dimColor> {recommendation.description}</Text>
          <Text dimColor>
            {" "}
            workflow: {recommendation.workflow.id} · skill: {recommendation.workflow.skill ?? "—"}
          </Text>
          <Text wrap="wrap"> {recommendation.reason}</Text>
          <Text color="yellow" wrap="wrap">
            {"  "}
            Tradeoff: {recommendation.tradeoff}
          </Text>
          <Text dimColor>
            {"  "}
            Prerequisites:{" "}
            {recommendation.prerequisites.length === 0
              ? "none"
              : recommendation.prerequisites.map((p) => p.id).join(", ")}{" "}
            · headless prompt: {recommendation.headless.prompt ? "yes" : "no"} · Herdr:{" "}
            {recommendation.herdrCompatibility.status}
          </Text>
        </Box>
      )
    })}
    <Text dimColor>↑/↓ or j/k select · ↵ generate · q cancel</Text>
  </Box>
)

const CandidatesView = ({
  candidates,
  index,
  usedTemplateFallback,
  command,
}: {
  readonly candidates: Triple<GuideGenerateCandidate>
  readonly index: number
  readonly usedTemplateFallback: boolean
  readonly command: PublicGuideCommand
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">
      Prompt candidates
    </Text>
    {usedTemplateFallback ? <Text color="yellow">Deterministic template fallback (no model call).</Text> : null}
    {candidates.map((candidate, itemIndex) => {
      const active = itemIndex === index
      return (
        <Box key={`${itemIndex}:${candidate.title}`} flexDirection="column" marginTop={1}>
          <Text bold={active} {...(active ? { color: "green" as const } : {})}>
            {active ? "❯ " : "  "}
            {candidate.title}
          </Text>
          <Text wrap="wrap"> {candidate.prompt}</Text>
          <Text dimColor wrap="wrap">
            {"  "}
            {candidate.notes}
          </Text>
        </Box>
      )
    })}
    <Text dimColor wrap="wrap">
      Command: {command.preview}
      {command.promptHandling === "manual-paste" ? " (manual paste required)" : ""}
    </Text>
    <Text dimColor>↑/↓ or j/k select · ↵ continue · r refine · e edit · c print · q cancel</Text>
  </Box>
)

const TextEditor = ({
  title,
  textDraft,
  keys,
}: {
  readonly title: string
  readonly textDraft: string
  readonly keys: string
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">
      {title}
    </Text>
    <Text wrap="wrap">
      {textDraft}
      <Text color="yellow">█</Text>
    </Text>
    <Text dimColor>{keys}</Text>
  </Box>
)

const DestinationView = ({
  options,
  index,
  commandPreview,
}: {
  readonly options: ReadonlyArray<GuideUiDestination>
  readonly index: number
  readonly commandPreview: string
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold color="cyan">
      Choose a destination
    </Text>
    {options.map((option, itemIndex) => (
      <Text key={option} bold={itemIndex === index} {...(itemIndex === index ? { color: "green" as const } : {})}>
        {itemIndex === index ? "❯ " : "  "}
        {option}
      </Text>
    ))}
    <Text dimColor wrap="wrap">
      Command: {commandPreview}
    </Text>
    <Text dimColor>↑/↓ or j/k select · ↵ confirm · c print prompt · b back</Text>
  </Box>
)

const WorktreeReadyView = ({
  inspection,
  confirmations,
}: {
  readonly inspection: GitInspectionReady
  readonly confirmations: number
}) => {
  const required = requiredWorktreeConfirmations(inspection.dirty)
  const dirtyWarning = worktreeDirtyWarning(inspection.dirty)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Create Herdr worktree
      </Text>
      <Text>Branch: {inspection.branch}</Text>
      <Text>Base: {inspection.baseRef}</Text>
      <Text>Primary checkout: {inspection.primaryCheckoutPath}</Text>
      <Text color={inspection.dirty ? "yellow" : "green"}>
        Source working tree: {inspection.dirty ? "dirty" : "clean"}
      </Text>
      {dirtyWarning === undefined ? null : (
        <Text color="yellow" wrap="wrap">
          {dirtyWarning}
        </Text>
      )}
      <Text dimColor>
        Confirm {confirmations}/{required} · ↵ confirm · b back
      </Text>
    </Box>
  )
}

const WorktreeCollisionView = ({ inspection }: { readonly inspection: WorktreeCollisionResult }) => (
  <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="yellow">
    <Text bold color="yellow">
      Worktree collision: {inspection.collision.kind}
    </Text>
    {inspection.collision.path === undefined ? (
      <>
        <Text wrap="wrap">
          Branch "{inspection.branch}" already exists with no active worktree. Choose a different branch.
        </Text>
        <Text dimColor>e edit branch · q cancel</Text>
      </>
    ) : (
      <>
        <Text wrap="wrap">An active worktree already exists at {inspection.collision.path}.</Text>
        <Text dimColor>↵ open existing worktree · e edit branch · q cancel</Text>
      </>
    )}
  </Box>
)

type GuideUiDispatch = React.Dispatch<GuideUiAction>

const useGuideMatchEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (state.stage !== GuideUiStage.Matching) return undefined
    let cancelled = false
    void (async () => {
      try {
        const response = await runGuideMatch(props.provider, props.catalog, {
          intent: state.intent ?? "",
          model: props.model,
          effort: props.effort,
        })
        if (!cancelled) dispatch({ type: GuideUiActionType.MatchSucceeded, recommendations: response.recommendations })
      } catch (error) {
        if (!cancelled) dispatch({ type: GuideUiActionType.MatchFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage, state.intent])
}

const useGuideGenerationEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (
      state.stage !== GuideUiStage.Generating ||
      state.selectedRecommendation === undefined ||
      state.intent === undefined
    ) {
      return undefined
    }
    let cancelled = false
    const recommendation = state.selectedRecommendation
    const intent = state.intent
    void (async () => {
      try {
        const { candidates } = await runGuideGenerationStep(
          props.catalog,
          props.guideRoot,
          props.provider,
          intent,
          recommendation,
          (guideDocument) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.GenerateGuideLoaded, guideDocument })
          },
        )
        if (!cancelled) dispatch({ type: GuideUiActionType.GenerateSucceeded, candidates })
      } catch (error) {
        if (!cancelled) dispatch({ type: GuideUiActionType.GenerateFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage, state.selectedRecommendation, state.intent])
}

const useGuideRefinementEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (
      state.stage !== GuideUiStage.Refining ||
      state.selectedRecommendation === undefined ||
      state.guideDocument === undefined ||
      state.candidates === undefined ||
      state.intent === undefined
    ) {
      return undefined
    }
    let cancelled = false
    const intent = state.intent
    const recommendation = state.selectedRecommendation
    const guideDocument = state.guideDocument
    const candidate = tripleAt(state.candidates, state.candidateIndex)
    const feedback = state.textDraft
    void (async () => {
      try {
        const refinedCandidate = await runGuideRefinementStep(
          props.provider,
          intent,
          recommendation,
          guideDocument,
          candidate,
          feedback,
        )
        if (!cancelled) dispatch({ type: GuideUiActionType.RefineSucceeded, candidate: refinedCandidate })
      } catch (error) {
        if (!cancelled) dispatch({ type: GuideUiActionType.RefineFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage])
}

const useGuideReadinessEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (state.stage !== GuideUiStage.CheckingReadiness || state.selectedProfile === undefined) return undefined
    let cancelled = false
    const selectedProfile = state.selectedProfile
    void (async () => {
      try {
        const result = await checkSelectedProfileReadiness(props.runner, selectedProfile, props.cwd)
        if (cancelled) return
        dispatch(
          result.kind === ProfileReadinessKind.Ready
            ? { type: GuideUiActionType.ReadinessReady, result }
            : { type: GuideUiActionType.ReadinessBlocked, result },
        )
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: GuideUiActionType.ReadinessBlocked,
            result: {
              kind: ProfileReadinessKind.Blocked,
              summary: "Readiness check failed",
              diagnostic: describeGuideUiError(error),
            },
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage])
}

const worktreeInspectionAction = (
  inspection: Awaited<ReturnType<typeof inspectGitWorktreeIntent>>,
): GuideUiAction => {
  if (inspection.kind === "invalid-branch") return { type: GuideUiActionType.WorktreeInvalidBranch }
  if (inspection.kind === "collision") return { type: GuideUiActionType.WorktreeCollision, inspection }
  return { type: GuideUiActionType.WorktreeReady, inspection }
}

const useGuideWorktreeEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (state.stage !== GuideUiStage.InspectingWorktree || state.worktreeBranch === undefined) return undefined
    let cancelled = false
    const branch = state.worktreeBranch
    void (async () => {
      try {
        const inspection = await inspectGitWorktreeIntent(props.runner, { cwd: props.cwd, branch })
        if (!cancelled) dispatch(worktreeInspectionAction(inspection))
      } catch (error) {
        if (!cancelled)
          dispatch({ type: GuideUiActionType.WorktreeInspectFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage, state.worktreeBranch])
}

interface GuideInputContext {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly dispatch: GuideUiDispatch
  readonly complete: (result: GuideUiResult) => void
  readonly cancel: () => void
  readonly herdrContext: HerdrContext | null
  readonly herdrEnabled: boolean
}

type GuideInputHandler = (context: GuideInputContext, input: string, key: Key) => void

const handleNoInput: GuideInputHandler = () => undefined

const handleIntentInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (key.return) dispatch({ type: GuideUiActionType.IntentSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.IntentBackspace })
  else if (isPrintableInput(input, key) && isWithinTextBound(state.textDraft, input, intentMaxLength)) {
    dispatch({ type: GuideUiActionType.IntentChange, text: state.textDraft + input })
  }
}

const handleMatchFailedInput: GuideInputHandler = ({ props, state, dispatch, cancel }, input) => {
  if (input === "r") {
    dispatch({ type: GuideUiActionType.MatchRetry })
    return
  }
  if (input === "q") {
    cancel()
    return
  }
  if (input !== "l" || state.intent === undefined) return
  try {
    dispatch({
      type: GuideUiActionType.MatchLiteral,
      recommendations: literalGuideRecommendations(props.catalog, state.intent),
    })
  } catch (error) {
    dispatch({ type: GuideUiActionType.MatchLiteralFailed, message: describeGuideUiError(error) })
  }
}

const handleRecommendationsInput: GuideInputHandler = ({ props, state, dispatch, cancel }, input, key) => {
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.RecommendationsMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.RecommendationsMove, delta: 1 })
  else if (key.return && state.recommendations !== undefined) {
    const recommendation = tripleAt(state.recommendations, state.recommendationIndex)
    dispatch({
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: selectedProfileFromCatalogRef(props.catalog, recommendation.profileRef),
    })
  } else if (input === "q") cancel()
}

const handleGenerateFailedInput: GuideInputHandler = ({ state, dispatch, cancel }, input) => {
  if (input === "r") dispatch({ type: GuideUiActionType.GenerateRetry })
  else if (input === "b") dispatch({ type: GuideUiActionType.GenerateBack })
  else if (input === "q") cancel()
  else if (
    input === "t" &&
    state.guideDocument !== undefined &&
    state.selectedRecommendation !== undefined &&
    state.intent !== undefined
  ) {
    try {
      dispatch({
        type: GuideUiActionType.GenerateTemplateFallback,
        candidates: templateGuideCandidates(
          state.guideDocument.guide,
          state.selectedRecommendation.workflowId,
          state.intent,
        ),
      })
    } catch (error) {
      dispatch({ type: GuideUiActionType.GenerateTemplateFallbackFailed, message: describeGuideUiError(error) })
    }
  }
}

const handleCandidatesInput: GuideInputHandler = ({ state, dispatch, complete, cancel }, input, key) => {
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.CandidatesMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.CandidatesMove, delta: 1 })
  else if (key.return) dispatch({ type: GuideUiActionType.CandidatesConfirm })
  else if (input === "r") dispatch({ type: GuideUiActionType.CandidatesRefineStart })
  else if (input === "e") dispatch({ type: GuideUiActionType.CandidatesDirectEditStart })
  else if (input === "c" && state.candidates !== undefined) {
    complete(buildPrintResult(tripleAt(state.candidates, state.candidateIndex).prompt))
  } else if (input === "q") cancel()
}

const handleTextEditorInput = (
  context: GuideInputContext,
  input: string,
  key: Key,
  maximum: number,
  submit: GuideUiAction,
  back: GuideUiAction,
): void => {
  if (key.escape) context.dispatch(back)
  else if (key.return) context.dispatch(submit)
  else if (key.backspace || key.delete) context.dispatch({ type: GuideUiActionType.EditorBackspace })
  else if (isPrintableInput(input, key) && isWithinTextBound(context.state.textDraft, input, maximum)) {
    context.dispatch({ type: GuideUiActionType.EditorChange, text: context.state.textDraft + input })
  }
}

const handleRefineEditorInput: GuideInputHandler = (context, input, key) =>
  handleTextEditorInput(
    context,
    input,
    key,
    feedbackMaxLength,
    { type: GuideUiActionType.RefineSubmit },
    { type: GuideUiActionType.RefineBack },
  )

const handleDirectEditorInput: GuideInputHandler = (context, input, key) =>
  handleTextEditorInput(
    context,
    input,
    key,
    promptMaxLength,
    { type: GuideUiActionType.DirectEditSubmit },
    { type: GuideUiActionType.DirectEditBack },
  )

const handleBranchEditorInput: GuideInputHandler = (context, input, key) =>
  handleTextEditorInput(
    context,
    input,
    key,
    branchMaxLength,
    { type: GuideUiActionType.WorktreeSubmitBranch },
    { type: GuideUiActionType.WorktreeBack },
  )

const handleRefineFailedInput: GuideInputHandler = ({ dispatch }, input) => {
  if (input === "r") dispatch({ type: GuideUiActionType.RefineRetry })
  else if (input === "b") dispatch({ type: GuideUiActionType.RefineBack })
}

const handleReadinessBlockedInput: GuideInputHandler = ({ dispatch, cancel }, input) => {
  if (input === "r") dispatch({ type: GuideUiActionType.ReadinessRetry })
  else if (input === "b") dispatch({ type: GuideUiActionType.ReadinessBack })
  else if (input === "q") cancel()
}

const completeDestination = (context: GuideInputContext, option: GuideUiDestination): void => {
  const { state, props, herdrContext, dispatch, complete } = context
  if (state.selectedProfile === undefined || state.selectedCandidate === undefined) return
  const prompt = state.selectedCandidate.prompt
  if (option === GuideUiDestination.CurrentTerminal) {
    complete(buildCurrentTerminalResult(state.selectedProfile, prompt, props.cwd))
    return
  }
  if (option === GuideUiDestination.CurrentHerdrWorkspace && herdrContext !== null) {
    complete(buildCurrentHerdrWorkspaceResult(state.selectedProfile, prompt, props.cwd, herdrContext))
    return
  }
  if (option === GuideUiDestination.NewHerdrWorktree) {
    dispatch({ type: GuideUiActionType.DestinationStartWorktree })
  }
}

const handleDestinationInput: GuideInputHandler = (context, input, key) => {
  const { state, dispatch, complete, cancel, herdrEnabled } = context
  const options = destinationOptions(herdrEnabled)
  if (key.upArrow || input === "k")
    dispatch({ type: GuideUiActionType.DestinationMove, delta: -1, optionCount: options.length })
  else if (key.downArrow || input === "j")
    dispatch({ type: GuideUiActionType.DestinationMove, delta: 1, optionCount: options.length })
  else if (input === "c" && state.selectedCandidate !== undefined)
    complete(buildPrintResult(state.selectedCandidate.prompt))
  else if (key.return) {
    const option = options[state.destinationIndex]
    if (option !== undefined) completeDestination(context, option)
  }
  else if (input === "b") dispatch({ type: GuideUiActionType.DestinationBack })
  else if (input === "q") cancel()
}

const handleWorktreeCollisionInput: GuideInputHandler = ({ state, dispatch, complete, cancel }, input, key) => {
  if (input === "e") {
    dispatch({ type: GuideUiActionType.WorktreeEditBranch })
    return
  }
  if (input === "q") {
    cancel()
    return
  }
  const inspection = state.worktreeInspection
  if (
    !key.return ||
    inspection === undefined ||
    !("collision" in inspection) ||
    inspection.collision.path === undefined ||
    state.selectedProfile === undefined ||
    state.selectedCandidate === undefined
  ) {
    return
  }
  complete(
    buildExistingHerdrWorktreeResult(
      state.selectedProfile,
      state.selectedCandidate.prompt,
      inspection.primaryCheckoutPath,
      inspection.collision.path,
    ),
  )
}

const confirmedWorktreeResult = (state: GuideUiState): GuideUiNewHerdrWorktreeResult | undefined => {
  const inspection = state.worktreeInspection
  if (
    inspection === undefined ||
    "collision" in inspection ||
    !isWorktreeConfirmed(state.worktreeConfirmations + 1, inspection.dirty) ||
    state.selectedProfile === undefined ||
    state.selectedCandidate === undefined
  ) {
    return undefined
  }
  return buildNewHerdrWorktreeResult(
    state.selectedProfile,
    state.selectedCandidate.prompt,
    inspection.primaryCheckoutPath,
    inspection.branch,
    inspection.baseRef,
  )
}

const handleWorktreeReadyInput: GuideInputHandler = ({ state, dispatch, complete }, input, key) => {
  if (key.escape) {
    dispatch({ type: GuideUiActionType.WorktreeBack })
    return
  }
  if (!key.return && input !== "y") return
  const result = confirmedWorktreeResult(state)
  if (result === undefined) dispatch({ type: GuideUiActionType.WorktreeConfirm })
  else complete(result)
}

const inputHandlerByStage: Record<GuideUiStage, GuideInputHandler> = {
  [GuideUiStage.Intent]: handleIntentInput,
  [GuideUiStage.Matching]: handleNoInput,
  [GuideUiStage.MatchFailed]: handleMatchFailedInput,
  [GuideUiStage.Recommendations]: handleRecommendationsInput,
  [GuideUiStage.Generating]: handleNoInput,
  [GuideUiStage.GenerateFailed]: handleGenerateFailedInput,
  [GuideUiStage.Candidates]: handleCandidatesInput,
  [GuideUiStage.RefineEditor]: handleRefineEditorInput,
  [GuideUiStage.Refining]: handleNoInput,
  [GuideUiStage.RefineFailed]: handleRefineFailedInput,
  [GuideUiStage.DirectEditor]: handleDirectEditorInput,
  [GuideUiStage.CheckingReadiness]: handleNoInput,
  [GuideUiStage.ReadinessBlocked]: handleReadinessBlockedInput,
  [GuideUiStage.Destination]: handleDestinationInput,
  [GuideUiStage.WorktreeBranchEditor]: handleBranchEditorInput,
  [GuideUiStage.InspectingWorktree]: handleNoInput,
  [GuideUiStage.WorktreeCollision]: handleWorktreeCollisionInput,
  [GuideUiStage.WorktreeReady]: handleWorktreeReadyInput,
}

const handleGuideInput = (context: GuideInputContext, input: string, key: Key): void => {
  if (key.ctrl && input === "c") {
    context.cancel()
    return
  }
  inputHandlerByStage[context.state.stage](context, input, key)
}

interface GuideRenderContext {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly herdrEnabled: boolean
}

type GuideStageRenderer = (context: GuideRenderContext) => React.ReactElement

const matchingSpinner = ({ props }: GuideRenderContext): React.ReactElement => (
  <Spinner label="Matching profiles" detail={`Model: ${props.model} · Effort: ${props.effort}`} />
)

const renderRecommendations: GuideStageRenderer = ({ props, state }) =>
  state.recommendations === undefined ? (
    <Spinner label="Matching profiles" detail={`Model: ${props.model} · Effort: ${props.effort}`} />
  ) : (
    <RecommendationsView
      intent={state.intent ?? ""}
      model={props.model}
      effort={props.effort}
      recommendations={state.recommendations}
      index={state.recommendationIndex}
      usedLiteralFallback={state.usedLiteralFallback}
    />
  )

const renderCandidateStage: GuideStageRenderer = ({ props, state }) => {
  if (state.candidates === undefined || state.selectedRecommendation === undefined) return <Spinner label="Loading" />
  if (state.stage === GuideUiStage.RefineEditor)
    return <TextEditor title="Refinement feedback" textDraft={state.textDraft} keys="↵ submit · Esc back" />
  if (state.stage === GuideUiStage.Refining) return <Spinner label="Refining prompt" />
  if (state.stage === GuideUiStage.RefineFailed)
    return <ErrorPanel title="Refinement failed" message={state.errorMessage} keys="r retry · b back" />
  if (state.stage === GuideUiStage.DirectEditor)
    return <TextEditor title="Edit prompt" textDraft={state.textDraft} keys="↵ submit · Esc back" />
  return (
    <CandidatesView
      candidates={state.candidates}
      index={state.candidateIndex}
      usedTemplateFallback={state.usedTemplateFallback}
      command={publicGuideLaunchCommand(
        props.catalog,
        state.selectedRecommendation.profileRef,
        tripleAt(state.candidates, state.candidateIndex).prompt,
      )}
    />
  )
}

const renderDestination: GuideStageRenderer = ({ state, herdrEnabled }) => {
  const options = destinationOptions(herdrEnabled)
  const option = options[state.destinationIndex]
  const command =
    state.selectedProfile === undefined
      ? undefined
      : option === GuideUiDestination.CurrentTerminal
        ? buildGuideLaunchCommand(state.selectedProfile, {
            mode: "argv",
            prompt: state.selectedCandidate?.prompt ?? "",
          }).command
        : buildGuideLaunchCommand(state.selectedProfile).command
  return (
    <DestinationView
      options={options}
      index={state.destinationIndex}
      commandPreview={command === undefined ? "" : renderCommandPreview(command)}
    />
  )
}

const renderWorktreeCollision: GuideStageRenderer = ({ state }) =>
  state.worktreeInspection === undefined || !("collision" in state.worktreeInspection) ? (
    <Spinner label="Inspecting git worktree" />
  ) : (
    <WorktreeCollisionView inspection={state.worktreeInspection} />
  )

const renderWorktreeReady: GuideStageRenderer = ({ state }) =>
  state.worktreeInspection === undefined || "collision" in state.worktreeInspection ? (
    <Spinner label="Inspecting git worktree" />
  ) : (
    <WorktreeReadyView inspection={state.worktreeInspection} confirmations={state.worktreeConfirmations} />
  )

const stageRenderer: Record<GuideUiStage, GuideStageRenderer> = {
  [GuideUiStage.Intent]: ({ state }) => <IntentEditor textDraft={state.textDraft} />,
  [GuideUiStage.Matching]: matchingSpinner,
  [GuideUiStage.MatchFailed]: ({ state }) => (
    <ErrorPanel title="Match failed" message={state.errorMessage} keys="r retry · l literal match · q cancel" />
  ),
  [GuideUiStage.Recommendations]: renderRecommendations,
  [GuideUiStage.Generating]: () => <Spinner label="Generating prompts" />,
  [GuideUiStage.GenerateFailed]: ({ state }) => (
    <ErrorPanel
      title="Generation failed"
      message={state.errorMessage}
      keys={`r retry${state.guideDocument === undefined ? "" : " · t template fallback"} · b back · q cancel`}
    />
  ),
  [GuideUiStage.Candidates]: renderCandidateStage,
  [GuideUiStage.RefineEditor]: renderCandidateStage,
  [GuideUiStage.Refining]: renderCandidateStage,
  [GuideUiStage.RefineFailed]: renderCandidateStage,
  [GuideUiStage.DirectEditor]: renderCandidateStage,
  [GuideUiStage.CheckingReadiness]: () => <Spinner label="Checking profile readiness" />,
  [GuideUiStage.ReadinessBlocked]: ({ state }) => (
    <ErrorPanel
      title={state.readiness?.summary ?? "Profile is not ready"}
      message={state.readiness?.kind === ProfileReadinessKind.Blocked ? state.readiness.diagnostic : undefined}
      keys="r retry · b back · q cancel"
    />
  ),
  [GuideUiStage.Destination]: renderDestination,
  [GuideUiStage.WorktreeBranchEditor]: ({ state }) => (
    <TextEditor
      title="Worktree branch"
      textDraft={state.textDraft}
      keys={`${state.errorMessage ?? ""}${state.errorMessage === undefined ? "" : " · "}↵ submit · Esc back`}
    />
  ),
  [GuideUiStage.InspectingWorktree]: () => <Spinner label="Inspecting git worktree" />,
  [GuideUiStage.WorktreeCollision]: renderWorktreeCollision,
  [GuideUiStage.WorktreeReady]: renderWorktreeReady,
}

/**
 * The exported `trx guide` interactive UI. Side effects and stage-specific
 * input/render behavior are delegated to focused helpers.
 */
export const GuideApp = (props: GuideUiProps): React.ReactElement => {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(guideUiReducer, props.initialIntent, createInitialGuideUiState)
  const herdrContext = getHerdrContext(props.herdrEnv)
  const herdrEnabled = herdrContext !== null && props.herdrAvailabilityProbe
  const complete = (result: GuideUiResult): void => exit(result)
  const cancel = (): void => complete(buildCancelResult())

  useGuideMatchEffect(props, state, dispatch)
  useGuideGenerationEffect(props, state, dispatch)
  useGuideRefinementEffect(props, state, dispatch)
  useGuideReadinessEffect(props, state, dispatch)
  useGuideWorktreeEffect(props, state, dispatch)

  const inputContext: GuideInputContext = {
    props,
    state,
    dispatch,
    complete,
    cancel,
    herdrContext,
    herdrEnabled,
  }
  useInput((input, key) => handleGuideInput(inputContext, input, key))

  return stageRenderer[state.stage]({ props, state, herdrEnabled })
}
