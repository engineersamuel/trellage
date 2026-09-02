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
import React, { createContext, useContext, useEffect, useReducer, useRef, useState } from "react"
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from "ink"
import stringWidth from "string-width"

import {
  profileGuideIdentityKey,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
} from "../../trellage-guide-core/dist/index.js"
import {
  basketBlockPreview,
  basketVisibleRange,
  countLabel,
  countTextLines,
  type BasketBlockPreview,
} from "./basket.js"
import { compactProfileGuide, type CombinedGuideCatalog } from "./guide-catalog.js"
import {
  applyRequiredProfilePromptTemplate,
  guideIntentMaximumLength,
  guideTargetTool,
  GuideLongPromptVariant,
  literalGuideMatch,
  publicGuideLaunchCommand,
  runGuideMatch,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
  type GuideEffort,
  type GuideMatchResponse,
  type GuideModelConfig,
  type GuideRecommendation,
  type GuideResolvedModelRouting,
  type PublicGuideCommand,
} from "./guide-api.js"
import type { GuideArtifactCache } from "./guide-match-cache.js"
import type { GuideGenerateCandidate, GuideProvider } from "./guide-provider.js"
import { loadSelectedGuide, type SelectedGuideDocument } from "./guide-selected.js"
import {
  GuideCandidatePromptCollisionError,
  GuideCandidatePromptStage,
  renderWorkflowBodyCandidate,
  requireDistinctGuideCandidatePrompts,
  resolveGeneratedWorkflowBodyCandidate,
  resolveRefinedWorkflowBodyCandidate,
  resolveWorkflowBodyCandidate,
  workflowBodyCandidate,
  workflowOptimizeFixedFrame,
} from "./guide-workflow-prompt.js"
import {
  buildGuideLaunchCommand,
  buildHerdrGuideLaunch,
  defaultWorktreeBranch,
  getHerdrContext,
  inspectGitWorktreeIntent,
  parseSelectedProfile,
  renderCommandPreview,
  type CommandRunner,
  type CommandSpec,
  type GitInspectionReady,
  type GuideCaptureProvenance,
  type HerdrContext,
  type HerdrEnvironment,
  type HerdrPromptDeliveryMode,
  type HerdrInvocationSurface,
  type HerdrSplitDirection,
  type PromptHandlingMode,
  type SelectedProfile,
  type WorktreeCollisionResult,
} from "./guide-launch.js"
import { checkSelectedProfileReadiness, ProfileReadinessKind, type ProfileReadinessResult } from "./guide-preflight.js"
import {
  describeJobPlacement,
  emptyGuideQueue,
  enqueueGuideJob,
  removeQueuedGuideJobById,
  removeSelectedQueuedGuideJob,
  replaceQueuedGuideJob,
  selectQueuedGuideJob,
  startQueuedGuidePromptEdit,
  submitQueuedGuidePromptEdit,
  executeGuideBatch,
  type GuideBatch,
  type GuideBatchExecutionResult,
  type GuideBatchProgressEvent,
  type GuideQueueState,
  type QueuedGuideJob,
  type JobPlacement,
} from "./guide-batch.js"

// ---------------------------------------------------------------------------
// Shared small helpers.
// ---------------------------------------------------------------------------

type Triple<T> = readonly [T, T, T]

const feedbackMaxLength = 2000
const branchMaxLength = 200
/** Mirrors guide-provider.ts's `validateGenerateCandidate` inline 8000-character prompt bound. */
const promptMaxLength = 8000
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u
const pastedControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu

const textCharacterLength = (value: string): number => [...value].length
const takeTextCharacters = (value: string, maximum: number): string =>
  [...value].slice(0, Math.max(0, maximum)).join("")
const removeLastTextCharacter = (value: string): string => takeTextCharacters(value, textCharacterLength(value) - 1)

/** True when appending `addition` to `current` would stay within `maxLength`. Shared by every bounded text editor. */
export const isWithinTextBound = (current: string, addition: string, maxLength: number): boolean =>
  textCharacterLength(current) + textCharacterLength(addition) <= maxLength

export const boundedPastedText = (current: string, pasted: string, maximum: number): string => {
  const normalized = pasted.replace(/\r\n?/gu, "\n").replace(pastedControlCharacters, "")
  return takeTextCharacters(normalized, maximum - textCharacterLength(current))
}

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

const selectedGuideWorkflow = (guide: ProfileGuideV1, workflowId: string): ProfileGuideWorkflow => {
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`Unknown workflow reference: ${workflowId}`)
  return workflow
}

// ---------------------------------------------------------------------------
// Stage discriminant (string enum per repository convention).
// ---------------------------------------------------------------------------

export enum GuideUiStage {
  Intent = "intent",
  Matching = "matching",
  MatchFailed = "match-failed",
  Recommendations = "recommendations",
  PromptReview = "prompt-review",
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
  Queue = "queue",
  QueueEntry = "queue-entry",
  QueuePromptEditor = "queue-prompt-editor",
  QueuePlacement = "queue-placement",
  Launching = "launching",
}

const editingStages: ReadonlySet<GuideUiStage> = new Set([
  GuideUiStage.RefineEditor,
  GuideUiStage.DirectEditor,
  GuideUiStage.WorktreeBranchEditor,
  GuideUiStage.QueuePromptEditor,
])

export enum GuideUiDestination {
  CurrentTerminal = "current-terminal",
  CurrentHerdrWorkspace = "current-herdr-workspace",
  NewHerdrTab = "new-herdr-tab",
  NewHerdrWorktree = "new-herdr-worktree",
}

/** What each destination reads as on screen. */
export const destinationLabels: Readonly<Record<GuideUiDestination, string>> = {
  [GuideUiDestination.CurrentTerminal]: "This terminal",
  [GuideUiDestination.CurrentHerdrWorkspace]: "New pane in this Herdr workspace",
  [GuideUiDestination.NewHerdrTab]: "New tab in this Herdr worktree",
  [GuideUiDestination.NewHerdrWorktree]: "New Herdr worktree",
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
  [GuideUiStage.PromptReview]: GuideWizardStep.Profile,
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
  [GuideUiStage.Queue]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.QueueEntry]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.QueuePromptEditor]: GuideWizardStep.PromptCandidates,
  [GuideUiStage.QueuePlacement]: GuideWizardStep.Destination,
  [GuideUiStage.Launching]: GuideWizardStep.Destination,
}

export const wizardStepForStage = (stage: GuideUiStage): GuideWizardStep | undefined => wizardStepByStage[stage]

/** The destination choices offered, in display order. Herdr choices only appear when `herdrEnabled`. */
export const destinationOptions = (
  herdrEnabled: boolean,
  surface: HerdrInvocationSurface = "pane",
): ReadonlyArray<GuideUiDestination> =>
  herdrEnabled
    ? surface === "popup"
      ? [GuideUiDestination.CurrentHerdrWorkspace, GuideUiDestination.NewHerdrTab, GuideUiDestination.NewHerdrWorktree]
      : [
          GuideUiDestination.CurrentTerminal,
          GuideUiDestination.CurrentHerdrWorkspace,
          GuideUiDestination.NewHerdrTab,
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
  readonly promptReviewReturnStage:
    | GuideUiStage.Matching
    | GuideUiStage.MatchFailed
    | GuideUiStage.Recommendations
    | undefined
  readonly promptReviewEditing: boolean
  readonly queue: GuideQueueState
  /** Where `b` returns from the worktree sub-flow, which both placement screens share. */
  readonly worktreeReturnStage: GuideUiStage.Destination | GuideUiStage.QueuePlacement
  /** The git checkout every queued worktree placement was resolved against. */
  readonly primaryCheckoutPath: string | undefined
  /** The batch `L` is launching; `undefined` unless the launch screen is showing. */
  readonly launchBatch: GuideBatch | undefined
  /** The newest step reported for each queued job, in queue order. */
  readonly launchProgress: ReadonlyArray<GuideBatchProgressEvent>
  /** Every unfinished draft opened from the main screen, in tab order. */
  readonly forks: ReadonlyArray<GuideForkTab>
  /** `undefined` means the main recommendations screen is showing. */
  readonly activeForkId: number | undefined
  readonly nextForkId: number
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
  promptReviewReturnStage: undefined,
  promptReviewEditing: false,
  queue: emptyGuideQueue(),
  worktreeReturnStage: GuideUiStage.Destination,
  primaryCheckoutPath: undefined,
  launchBatch: undefined,
  launchProgress: [],
  forks: [],
  activeForkId: undefined,
  nextForkId: 1,
}

/** Builds initial state and starts matching immediately when a supplied intent is present. */
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
// Fork tabs. A tab and a queue entry are the same thing seen twice: the main
// screen keeps the intent, the recommendations and the queue, while each tab
// keeps its own profile, prompt candidate and destination. An unfinished tab
// holds no entry yet; adding it to the queue binds the two, and removing
// either one removes the other, so the tab bar always reads as the queue.
// ---------------------------------------------------------------------------

/** The state the main screen and every fork share. Everything else is per fork. */
type GuideForkSharedKey =
  | "intent"
  | "matchPhase"
  | "recommendations"
  | "recommendationIndex"
  | "usedLiteralFallback"
  | "queue"
  | "primaryCheckoutPath"
  | "launchBatch"
  | "launchProgress"
  | "forks"
  | "activeForkId"
  | "nextForkId"

export type GuideForkSlice = Omit<GuideUiState, GuideForkSharedKey>

export interface GuideForkTab {
  readonly id: number
  readonly slice: GuideForkSlice
  /** The queue entry this tab produced, or `undefined` while its draft is unfinished. */
  readonly jobId: number | undefined
}

/** Drops every shared field, so a parked fork can never overwrite the intent, the recommendations or the queue. */
const forkSlice = ({
  intent: _intent,
  matchPhase: _matchPhase,
  recommendations: _recommendations,
  recommendationIndex: _recommendationIndex,
  usedLiteralFallback: _usedLiteralFallback,
  queue: _queue,
  primaryCheckoutPath: _primaryCheckoutPath,
  launchBatch: _launchBatch,
  launchProgress: _launchProgress,
  forks: _forks,
  activeForkId: _activeForkId,
  nextForkId: _nextForkId,
  ...slice
}: GuideUiState): GuideForkSlice => slice

const mainForkSlice: GuideForkSlice = forkSlice({ ...emptyState, stage: GuideUiStage.Recommendations })

/** Writes the live state back into the active fork, so leaving a tab keeps its progress. */
const parkActiveFork = (state: GuideUiState): GuideUiState =>
  state.activeForkId === undefined
    ? state
    : {
        ...state,
        forks: state.forks.map((fork) =>
          fork.id === state.activeForkId ? { ...fork, slice: forkSlice(state) } : fork,
        ),
      }

const enterMainScreen = (state: GuideUiState): GuideUiState => ({
  ...parkActiveFork(state),
  ...mainForkSlice,
  activeForkId: undefined,
})

const enterFork = (state: GuideUiState, id: number): GuideUiState => {
  const parked = parkActiveFork(state)
  const target = parked.forks.find((fork) => fork.id === id)
  return target === undefined ? state : { ...parked, ...target.slice, activeForkId: id }
}

const openFork = (state: GuideUiState, slice: GuideForkSlice): GuideUiState => {
  const parked = parkActiveFork(state)
  return {
    ...parked,
    ...slice,
    forks: [...parked.forks, { id: parked.nextForkId, slice, jobId: undefined }],
    activeForkId: parked.nextForkId,
    nextForkId: parked.nextForkId + 1,
  }
}

/** Binds the active tab to the entry it just produced and returns to the main screen. The tab stays. */
const bindActiveForkToJob = (state: GuideUiState, jobId: number): GuideUiState => {
  const parked = parkActiveFork(state)
  return {
    ...parked,
    ...mainForkSlice,
    forks: parked.forks.map((fork) => (fork.id === state.activeForkId ? { ...fork, jobId } : fork)),
    activeForkId: undefined,
  }
}

/** Drops the active tab and, because the two are one thing, the queue entry it held. */
const dropActiveFork = (state: GuideUiState): GuideUiState => {
  const dropped = state.forks.find((fork) => fork.id === state.activeForkId)
  if (dropped === undefined) return state
  const main = enterMainScreen(state)
  return {
    ...main,
    forks: main.forks.filter((fork) => fork.id !== dropped.id),
    queue: dropped.jobId === undefined ? main.queue : removeQueuedGuideJobById(main.queue, dropped.jobId),
  }
}

/** The state one fork sees: the shared fields live, its own fields from its slice. */
const hydrateFork = (state: GuideUiState, slice: GuideForkSlice): GuideUiState => ({ ...state, ...slice })

/** The state the fork with `id` is really in, whether it is on screen or parked. */
export const forkState = (state: GuideUiState, id: number): GuideUiState | undefined => {
  if (state.activeForkId === id) return state
  const target = state.forks.find((fork) => fork.id === id)
  return target === undefined ? undefined : hydrateFork(state, target.slice)
}

