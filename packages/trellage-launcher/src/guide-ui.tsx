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
import React, { useEffect, useReducer, useState } from "react"
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink"

import { profileGuideIdentityKey, type ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"
import { compactProfileGuide, type CombinedGuideCatalog } from "./guide-catalog.js"
import {
  applyWorkflowPromptTemplate,
  guideTargetTool,
  literalGuideMatch,
  publicGuideLaunchCommand,
  runGuideMatch,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
  type GuideEffort,
  type GuideMatchResponse,
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
  parseSelectedProfile,
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

const recommendationAt = <T,>(items: ReadonlyArray<T>, index: number): T => {
  const item = items[index] ?? items[0]
  if (item === undefined) throw new Error("Recommendation set must not be empty")
  return item
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

export enum GuideWizardStep {
  Profile = "profile",
  PromptCandidates = "prompt-candidates",
  Destination = "destination",
}

export enum GuideGenerationPhase {
  LoadingProfile = "loading-profile",
  GeneratingCandidates = "generating-candidates",
  ApplyingWorkflow = "applying-workflow",
  OptimizingCandidates = "optimizing-candidates",
}

export enum GuideMatchPhase {
  LoadingProfiles = "loading-profiles",
  ComparingProfiles = "comparing-profiles",
  PreparingRecommendations = "preparing-recommendations",
}

const wizardStepByStage: Readonly<Record<GuideUiStage, GuideWizardStep | undefined>> = {
  [GuideUiStage.Intent]: undefined,
  [GuideUiStage.Matching]: GuideWizardStep.Profile,
  [GuideUiStage.MatchFailed]: GuideWizardStep.Profile,
  [GuideUiStage.Recommendations]: GuideWizardStep.Profile,
  [GuideUiStage.Generating]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.GenerateFailed]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.Candidates]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.RefineEditor]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.Refining]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.RefineFailed]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.DirectEditor]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.CheckingReadiness]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.ReadinessBlocked]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.Destination]: GuideWizardStep.Destination,
  [GuideUiStage.WorktreeBranchEditor]: GuideWizardStep.Destination,
  [GuideUiStage.InspectingWorktree]: GuideWizardStep.Destination,
  [GuideUiStage.WorktreeCollision]: GuideWizardStep.Destination,
  [GuideUiStage.WorktreeReady]: GuideWizardStep.Destination,
}

export const wizardStepForStage = (stage: GuideUiStage): GuideWizardStep | undefined => wizardStepByStage[stage]

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
  readonly matchPhase: GuideMatchPhase | undefined
  readonly recommendations: ReadonlyArray<GuideRecommendation> | undefined
  readonly recommendationIndex: number
  readonly usedLiteralFallback: boolean
  readonly selectedRecommendation: GuideRecommendation | undefined
  readonly selectedProfile: SelectedProfile | undefined
  readonly guideDocument: SelectedGuideDocument | undefined
  readonly generationPhase: GuideGenerationPhase | undefined
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
  matchPhase: undefined,
  recommendations: undefined,
  recommendationIndex: 0,
  usedLiteralFallback: false,
  selectedRecommendation: undefined,
  selectedProfile: undefined,
  guideDocument: undefined,
  generationPhase: undefined,
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
    return {
      ...emptyState,
      stage: GuideUiStage.Matching,
      intent: trimmed,
      matchPhase: GuideMatchPhase.LoadingProfiles,
    }
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
  MatchProgress = "match/progress",
  MatchSucceeded = "match/succeeded",
  MatchFailed = "match/failed",
  MatchLiteral = "match/literal",
  MatchLiteralFailed = "match/literal-failed",
  RecommendationsMove = "recommendations/move",
  RecommendationsConfirm = "recommendations/confirm",
  GenerateGuideLoaded = "generate/guide-loaded",
  GenerateProgress = "generate/progress",
  GenerateRetry = "generate/retry",
  GenerateSucceeded = "generate/succeeded",
  GenerateFailed = "generate/failed",
  GenerateTemplateFallback = "generate/template-fallback",
  GenerateTemplateFallbackFailed = "generate/template-fallback-failed",
  GenerateBack = "generate/back",
  CandidatesMove = "candidates/move",
  CandidatesBack = "candidates/back",
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
  | { readonly type: GuideUiActionType.MatchProgress; readonly phase: GuideMatchPhase }
  | { readonly type: GuideUiActionType.MatchSucceeded; readonly recommendations: ReadonlyArray<GuideRecommendation> }
  | { readonly type: GuideUiActionType.MatchFailed; readonly message: string }
  | { readonly type: GuideUiActionType.MatchLiteral; readonly recommendations: ReadonlyArray<GuideRecommendation> }
  | { readonly type: GuideUiActionType.MatchLiteralFailed; readonly message: string }
  | { readonly type: GuideUiActionType.RecommendationsMove; readonly delta: 1 | -1 }
  | {
      readonly type: GuideUiActionType.RecommendationsConfirm
      readonly selectedProfile: SelectedProfile
      readonly recommendation?: GuideRecommendation
    }
  | { readonly type: GuideUiActionType.GenerateGuideLoaded; readonly guideDocument: SelectedGuideDocument }
  | { readonly type: GuideUiActionType.GenerateProgress; readonly phase: GuideGenerationPhase }
  | { readonly type: GuideUiActionType.GenerateRetry }
  | { readonly type: GuideUiActionType.GenerateSucceeded; readonly candidates: Triple<GuideGenerateCandidate> }
  | { readonly type: GuideUiActionType.GenerateFailed; readonly message: string }
  | { readonly type: GuideUiActionType.GenerateTemplateFallback; readonly candidates: Triple<GuideGenerateCandidate> }
  | { readonly type: GuideUiActionType.GenerateTemplateFallbackFailed; readonly message: string }
  | { readonly type: GuideUiActionType.GenerateBack }
  | { readonly type: GuideUiActionType.CandidatesMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.CandidatesBack }
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
      return {
        ...emptyState,
        stage: GuideUiStage.Matching,
        intent: trimmed,
        matchPhase: GuideMatchPhase.LoadingProfiles,
      }
    }

    default:
      return state
  }
}