/** Every stage that waits on a model or a git call. A tab in one of these shows a spinner. */
const busyStages: ReadonlySet<GuideUiStage> = new Set([
  GuideUiStage.Matching,
  GuideUiStage.Generating,
  GuideUiStage.Refining,
  GuideUiStage.CheckingReadiness,
  GuideUiStage.InspectingWorktree,
])

export const forkIsBusy = (state: GuideUiState, id: number): boolean => {
  const target = forkState(state, id)
  return target !== undefined && busyStages.has(target.stage)
}

/** Tab order: the main screen first, then every open fork. */
const cycleFork = (state: GuideUiState, delta: 1 | -1): GuideUiState => {
  const ids: ReadonlyArray<number | undefined> = [undefined, ...state.forks.map((fork) => fork.id)]
  const next = ids[(ids.indexOf(state.activeForkId) + delta + ids.length) % ids.length]
  return next === undefined ? enterMainScreen(state) : enterFork(state, next)
}

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
  PromptReviewOpen = "prompt-review/open",
  PromptReviewEdit = "prompt-review/edit",
  PromptReviewChange = "prompt-review/change",
  PromptReviewBackspace = "prompt-review/backspace",
  PromptReviewSubmit = "prompt-review/submit",
  PromptReviewBack = "prompt-review/back",
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
  CandidatesEnqueue = "candidates/enqueue",
  CandidatesViewQueue = "candidates/view-queue",
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
  DestinationEnqueue = "destination/enqueue",
  WorktreeSubmitBranch = "worktree/submit-branch",
  WorktreeInvalidBranch = "worktree/invalid-branch",
  WorktreeInspectFailed = "worktree/inspect-failed",
  WorktreeCollision = "worktree/collision",
  WorktreeReady = "worktree/ready",
  WorktreeConfirm = "worktree/confirm",
  WorktreeEditBranch = "worktree/edit-branch",
  WorktreeBack = "worktree/back",
  QueueMove = "queue/move",
  QueueOpenEntry = "queue/open-entry",
  QueueEditStart = "queue/edit-start",
  QueueEditSubmit = "queue/edit-submit",
  QueueRemove = "queue/remove",
  QueueAddAnother = "queue/add-another",
  QueueBack = "queue/back",
  QueueExecuteBlocked = "queue/execute-blocked",
  LaunchStart = "launch/start",
  LaunchProgress = "launch/progress",
  QueuePlacementMove = "queue-placement/move",
  QueuePlacementBack = "queue-placement/back",
  QueuePlacementUnavailable = "queue-placement/unavailable",
  QueuePlacementHere = "queue-placement/here",
  QueuePlacementStartWorktree = "queue-placement/start-worktree",
  QueuePlacementWorktree = "queue-placement/worktree",
  ForkNext = "fork/next",
  ForkPrevious = "fork/previous",
  ForkMain = "fork/main",
  ForkSelect = "fork/select",
  ForkDrop = "fork/drop",
  ForkDeliver = "fork/deliver",
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
  | { readonly type: GuideUiActionType.PromptReviewOpen }
  | { readonly type: GuideUiActionType.PromptReviewEdit; readonly editing: boolean }
  | { readonly type: GuideUiActionType.PromptReviewChange; readonly text: string }
  | { readonly type: GuideUiActionType.PromptReviewBackspace }
  | { readonly type: GuideUiActionType.PromptReviewSubmit }
  | { readonly type: GuideUiActionType.PromptReviewBack }
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
  | { readonly type: GuideUiActionType.CandidatesEnqueue }
  | { readonly type: GuideUiActionType.CandidatesViewQueue }
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
  | { readonly type: GuideUiActionType.DestinationEnqueue; readonly placement: JobPlacement }
  | { readonly type: GuideUiActionType.WorktreeSubmitBranch }
  | { readonly type: GuideUiActionType.WorktreeInvalidBranch }
  | { readonly type: GuideUiActionType.WorktreeInspectFailed; readonly message: string }
  | { readonly type: GuideUiActionType.WorktreeCollision; readonly inspection: WorktreeCollisionResult }
  | { readonly type: GuideUiActionType.WorktreeReady; readonly inspection: GitInspectionReady }
  | { readonly type: GuideUiActionType.WorktreeConfirm }
  | { readonly type: GuideUiActionType.WorktreeEditBranch }
  | { readonly type: GuideUiActionType.WorktreeBack }
  | { readonly type: GuideUiActionType.QueueMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.QueueOpenEntry }
  | { readonly type: GuideUiActionType.QueueEditStart }
  | { readonly type: GuideUiActionType.QueueEditSubmit }
  | { readonly type: GuideUiActionType.QueueRemove }
  | { readonly type: GuideUiActionType.QueueAddAnother }
  | { readonly type: GuideUiActionType.QueueBack }
  | { readonly type: GuideUiActionType.QueueExecuteBlocked; readonly message: string }
  | { readonly type: GuideUiActionType.LaunchStart; readonly batch: GuideBatch }
  | { readonly type: GuideUiActionType.LaunchProgress; readonly event: GuideBatchProgressEvent }
  | { readonly type: GuideUiActionType.QueuePlacementMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.QueuePlacementBack }
  | { readonly type: GuideUiActionType.QueuePlacementUnavailable }
  | { readonly type: GuideUiActionType.QueuePlacementHere }
  | { readonly type: GuideUiActionType.QueuePlacementStartWorktree }
  | {
      readonly type: GuideUiActionType.QueuePlacementWorktree
      readonly placement: JobPlacement
      readonly primaryCheckoutPath: string
    }
  | { readonly type: GuideUiActionType.ForkNext }
  | { readonly type: GuideUiActionType.ForkPrevious }
  | { readonly type: GuideUiActionType.ForkMain }
  | { readonly type: GuideUiActionType.ForkSelect; readonly index: number }
  | { readonly type: GuideUiActionType.ForkDrop }
  | { readonly type: GuideUiActionType.ForkDeliver; readonly forkId: number; readonly action: GuideUiAction }

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
      return state.stage === GuideUiStage.Intent
        ? { ...state, textDraft: removeLastTextCharacter(state.textDraft) }
        : state

    case GuideUiActionType.IntentSubmit: {
      if (state.stage !== GuideUiStage.Intent) return state
      const trimmed = state.textDraft.trim()
      if (trimmed.length === 0) return state
      return {
        ...emptyState,
        queue: state.queue,
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

const promptReviewSourceStage = (
  stage: GuideUiStage,
): GuideUiStage.Matching | GuideUiStage.MatchFailed | GuideUiStage.Recommendations | undefined => {
  if (stage === GuideUiStage.Matching || stage === GuideUiStage.MatchFailed || stage === GuideUiStage.Recommendations) {
    return stage
  }
  return undefined
}

const openPromptReview = (state: GuideUiState): GuideUiState => {
  const returnStage = promptReviewSourceStage(state.stage)
  return returnStage === undefined || state.intent === undefined
    ? state
    : {
        ...state,
        stage: GuideUiStage.PromptReview,
        textDraft: state.intent,
        promptReviewReturnStage: returnStage,
        promptReviewEditing: false,
      }
}

const closePromptReview = (state: GuideUiState): GuideUiState =>
  state.promptReviewEditing
    ? { ...state, promptReviewEditing: false, textDraft: state.intent ?? state.textDraft }
    : {
        ...state,
        stage: state.promptReviewReturnStage ?? GuideUiStage.Matching,
        textDraft: "",
        promptReviewReturnStage: undefined,
      }

const submitPromptReview = (state: GuideUiState): GuideUiState => {
  const intent = state.textDraft.trim()
  if (intent.length === 0) return state
  if (intent === state.intent) {
    return {
      ...state,
      stage: state.promptReviewReturnStage ?? GuideUiStage.Matching,
      textDraft: "",
      promptReviewReturnStage: undefined,
      promptReviewEditing: false,
    }
  }
  return {
    ...emptyState,
    queue: state.queue,
    stage: GuideUiStage.Matching,
    intent,
    matchPhase: GuideMatchPhase.LoadingProfiles,
  }
}

const reducePromptReview = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  if (action.type === GuideUiActionType.PromptReviewOpen) return openPromptReview(state)
  if (state.stage !== GuideUiStage.PromptReview) return state
  switch (action.type) {
    case GuideUiActionType.PromptReviewEdit:
      return { ...state, promptReviewEditing: action.editing }
    case GuideUiActionType.PromptReviewChange:
      return state.promptReviewEditing ? { ...state, textDraft: action.text } : state
    case GuideUiActionType.PromptReviewBackspace:
      return state.promptReviewEditing ? { ...state, textDraft: removeLastTextCharacter(state.textDraft) } : state
    case GuideUiActionType.PromptReviewBack:
      return closePromptReview(state)
    case GuideUiActionType.PromptReviewSubmit:
      return submitPromptReview(state)
    default:
      return state
  }
}

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
      const slice: GuideForkSlice = {
        ...forkSlice(state),
        stage: GuideUiStage.Generating,
        selectedRecommendation:
          action.recommendation ?? recommendationAt(state.recommendations, state.recommendationIndex),
        selectedProfile: action.selectedProfile,
        guideDocument: undefined,
        generationPhase: GuideGenerationPhase.LoadingProfile,
        candidates: undefined,
        usedTemplateFallback: false,
        errorMessage: undefined,
      }
      // From the main screen this starts a new fork; inside a fork it replaces
      // that fork's profile, so `b` back from the candidates still works.
      return state.activeForkId === undefined ? openFork(state, slice) : { ...state, ...slice }
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

const reduceCandidateNavigation = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
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

    case GuideUiActionType.CandidatesEnqueue:
      return state.stage === GuideUiStage.Candidates &&
        state.candidates !== undefined &&
        state.selectedProfile !== undefined
        ? { ...state, stage: GuideUiStage.QueuePlacement, destinationIndex: 0, errorMessage: undefined }
        : state

    // The queue belongs to the main screen, so viewing it parks whatever tab is open.
    case GuideUiActionType.CandidatesViewQueue:
      return state.queue.entries.length > 0
        ? { ...enterMainScreen(state), stage: GuideUiStage.Queue, errorMessage: undefined }
        : state

    default:
      return state
  }
}

const candidateEditingWorkflow = (state: GuideUiState): ProfileGuideWorkflow | undefined =>
  state.guideDocument === undefined || state.selectedRecommendation === undefined
    ? undefined
    : selectedGuideWorkflow(state.guideDocument.guide, state.selectedRecommendation.workflowId)

const candidateDirectEditDraft = (state: GuideUiState): string => {
  if (state.candidates === undefined) throw new Error("Direct editing requires prompt candidates")
  const current = tripleAt(state.candidates, state.candidateIndex)
  const workflow = candidateEditingWorkflow(state)
  return workflow === undefined ? current.prompt : workflowBodyCandidate(workflow, current).prompt
}

const reduceCandidateEditing = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.CandidatesRefineStart:
      return state.stage === GuideUiStage.Candidates
        ? { ...state, stage: GuideUiStage.RefineEditor, textDraft: "", errorMessage: undefined }
        : state

    case GuideUiActionType.CandidatesDirectEditStart:
      return state.stage === GuideUiStage.Candidates && state.candidates !== undefined
        ? {
            ...state,
            stage: GuideUiStage.DirectEditor,
            textDraft: candidateDirectEditDraft(state),
            errorMessage: undefined,
          }
        : state

    default:
      return state
  }
}

const reduceCandidateSelection = (state: GuideUiState, action: GuideUiAction): GuideUiState =>
  reduceCandidateEditing(reduceCandidateNavigation(state, action), action)

const directlyEditedCandidate = (state: GuideUiState): GuideGenerateCandidate => {
  if (state.candidates === undefined) throw new Error("Direct editing requires prompt candidates")
  const current = tripleAt(state.candidates, state.candidateIndex)
  const edited = { ...current, prompt: state.textDraft }
  const workflow = candidateEditingWorkflow(state)
  return workflow === undefined ? edited : renderWorkflowBodyCandidate(workflow, edited)
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
            candidates: replaceCandidateAt(state.candidates, state.candidateIndex, directlyEditedCandidate(state)),
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
      return editingStages.has(state.stage) ? { ...state, textDraft: removeLastTextCharacter(state.textDraft) } : state

    default:
      return state
  }
}

const refineSucceededState = (state: GuideUiState, candidate: GuideGenerateCandidate): GuideUiState => {
  if (state.stage !== GuideUiStage.Refining || state.candidates === undefined) return state
  try {
    return {
      ...state,
      stage: GuideUiStage.Candidates,
      candidates: requireDistinctGuideCandidatePrompts(
        replaceCandidateAt(state.candidates, state.candidateIndex, candidate),
        GuideCandidatePromptStage.FinalRendering,
      ),
      errorMessage: undefined,
    }
  } catch (cause) {
    if (!(cause instanceof GuideCandidatePromptCollisionError)) throw cause
    return {
      ...state,
      stage: GuideUiStage.RefineFailed,
      errorMessage: cause.message,
    }
  }
}

const reduceRefine = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.RefineSubmit:
      return state.stage === GuideUiStage.RefineEditor && state.textDraft.trim().length > 0
        ? { ...state, stage: GuideUiStage.Refining, errorMessage: undefined }
        : state

    case GuideUiActionType.RefineSucceeded:
      return refineSucceededState(state, action.candidate)

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
      if (state.stage !== GuideUiStage.CheckingReadiness) return state
      return { ...state, stage: GuideUiStage.Destination, readiness: action.result, destinationIndex: 0 }

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
            worktreeReturnStage: GuideUiStage.Destination,
          }
        : state

    case GuideUiActionType.DestinationEnqueue:
      return state.stage === GuideUiStage.Destination ? enqueueSelectedCandidate(state, action.placement) : state

    default:
      return state
  }
}

const reduceQueueNavigation = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.QueueMove:
      return state.stage === GuideUiStage.Queue
        ? { ...state, queue: selectQueuedGuideJob(state.queue, action.delta) }
        : state
    case GuideUiActionType.QueueOpenEntry:
      return state.stage === GuideUiStage.Queue && state.queue.entries[state.queue.selectedIndex] !== undefined
        ? { ...state, stage: GuideUiStage.QueueEntry }
        : state
    case GuideUiActionType.QueueBack:
      if (state.stage === GuideUiStage.QueueEntry) return { ...state, stage: GuideUiStage.Queue }
      if (state.stage === GuideUiStage.QueuePromptEditor) {
        const { editingId: _, ...queue } = state.queue
        return { ...state, stage: GuideUiStage.Queue, queue, errorMessage: undefined }
      }
      return state.stage === GuideUiStage.Queue
        ? {
            ...state,
            stage: state.candidates === undefined ? GuideUiStage.Recommendations : GuideUiStage.Candidates,
            errorMessage: undefined,
          }
        : state
    default:
      return state
  }
}

const reduceQueueEditing = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.QueueEditStart: {
      if (state.stage !== GuideUiStage.Queue) return state
      const queue = startQueuedGuidePromptEdit(state.queue)
      const job = queue.entries[queue.selectedIndex]
      return job === undefined
        ? state
        : { ...state, stage: GuideUiStage.QueuePromptEditor, queue, textDraft: job.prompt }
    }
    case GuideUiActionType.QueueEditSubmit:
      return state.stage === GuideUiStage.QueuePromptEditor && state.textDraft.trim().length > 0
        ? { ...state, stage: GuideUiStage.Queue, queue: submitQueuedGuidePromptEdit(state.queue, state.textDraft) }
        : state
    default:
      return state
  }
}

const reduceQueueContents = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.QueueRemove: {
      const removed = state.stage === GuideUiStage.Queue ? state.queue.entries[state.queue.selectedIndex] : undefined
      return removed === undefined
        ? state
        : {
            ...state,
            queue: removeSelectedQueuedGuideJob(state.queue),
            forks: state.forks.filter((fork) => fork.jobId !== removed.id),
            errorMessage: undefined,
          }
    }
    case GuideUiActionType.QueueAddAnother:
      if (state.stage !== GuideUiStage.Queue) return state
      return state.recommendations === undefined
        ? { ...emptyState, queue: state.queue, primaryCheckoutPath: state.primaryCheckoutPath }
        : enterMainScreen(state)
    case GuideUiActionType.QueueExecuteBlocked:
      return state.stage === GuideUiStage.Queue ? { ...state, errorMessage: action.message } : state
    default:
      return state
  }
}

const reduceQueue = (state: GuideUiState, action: GuideUiAction): GuideUiState =>
  reduceQueueContents(reduceQueueEditing(reduceQueueNavigation(state, action), action), action)

/**
 * Drives the launch screen. The launch belongs to the whole queue, not to one
 * tab, so it starts on the main screen: the effects that run it read the main
 * slice, and a parked fork keeps its own progress.
 */
const reduceLaunch = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  if (action.type === GuideUiActionType.LaunchStart) {
    return {
      ...enterMainScreen(state),
      stage: GuideUiStage.Launching,
      launchBatch: action.batch,
      launchProgress: [],
    }
  }
  if (action.type !== GuideUiActionType.LaunchProgress) return state
  const known = state.launchProgress.some((event) => event.jobId === action.event.jobId)
  return {
    ...state,
    launchProgress: known
      ? state.launchProgress.map((event) => (event.jobId === action.event.jobId ? action.event : event))
      : [...state.launchProgress, action.event],
  }
}

/**
 * Adds the candidate on screen to the queue with the placement just chosen for
 * it. Every entry picks its own placement, so a queue can mix panes here with
 * one worktree per entry.
 */
const enqueueSelectedCandidate = (
  state: GuideUiState,
  placement: JobPlacement,
  primaryCheckoutPath?: string,
): GuideUiState => {
  const profile = state.selectedProfile
  if (state.candidates === undefined || profile === undefined) return state
  const prompt = tripleAt(state.candidates, state.candidateIndex).prompt
  const held = state.forks.find((fork) => fork.id === state.activeForkId)?.jobId
  return {
    ...bindActiveForkToJob(state, held ?? state.queue.nextId),
    stage: GuideUiStage.Queue,
    queue:
      held === undefined
        ? enqueueGuideJob(state.queue, profile, prompt, placement)
        : replaceQueuedGuideJob(state.queue, held, profile, prompt, placement),
    ...(primaryCheckoutPath === undefined ? {} : { primaryCheckoutPath }),
    errorMessage: undefined,
  }
}

const reduceQueuePlacement = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.QueuePlacementMove:
      return state.stage === GuideUiStage.QueuePlacement
        ? { ...state, destinationIndex: (state.destinationIndex + action.delta + 2) % 2 }
        : state
    case GuideUiActionType.QueuePlacementBack:
      return state.stage === GuideUiStage.QueuePlacement ? { ...state, stage: GuideUiStage.Candidates } : state
    case GuideUiActionType.QueuePlacementUnavailable:
      return state.stage === GuideUiStage.QueuePlacement
        ? { ...state, errorMessage: "Herdr is unavailable. Start trx guide from a Herdr pane or popup." }
        : state
    case GuideUiActionType.QueuePlacementHere:
      return state.stage === GuideUiStage.QueuePlacement
        ? enqueueSelectedCandidate(state, { kind: "current-workspace-pane", direction: "right" })
        : state
    case GuideUiActionType.QueuePlacementStartWorktree:
      return state.stage === GuideUiStage.QueuePlacement
        ? {
            ...state,
            stage: GuideUiStage.WorktreeBranchEditor,
            textDraft: defaultWorktreeBranch(state.intent ?? "queue"),
            worktreeInspection: undefined,
            worktreeReturnStage: GuideUiStage.QueuePlacement,
            errorMessage: undefined,
          }
        : state
    case GuideUiActionType.QueuePlacementWorktree:
      return enqueueSelectedCandidate(state, action.placement, action.primaryCheckoutPath)
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
        ? {
            ...state,
            stage: state.worktreeReturnStage,
            worktreeInspection: undefined,
            worktreeConfirmations: 0,
          }
        : state

    default:
      return state
  }
}

/**
 * An async result belongs to the fork that started it, which is often not the
 * fork on screen: a parked fork keeps generating and its result is written
 * straight into its slice, so no work is lost and no tab has to be visited.
 */
const deliverToFork = (state: GuideUiState, forkId: number, action: GuideUiAction): GuideUiState => {
  if (action.type === GuideUiActionType.ForkDeliver) return state
  if (state.activeForkId === forkId) return guideUiReducer(state, action)
  const target = state.forks.find((fork) => fork.id === forkId)
  if (target === undefined) return state
  const applied = guideUiReducer(hydrateFork(state, target.slice), action)
  return {
    ...applied,
    ...forkSlice(state),
    forks: applied.forks.map((fork) => (fork.id === forkId ? { ...fork, slice: forkSlice(applied) } : fork)),
  }
}

const reduceFork = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.ForkNext:
      return cycleFork(state, 1)
    case GuideUiActionType.ForkPrevious:
      return cycleFork(state, -1)
    case GuideUiActionType.ForkMain:
      return state.stage === GuideUiStage.Recommendations && state.activeForkId === undefined
        ? state
        : enterMainScreen(state)
    case GuideUiActionType.ForkSelect: {
      const target = state.forks[action.index]
      return target === undefined ? state : enterFork(state, target.id)
    }
    case GuideUiActionType.ForkDrop:
      return dropActiveFork(state)
    case GuideUiActionType.ForkDeliver:
      return deliverToFork(state, action.forkId, action.action)
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
  [GuideUiActionType.PromptReviewOpen]: reducePromptReview,
  [GuideUiActionType.PromptReviewEdit]: reducePromptReview,
  [GuideUiActionType.PromptReviewChange]: reducePromptReview,
  [GuideUiActionType.PromptReviewBackspace]: reducePromptReview,
  [GuideUiActionType.PromptReviewSubmit]: reducePromptReview,
  [GuideUiActionType.PromptReviewBack]: reducePromptReview,
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
  [GuideUiActionType.CandidatesEnqueue]: reduceCandidateSelection,
  [GuideUiActionType.CandidatesViewQueue]: reduceCandidateSelection,
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
  [GuideUiActionType.DestinationEnqueue]: reduceDestination,
  [GuideUiActionType.WorktreeSubmitBranch]: reduceWorktreeBranch,
  [GuideUiActionType.WorktreeInvalidBranch]: reduceWorktreeBranch,
  [GuideUiActionType.WorktreeInspectFailed]: reduceWorktreeBranch,
  [GuideUiActionType.WorktreeCollision]: reduceWorktreeInspection,
  [GuideUiActionType.WorktreeReady]: reduceWorktreeInspection,
  [GuideUiActionType.WorktreeConfirm]: reduceWorktreeResolution,
  [GuideUiActionType.WorktreeEditBranch]: reduceWorktreeResolution,
  [GuideUiActionType.WorktreeBack]: reduceWorktreeResolution,
  [GuideUiActionType.QueueMove]: reduceQueue,
  [GuideUiActionType.QueueOpenEntry]: reduceQueue,
  [GuideUiActionType.QueueEditStart]: reduceQueue,
  [GuideUiActionType.QueueEditSubmit]: reduceQueue,
  [GuideUiActionType.QueueRemove]: reduceQueue,
  [GuideUiActionType.QueueAddAnother]: reduceQueue,
  [GuideUiActionType.QueueBack]: reduceQueue,
  [GuideUiActionType.QueueExecuteBlocked]: reduceQueue,
  [GuideUiActionType.LaunchStart]: reduceLaunch,
  [GuideUiActionType.LaunchProgress]: reduceLaunch,
  [GuideUiActionType.QueuePlacementMove]: reduceQueuePlacement,
  [GuideUiActionType.QueuePlacementBack]: reduceQueuePlacement,
  [GuideUiActionType.QueuePlacementUnavailable]: reduceQueuePlacement,
  [GuideUiActionType.QueuePlacementHere]: reduceQueuePlacement,
  [GuideUiActionType.QueuePlacementStartWorktree]: reduceQueuePlacement,
  [GuideUiActionType.QueuePlacementWorktree]: reduceQueuePlacement,
  [GuideUiActionType.ForkNext]: reduceFork,
  [GuideUiActionType.ForkPrevious]: reduceFork,
  [GuideUiActionType.ForkMain]: reduceFork,
  [GuideUiActionType.ForkSelect]: reduceFork,
  [GuideUiActionType.ForkDrop]: reduceFork,
  [GuideUiActionType.ForkDeliver]: reduceFork,
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

const pinnedLensDefinitions: ReadonlyArray<
  Omit<GuidePinnedLens, "recommendation"> & {
    readonly profileRef: string
    readonly workflowId: string
    readonly reason: string
    readonly tradeoff: string
  }