const recommendationsState = (
  state: GuideUiState,
  recommendations: ReadonlyArray<GuideRecommendation>,
  usedLiteralFallback: boolean,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Recommendations,
  matchPhase: undefined,
  recommendations,
  recommendationIndex: 0,
  usedLiteralFallback,
  errorMessage: undefined,
})

const reduceMatchProgress = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.MatchProgress:
      return state.stage === GuideUiStage.Matching ? { ...state, matchPhase: action.phase } : state

    default:
      return state
  }
}

const reduceMatch = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.MatchRetry:
      return state.stage === GuideUiStage.MatchFailed
        ? {
            ...state,
            stage: GuideUiStage.Matching,
            matchPhase: GuideMatchPhase.LoadingProfiles,
            errorMessage: undefined,
          }
        : state

    case GuideUiActionType.MatchSucceeded:
      return state.stage === GuideUiStage.Matching ? recommendationsState(state, action.recommendations, false) : state

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
        ? {
            ...state,
            recommendationIndex:
              state.recommendations === undefined
                ? state.recommendationIndex
                : (state.recommendationIndex + action.delta + state.recommendations.length) %
                  state.recommendations.length,
          }
        : state

    case GuideUiActionType.RecommendationsConfirm: {
      if (state.stage !== GuideUiStage.Recommendations || state.recommendations === undefined) return state
      return {
        ...state,
        stage: GuideUiStage.Generating,
        selectedRecommendation: action.recommendation ?? recommendationAt(state.recommendations, state.recommendationIndex),
        selectedProfile: action.selectedProfile,
        guideDocument: undefined,
        generationPhase: GuideGenerationPhase.LoadingProfile,
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
  generationPhase: undefined,
  candidates,
  candidateIndex: 0,
  usedTemplateFallback,
  errorMessage: undefined,
})

const profileSelectionState = (state: GuideUiState): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Recommendations,
  selectedRecommendation: undefined,
  selectedProfile: undefined,
  guideDocument: undefined,
  generationPhase: undefined,
  candidates: undefined,
  candidateIndex: 0,
  usedTemplateFallback: false,
  selectedCandidate: undefined,
  readiness: undefined,
  destinationIndex: 0,
  worktreeBranch: undefined,
  worktreeInspection: undefined,
  worktreeConfirmations: 0,
  errorMessage: undefined,
})

const reduceGenerateProgress = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.GenerateProgress:
      return state.stage === GuideUiStage.Generating ? { ...state, generationPhase: action.phase } : state

    default:
      return state
  }
}