> = [
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
    reason:
      "Use HVE Core's dedicated agent to carry the request through research, planning, implementation, and review.",
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

export const selectedProfileForPinnedLens = (catalog: CombinedGuideCatalog, lens: GuidePinnedLens): SelectedProfile => {
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
  cache?: GuideArtifactCache,
): Promise<GuideMatchResponse> => {
  onProgress?.(GuideMatchPhase.ComparingProfiles)
  const response = await runGuideMatch(provider, catalog, request, cache)
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
  cache?: GuideArtifactCache,
): Promise<GuideGenerationStepResult> => {
  const guideDocument = await loadSelectedGuide(catalog, guideRoot, recommendation.profileRef)
  onGuideLoaded?.(guideDocument)
  const workflow = selectedGuideWorkflow(guideDocument.guide, recommendation.workflowId)
  const fixedFrame = workflowOptimizeFixedFrame(workflow)
  const targetTool = guideTargetTool(catalog, recommendation.profileRef)
  const produce = async () => {
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
    const bodyCandidates = requireDistinctGuideCandidatePrompts(
      [
        resolveGeneratedWorkflowBodyCandidate(guideDocument.guide, workflow, intent, first),
        resolveGeneratedWorkflowBodyCandidate(guideDocument.guide, workflow, intent, second),
        resolveGeneratedWorkflowBodyCandidate(guideDocument.guide, workflow, intent, third),
      ],
      GuideCandidatePromptStage.GeneratedBodyNormalization,
    )
    onProgress?.(GuideGenerationPhase.OptimizingCandidates)
    const optimized = await provider.optimize({
      targetTool,
      profileRef: recommendation.profileRef,
      candidates: bodyCandidates,
      ...(fixedFrame === undefined ? {} : { fixedFrame }),
    })
    const [optimizedFirst, optimizedSecond, optimizedThird] = optimized.candidates
    if (optimizedFirst === undefined || optimizedSecond === undefined || optimizedThird === undefined) {
      throw new Error("Prompt Master must return exactly three prompt candidates")
    }
    const renderedCandidates = requireDistinctGuideCandidatePrompts(
      [
        renderWorkflowBodyCandidate(
          workflow,
          resolveWorkflowBodyCandidate(guideDocument.guide, workflow, bodyCandidates[0], optimizedFirst),
        ),
        renderWorkflowBodyCandidate(
          workflow,
          resolveWorkflowBodyCandidate(guideDocument.guide, workflow, bodyCandidates[1], optimizedSecond),
        ),
        renderWorkflowBodyCandidate(
          workflow,
          resolveWorkflowBodyCandidate(guideDocument.guide, workflow, bodyCandidates[2], optimizedThird),
        ),
      ],
      GuideCandidatePromptStage.FinalRendering,
    )
    return {
      candidates: requireDistinctGuideCandidatePrompts(
        [
          applyRequiredProfilePromptTemplate(
            recommendation.profileRef,
            guideDocument.guide,
            recommendation.workflowId,
            renderedCandidates[0],
          ),
          applyRequiredProfilePromptTemplate(
            recommendation.profileRef,
            guideDocument.guide,
            recommendation.workflowId,
            renderedCandidates[1],
          ),
          applyRequiredProfilePromptTemplate(
            recommendation.profileRef,
            guideDocument.guide,
            recommendation.workflowId,
            renderedCandidates[2],
          ),
        ],
        GuideCandidatePromptStage.FinalRendering,
      ),
    }
  }
  const generated = await (cache === undefined
    ? produce()
    : cache.generation(
        {
          intent,
          profileRef: recommendation.profileRef,
          workflowId: recommendation.workflowId,
          guide: guideDocument.guide,
          guideBody: guideDocument.body,
          targetTool,
          ...(fixedFrame === undefined ? {} : { fixedFrame }),
        },
        produce,
      ))
  const [first, second, third] = generated.candidates
  if (first === undefined || second === undefined || third === undefined)
    throw new Error("Cached generation must contain three candidates")
  return {
    guideDocument,
    candidates: [first, second, third],
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
  candidates: Triple<GuideGenerateCandidate>,
  candidateIndex: number,
  feedback: string,
  cache?: GuideArtifactCache,
): Promise<GuideGenerateCandidate> => {
  const workflow = selectedGuideWorkflow(guideDocument.guide, recommendation.workflowId)
  const candidate = tripleAt(candidates, candidateIndex)
  const bodyCandidate = workflowBodyCandidate(workflow, candidate)
  const fixedFrame = workflowOptimizeFixedFrame(workflow)
  const targetTool = guideTargetTool(catalog, recommendation.profileRef)
  const produce = async () => {
    const refined = await provider.refine({
      intent,
      profileRef: recommendation.profileRef,
      workflowId: recommendation.workflowId,
      guide: guideDocument.guide,
      guideBody: guideDocument.body,
      candidate: bodyCandidate,
      feedback,
    })
    const refinedBodyCandidate = resolveRefinedWorkflowBodyCandidate(
      guideDocument.guide,
      workflow,
      bodyCandidate,
      refined.candidate,
    )
    const optimized = await provider.optimize({
      targetTool,
      profileRef: recommendation.profileRef,
      candidates: [refinedBodyCandidate],
      ...(fixedFrame === undefined ? {} : { fixedFrame }),
    })
    const optimizedCandidate = optimized.candidates[0]
    if (optimizedCandidate === undefined) throw new Error("Prompt Master must return one refined prompt candidate")
    const renderedCandidate = renderWorkflowBodyCandidate(
      workflow,
      resolveWorkflowBodyCandidate(guideDocument.guide, workflow, refinedBodyCandidate, optimizedCandidate),
    )
    return {
      candidate: applyRequiredProfilePromptTemplate(
        recommendation.profileRef,
        guideDocument.guide,
        recommendation.workflowId,
        renderedCandidate,
      ),
    }
  }
  const refined = await (cache === undefined
    ? produce()
    : cache.refinement(
        {
          intent,
          profileRef: recommendation.profileRef,
          workflowId: recommendation.workflowId,
          guide: guideDocument.guide,
          guideBody: guideDocument.body,
          targetTool,
          ...(fixedFrame === undefined ? {} : { fixedFrame }),
          candidates,
          candidateIndex,
          feedback,
        },
        produce,
      ))
  const finalCandidate = refined.candidate
  requireDistinctGuideCandidatePrompts(
    replaceCandidateAt(candidates, candidateIndex, finalCandidate),
    GuideCandidatePromptStage.FinalRendering,
  )
  return finalCandidate
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
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly cwd: string
  readonly callerPaneId: string
  readonly direction: HerdrSplitDirection
}

export interface GuideUiNewHerdrWorktreeResult {
  readonly action: "herdr-worktree-create"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly primaryCheckoutPath: string
  readonly branch: string
  readonly baseRef: string
}

export interface GuideUiExistingHerdrWorktreeResult {
  readonly action: "herdr-worktree-open"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly primaryCheckoutPath: string
  readonly path: string
}

/**
 * What a queue launch produced. The launch runs inside the guide so it can show
 * progress, so this carries the finished result and not the work to do.
 */
export interface GuideUiBatchResult {
  readonly action: "batch"
  readonly result: GuideBatchExecutionResult
}

/** A new Herdr tab in this workspace, on this checkout. */
export interface GuideUiNewHerdrTabResult {
  readonly action: "new-herdr-tab"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly cwd: string
  readonly workspaceId: string
}

export type GuideUiResult =
  | GuideUiCancelResult
  | GuideUiPrintResult
  | GuideUiCurrentTerminalResult
  | GuideUiCurrentHerdrWorkspaceResult
  | GuideUiNewHerdrTabResult
  | GuideUiNewHerdrWorktreeResult
  | GuideUiExistingHerdrWorktreeResult
  | GuideUiBatchResult

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

export const buildNewHerdrTabResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
  herdrContext: HerdrContext,
): GuideUiNewHerdrTabResult => {
  const built = buildHerdrGuideLaunch(profile, prompt)
  return {
    action: "new-herdr-tab",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
    cwd,
    workspaceId: herdrContext.workspaceId,
  }
}

export const buildCurrentHerdrWorkspaceResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
  herdrContext: HerdrContext,
  direction: HerdrSplitDirection = "right",
): GuideUiCurrentHerdrWorkspaceResult => {
  const built = buildHerdrGuideLaunch(profile, prompt)
  return {
    action: "current-herdr-workspace",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
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
  const built = buildHerdrGuideLaunch(profile, prompt)
  return {
    action: "herdr-worktree-create",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
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
  const built = buildHerdrGuideLaunch(profile, prompt)
  return {
    action: "herdr-worktree-open",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
    primaryCheckoutPath,
    path,
  }
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export interface GuideUiProps {
  readonly catalog: CombinedGuideCatalog
  readonly guideRoot: string
  readonly provider: GuideProvider
  readonly cache?: GuideArtifactCache
  readonly routing: GuideResolvedModelRouting
  readonly runner: CommandRunner
  readonly cwd: string
  /** Raw Herdr environment used to derive `HerdrContext` via `getHerdrContext`. */
  readonly herdrEnv: HerdrEnvironment
  /** Whether a Herdr availability probe (e.g. `probeHerdrAvailability`) succeeded, checked before rendering. */
  readonly herdrAvailabilityProbe: boolean
  readonly initialIntent?: string
  readonly uiVariant?: GuideLongPromptVariant
}

export const captureSourcePresentation = (
  capture: GuideCaptureProvenance,
): { readonly label: string; readonly detail: string; readonly color: "cyan" | "green" | "yellow" } => {
  if (capture.source === "capture-queue") {
    return {
      label: "Curated capture queue",
      detail: "The guide is using the highlighted text and agent results you queued.",
      color: "cyan",
    }
  }
  if (capture.source === "selection") {
    return {
      label: "Highlighted text",
      detail: "The guide is using text that you selected.",
      color: "cyan",
    }
  }
  if (capture.source === "terminal") {
    return {
      label: "Terminal snapshot",
      detail: "This is not an exact message and can include prompts, status rows, or earlier output.",
      color: "yellow",
    }
  }
  const agent = capture.agent === undefined ? "Agent" : capture.agent[0]?.toUpperCase() + capture.agent.slice(1)
  const session = capture.sessionId === undefined ? "" : ` · session ${capture.sessionId.slice(0, 12)}`
  const profile = capture.profile === undefined ? "" : ` · profile ${capture.profile}`
  return {
    label: capture.source === "sandbox-transcript" ? "Exact Sandbox result" : "Exact agent result",
    detail: `${agent}${session}${profile}`,
    color: "green",
  }
}

const CaptureSourceBanner = ({ capture }: { readonly capture: GuideCaptureProvenance }) => {
  const presentation = captureSourcePresentation(capture)
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1} borderStyle="round" borderColor={presentation.color}>
      <Text bold color={presentation.color}>
        {presentation.label}
      </Text>
      <Text dimColor wrap="wrap">
        {presentation.detail}
      </Text>
    </Box>
  )
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
    label: `Prepare the ${recommendation.workflow.id} workflow body`,
  },
  {
    phase: GuideGenerationPhase.OptimizingCandidates,
    label: "Improve clarity and completeness with Prompt Master",
  },
]

export const summarizeGenerationIntent = (intent: string, maximumLength = 100): string => {
  const normalized = intent.replace(/\s+/gu, " ").trim()
  return textCharacterLength(normalized) <= maximumLength
    ? normalized
    : `${takeTextCharacters(normalized, maximumLength - 1)}…`
}

const guideTextSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

const wrapGuideTextLine = (sourceLine: string, lineWidth: number): ReadonlyArray<string> => {
  if (sourceLine.length === 0) return [""]
  const lines: Array<string> = []
  let line = ""
  let displayWidth = 0
  let continuation = false
  for (const { segment } of guideTextSegmenter.segment(sourceLine)) {
    const segmentWidth = stringWidth(segment)
    if (line.length > 0 && displayWidth + segmentWidth > lineWidth) {
      lines.push(line)
      line = ""
      displayWidth = 0
      continuation = true
    }
    if (continuation && line.length === 0 && segment === " ") continue
    line += segment
    displayWidth += segmentWidth
    continuation = false
  }
  if (line.length > 0) lines.push(line)
  return lines
}

export const wrapGuideText = (value: string, width: number): ReadonlyArray<string> => {
  const lineWidth = Math.max(1, width)
  return value
    .replaceAll("\t", "    ")
    .split("\n")
    .flatMap((sourceLine) => wrapGuideTextLine(sourceLine, lineWidth))
}

export interface GuideTextViewport {
  readonly text: string
  readonly lines: ReadonlyArray<string>
  readonly startLine: number
  readonly maximumStartLine: number
  readonly atStart: boolean
  readonly atEnd: boolean
}

export const guideTextViewport = (
  value: string,
  width: number,
  height: number,
  requestedStartLine: number,
): GuideTextViewport => {
  const lines = wrapGuideText(value, width)
  const viewportHeight = Math.max(1, height)
  const maximumStartLine = Math.max(0, lines.length - viewportHeight)
  const startLine = Math.min(maximumStartLine, Math.max(0, requestedStartLine))
  const visibleLines = lines.slice(startLine, startLine + viewportHeight)
  return {
    text: visibleLines.join("\n"),
    lines: visibleLines,
    startLine,
    maximumStartLine,
    atStart: startLine === 0,
    atEnd: startLine === maximumStartLine,
  }
}

const ScrollableTextViewport = ({
  value,
  width,
  height,
  startAtEnd,
  cursor = false,
  followChanges = false,
  resetKey,
}: {
  readonly value: string
  readonly width: number
  readonly height: number
  readonly startAtEnd: boolean
  readonly cursor?: boolean
  readonly followChanges?: boolean
  readonly resetKey?: string
}) => {
  const [requestedStartLine, setRequestedStartLine] = useState(startAtEnd ? Number.MAX_SAFE_INTEGER : 0)
  const previousValue = useRef(value)
  const viewport = guideTextViewport(value, cursor ? Math.max(1, width - 1) : width, height, requestedStartLine)
  const pageSize = Math.max(1, height - 1)

  useEffect(() => {
    setRequestedStartLine(startAtEnd ? Number.MAX_SAFE_INTEGER : 0)
  }, [resetKey, startAtEnd])

  useEffect(() => {
    if (followChanges && previousValue.current !== value) setRequestedStartLine(Number.MAX_SAFE_INTEGER)
    previousValue.current = value
  }, [followChanges, value])

  useInput((_input, key) => {
    if (key.pageUp) setRequestedStartLine(Math.max(0, viewport.startLine - pageSize))
    else if (key.pageDown) setRequestedStartLine(Math.min(viewport.maximumStartLine, viewport.startLine + pageSize))
  })

  return (
    <Box flexDirection="column" height={Math.max(1, height)} overflowY="hidden">
      {viewport.lines.map((line, index) => {
        const showCursor = cursor && viewport.atEnd && index === viewport.lines.length - 1
        return (
          <Text key={`${viewport.startLine + index}:${line}`} wrap="truncate-end">
            {line}
            {showCursor ? <Text color="yellow">█</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}

type MarkdownDisplayKind = "body" | "heading" | "list" | "quote" | "code" | "rule"
type MarkdownInlineKind = "text" | "bold" | "italic" | "code" | "strikethrough" | "link"

export interface MarkdownDisplayLine {
  readonly text: string
  readonly kind: MarkdownDisplayKind
}

export interface MarkdownInlineSegment {
  readonly text: string
  readonly kind: MarkdownInlineKind
}

const markdownInlineTokenPattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\s)\n]+\))/u

interface MarkdownInlineSourcePart {
  readonly value: string
  readonly token: boolean
}

const markdownInlineSourceParts = (value: string): ReadonlyArray<MarkdownInlineSourcePart> => {
  const parts: Array<MarkdownInlineSourcePart> = []
  let remaining = value
  while (remaining.length > 0) {
    const match = markdownInlineTokenPattern.exec(remaining)
    if (match?.index === undefined || match[0] === undefined) {
      parts.push({ value: remaining, token: false })
      break
    }
    if (match.index > 0) parts.push({ value: remaining.slice(0, match.index), token: false })
    parts.push({ value: match[0], token: true })
    remaining = remaining.slice(match.index + match[0].length)
  }
  return parts
}

export const markdownInlineSegments = (value: string): ReadonlyArray<MarkdownInlineSegment> => {
  const segments: Array<MarkdownInlineSegment> = []
  for (const part of markdownInlineSourceParts(value)) {
    if (!part.token) {
      segments.push({ text: part.value, kind: "text" })
      continue
    }
    const matched = part.value
    if (matched.startsWith("`")) segments.push({ text: matched.slice(1, -1), kind: "code" })
    else if (matched.startsWith("**") || matched.startsWith("__")) {
      segments.push({ text: matched.slice(2, -2), kind: "bold" })
    } else if (matched.startsWith("~~")) {
      segments.push({ text: matched.slice(2, -2), kind: "strikethrough" })
    } else if (matched.startsWith("[")) {
      const labelEnd = matched.indexOf("](")
      segments.push({
        text: `${matched.slice(1, labelEnd)} (${matched.slice(labelEnd + 2, -1)})`,
        kind: "link",
      })
    } else {
      segments.push({ text: matched.slice(1, -1), kind: "italic" })
    }
  }
  return segments
}

interface MarkdownWrapState {
  line: string
  displayWidth: number
}

const pushMarkdownWrapLine = (lines: Array<string>, state: MarkdownWrapState): void => {
  lines.push(state.line)
  state.line = ""
  state.displayWidth = 0
}

const appendMarkdownToken = (
  lines: Array<string>,
  state: MarkdownWrapState,
  token: string,
  lineWidth: number,
): void => {
  const tokenWidth = stringWidth(
    markdownInlineSegments(token)
      .map(({ text }) => text)
      .join(""),
  )
  if (state.line.length > 0 && state.displayWidth + tokenWidth > lineWidth) pushMarkdownWrapLine(lines, state)
  state.line += token
  state.displayWidth += tokenWidth
  if (state.displayWidth >= lineWidth) pushMarkdownWrapLine(lines, state)
}

const appendMarkdownText = (lines: Array<string>, state: MarkdownWrapState, text: string, lineWidth: number): void => {
  for (const { segment } of guideTextSegmenter.segment(text)) {
    const segmentWidth = stringWidth(segment)
    if (state.line.length > 0 && state.displayWidth + segmentWidth > lineWidth) {
      pushMarkdownWrapLine(lines, state)
    }
    if (state.line.length === 0 && segment === " ") continue
    state.line += segment
    state.displayWidth += segmentWidth
  }
}

const wrapMarkdownTextLine = (sourceLine: string, lineWidth: number): ReadonlyArray<string> => {
  if (sourceLine.length === 0) return [""]
  const lines: Array<string> = []
  const state: MarkdownWrapState = { line: "", displayWidth: 0 }
  for (const part of markdownInlineSourceParts(sourceLine)) {
    if (part.token) appendMarkdownToken(lines, state, part.value, lineWidth)
    else appendMarkdownText(lines, state, part.value, lineWidth)
  }
  if (state.line.length > 0) lines.push(state.line)
  return lines
}

const classifyMarkdownListLine = (source: string): string | undefined => {
  const taskItem = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/u.exec(source)
  if (taskItem?.[1] !== undefined && taskItem[2] !== undefined) {
    return `${taskItem[1] === " " ? "☐" : "☒"} ${taskItem[2]}`
  }
  const unorderedItem = /^(\s*)[-*+]\s+(.+)$/u.exec(source)
  if (unorderedItem?.[2] !== undefined) return `${unorderedItem[1] ?? ""}• ${unorderedItem[2]}`
  const orderedItem = /^(\s*)\d+[.)]\s+(.+)$/u.exec(source)
  if (orderedItem?.[2] !== undefined) return `${orderedItem[1] ?? ""}1. ${orderedItem[2]}`
  return undefined
}

const classifyMarkdownLine = (
  source: string,
  inCode: boolean,
): { readonly text: string; readonly kind: MarkdownDisplayKind; readonly inCode: boolean } => {
  if (/^\s*```/u.test(source)) return { text: source.trim(), kind: "code", inCode: !inCode }
  if (inCode) return { text: source, kind: "code", inCode }
  const heading = /^\s*#{1,6}\s+(.+)$/u.exec(source)
  if (heading?.[1] !== undefined) return { text: heading[1], kind: "heading", inCode }
  const listLine = classifyMarkdownListLine(source)
  if (listLine !== undefined) return { text: listLine, kind: "list", inCode }
  const quote = /^\s*>\s?(.*)$/u.exec(source)
  if (quote?.[1] !== undefined) return { text: `│ ${quote[1]}`, kind: "quote", inCode }
  if (/^\s*(?:---+|\*\*\*+|___+)\s*$/u.test(source)) return { text: "─".repeat(24), kind: "rule", inCode }
  return { text: source, kind: "body", inCode }
}

export const markdownPromptLines = (value: string, width: number): ReadonlyArray<MarkdownDisplayLine> => {
  const lines: Array<MarkdownDisplayLine> = []
  let inCode = false
  for (const source of value.replaceAll("\t", "    ").split("\n")) {
    const classified = classifyMarkdownLine(source, inCode)
    inCode = classified.inCode
    const previous = lines.at(-1)
    if (classified.kind === "heading" && previous !== undefined && previous.text.length > 0) {
      lines.push({ text: "", kind: "body" })
    }
    const wrapped =
      classified.kind === "code"
        ? wrapGuideTextLine(classified.text, Math.max(1, width))
        : wrapMarkdownTextLine(classified.text, Math.max(1, width))
    for (const text of wrapped) {
      if (text.length > 0 || lines.at(-1)?.text.length !== 0) lines.push({ text, kind: classified.kind })
    }
    if (classified.kind === "heading") lines.push({ text: "", kind: "body" })
  }
  return lines
}

const MarkdownInline = ({ value }: { readonly value: string }) => (
  <>
    {markdownInlineSegments(value).map((segment, index) => {
      const key = `${index}:${segment.kind}:${segment.text}`
      switch (segment.kind) {
        case "bold":
          return (
            <Text key={key} bold>
              {segment.text}
            </Text>
          )
        case "italic":
          return (
            <Text key={key} italic>
              {segment.text}
            </Text>
          )
        case "code":
          return (
            <Text key={key} color="yellow">
              {segment.text}
            </Text>
          )
        case "strikethrough":
          return (
            <Text key={key} strikethrough>
              {segment.text}
            </Text>
          )
        case "link":
          return (
            <Text key={key} color="blue" underline>
              {segment.text}
            </Text>
          )
        case "text":
          return segment.text
      }
    })}
  </>
)

const MarkdownLine = ({ line }: { readonly line: MarkdownDisplayLine }) => {
  switch (line.kind) {
    case "heading":
      return (
        <Text bold color="cyan" wrap="truncate-end">
          <MarkdownInline value={line.text} />
        </Text>
      )
    case "list":
      return (
        <Text color="green" wrap="truncate-end">
          <MarkdownInline value={line.text} />
        </Text>
      )
    case "quote":
      return (
        <Text italic dimColor wrap="truncate-end">
          <MarkdownInline value={line.text} />
        </Text>
      )
    case "code":
      return (
        <Text color="yellow" wrap="truncate-end">
          {line.text}
        </Text>
      )
    case "rule":
      return <Text dimColor>{line.text}</Text>
    case "body":
      return (
        <Text wrap="truncate-end">
          <MarkdownInline value={line.text} />
        </Text>
      )
  }
}

const MarkdownTextViewport = ({
  value,
  width,
  height,
  resetKey,
}: {
  readonly value: string
  readonly width: number
  readonly height: number
  readonly resetKey?: string
}) => {
  const [requestedStartLine, setRequestedStartLine] = useState(0)
  const lines = markdownPromptLines(value, width)
  const viewportHeight = Math.max(1, height)
  const maximumStartLine = Math.max(0, lines.length - viewportHeight)
  const startLine = Math.min(maximumStartLine, requestedStartLine)
  const pageSize = Math.max(1, viewportHeight - 1)
  useEffect(() => {
    setRequestedStartLine(0)
  }, [resetKey])
  useInput((_input, key) => {
    if (key.pageUp) setRequestedStartLine(Math.max(0, startLine - pageSize))
    else if (key.pageDown) setRequestedStartLine(Math.min(maximumStartLine, startLine + pageSize))
  })
  return (
    <Box flexDirection="column" height={viewportHeight} overflowY="hidden">
      {lines.slice(startLine, startLine + viewportHeight).map((line, index) => (
        <MarkdownLine key={`${startLine + index}:${line.kind}:${line.text}`} line={line} />
      ))}
    </Box>
  )
}

const PromptDocumentViewport = ({
  textDraft,
  width,
  height,
  editing,
}: {
  readonly textDraft: string
  readonly width: number
  readonly height: number
  readonly editing: boolean
}) =>
  editing ? (
    <ScrollableTextViewport value={textDraft} width={width} height={height} startAtEnd={false} cursor followChanges />
  ) : (
    <MarkdownTextViewport value={textDraft} width={width} height={height} />
  )

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
  <Box flexDirection="column">
    <ProgressPipeline
      title="Finding the best profiles"
      intent={intent}
      items={matchProgressItems(catalog.native.length + catalog.sandbox.length)}
      activePhase={phase}
      detail={`Copilot model: ${model} · Effort: ${effort}`}
    />
    <Text dimColor>p view prompt · q cancel</Text>
  </Box>
)

const GenerationProgress = ({
  recommendation,
  phase,
  intent,
  generateConfig,
  optimizeConfig,
}: {
  readonly recommendation: GuideRecommendation
  readonly phase: GuideGenerationPhase
  readonly intent: string
  readonly generateConfig: GuideModelConfig
  readonly optimizeConfig: GuideModelConfig
}) => (
  <ProgressPipeline
    title="Preparing prompt candidates"
    intent={intent}
    items={generationProgressItems(recommendation)}
    activePhase={phase}
    detail={`Draft: ${generateConfig.model} (${generateConfig.effort}) · Optimize: ${optimizeConfig.model} (${optimizeConfig.effort}) · Selected profile: ${recommendation.profileRef}`}
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

interface PromptReviewMetrics {
  readonly characters: number
  readonly words: number
  readonly sourceLines: number
  readonly headings: ReadonlyArray<string>
}

export const promptReviewMetrics = (value: string): PromptReviewMetrics => ({
  characters: textCharacterLength(value),
  words: value.trim().length === 0 ? 0 : value.trim().split(/\s+/u).length,
  sourceLines: value.length === 0 ? 0 : value.split("\n").length,
  headings: value
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/u.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/u, "").trim())
    .slice(0, 8),
})

const PromptReviewHeader = ({
  variant,
  metrics,
  editing,
}: {
  readonly variant: GuideLongPromptVariant
  readonly metrics: PromptReviewMetrics
  readonly editing: boolean
}) => (
  <Box justifyContent="space-between">
    <Text bold color="cyan">
      Task prompt · {variant}
    </Text>
    <Text dimColor>
      {editing ? "Raw edit" : "Markdown preview"} · {metrics.characters.toLocaleString("en")} chars ·{" "}
      {metrics.words.toLocaleString("en")} words
    </Text>
  </Box>
)

const PromptReviewFooter = ({ editing }: { readonly editing: boolean }) => (
  <Text dimColor wrap="truncate-end">
    {editing
      ? "Type, paste, or Backspace edit · PgUp/PgDn review · Enter re-match · Esc discard edits"
      : "PgUp/PgDn review · e edit · Enter or Esc return"}
  </Text>
)

const PagerPromptReview = ({
  textDraft,
  rows,
  columns,
  editing,
}: {
  readonly textDraft: string
  readonly rows: number
  readonly columns: number
  readonly editing: boolean
}) => {
  const metrics = promptReviewMetrics(textDraft)
  return (
    <Box flexDirection="column" height={Math.max(4, rows - 1)} overflowY="hidden" paddingX={1}>
      <PromptReviewHeader variant={GuideLongPromptVariant.Pager} metrics={metrics} editing={editing} />
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
        <PromptDocumentViewport
          textDraft={textDraft}
          width={Math.max(1, columns - 6)}
          height={Math.max(1, rows - 5)}
          editing={editing}
        />
      </Box>
      <PromptReviewFooter editing={editing} />
    </Box>
  )
}

const SplitPromptReview = ({
  textDraft,
  rows,
  columns,
  editing,
}: {
  readonly textDraft: string
  readonly rows: number
  readonly columns: number
  readonly editing: boolean
}) => {
  const metrics = promptReviewMetrics(textDraft)
  const railWidth = Math.min(28, Math.max(20, Math.floor(columns * 0.28)))
  if (columns < 70) return <PagerPromptReview textDraft={textDraft} rows={rows} columns={columns} editing={editing} />
  return (
    <Box flexDirection="column" height={Math.max(4, rows - 1)} overflowY="hidden" paddingX={1}>
      <PromptReviewHeader variant={GuideLongPromptVariant.Split} metrics={metrics} editing={editing} />
      <Box flexGrow={1}>
        <Box flexDirection="column" width={railWidth} borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text bold>DOCUMENT MAP</Text>
          <Text dimColor>{metrics.sourceLines.toLocaleString("en")} source lines</Text>
          <Box flexDirection="column" marginTop={1}>
            {(metrics.headings.length === 0 ? ["No Markdown headings"] : metrics.headings).map((heading, index) => (
              <Text key={`${index}:${heading}`} wrap="truncate-end" dimColor={metrics.headings.length === 0}>
                {metrics.headings.length === 0 ? heading : `${index + 1}. ${heading}`}
              </Text>
            ))}
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" paddingX={1}>
          <PromptDocumentViewport
            textDraft={textDraft}
            width={Math.max(1, columns - railWidth - 8)}
            height={Math.max(1, rows - 5)}
            editing={editing}
          />
        </Box>
      </Box>
      <PromptReviewFooter editing={editing} />
    </Box>
  )
}

const FocusPromptReview = ({
  textDraft,
  rows,
  columns,
  editing,
}: {
  readonly textDraft: string
  readonly rows: number
  readonly columns: number
  readonly editing: boolean
}) => {
  const metrics = promptReviewMetrics(textDraft)
  const readingWidth = Math.max(1, Math.min(76, columns - 4))
  return (
    <Box flexDirection="column" height={Math.max(4, rows - 1)} overflowY="hidden" alignItems="center">
      <Box width={readingWidth} flexDirection="column">
        <PromptReviewHeader variant={GuideLongPromptVariant.Focus} metrics={metrics} editing={editing} />
        <Box borderStyle="round" borderColor="cyan" paddingX={2} flexGrow={1}>
          <PromptDocumentViewport
            textDraft={textDraft}
            width={Math.max(1, readingWidth - 6)}
            height={Math.max(1, rows - 5)}
            editing={editing}
          />
        </Box>
        <PromptReviewFooter editing={editing} />
      </Box>
    </Box>
  )
}

const promptEdgePreview = (value: string, fromEnd: boolean): string => {
  const lines = value.split("\n").filter((line) => line.trim().length > 0)
  const line = fromEnd ? lines.at(-1) : lines[0]
  return line === undefined ? "(empty)" : summarizeGenerationIntent(line, 120)
}

const BookendsPromptReview = ({
  textDraft,
  rows,
  columns,
  editing,
}: {
  readonly textDraft: string
  readonly rows: number
  readonly columns: number
  readonly editing: boolean
}) => {
  const metrics = promptReviewMetrics(textDraft)
  return (
    <Box flexDirection="column" height={Math.max(6, rows - 1)} overflowY="hidden" paddingX={1}>
      <PromptReviewHeader variant={GuideLongPromptVariant.Bookends} metrics={metrics} editing={editing} />
      <Text dimColor wrap="truncate-end">
        START · {promptEdgePreview(textDraft, false)}
      </Text>
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
        <PromptDocumentViewport
          textDraft={textDraft}
          width={Math.max(1, columns - 6)}
          height={Math.max(1, rows - 7)}
          editing={editing}
        />
      </Box>
      <Text dimColor wrap="truncate-end">
        END · {promptEdgePreview(textDraft, true)}
      </Text>
      <PromptReviewFooter editing={editing} />
    </Box>
  )
}

const DashboardPromptReview = ({
  textDraft,
  rows,
  columns,
  editing,
}: {
  readonly textDraft: string
  readonly rows: number
  readonly columns: number
  readonly editing: boolean
}) => {
  const metrics = promptReviewMetrics(textDraft)
  return (
    <Box flexDirection="column" height={Math.max(6, rows - 1)} overflowY="hidden" paddingX={1}>
      <PromptReviewHeader variant={GuideLongPromptVariant.Dashboard} metrics={metrics} editing={editing} />
      <Box justifyContent="space-between" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text wrap="truncate-end">Characters {metrics.characters.toLocaleString("en")}</Text>
        <Text wrap="truncate-end">Words {metrics.words.toLocaleString("en")}</Text>
        <Text wrap="truncate-end">Lines {metrics.sourceLines.toLocaleString("en")}</Text>
        <Text wrap="truncate-end">Headings {metrics.headings.length}</Text>
      </Box>
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
        <PromptDocumentViewport
          textDraft={textDraft}
          width={Math.max(1, columns - 6)}
          height={Math.max(1, rows - 8)}
          editing={editing}
        />
      </Box>
      <PromptReviewFooter editing={editing} />
    </Box>
  )
}

const PromptReview = ({
  textDraft,
  variant,
  editing,
}: {
  readonly textDraft: string
  readonly variant: GuideLongPromptVariant
  readonly editing: boolean
}) => {
  const { rows, columns } = useGuideWindowSize()
  const props = { textDraft, rows, columns, editing }
  switch (variant) {
    case GuideLongPromptVariant.Pager:
      return <PagerPromptReview {...props} />
    case GuideLongPromptVariant.Split:
      return <SplitPromptReview {...props} />
    case GuideLongPromptVariant.Focus:
      return <FocusPromptReview {...props} />
    case GuideLongPromptVariant.Bookends:
      return <BookendsPromptReview {...props} />
    case GuideLongPromptVariant.Dashboard:
      return <DashboardPromptReview {...props} />
  }
}

const IntentEditor = ({ textDraft }: { readonly textDraft: string }) => {
  const { rows, columns } = useGuideWindowSize()
  return (
    <Box flexDirection="column" height={Math.max(3, rows - 1)} overflowY="hidden" paddingX={1}>
      <Text bold color="cyan">
        What do you want to do?
      </Text>
      <ScrollableTextViewport
        value={textDraft}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - 3)}
        startAtEnd
        cursor
      />
      <Text dimColor>Type your intent · PgUp/PgDn scroll · ↵ submit · Ctrl-C cancel</Text>
    </Box>
  )
}

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
  fmx: "Firstmate",
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
  const metrics = promptReviewMetrics(intent)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Profile recommendations
      </Text>
      <Text dimColor>
        Prompt: {metrics.characters.toLocaleString("en")} chars · {metrics.words.toLocaleString("en")} words · Model:{" "}
        {model} · Effort: {effort}
      </Text>
      {usedLiteralFallback ? <Text color="yellow">Deterministic literal match (no model call).</Text> : null}
      <PinnedLenses lenses={pinnedLenses} />
      <Box marginTop={1}>
        <RecommendationRail recommendations={recommendations} index={index} />
        <RecommendationDetail recommendation={recommendation} />
      </Box>
      <Text dimColor>
        ↑/↓ or j/k select · ↵ generate · p view prompt · c council · r research · h HVE RPI · q cancel
      </Text>
    </Box>
  )
}

/**
 * Rows the persistent chrome above a stage takes: the tab bar and its hint line
 * when any tab is open. Every stage sizes itself to the whole terminal, so
 * without this the chrome is pushed off the top of a tall screen.
 */
const forkTabBarRows = 2

const ChromeRowsContext = createContext(0)

/** Terminal size minus the chrome, so a stage never overflows the screen. */
const useGuideWindowSize = (): { readonly rows: number; readonly columns: number } => {
  const { rows, columns } = useWindowSize()
  return { rows: Math.max(6, rows - useContext(ChromeRowsContext)), columns }
}

const forkTabLabel = (fork: GuideForkTab): string =>
  fork.slice.selectedRecommendation === undefined ? "fork" : recommendationLabel(fork.slice.selectedRecommendation)

/**
 * The open forks, so an unfinished draft is never hidden behind the screen you
 * are on. A spinning tab is still working; you do not have to wait on it.
 */
/** `●` marks a tab already in the queue, `○` one still being drafted, a spinner one still working. */
const forkTabMarker = (state: GuideUiState, fork: GuideForkTab, tick: number): string => {
  if (forkIsBusy(state, fork.id)) return spinnerFrameAt(tick)
  return fork.jobId === undefined ? "○" : "●"
}

const ForkTabBar = ({ state }: { readonly state: GuideUiState }) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate-end">
        <Text inverse={state.activeForkId === undefined}> main </Text>
        {state.forks.map((fork, index) => (
          <Text key={fork.id}>
            <Text dimColor> │ </Text>
            <Text inverse={fork.id === state.activeForkId} color={fork.jobId === undefined ? "yellow" : "green"}>
              {" "}
              {index + 1} {forkTabLabel(fork)} {forkTabMarker(state, fork, tick)}{" "}
            </Text>
          </Text>
        ))}
      </Text>
      <Text dimColor>Tab/Shift-Tab switch tab · ` main · 1-9 jump · v queue · x drop tab</Text>
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
  width,
}: {
  readonly candidate: GuideGenerateCandidate
  readonly height: number
  readonly width: number
}) => {
  const promptHeight = Math.max(1, height - 5)
  return (
    <Box flexDirection="column" flexGrow={1} height={height} overflowY="hidden" paddingLeft={2}>
      <Text bold color="cyan" wrap="truncate-end">
        {candidate.title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {candidate.notes}
      </Text>
      <Box marginTop={1} marginBottom={1}>
        <Text bold color="cyan">
          Prompt
        </Text>
      </Box>
      <MarkdownTextViewport
        value={candidate.prompt}
        width={Math.max(1, width - 2)}
        height={promptHeight}
        resetKey={candidate.title}
      />
    </Box>
  )
}

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
  const { rows, columns: terminalColumns } = useGuideWindowSize()
  const paneHeight = candidatePaneHeight(rows)
  const railWidth = candidateRailWidth(terminalColumns)
  const candidate = tripleAt(candidates, index)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Prompt candidates
      </Text>
      {usedTemplateFallback ? <Text color="yellow">Deterministic template fallback (no model call).</Text> : null}
      <Box marginTop={1}>
        <CandidateRail candidates={candidates} index={index} width={railWidth} height={paneHeight} />
        <CandidateDetail
          candidate={candidate}
          height={paneHeight}
          width={Math.max(1, terminalColumns - railWidth - 2)}
        />
      </Box>
      <Text dimColor wrap="truncate-end">
        Command: {compactCommandPreview(command.preview)}
        {command.promptHandling === "manual-paste" ? " (manual paste required)" : ""}
      </Text>
      <Text dimColor wrap="truncate-end">
        ↑/↓ or j/k select · ↵ continue · b/Esc back · r refine · e edit · c print · q cancel
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
}) => {
  const { rows, columns } = useGuideWindowSize()
  return (
    <Box flexDirection="column" height={Math.max(3, rows - 3)} overflowY="hidden" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <ScrollableTextViewport
        value={textDraft}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - 5)}
        startAtEnd
        cursor
      />
      <Text dimColor>{keys} · PgUp/PgDn scroll</Text>
    </Box>
  )
}

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
        {destinationLabels[option]}
      </Text>
    ))}
    <Text dimColor wrap="wrap">
      Command: {commandPreview}
    </Text>
    <Text dimColor>↑/↓ or j/k select · ↵ queue it · L launch all · c print prompt · b back</Text>
  </Box>
)