const reduceGenerate = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.GenerateGuideLoaded:
      return state.stage === GuideUiStage.Generating ? { ...state, guideDocument: action.guideDocument } : state

    case GuideUiActionType.GenerateRetry:
      return state.stage === GuideUiStage.GenerateFailed
        ? {
            ...state,
            stage: GuideUiStage.Generating,
            generationPhase: GuideGenerationPhase.LoadingProfile,
            errorMessage: undefined,
          }
        : state

    case GuideUiActionType.GenerateSucceeded:
      return state.stage === GuideUiStage.Generating ? candidatesState(state, action.candidates, false) : state

    case GuideUiActionType.GenerateFailed:
      return state.stage === GuideUiStage.Generating
        ? { ...state, stage: GuideUiStage.GenerateFailed, errorMessage: action.message }
        : state

    case GuideUiActionType.GenerateTemplateFallback:
      return state.stage === GuideUiStage.GenerateFailed ? candidatesState(state, action.candidates, true) : state

    case GuideUiActionType.GenerateTemplateFallbackFailed:
      return state.stage === GuideUiStage.GenerateFailed ? { ...state, errorMessage: action.message } : state

    case GuideUiActionType.GenerateBack:
      return state.stage === GuideUiStage.GenerateFailed ? profileSelectionState(state) : state

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

    case GuideUiActionType.CandidatesBack:
      return state.stage === GuideUiStage.Candidates ? profileSelectionState(state) : state

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
  [GuideUiActionType.MatchProgress]: reduceMatchProgress,
  [GuideUiActionType.MatchSucceeded]: reduceMatch,
  [GuideUiActionType.MatchFailed]: reduceMatch,
  [GuideUiActionType.MatchLiteral]: reduceMatch,
  [GuideUiActionType.MatchLiteralFailed]: reduceMatch,
  [GuideUiActionType.RecommendationsMove]: reduceRecommendations,
  [GuideUiActionType.RecommendationsConfirm]: reduceRecommendations,
  [GuideUiActionType.GenerateGuideLoaded]: reduceGenerate,
  [GuideUiActionType.GenerateProgress]: reduceGenerateProgress,
  [GuideUiActionType.GenerateRetry]: reduceGenerate,
  [GuideUiActionType.GenerateSucceeded]: reduceGenerate,
  [GuideUiActionType.GenerateFailed]: reduceGenerate,
  [GuideUiActionType.GenerateTemplateFallback]: reduceGenerate,
  [GuideUiActionType.GenerateTemplateFallbackFailed]: reduceGenerate,
  [GuideUiActionType.GenerateBack]: reduceGenerate,
  [GuideUiActionType.CandidatesMove]: reduceCandidateSelection,
  [GuideUiActionType.CandidatesBack]: reduceCandidateSelection,
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

export enum GuidePinnedLensKind {
  Council = "council",
  Research = "research",
  HveRpi = "hve-rpi",
}

export interface GuidePinnedLens {
  readonly kind: GuidePinnedLensKind
  readonly key: string
  readonly emoji: string
  readonly label: string
  readonly description: string
  readonly agent?: string
  readonly recommendation: GuideRecommendation
}

const pinnedLensDefinitions: ReadonlyArray<Omit<GuidePinnedLens, "recommendation"> & {
  readonly profileRef: string
  readonly workflowId: string
  readonly reason: string
  readonly tradeoff: string
}> = [
  {
    kind: GuidePinnedLensKind.Council,
    key: "c",
    emoji: "🧠",
    label: "Council",
    description: "Pressure-test the idea and its implementation.",
    profileRef: "sandbox:claude-council",
    workflowId: "run-council-deliberation",
    reason: "Use a structured council to challenge the idea, its assumptions, and its implementation.",
    tradeoff: "Adds deliberation time before implementation begins.",
  },
  {
    kind: GuidePinnedLensKind.Research,
    key: "r",
    emoji: "🔎",
    label: "Research",
    description: "Gather evidence before implementation.",
    profileRef: "sandbox:claude-research",
    workflowId: "vault-backed-research",
    reason: "Collect source-backed evidence, prior art, risks, and implementation options before acting.",
    tradeoff: "Adds research time before implementation begins.",
  },
  {
    kind: GuidePinnedLensKind.HveRpi,
    key: "h",
    emoji: "🔄",
    label: "HVE RPI",
    description: "Run the dedicated HVE Core RPI agent.",
    profileRef: "native:cpx/hve",
    workflowId: "rpi-agent-cycle",
    agent: "hve-core:rpi-agent",
    reason: "Use HVE Core's dedicated agent to carry the request through research, planning, implementation, and review.",
    tradeoff: "Adds a structured multi-stage process that is unnecessary for small changes.",
  },
]