/** `cpx · council`, or `sandbox · claude-council`. */
const describeJobRunner = (profile: SelectedProfile): string =>
  profile.surface === "native"
    ? `${profile.launcher} · ${profile.profile}${profile.agent === undefined ? "" : ` · ${profile.agent}`}`
    : `sandbox · ${profile.profile}`

const QueuedJobBlock = ({
  job,
  selected,
  preview,
}: {
  readonly job: QueuedGuideJob
  readonly selected: boolean
  readonly preview: BasketBlockPreview
}) => (
  <Box flexDirection="column" marginBottom={1} flexShrink={0}>
    <Text wrap="truncate-end">
      <Text inverse={selected}> {job.id} </Text>
      <Text color="cyan"> {describeJobRunner(job.profile)}</Text>
      <Text dimColor>
        {" "}
        · {job.prompt.length}c · {countLabel(countTextLines(job.prompt), "line")}
      </Text>
      {preview.truncated ? <Text color="cyan"> · o opens</Text> : null}
    </Text>
    <Text {...(selected ? { color: "green" as const } : { dimColor: true })} wrap="truncate-end">
      {"  → "}
      {describeJobPlacement(job.placement)}
    </Text>
    <Text dimColor wrap="truncate-end">
      {"  "}
      {renderCommandPreview(job.command)}
    </Text>
    {preview.lines.map((line, index) => (
      <Text key={`${job.id}:${index}`} dimColor={!selected} wrap="truncate-end">
        {line.length === 0 ? " " : line}
      </Text>
    ))}
  </Box>
)