export const pinnedGuideLenses = (catalog: CombinedGuideCatalog): ReadonlyArray<GuidePinnedLens> =>
  pinnedLensDefinitions.flatMap((definition) => {
    if (findCombinedCatalogEntry(catalog, definition.profileRef) === undefined) return []
    const { profileRef, workflowId, reason, tradeoff, ...lens } = definition
    return [
      {
        ...lens,
        recommendation: enrichLiteralCandidate(catalog, {
          profileRef,
          workflowId,
          confidence: 1,
          reason,
          tradeoff,
        }),
      },
    ]
  })

export const selectedProfileForPinnedLens = (
  catalog: CombinedGuideCatalog,
  lens: GuidePinnedLens,
): SelectedProfile => {
  const selectedProfile = selectedProfileFromCatalogRef(catalog, lens.recommendation.profileRef)
  if (lens.agent === undefined) return selectedProfile
  if (selectedProfile.surface !== "native") {
    throw new Error(`Pinned lens agent requires a native profile: ${lens.recommendation.profileRef}`)
  }
  return parseSelectedProfile({ ...selectedProfile, agent: lens.agent })
}

/** Computes the three deterministic, model-free literal-match recommendations, fully enriched for display. */
export const literalGuideRecommendations = (
  catalog: CombinedGuideCatalog,
  intent: string,
): ReadonlyArray<GuideRecommendation> =>
  literalGuideMatch(catalog, intent).map((candidate) => enrichLiteralCandidate(catalog, candidate))

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

export const runGuideMatchingStep = async (
  provider: GuideProvider,
  catalog: CombinedGuideCatalog,
  request: { readonly intent: string; readonly model: string; readonly effort: GuideEffort },
  onProgress?: (phase: GuideMatchPhase) => void,
): Promise<GuideMatchResponse> => {
  onProgress?.(GuideMatchPhase.ComparingProfiles)
  const response = await runGuideMatch(provider, catalog, request)
  onProgress?.(GuideMatchPhase.PreparingRecommendations)
  return response
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
  onProgress?: (phase: GuideGenerationPhase) => void,
): Promise<GuideGenerationStepResult> => {
  const guideDocument = await loadSelectedGuide(catalog, guideRoot, recommendation.profileRef)
  onGuideLoaded?.(guideDocument)
  onProgress?.(GuideGenerationPhase.GeneratingCandidates)
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
  onProgress?.(GuideGenerationPhase.ApplyingWorkflow)
  const workflowCandidates = [
    applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, first),
    applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, second),
    applyWorkflowPromptTemplate(guideDocument.guide, recommendation.workflowId, third),
  ] as const
  onProgress?.(GuideGenerationPhase.OptimizingCandidates)
  const optimized = await provider.optimize({
    targetTool: guideTargetTool(catalog, recommendation.profileRef),
    profileRef: recommendation.profileRef,
    candidates: workflowCandidates,
  })
  const [optimizedFirst, optimizedSecond, optimizedThird] = optimized.candidates
  if (optimizedFirst === undefined || optimizedSecond === undefined || optimizedThird === undefined) {
    throw new Error("Prompt Master must return exactly three prompt candidates")
  }
  return {
    guideDocument,
    candidates: [optimizedFirst, optimizedSecond, optimizedThird],
  }
}

/**
 * Calls `provider.refine` constrained by the same intent, profile,
 * workflow, guide, and guide body as the original generation, plus the
 * candidate being refined and the user's feedback.
 */
export const runGuideRefinementStep = async (
  catalog: CombinedGuideCatalog,
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
  const workflowCandidate = applyWorkflowPromptTemplate(
    guideDocument.guide,
    recommendation.workflowId,
    refined.candidate,
  )
  const optimized = await provider.optimize({
    targetTool: guideTargetTool(catalog, recommendation.profileRef),
    profileRef: recommendation.profileRef,
    candidates: [workflowCandidate],
  })
  const optimizedCandidate = optimized.candidates[0]
  if (optimizedCandidate === undefined) throw new Error("Prompt Master must return one refined prompt candidate")
  return optimizedCandidate
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

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

const cyclicItemAt = <T,>(items: ReadonlyArray<T>, index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length]

export const spinnerFrameAt = (tick: number): string => cyclicItemAt(spinnerFrames, tick) ?? "•"

export const spinnerMessageAt = (messages: ReadonlyArray<string>, tick: number): string | undefined =>
  cyclicItemAt(messages, Math.floor(tick / 15))

const Spinner = ({
  label,
  detail,
  messages = [],
}: {
  readonly label: string
  readonly detail?: string
  readonly messages?: ReadonlyArray<string>
}) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  const message = spinnerMessageAt(messages, tick)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        <Text color="cyan">{spinnerFrameAt(tick)}</Text> {label}
      </Text>
      {message === undefined ? null : <Text color="magenta">{message}</Text>}
      {detail === undefined ? null : <Text dimColor>{detail}</Text>}
    </Box>
  )
}