const queueFooterLines: ReadonlyArray<string> = [
  "j/k select · o open prompt · e edit prompt · x remove job and its tab · a add another",
  "↵ or L launch all · ` main · Tab or 1-9 reopen a job · q cancel",
]

const QueueView = ({ queue, errorMessage }: { readonly queue: GuideQueueState; readonly errorMessage?: string }) => {
  const { rows, columns } = useGuideWindowSize()
  const width = Math.max(20, columns - 6)
  const previews = queue.entries.map((job) => basketBlockPreview(job.prompt, width))
  const heights = previews.map((preview) => preview.lines.length + 4)
  const { start, end } = basketVisibleRange(heights, queue.selectedIndex, Math.max(4, rows - 8))
  return (
    <Box flexDirection="column" height={Math.max(6, rows - 2)} overflowY="hidden" paddingX={1}>
      <Text bold color="cyan">
        Batch queue. {countLabel(queue.entries.length, "job")} launch together
      </Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1} overflowY="hidden">
        {queue.entries.slice(start, end).map((job, offset) => (
          <QueuedJobBlock
            key={job.id}
            job={job}
            selected={start + offset === queue.selectedIndex}
            preview={previews[start + offset] ?? { lines: [], truncated: false }}
          />
        ))}
      </Box>
      {end - start < queue.entries.length ? (
        <Text dimColor wrap="truncate-end">
          showing jobs {start + 1}–{end} of {queue.entries.length}
        </Text>
      ) : null}
      {errorMessage === undefined ? null : <Text color="yellow">{errorMessage}</Text>}
      {queueFooterLines.map((line) => (
        <Text key={line} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}

const QueueEntryView = ({ queue }: { readonly queue: GuideQueueState }) => {
  const { rows, columns } = useGuideWindowSize()
  const job = queue.entries[queue.selectedIndex]
  if (job === undefined) return null
  return (
    <Box flexDirection="column" height={Math.max(4, rows - 2)} overflowY="hidden" paddingX={1}>
      <Text bold color="cyan" wrap="truncate-end">
        Queued prompt {job.id} · {describeJobRunner(job.profile)}
      </Text>
      <Text dimColor wrap="truncate-end">
        → {describeJobPlacement(job.placement)} · {job.prompt.length}c ·{" "}
        {countLabel(countTextLines(job.prompt), "line")}
      </Text>
      <ScrollableTextViewport
        value={job.prompt}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - 6)}
        startAtEnd={false}
        resetKey={`${job.id}`}
      />
      <Text dimColor>PgUp/PgDn scroll · o/b/Esc back · q cancel</Text>
    </Box>
  )
}

const QueuePlacementView = ({ index, errorMessage }: { readonly index: number; readonly errorMessage?: string }) => {
  const options = ["Pane in this Herdr workspace", "Herdr worktree"] as const
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Where does this queued job run?
      </Text>
      {options.map((option, itemIndex) => (
        <Text key={option} bold={itemIndex === index} {...(itemIndex === index ? { color: "green" as const } : {})}>
          {itemIndex === index ? "❯ " : "  "}
          {option}
        </Text>
      ))}
      {errorMessage === undefined ? null : <Text color="yellow">{errorMessage}</Text>}
      <Text dimColor>j/k select · ↵ confirm · b back</Text>
    </Box>
  )
}

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
        <Text dimColor>↵ open existing worktree · e edit branch · b back · q cancel</Text>
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
            model: props.routing.match.model,
            effort: props.routing.match.effort,
          },
          (phase) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.MatchProgress, phase })
          },
          props.cache,
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
          props.cache,
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
    const candidates = state.candidates
    const candidateIndex = state.candidateIndex
    const feedback = state.textDraft
    void (async () => {
      try {
        const refinedCandidate = await runGuideRefinementStep(
          props.catalog,
          props.provider,
          intent,
          recommendation,
          guideDocument,
          candidates,
          candidateIndex,
          feedback,
          props.cache,
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
    const abort = new AbortController()
    const selectedProfile = state.selectedProfile
    void (async () => {
      try {
        const result = await checkSelectedProfileReadiness(props.runner, selectedProfile, props.cwd, abort.signal)
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
      abort.abort()
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

/**
 * Runs the queued launch inside the guide, so every step of every job is on
 * screen while it happens. The summary is printed by the caller after Ink
 * exits, so nothing writes over the live screen.
 */
const useGuideLaunchEffect = (
  props: GuideUiProps,
  state: GuideUiState,
  dispatch: GuideUiDispatch,
  complete: (result: GuideUiResult) => void,
): void => {
  useEffect(() => {
    if (state.stage !== GuideUiStage.Launching || state.launchBatch === undefined) return undefined
    let cancelled = false
    const batch = state.launchBatch
    void (async () => {
      const executed = await executeGuideBatch(batch, {
        runner: props.runner,
        write: () => {},
        onProgress: (event) => {
          if (!cancelled) dispatch({ type: GuideUiActionType.LaunchProgress, event })
        },
      })
      if (!cancelled) complete({ action: "batch", result: executed.result })
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage])
}

/**
 * One fork's async work, mounted for as long as that fork is open. Each fork is
 * its own component instance, so its effects run off its own stage whether or
 * not it is the tab on screen, and every result it dispatches is addressed back
 * to it. This is what makes a fork non-blocking.
 */
const ForkWorker = ({
  props,
  state,
  forkId,
  dispatch,
}: {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly forkId: number
  readonly dispatch: GuideUiDispatch
}) => {
  const deliver: GuideUiDispatch = (action) =>
    dispatch({ type: GuideUiActionType.ForkDeliver, forkId, action: action as GuideUiAction })
  useGuideMatchEffect(props, state, deliver)
  useGuideGenerationEffect(props, state, deliver)
  useGuideRefinementEffect(props, state, deliver)
  useGuideReadinessEffect(props, state, deliver)
  useGuideWorktreeEffect(props, state, deliver)
  return null
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

const handleMatchingInput: GuideInputHandler = ({ dispatch, cancel }, input) => {
  if (input === "p") dispatch({ type: GuideUiActionType.PromptReviewOpen })
  else if (input === "q") cancel()
}

const handleIntentInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (key.return) dispatch({ type: GuideUiActionType.IntentSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.IntentBackspace })
  else if (isPrintableInput(input, key) && isWithinTextBound(state.textDraft, input, guideIntentMaximumLength)) {
    dispatch({ type: GuideUiActionType.IntentChange, text: state.textDraft + input })
  }
}

const handleMatchFailedInput: GuideInputHandler = ({ props, state, dispatch, cancel }, input) => {
  if (input === "p") {
    dispatch({ type: GuideUiActionType.PromptReviewOpen })
    return
  }
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
  if (input === "p") {
    dispatch({ type: GuideUiActionType.PromptReviewOpen })
    return
  }
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

const handlePromptReviewInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (!state.promptReviewEditing) {
    if (input === "e") dispatch({ type: GuideUiActionType.PromptReviewEdit, editing: true })
    else if (key.escape || key.return || input === "p" || input === "b") {
      dispatch({ type: GuideUiActionType.PromptReviewBack })
    }
    return
  }
  if (key.escape) dispatch({ type: GuideUiActionType.PromptReviewBack })
  else if (key.return) dispatch({ type: GuideUiActionType.PromptReviewSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.PromptReviewBackspace })
  else if (isPrintableInput(input, key) && isWithinTextBound(state.textDraft, input, guideIntentMaximumLength)) {
    dispatch({ type: GuideUiActionType.PromptReviewChange, text: state.textDraft + input })
  }
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

const candidateNavigationAction = (input: string, key: Key): GuideUiAction | undefined => {
  if (key.upArrow || input === "k") return { type: GuideUiActionType.CandidatesMove, delta: -1 }
  if (key.downArrow || input === "j") return { type: GuideUiActionType.CandidatesMove, delta: 1 }
  if (key.escape || input === "b") return { type: GuideUiActionType.CandidatesBack }
  if (key.return) return { type: GuideUiActionType.CandidatesConfirm }
  return undefined
}

const candidateCommandAction = (state: GuideUiState, input: string): GuideUiAction | undefined => {
  if (input === "a") return { type: GuideUiActionType.CandidatesEnqueue }
  if (input === "v" && state.queue.entries.length > 0) return { type: GuideUiActionType.CandidatesViewQueue }
  if (input === "r") return { type: GuideUiActionType.CandidatesRefineStart }
  if (input === "e") return { type: GuideUiActionType.CandidatesDirectEditStart }
  return undefined
}

const launchQueue: GuideInputHandler = ({ state, dispatch, herdrContext, herdrEnabled, props }) => {
  if (state.queue.entries.length === 0) {
    dispatch({ type: GuideUiActionType.QueueExecuteBlocked, message: "Batch queue is empty." })
    return
  }
  if (!herdrEnabled || herdrContext === null) {
    dispatch({
      type: GuideUiActionType.QueueExecuteBlocked,
      message: "Herdr is unavailable. Start trx guide from a Herdr pane or popup.",
    })
    return
  }
  const cwd = herdrContext.cwd ?? props.cwd
  dispatch({
    type: GuideUiActionType.LaunchStart,
    batch: {
      jobs: state.queue.entries,
      context: {
        workspaceId: herdrContext.workspaceId,
        cwd,
        callerPaneId: herdrContext.paneId,
        primaryCheckoutPath: state.primaryCheckoutPath ?? cwd,
      },
    },
  })
}

const handleQueueEntryInput: GuideInputHandler = ({ dispatch, cancel }, input, key) => {
  if (input === "b" || input === "o" || key.escape) dispatch({ type: GuideUiActionType.QueueBack })
  else if (input === "q") cancel()
}

const handleQueueInput: GuideInputHandler = (context, input, key) => {
  const { dispatch, cancel } = context
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.QueueMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.QueueMove, delta: 1 })
  else if (input === "o") dispatch({ type: GuideUiActionType.QueueOpenEntry })
  else if (input === "e") dispatch({ type: GuideUiActionType.QueueEditStart })
  else if (input === "x") dispatch({ type: GuideUiActionType.QueueRemove })
  else if (input === "a") dispatch({ type: GuideUiActionType.QueueAddAnother })
  else if (key.return) launchQueue(context, input, key)
  else if (input === "b" || key.escape) dispatch({ type: GuideUiActionType.QueueBack })
  else if (input === "q") cancel()
}

const handleCandidatesInput: GuideInputHandler = ({ state, dispatch, complete, cancel }, input, key) => {
  const action = candidateNavigationAction(input, key) ?? candidateCommandAction(state, input)
  if (action !== undefined) {
    dispatch(action)
    return
  }
  if (input === "c" && state.candidates !== undefined) {
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

const handleQueuePromptEditorInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (key.escape) dispatch({ type: GuideUiActionType.QueueBack })
  else if (key.return) dispatch({ type: GuideUiActionType.QueueEditSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.EditorBackspace })
  else if (isPrintableInput(input, key) && isWithinTextBound(state.textDraft, input, promptMaxLength)) {
    dispatch({ type: GuideUiActionType.EditorChange, text: state.textDraft + input })
  }
}

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

/**
 * Every Herdr destination only marks the entry and returns to the queue, so a
 * batch of forks stays intact until `L` launches all of it. This terminal is
 * the one exception: it seizes stdio, so no queue can hold it and it runs now.
 */
const completeDestination = (context: GuideInputContext, option: GuideUiDestination): void => {
  const { state, props, herdrContext, dispatch, complete } = context
  if (state.selectedProfile === undefined || state.selectedCandidate === undefined) return
  if (option === GuideUiDestination.CurrentTerminal) {
    complete(buildCurrentTerminalResult(state.selectedProfile, state.selectedCandidate.prompt, props.cwd))
    return
  }
  if (herdrContext === null) return
  if (option === GuideUiDestination.CurrentHerdrWorkspace) {
    dispatch({
      type: GuideUiActionType.DestinationEnqueue,
      placement: { kind: "current-workspace-pane", direction: "right" },
    })
    return
  }
  if (option === GuideUiDestination.NewHerdrTab) {
    dispatch({ type: GuideUiActionType.DestinationEnqueue, placement: { kind: "new-tab" } })
    return
  }
  if (option === GuideUiDestination.NewHerdrWorktree) {
    dispatch({ type: GuideUiActionType.DestinationStartWorktree })
  }
}

const handleDestinationInput: GuideInputHandler = (context, input, key) => {
  const { state, dispatch, complete, cancel, herdrEnabled, herdrContext } = context
  const options = destinationOptions(herdrEnabled, herdrContext?.surface)
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

const handleQueuePlacementInput: GuideInputHandler = ({ state, dispatch, herdrContext, herdrEnabled }, input, key) => {
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.QueuePlacementMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.QueuePlacementMove, delta: 1 })
  else if (input === "b" || key.escape) dispatch({ type: GuideUiActionType.QueuePlacementBack })
  else if (key.return) {
    if (!herdrEnabled || herdrContext === null) dispatch({ type: GuideUiActionType.QueuePlacementUnavailable })
    else if (state.destinationIndex === 0) dispatch({ type: GuideUiActionType.QueuePlacementHere })
    else dispatch({ type: GuideUiActionType.QueuePlacementStartWorktree })
  }
}

const handleWorktreeCollisionInput: GuideInputHandler = ({ state, dispatch, cancel }, input, key) => {
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
    state.selectedProfile === undefined
  ) {
    if (input === "b" || key.escape) dispatch({ type: GuideUiActionType.WorktreeBack })
    return
  }
  dispatch({
    type: GuideUiActionType.QueuePlacementWorktree,
    placement: { kind: "existing-worktree", path: inspection.collision.path },
    primaryCheckoutPath: inspection.primaryCheckoutPath,
  })
}

/** The confirmed fresh worktree a queued entry will run in, once the dirty-checkout gate is cleared. */
const confirmedQueueWorktree = (
  state: GuideUiState,
): { readonly placement: JobPlacement; readonly primaryCheckoutPath: string } | undefined => {
  const inspection = state.worktreeInspection
  if (
    inspection === undefined ||
    "collision" in inspection ||
    !isWorktreeConfirmed(state.worktreeConfirmations + 1, inspection.dirty)
  ) {
    return undefined
  }
  return {
    placement: { kind: "new-worktree", branch: inspection.branch, baseRef: inspection.baseRef },
    primaryCheckoutPath: inspection.primaryCheckoutPath,
  }
}

const handleWorktreeReadyInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (key.escape) {
    dispatch({ type: GuideUiActionType.WorktreeBack })
    return
  }
  if (!key.return && input !== "y") return
  const confirmed = confirmedQueueWorktree(state)
  if (confirmed === undefined) dispatch({ type: GuideUiActionType.WorktreeConfirm })
  else dispatch({ type: GuideUiActionType.QueuePlacementWorktree, ...confirmed })
}

const inputHandlerByStage: Record<GuideUiStage, GuideInputHandler> = {
  [GuideUiStage.Intent]: handleIntentInput,
  [GuideUiStage.Matching]: handleMatchingInput,
  [GuideUiStage.MatchFailed]: handleMatchFailedInput,
  [GuideUiStage.Recommendations]: handleRecommendationsInput,
  [GuideUiStage.PromptReview]: handlePromptReviewInput,
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
  [GuideUiStage.Queue]: handleQueueInput,
  [GuideUiStage.QueueEntry]: handleQueueEntryInput,
  [GuideUiStage.QueuePromptEditor]: handleQueuePromptEditorInput,
  [GuideUiStage.QueuePlacement]: handleQueuePlacementInput,
  [GuideUiStage.Launching]: handleNoInput,
}

/**
 * Tab switching is off only while text is typed, where Tab, a backtick and a
 * digit are all ordinary characters. A busy fork keeps working in its own
 * ForkWorker, so leaving it costs nothing.
 */
const acceptsGlobalKeys = (state: GuideUiState): boolean =>
  state.stage !== GuideUiStage.Intent &&
  state.stage !== GuideUiStage.Launching &&
  !editingStages.has(state.stage) &&
  !(state.stage === GuideUiStage.PromptReview && state.promptReviewEditing)

const canSwitchForks = (state: GuideUiState): boolean => state.forks.length > 0 && acceptsGlobalKeys(state)

/**
 * Keys that read the same on every non-typing screen. The queue and the tab bar
 * are one list, so `v` reaches it from anywhere and `x` drops the open tab with
 * whatever entry it holds.
 */
const globalCommand = (state: GuideUiState, input: string): GuideUiAction | undefined => {
  if (input === "`") return { type: GuideUiActionType.ForkMain }
  if (input === "x" && state.activeForkId !== undefined) return { type: GuideUiActionType.ForkDrop }
  if (input === "v" && state.queue.entries.length > 0) return { type: GuideUiActionType.CandidatesViewQueue }
  return undefined
}

const forkCommand = (input: string, key: Key): GuideUiAction | undefined => {
  if (key.tab) return { type: key.shift ? GuideUiActionType.ForkPrevious : GuideUiActionType.ForkNext }
  const digit = Number.parseInt(input, 10)
  return Number.isInteger(digit) && digit >= 1 && digit <= 9
    ? { type: GuideUiActionType.ForkSelect, index: digit - 1 }
    : undefined
}

const handleGuideInput = (context: GuideInputContext, input: string, key: Key): void => {
  if (key.ctrl && input === "c") {
    context.cancel()
    return
  }
  if (acceptsGlobalKeys(context.state)) {
    if (input === "L" && context.state.queue.entries.length > 0) {
      launchQueue(context, input, key)
      return
    }
    const global = globalCommand(context.state, input)
    if (global !== undefined) {
      context.dispatch(global)
      return
    }
  }
  const fork = canSwitchForks(context.state) ? forkCommand(input, key) : undefined
  if (fork !== undefined) {
    context.dispatch(fork)
    return
  }
  inputHandlerByStage[context.state.stage](context, input, key)
}

const pastedEditorMaximum = (state: GuideUiState): number | undefined => {
  if (state.stage === GuideUiStage.Intent) return guideIntentMaximumLength
  if (state.stage === GuideUiStage.PromptReview && state.promptReviewEditing) return guideIntentMaximumLength
  if (state.stage === GuideUiStage.RefineEditor) return feedbackMaxLength
  if (state.stage === GuideUiStage.DirectEditor) return promptMaxLength
  if (state.stage === GuideUiStage.QueuePromptEditor) return promptMaxLength
  return undefined
}

const handleGuidePaste = (state: GuideUiState, dispatch: GuideUiDispatch, pasted: string): void => {
  const maximum = pastedEditorMaximum(state)
  if (maximum === undefined) return
  const addition = boundedPastedText(state.textDraft, pasted, maximum)
  if (addition.length === 0) return
  dispatch({
    type:
      state.stage === GuideUiStage.Intent
        ? GuideUiActionType.IntentChange
        : state.stage === GuideUiStage.PromptReview
          ? GuideUiActionType.PromptReviewChange
          : GuideUiActionType.EditorChange,
    text: state.textDraft + addition,
  })
}

interface GuideRenderContext {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly herdrEnabled: boolean
  readonly herdrContext: HerdrContext | null
}

type GuideStageRenderer = (context: GuideRenderContext) => React.ReactElement

const matchingProgress = ({ props, state }: GuideRenderContext): React.ReactElement => (
  <MatchProgress
    catalog={props.catalog}
    phase={state.matchPhase ?? GuideMatchPhase.LoadingProfiles}
    intent={state.intent ?? ""}
    model={props.routing.match.model}
    effort={props.routing.match.effort}
  />
)

const renderRecommendations: GuideStageRenderer = (context) =>
  context.state.recommendations === undefined ? (
    matchingProgress(context)
  ) : (
    <RecommendationsView
      pinnedLenses={pinnedGuideLenses(context.props.catalog)}
      intent={context.state.intent ?? ""}
      model={context.props.routing.match.model}
      effort={context.props.routing.match.effort}
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
        detail={`Refine: ${props.routing.refine.model} (${props.routing.refine.effort}) · Optimize: ${props.routing.optimize.model} (${props.routing.optimize.effort})`}
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

const renderDestination: GuideStageRenderer = ({ state, herdrEnabled, herdrContext }) => {
  const options = destinationOptions(herdrEnabled, herdrContext?.surface)
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

/** What one queued job is doing right now, so a launch is never a silent pause. */
export const launchRowDetail = (event: GuideBatchProgressEvent | undefined): string =>
  event === undefined ? "Waiting to start" : event.detail

export const launchRowMarker = (event: GuideBatchProgressEvent | undefined, tick: number): string => {
  if (event === undefined) return "○"
  if (event.phase === "done") return "✔"
  if (event.phase === "failed") return "✖"
  return spinnerFrameAt(tick)
}

const launchRowColor = (event: GuideBatchProgressEvent | undefined): string => {
  if (event === undefined) return "gray"
  if (event.phase === "done") return "green"
  if (event.phase === "failed") return "red"
  return "cyan"
}

const LaunchProgress = ({ state }: { readonly state: GuideUiState }) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  const jobs = state.launchBatch?.jobs ?? []
  const finished = state.launchProgress.filter((event) => event.phase === "done" || event.phase === "failed").length
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        Launching {jobs.length} job{jobs.length === 1 ? "" : "s"} · {finished}/{jobs.length} finished
      </Text>
      {jobs.map((job) => {
        const event = state.launchProgress.find((entry) => entry.jobId === job.id)
        return (
          <Text key={job.id} wrap="truncate-end">
            <Text color={launchRowColor(event)}>{launchRowMarker(event, tick)}</Text> {job.id}. {job.profile.profile}
            {" · "}
            {describeJobPlacement(job.placement)} — {launchRowDetail(event)}
          </Text>
        )
      })}
      <Text dimColor>Every job runs in its own pane. The summary prints when all of them finish.</Text>
    </Box>
  )
}

const stageRenderer: Record<GuideUiStage, GuideStageRenderer> = {
  [GuideUiStage.Intent]: ({ state }) => <IntentEditor textDraft={state.textDraft} />,
  [GuideUiStage.Matching]: matchingProgress,
  [GuideUiStage.MatchFailed]: ({ state }) => (
    <ErrorPanel
      title="Match failed"
      message={state.errorMessage}
      keys="r retry · l literal match · p view prompt · q cancel"
    />
  ),
  [GuideUiStage.Recommendations]: renderRecommendations,
  [GuideUiStage.PromptReview]: ({ props, state }) => (
    <PromptReview
      textDraft={state.textDraft}
      variant={props.uiVariant ?? GuideLongPromptVariant.Dashboard}
      editing={state.promptReviewEditing}
    />
  ),
  [GuideUiStage.Generating]: ({ props, state }) =>
    state.selectedRecommendation === undefined || state.intent === undefined ? (
      <Spinner label="Preparing prompt candidates" />
    ) : (
      <GenerationProgress
        recommendation={state.selectedRecommendation}
        phase={state.generationPhase ?? GuideGenerationPhase.LoadingProfile}
        intent={state.intent}
        generateConfig={props.routing.generate}
        optimizeConfig={props.routing.optimize}
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
  [GuideUiStage.Queue]: ({ state }) => (
    <QueueView
      queue={state.queue}
      {...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage })}
    />
  ),
  [GuideUiStage.QueueEntry]: ({ state }) => <QueueEntryView queue={state.queue} />,
  [GuideUiStage.QueuePromptEditor]: ({ state }) => (
    <TextEditor title="Edit queued prompt" textDraft={state.textDraft} keys="↵ save · Esc back" />
  ),
  [GuideUiStage.Launching]: ({ state }) => <LaunchProgress state={state} />,
  [GuideUiStage.QueuePlacement]: ({ state }) => (
    <QueuePlacementView
      index={state.destinationIndex}
      {...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage })}
    />
  ),
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

  // The main screen owns only its own async work; each fork's runs in its own
  // ForkWorker below, so parking a fork never abandons the call it started.
  const mainState = state.activeForkId === undefined ? state : { ...state, ...mainForkSlice }
  useGuideMatchEffect(props, mainState, dispatch)
  useGuideGenerationEffect(props, mainState, dispatch)
  useGuideRefinementEffect(props, mainState, dispatch)
  useGuideReadinessEffect(props, mainState, dispatch)
  useGuideWorktreeEffect(props, mainState, dispatch)
  useGuideLaunchEffect(props, mainState, dispatch, complete)

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
  usePaste((pasted) => handleGuidePaste(state, dispatch, pasted), {
    isActive: pastedEditorMaximum(state) !== undefined,
  })

  const activeWizardStep = wizardStepForStage(state.stage)
  return (
    <Box flexDirection="column">
      {herdrContext?.capture === undefined ? null : <CaptureSourceBanner capture={herdrContext.capture} />}
      {state.forks.map((fork) => {
        const slice = forkState(state, fork.id)
        return slice === undefined ? null : (
          <ForkWorker key={fork.id} props={props} state={slice} forkId={fork.id} dispatch={dispatch} />
        )
      })}
      {state.forks.length === 0 ? null : <ForkTabBar state={state} />}
      <ChromeRowsContext.Provider value={state.forks.length === 0 ? 0 : forkTabBarRows}>
        {activeWizardStep === undefined ? null : <WizardBreadcrumbs activeStep={activeWizardStep} />}
        {stageRenderer[state.stage]({ props, state, herdrEnabled, herdrContext })}
      </ChromeRowsContext.Provider>
    </Box>
  )
}