export interface GuideGenerationProgressItem {
  readonly phase: GuideGenerationPhase
  readonly label: string
}

export interface GuideMatchProgressItem {
  readonly phase: GuideMatchPhase
  readonly label: string
}

export const matchProgressItems = (profileCount: number): ReadonlyArray<GuideMatchProgressItem> => [
  {
    phase: GuideMatchPhase.LoadingProfiles,
    label: `Read ${profileCount} available profiles and their workflows`,
  },
  {
    phase: GuideMatchPhase.ComparingProfiles,
    label: "Compare the request with capabilities and trade-offs",
  },
  {
    phase: GuideMatchPhase.PreparingRecommendations,
    label: "Prepare the ranked profile choices",
  },
]

export const generationProgressItems = (
  recommendation: GuideRecommendation,
): ReadonlyArray<GuideGenerationProgressItem> => [
  {
    phase: GuideGenerationPhase.LoadingProfile,
    label: `Read ${recommendationLabel(recommendation)} guidance`,
  },
  {
    phase: GuideGenerationPhase.GeneratingCandidates,
    label: "Draft three profile-specific approaches",
  },
  {
    phase: GuideGenerationPhase.ApplyingWorkflow,
    label: `Apply the ${recommendation.workflow.id} workflow`,
  },
  {
    phase: GuideGenerationPhase.OptimizingCandidates,
    label: "Improve clarity and completeness with Prompt Master",
  },
]

export const summarizeGenerationIntent = (intent: string, maximumLength = 100): string => {
  const normalized = intent.replace(/\s+/gu, " ").trim()
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`
}

const ProgressPipeline = ({
  title,
  intent,
  items,
  activePhase,
  detail,
}: {
  readonly title: string
  readonly intent: string
  readonly items: ReadonlyArray<{ readonly phase: string; readonly label: string }>
  readonly activePhase: string
  readonly detail: string
}) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  const activeIndex = items.findIndex((item) => item.phase === activePhase)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{title}</Text>
      <Text dimColor wrap="truncate-end">
        Request: {summarizeGenerationIntent(intent)}
      </Text>
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        {items.map((item, index) => {
          const complete = index < activeIndex
          const active = index === activeIndex
          return (
            <Text key={item.phase} color={complete ? "green" : active ? "cyan" : "gray"}>
              {complete ? "✓" : active ? spinnerFrameAt(tick) : "○"} {item.label}
            </Text>
          )
        })}
      </Box>
      <Text dimColor>{detail}</Text>
    </Box>
  )
}

const MatchProgress = ({
  catalog,
  phase,
  intent,
  model,
  effort,
}: {
  readonly catalog: CombinedGuideCatalog
  readonly phase: GuideMatchPhase
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
}) => (
  <ProgressPipeline
    title="Finding the best profiles"
    intent={intent}
    items={matchProgressItems(catalog.native.length + catalog.sandbox.length)}
    activePhase={phase}
    detail={`Copilot model: ${model} · Effort: ${effort}`}
  />
)

const GenerationProgress = ({
  recommendation,
  phase,
  intent,
  model,
}: {
  readonly recommendation: GuideRecommendation
  readonly phase: GuideGenerationPhase
  readonly intent: string
  readonly model: string
}) => (
  <ProgressPipeline
    title="Preparing prompt candidates"
    intent={intent}
    items={generationProgressItems(recommendation)}
    activePhase={phase}
    detail={`Copilot model: ${model} · Selected profile: ${recommendation.profileRef}`}
  />
)

const wizardSteps: ReadonlyArray<{ readonly step: GuideWizardStep; readonly label: string }> = [
  { step: GuideWizardStep.Profile, label: "Profile" },
  { step: GuideWizardStep.PromptCandidates, label: "Prompt candidates" },
  { step: GuideWizardStep.Destination, label: "Destination" },
]

export const wizardBreadcrumbLabel = (index: number, label: string, complete: boolean): string =>
  `${complete ? "✓ " : ""}Step ${index + 1}: ${label}`

const WizardBreadcrumbs = ({ activeStep }: { readonly activeStep: GuideWizardStep }) => {
  const activeIndex = wizardSteps.findIndex(({ step }) => step === activeStep)
  return (
    <Box paddingX={1} marginBottom={1}>
      {wizardSteps.map(({ step, label }, index) => {
        const active = step === activeStep
        const complete = index < activeIndex
        return (
          <React.Fragment key={step}>
            {index === 0 ? null : <Text dimColor> › </Text>}
            <Text bold={active} color={active ? "cyan" : complete ? "green" : "gray"}>
              {wizardBreadcrumbLabel(index, label, complete)}
            </Text>
          </React.Fragment>
        )
      })}
    </Box>
  )
}

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

const launcherHarnessLabels: Readonly<Record<string, string>> = {
  cdx: "Codex",
  cpx: "Copilot",
  cldx: "Claude",
  grx: "Grok",
  jcx: "Junie",
  omp: "OpenCode",
  picx: "Pi",
  prx: "Prime",
}

const titleCaseIdentifier = (value: string): string =>
  value
    .split(/[-_]+/u)
    .map((part) => (part.length === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ")

const recommendationHarness = (recommendation: GuideRecommendation): string => {
  if (recommendation.launcher !== undefined) {
    return launcherHarnessLabels[recommendation.launcher] ?? recommendation.launcher
  }
  return titleCaseIdentifier(recommendation.harness ?? recommendation.name)
}

const recommendationLabel = (recommendation: GuideRecommendation): string => {
  if (recommendation.name === "pstack") return "Poteto Mode"
  if (recommendation.name === "hve") {
    return recommendation.launcher === "cdx" ? "HVE Core" : `${recommendationHarness(recommendation)} HVE`
  }
  return titleCaseIdentifier(recommendation.name)
}

const recommendationConfidence = (recommendation: GuideRecommendation): string =>
  `${(recommendation.confidence * 100).toFixed(0)}%`

const RecommendationRail = ({
  recommendations,
  index,
}: {
  readonly recommendations: ReadonlyArray<GuideRecommendation>
  readonly index: number
}) => (
  <Box flexDirection="column" width={30} borderStyle="single" borderColor="gray" paddingX={1}>
    <Text bold>RECOMMENDATIONS</Text>
    {recommendations.map((recommendation, itemIndex) => {
      const active = itemIndex === index
      return (
        <Box key={recommendation.profileRef} flexDirection="column" marginTop={1}>
          <Text bold={active} {...(active ? { color: "green" as const } : {})}>
            {active ? "❯ " : "  "}
            {recommendationLabel(recommendation)}
          </Text>
          <Text dimColor>
            {recommendationHarness(recommendation)} | {recommendationConfidence(recommendation)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {recommendation.workflow.id}
          </Text>
        </Box>
      )
    })}
  </Box>
)

const RecommendationDetail = ({ recommendation }: { readonly recommendation: GuideRecommendation }) => {
  const harness = recommendationHarness(recommendation)
  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
      <Text bold color="cyan">
        {recommendationLabel(recommendation)}
      </Text>
      <Text dimColor>
        {recommendation.profileRef} | {harness} | {recommendationConfidence(recommendation)}
      </Text>
      <Text wrap="wrap">{recommendation.reason}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="green">
          WHY THIS PROFILE OVER PLAIN {harness.toUpperCase()}
        </Text>
        <Text wrap="wrap">• {recommendation.workflow.description}</Text>
        <Text wrap="wrap">
          • Adds the {recommendation.workflow.id} workflow, profile guidance, constraints, and prerequisites.
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">COST OF THIS CHOICE</Text>
        <Text wrap="wrap">{recommendation.tradeoff}</Text>
      </Box>
      <Text dimColor>
        Skill: {recommendation.workflow.skill ?? "none"} | Sandbox: {recommendation.sandbox ? "Docker" : "host"} |
        Headless prompt: {recommendation.headless.prompt ? "yes" : "no"} | Herdr:{" "}
        {recommendation.herdrCompatibility.status}
      </Text>
      <Text dimColor wrap="wrap">
        Prerequisites:{" "}
        {recommendation.prerequisites.length === 0
          ? "none"
          : recommendation.prerequisites.map((prerequisite) => prerequisite.id).join(", ")}
      </Text>
    </Box>
  )
}

const PinnedLenses = ({ lenses }: { readonly lenses: ReadonlyArray<GuidePinnedLens> }) =>
  lenses.length === 0 ? null : (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>PINNED LENSES</Text>
      <Box gap={3}>
        {lenses.map((lens) => (
          <Text key={lens.kind}>
            <Text bold color="magenta">
              {lens.emoji} {lens.key} {lens.label}
            </Text>
            <Text dimColor> — {lens.description}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  )

const RecommendationsView = ({
  pinnedLenses,
  intent,
  model,
  effort,
  recommendations,
  index,
  usedLiteralFallback,
}: {
  readonly pinnedLenses: ReadonlyArray<GuidePinnedLens>
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly recommendations: ReadonlyArray<GuideRecommendation>
  readonly index: number
  readonly usedLiteralFallback: boolean
}) => {
  const recommendation = recommendationAt(recommendations, index)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Recommendations for: {intent}
      </Text>
      <Text dimColor>
        Model: {model} · Effort: {effort}
      </Text>
      {usedLiteralFallback ? <Text color="yellow">Deterministic literal match (no model call).</Text> : null}
      <PinnedLenses lenses={pinnedLenses} />
      <Box marginTop={1}>
        <RecommendationRail recommendations={recommendations} index={index} />
        <RecommendationDetail recommendation={recommendation} />
      </Box>
      <Text dimColor>↑/↓ or j/k select · ↵ generate · c council · r research · h HVE RPI · q cancel</Text>
    </Box>
  )
}

export const candidatePaneHeight = (terminalRows: number): number => Math.max(6, terminalRows - 8)

export const candidateRailWidth = (terminalColumns: number): number =>
  Math.min(30, Math.max(20, Math.floor(terminalColumns * 0.3)))

export const compactCommandPreview = (preview: string): string => preview.replace(/\s+/gu, " ").trim()

const CandidateRail = ({
  candidates,
  index,
  width,
  height,
}: {
  readonly candidates: Triple<GuideGenerateCandidate>
  readonly index: number
  readonly width: number
  readonly height: number
}) => (
  <Box
    flexDirection="column"
    width={width}
    height={height}
    overflowY="hidden"
    borderStyle="single"
    borderColor="gray"
    paddingX={1}
  >
    <Text bold>CANDIDATES</Text>
    {candidates.map((candidate, itemIndex) => {
      const active = itemIndex === index
      return (
        <Box key={`${itemIndex}:${candidate.title}`} flexDirection="column" marginTop={1}>
          <Text bold={active} {...(active ? { color: "green" as const } : {})} wrap="truncate-end">
            {active ? "❯ " : "  "}
            {candidate.title}
          </Text>
          <Text dimColor wrap="truncate-end">
            {candidate.notes}
          </Text>
        </Box>
      )
    })}
  </Box>
)

const CandidateDetail = ({
  candidate,
  height,
}: {
  readonly candidate: GuideGenerateCandidate
  readonly height: number
}) => (
  <Box flexDirection="column" flexGrow={1} height={height} overflowY="hidden" paddingLeft={2}>
    <Text bold color="cyan" wrap="truncate-end">
      {candidate.title}
    </Text>
    <Text dimColor wrap="wrap">
      {candidate.notes}
    </Text>
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="green">
        PROMPT PREVIEW
      </Text>
      <Text wrap="wrap">{candidate.prompt}</Text>
    </Box>
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
}) => {
  const { stdout } = useStdout()
  const paneHeight = candidatePaneHeight(stdout.rows ?? 24)
  const railWidth = candidateRailWidth(stdout.columns ?? 100)
  const candidate = tripleAt(candidates, index)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Prompt candidates
      </Text>
      {usedTemplateFallback ? <Text color="yellow">Deterministic template fallback (no model call).</Text> : null}
      <Box marginTop={1}>
        <CandidateRail candidates={candidates} index={index} width={railWidth} height={paneHeight} />
        <CandidateDetail candidate={candidate} height={paneHeight} />
      </Box>
      <Text dimColor wrap="truncate-end">
        Command: {compactCommandPreview(command.preview)}
        {command.promptHandling === "manual-paste" ? " (manual paste required)" : ""}
      </Text>
      <Text dimColor>
        ↑/↓ or j/k select · ↵ continue · b/Esc back · r refine · e edit · c print full prompt · q cancel
      </Text>
    </Box>
  )
}

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
        const response = await runGuideMatchingStep(
          props.provider,
          props.catalog,
          {
            intent: state.intent ?? "",
            model: props.model,
            effort: props.effort,
          },
          (phase) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.MatchProgress, phase })
          },
        )
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
          (phase) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.GenerateProgress, phase })
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
          props.catalog,
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

const worktreeInspectionAction = (inspection: Awaited<ReturnType<typeof inspectGitWorktreeIntent>>): GuideUiAction => {
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
  const pinnedLens = pinnedGuideLenses(props.catalog).find(({ key: lensKey }) => lensKey === input)
  if (pinnedLens !== undefined) {
    dispatch({
      type: GuideUiActionType.RecommendationsConfirm,
      selectedProfile: selectedProfileForPinnedLens(props.catalog, pinnedLens),
      recommendation: pinnedLens.recommendation,
    })
    return
  }
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.RecommendationsMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.RecommendationsMove, delta: 1 })
  else if (key.return && state.recommendations !== undefined) {
    const recommendation = recommendationAt(state.recommendations, state.recommendationIndex)
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
  else if (key.escape || input === "b") dispatch({ type: GuideUiActionType.CandidatesBack })
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
  } else if (input === "b") dispatch({ type: GuideUiActionType.DestinationBack })
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

const matchingProgress = ({ props, state }: GuideRenderContext): React.ReactElement => (
  <MatchProgress
    catalog={props.catalog}
    phase={state.matchPhase ?? GuideMatchPhase.LoadingProfiles}
    intent={state.intent ?? ""}
    model={props.model}
    effort={props.effort}
  />
)

const renderRecommendations: GuideStageRenderer = (context) =>
  context.state.recommendations === undefined ? (
    matchingProgress(context)
  ) : (
    <RecommendationsView
      pinnedLenses={pinnedGuideLenses(context.props.catalog)}
      intent={context.state.intent ?? ""}
      model={context.props.model}
      effort={context.props.effort}
      recommendations={context.state.recommendations}
      index={context.state.recommendationIndex}
      usedLiteralFallback={context.state.usedLiteralFallback}
    />
  )

const renderCandidateStage: GuideStageRenderer = ({ props, state }) => {
  if (state.candidates === undefined || state.selectedRecommendation === undefined) {
    return <Spinner label="Preparing prompt candidates" messages={["Loading the selected profile workflow"]} />
  }
  if (state.stage === GuideUiStage.RefineEditor)
    return <TextEditor title="Refinement feedback" textDraft={state.textDraft} keys="↵ submit · Esc back" />
  if (state.stage === GuideUiStage.Refining)
    return (
      <Spinner
        label="Refining prompt"
        messages={["Applying your feedback", "Preserving profile-specific requirements"]}
      />
    )
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
    <Spinner
      label="Inspecting git worktree"
      messages={["Checking branch and path collisions", "Resolving the existing worktree location"]}
    />
  ) : (
    <WorktreeCollisionView inspection={state.worktreeInspection} />
  )

const renderWorktreeReady: GuideStageRenderer = ({ state }) =>
  state.worktreeInspection === undefined || "collision" in state.worktreeInspection ? (
    <Spinner
      label="Inspecting git worktree"
      messages={["Checking branch and path collisions", "Preparing worktree confirmation"]}
    />
  ) : (
    <WorktreeReadyView inspection={state.worktreeInspection} confirmations={state.worktreeConfirmations} />
  )

const stageRenderer: Record<GuideUiStage, GuideStageRenderer> = {
  [GuideUiStage.Intent]: ({ state }) => <IntentEditor textDraft={state.textDraft} />,
  [GuideUiStage.Matching]: matchingProgress,
  [GuideUiStage.MatchFailed]: ({ state }) => (
    <ErrorPanel title="Match failed" message={state.errorMessage} keys="r retry · l literal match · q cancel" />
  ),
  [GuideUiStage.Recommendations]: renderRecommendations,
  [GuideUiStage.Generating]: ({ props, state }) =>
    state.selectedRecommendation === undefined || state.intent === undefined ? (
      <Spinner label="Preparing prompt candidates" />
    ) : (
      <GenerationProgress
        recommendation={state.selectedRecommendation}
        phase={state.generationPhase ?? GuideGenerationPhase.LoadingProfile}
        intent={state.intent}
        model={props.model}
      />
    ),
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
  [GuideUiStage.CheckingReadiness]: ({ state }) => (
    <Spinner
      label="Checking profile readiness"
      messages={[
        state.selectedRecommendation === undefined
          ? "Checking runtime requirements"
          : `Checking ${recommendationLabel(state.selectedRecommendation)} requirements`,
        "Confirming the selected profile can launch",
      ]}
    />
  ),
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
  [GuideUiStage.InspectingWorktree]: () => (
    <Spinner
      label="Inspecting git worktree"
      messages={["Checking branch and path collisions", "Reviewing the source checkout state"]}
    />
  ),
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

  const activeWizardStep = wizardStepForStage(state.stage)
  return (
    <Box flexDirection="column">
      {activeWizardStep === undefined ? null : <WizardBreadcrumbs activeStep={activeWizardStep} />}
      {stageRenderer[state.stage]({ props, state, herdrEnabled })}
    </Box>
  )
}
