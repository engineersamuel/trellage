import { guideModelLabel, type GuideModelConfig as SelectedGuideModelConfig, type GuideModelPhase } from "./guide-model-routing.ts"
/**
 * Interactive Ink state machine for `trx guide`.
 *
 * `GuideApp` walks a user from a free-text intent through model-backed
 * profile matching, prompt generation/refinement, and destination selection,
 * then exits (via Ink's `useApp().exit`) with a `GuideUiResult`. Confirmed
 * batches run here so the guide can show progress.
 *
 * The reducer (`guideUiReducer`) and every state-derived helper in this file
 * are exported so decisions can be tested without rendering Ink.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from "ink"

import type {
  ProfileGuideV1,
  ProfileGuideWorkflow,
} from "@trellage/guide-core"
import {
  basketBlockPreview,
  basketVisibleRange,
  countLabel,
  countTextLines,
  type BasketBlockPreview,
} from "./basket.ts"
import {
  GuideAugmentKind,
  GuideAugmentPhase,
  clampAugmentedIntent,
  runCodebaseAugment,
  runFirstmateAugment,
  runResearchAugment,
  type GuideAugmentContext,
} from "./guide-augment.ts"
import {
  createGuideCustomerPanel, customerPromptProjection, guideCustomerPanelReducer, reviewedCustomerContext, stripCustomerContext,
  type ApprovedGuideCustomerContext, type GuideCustomerPanelAction, type GuideCustomerPanelState,
} from "./guide-customer-context.ts"
import { GuideCustomerPanel } from "./guide-customer-context-ui.tsx"
import {
  GuideGoalError,
  GuideGoalInteractionController,
  validateGuideGoalPrompt,
  type GuideGoalAugmentProvider,
  type GuideGoalProposal,
  type GuideGoalRequest,
  type GuideGoalResponse,
  type GuideGoalTurn,
} from "./guide-goal-augment.ts"
import {
  createGuideGoalPanelState,
  GuideGoalPanel,
  goalAutoAcceptHelp,
  guideGoalPanelReducer,
  type GuideGoalPanelAction,
  type GuideGoalPanelState,
} from "./guide-goal-augment-ui.tsx"
import { MarkdownTextViewport, wrapGuideText } from "./guide-markdown.tsx"
import { resolveStatusSymbol, resolveTerminalSymbol } from "./termcn/terminal-symbols.ts"
import { resolveBorderStyle } from "./termcn/terminal-style.ts"
import { isNoUnicode, useUnicode } from "./termcn/use-unicode.ts"
import { spinnerFrameAt } from "./guide-spinner.ts"
import {
  composeGuideGoalCandidate,
  guideGoalApproachBudget,
  guideGoalCandidateBody,
  guideGoalControllerLabel,
  prepareGuideGoal,
  resolveGuideGoalExecution,
  type GuideGoalCandidateContext,
  type PreparedGuideGoal,
} from "./guide-goal-execution.ts"
import { runGuideGoalGeneration, runGuideGoalRefinement } from "./guide-goal-generation.ts"
import type { GuideGoalReadinessServices } from "./guide-goal-readiness.ts"
import { compactProfileGuide } from "./guide-catalog.ts"
import { formatCompositionRef, type CompositionCatalog, type CompositionCatalogEntry } from "./composition-catalog.ts"
import {
  assertGuidePromptDeliveryContext,
  completeSinglePromptArtifact,
  guideModelBodyCandidate,
  prepareGuidePrompt,
  validateGuideOriginalIntent,
  type GuideTaskContext,
  type PreparedGuidePrompt,
} from "./guide-context.ts"
import { GuideValidationError } from "./guide-text.ts"
import {
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
  type GuideMatchRequest,
  type GuideMatchAdapter,
  type GuideMatchExecution,
  type GuideMatcherFallback,
  GuideMatcherFallbackReason,
  type GuideMatchOptions,
  type GuideRecommendation,
  type GuideResolvedModelRouting,
  type PublicGuideCommand,
} from "./guide-api.ts"
import type { GuideArtifactCache } from "./guide-match-cache.ts"
import type { GuideGenerateCandidate, GuideOptimizeInput, GuideProvider } from "./guide-provider.ts"
import { jevShouldSkipPromptOptimization } from "./jev-guide-gates.ts"
import { createGuideReviewServices, type GuideReviewServices, type GuideReviewTerminalResult } from "./review-services.ts"
import { GuideReviewFlow } from "./review-flow-ui.tsx"
import { GuideOptimizeScreen, type GuideOptimizeLaunch } from "./guide-optimize-ui.tsx"
import { GuideOptimizeRunner, type GuideOptimizeSdkOptions } from "./guide-optimize.ts"
import type { ensureOptimizeSkills } from "./guide-optimize-skills.ts"
import type { ReviewPlanTerminalResult } from "./review-planning.ts"
import { copyTextToClipboard } from "./ritual-clipboard.ts"
import { loadSelectedGuide, type SelectedGuideDocument } from "./guide-selected.ts"
import {
  GuideCandidatePromptCollisionError,
  GuideCandidatePromptStage,
  GuideWorkflowBodyError,
  renderWorkflowBodyCandidate,
  requireDistinctGuideCandidatePrompts,
  resolveGeneratedWorkflowBodyCandidate,
  resolveRefinedWorkflowBodyCandidate,
  resolveWorkflowBodyCandidate,
  workflowOptimizeFixedFrame,
  validateFinalGuideCandidate,
} from "./guide-workflow-prompt.ts"
import {
  buildGuideLaunchCommand,
  buildHerdrGuideLaunch,
  suggestWorktreeBranch,
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
} from "./guide-launch.ts"
import {
  checkSelectedProfileReadiness,
  ProfileReadinessKind,
  type ProfileReadinessResult,
} from "./guide-preflight.ts"
import {
  describeJobPlacement,
  emptyGuideQueue,
  enqueueGuideJob,
  findGuideQueueConflict,
  GuideQueueConflictError,
  reservedWorktreeBranches,
  removeQueuedGuideJobById,
  removeSelectedQueuedGuideJob,
  replaceQueuedGuideJob,
  selectQueuedGuideJob,
  startQueuedGuidePromptEdit,
  submitQueuedGuidePromptEdit,
  queuedGuideJobEditText,
  executeGuideBatch,
  type GuideBatch,
  type GuideBatchExecutionResult,
  type GuideBatchProgressEvent,
  type GuideQueueState,
  type GuideQueuedContext,
  type QueuedGuideJob,
  type JobPlacement,
} from "./guide-batch.ts"

export { spinnerFrameAt } from "./guide-spinner.ts"
export {
  MarkdownTextViewport,
  markdownInlineSegments,
  markdownPromptLines,
  wrapGuideText,
  type MarkdownDisplayLine,
  type MarkdownInlineSegment,
} from "./guide-markdown.tsx"

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

// ---------------------------------------------------------------------------
// Stage discriminant (string enum per repository convention).
// ---------------------------------------------------------------------------

export enum GuideUiStage {
  Intent = "intent",
  Augment = "augment",
  Augmenting = "augmenting",
  Matching = "matching",
  MatchFailed = "match-failed",
  Recommendations = "recommendations",
  Review = "review",
  Optimize = "optimize",
  PromptReview = "prompt-review",
  GoalChange = "goal-change",
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
  [GuideUiStage.Augment]: undefined,
  [GuideUiStage.Augmenting]: undefined,
  [GuideUiStage.Matching]: GuideWizardStep.Profile,
  [GuideUiStage.MatchFailed]: GuideWizardStep.Profile,
  [GuideUiStage.Recommendations]: GuideWizardStep.Profile,
  [GuideUiStage.Review]: undefined,
  [GuideUiStage.Optimize]: undefined,
  [GuideUiStage.PromptReview]: GuideWizardStep.Profile,
  [GuideUiStage.GoalChange]: GuideWizardStep.Profile,
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

/**
 * A prompt augmentation running in the background. It is one record on shared
 * state rather than a stage, so starting one gives the screen straight back and
 * the user can keep matching, drafting and queueing on the base prompt while a
 * multi-minute research run works.
 */
export interface GuideAugmentJob {
  readonly kind: GuideAugmentKind
  /** Bumped on every start and retry, so the effect runs exactly once per run. */
  readonly runId: number
  /** The prompt this run started from, frozen at start; later edits do not reach it. */
  readonly source: string
  /** Where the augmented text lands when the user applies it. */
  readonly returnStage: GuideUiStage.Intent | GuideUiStage.PromptReview
  readonly status: "running" | "ready" | "failed"
  readonly phase: GuideAugmentPhase | undefined
  /** The tail of the run's output, newest last, bounded by `augmentLogLimit`. */
  readonly log: ReadonlyArray<string>
  /** The augmented prompt, once the run is `ready`. */
  readonly text: string | undefined
  readonly errorMessage: string | undefined
  readonly goalPanel: GuideGoalPanelState | undefined
  readonly goalAutoAcceptRecommended: boolean
  readonly goalHistory: ReadonlyArray<GuideGoalTurn>
  readonly goalLastProposal: GuideGoalProposal | undefined
  readonly goalApprovedPrompt: string | undefined
  readonly customerPanel?: GuideCustomerPanelState | undefined
}

type GuideGoalChange =
  | { readonly kind: "prompt"; readonly text: string; readonly returnStage: GuideUiStage.Intent | GuideUiStage.PromptReview }
  | { readonly kind: "profile"; readonly recommendation: GuideRecommendation; readonly profile: SelectedProfile; readonly reason: string }

interface GuideProfileSelection {
  readonly recommendations: ReadonlyArray<GuideRecommendation> | undefined
  readonly recommendationIndex: number
  readonly usedLiteralFallback: boolean
  readonly execution?: GuideMatchExecution | undefined
  readonly fallback?: GuideMatcherFallback | undefined
}

export interface GuideUiState {
  readonly reviewReturnStage?: GuideUiStage | undefined
  readonly stage: GuideUiStage
  /** The confirmed intent used for match/generate calls; `undefined` until the intent editor is submitted. */
  readonly intent: string | undefined
  readonly goal: PreparedGuideGoal | undefined
  readonly goalRevision: number
  readonly matchedGoalFingerprint: string | undefined
  readonly matchedGoalRevision: number
  readonly goalChange: GuideGoalChange | undefined
  readonly selectedIntent: string | undefined
  readonly selectedGoal: PreparedGuideGoal | undefined
  readonly profileSelection: GuideProfileSelection | undefined
  readonly originalIntent?: string | undefined
  /** A fork keeps the exact human text even when the main prompt is augmented later. */
  readonly selectedOriginalIntent?: string | undefined
  readonly customerContext?: ApprovedGuideCustomerContext | undefined
  readonly selectedCustomerContext?: ApprovedGuideCustomerContext | undefined
  /** Shared free-text editing buffer for the intent editor, refine feedback, direct edit, and worktree branch editors. */
  readonly textDraft: string
  readonly errorMessage: string | undefined
  readonly augmentIndex: number
  /** The augmentation running in the background, or waiting to be applied. */
  readonly augmentJob: GuideAugmentJob | undefined
  /** Shared across forks and re-matches; a discarded run ID is never reused. */
  readonly nextAugmentRunId: number
  /** Where `Esc` leaves the watch screen: the stage the user opened it from. */
  readonly augmentViewReturnStage: GuideUiStage | undefined
  readonly matchPhase: GuideMatchPhase | undefined
  readonly matchExecution: GuideMatchExecution | undefined
  /** Why Jev was skipped for the current match; `undefined` when Jev matched or no matcher is configured. */
  readonly matchFallback: GuideMatcherFallback | undefined
  readonly matchProfileCount: number | undefined
  readonly recommendations: ReadonlyArray<GuideRecommendation> | undefined
  readonly recommendationIndex: number
  readonly usedLiteralFallback: boolean
  /** The `c` Decide chooser is open over the recommendations screen. */
  readonly decideChooserOpen: boolean
  readonly selectedRecommendation: GuideRecommendation | undefined
  readonly selectedProfile: SelectedProfile | undefined
  readonly guideDocument: SelectedGuideDocument | undefined
  readonly selectedModels: Partial<Record<GuideModelPhase, SelectedGuideModelConfig>>
  readonly generationPhase: GuideGenerationPhase | undefined
  readonly candidates: Triple<GuideGenerateCandidate> | undefined
  readonly candidateIndex: number
  readonly templateFallback: GuideTemplateFallback | undefined
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
  /** The augmented prompt now on the prompt page. Set means leaving that page re-matches on it. */
  readonly promptReviewAugmented: string | undefined
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
  goal: undefined,
  goalRevision: 0,
  matchedGoalFingerprint: undefined,
  matchedGoalRevision: 0,
  goalChange: undefined,
  selectedIntent: undefined,
  selectedGoal: undefined,
  profileSelection: undefined,
  originalIntent: undefined,
  selectedOriginalIntent: undefined,
  textDraft: "",
  errorMessage: undefined,
  augmentIndex: 0,
  augmentJob: undefined,
  nextAugmentRunId: 1,
  augmentViewReturnStage: undefined,
  matchPhase: undefined,
  matchExecution: undefined,
  matchFallback: undefined,
  matchProfileCount: undefined,
  recommendations: undefined,
  recommendationIndex: 0,
  usedLiteralFallback: false,
  decideChooserOpen: false,
  selectedRecommendation: undefined,
  selectedProfile: undefined,
  guideDocument: undefined,
  selectedModels: {},
  generationPhase: undefined,
  candidates: undefined,
  candidateIndex: 0,
  templateFallback: undefined,
  selectedCandidate: undefined,
  readiness: undefined,
  destinationIndex: 0,
  worktreeBranch: undefined,
  worktreeInspection: undefined,
  worktreeConfirmations: 0,
  promptReviewReturnStage: undefined,
  promptReviewEditing: false,
  promptReviewAugmented: undefined,
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
export const createInitialGuideUiState = (initialIntent?: string, openOptimize = false): GuideUiState => {
  if (openOptimize) return { ...emptyState, stage: GuideUiStage.Optimize, reviewReturnStage: GuideUiStage.Intent }
  const trimmed = initialIntent?.trim()
  if (trimmed !== undefined && trimmed.length > 0) {
    return {
      ...emptyState,
      stage: GuideUiStage.Matching,
      intent: trimmed,
      originalIntent: validateGuideOriginalIntent(initialIntent),
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

const guideBranchIntent = (state: GuideUiState): string | undefined =>
  state.selectedGoal?.draft.task ?? state.selectedIntent ?? state.intent

const guideProfileGoal = (state: GuideUiState): PreparedGuideGoal | undefined =>
  state.activeForkId === undefined ? state.goal : state.selectedGoal

const guideProfileIntent = (state: GuideUiState): string | undefined =>
  state.activeForkId === undefined ? state.intent : state.selectedIntent

const guideProfileSelection = (state: GuideUiState): GuideProfileSelection =>
  state.profileSelection ?? {
    recommendations: state.recommendations,
    recommendationIndex: state.recommendationIndex,
    usedLiteralFallback: state.usedLiteralFallback,
    execution: state.matchExecution,
    fallback: state.matchFallback,
  }

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
  | "goal"
  | "goalRevision"
  | "matchedGoalFingerprint"
  | "matchedGoalRevision"
  | "originalIntent"
  | "customerContext"
  | "augmentJob"
  | "nextAugmentRunId"
  | "matchPhase"
  | "matchExecution"
  | "matchFallback"
  | "matchProfileCount"
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
  goal: _goal,
  goalRevision: _goalRevision,
  matchedGoalFingerprint: _matchedGoalFingerprint,
  matchedGoalRevision: _matchedGoalRevision,
  originalIntent: _originalIntent,
  customerContext: _customerContext,
  augmentJob: _augmentJob,
  nextAugmentRunId: _nextAugmentRunId,
  matchPhase: _matchPhase,
  matchExecution: _matchExecution,
  matchFallback: _matchFallback,
  matchProfileCount: _matchProfileCount,
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
  if (target === undefined) return state
  return { ...parked, ...target.slice, activeForkId: id }
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
  AugmentOpen = "augment/open",
  AugmentMove = "augment/move",
  AugmentConfirm = "augment/confirm",
  AugmentProgress = "augment/progress",
  AugmentOutput = "augment/output",
  AugmentSucceeded = "augment/succeeded",
  AugmentFailed = "augment/failed",
  AugmentRetry = "augment/retry",
  AugmentApply = "augment/apply",
  AugmentDiscard = "augment/discard",
  AugmentBack = "augment/back",
  AugmentGoalRequest = "augment/goal-request",
  AugmentGoalTurn = "augment/goal-turn",
  AugmentGoalPanel = "augment/goal-panel",
  AugmentGoalAutoAccept = "augment/goal-auto-accept",
  AugmentCustomerPanel = "augment/customer-panel",
  AugmentCustomerApprove = "augment/customer-approve",
  MatchRetry = "match/retry",
  MatchProgress = "match/progress",
  MatchAttempt = "match/attempt",
  MatchSucceeded = "match/succeeded",
  MatchFailed = "match/failed",
  MatchLiteral = "match/literal",
  MatchLiteralFailed = "match/literal-failed",
  RecommendationsMove = "recommendations/move",
  RecommendationsConfirm = "recommendations/confirm",
  DecideOpen = "decide/open",
  DecideClose = "decide/close",
  ReviewOpen = "review/open",
  ReviewBack = "review/back",
  OptimizeOpen = "optimize/open",
  OptimizeBack = "optimize/back",
  InputRejected = "input/rejected",
  PromptReviewOpen = "prompt-review/open",
  PromptReviewEdit = "prompt-review/edit",
  PromptReviewChange = "prompt-review/change",
  PromptReviewBackspace = "prompt-review/backspace",
  PromptReviewSubmit = "prompt-review/submit",
  PromptReviewBack = "prompt-review/back",
  GoalChangeRevise = "goal-change/revise",
  GoalChangeDetach = "goal-change/detach",
  GoalChangeKeep = "goal-change/keep",
  GenerateGuideLoaded = "generate/guide-loaded",
  ModelSelected = "model-selected",
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
  LaunchFailed = "launch/failed",
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
  | { readonly type: GuideUiActionType.AugmentOpen }
  | { readonly type: GuideUiActionType.AugmentMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.AugmentConfirm }
  | { readonly type: GuideUiActionType.AugmentProgress; readonly runId: number; readonly phase: GuideAugmentPhase }
  | { readonly type: GuideUiActionType.AugmentOutput; readonly runId: number; readonly line: string }
  | { readonly type: GuideUiActionType.AugmentSucceeded; readonly runId: number; readonly text: string }
  | { readonly type: GuideUiActionType.AugmentFailed; readonly runId: number; readonly message: string }
  | { readonly type: GuideUiActionType.AugmentRetry }
  | { readonly type: GuideUiActionType.AugmentApply }
  | { readonly type: GuideUiActionType.AugmentDiscard; readonly runId?: number }
  | { readonly type: GuideUiActionType.AugmentBack }
  | { readonly type: GuideUiActionType.AugmentCustomerPanel; readonly runId: number; readonly action: GuideCustomerPanelAction }
  | { readonly type: GuideUiActionType.AugmentCustomerApprove; readonly runId: number }
  | {
      readonly type: GuideUiActionType.AugmentGoalRequest
      readonly runId: number
      readonly request: GuideGoalRequest | undefined
    }
  | { readonly type: GuideUiActionType.AugmentGoalTurn; readonly runId: number; readonly turn: GuideGoalTurn }
  | {
      readonly type: GuideUiActionType.AugmentGoalAutoAccept
      readonly runId: number
      readonly requestId?: number
      readonly enabled: boolean
    }
  | {
      readonly type: GuideUiActionType.AugmentGoalPanel
      readonly runId: number
      readonly requestId: number
      readonly action: GuideGoalPanelAction
    }
  | { readonly type: GuideUiActionType.MatchRetry }
  | { readonly type: GuideUiActionType.MatchProgress; readonly phase: GuideMatchPhase }
  | {
      readonly type: GuideUiActionType.MatchAttempt
      readonly execution: GuideMatchExecution
      readonly profileCount: number
      readonly fallback?: GuideMatcherFallback
    }
  | {
      readonly type: GuideUiActionType.MatchSucceeded
      readonly recommendations: ReadonlyArray<GuideRecommendation>
      readonly execution?: GuideMatchExecution
      readonly fallback?: GuideMatcherFallback
      readonly profileCount?: number
    }
  | { readonly type: GuideUiActionType.MatchFailed; readonly message: string }
  | { readonly type: GuideUiActionType.MatchLiteral; readonly recommendations: ReadonlyArray<GuideRecommendation> }
  | { readonly type: GuideUiActionType.MatchLiteralFailed; readonly message: string }
  | { readonly type: GuideUiActionType.RecommendationsMove; readonly delta: 1 | -1 }
  | { readonly type: GuideUiActionType.DecideOpen }
  | { readonly type: GuideUiActionType.DecideClose }
  | { readonly type: GuideUiActionType.ReviewOpen }
  | { readonly type: GuideUiActionType.ReviewBack }
  | { readonly type: GuideUiActionType.OptimizeOpen }
  | { readonly type: GuideUiActionType.OptimizeBack }
  | { readonly type: GuideUiActionType.InputRejected; readonly message: string }
  | {
      readonly type: GuideUiActionType.RecommendationsConfirm
      readonly selectedProfile: SelectedProfile
      readonly recommendation?: GuideRecommendation
      readonly goalUnavailableReason?: string
    }
  | { readonly type: GuideUiActionType.PromptReviewOpen }
  | { readonly type: GuideUiActionType.PromptReviewEdit; readonly editing: boolean }
  | { readonly type: GuideUiActionType.PromptReviewChange; readonly text: string }
  | { readonly type: GuideUiActionType.PromptReviewBackspace }
  | { readonly type: GuideUiActionType.PromptReviewSubmit }
  | { readonly type: GuideUiActionType.PromptReviewBack }
  | { readonly type: GuideUiActionType.GoalChangeRevise }
  | { readonly type: GuideUiActionType.GoalChangeDetach }
  | { readonly type: GuideUiActionType.GoalChangeKeep }
  | { readonly type: GuideUiActionType.GenerateGuideLoaded; readonly guideDocument: SelectedGuideDocument }
  | { readonly type: GuideUiActionType.ModelSelected; readonly phase: GuideModelPhase; readonly config: SelectedGuideModelConfig }
  | { readonly type: GuideUiActionType.GenerateProgress; readonly phase: GuideGenerationPhase }
  | { readonly type: GuideUiActionType.GenerateRetry }
  | { readonly type: GuideUiActionType.GenerateSucceeded; readonly candidates: Triple<GuideGenerateCandidate> }
  | { readonly type: GuideUiActionType.GenerateFailed; readonly message: string }
  | { readonly type: GuideUiActionType.GenerateTemplateFallback; readonly candidates: Triple<GuideGenerateCandidate>; readonly reason?: string }
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
  | { readonly type: GuideUiActionType.LaunchFailed; readonly message: string }
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

const beginGuideMatching = (state: GuideUiState, intent: string, goal: PreparedGuideGoal | undefined): GuideUiState => ({
  ...emptyState,
  queue: state.queue,
  forks: parkActiveFork(state).forks,
  nextForkId: state.nextForkId,
  primaryCheckoutPath: state.primaryCheckoutPath,
  augmentJob: state.augmentJob,
  nextAugmentRunId: state.nextAugmentRunId,
  stage: GuideUiStage.Matching,
  intent,
  originalIntent: state.originalIntent ?? state.textDraft,
  customerContext: state.customerContext,
  goal,
  goalRevision: state.goalRevision,
  matchedGoalFingerprint: goal?.fingerprint,
  matchedGoalRevision: state.goalRevision,
  matchPhase: GuideMatchPhase.LoadingProfiles,
})

const changedGoalPrompt = (
  state: GuideUiState,
  text: string,
  returnStage: GuideUiStage.Intent | GuideUiStage.PromptReview,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.GoalChange,
  goalChange: { kind: "prompt", text, returnStage },
  promptReviewEditing: false,
  errorMessage: undefined,
})

const reduceIntent = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.IntentChange:
      return state.stage === GuideUiStage.Intent
        ? { ...state, textDraft: action.text, originalIntent: undefined, customerContext: undefined, errorMessage: undefined }
        : state

    case GuideUiActionType.IntentBackspace:
      return state.stage === GuideUiStage.Intent
        ? { ...state, textDraft: removeLastTextCharacter(state.textDraft), originalIntent: undefined, customerContext: undefined, errorMessage: undefined }
        : state

    case GuideUiActionType.IntentSubmit: {
      if (state.stage !== GuideUiStage.Intent) return state
      const trimmed = state.textDraft.trim()
      if (trimmed.length === 0) return state
      try {
        validateGuideOriginalIntent(state.textDraft)
      } catch (cause) {
        return { ...state, errorMessage: describeGuideUiError(cause) }
      }
      if (state.goal !== undefined && trimmed !== state.goal.prompt.trim()) {
        return changedGoalPrompt(state, trimmed, GuideUiStage.Intent)
      }
      return beginGuideMatching(state, trimmed, state.goal)
    }

    default:
      return state
  }
}

/** The augmenters offered on the augment screen, in display order. */
export const augmentOptions = [GuideAugmentKind.Research, GuideAugmentKind.Codebase, GuideAugmentKind.GoalMe, GuideAugmentKind.CustomerContext, GuideAugmentKind.Firstmate] as const

const augmentLabels: Readonly<Record<GuideAugmentKind, { readonly title: string; readonly detail: string }>> = {
  [GuideAugmentKind.Research]: {
    title: "Research",
    detail: "Run HVE Core rpi-research and replace the draft with its note",
  },
  [GuideAugmentKind.Codebase]: {
    title: "Codebase",
    detail: "Pack this repository with repomix and rewrite the draft",
  },
  [GuideAugmentKind.Firstmate]: {
    title: "Firstmate",
    detail: "Pack this repository and rewrite the draft as tasks for a Firstmate fleet",
  },
  [GuideAugmentKind.GoalMe]: {
    title: "Goal me",
    detail: "Answer questions here and approve a complete goal prompt",
  },
  [GuideAugmentKind.CustomerContext]: {
    title: "Customer context and outcome",
    detail: "Prepare a local brief; review evidence, unknowns, and sharing before applying",
  },
}

/** How many recent output lines the augment panel keeps on screen. */
export const augmentLogLimit = 14

/**
 * A bounded, newest-last window on the running augmenter's output. It exists so
 * a multi-minute research run shows that something is happening; it is not a
 * transcript, so old lines fall off rather than scroll. The panel is padded to
 * its full height so it never grows line by line under the spinner.
 */
const AugmentActivity = ({
  title,
  lines,
  height = augmentLogLimit,
}: {
  readonly title: string
  readonly lines: ReadonlyArray<string>
  readonly height?: number
}) => {
  if (lines.length === 0) return null
  const recent = lines.slice(-height)
  const rows = [...recent, ...Array.from({ length: height - recent.length }, () => "")]
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {rows.map((line, index) => (
        <Text key={`${index}-${line}`} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}

const augmentPhaseLabels: Readonly<Record<GuideAugmentPhase, string>> = {
  [GuideAugmentPhase.RunningResearch]: "Running HVE Core research",
  [GuideAugmentPhase.ReadingNote]: "Reading the research note",
  [GuideAugmentPhase.CheckingRepositoryNeed]: "Checking whether repository context is needed",
  [GuideAugmentPhase.PackingRepository]: "Packing this repository with repomix",
  [GuideAugmentPhase.RewritingIntent]: "Rewriting the prompt against the pack",
  [GuideAugmentPhase.GoalInterview]: "Developing your goal",
}

/** The running job, for screens that show it beside their own content. */
const AugmentJobContext = createContext<GuideAugmentJob | undefined>(undefined)

/** What the live output panel is showing, so its heading names the real source. */
const augmentSourceLabels: Readonly<Record<GuideAugmentKind, string>> = {
  [GuideAugmentKind.Research]: "Live output · copilot hve",
  [GuideAugmentKind.Codebase]: "Live output · repomix",
  [GuideAugmentKind.Firstmate]: "Live output · repomix",
  [GuideAugmentKind.GoalMe]: "Goal me activity",
  [GuideAugmentKind.CustomerContext]: "Local customer preparation",
}

const augmentRunningLabels: Readonly<Record<GuideAugmentKind, string>> = {
  [GuideAugmentKind.Research]: "Researching your request",
  [GuideAugmentKind.Codebase]: "Reading your codebase",
  [GuideAugmentKind.Firstmate]: "Writing your Firstmate message",
  [GuideAugmentKind.GoalMe]: "Preparing your goal",
  [GuideAugmentKind.CustomerContext]: "Preparing your customer brief",
}

const interactiveAugment = (kind: GuideAugmentKind): boolean =>
  kind === GuideAugmentKind.GoalMe || kind === GuideAugmentKind.CustomerContext

/**
 * The augment sub-flow. Confirming a choice starts a background job and hands
 * the screen straight back, so a multi-minute run never blocks the wizard. The
 * job carries its own source prompt, live output and result; nothing lands in
 * the draft until the user applies it.
 */
const startAugmentJob = (
  state: GuideUiState,
  kind: GuideAugmentKind,
  source: string,
  returnStage: GuideUiStage.Intent | GuideUiStage.PromptReview,
): GuideUiState => ({
  ...state,
  originalIntent: state.originalIntent ?? source,
  stage: interactiveAugment(kind) ? GuideUiStage.Augmenting : returnStage,
  nextAugmentRunId: state.nextAugmentRunId + 1,
  augmentJob: {
    kind,
    runId: state.nextAugmentRunId,
    source,
    returnStage,
    status: "running",
    phase: undefined,
    log: [],
    text: undefined,
    errorMessage: undefined,
    goalPanel: undefined,
    goalAutoAcceptRecommended: false,
    goalHistory: [],
    goalLastProposal: undefined,
    goalApprovedPrompt: undefined,
    ...(kind === GuideAugmentKind.CustomerContext ? { customerPanel: createGuideCustomerPanel(state.customerContext) } : {}),
  },
  augmentViewReturnStage: interactiveAugment(kind) ? returnStage : undefined,
  errorMessage: undefined,
})

/** Opens the chooser, recording where the augmented text should land. */
const openAugmentChooser = (
  state: GuideUiState,
  returnStage: GuideUiStage.Intent | GuideUiStage.PromptReview,
  textDraft: string,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Augment,
  textDraft,
  augmentIndex: 0,
  augmentViewReturnStage: returnStage,
  errorMessage: undefined,
})

/**
 * Auto-apply is the point of the feature, so it is the default. It waits only
 * where replacing the text would throw away something the user is doing: a
 * half-typed prompt edit, or a draft that belongs to a fork tab rather than to
 * the main screen.
 */
const canAutoApplyAugment = (state: GuideUiState): boolean =>
  state.activeForkId === undefined && !state.promptReviewEditing &&
  state.stage !== GuideUiStage.GoalChange && state.stage !== GuideUiStage.Review && state.stage !== GuideUiStage.Optimize

const goalSourceIsCurrent = (state: GuideUiState, job: GuideAugmentJob): boolean => {
  const usesDraft =
    state.stage === GuideUiStage.Intent || state.stage === GuideUiStage.PromptReview ||
    (state.stage === GuideUiStage.Augmenting && state.augmentViewReturnStage === GuideUiStage.Intent)
  const current =
    usesDraft ? state.textDraft : state.promptReviewAugmented ?? state.intent ?? ""
  return current.trim() === job.source.trim()
}

/** Puts the augmented text where the run was started from, and ends the job. */
const applyAugmentJob = (state: GuideUiState, job: GuideAugmentJob, text: string): GuideUiState => {
  let goal = state.goal
  if (job.kind === GuideAugmentKind.GoalMe) {
    if (job.goalLastProposal?.prompt !== text || job.goalApprovedPrompt !== text) {
      return {
        ...state,
        augmentJob: { ...job, status: "failed", errorMessage: "The approved goal context is missing. Review the goal again." },
      }
    }
    goal = prepareGuideGoal(job.goalLastProposal)
  }
  const applied: GuideUiState = {
  // The augmented text is the main screen's prompt, not a fork's draft, so
  // applying from inside a tab parks that tab and comes back to the main screen.
  ...(state.activeForkId === undefined ? state : enterMainScreen(state)),
  stage: job.returnStage,
  textDraft: text,
  goal,
  goalRevision: job.kind === GuideAugmentKind.GoalMe ? state.goalRevision + 1 : state.goalRevision,
  // On the prompt page the augmented text is the new baseline: reverting an
  // edit returns to it, and leaving the page re-matches on it.
  ...(job.returnStage === GuideUiStage.PromptReview
    ? { promptReviewAugmented: text, promptReviewEditing: false }
    : {}),
  augmentJob: undefined,
  augmentViewReturnStage: undefined,
  goalChange: undefined,
  errorMessage: undefined,
  }
  return job.kind !== GuideAugmentKind.GoalMe && goal !== undefined && text.trim() !== goal.prompt.trim()
    ? changedGoalPrompt(applied, text, job.returnStage)
    : applied
}

/** Only the run that is still current may write to the job. */
const liveJob = (state: GuideUiState, runId: number): GuideAugmentJob | undefined =>
  state.augmentJob?.runId === runId && state.augmentJob.status === "running" ? state.augmentJob : undefined

const openAugment = (state: GuideUiState): GuideUiState => {
  // A job already exists: the same key watches it rather than starting another.
  if (state.augmentJob !== undefined) {
    return state.stage === GuideUiStage.Augmenting
      ? state
      : { ...state, stage: GuideUiStage.Augmenting, augmentViewReturnStage: state.stage }
  }
  if (state.stage === GuideUiStage.Intent) {
    return state.textDraft.trim().length === 0 ? state : openAugmentChooser(state, GuideUiStage.Intent, state.textDraft)
  }
  // From the prompt page the draft is already the prompt, and the augmented
  // text goes back to that same page rather than to the intent editor.
  if (state.stage === GuideUiStage.PromptReview) {
    return state.promptReviewEditing || state.textDraft.trim().length === 0
      ? state
      : openAugmentChooser(state, GuideUiStage.PromptReview, state.textDraft)
  }
  if (state.stage !== GuideUiStage.MatchFailed || state.intent === undefined) return state
  return openAugmentChooser(state, GuideUiStage.Intent, state.intent)
}

const confirmAugment = (state: GuideUiState): GuideUiState => {
  if (state.stage !== GuideUiStage.Augment) return state
  const kind = augmentOptions[state.augmentIndex]
  if (kind === undefined || state.textDraft.trim().length === 0) return state
  if (kind === GuideAugmentKind.CustomerContext && state.goal !== undefined) {
    return { ...state, errorMessage: "An approved goal is active. Revise the goal or choose a normal prompt flow before adding customer context." }
  }
  if (kind === GuideAugmentKind.GoalMe && state.customerContext !== undefined) {
    return { ...state, errorMessage: "Customer context is not an execution goal. Start a separate prompt for Goal me, or explicitly edit the main request to remove the brief." }
  }
  const returnStage =
    state.augmentViewReturnStage === GuideUiStage.PromptReview ? GuideUiStage.PromptReview : GuideUiStage.Intent
  return startAugmentJob(state, kind, state.textDraft, returnStage)
}

const reduceAugmentNavigation = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.AugmentOpen:
      return openAugment(state)

    case GuideUiActionType.AugmentMove:
      return state.stage === GuideUiStage.Augment
        ? {
            ...state,
            augmentIndex: (state.augmentIndex + action.delta + augmentOptions.length) % augmentOptions.length,
          }
        : state

    case GuideUiActionType.AugmentConfirm:
      return confirmAugment(state)

    case GuideUiActionType.AugmentBack:
      // Leaving the chooser or the watch screen. A running job keeps running.
      return state.stage === GuideUiStage.Augment || state.stage === GuideUiStage.Augmenting
        ? {
            ...state,
            stage: state.augmentViewReturnStage ?? GuideUiStage.Intent,
            augmentViewReturnStage: undefined,
            errorMessage: undefined,
          }
        : state

    default:
      return state
  }
}

const succeedAugment = (state: GuideUiState, runId: number, text: string): GuideUiState => {
  const job = liveJob(state, runId)
  if (job === undefined) return state
  if (job.kind === GuideAugmentKind.CustomerContext) return state
  if (job.kind === GuideAugmentKind.GoalMe && job.goalApprovedPrompt !== text) {
    return {
      ...state,
      augmentJob: { ...job, status: "failed", errorMessage: "Goal me finished without an approved goal. The prompt is unchanged." },
    }
  }
  const canApplyGoal =
    state.stage !== GuideUiStage.Launching && !editingStages.has(state.stage) && goalSourceIsCurrent(state, job)
  if (canAutoApplyAugment(state) && (job.kind !== GuideAugmentKind.GoalMe || canApplyGoal)) {
    return applyAugmentJob(state, job, text)
  }
  return { ...state, augmentJob: { ...job, status: "ready", phase: undefined, text } }
}

const reduceAugmentRun = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.AugmentProgress: {
      const job = liveJob(state, action.runId)
      return job === undefined ? state : { ...state, augmentJob: { ...job, phase: action.phase } }
    }

    case GuideUiActionType.AugmentOutput: {
      const job = liveJob(state, action.runId)
      return job === undefined
        ? state
        : { ...state, augmentJob: { ...job, log: [...job.log, action.line].slice(-augmentLogLimit) } }
    }

    case GuideUiActionType.AugmentSucceeded:
      return succeedAugment(state, action.runId, action.text)

    case GuideUiActionType.AugmentFailed: {
      const job = liveJob(state, action.runId)
      return job === undefined
        ? state
        : { ...state, augmentJob: { ...job, status: "failed", phase: undefined, errorMessage: action.message } }
    }

    default:
      return state
  }
}

const receiveGoalRequest = (
  state: GuideUiState,
  runId: number,
  request: GuideGoalRequest | undefined,
): GuideUiState => {
  const job = liveJob(state, runId)
  if (job?.kind !== GuideAugmentKind.GoalMe) return state
  if (request !== undefined && request.runId !== job.runId) return state
  if (request !== undefined && job.goalPanel?.request.requestId === request.requestId) return state
  return {
    ...state,
    augmentJob: {
      ...job,
      goalPanel: request === undefined ? undefined : createGuideGoalPanelState(request),
      goalLastProposal: request?.kind === "review" ? request.proposal : job.goalLastProposal,
    },
  }
}

const receiveGoalTurn = (state: GuideUiState, runId: number, turn: GuideGoalTurn): GuideUiState => {
  const job = liveJob(state, runId)
  if (
    job?.kind !== GuideAugmentKind.GoalMe ||
    turn.request.runId !== runId ||
    job.goalPanel?.request.requestId !== turn.request.requestId
  ) return state
  const { request, response } = turn
  return {
    ...state,
    augmentJob: {
      ...job,
      goalHistory: [...job.goalHistory, turn],
      goalApprovedPrompt:
        request.kind === "review" && response.kind === "review" && response.review.decision === "use"
          ? request.proposal.prompt
          : undefined,
    },
  }
}

const setGoalAutomaticAnswers = (
  state: GuideUiState,
  action: Extract<GuideUiAction, { readonly type: GuideUiActionType.AugmentGoalAutoAccept }>,
): GuideUiState => {
  const job = liveJob(state, action.runId)
  if (job?.kind !== GuideAugmentKind.GoalMe) return state
  const panel = job.goalPanel
  if (action.requestId !== undefined && action.requestId !== panel?.request.requestId) return state
  if (panel?.discardOpen || panel?.view === "answer" || panel?.view === "feedback") return state
  if (panel?.request.kind === "review" && action.enabled) return state
  return { ...state, augmentJob: { ...job, goalAutoAcceptRecommended: action.enabled } }
}

const reduceGoalInteraction = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.AugmentGoalAutoAccept:
      return setGoalAutomaticAnswers(state, action)
    case GuideUiActionType.AugmentGoalRequest:
      return receiveGoalRequest(state, action.runId, action.request)
    case GuideUiActionType.AugmentGoalTurn:
      return receiveGoalTurn(state, action.runId, action.turn)
    case GuideUiActionType.AugmentGoalPanel: {
      const job = liveJob(state, action.runId)
      const panel = job?.goalPanel
      if (job === undefined || panel === undefined || panel.request.requestId !== action.requestId) return state
      return { ...state, augmentJob: { ...job, goalPanel: guideGoalPanelReducer(panel, action.action) } }
    }
    default:
      return state
  }
}

const approveCustomerBrief = (state: GuideUiState, job: GuideAugmentJob): GuideUiState => {
  const panel = job.customerPanel
  if (panel === undefined || !panel.reviewing) return state
  try {
    if (state.goal !== undefined) throw new Error("The approved goal is unchanged. Choose a normal prompt flow before applying customer context.")
    if (!goalSourceIsCurrent(state, job)) throw new Error("The request changed. Discard this draft and start from the current prompt.")
    const customerContext = reviewedCustomerContext(panel)
    const prompt = clampAugmentedIntent(customerPromptProjection(job.source, customerContext, state.customerContext))
    return applyAugmentJob({ ...state, customerContext }, job, prompt)
  } catch (cause) {
    return {
      ...state,
      augmentJob: { ...job, customerPanel: { ...panel, error: describeGuideUiError(cause) } },
    }
  }
}

const reduceCustomerInteraction = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  if (action.type !== GuideUiActionType.AugmentCustomerPanel && action.type !== GuideUiActionType.AugmentCustomerApprove) return state
  const job = liveJob(state, action.runId)
  if (state.stage !== GuideUiStage.Augmenting || job?.kind !== GuideAugmentKind.CustomerContext || job.customerPanel === undefined) return state
  return action.type === GuideUiActionType.AugmentCustomerApprove
    ? approveCustomerBrief(state, job)
    : { ...state, augmentJob: { ...job, customerPanel: guideCustomerPanelReducer(job.customerPanel, action.action) } }
}

const retryAugmentJob = (state: GuideUiState): GuideUiState => {
  const job = state.augmentJob
  if (job === undefined || job.status !== "failed") return state
  const restarted = startAugmentJob(state, job.kind, job.source, job.returnStage)
  return {
    ...restarted,
    stage: state.stage,
    augmentViewReturnStage: state.augmentViewReturnStage,
    augmentJob: restarted.augmentJob === undefined ? undefined : {
      ...restarted.augmentJob,
      goalHistory: job.goalHistory,
      goalAutoAcceptRecommended: job.goalAutoAcceptRecommended,
      goalLastProposal: job.goalLastProposal,
    },
  }
}

const discardAugmentJob = (state: GuideUiState, runId: number | undefined): GuideUiState => {
  if (state.augmentJob === undefined || (runId !== undefined && runId !== state.augmentJob.runId)) return state
  return {
    ...state,
    stage: state.stage === GuideUiStage.Augmenting ? (state.augmentViewReturnStage ?? GuideUiStage.Intent) : state.stage,
    augmentJob: undefined,
    augmentViewReturnStage: undefined,
  }
}

const reduceAugmentJob = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.AugmentRetry:
      return retryAugmentJob(state)

    case GuideUiActionType.AugmentApply: {
      const job = state.augmentJob
      if (job?.kind === GuideAugmentKind.CustomerContext) return state
      if (job?.kind === GuideAugmentKind.GoalMe && job.goalApprovedPrompt !== job.text) return state
      return job?.status === "ready" && job.text !== undefined ? applyAugmentJob(state, job, job.text) : state
    }

    case GuideUiActionType.AugmentDiscard:
      return discardAugmentJob(state, action.runId)

    default:
      return state
  }
}

const reduceAugment = (state: GuideUiState, action: GuideUiAction): GuideUiState =>
  reduceAugmentJob(reduceCustomerInteraction(reduceGoalInteraction(reduceAugmentRun(reduceAugmentNavigation(state, action), action), action), action), action)

const recommendationsState = (
  state: GuideUiState,
  recommendations: ReadonlyArray<GuideRecommendation>,
  usedLiteralFallback: boolean,
  execution?: GuideMatchExecution,
  profileCount?: number,
  fallback?: GuideMatcherFallback,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Recommendations,
  matchPhase: undefined,
  recommendations,
  recommendationIndex: 0,
  usedLiteralFallback,
  ...(execution === undefined ? {} : { matchExecution: execution, matchFallback: fallback }),
  ...(profileCount === undefined ? {} : { matchProfileCount: profileCount }),
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
  const source = state.activeForkId === undefined ? state : enterMainScreen(state)
  const returnStage = promptReviewSourceStage(source.stage)
  return returnStage === undefined || source.intent === undefined
    ? state
    : {
        ...source,
        stage: GuideUiStage.PromptReview,
        textDraft: source.intent,
        promptReviewReturnStage: returnStage,
        promptReviewEditing: false,
      }
}

const closePromptReview = (state: GuideUiState): GuideUiState => {
  // Discarding an edit falls back to the augmented prompt when there is one.
  if (state.promptReviewEditing) {
    return {
      ...state,
      promptReviewEditing: false,
      textDraft: state.promptReviewAugmented ?? state.intent ?? state.textDraft,
    }
  }
  // Leaving the page after an augmentation re-matches on the augmented prompt.
  if (state.promptReviewAugmented !== undefined) return submitPromptReview(state)
  return {
    ...state,
    stage: state.promptReviewReturnStage ?? GuideUiStage.Matching,
    textDraft: "",
    promptReviewReturnStage: undefined,
  }
}

const confirmedPromptReviewIntent = (state: GuideUiState): string | undefined => {
  const baseline = state.promptReviewAugmented ?? state.intent
  return state.promptReviewEditing && state.textDraft !== baseline
    ? state.textDraft
    : state.originalIntent ?? state.intent
}

const confirmedCustomerContext = (state: GuideUiState): ApprovedGuideCustomerContext | undefined =>
  state.promptReviewEditing && state.textDraft !== (state.promptReviewAugmented ?? state.intent)
    ? undefined
    : state.customerContext

const submitPromptReview = (state: GuideUiState): GuideUiState => {
  const intent = state.textDraft.trim()
  if (intent.length === 0) return state
  try {
    validateGuideOriginalIntent(state.textDraft)
  } catch (cause) {
    return { ...state, errorMessage: describeGuideUiError(cause) }
  }
  if (state.goal !== undefined && intent !== state.goal.prompt.trim()) {
    return changedGoalPrompt(state, intent, GuideUiStage.PromptReview)
  }
  if (intent === state.intent && state.goal?.fingerprint === state.matchedGoalFingerprint && state.goalRevision === state.matchedGoalRevision) {
    return {
      ...state,
      stage: state.promptReviewReturnStage ?? GuideUiStage.Matching,
      textDraft: "",
      promptReviewReturnStage: undefined,
      promptReviewEditing: false,
      promptReviewAugmented: undefined,
      originalIntent: confirmedPromptReviewIntent(state),
      customerContext: confirmedCustomerContext(state),
      errorMessage: undefined,
    }
  }
  return beginGuideMatching({
    ...state, originalIntent: confirmedPromptReviewIntent(state) ?? state.textDraft,
    customerContext: confirmedCustomerContext(state),
  }, intent, state.goal)
}

const reducePromptReview = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  if (action.type === GuideUiActionType.PromptReviewOpen) return openPromptReview(state)
  if (state.stage !== GuideUiStage.PromptReview) return state
  switch (action.type) {
    case GuideUiActionType.PromptReviewEdit:
      return { ...state, promptReviewEditing: action.editing }
    case GuideUiActionType.PromptReviewChange:
      return state.promptReviewEditing ? { ...state, textDraft: action.text, errorMessage: undefined } : state
    case GuideUiActionType.PromptReviewBackspace:
      return state.promptReviewEditing
        ? { ...state, textDraft: removeLastTextCharacter(state.textDraft), errorMessage: undefined }
        : state
    case GuideUiActionType.PromptReviewBack:
      return closePromptReview(state)
    case GuideUiActionType.PromptReviewSubmit:
      return submitPromptReview(state)
    default:
      return state
  }
}

/** Review and Optimize are side screens: each opens over Intent or Recommendations and returns there. */
const openSideScreen = (state: GuideUiState, stage: GuideUiStage): GuideUiState => {
  if (state.stage !== GuideUiStage.Recommendations && state.stage !== GuideUiStage.Intent) return state
  const source = state.activeForkId === undefined ? state : enterMainScreen(state)
  return { ...source, stage, reviewReturnStage: state.stage, errorMessage: undefined }
}

const sideScreenReturnStage = (state: GuideUiState): GuideUiStage => {
  if (state.reviewReturnStage !== undefined) return state.reviewReturnStage
  if (state.recommendations !== undefined) return GuideUiStage.Recommendations
  return state.intent === undefined ? GuideUiStage.Intent : GuideUiStage.Matching
}

const closeSideScreen = (state: GuideUiState, stage: GuideUiStage): GuideUiState =>
  state.stage !== stage
    ? state
    : { ...state, stage: sideScreenReturnStage(state), reviewReturnStage: undefined, errorMessage: undefined }

const reduceSideScreen = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  if (action.type === GuideUiActionType.ReviewOpen) return openSideScreen(state, GuideUiStage.Review)
  if (action.type === GuideUiActionType.OptimizeOpen) return openSideScreen(state, GuideUiStage.Optimize)
  if (action.type === GuideUiActionType.ReviewBack) return closeSideScreen(state, GuideUiStage.Review)
  if (action.type === GuideUiActionType.OptimizeBack) return closeSideScreen(state, GuideUiStage.Optimize)
  return state
}

const reduceMatchProgress = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.MatchProgress:
      return state.stage === GuideUiStage.Matching ? { ...state, matchPhase: action.phase } : state

    case GuideUiActionType.MatchAttempt:
      return state.stage === GuideUiStage.Matching
        ? {
            ...state,
            matchExecution: action.execution,
            matchFallback: action.fallback,
            matchProfileCount: action.profileCount,
          }
        : state

    default:
      return state
  }
}

const reduceMatchSucceeded = (
  state: GuideUiState,
  action: Extract<GuideUiAction, { readonly type: GuideUiActionType.MatchSucceeded }>,
): GuideUiState => {
  if (state.stage !== GuideUiStage.Matching) return state
  return recommendationsState(
    state,
    action.recommendations,
    false,
    action.execution ?? state.matchExecution,
    action.profileCount ?? state.matchProfileCount,
    action.execution === undefined ? state.matchFallback : action.fallback,
  )
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
      return reduceMatchSucceeded(state, action)

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

const moveGuideRecommendation = (state: GuideUiState, delta: number): GuideUiState => {
  const selection = guideProfileSelection(state)
  if (selection.recommendations === undefined || selection.recommendations.length === 0) return state
  const recommendationIndex =
    (selection.recommendationIndex + delta + selection.recommendations.length) % selection.recommendations.length
  return state.activeForkId === undefined
    ? { ...state, recommendationIndex }
    : { ...state, profileSelection: { ...selection, recommendationIndex } }
}

const invalidateForkQueueEntry = (state: GuideUiState): GuideUiState => {
  if (state.launchBatch !== undefined) return state
  const fork = state.forks.find(({ id }) => id === state.activeForkId)
  if (fork?.jobId === undefined) return state
  return {
    ...state,
    queue: removeQueuedGuideJobById(state.queue, fork.jobId),
    forks: state.forks.map((entry) => entry.id === fork.id ? { ...entry, jobId: undefined } : entry),
  }
}

const confirmGuideRecommendation = (
  state: GuideUiState,
  action: Extract<GuideUiAction, { readonly type: GuideUiActionType.RecommendationsConfirm }>,
): GuideUiState => {
  const selection = guideProfileSelection(state)
  if (selection.recommendations === undefined ||
    (selection.recommendations.length === 0 && action.recommendation === undefined)) return state
  const recommendation = action.recommendation ?? recommendationAt(selection.recommendations, selection.recommendationIndex)
  const goal = guideProfileGoal(state)
  if (goal !== undefined && action.goalUnavailableReason !== undefined) {
    return {
      ...state,
      stage: GuideUiStage.GoalChange,
      goalChange: { kind: "profile", recommendation, profile: action.selectedProfile, reason: action.goalUnavailableReason },
    }
  }
  return openRecommendedProfile(state, action, selection, recommendation, goal)
}

const openRecommendedProfile = (
  state: GuideUiState,
  action: Extract<GuideUiAction, { readonly type: GuideUiActionType.RecommendationsConfirm }>,
  selection: GuideProfileSelection,
  recommendation: GuideRecommendation,
  goal: PreparedGuideGoal | undefined,
): GuideUiState => {
  const base = invalidateForkQueueEntry(state)
  const slice: GuideForkSlice = {
    ...forkSlice(base),
    stage: GuideUiStage.Generating,
    selectedRecommendation: recommendation,
    selectedGoal: goal,
    selectedIntent: guideProfileIntent(state),
    profileSelection: selection,
    selectedProfile: action.selectedProfile,
    selectedOriginalIntent: state.selectedOriginalIntent ?? state.originalIntent ?? state.intent,
    selectedCustomerContext: state.activeForkId === undefined ? state.customerContext : state.selectedCustomerContext,
    guideDocument: undefined,
    selectedModels: {},
    generationPhase: GuideGenerationPhase.LoadingProfile,
    candidates: undefined,
    selectedCandidate: undefined,
    readiness: undefined,
    templateFallback: undefined,
    errorMessage: undefined,
  }
  return base.activeForkId === undefined ? openFork(base, slice) : { ...base, ...slice }
}

const reduceRecommendations = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  if (state.stage !== GuideUiStage.Recommendations) return state
  switch (action.type) {
    case GuideUiActionType.RecommendationsMove:
      return moveGuideRecommendation(state, action.delta)
    case GuideUiActionType.RecommendationsConfirm:
      return confirmGuideRecommendation({ ...state, decideChooserOpen: false }, action)
    case GuideUiActionType.DecideOpen:
      return { ...state, decideChooserOpen: true }
    case GuideUiActionType.DecideClose:
      return { ...state, decideChooserOpen: false }
    default:
      return state
  }
}

const keepPreparedGoal = (state: GuideUiState, change: GuideGoalChange): GuideUiState => ({
  ...state,
  stage: change.kind === "profile" ? GuideUiStage.Recommendations : change.returnStage,
  textDraft: guideProfileGoal(state)?.prompt ?? guideProfileIntent(state) ?? "",
  promptReviewAugmented: change.kind === "prompt" && state.goal?.prompt !== state.intent ? state.goal?.prompt : undefined,
  goalChange: undefined,
  errorMessage: undefined,
})

const openOrdinaryGoalReference = (
  state: GuideUiState,
  change: Extract<GuideGoalChange, { readonly kind: "profile" }>,
): GuideUiState => {
  const goal = guideProfileGoal(state)
  const intent = goal === undefined ? guideProfileIntent(state) : [
    `Artifact: ${goal.draft.artifact}`,
    goal.draft.task,
    "Success criteria:",
    ...goal.draft.criteria.map((criterion) => `- ${criterion}`),
  ].join("\n")
  return openFork(keepPreparedGoal(state, change), {
    ...mainForkSlice,
    stage: GuideUiStage.Generating,
    selectedRecommendation: change.recommendation,
    selectedProfile: change.profile,
    selectedGoal: undefined,
    selectedIntent: intent,
    profileSelection: guideProfileSelection(state),
    selectedModels: {},
    generationPhase: GuideGenerationPhase.LoadingProfile,
    goalChange: undefined,
  })
}

const reduceGoalChange = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  const change = state.goalChange
  if (state.stage !== GuideUiStage.GoalChange || change === undefined) return state
  if (action.type === GuideUiActionType.GoalChangeKeep) {
    return keepPreparedGoal(state, change)
  }
  if (action.type === GuideUiActionType.GoalChangeRevise && change.kind === "prompt") {
    if (state.augmentJob !== undefined) {
      return { ...state, errorMessage: "Finish or discard the active augmentation before starting another goal interview." }
    }
    return startAugmentJob({
      ...state,
      goalChange: undefined,
      textDraft: change.text,
      promptReviewAugmented: change.returnStage === GuideUiStage.PromptReview ? change.text : undefined,
    }, GuideAugmentKind.GoalMe, change.text, change.returnStage)
  }
  if (action.type !== GuideUiActionType.GoalChangeDetach) return state
  if (change.kind === "prompt") {
    return beginGuideMatching({ ...state, goalChange: undefined }, change.text, undefined)
  }
  return openOrdinaryGoalReference(state, change)
}

const candidatesState = (
  state: GuideUiState,
  candidates: Triple<GuideGenerateCandidate>,
  templateFallback: GuideTemplateFallback | undefined,
): GuideUiState => ({
  ...state,
  stage: GuideUiStage.Candidates,
  generationPhase: undefined,
  candidates,
  candidateIndex: 0,
  templateFallback,
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
  templateFallback: undefined,
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
    case GuideUiActionType.ModelSelected:
      return state.stage === GuideUiStage.Generating || state.stage === GuideUiStage.Refining
        ? { ...state, selectedModels: { ...state.selectedModels, [action.phase]: action.config } }
        : state
    case GuideUiActionType.GenerateProgress:
      return state.stage === GuideUiStage.Generating ? { ...state, generationPhase: action.phase } : state

    default:
      return state
  }
}

const acceptsGeneratedTemplateFallback = (stage: GuideUiStage): boolean =>
  stage === GuideUiStage.GenerateFailed || stage === GuideUiStage.Generating

const reduceGenerateActive = (state: GuideUiState, action: GuideUiAction): GuideUiState | undefined => {
  switch (action.type) {
    case GuideUiActionType.GenerateGuideLoaded:
      return state.stage === GuideUiStage.Generating ? { ...state, guideDocument: action.guideDocument } : state

    case GuideUiActionType.GenerateRetry:
      return state.stage === GuideUiStage.GenerateFailed
        ? {
            ...state,
            stage: GuideUiStage.Generating,
            selectedModels: {},
            generationPhase: GuideGenerationPhase.LoadingProfile,
            errorMessage: undefined,
          }
        : state

    case GuideUiActionType.GenerateSucceeded:
      return state.stage === GuideUiStage.Generating ? candidatesState(state, action.candidates, undefined) : state

    default:
      return undefined
  }
}

const reduceGenerateRecovery = (state: GuideUiState, action: GuideUiAction): GuideUiState | undefined => {
  switch (action.type) {
    case GuideUiActionType.GenerateFailed:
      return state.stage === GuideUiStage.Generating
        ? { ...state, stage: GuideUiStage.GenerateFailed, errorMessage: action.message }
        : state

    case GuideUiActionType.GenerateTemplateFallback:
      return acceptsGeneratedTemplateFallback(state.stage)
        ? candidatesState(state, action.candidates, {
            kind: state.stage === GuideUiStage.Generating ? "validation" : "manual",
            reason: action.reason ?? state.errorMessage,
          })
        : state

    case GuideUiActionType.GenerateTemplateFallbackFailed:
      return state.stage === GuideUiStage.GenerateFailed ? { ...state, errorMessage: action.message } : state

    case GuideUiActionType.GenerateBack:
      return state.stage === GuideUiStage.GenerateFailed ? profileSelectionState(state) : state

    default:
      return undefined
  }
}

const reduceGenerate = (state: GuideUiState, action: GuideUiAction): GuideUiState =>
  reduceGenerateActive(state, action) ?? reduceGenerateRecovery(state, action) ?? state

const confirmCandidate = (state: GuideUiState): GuideUiState => {
  if (state.stage !== GuideUiStage.Candidates || state.candidates === undefined) return state
  return {
    ...state,
    stage: GuideUiStage.CheckingReadiness,
    selectedCandidate: tripleAt(state.candidates, state.candidateIndex),
    readiness: undefined,
  }
}

const placeCandidate = (state: GuideUiState): GuideUiState => {
  if (state.stage !== GuideUiStage.Candidates || state.candidates === undefined || state.selectedProfile === undefined) {
    return state
  }
  if (state.selectedProfile.interaction !== undefined) {
    return { ...state, errorMessage: "This workflow needs your answers. Press Enter to launch it directly; it cannot use the batch queue." }
  }
  return { ...state, stage: GuideUiStage.QueuePlacement, destinationIndex: 0, errorMessage: undefined }
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
      return confirmCandidate(state)

    case GuideUiActionType.CandidatesEnqueue:
      return placeCandidate(state)

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
  guideUiPrompt(state)?.workflow

export const guideUiTaskContext = (state: GuideUiState): GuideTaskContext =>
  state.selectedCustomerContext === undefined ? {} : {
    customerContext: state.selectedCustomerContext,
    originalIntent: validateGuideOriginalIntent(state.selectedOriginalIntent ?? state.originalIntent ?? state.intent),
  }

const guideUiPrompt = (state: GuideUiState): PreparedGuidePrompt | undefined => {
  const recommendation = state.selectedRecommendation
  if (state.guideDocument === undefined || recommendation === undefined || state.intent === undefined) return undefined
  return prepareGuidePrompt(
    state.guideDocument.guide, recommendation.workflowId, recommendation.ref, guideUiTaskContext(state),
  )
}

const candidateDirectEditDraft = (state: GuideUiState): string => {
  if (state.candidates === undefined) throw new Error("Direct editing requires prompt candidates")
  const current = tripleAt(state.candidates, state.candidateIndex)
  if (current.goalExecution !== undefined) return current.goalExecution.approach
  const workflow = candidateEditingWorkflow(state)
  return workflow === undefined ? current.prompt : guideModelBodyCandidate(workflow, current, guideUiTaskContext(state)).prompt
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
  if (current.goalExecution !== undefined) {
    return composeGuideGoalCandidate(current.goalExecution, { ...guideGoalCandidateBody(current), prompt: state.textDraft })
  }
  const edited = { ...current, prompt: state.textDraft }
  const workflow = candidateEditingWorkflow(state)
  return workflow === undefined
    ? validateFinalGuideCandidate(edited)
    : completeSinglePromptArtifact(workflow, renderWorkflowBodyCandidate(workflow, edited), guideUiTaskContext(state))
}

const submitDirectEdit = (state: GuideUiState): GuideUiState => {
  if (state.stage !== GuideUiStage.DirectEditor || state.candidates === undefined) return state
  if (state.textDraft.trim().length === 0) return { ...state, errorMessage: "Enter a non-empty specification." }
  try {
    const edited = directlyEditedCandidate(state)
    return {
      ...state,
      stage: GuideUiStage.Candidates,
      candidates: requireDistinctGuideCandidatePrompts(
        replaceCandidateAt(state.candidates, state.candidateIndex, edited),
        GuideCandidatePromptStage.FinalRendering,
      ),
      errorMessage: undefined,
    }
  } catch (cause) {
    if (cause instanceof GuideValidationError || cause instanceof GuideGoalError || cause instanceof GuideCandidatePromptCollisionError) return { ...state, errorMessage: cause.message }
    throw cause
  }
}

const reduceDirectEdit = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.DirectEditSubmit:
      return submitDirectEdit(state)

    case GuideUiActionType.DirectEditBack:
      return state.stage === GuideUiStage.DirectEditor
        ? { ...state, stage: GuideUiStage.Candidates, errorMessage: undefined }
        : state

    default:
      return state
  }
}

const reduceEditor = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.EditorChange:
      return editingStages.has(state.stage) ? { ...state, textDraft: action.text, errorMessage: undefined } : state

    case GuideUiActionType.EditorBackspace:
      return editingStages.has(state.stage)
        ? { ...state, textDraft: removeLastTextCharacter(state.textDraft), errorMessage: undefined }
        : state

    default:
      return state
  }
}

const refineSucceededState = (state: GuideUiState, candidate: GuideGenerateCandidate): GuideUiState => {
  if (state.stage !== GuideUiStage.Refining || state.candidates === undefined) return state
  try {
    const candidates = requireDistinctGuideCandidatePrompts(
      replaceCandidateAt(state.candidates, state.candidateIndex, candidate),
      GuideCandidatePromptStage.FinalRendering,
    )
    return {
      ...state,
      stage: GuideUiStage.Candidates,
      candidates,
      errorMessage: undefined,
    }
  } catch (cause) {
    if (!(cause instanceof GuideCandidatePromptCollisionError) && !(cause instanceof GuideValidationError)) throw cause
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
        ? { ...state, stage: GuideUiStage.Refining, selectedModels: {}, errorMessage: undefined }
        : state

    case GuideUiActionType.RefineSucceeded:
      return refineSucceededState(state, action.candidate)

    case GuideUiActionType.RefineFailed:
      return state.stage === GuideUiStage.Refining
        ? { ...state, stage: GuideUiStage.RefineFailed, errorMessage: action.message }
        : state

    case GuideUiActionType.RefineRetry:
      return state.stage === GuideUiStage.RefineFailed
        ? { ...state, stage: GuideUiStage.Refining, selectedModels: {}, errorMessage: undefined }
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
            textDraft: suggestedQueueBranch(state),
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
        : { ...state, stage: GuideUiStage.QueuePromptEditor, queue, textDraft: job.goalExecution?.approach ?? queuedGuideJobEditText(job) }
    }
    case GuideUiActionType.QueueEditSubmit:
      return submitQueueEdit(state)
    default:
      return state
  }

}

const submitQueueEdit = (state: GuideUiState): GuideUiState => {
  if (state.stage !== GuideUiStage.QueuePromptEditor) return state
  if (state.textDraft.trim().length === 0) return { ...state, errorMessage: "Enter a non-empty specification." }
  try {
    const selected = state.queue.entries.find((job) => job.id === state.queue.editingId)
    if (selected === undefined) return { ...state, errorMessage: "The queued request is no longer available." }
    if (state.textDraft === queuedGuideJobEditText(selected)) {
      const { editingId: _, ...queue } = state.queue
      return { ...state, stage: GuideUiStage.Queue, queue, errorMessage: undefined }
    }
    return {
      ...state,
      stage: GuideUiStage.Queue,
      queue: submitQueuedGuidePromptEdit(state.queue, state.textDraft),
      errorMessage: undefined,
    }
  } catch (cause) {
    if (cause instanceof GuideValidationError) return { ...state, errorMessage: cause.message }
    throw cause
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
        ? {
            ...emptyState,
            queue: state.queue,
            augmentJob: state.augmentJob,
            primaryCheckoutPath: state.primaryCheckoutPath,
          }
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
  if (state.stage !== GuideUiStage.Launching) return state
  if (action.type === GuideUiActionType.LaunchFailed) return { ...state, errorMessage: action.message }
  if (action.type !== GuideUiActionType.LaunchProgress) return state
  if (!state.launchBatch?.jobs.some((job) => job.id === action.event.jobId)) return state
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
const selectedQueuedContext = (state: GuideUiState): GuideQueuedContext | undefined => {
  if (state.selectedCustomerContext === undefined) return undefined
  const prepared = guideUiPrompt(state)
  if (prepared === undefined) throw new Error("Queue context requires a loaded selected workflow")
  return {
    originalIntent: validateGuideOriginalIntent(state.selectedOriginalIntent ?? state.originalIntent ?? state.intent),
    workflowId: prepared.workflow.id,
    workflow: prepared.workflow,
    ...(state.selectedCustomerContext === undefined ? {} : { customerContext: state.selectedCustomerContext }),
  }
}

const validateQueuedCheckoutRoot = (
  state: GuideUiState, placement: JobPlacement, primaryCheckoutPath: string | undefined, held: number | undefined,
): void => {
  if (placement.kind !== "new-worktree" || primaryCheckoutPath === undefined) return
  const existingRoot = state.queue.entries.find((job) =>
    job.id !== held && job.placement.kind === "new-worktree" && job.primaryCheckoutPath !== undefined,
  )?.primaryCheckoutPath
  if (existingRoot !== undefined && existingRoot !== primaryCheckoutPath) {
    throw new Error("New worktrees in one batch require the same checked primary checkout. Run these requests in separate batches.")
  }
}

const queuedCandidatePrompt = (
  state: GuideUiState, candidate: GuideGenerateCandidate, guideContext: GuideQueuedContext | undefined,
): string => {
  if (candidate.goalExecution !== undefined) return candidate.prompt
  if (guideContext === undefined) return validateFinalGuideCandidate(candidate).prompt
  return completeSinglePromptArtifact(guideContext.workflow, renderWorkflowBodyCandidate(
    guideContext.workflow, guideModelBodyCandidate(guideContext.workflow, candidate, guideUiTaskContext(state)),
  ), guideUiTaskContext(state)).prompt
}

const enqueueFailure = (state: GuideUiState, cause: unknown): GuideUiState => {
  if (cause instanceof GuideQueueConflictError) {
    return queueConflictState(state, cause, state.textDraft.trim() === cause.branch ? state.textDraft : cause.branch)
  }
  return { ...state, errorMessage: describeGuideUiError(cause) }
}

const enqueueSelectedCandidate = (
  state: GuideUiState,
  placement: JobPlacement,
  primaryCheckoutPath?: string,
): GuideUiState => {
  const profile = state.selectedProfile
  if (state.candidates === undefined || profile === undefined) return state
  const checkedRoot = placement.kind === "new-worktree" || placement.kind === "existing-worktree" ? primaryCheckoutPath : undefined
  try {
    const guideContext = selectedQueuedContext(state)
    const candidate = tripleAt(state.candidates, state.candidateIndex)
    const prompt = queuedCandidatePrompt(state, candidate, guideContext)
    const held = state.forks.find((fork) => fork.id === state.activeForkId)?.jobId
    validateQueuedCheckoutRoot(state, placement, checkedRoot, held)
    return {
      ...bindActiveForkToJob(state, held ?? state.queue.nextId),
      stage: GuideUiStage.Queue,
      queue:
        held === undefined
          ? enqueueGuideJob(state.queue, profile, prompt, placement, candidate.goalExecution ?? guideContext, checkedRoot)
          : replaceQueuedGuideJob(state.queue, held, profile, prompt, placement, candidate.goalExecution ?? guideContext, checkedRoot),
      ...(placement.kind !== "new-worktree" || checkedRoot === undefined ? {} : { primaryCheckoutPath: checkedRoot }),
      errorMessage: undefined,
    }
  } catch (cause) {
    return enqueueFailure(state, cause)
  }
}

const heldQueueJobId = (state: GuideUiState): number | undefined =>
  state.forks.find((fork) => fork.id === state.activeForkId)?.jobId

const suggestedQueueBranch = (state: GuideUiState): string => {
  const held = heldQueueJobId(state)
  const placement = state.queue.entries.find((job) => job.id === held)?.placement
  if (placement?.kind === "new-worktree") return placement.branch
  if (state.selectedProfile === undefined) throw new Error("A worktree suggestion requires a selected profile.")
  return suggestWorktreeBranch(guideBranchIntent(state) ?? "", state.selectedProfile, reservedWorktreeBranches(state.queue, held))
}

const queueConflictState = (state: GuideUiState, error: GuideQueueConflictError, branch: string): GuideUiState => ({
  ...state,
  stage: GuideUiStage.WorktreeBranchEditor,
  textDraft: branch,
  worktreeBranch: undefined,
  worktreeInspection: undefined,
  worktreeConfirmations: 0,
  errorMessage: error.message,
})

const reduceQueuePlacementNavigation = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.QueuePlacementMove:
      return state.stage === GuideUiStage.QueuePlacement
        ? {
            ...state,
            destinationIndex: (state.destinationIndex + action.delta + queuePlacementOptions(state).length) % queuePlacementOptions(state).length,
          }
        : state
    case GuideUiActionType.QueuePlacementBack:
      return state.stage === GuideUiStage.QueuePlacement ? { ...state, stage: GuideUiStage.Candidates } : state
    case GuideUiActionType.QueuePlacementUnavailable:
      return state.stage === GuideUiStage.QueuePlacement
        ? { ...state, errorMessage: "Herdr is unavailable. Start trx guide from a Herdr pane or popup." }
        : state
    default:
      return state
  }
}

const reduceQueuePlacement = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.QueuePlacementHere:
      return state.stage === GuideUiStage.QueuePlacement
        ? enqueueSelectedCandidate(state, { kind: "current-workspace-pane", direction: "right" })
        : state
    case GuideUiActionType.QueuePlacementStartWorktree:
      return state.stage === GuideUiStage.QueuePlacement
        ? {
            ...state,
            stage: GuideUiStage.WorktreeBranchEditor,
            textDraft: suggestedQueueBranch(state),
            worktreeInspection: undefined,
            worktreeReturnStage: GuideUiStage.QueuePlacement,
            errorMessage: undefined,
          }
        : state
    case GuideUiActionType.QueuePlacementWorktree:
      return enqueueSelectedCandidate(state, action.placement, action.primaryCheckoutPath)
    default:
      return reduceQueuePlacementNavigation(state, action)
  }
}

const reduceWorktreeBranch = (state: GuideUiState, action: GuideUiAction): GuideUiState => {
  switch (action.type) {
    case GuideUiActionType.WorktreeSubmitBranch: {
      if (state.stage === GuideUiStage.WorktreeBranchEditor) {
        const conflict = findGuideQueueConflict(state.queue, state.textDraft, heldQueueJobId(state))
        if (conflict !== undefined) return queueConflictState(state, conflict, state.textDraft)
      }
      return state.stage === GuideUiStage.WorktreeBranchEditor && state.textDraft.trim().length > 0
        ? {
            ...state,
            stage: GuideUiStage.InspectingWorktree,
            worktreeBranch: state.textDraft.trim(),
            errorMessage: undefined,
          }
        : state
    }

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
  const applied = guideUiReducer({ ...hydrateFork(state, target.slice), activeForkId: forkId }, action)
  return {
    ...applied,
    ...forkSlice(state),
    activeForkId: state.activeForkId,
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
  [GuideUiActionType.InputRejected]: (state, action) =>
    action.type === GuideUiActionType.InputRejected ? { ...state, errorMessage: action.message } : state,
  [GuideUiActionType.IntentChange]: reduceIntent,
  [GuideUiActionType.IntentBackspace]: reduceIntent,
  [GuideUiActionType.IntentSubmit]: reduceIntent,
  [GuideUiActionType.AugmentOpen]: reduceAugment,
  [GuideUiActionType.AugmentMove]: reduceAugment,
  [GuideUiActionType.AugmentConfirm]: reduceAugment,
  [GuideUiActionType.AugmentProgress]: reduceAugment,
  [GuideUiActionType.AugmentOutput]: reduceAugment,
  [GuideUiActionType.AugmentSucceeded]: reduceAugment,
  [GuideUiActionType.AugmentFailed]: reduceAugment,
  [GuideUiActionType.AugmentRetry]: reduceAugment,
  [GuideUiActionType.AugmentApply]: reduceAugment,
  [GuideUiActionType.AugmentDiscard]: reduceAugment,
  [GuideUiActionType.AugmentBack]: reduceAugment,
  [GuideUiActionType.AugmentGoalRequest]: reduceAugment,
  [GuideUiActionType.AugmentGoalTurn]: reduceAugment,
  [GuideUiActionType.AugmentGoalPanel]: reduceAugment,
  [GuideUiActionType.AugmentGoalAutoAccept]: reduceAugment,
  [GuideUiActionType.AugmentCustomerPanel]: reduceAugment,
  [GuideUiActionType.AugmentCustomerApprove]: reduceAugment,
  [GuideUiActionType.MatchRetry]: reduceMatch,
  [GuideUiActionType.MatchProgress]: reduceMatchProgress,
  [GuideUiActionType.MatchAttempt]: reduceMatchProgress,
  [GuideUiActionType.MatchSucceeded]: reduceMatch,
  [GuideUiActionType.MatchFailed]: reduceMatch,
  [GuideUiActionType.MatchLiteral]: reduceMatch,
  [GuideUiActionType.MatchLiteralFailed]: reduceMatch,
  [GuideUiActionType.RecommendationsMove]: reduceRecommendations,
  [GuideUiActionType.RecommendationsConfirm]: reduceRecommendations,
  [GuideUiActionType.DecideOpen]: reduceRecommendations,
  [GuideUiActionType.DecideClose]: reduceRecommendations,
  [GuideUiActionType.ReviewOpen]: reduceSideScreen,
  [GuideUiActionType.ReviewBack]: reduceSideScreen,
  [GuideUiActionType.OptimizeOpen]: reduceSideScreen,
  [GuideUiActionType.OptimizeBack]: reduceSideScreen,
  [GuideUiActionType.PromptReviewOpen]: reducePromptReview,
  [GuideUiActionType.PromptReviewEdit]: reducePromptReview,
  [GuideUiActionType.PromptReviewChange]: reducePromptReview,
  [GuideUiActionType.PromptReviewBackspace]: reducePromptReview,
  [GuideUiActionType.PromptReviewSubmit]: reducePromptReview,
  [GuideUiActionType.PromptReviewBack]: reducePromptReview,
  [GuideUiActionType.GoalChangeRevise]: reduceGoalChange,
  [GuideUiActionType.GoalChangeDetach]: reduceGoalChange,
  [GuideUiActionType.GoalChangeKeep]: reduceGoalChange,
  [GuideUiActionType.GenerateGuideLoaded]: reduceGenerate,
  [GuideUiActionType.ModelSelected]: reduceGenerateProgress,
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
  [GuideUiActionType.LaunchFailed]: reduceLaunch,
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
  if (state.launchBatch !== undefined &&
      action.type !== GuideUiActionType.LaunchProgress && action.type !== GuideUiActionType.LaunchFailed) return state
  const domainReducer = (domainReducerByActionType as Partial<Record<string, GuideUiDomainReducer>>)[action.type]
  const next = domainReducer === undefined ? state : domainReducer(state, action)
  return next.nextAugmentRunId < state.nextAugmentRunId ? { ...next, nextAugmentRunId: state.nextAugmentRunId } : next
}

// ---------------------------------------------------------------------------
// Deterministic literal-match enrichment mirrors guide-api.ts using only exported catalog data;
// model matches already return fully enriched recommendations.
// ---------------------------------------------------------------------------

const isGuidedEntry = (entry: CompositionCatalogEntry): entry is CompositionCatalogEntry & { readonly guide: ProfileGuideV1 } =>
  entry.guide !== null

const findCombinedCatalogEntry = (
  catalog: CompositionCatalog,
  ref: string,
): { readonly entry: CompositionCatalogEntry & { readonly guide: ProfileGuideV1 } } | undefined => {
  const entry = catalog.entries.filter(isGuidedEntry).find((candidate) => candidate.ref === ref)
  return entry === undefined ? undefined : { entry }
}

const goalRecommendationReason = (
  catalog: CompositionCatalog,
  goal: PreparedGuideGoal | undefined,
  recommendation: GuideRecommendation,
): string | undefined => {
  if (goal === undefined) return undefined
  const found = findCombinedCatalogEntry(catalog, recommendation.ref)
  if (found === undefined) return "The selected profile is no longer available."
  try {
    resolveGuideGoalExecution(goal, found.entry.guide, recommendation.workflowId)
    return undefined
  } catch (error) {
    if (!(error instanceof GuideGoalError || error instanceof GuideValidationError)) throw error
    return error.message
  }
}

/** Enriches a deterministic literal-match candidate into the same `GuideRecommendation` shape the model-match path produces. */
export const enrichLiteralCandidate = (
  catalog: CompositionCatalog,
  candidate: {
    readonly harness: string
    readonly profiles: ReadonlyArray<string>
    readonly workflowId: string
    readonly confidence: number
    readonly reason: string
    readonly tradeoff: string
    readonly goalExecution?: NonNullable<GuideRecommendation["goalExecution"]>
  },
): GuideRecommendation => {
  const ref = formatCompositionRef(candidate.harness, candidate.profiles)
  const found = findCombinedCatalogEntry(catalog, ref)
  if (found === undefined) throw new Error(`Literal match references an unknown composition: ${ref}`)
  const { entry } = found
  const workflow = compactProfileGuide(entry.guide).workflows.find(({ id }) => id === candidate.workflowId)
  if (workflow === undefined) {
    throw new Error(`Literal match references an unknown workflow of ${ref}: ${candidate.workflowId}`)
  }
  return {
    ref,
    harness: entry.harness,
    profiles: entry.profiles,
    workflowId: candidate.workflowId,
    confidence: candidate.confidence,
    reason: candidate.reason,
    tradeoff: candidate.tradeoff,
    description: entry.description,
    workflow,
    prerequisites: entry.guide.prerequisites,
    headless: entry.headless,
    herdrCompatibility: entry.herdrCompatibility,
    ...(candidate.goalExecution === undefined ? {} : { goalExecution: candidate.goalExecution }),
  }
}

export enum GuidePinnedLensKind {
  Council = "council",
  SixHats = "six-hats",
  Research = "research",
  HveRpi = "hve-rpi",
  Discovery = "discovery",
  Experiment = "experiment",
}

/** Opens the Decide chooser; decision lenses are bound to keys inside it. */
export const guideDecideKey = "c"

export interface GuidePinnedLens {
  readonly kind: GuidePinnedLensKind
  /** Inside the Decide chooser for decision lenses; on the recommendations screen otherwise. */
  readonly key: string
  readonly decision: boolean
  readonly emoji: string
  readonly label: string
  readonly description: string
  readonly agent?: string
  readonly recommendation: GuideRecommendation
}

const pinnedLensDefinitions: ReadonlyArray<
  Omit<GuidePinnedLens, "recommendation"> & {
    readonly ref: string
    readonly workflowId: string
    readonly reason: string
    readonly tradeoff: string
  }
> = [
  {
    kind: GuidePinnedLensKind.Council,
    key: "c",
    decision: true,
    emoji: "🧠",
    label: "Council",
    description: "Pressure-test the idea and its implementation.",
    ref: "native:claude/council",
    workflowId: "run-council-deliberation",
    reason: "Use a structured council to challenge the idea, its assumptions, and its implementation.",
    tradeoff: "Adds deliberation time before implementation begins.",
  },
  {
    kind: GuidePinnedLensKind.SixHats,
    key: "6",
    decision: true,
    emoji: "🎩",
    label: "Six Thinking Hats",
    description: "Facts, gut, value, risks, and tried options, then one plan.",
    ref: "native:claude/six-hats",
    workflowId: "run-six-hats-deliberation",
    reason: "Separate facts, feelings, benefits, risks, and alternatives before committing to one plan.",
    tradeoff: "Runs six subagents, including a scratch-copy prototype, before implementation begins.",
  },
  {
    kind: GuidePinnedLensKind.Research,
    key: "r",
    decision: false,
    emoji: "🔎",
    label: "Research",
    description: "Gather evidence before implementation.",
    ref: "native:claude/research",
    workflowId: "vault-backed-research",
    reason: "Collect source-backed evidence, prior art, risks, and implementation options before acting.",
    tradeoff: "Adds research time before implementation begins.",
  },
  {
    kind: GuidePinnedLensKind.HveRpi,
    key: "h",
    decision: false,
    emoji: "🔄",
    label: "HVE RPI",
    description: "Run the dedicated HVE Core RPI agent.",
    ref: "native:copilot/hve",
    workflowId: "rpi-agent-cycle",
    agent: "hve-core:rpi-agent",
    reason:
      "Use HVE Core's dedicated agent to carry the request through research, planning, implementation, and review.",
    tradeoff: "Adds a structured multi-stage process that is unnecessary for small changes.",
  },
  {
    kind: GuidePinnedLensKind.Discovery,
    key: "d",
    decision: false,
    emoji: "💬",
    label: "Discover with the customer",
    description: "Clarify needs and evidence with DT Coach.",
    ref: "native:copilot/hve",
    workflowId: "customer-discovery",
    reason: "Work with the customer on the problem and resume the method supported by the existing evidence.",
    tradeoff: "Needs your answers and customer decisions; not an unattended engineering run.",
  },
  {
    kind: GuidePinnedLensKind.Experiment,
    key: "e",
    decision: false,
    emoji: "🧪",
    label: "Test an assumption",
    description: "Plan a bounded experiment before investment.",
    ref: "native:copilot/hve",
    workflowId: "test-assumption",
    reason: "Define a falsifiable hypothesis and measurement criteria before approving an experiment.",
    tradeoff: "Needs human approval before execution; a working demo does not establish the hypothesis.",
  },
]

export const pinnedGuideLenses = (catalog: CompositionCatalog): ReadonlyArray<GuidePinnedLens> =>
  pinnedLensDefinitions.flatMap((definition) => {
    const found = findCombinedCatalogEntry(catalog, definition.ref)
    if (!found?.entry.guide.workflows.some(({ id }) => id === definition.workflowId)) return []
    const { ref: _ref, workflowId, reason, tradeoff, ...lens } = definition
    return [
      {
        ...lens,
        recommendation: enrichLiteralCandidate(catalog, {
          harness: found.entry.harness,
          profiles: found.entry.profiles,
          workflowId,
          confidence: 1,
          reason,
          tradeoff,
        }),
      },
    ]
  })

export const selectedProfileForPinnedLens = (catalog: CompositionCatalog, lens: GuidePinnedLens): SelectedProfile => {
  const selectedProfile = selectedProfileFromCatalogRef(
    catalog,
    lens.recommendation.ref,
    lens.recommendation.workflowId,
  )
  if (lens.agent === undefined) return selectedProfile
  return parseSelectedProfile({ ...selectedProfile, agent: lens.agent })
}

/** Computes the three deterministic, model-free literal-match recommendations, fully enriched for display. */
export const literalGuideRecommendations = (
  catalog: CompositionCatalog,
  intent: string,
  goal?: PreparedGuideGoal,
): ReadonlyArray<GuideRecommendation> =>
  literalGuideMatch(catalog, intent, goal).map((candidate) => enrichLiteralCandidate(catalog, candidate))

/** Computes deterministic template-based prompt candidates for the generate-failure fallback. */
export const templateGuideCandidates = (
  guide: ProfileGuideV1,
  workflowId: string,
  intent: string,
  contextOrGoal: GuideTaskContext | PreparedGuideGoal = {},
): Triple<GuideGenerateCandidate> => {
  if ("fingerprint" in contextOrGoal) return templatePromptCandidates(guide, workflowId, intent, contextOrGoal)
  const context = contextOrGoal
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`Unknown workflow reference: ${workflowId}`)
  const candidates = templatePromptCandidates(guide, workflowId, stripCustomerContext(intent, context.customerContext))
  return [
    completeSinglePromptArtifact(workflow, candidates[0], context),
    completeSinglePromptArtifact(workflow, candidates[1], context),
    completeSinglePromptArtifact(workflow, candidates[2], context),
  ]
}

// ---------------------------------------------------------------------------
// Generation / refinement orchestration. Extracted as plain async functions
// (no React) so the "use the match-selected workflow, never re-match" and
// "refine stays constrained to the same intent/profile/workflow/guide/body"
// requirements are directly unit-testable with a fake `GuideProvider`.
// ---------------------------------------------------------------------------

export interface GuideTemplateFallback {
  readonly kind: "validation" | "manual"
  readonly reason: string | undefined
}

export interface GuideGenerationStepResult {
  readonly guideDocument: SelectedGuideDocument
  readonly candidates: Triple<GuideGenerateCandidate>
  readonly templateFallback: GuideTemplateFallback | undefined
}

export const runGuideMatchingStep = async (
  provider: GuideProvider,
  catalog: CompositionCatalog,
  request: GuideMatchRequest,
  onProgress?: (phase: GuideMatchPhase) => void,
  cache?: GuideArtifactCache,
  options?: GuideMatchOptions,
): Promise<GuideMatchResponse> => {
  onProgress?.(GuideMatchPhase.ComparingProfiles)
  const response = await runGuideMatch(provider, catalog, request, cache, options)
  onProgress?.(GuideMatchPhase.PreparingRecommendations)
  return response
}

/**
 * Loads only the recommendation's own guide, then calls `provider.generate`
 * with the recommendation's own `workflowId` and the loaded Markdown body.
 * Never re-runs matching and never recomputes the workflow.
 */
export const runGuideGenerationStep = async (
  catalog: CompositionCatalog,
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
  contextOrGoal: GuideTaskContext | PreparedGuideGoal = {},
  shouldSkipOptimize?: (input: GuideOptimizeInput) => Promise<boolean>,
): Promise<GuideGenerationStepResult> => {
  const goal = "fingerprint" in contextOrGoal ? contextOrGoal : undefined
  const context = "fingerprint" in contextOrGoal ? {} : contextOrGoal
  const guideDocument = await loadSelectedGuide(catalog, guideRoot, recommendation.ref)
  onGuideLoaded?.(guideDocument)
  const prepared = prepareGuidePrompt(guideDocument.guide, recommendation.workflowId, recommendation.ref, context)
  const subject = stripCustomerContext(intent, prepared.context.customerContext)
  assertGuidePromptDeliveryContext(prepared.context)
  const workflow = prepared.workflow
  const complete = (candidate: GuideGenerateCandidate): GuideGenerateCandidate =>
    completeSinglePromptArtifact(
      workflow, renderWorkflowBodyCandidate(workflow, guideModelBodyCandidate(workflow, candidate, prepared.context)), prepared.context,
    )
  const fixedFrame = workflowOptimizeFixedFrame(workflow)
  const targetTool = guideTargetTool(catalog, recommendation.ref)
  if (goal !== undefined) {
    const result = await runGuideGoalGeneration(provider, {
      intent,
      profileRef: recommendation.ref,
      workflowId: recommendation.workflowId,
      guide: guideDocument.guide,
      guideBody: guideDocument.body,
      targetTool,
      goal,
    }, {
      ...(cache === undefined ? {} : { cache }),
      onPhase: (phase) => onProgress?.(
        phase === "optimize" ? GuideGenerationPhase.OptimizingCandidates : GuideGenerationPhase.GeneratingCandidates,
      ),
    })
    onProgress?.(GuideGenerationPhase.ApplyingWorkflow)
    return { guideDocument, candidates: result.candidates, templateFallback: undefined }
  }
  const produce = async () => {
    onProgress?.(GuideGenerationPhase.GeneratingCandidates)
    const generated = await provider.generate({
      intent: subject,
      profileRef: recommendation.ref,
      workflowId: recommendation.workflowId,
      guide: prepared.guide,
      guideBody: guideDocument.body,
      ...prepared.context,
      bodyBudget: prepared.bodyBudget,
    })
    const [first, second, third] = generated.candidates
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Generation must return exactly three prompt candidates")
    }
    onProgress?.(GuideGenerationPhase.ApplyingWorkflow)
    const bodyCandidates = requireDistinctGuideCandidatePrompts(
      [
        resolveGeneratedWorkflowBodyCandidate(prepared.guide, workflow, subject, first),
        resolveGeneratedWorkflowBodyCandidate(prepared.guide, workflow, subject, second),
        resolveGeneratedWorkflowBodyCandidate(prepared.guide, workflow, subject, third),
      ],
      GuideCandidatePromptStage.GeneratedBodyNormalization,
    )
    const optimizeInput: GuideOptimizeInput = {
      targetTool,
      profileRef: recommendation.ref,
      candidates: bodyCandidates,
      ...prepared.context,
      bodyBudget: prepared.bodyBudget,
      ...(fixedFrame === undefined ? {} : { fixedFrame }),
    }
    const skipOptimization = goal === undefined && (await shouldSkipOptimize?.(optimizeInput)) === true
    if (!skipOptimization) onProgress?.(GuideGenerationPhase.OptimizingCandidates)
    const optimized = skipOptimization ? { candidates: bodyCandidates } : await provider.optimize(optimizeInput)
    const [optimizedFirst, optimizedSecond, optimizedThird] = optimized.candidates
    if (optimizedFirst === undefined || optimizedSecond === undefined || optimizedThird === undefined) {
      throw new Error("Prompt Master must return exactly three prompt candidates")
    }
    const renderedCandidates = requireDistinctGuideCandidatePrompts(
      [
        renderWorkflowBodyCandidate(
          workflow,
          resolveWorkflowBodyCandidate(prepared.guide, workflow, bodyCandidates[0], optimizedFirst),
        ),
        renderWorkflowBodyCandidate(
          workflow,
          resolveWorkflowBodyCandidate(prepared.guide, workflow, bodyCandidates[1], optimizedSecond),
        ),
        renderWorkflowBodyCandidate(
          workflow,
          resolveWorkflowBodyCandidate(prepared.guide, workflow, bodyCandidates[2], optimizedThird),
        ),
      ],
      GuideCandidatePromptStage.FinalRendering,
    )
    return {
      candidates: requireDistinctGuideCandidatePrompts(
        [
          complete(renderedCandidates[0]),
          complete(renderedCandidates[1]),
          complete(renderedCandidates[2]),
        ],
        GuideCandidatePromptStage.FinalRendering,
      ),
    }
  }
  let generated: { readonly candidates: ReadonlyArray<GuideGenerateCandidate> }
  try {
    generated = await (cache === undefined
      ? produce()
      : cache.generation(
          {
            intent,
            profileRef: recommendation.ref,
            workflowId: recommendation.workflowId,
            guide: prepared.guide,
            guideBody: guideDocument.body,
            targetTool,
            ...prepared.context,
            bodyBudget: prepared.bodyBudget,
            ...(fixedFrame === undefined ? {} : { fixedFrame }),
          },
          produce,
        ))
  } catch (cause) {
    if (!(cause instanceof GuideWorkflowBodyError)) throw cause
    return {
      guideDocument,
      candidates: templateGuideCandidates(prepared.guide, recommendation.workflowId, intent, contextOrGoal),
      templateFallback: { kind: "validation", reason: cause.message },
    }
  }
  const [first, second, third] = generated.candidates
  if (first === undefined || second === undefined || third === undefined)
    throw new Error("Cached generation must contain three candidates")
  return {
    guideDocument,
    candidates: [complete(first), complete(second), complete(third)],
    templateFallback: undefined,
  }
}

/**
 * Calls `provider.refine` constrained by the same intent, profile,
 * workflow, guide, and guide body as the original generation, plus the
 * candidate being refined and the user's feedback.
 */
export const runGuideRefinementStep = async (
  catalog: CompositionCatalog,
  provider: GuideProvider,
  intent: string,
  recommendation: GuideRecommendation,
  guideDocument: SelectedGuideDocument,
  candidates: Triple<GuideGenerateCandidate>,
  candidateIndex: number,
  feedback: string,
  cache?: GuideArtifactCache,
  contextOrGoal: GuideTaskContext | PreparedGuideGoal = {},
  shouldSkipOptimize?: (input: GuideOptimizeInput) => Promise<boolean>,
): Promise<GuideGenerateCandidate> => {
  const goal = "fingerprint" in contextOrGoal ? contextOrGoal : undefined
  const context = "fingerprint" in contextOrGoal ? {} : contextOrGoal
  const prepared = prepareGuidePrompt(guideDocument.guide, recommendation.workflowId, recommendation.ref, context)
  assertGuidePromptDeliveryContext(prepared.context)
  const workflow = prepared.workflow
  const candidate = tripleAt(candidates, candidateIndex)
  const bodyCandidate = guideModelBodyCandidate(workflow, candidate, prepared.context)
  const fixedFrame = workflowOptimizeFixedFrame(workflow)
  const targetTool = guideTargetTool(catalog, recommendation.ref)
  const preparedGoal = goal ?? candidate.goalExecution?.goal
  if (preparedGoal !== undefined) {
    const result = await runGuideGoalRefinement(provider, {
      intent,
      profileRef: recommendation.ref,
      workflowId: recommendation.workflowId,
      guide: guideDocument.guide,
      guideBody: guideDocument.body,
      targetTool,
      goal: preparedGoal,
      candidate,
      candidates,
      candidateIndex,
      feedback,
    }, cache === undefined ? {} : { cache })
    requireDistinctGuideCandidatePrompts(
      replaceCandidateAt(candidates, candidateIndex, result.candidate),
      GuideCandidatePromptStage.FinalRendering,
    )
    return result.candidate
  }
  const produce = async () => {
    const refined = await provider.refine({
      intent: stripCustomerContext(intent, prepared.context.customerContext),
      profileRef: recommendation.ref,
      workflowId: recommendation.workflowId,
      guide: prepared.guide,
      guideBody: guideDocument.body,
      ...prepared.context,
      bodyBudget: prepared.bodyBudget,
      candidate: bodyCandidate,
      feedback,
    })
    const refinedBodyCandidate = resolveRefinedWorkflowBodyCandidate(
      prepared.guide,
      workflow,
      bodyCandidate,
      refined.candidate,
    )
    const optimizeInput: GuideOptimizeInput = {
      targetTool,
      profileRef: recommendation.ref,
      candidates: [refinedBodyCandidate],
      ...prepared.context,
      bodyBudget: prepared.bodyBudget,
      ...(fixedFrame === undefined ? {} : { fixedFrame }),
    }
    const skipOptimization = goal === undefined && (await shouldSkipOptimize?.(optimizeInput)) === true
    const optimized = skipOptimization ? { candidates: [refinedBodyCandidate] } : await provider.optimize(optimizeInput)
    const optimizedCandidate = optimized.candidates[0]
    if (optimizedCandidate === undefined) throw new Error("Prompt Master must return one refined prompt candidate")
    const renderedCandidate = renderWorkflowBodyCandidate(
      workflow,
      resolveWorkflowBodyCandidate(prepared.guide, workflow, refinedBodyCandidate, optimizedCandidate),
    )
    return {
      candidate: completeSinglePromptArtifact(workflow, renderedCandidate, prepared.context),
    }
  }
  const refined = await (cache === undefined
    ? produce()
    : cache.refinement(
        {
          intent,
          profileRef: recommendation.ref,
          workflowId: recommendation.workflowId,
          guide: prepared.guide,
          guideBody: guideDocument.body,
          targetTool,
          ...prepared.context,
          bodyBudget: prepared.bodyBudget,
          ...(fixedFrame === undefined ? {} : { fixedFrame }),
          candidates,
          candidateIndex,
          feedback,
        },
        produce,
      ))
  const finalCandidate = completeSinglePromptArtifact(workflow, refined.candidate, prepared.context)
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

interface GuideUiGoalResult {
  readonly goalExecution?: GuideGoalCandidateContext
}

export interface GuideUiPrintResult extends GuideUiGoalResult {
  readonly action: "print"
  readonly prompt: string
  readonly notice?: string
}

export interface GuideUiCurrentTerminalResult extends GuideUiGoalResult {
  readonly action: "current-terminal"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly promptHandling: PromptHandlingMode
  readonly prompt: string
  readonly cwd: string
}

export interface GuideUiCurrentHerdrWorkspaceResult extends GuideUiGoalResult {
  readonly action: "current-herdr-workspace"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly cwd: string
  readonly callerPaneId: string
  readonly direction: HerdrSplitDirection
}

export interface GuideUiNewHerdrWorktreeResult extends GuideUiGoalResult {
  readonly action: "herdr-worktree-create"
  readonly profile: SelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly primaryCheckoutPath: string
  readonly branch: string
  readonly baseRef: string
}

export interface GuideUiExistingHerdrWorktreeResult extends GuideUiGoalResult {
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
export interface GuideUiNewHerdrTabResult extends GuideUiGoalResult {
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
  | GuideReviewTerminalResult
  | ReviewPlanTerminalResult
  | { readonly action: "review-submitted" }
  | { readonly action: "review" }

export const buildCancelResult = (): GuideUiCancelResult => ({ action: "cancel", exitCode: 130 })

export const buildPrintResult = (prompt: string, goalExecution?: GuideGoalCandidateContext): GuideUiPrintResult =>
  goalExecution === undefined ? { action: "print", prompt } : { action: "print", prompt, goalExecution }

export const buildCurrentTerminalResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
  goalExecution?: GuideGoalCandidateContext,
): GuideUiCurrentTerminalResult => {
  const built = buildGuideLaunchCommand(profile, { mode: "argv", prompt }, goalExecution)
  return {
    action: "current-terminal",
    profile,
    command: built.command,
    promptHandling: built.promptHandling,
    prompt,
    cwd,
    ...(goalExecution === undefined ? {} : { goalExecution }),
  }
}

export const buildNewHerdrTabResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
  herdrContext: HerdrContext,
  goalExecution?: GuideGoalCandidateContext,
): GuideUiNewHerdrTabResult => {
  const built = buildHerdrGuideLaunch(profile, prompt, goalExecution)
  return {
    action: "new-herdr-tab",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
    cwd,
    workspaceId: herdrContext.workspaceId,
    ...(goalExecution === undefined ? {} : { goalExecution }),
  }
}

export const buildCurrentHerdrWorkspaceResult = (
  profile: SelectedProfile,
  prompt: string,
  cwd: string,
  herdrContext: HerdrContext,
  direction: HerdrSplitDirection = "right",
  goalExecution?: GuideGoalCandidateContext,
): GuideUiCurrentHerdrWorkspaceResult => {
  const built = buildHerdrGuideLaunch(profile, prompt, goalExecution)
  return {
    action: "current-herdr-workspace",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
    cwd,
    callerPaneId: herdrContext.paneId,
    direction,
    ...(goalExecution === undefined ? {} : { goalExecution }),
  }
}

export const buildNewHerdrWorktreeResult = (
  profile: SelectedProfile,
  prompt: string,
  primaryCheckoutPath: string,
  branch: string,
  baseRef: string,
  goalExecution?: GuideGoalCandidateContext,
): GuideUiNewHerdrWorktreeResult => {
  const built = buildHerdrGuideLaunch(profile, prompt, goalExecution)
  return {
    action: "herdr-worktree-create",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
    primaryCheckoutPath,
    branch,
    baseRef,
    ...(goalExecution === undefined ? {} : { goalExecution }),
  }
}

export const buildExistingHerdrWorktreeResult = (
  profile: SelectedProfile,
  prompt: string,
  primaryCheckoutPath: string,
  path: string,
  goalExecution?: GuideGoalCandidateContext,
): GuideUiExistingHerdrWorktreeResult => {
  const built = buildHerdrGuideLaunch(profile, prompt, goalExecution)
  return {
    action: "herdr-worktree-open",
    profile,
    command: built.command,
    prompt,
    promptDelivery: built.promptDelivery,
    primaryCheckoutPath,
    path,
    ...(goalExecution === undefined ? {} : { goalExecution }),
  }
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export interface GuideUiProps {
  readonly catalog: CompositionCatalog
  /** Refreshes runtime capability fields; production entrypoints inject this, fixtures do not. */
  readonly resolveCatalog?: (signal?: AbortSignal) => Promise<CompositionCatalog>
  readonly guideRoot: string
  readonly provider: GuideProvider
  readonly matcher?: GuideMatchAdapter
  readonly goalProvider?: GuideGoalAugmentProvider
  readonly goalReadinessServices?: GuideGoalReadinessServices
  readonly cache?: GuideArtifactCache
  readonly routing: GuideResolvedModelRouting
  readonly reviewModelOverrides?: Partial<GuideResolvedModelRouting["optimize"]>
  readonly runner: CommandRunner
  readonly cwd: string
  /** Raw Herdr environment used to derive `HerdrContext` via `getHerdrContext`. */
  readonly herdrEnv: HerdrEnvironment
  /** Whether a Herdr availability probe (e.g. `probeHerdrAvailability`) succeeded, checked before rendering. */
  readonly herdrAvailabilityProbe: boolean
  readonly initialIntent?: string
  /** Open directly on the Optimize screen; Esc returns to an empty intent. */
  readonly openOptimize?: boolean
  readonly reviewServices?: GuideReviewServices
  readonly runOptimizeSdk?: (options: GuideOptimizeSdkOptions) => Promise<void>
  readonly ensureOptimizeSkills?: typeof ensureOptimizeSkills
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
    label:
      capture.source === "conversation-transcript"
        ? "Exact conversation transcript"
        : "Exact agent result",
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

const cyclicItemAt = <T,>(items: ReadonlyArray<T>, index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length]

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

export const matchProgressItems = (
  readProfileCount: number,
  availableProfileCount: number,
): ReadonlyArray<GuideMatchProgressItem> => [
  {
    phase: GuideMatchPhase.LoadingProfiles,
    label: `Read ${readProfileCount} out of ${availableProfileCount} profiles and their workflows`,
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
  const unicode = useUnicode()
  const activeIndex = items.findIndex((item) => item.phase === activePhase)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{title}</Text>
      <Text dimColor wrap="truncate-end">
        Request: {summarizeGenerationIntent(intent)}
      </Text>
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle={resolveBorderStyle("round", unicode)}
        borderColor="cyan"
        paddingX={1}
      >
        {items.map((item, index) => {
          const complete = index < activeIndex
          const active = index === activeIndex
          return (
            <Text key={item.phase} color={complete ? "green" : active ? "cyan" : "gray"}>
              {complete
                ? resolveStatusSymbol(unicode, "success")
                : active
                  ? spinnerFrameAt(tick)
                  : resolveStatusSymbol(unicode, "pending")}{" "}
              {item.label}
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
  execution,
  fallback,
  profileCount,
}: {
  readonly catalog: CompositionCatalog
  readonly phase: GuideMatchPhase
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly execution: GuideMatchExecution | undefined
  readonly fallback: GuideMatcherFallback | undefined
  readonly profileCount: number | undefined
}) => {
  const availableProfileCount = catalog.entries.length
  const readProfileCount = profileCount ?? availableProfileCount
  const executionLabel = matchExecutionLabel(execution, model, effort)
  return (
    <Box flexDirection="column">
      <ProgressPipeline
        title="Finding the best profiles"
        intent={intent}
        items={matchProgressItems(readProfileCount, availableProfileCount)}
        activePhase={phase}
        detail={executionLabel}
      />
      <Box paddingX={1}>
        <MatchFallbackNotice fallback={fallback} />
      </Box>
      <Text dimColor>p view prompt · q cancel</Text>
    </Box>
  )
}

export const matchExecutionLabel = (
  execution: GuideMatchExecution | undefined,
  model: string,
  effort: GuideEffort,
): string => execution?.backend === "jev"
  ? `Jev model: ${execution.model}`
  : `Copilot model: ${execution?.model ?? model} · Effort: ${execution?.effort ?? effort}`

const jevFallbackReasons: Readonly<Record<GuideMatcherFallbackReason, string>> = {
  [GuideMatcherFallbackReason.MissingCredentials]: "TYPESAFE_API_KEY is not set",
  [GuideMatcherFallbackReason.Timeout]: "Jev did not answer within 3 seconds",
  [GuideMatcherFallbackReason.RequestFailed]: "the Jev request failed",
  [GuideMatcherFallbackReason.InvalidResponse]: "Jev returned an invalid result",
}

/** Encourages Jev without requiring it: Copilot still matches, but the user sees why the fast path was skipped. */
export const matchFallbackNotice = (
  fallback: GuideMatcherFallback | undefined,
): { readonly summary: string; readonly hint: string | undefined } | undefined =>
  fallback === undefined
    ? undefined
    : {
        summary: `Jev not in use: ${jevFallbackReasons[fallback.reason]}. Copilot matched instead (slower).`,
        hint: fallback.reason === GuideMatcherFallbackReason.MissingCredentials
          ? "For faster matching, add TYPESAFE_API_KEY to ~/.config/trellage/.env.local (mode 600)."
          : undefined,
      }

const MatchFallbackNotice = ({ fallback }: { readonly fallback: GuideMatcherFallback | undefined }) => {
  const notice = matchFallbackNotice(fallback)
  if (notice === undefined) return null
  return (
    <Box flexDirection="column">
      <Text color="yellow" wrap="wrap">{notice.summary}</Text>
      {notice.hint === undefined ? null : <Text dimColor wrap="wrap">{notice.hint}</Text>}
    </Box>
  )
}

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
  readonly generateConfig: SelectedGuideModelConfig
  readonly optimizeConfig: SelectedGuideModelConfig
}) => (
  <ProgressPipeline
    title="Preparing prompt candidates"
    intent={intent}
    items={generationProgressItems(recommendation)}
    activePhase={phase}
    detail={`Draft: ${guideModelLabel(generateConfig)} · Optimize: ${guideModelLabel(optimizeConfig)} · Selected profile: ${recommendation.ref}`}
  />
)

const wizardSteps: ReadonlyArray<{ readonly step: GuideWizardStep; readonly label: string }> = [
  { step: GuideWizardStep.Profile, label: "Profile" },
  { step: GuideWizardStep.PromptCandidates, label: "Prompt candidates" },
  { step: GuideWizardStep.Destination, label: "Destination" },
]

export const wizardBreadcrumbLabel = (index: number, label: string, complete: boolean): string =>
  `${complete ? `${resolveStatusSymbol(!isNoUnicode(), "success")} ` : ""}Step ${index + 1}: ${label}`

const WizardBreadcrumbs = ({ activeStep }: { readonly activeStep: GuideWizardStep }) => {
  const unicode = useUnicode()
  const activeIndex = wizardSteps.findIndex(({ step }) => step === activeStep)
  return (
    <Box paddingX={1} marginBottom={1}>
      {wizardSteps.map(({ step, label }, index) => {
        const active = step === activeStep
        const complete = index < activeIndex
        return (
          <React.Fragment key={step}>
            {index === 0 ? null : <Text dimColor> {resolveTerminalSymbol(unicode, "›", ">")} </Text>}
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

const promptReviewAugmentKey = (job: GuideAugmentJob | undefined): string => {
  if (job === undefined) return "a augment"
  if (job.status === "ready") return "a review and apply"
  return job.status === "failed" ? "a details" : "a watch"
}

const PromptReviewFooter = ({ editing }: { readonly editing: boolean }) => {
  const job = useContext(AugmentJobContext)
  return (
    <Text dimColor wrap="truncate-end">
      {editing
        ? "Type, paste, or Backspace edit · PgUp/PgDn review · Enter re-match · Esc discard edits"
        : `PgUp/PgDn review · ${promptReviewAugmentKey(job)} · e edit · Enter or Esc return`}
    </Text>
  )
}

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

/**
 * The prompt page with the running job above it. The strip is chrome: the page
 * below shrinks by its rows, so nothing overflows the terminal.
 */
const PromptReviewStage = ({
  textDraft,
  variant,
  editing,
  job,
}: {
  readonly textDraft: string
  readonly variant: GuideLongPromptVariant
  readonly editing: boolean
  readonly job: GuideAugmentJob | undefined
}) => {
  const chromeRows = useContext(ChromeRowsContext)
  return (
    <AugmentJobContext.Provider value={job}>
      <AugmentInline job={job} />
      <ChromeRowsContext.Provider value={chromeRows + augmentInlineRows(job)}>
        <PromptReview textDraft={textDraft} variant={variant} editing={editing} />
      </ChromeRowsContext.Provider>
    </AugmentJobContext.Provider>
  )
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
        height={Math.max(1, rows - 4)}
        startAtEnd
        cursor
      />
      <Text dimColor>Type your intent · Ctrl-G augment · PgUp/PgDn scroll · ↵ submit · Ctrl-C cancel</Text>
      <Text dimColor>Ctrl-R review committed and working-tree changes</Text>
    </Box>
  )
}

const AugmentChooser = ({ index, error }: { readonly index: number; readonly error?: string | undefined }) => (
  <Box flexDirection="column" paddingX={1}>
    {error === undefined ? null : <Text color="red">{error}</Text>}
    <Text bold color="cyan">
      Augment your prompt
    </Text>
    {augmentOptions.map((option, itemIndex) => (
      <Text key={option} bold={itemIndex === index} {...(itemIndex === index ? { color: "green" as const } : {})}>
        {itemIndex === index ? "❯ " : "  "}
        {augmentLabels[option].title}
        <Text dimColor> · {augmentLabels[option].detail}</Text>
      </Text>
    ))}
    <Text dimColor>↑/↓ or j/k select · ↵ run it · b back · q cancel</Text>
  </Box>
)

const optimizeTerminalBlockReason = (state: GuideUiState): string | undefined => {
  if (state.queue.entries.length > 0 || state.forks.length > 0) {
    return "A new agent in this terminal would close Guide. Finish or remove its queued jobs and forks first, or use a Herdr pane."
  }
  return undefined
}

const ReviewStage = ({ props, state, dispatch }: {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly dispatch: React.Dispatch<GuideUiAction>
}) => {
  const { rows, columns } = useGuideWindowSize()
  const { exit } = useApp()
  const services = useMemo(() => props.reviewServices ?? createGuideReviewServices({
    runner: props.runner, cwd: props.cwd, catalog: props.catalog,
    routing: props.routing,
    ...(props.reviewModelOverrides ? { modelOverrides: props.reviewModelOverrides } : {}),
    context: props.herdrAvailabilityProbe ? getHerdrContext(props.herdrEnv) : null,
  }), [props.reviewServices, props.runner, props.cwd, props.catalog, props.routing, props.reviewModelOverrides, props.herdrAvailabilityProbe, props.herdrEnv, state.reviewReturnStage])
  return <GuideReviewFlow
    services={services} rows={rows} columns={columns} originalIntent={state.originalIntent ?? state.intent} intent={state.intent}
    blockedReason={state.augmentJob === undefined ? undefined : "Finish or discard the pending augmentation first. Press Esc, then a."}
    terminalBlockedReason={optimizeTerminalBlockReason(state)}
    onBack={() => dispatch({ type: GuideUiActionType.ReviewBack })}
    onTerminal={(result) => exit(result)}
  />
}

/** Optimize launches carry their own composed `trx run --skill` command; the prompt is already in it. */
const optimizeLaunchResult = (launch: GuideOptimizeLaunch, cwd: string, herdrContext: HerdrContext | null): GuideUiResult => {
  const { profile, command, prompt } = launch
  if (launch.runner === GuideOptimizeRunner.CurrentTerminal)
    return { action: "current-terminal", profile, command, promptHandling: "argv", prompt, cwd }
  if (herdrContext === null) throw new Error("This placement requires Herdr.")
  return launch.runner === GuideOptimizeRunner.NewHerdrTab
    ? { action: "new-herdr-tab", profile, command, prompt, promptDelivery: "command", cwd, workspaceId: herdrContext.workspaceId }
    : { action: "herdr-worktree-create", profile, command, prompt, promptDelivery: "command",
        primaryCheckoutPath: launch.primaryCheckoutPath, branch: launch.branch, baseRef: launch.baseRef }
}

const OptimizeStage = ({ props, state, dispatch }: {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly dispatch: React.Dispatch<GuideUiAction>
}) => {
  const { rows, columns } = useGuideWindowSize()
  const { exit } = useApp()
  const herdrContext = props.herdrAvailabilityProbe ? getHerdrContext(props.herdrEnv) : null
  return <GuideOptimizeScreen
    catalog={props.catalog} cwd={props.cwd} runner={props.runner} herdrContext={herdrContext}
    model={props.routing.optimize} rows={rows} columns={columns} terminalBlockedReason={optimizeTerminalBlockReason(state)}
    {...(props.runOptimizeSdk === undefined ? {} : { runSdk: props.runOptimizeSdk })}
    {...(props.ensureOptimizeSkills === undefined ? {} : { ensureSkills: props.ensureOptimizeSkills })}
    onBack={() => dispatch({ type: GuideUiActionType.OptimizeBack })}
    onLaunch={(launch) => {
      try {
        exit(optimizeLaunchResult(launch, props.cwd, herdrContext))
      } catch (error) {
        dispatch({ type: GuideUiActionType.OptimizeBack })
        dispatch({ type: GuideUiActionType.InputRejected, message: describeGuideUiError(error) })
      }
    }}
  />
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

/** How many lines of a ready augmented prompt the watch screen previews. */
const augmentPreviewLines = 12

const goalRecoveryText = (job: GuideAugmentJob): string => {
  const answers = job.goalHistory.map(({ request, response }) => {
    if (request.kind === "question" && response.kind === "answer") {
      return `${request.question.question}\nYour answer: ${response.answer.answer}`
    }
    if (response.kind === "review" && response.review.decision === "revise") {
      return `Revision feedback: ${response.review.feedback}`
    }
    return "The previous draft was approved, but the run did not finish."
  })
  return [
    `Original prompt:\n${job.source}`,
    ...answers,
    ...(job.goalLastProposal === undefined ? [] : [`Last goal draft:\n${job.goalLastProposal.prompt}`]),
  ].join("\n\n")
}

const GoalAugmentResult = ({ job }: { readonly job: GuideAugmentJob }) => {
  const { rows, columns } = useGuideWindowSize()
  const failed = job.status === "failed"
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined)
  useInput((input, key) => {
    if (input !== "c" || key.ctrl || key.meta || key.super || key.hyper || key.eventType === "release") return
    if (failed || job.text === undefined) return
    try {
      copyTextToClipboard(job.text)
      setCopyNotice("Copied goal to clipboard.")
    } catch (error) {
      setCopyNotice(`Copy failed. ${describeGuideUiError(error)}`)
    }
  })
  const viewportProps = {
    width: Math.max(1, columns - 2),
    height: Math.max(1, rows - 7),
    resetKey: `${job.runId}-${job.status}`,
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={failed ? "red" : "green"}>{failed ? "Goal me failed" : "Goal me is ready"}</Text>
      <Text wrap="wrap">
        {failed ? job.errorMessage : "The prompt changed or another operation is active. Enter replaces the current prompt with this approved goal."}
      </Text>
      {failed ? <Text dimColor>Saved interview context. Retry uses it in a new session.</Text> : null}
      {failed ? (
        <ScrollableTextViewport value={goalRecoveryText(job)} startAtEnd={false} {...viewportProps} />
      ) : (
        <MarkdownTextViewport value={job.text ?? ""} {...viewportProps} />
      )}
      {copyNotice === undefined ? null : <Text color="green" wrap="truncate-end">{copyNotice}</Text>}
      <Text dimColor>
        {failed ? "r retry" : "Enter replace current prompt · c copy to clipboard"} · x discard interview · PgUp/PgDn scroll · Esc back
      </Text>
    </Box>
  )
}

/**
 * The augment watch screen: one screen for all three states of a background
 * job. `Esc` always leaves it running, so this is somewhere you look, never
 * somewhere you wait.
 */
const AugmentWatch = ({ job }: { readonly job: GuideAugmentJob | undefined }) => {
  if (job === undefined) return null
  if (job.kind === GuideAugmentKind.GoalMe && job.status !== "running") return <GoalAugmentResult job={job} />
  if (job.status === "failed") {
    return (
      <Box flexDirection="column">
        <ErrorPanel
          title={`${augmentLabels[job.kind].title} failed`}
          message={job.errorMessage}
          keys="r retry · x discard · Esc back · q cancel"
        />
        {/* The last output the run produced is what explains the failure, so it stays on screen. */}
        <AugmentActivity title="Last output" lines={job.log} />
      </Box>
    )
  }
  if (job.status === "ready") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="green">
          ✓ {augmentLabels[job.kind].title} is ready
        </Text>
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={1}>
          {(job.text ?? "")
            .split("\n")
            .slice(0, augmentPreviewLines)
            .map((line, index) => (
              <Text key={`${index}-${line}`} wrap="truncate-end">
                {line}
              </Text>
            ))}
        </Box>
        <Text dimColor>↵ replace the prompt · x discard · Esc back · q cancel</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Spinner
        label={augmentRunningLabels[job.kind]}
        {...(job.phase === undefined ? {} : { detail: augmentPhaseLabels[job.phase] })}
        messages={["This can take several minutes", "Esc leaves it running in the background"]}
      />
      <Box flexDirection="column" paddingX={1}>
        <AugmentActivity title={augmentSourceLabels[job.kind]} lines={job.log} />
        {job.kind === GuideAugmentKind.GoalMe ? (
          <Text dimColor>{goalAutoAcceptHelp(job.goalAutoAcceptRecommended)}</Text>
        ) : null}
        <Text dimColor>
          {job.kind === GuideAugmentKind.GoalMe
            ? "Esc back · x discard interview · Ctrl-C exit and discard interview"
            : "Esc back · x stop · q cancel"}
        </Text>
      </Box>
    </Box>
  )
}

/** Rows the augment status line takes above a stage, for the chrome accounting. */
const augmentStatusRows = 1

/**
 * The status line is a reminder for screens that show nothing of the run. The
 * prompt page and the watch screen already show it, so it would only repeat
 * itself there.
 */
const showsAugmentStatusBar = (state: GuideUiState): boolean =>
  state.augmentJob !== undefined &&
  state.stage !== GuideUiStage.PromptReview &&
  state.stage !== GuideUiStage.Augmenting

/**
 * The one line that makes a background job visible from every screen. Without
 * it a running augmentation would be invisible the moment the user navigates
 * away from the watch screen.
 */
const AugmentStatusBar = ({ job }: { readonly job: GuideAugmentJob }) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  const title = augmentLabels[job.kind].title
  if (job.status === "running" && job.goalPanel !== undefined) {
    return (
      <Box paddingX={1}>
        <Text color="yellow" wrap="truncate-end">
          {job.goalPanel.request.kind === "review" ? "Goal me needs review" : "Goal me needs an answer"} · p then a to continue
        </Text>
      </Box>
    )
  }
  if (job.status === "ready") {
    return (
      <Box paddingX={1}>
        <Text color="green" wrap="truncate-end">
          ✓ {title} ready · p then a to apply
        </Text>
      </Box>
    )
  }
  if (job.status === "failed") {
    return (
      <Box paddingX={1}>
        <Text color="red" wrap="truncate-end">
          ✗ {title} failed · p then a for details
        </Text>
      </Box>
    )
  }
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text color="cyan">{spinnerFrameAt(tick)}</Text> {title}
        {job.phase === undefined ? "" : ` · ${augmentPhaseLabels[job.phase]}`}
        {job.goalAutoAcceptRecommended ? " · auto answers on" : ""} · p then a to watch
      </Text>
    </Box>
  )
}

/** Output lines the prompt page shows beside the prompt. */
const augmentInlineLogLines = 6

/** Rows the inline strip takes, so the prompt page shrinks by exactly that much. */
const augmentInlineRows = (job: GuideAugmentJob | undefined): number =>
  // Margin, both borders and the heading, on top of the output lines themselves.
  job === undefined ? 0 : job.status === "running" && job.goalPanel === undefined ? augmentInlineLogLines + 4 : 1

/**
 * A running augmentation, shown on the prompt page itself. Without it the page
 * looks unchanged while a multi-minute run works on the very prompt it shows.
 */
const AugmentInline = ({ job }: { readonly job: GuideAugmentJob | undefined }) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  if (job === undefined) return null
  const title = augmentLabels[job.kind].title
  if (job.status === "running" && job.goalPanel !== undefined) {
    return (
      <Text color="yellow">
        {job.goalPanel.request.kind === "review" ? "Goal me needs review" : "Goal me needs an answer"} · a to continue
      </Text>
    )
  }
  if (job.status === "ready") {
    return (
      <Box paddingX={1}>
        <Text color="green" wrap="truncate-end">
          ✓ {title} ready · a to review and apply it
        </Text>
      </Box>
    )
  }
  if (job.status === "failed") {
    return (
      <Box paddingX={1}>
        <Text color="red" wrap="truncate-end">
          ✗ {title} failed · a for details
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <AugmentActivity
        title={`${spinnerFrameAt(tick)} ${title}${job.phase === undefined ? "" : ` · ${augmentPhaseLabels[job.phase]}`}`}
        lines={job.log.length === 0 ? [""] : job.log}
        height={augmentInlineLogLines}
      />
    </Box>
  )
}

const launcherHarnessLabels: Readonly<Record<string, string>> = {
  codex: "Codex",
  copilot: "Copilot",
  claude: "Claude",
  jcode: "Junie",
  omp: "OpenCode",
  pi: "Pi",
  prime: "Prime",
}

const titleCaseIdentifier = (value: string): string =>
  value
    .split(/[-_]+/u)
    .map((part) => (part.length === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ")

const recommendationHarness = (recommendation: GuideRecommendation): string =>
  launcherHarnessLabels[recommendation.harness] ?? titleCaseIdentifier(recommendation.harness)

const recommendationLabel = (recommendation: GuideRecommendation): string => {
  const label = recommendation.profiles.join(" + ")
  if (recommendation.profiles.length === 1 && recommendation.profiles[0] === "pstack") return "Poteto Mode"
  if (recommendation.profiles.length === 1 && recommendation.profiles[0] === "hve") {
    return recommendation.harness === "codex" ? "HVE Core" : `${recommendationHarness(recommendation)} HVE`
  }
  return titleCaseIdentifier(label)
}

const recommendationConfidence = (recommendation: GuideRecommendation): string =>
  `${(recommendation.confidence * 100).toFixed(0)}%`

const RecommendationRail = ({
  recommendations,
  index,
  compact,
}: {
  readonly recommendations: ReadonlyArray<GuideRecommendation>
  readonly index: number
  readonly compact: boolean
}) => (
  <Box flexDirection="column" width={30} borderStyle="single" borderColor="gray" paddingX={1}>
    <Text bold>RECOMMENDATIONS</Text>
    {recommendations.map((recommendation, itemIndex) => {
      const active = itemIndex === index
      return (
        <Box key={recommendation.ref} flexDirection="column" marginTop={compact ? 0 : 1}>
          <Text bold={active} {...(active ? { color: "green" as const } : {})}>
            {active ? "❯ " : "  "}
            {recommendationLabel(recommendation)}
          </Text>
          {compact ? null : (
            <>
              <Text dimColor>
                {recommendationHarness(recommendation)} | {recommendationConfidence(recommendation)}
              </Text>
              <Text dimColor wrap="truncate-end">
                {recommendation.workflow.id}
              </Text>
            </>
          )}
        </Box>
      )
    })}
  </Box>
)

const RecommendationDetail = ({ recommendation, controllerLabel }: {
  readonly recommendation: GuideRecommendation
  readonly controllerLabel?: string
}) => {
  const harness = recommendationHarness(recommendation)
  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
      <Text bold color="cyan">
        {recommendationLabel(recommendation)}
      </Text>
      <Text dimColor>
        {recommendation.ref} | {harness} | {recommendationConfidence(recommendation)}
        {controllerLabel === undefined ? "" : ` | ${controllerLabel}`}
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
        Skill: {recommendation.workflow.skill ?? "none"} | Headless prompt: {recommendation.headless.prompt ? "yes" : "no"} | Herdr:{" "}
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

const PinnedLenses = ({ lenses }: { readonly lenses: ReadonlyArray<GuidePinnedLens> }) => {
  const direct = lenses.filter(({ decision }) => !decision)
  const entries = [
    ...(lenses.some(({ decision }) => decision) ? [{ id: "decide", text: `🧭 ${guideDecideKey} Decide…` }] : []),
    ...direct.map((lens) => ({ id: lens.kind, text: `${lens.emoji} ${lens.key} ${lens.label}` })),
    { id: "optimize", text: "o Optimize repository" },
  ]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>PINNED LENSES</Text>
      <Text>
        {entries.map(({ id, text }, index) => (
          <Text key={id} bold color="magenta">
            {index === 0 ? "" : " · "}{text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

const DecideChooser = ({ lenses }: { readonly lenses: ReadonlyArray<GuidePinnedLens> }) => (
  <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
    <Text bold color="magenta">DECIDE — how should this decision be made?</Text>
    {lenses.map((lens) => (
      <Text key={lens.kind}>
        <Text bold color="magenta">{lens.key}</Text> {lens.emoji} <Text bold>{lens.label}</Text>
        <Text dimColor> — {lens.description}</Text>
      </Text>
    ))}
    <Text dimColor>{lenses.map(({ key }) => key).join("/")} choose · Esc or b back · q cancel</Text>
  </Box>
)

const RecommendationsView = ({
  pinnedLenses,
  intent,
  model,
  effort,
  execution,
  fallback,
  recommendations,
  index,
  usedLiteralFallback,
  decideChooserOpen,
  goal,
  controllerLabel,
}: {
  readonly pinnedLenses: ReadonlyArray<GuidePinnedLens>
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly execution: GuideMatchExecution | undefined
  readonly fallback: GuideMatcherFallback | undefined
  readonly recommendations: ReadonlyArray<GuideRecommendation>
  readonly index: number
  readonly usedLiteralFallback: boolean
  readonly decideChooserOpen: boolean
  readonly goal?: PreparedGuideGoal
  readonly controllerLabel?: string
}) => {
  const { rows } = useGuideWindowSize()
  const compact = rows < 36
  const recommendation = recommendationAt(recommendations, index)
  const metrics = promptReviewMetrics(intent)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Profile recommendations
      </Text>
      <Text dimColor>
        {goal === undefined
          ? `Prompt: ${metrics.characters.toLocaleString("en")} chars · ${metrics.words.toLocaleString("en")} words`
          : `Goal: ${goal.draft.criteria.length} approved criteria`} ·{" "}
        {usedLiteralFallback ? "Literal matching" : matchExecutionLabel(execution, model, effort)}
      </Text>
      {usedLiteralFallback ? <Text color="yellow">Deterministic literal match (no model call).</Text> : <MatchFallbackNotice fallback={fallback} />}
      <PinnedLenses lenses={pinnedLenses} />
      {decideChooserOpen ? <DecideChooser lenses={pinnedLenses.filter(({ decision }) => decision)} /> : null}
      <Box marginTop={1}>
        <RecommendationRail recommendations={recommendations} index={index} compact={compact} />
        <RecommendationDetail recommendation={recommendation} {...(controllerLabel === undefined ? {} : { controllerLabel })} />
      </Box>
      <Text dimColor>
        {compact
          ? "↑/↓ or j/k select · ↵ generate · p view prompt · q cancel"
          : `↑/↓ or j/k select · ↵ generate · p view prompt${pinnedLenses.length === 0 ? "" : ` · ${[...new Set(pinnedLenses.map((lens) => lens.decision ? guideDecideKey : lens.key))].join("/")} lenses`} · o Optimize · q cancel`}
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
          Prompt{candidate.goalExecution === undefined ? "" : ` · ${guideGoalControllerLabel(candidate.goalExecution.controller)}`}
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
  templateFallback,
  command,
}: {
  readonly candidates: Triple<GuideGenerateCandidate>
  readonly index: number
  readonly templateFallback: GuideTemplateFallback | undefined
  readonly command: PublicGuideCommand
}) => {
  const { rows, columns: terminalColumns } = useGuideWindowSize()
  const fallbackNotice = templateFallback === undefined ? undefined : [
    templateFallback.kind === "validation"
      ? "Using template candidates: generated output failed workflow validation."
      : "Using template candidates you selected after generation failed.",
    ...(templateFallback.reason === undefined ? [] : [templateFallback.reason]),
  ].join("\n")
  const fallbackRows = fallbackNotice === undefined ? 0 : wrapGuideText(fallbackNotice, Math.max(1, terminalColumns - 2)).length
  const paneHeight = Math.max(1, candidatePaneHeight(rows) - fallbackRows)
  const railWidth = candidateRailWidth(terminalColumns)
  const candidate = tripleAt(candidates, index)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Prompt candidates
      </Text>
      {fallbackNotice === undefined ? null : <Text color="yellow">{fallbackNotice}</Text>}
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
        {command.promptHandling === "manual-paste"
          ? candidate.goalExecution === undefined ? " (manual paste required)" : " (native goal input required)"
          : ""}
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
  maximum,
  errorMessage,
}: {
  readonly title: string
  readonly textDraft: string
  readonly keys: string
  readonly maximum?: number
  readonly errorMessage?: string
}) => {
  const { rows, columns } = useGuideWindowSize()
  const errorRows = errorMessage === undefined ? 0 : wrapGuideText(errorMessage, Math.max(1, columns - 2)).length
  return (
    <Box flexDirection="column" height={Math.max(3, rows - 3)} overflowY="hidden" paddingX={1}>
      <Text bold color="cyan">
        {title}{maximum === undefined ? "" : ` (${textCharacterLength(textDraft)}/${maximum})`}
      </Text>
      {errorMessage === undefined ? null : <Text color="red">{errorMessage}</Text>}
      <ScrollableTextViewport
        value={textDraft}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - 5 - errorRows)}
        startAtEnd
        cursor
      />
      <Text dimColor>{keys} · PgUp/PgDn scroll</Text>
    </Box>
  )
}

const goalChangeCopy = (change: GuideGoalChange | undefined): { readonly title: string; readonly message: string } =>
  change?.kind === "profile"
    ? {
        title: "This workflow cannot execute the goal",
        message: `${change.reason} You can use this profile as a normal prompt flow. The main goal and queued jobs stay unchanged.`,
      }
    : {
        title: "Review goal changes",
        message: "This text is not the approved goal. Revise and approve the goal, use the text as a normal prompt, or keep the approved goal.",
      }

const GoalChangeView = ({ state }: { readonly state: GuideUiState }) => {
  const { rows, columns } = useGuideWindowSize()
  const change = state.goalChange
  const { title, message } = goalChangeCopy(change)
  const messageRows = wrapGuideText(message, Math.max(1, columns - 2)).length
  const errorRows = state.errorMessage === undefined ? 0 : wrapGuideText(state.errorMessage, Math.max(1, columns - 2)).length
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">{title}</Text>
      <Text>{message}</Text>
      {state.errorMessage === undefined ? null : <Text color="red">{state.errorMessage}</Text>}
      <MarkdownTextViewport
        value={change?.kind === "prompt" ? change.text : guideProfileGoal(state)?.prompt ?? ""}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - messageRows - errorRows - 5)}
        resetKey={change?.kind ?? "goal-change"}
      />
      <Text dimColor>
        {change?.kind === "prompt" ? "g revise goal · " : ""}n use normal prompt · b/Esc keep goal
        {state.augmentJob === undefined ? "" : " · a view active augmentation"} · q cancel
      </Text>
    </Box>
  )
}

const DestinationView = ({
  options,
  index,
  commandPreview,
  manualGoal = false,
  goalPrompt = false,
  customerPrompt = false,
  interactiveWorkflow = false,
}: {
  readonly options: ReadonlyArray<GuideUiDestination>
  readonly index: number
  readonly commandPreview: string
  readonly manualGoal?: boolean
  readonly goalPrompt?: boolean
  readonly customerPrompt?: boolean
  readonly interactiveWorkflow?: boolean
}) => {
  const { rows, columns } = useGuideWindowSize()
  return (
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
    {customerPrompt ? <MarkdownTextViewport
      value={`Command: ${commandPreview}`}
      width={Math.max(1, columns - 2)}
      height={Math.max(1, rows - options.length - 6)}
      resetKey={commandPreview}
    /> : <Text dimColor wrap={goalPrompt ? "truncate-end" : "wrap"}>
      Command: {goalPrompt ? compactCommandPreview(commandPreview) : commandPreview}
    </Text>}
    {manualGoal ? <Text color="yellow">Native goal input is required after the session starts.</Text> : null}
    <Text dimColor>
      {interactiveWorkflow
        ? "↑/↓ select · Enter launch directly · PgUp/PgDn command · c print prompt · b back"
        : "↑/↓ or j/k select · ↵ queue it · L launch all · c print prompt · b back"}
    </Text>
  </Box>
  )
}

/** `copilot · council`. */
const describeJobRunner = (profile: SelectedProfile): string =>
  `${profile.harness} · ${profile.profiles.join(" + ")}${profile.agent === undefined ? "" : ` · ${profile.agent}`}`

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
      {job.goalExecution === undefined ? null : <Text color="yellow">
        {" · "}{guideGoalControllerLabel(job.goalExecution.controller)}
        {job.promptDelivery === "manual" ? " (needs input)" : ""}
      </Text>}
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
      {compactCommandPreview(renderCommandPreview(job.command))}
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

const queuePlacementOptions = (_state: GuideUiState): ReadonlyArray<{
  readonly label: string
  readonly action: GuideUiAction
  readonly requiresHerdr: boolean
}> => [
  { label: "Pane in this Herdr workspace", action: { type: GuideUiActionType.QueuePlacementHere }, requiresHerdr: true },
  { label: "Herdr worktree", action: { type: GuideUiActionType.QueuePlacementStartWorktree }, requiresHerdr: true },
]

const QueuePlacementView = ({ state }: { readonly state: GuideUiState }) => {
  const options = queuePlacementOptions(state)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Where does this queued job run?
      </Text>
      {options.map(({ label }, itemIndex) => (
        <Text key={label} bold={itemIndex === state.destinationIndex} {...(itemIndex === state.destinationIndex ? { color: "green" as const } : {})}>
          {itemIndex === state.destinationIndex ? "❯ " : "  "}
          {label}
        </Text>
      ))}
      {state.errorMessage === undefined ? null : <Text color="yellow">{state.errorMessage}</Text>}
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

const refreshCatalogAfterMatchFailure = async (
  props: GuideUiProps,
  signal: AbortSignal,
): Promise<boolean> => {
  if (props.resolveCatalog === undefined) return true
  try {
    await props.resolveCatalog(signal)
    return true
  } catch {
    return !signal.aborted
  }
}

const dispatchGuideMatchSuccess = (response: GuideMatchResponse, dispatch: GuideUiDispatch): void => {
  dispatch({
    type: GuideUiActionType.MatchSucceeded,
    recommendations: response.recommendations,
    ...(response.execution === undefined ? {} : { execution: response.execution }),
    ...(response.fallback === undefined ? {} : { fallback: response.fallback }),
  })
}

const useGuideMatchEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (state.stage !== GuideUiStage.Matching) return undefined
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await runGuideMatchingStep(
          props.provider,
          props.catalog,
          {
            intent: state.intent ?? "",
            model: props.routing.match.model,
            effort: props.routing.match.effort,
            ...(state.goal === undefined ? {} : { goal: state.goal }),
          },
          (phase) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.MatchProgress, phase })
          },
          props.cache,
          {
            ...(props.matcher === undefined ? {} : { matcher: props.matcher }),
            ...(props.resolveCatalog === undefined ? {} : { resolveCatalog: props.resolveCatalog }),
            signal: controller.signal,
            onAttempt: (attempt) => {
              if (!cancelled) dispatch({ type: GuideUiActionType.MatchAttempt, ...attempt })
            },
          },
        )
        if (!cancelled) dispatchGuideMatchSuccess(response, dispatch)
      } catch (error) {
        if (cancelled) return
        if (!(await refreshCatalogAfterMatchFailure(props, controller.signal)) || cancelled) return
        dispatch({ type: GuideUiActionType.MatchFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [state.stage, state.intent, state.goal?.fingerprint, state.goalRevision, props.matcher, props.resolveCatalog])
}

const useGuideGenerationEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  const intent = state.selectedIntent ?? state.intent
  useEffect(() => {
    if (
      state.stage !== GuideUiStage.Generating ||
      state.selectedRecommendation === undefined ||
      intent === undefined
    ) {
      return undefined
    }
    let cancelled = false
    const recommendation = state.selectedRecommendation
    void (async () => {
      try {
        const { candidates, templateFallback } = await runGuideGenerationStep(
          props.catalog,
          props.guideRoot,
          props.provider.withModelObserver?.((phase, config) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.ModelSelected, phase, config })
          }) ?? props.provider,
          intent,
          recommendation,
          (guideDocument) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.GenerateGuideLoaded, guideDocument })
          },
          (phase) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.GenerateProgress, phase })
          },
          props.cache,
          state.selectedGoal ?? guideUiTaskContext(state),
          (input) => jevShouldSkipPromptOptimization(input, intent, { cwd: props.cwd }),
        )
        if (!cancelled) {
          dispatch({
            type: templateFallback
              ? GuideUiActionType.GenerateTemplateFallback
              : GuideUiActionType.GenerateSucceeded,
            candidates,
            ...(templateFallback?.reason === undefined ? {} : { reason: templateFallback.reason }),
          })
        }
      } catch (error) {
        if (!cancelled) dispatch({ type: GuideUiActionType.GenerateFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage, intent, state.selectedGoal?.fingerprint, state.selectedRecommendation, state.intent, state.selectedOriginalIntent])
}

const useGuideRefinementEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  const intent = state.selectedIntent ?? state.intent
  useEffect(() => {
    if (
      state.stage !== GuideUiStage.Refining ||
      state.selectedRecommendation === undefined ||
      state.guideDocument === undefined ||
      state.candidates === undefined ||
      intent === undefined
    ) {
      return undefined
    }
    let cancelled = false
    const recommendation = state.selectedRecommendation
    const guideDocument = state.guideDocument
    const candidates = state.candidates
    const candidateIndex = state.candidateIndex
    const feedback = state.textDraft
    void (async () => {
      try {
        const refinedCandidate = await runGuideRefinementStep(
          props.catalog,
          props.provider.withModelObserver?.((phase, config) => {
            if (!cancelled) dispatch({ type: GuideUiActionType.ModelSelected, phase, config })
          }) ?? props.provider,
          intent,
          recommendation,
          guideDocument,
          candidates,
          candidateIndex,
          feedback,
          props.cache,
          state.selectedGoal ?? guideUiTaskContext(state),
          (input) => jevShouldSkipPromptOptimization(input, intent, { cwd: props.cwd }),
        )
        if (!cancelled) dispatch({ type: GuideUiActionType.RefineSucceeded, candidate: refinedCandidate })
      } catch (error) {
        if (!cancelled) dispatch({ type: GuideUiActionType.RefineFailed, message: describeGuideUiError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state.stage, intent, state.selectedGoal?.fingerprint, state.selectedRecommendation, state.intent, state.selectedOriginalIntent])
}

const useGuideReadinessEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): void => {
  useEffect(() => {
    if (state.stage !== GuideUiStage.CheckingReadiness || state.selectedProfile === undefined) return undefined
    let cancelled = false
    const abort = new AbortController()
    const selectedProfile = state.selectedProfile
    void (async () => {
      try {
        const result = await checkSelectedProfileReadiness(
          props.runner, selectedProfile, props.cwd, abort.signal, state.selectedCandidate?.goalExecution, props.goalReadinessServices,
        )
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
  }, [
    state.stage,
    state.selectedProfile,
    state.selectedCandidate?.goalExecution,
    props.runner,
    props.cwd,
    props.goalReadinessServices,
    dispatch,
  ])
}

type GuideGoalSubmit = (request: GuideGoalRequest, response: GuideGoalResponse) => void

const runAugmentJob = async (
  props: GuideUiProps,
  job: GuideAugmentJob,
  context: GuideAugmentContext,
  interactions: GuideGoalInteractionController | undefined,
): Promise<string> => {
  switch (job.kind) {
    case GuideAugmentKind.CustomerContext:
      throw new Error("Customer preparation is local and requires explicit review, not a background provider")
    case GuideAugmentKind.Research:
      return runResearchAugment(job.source, props.catalog, context)
    case GuideAugmentKind.Codebase:
      return runCodebaseAugment(job.source, props.provider, context)
    case GuideAugmentKind.Firstmate:
      return runFirstmateAugment(job.source, props.provider, context)
    case GuideAugmentKind.GoalMe: {
      if (props.goalProvider === undefined || interactions === undefined) {
        throw new GuideGoalError("Goal me is not configured. Start the guide through an updated trx installation.")
      }
      context.onPhase(GuideAugmentPhase.GoalInterview)
      const text = await props.goalProvider.augment(
        {
          intent: job.source,
          history: job.goalHistory,
          ...(job.goalLastProposal === undefined ? {} : { lastProposal: job.goalLastProposal }),
        },
        { signal: context.signal, interactions, onActivity: context.onActivity },
      )
      return validateGuideGoalPrompt(text)
    }
  }
}

/**
 * Runs the background augmentation. It is keyed on the job, not the stage, so
 * navigating away never abandons the child process; only discarding the job or
 * leaving the app aborts it.
 */
const useGuideAugmentEffect = (props: GuideUiProps, state: GuideUiState, dispatch: GuideUiDispatch): GuideGoalSubmit => {
  const controllerRef = useRef<GuideGoalInteractionController | undefined>(undefined)
  const job = state.augmentJob
  const runId = job?.runId
  const running = job?.status === "running" && job.kind !== GuideAugmentKind.CustomerContext
  const autoAcceptRecommended = job?.goalAutoAcceptRecommended ?? false
  useEffect(() => {
    if (job === undefined || runId === undefined || !running) return undefined
    let cancelled = false
    const abort = new AbortController()
    const controller = job.kind === GuideAugmentKind.GoalMe ? new GuideGoalInteractionController({
      runId,
      signal: abort.signal,
      onRequest: (request) => {
        if (!cancelled) dispatch({ type: GuideUiActionType.AugmentGoalRequest, runId, request })
      },
      onTurn: (turn) => {
        if (!cancelled) dispatch({ type: GuideUiActionType.AugmentGoalTurn, runId, turn })
      },
    }) : undefined
    controllerRef.current = controller
    void (async () => {
      const context: GuideAugmentContext = {
        runner: props.runner,
        cwd: props.cwd,
        signal: abort.signal,
        onPhase: (phase) => {
          if (!cancelled) dispatch({ type: GuideUiActionType.AugmentProgress, runId, phase })
        },
        onActivity: (line) => {
          if (!cancelled) dispatch({ type: GuideUiActionType.AugmentOutput, runId, line })
        },
      }
      try {
        const text = await runAugmentJob(props, job, context, controller)
        if (!cancelled) dispatch({ type: GuideUiActionType.AugmentSucceeded, runId, text })
      } catch (error) {
        if (!cancelled)
          dispatch({ type: GuideUiActionType.AugmentFailed, runId, message: describeGuideUiError(error) })
      } finally {
        controller?.close()
        if (controllerRef.current === controller) controllerRef.current = undefined
      }
    })()
    return () => {
      cancelled = true
      abort.abort()
      controller?.close()
      if (controllerRef.current === controller) controllerRef.current = undefined
    }
  }, [runId, running])
  useEffect(() => {
    if (runId !== undefined && running) controllerRef.current?.setAutoAcceptRecommended(runId, autoAcceptRecommended)
  }, [runId, running, autoAcceptRecommended])
  return (request, response) => {
    try {
      controllerRef.current?.submit(request.runId, request.requestId, response)
    } catch (error) {
      dispatch({
        type: GuideUiActionType.AugmentGoalPanel,
        runId: request.runId,
        requestId: request.requestId,
        action: { type: "error", message: describeGuideUiError(error) },
      })
    }
  }
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
      try {
      const executed = await executeGuideBatch(batch, {
        runner: props.runner,
        write: () => {},
        ...(props.goalReadinessServices === undefined ? {} : {
          checkReadiness: (runner, profile, cwd, signal, goal) =>
            checkSelectedProfileReadiness(runner, profile, cwd, signal, goal, props.goalReadinessServices),
        }),
        onProgress: (event) => {
          if (!cancelled) dispatch({ type: GuideUiActionType.LaunchProgress, event })
        },
      })
      if (!cancelled) complete({ action: "batch", result: executed.result })
      } catch (cause) {
        if (!cancelled) dispatch({ type: GuideUiActionType.LaunchFailed, message: describeGuideUiError(cause) })
      }
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
  const deliver = useCallback<GuideUiDispatch>(
    (action) => dispatch({ type: GuideUiActionType.ForkDeliver, forkId, action: action as GuideUiAction }),
    [dispatch, forkId],
  )
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

const appendEditorInput = (
  state: GuideUiState,
  dispatch: GuideUiDispatch,
  input: string,
  maximum: number,
  type: GuideUiActionType.IntentChange | GuideUiActionType.PromptReviewChange | GuideUiActionType.EditorChange,
): void => {
  dispatch(isWithinTextBound(state.textDraft, input, maximum)
    ? { type, text: state.textDraft + input }
    : { type: GuideUiActionType.InputRejected, message: `Text exceeds ${maximum} characters. Nothing was added.` })
}

const handleIntentInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  // Checked before the printable branch: every other key on this screen is
  // text, so only a Ctrl chord can be a shortcut here.
  if (key.ctrl && input === "r") {
    if (state.textDraft.length === 0) dispatch({ type: GuideUiActionType.ReviewOpen })
    else dispatch({ type: GuideUiActionType.InputRejected, message: "Clear the draft before opening Review." })
  } else if (key.ctrl && input === "g") dispatch({ type: GuideUiActionType.AugmentOpen })
  else if (key.return) dispatch({ type: GuideUiActionType.IntentSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.IntentBackspace })
  else if (isPrintableInput(input, key)) {
    appendEditorInput(state, dispatch, input, guideIntentMaximumLength, GuideUiActionType.IntentChange)
  }
}

const handleAugmentInput: GuideInputHandler = ({ dispatch, cancel }, input, key) => {
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.AugmentMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.AugmentMove, delta: 1 })
  else if (key.return) dispatch({ type: GuideUiActionType.AugmentConfirm })
  else if (key.escape || input === "b") dispatch({ type: GuideUiActionType.AugmentBack })
  else if (input === "q") cancel()
}

/**
 * The watch screen never blocks: every key here either leaves the job running
 * or ends it on purpose.
 */
const goalAutomaticAnswerCommand = (state: GuideUiState, input: string, key: Key): GuideUiAction | undefined => {
  if (input !== "a" || key.ctrl || key.meta || key.super || key.hyper || key.eventType === "release") return undefined
  const job = state.augmentJob
  return job?.kind === GuideAugmentKind.GoalMe && job.status === "running" ? {
    type: GuideUiActionType.AugmentGoalAutoAccept,
    runId: job.runId,
    enabled: !job.goalAutoAcceptRecommended,
  } : undefined
}

const handleAugmentingInput: GuideInputHandler = ({ state, dispatch, cancel }, input, key) => {
  const automaticAnswer = goalAutomaticAnswerCommand(state, input, key)
  if (automaticAnswer !== undefined) {
    dispatch(automaticAnswer)
    return
  }
  if (key.escape || input === "b") dispatch({ type: GuideUiActionType.AugmentBack })
  else if (key.return && state.augmentJob?.status === "ready") dispatch({ type: GuideUiActionType.AugmentApply })
  else if (input === "r" && state.augmentJob?.status === "failed") dispatch({ type: GuideUiActionType.AugmentRetry })
  else if (input === "x") dispatch({ type: GuideUiActionType.AugmentDiscard })
  else if (input === "q") cancel()
}

const handleGoalChangeInput: GuideInputHandler = ({ state, dispatch, cancel }, input, key) => {
  if (input === "g") dispatch({ type: GuideUiActionType.GoalChangeRevise })
  else if (input === "n") dispatch({ type: GuideUiActionType.GoalChangeDetach })
  else if (input === "b" || key.escape) dispatch({ type: GuideUiActionType.GoalChangeKeep })
  else if (input === "a" && state.augmentJob !== undefined) dispatch({ type: GuideUiActionType.AugmentOpen })
  else if (input === "q") cancel()
}

const handleMatchFailedInput: GuideInputHandler = ({ props, state, dispatch, cancel }, input) => {
  if (input === "a") {
    dispatch({ type: GuideUiActionType.AugmentOpen })
    return
  }
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
      recommendations: literalGuideRecommendations(props.catalog, state.intent, state.goal),
    })
  } catch (error) {
    dispatch({ type: GuideUiActionType.MatchLiteralFailed, message: describeGuideUiError(error) })
  }
}

const confirmPinnedGuideLens = ({ props, state, dispatch }: GuideInputContext, pinnedLens: GuidePinnedLens): void => {
  const goalUnavailableReason = goalRecommendationReason(props.catalog, guideProfileGoal(state), pinnedLens.recommendation)
  dispatch({
    type: GuideUiActionType.RecommendationsConfirm,
    selectedProfile: selectedProfileForPinnedLens(props.catalog, pinnedLens),
    recommendation: pinnedLens.recommendation,
    ...(goalUnavailableReason === undefined ? {} : { goalUnavailableReason }),
  })
}

const handleDecideChooserInput: GuideInputHandler = (context, input, key) => {
  const decisionLens = pinnedGuideLenses(context.props.catalog).find((lens) => lens.decision && lens.key === input)
  if (decisionLens !== undefined) confirmPinnedGuideLens(context, decisionLens)
  else if (key.escape || input === "b") context.dispatch({ type: GuideUiActionType.DecideClose })
  else if (input === "q") context.cancel()
}

const confirmCurrentRecommendation = ({ props, state, dispatch }: GuideInputContext): void => {
  const selection = guideProfileSelection(state)
  if (selection.recommendations === undefined || selection.recommendations.length === 0) return
  const recommendation = recommendationAt(selection.recommendations, selection.recommendationIndex)
  const goalUnavailableReason = goalRecommendationReason(props.catalog, guideProfileGoal(state), recommendation)
  dispatch({
    type: GuideUiActionType.RecommendationsConfirm,
    selectedProfile: selectedProfileFromCatalogRef(
      props.catalog,
      recommendation.ref,
      recommendation.workflowId,
    ),
    ...(goalUnavailableReason === undefined ? {} : { goalUnavailableReason }),
  })
}

const handleRecommendationNavigationInput: GuideInputHandler = (context, input, key) => {
  const { dispatch, cancel } = context
  if (key.upArrow || input === "k") dispatch({ type: GuideUiActionType.RecommendationsMove, delta: -1 })
  else if (key.downArrow || input === "j") dispatch({ type: GuideUiActionType.RecommendationsMove, delta: 1 })
  else if (key.return) confirmCurrentRecommendation(context)
  else if (input === "q") cancel()
}

const handleRecommendationsInput: GuideInputHandler = (context, input, key) => {
  const { props, state, dispatch } = context
  if (state.decideChooserOpen) {
    handleDecideChooserInput(context, input, key)
    return
  }
  if (input === "o") {
    dispatch({ type: GuideUiActionType.OptimizeOpen })
    return
  }
  if (input === "p") {
    dispatch({ type: GuideUiActionType.PromptReviewOpen })
    return
  }
  const lenses = pinnedGuideLenses(props.catalog)
  if (input === guideDecideKey && lenses.some(({ decision }) => decision)) {
    dispatch({ type: GuideUiActionType.DecideOpen })
    return
  }
  const pinnedLens = lenses.find((lens) => !lens.decision && lens.key === input)
  if (pinnedLens !== undefined) confirmPinnedGuideLens(context, pinnedLens)
  else handleRecommendationNavigationInput(context, input, key)
}

const handlePromptReviewInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (!state.promptReviewEditing) {
    if (input === "a") dispatch({ type: GuideUiActionType.AugmentOpen })
    else if (input === "e") dispatch({ type: GuideUiActionType.PromptReviewEdit, editing: true })
    else if (key.escape || key.return || input === "p" || input === "b") {
      dispatch({ type: GuideUiActionType.PromptReviewBack })
    }
    return
  }
  if (key.escape) dispatch({ type: GuideUiActionType.PromptReviewBack })
  else if (key.return) dispatch({ type: GuideUiActionType.PromptReviewSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.PromptReviewBackspace })
  else if (isPrintableInput(input, key)) {
    appendEditorInput(state, dispatch, input, guideIntentMaximumLength, GuideUiActionType.PromptReviewChange)
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
    (state.selectedIntent ?? state.intent) !== undefined
  ) {
    try {
      const prepared = guideUiPrompt(state)
      if (prepared === undefined) throw new Error("Template fallback requires a loaded selected workflow.")
      dispatch({
        type: GuideUiActionType.GenerateTemplateFallback,
        candidates: templateGuideCandidates(
          prepared.guide,
          state.selectedRecommendation.workflowId,
          state.selectedIntent ?? state.intent ?? "",
          state.selectedGoal ?? prepared.context,
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

export const buildGuideUiBatch = (
  state: GuideUiState,
  cwd: string,
  herdrContext: HerdrContext | null,
  herdrEnabled: boolean,
): GuideBatch => {
  if (state.queue.entries.length === 0) {
    throw new Error("Batch queue is empty.")
  }
  if (!herdrEnabled || herdrContext === null) {
    throw new Error("Herdr is unavailable for the selected destination. Use Herdr for queued jobs.")
  }
  return {
    jobs: state.queue.entries,
    context: {
      workspaceId: herdrContext.workspaceId,
      cwd: herdrContext.cwd ?? cwd,
      callerPaneId: herdrContext.paneId,
      ...(state.primaryCheckoutPath === undefined ? {} : { primaryCheckoutPath: state.primaryCheckoutPath }),
    },
  }
}

const launchQueue: GuideInputHandler = ({ state, dispatch, herdrContext, herdrEnabled, props }) => {
  try {
    dispatch({ type: GuideUiActionType.LaunchStart, batch: buildGuideUiBatch(state, props.cwd, herdrContext, herdrEnabled) })
  } catch (cause) {
    dispatch({ type: GuideUiActionType.InputRejected, message: describeGuideUiError(cause) })
  }
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

const completePrintedCandidate = (context: GuideInputContext, prompt: string): void => {
  try {
    context.complete(buildPrintResult(prompt))
  } catch (error) {
    context.dispatch({ type: GuideUiActionType.InputRejected, message: describeGuideUiError(error) })
  }
}

const handleCandidatesInput: GuideInputHandler = (context, input, key) => {
  const { state, dispatch, cancel } = context
  const action = candidateNavigationAction(input, key) ?? candidateCommandAction(state, input)
  if (action !== undefined) {
    dispatch(action)
    return
  }
  if (input === "c" && state.candidates !== undefined) {
    const candidate = tripleAt(state.candidates, state.candidateIndex)
    if (candidate.goalExecution !== undefined) context.complete(buildPrintResult(candidate.prompt, candidate.goalExecution))
    else completePrintedCandidate(context, candidate.prompt)
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
  else if (isPrintableInput(input, key)) {
    appendEditorInput(context.state, context.dispatch, input, maximum, GuideUiActionType.EditorChange)
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

const goalEditorMaximum = (state: GuideUiState): number => {
  const execution = state.stage === GuideUiStage.QueuePromptEditor
    ? state.queue.entries.find(({ id }) => id === state.queue.editingId)?.goalExecution
    : state.candidates === undefined ? undefined : tripleAt(state.candidates, state.candidateIndex).goalExecution
  return execution === undefined ? promptMaxLength : guideGoalApproachBudget(execution)
}

const handleDirectEditorInput: GuideInputHandler = (context, input, key) =>
  handleTextEditorInput(
    context,
    input,
    key,
    goalEditorMaximum(context.state),
    { type: GuideUiActionType.DirectEditSubmit },
    { type: GuideUiActionType.DirectEditBack },
  )

const handleQueuePromptEditorInput: GuideInputHandler = ({ state, dispatch }, input, key) => {
  if (key.escape) dispatch({ type: GuideUiActionType.QueueBack })
  else if (key.return) dispatch({ type: GuideUiActionType.QueueEditSubmit })
  else if (key.backspace || key.delete) dispatch({ type: GuideUiActionType.EditorBackspace })
  else if (isPrintableInput(input, key) && isWithinTextBound(state.textDraft, input, goalEditorMaximum(state))) {
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

const completeCustomerDestination = (context: GuideInputContext, option: GuideUiDestination): boolean => {
  const { state, props, herdrContext, dispatch, complete } = context
  const profile = state.selectedProfile
  const candidate = state.selectedCandidate
  if (profile?.interaction === undefined || candidate === undefined || herdrContext === null ||
      option === GuideUiDestination.NewHerdrWorktree) return false
  try {
    complete(option === GuideUiDestination.CurrentHerdrWorkspace
      ? buildCurrentHerdrWorkspaceResult(profile, candidate.prompt, props.cwd, herdrContext)
      : buildNewHerdrTabResult(profile, candidate.prompt, props.cwd, herdrContext))
  } catch (error) {
    dispatch({ type: GuideUiActionType.InputRejected, message: describeGuideUiError(error) })
  }
  return true
}

/** Ordinary Herdr work is queued; customer workflows use a direct handoff. */
const completeDestination = (context: GuideInputContext, option: GuideUiDestination): void => {
  const { state, props, herdrContext, dispatch, complete } = context
  const profile = state.selectedProfile
  const candidate = state.selectedCandidate
  if (profile === undefined || candidate === undefined) return
  if (option === GuideUiDestination.CurrentTerminal) {
    try {
      complete(buildCurrentTerminalResult(
        profile, candidate.prompt, props.cwd, candidate.goalExecution,
      ))
    } catch (error) {
      dispatch({ type: GuideUiActionType.InputRejected, message: describeGuideUiError(error) })
    }
    return
  }
  if (herdrContext === null) return
  if (completeCustomerDestination(context, option)) return
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
  const { state, dispatch, cancel, herdrEnabled, herdrContext } = context
  const options = destinationOptions(herdrEnabled, herdrContext?.surface)
  if (key.upArrow || input === "k")
    dispatch({ type: GuideUiActionType.DestinationMove, delta: -1, optionCount: options.length })
  else if (key.downArrow || input === "j")
    dispatch({ type: GuideUiActionType.DestinationMove, delta: 1, optionCount: options.length })
  else if (input === "c" && state.selectedCandidate !== undefined)
    if (state.selectedCandidate.goalExecution !== undefined) {
    context.complete(buildPrintResult(state.selectedCandidate.prompt, state.selectedCandidate.goalExecution))
    } else {
    completePrintedCandidate(context, state.selectedCandidate.prompt)
    }
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
    const option = queuePlacementOptions(state)[state.destinationIndex]
    if (option === undefined) return
    if (option.requiresHerdr && (!herdrEnabled || herdrContext === null)) {
      dispatch({ type: GuideUiActionType.QueuePlacementUnavailable })
    } else {
      dispatch(option.action)
    }
  }
}

const completeCustomerWorktree = (
  context: GuideInputContext,
  placement: Extract<JobPlacement, { readonly kind: "new-worktree" | "existing-worktree" }>,
  primaryCheckoutPath: string,
): boolean => {
  const { state, complete, dispatch } = context
  const profile = state.selectedProfile
  if (profile?.interaction === undefined) return false
  try {
    if (state.selectedCandidate === undefined) throw new Error("The customer prompt is missing; return to the candidate.")
    complete(placement.kind === "new-worktree"
      ? buildNewHerdrWorktreeResult(profile, state.selectedCandidate.prompt, primaryCheckoutPath, placement.branch, placement.baseRef)
      : buildExistingHerdrWorktreeResult(profile, state.selectedCandidate.prompt, primaryCheckoutPath, placement.path))
  } catch (error) {
    dispatch({ type: GuideUiActionType.InputRejected, message: describeGuideUiError(error) })
  }
  return true
}

const handleWorktreeCollisionInput: GuideInputHandler = (context, input, key) => {
  const { state, dispatch, cancel } = context
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
  const placement = { kind: "existing-worktree", path: inspection.collision.path } as const
  if (completeCustomerWorktree(context, placement, inspection.primaryCheckoutPath)) return
  dispatch({
    type: GuideUiActionType.QueuePlacementWorktree,
    placement,
    primaryCheckoutPath: inspection.primaryCheckoutPath,
  })
}

/** The fresh worktree after the dirty-checkout gate is cleared. */
const confirmedQueueWorktree = (
  state: GuideUiState,
): { readonly placement: Extract<JobPlacement, { readonly kind: "new-worktree" }>; readonly primaryCheckoutPath: string } | undefined => {
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

const handleWorktreeReadyInput: GuideInputHandler = (context, input, key) => {
  const { state, dispatch } = context
  if (key.escape) {
    dispatch({ type: GuideUiActionType.WorktreeBack })
    return
  }
  if (!key.return && input !== "y") return
  const confirmed = confirmedQueueWorktree(state)
  if (confirmed === undefined) dispatch({ type: GuideUiActionType.WorktreeConfirm })
  else if (!completeCustomerWorktree(context, confirmed.placement, confirmed.primaryCheckoutPath)) {
    dispatch({ type: GuideUiActionType.QueuePlacementWorktree, ...confirmed })
  }
}

const inputHandlerByStage: Record<GuideUiStage, GuideInputHandler> = {
  [GuideUiStage.Intent]: handleIntentInput,
  [GuideUiStage.Augment]: handleAugmentInput,
  [GuideUiStage.Augmenting]: handleAugmentingInput,
  [GuideUiStage.Matching]: handleMatchingInput,
  [GuideUiStage.MatchFailed]: handleMatchFailedInput,
  [GuideUiStage.Recommendations]: handleRecommendationsInput,
  [GuideUiStage.Review]: handleNoInput,
  [GuideUiStage.Optimize]: handleNoInput,
  [GuideUiStage.PromptReview]: handlePromptReviewInput,
  [GuideUiStage.GoalChange]: handleGoalChangeInput,
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
  state.stage !== GuideUiStage.GoalChange &&
  state.stage !== GuideUiStage.Review &&
  state.stage !== GuideUiStage.Optimize &&
  // The watch screen owns `x`: there it stops the job, never drops a fork tab.
  state.stage !== GuideUiStage.Augmenting &&
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

const hasRunningAugmentPanel = (state: GuideUiState): boolean =>
  state.stage === GuideUiStage.Augmenting &&
  state.augmentJob?.status === "running" &&
  (state.augmentJob.goalPanel !== undefined || state.augmentJob.customerPanel !== undefined)

const handleGuideInput = (context: GuideInputContext, input: string, key: Key): void => {
  if (context.state.stage === GuideUiStage.Review || context.state.stage === GuideUiStage.Optimize) return
  if (key.ctrl && input === "c") {
    context.cancel()
    return
  }
  // The mounted goal or customer panel owns ordinary keys, including answer text.
  if (hasRunningAugmentPanel(context.state)) return
  // The Decide chooser is modal: its digit keys (6 = Six Thinking Hats) must not switch fork tabs.
  if (context.state.stage === GuideUiStage.Recommendations && context.state.decideChooserOpen) {
    inputHandlerByStage[context.state.stage](context, input, key)
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
  if (state.stage === GuideUiStage.DirectEditor || state.stage === GuideUiStage.QueuePromptEditor) return goalEditorMaximum(state)
  return undefined
}

export const handleGuidePaste = (state: GuideUiState, dispatch: GuideUiDispatch, pasted: string): void => {
  const maximum = pastedEditorMaximum(state)
  if (maximum === undefined) return
  const normalized = pasted.replace(/\r\n?/gu, "\n").replace(pastedControlCharacters, "")
  if (!isWithinTextBound(state.textDraft, normalized, maximum)) {
    dispatch({ type: GuideUiActionType.InputRejected, message: `Pasted text exceeds ${maximum} characters. Nothing was truncated or added.` })
    return
  }
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
  readonly dispatch: GuideUiDispatch
  readonly submitGoal: GuideGoalSubmit
}

type GuideStageRenderer = (context: GuideRenderContext) => React.ReactElement

const GoalInteractionStage = ({
  panel,
  autoAcceptRecommended,
  dispatch,
  submitGoal,
}: {
  readonly panel: GuideGoalPanelState
  readonly autoAcceptRecommended: boolean
  readonly dispatch: GuideUiDispatch
  readonly submitGoal: GuideGoalSubmit
}) => {
  const { rows, columns } = useGuideWindowSize()
  return (
    <GuideGoalPanel
      state={panel}
      autoAcceptRecommended={autoAcceptRecommended}
      onSetAutoAcceptRecommended={(enabled) => dispatch({
        type: GuideUiActionType.AugmentGoalAutoAccept,
        runId: panel.request.runId,
        requestId: panel.request.requestId,
        enabled,
      })}
      rows={rows}
      columns={columns}
      onAction={(action) => dispatch({
        type: GuideUiActionType.AugmentGoalPanel,
        runId: panel.request.runId,
        requestId: panel.request.requestId,
        action,
      })}
      onSubmit={(response) => submitGoal(panel.request, response)}
      onPark={() => dispatch({ type: GuideUiActionType.AugmentBack })}
      onDiscard={() => dispatch({ type: GuideUiActionType.AugmentDiscard, runId: panel.request.runId })}
    />
  )
}

const renderAugmentWatch: GuideStageRenderer = ({ state, dispatch, submitGoal }) => {
  const job = state.augmentJob
  if (job?.kind === GuideAugmentKind.CustomerContext && job.customerPanel !== undefined) {
    return <CustomerInteractionStage job={job} panel={job.customerPanel} dispatch={dispatch} />
  }
  const panel = job?.goalPanel
  return job?.status === "running" && panel !== undefined
    ? <GoalInteractionStage panel={panel} autoAcceptRecommended={job.goalAutoAcceptRecommended} dispatch={dispatch} submitGoal={submitGoal} />
    : <AugmentWatch job={job} />
}

const CustomerInteractionStage = ({
  job, panel, dispatch,
}: {
  readonly job: GuideAugmentJob
  readonly panel: GuideCustomerPanelState
  readonly dispatch: GuideUiDispatch
}) => {
  const { rows, columns } = useGuideWindowSize()
  return <GuideCustomerPanel
    state={panel} source={job.source} rows={rows} columns={columns}
    onAction={(action) => dispatch({ type: GuideUiActionType.AugmentCustomerPanel, runId: job.runId, action })}
    onApprove={() => dispatch({ type: GuideUiActionType.AugmentCustomerApprove, runId: job.runId })}
    onDiscard={() => dispatch({ type: GuideUiActionType.AugmentDiscard, runId: job.runId })}
    onPark={() => dispatch({ type: GuideUiActionType.AugmentBack })}
  />
}

const matchingProgress = ({ props, state }: GuideRenderContext): React.ReactElement => (
  <MatchProgress
    catalog={props.catalog}
    phase={state.matchPhase ?? GuideMatchPhase.LoadingProfiles}
    intent={state.intent ?? ""}
    model={props.routing.match.model}
    effort={props.routing.match.effort}
    execution={state.matchExecution}
    fallback={state.matchFallback}
    profileCount={state.matchProfileCount}
  />
)

const renderRecommendations: GuideStageRenderer = (context) => {
  const { recommendations, recommendationIndex, usedLiteralFallback, execution, fallback } = guideProfileSelection(context.state)
  const goal = guideProfileGoal(context.state)
  if (recommendations === undefined) return matchingProgress(context)
  if (recommendations.length === 0) {
    return <ErrorPanel title="No compatible profiles" message="Edit the goal or choose a normal prompt flow." keys="o Optimize · p view prompt · q cancel" />
  }
  const selected = recommendationAt(recommendations, recommendationIndex)
  const controller = goal === undefined ? undefined : findCombinedCatalogEntry(context.props.catalog, selected.ref)?.entry.guide.goalExecution?.controller
  return (
    <RecommendationsView
      pinnedLenses={pinnedGuideLenses(context.props.catalog)}
      intent={guideProfileIntent(context.state) ?? ""}
      model={context.props.routing.match.model}
      effort={context.props.routing.match.effort}
      execution={execution}
      fallback={fallback}
      recommendations={recommendations}
      index={recommendationIndex}
      usedLiteralFallback={usedLiteralFallback}
      decideChooserOpen={context.state.decideChooserOpen}
      {...(goal === undefined ? {} : { goal })}
      {...(controller === undefined ? {} : { controllerLabel: guideGoalControllerLabel(controller) })}
    />
  )
}

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
        detail={`Refine: ${guideModelLabel(state.selectedModels.refine ?? props.routing.refine)} · Optimize: ${guideModelLabel(state.selectedModels.optimize ?? props.routing.optimize)}`}
      />
    )
  if (state.stage === GuideUiStage.RefineFailed)
    return <ErrorPanel title="Refinement failed" message={state.errorMessage} keys="r retry · b back" />
  if (state.stage === GuideUiStage.DirectEditor)
    return <TextEditor
      title={tripleAt(state.candidates, state.candidateIndex).goalExecution === undefined ? "Edit prompt" : "Edit approach (goal fixed)"}
      textDraft={state.textDraft}
      {...(tripleAt(state.candidates, state.candidateIndex).goalExecution === undefined ? {} : { maximum: goalEditorMaximum(state) })}
      {...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage })}
      keys="↵ submit · Esc back"
    />
  return (
    <CandidatesView
      candidates={state.candidates}
      index={state.candidateIndex}
      templateFallback={state.templateFallback}
      command={publicGuideLaunchCommand(
        props.catalog,
        state.selectedRecommendation.ref,
        tripleAt(state.candidates, state.candidateIndex).prompt,
        state.selectedRecommendation.workflowId,
        tripleAt(state.candidates, state.candidateIndex).goalExecution,
      )}
    />
  )
}

const destinationLaunchPreview = (state: GuideUiState, option: GuideUiDestination | undefined) => {
  const profile = state.selectedProfile
  if (profile === undefined) return undefined
  const candidate = state.selectedCandidate
  if (option === GuideUiDestination.CurrentTerminal) {
    return buildGuideLaunchCommand(profile, { mode: "argv", prompt: candidate?.prompt ?? "" }, candidate?.goalExecution)
  }
  return candidate?.goalExecution !== undefined || profile.interaction !== undefined
    ? buildHerdrGuideLaunch(profile, candidate?.prompt ?? "", candidate?.goalExecution)
    : buildGuideLaunchCommand(profile)
}

const renderDestination: GuideStageRenderer = ({ state, herdrEnabled, herdrContext }) => {
  const options = destinationOptions(herdrEnabled, herdrContext?.surface)
  const built = destinationLaunchPreview(state, options[state.destinationIndex])
  const manualGoal = state.selectedCandidate?.goalExecution !== undefined && built !== undefined &&
    ("promptHandling" in built ? built.promptHandling === "manual-paste" : built.promptDelivery === "manual")
  return (
    <DestinationView
      options={options}
      index={state.destinationIndex}
      commandPreview={built === undefined ? "" : renderCommandPreview(built.command)}
      manualGoal={manualGoal}
      goalPrompt={state.selectedCandidate?.goalExecution !== undefined}
      customerPrompt={state.selectedCustomerContext !== undefined || state.selectedProfile?.interaction !== undefined}
      interactiveWorkflow={state.selectedProfile?.interaction !== undefined}
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
  if (event.phase === "needs-input") return "!"
  return spinnerFrameAt(tick)
}

const launchRowColor = (event: GuideBatchProgressEvent | undefined): string => {
  if (event === undefined) return "gray"
  if (event.phase === "done") return "green"
  if (event.phase === "failed") return "red"
  if (event.phase === "needs-input") return "yellow"
  return "cyan"
}

const LaunchProgress = ({ state }: { readonly state: GuideUiState }) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])
  const jobs = state.launchBatch?.jobs ?? []
  const finished = state.launchProgress.filter((event) =>
    event.phase === "done" || event.phase === "failed" || event.phase === "needs-input",
  ).length
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        Launching {jobs.length} job{jobs.length === 1 ? "" : "s"} · {finished}/{jobs.length} finished
      </Text>
      {jobs.map((job) => {
        const event = state.launchProgress.find((entry) => entry.jobId === job.id)
        return (
          <Text key={job.id} wrap="wrap">
            <Text color={launchRowColor(event)}>{launchRowMarker(event, tick)}</Text> {job.id}. {job.profile.profiles.join("+")}
            {" · "}
            {describeJobPlacement(job.placement)} — {launchRowDetail(event)}
          </Text>
        )
      })}
      <Text dimColor>Every job runs in its own pane. The summary prints when all of them finish.</Text>
      {state.errorMessage === undefined ? null : (
        <Text color="yellow">Execution stopped: {state.errorMessage}</Text>
      )}
    </Box>
  )
}

const stageRenderer: Record<GuideUiStage, GuideStageRenderer> = {
  [GuideUiStage.Intent]: ({ state }) => <IntentEditor textDraft={state.textDraft} />,
  [GuideUiStage.Augment]: ({ state }) => <AugmentChooser index={state.augmentIndex} error={state.errorMessage} />,
  [GuideUiStage.Augmenting]: renderAugmentWatch,
  [GuideUiStage.Matching]: matchingProgress,
  [GuideUiStage.MatchFailed]: ({ state }) => (
    <ErrorPanel
      title="Match failed"
      message={state.errorMessage}
      keys="r retry · a augment prompt · l literal match · p view prompt · q cancel"
    />
  ),
  [GuideUiStage.Recommendations]: renderRecommendations,
  [GuideUiStage.Review]: ({ props, state, dispatch }) => <ReviewStage props={props} state={state} dispatch={dispatch} />,
  [GuideUiStage.Optimize]: ({ props, state, dispatch }) => <OptimizeStage props={props} state={state} dispatch={dispatch} />,
  [GuideUiStage.PromptReview]: ({ props, state }) => (
    <PromptReviewStage
      textDraft={state.textDraft}
      variant={props.uiVariant ?? GuideLongPromptVariant.Dashboard}
      editing={state.promptReviewEditing}
      job={state.augmentJob}
    />
  ),
  [GuideUiStage.GoalChange]: ({ state }) => <GoalChangeView state={state} />,
  [GuideUiStage.Generating]: ({ props, state }) =>
    state.selectedRecommendation === undefined || (state.selectedIntent ?? state.intent) === undefined ? (
      <Spinner label="Preparing prompt candidates" />
    ) : (
      <GenerationProgress
        recommendation={state.selectedRecommendation}
        phase={state.generationPhase ?? GuideGenerationPhase.LoadingProfile}
        intent={state.selectedIntent ?? state.intent ?? ""}
        generateConfig={state.selectedModels.generate ?? props.routing.generate}
        optimizeConfig={state.selectedModels.optimize ?? props.routing.optimize}
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
      keys="↵ submit · Esc back"
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
    <TextEditor
      title={state.queue.entries.find(({ id }) => id === state.queue.editingId)?.goalExecution === undefined ? "Edit queued prompt" : "Edit queued approach (goal fixed)"}
      textDraft={state.textDraft}
      {...(state.queue.entries.find(({ id }) => id === state.queue.editingId)?.goalExecution === undefined ? {} : { maximum: goalEditorMaximum(state) })}
      {...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage })}
      keys="↵ save · Esc back"
    />
  ),
  [GuideUiStage.Launching]: ({ state }) => <LaunchProgress state={state} />,
  [GuideUiStage.QueuePlacement]: ({ state }) => <QueuePlacementView state={state} />,
}

const inlineErrorStages: ReadonlySet<GuideUiStage> = new Set([
  GuideUiStage.Intent,
  GuideUiStage.PromptReview,
  GuideUiStage.Candidates,
  GuideUiStage.DirectEditor,
  GuideUiStage.RefineEditor,
  GuideUiStage.QueuePromptEditor,
  GuideUiStage.WorktreeBranchEditor,
  GuideUiStage.Destination,
  GuideUiStage.Recommendations,
  GuideUiStage.Matching,
  GuideUiStage.Generating,
])

interface GuideAppViewProps {
  readonly props: GuideUiProps
  readonly state: GuideUiState
  readonly herdrContext: HerdrContext | null
  readonly herdrEnabled: boolean
  readonly dispatch: GuideUiDispatch
  readonly submitGoal: ReturnType<typeof useGuideAugmentEffect>
  readonly inlineError: string | undefined
  readonly inlineErrorRows: number
}

const GuideAppView = ({
  props,
  state,
  herdrContext,
  herdrEnabled,
  dispatch,
  submitGoal,
  inlineError,
  inlineErrorRows,
}: GuideAppViewProps): React.ReactElement => {
  const activeWizardStep = wizardStepForStage(state.stage)
  return (
    <Box flexDirection="column">
      {herdrContext?.capture === undefined || state.stage === GuideUiStage.Review || state.stage === GuideUiStage.Optimize ? null : <CaptureSourceBanner capture={herdrContext.capture} />}
      {state.forks.map((fork) => {
        const slice = forkState(state, fork.id)
        return slice === undefined ? null : (
          <ForkWorker key={fork.id} props={props} state={slice} forkId={fork.id} dispatch={dispatch} />
        )
      })}
      {showsAugmentStatusBar(state) && state.augmentJob !== undefined ? (
        <AugmentStatusBar job={state.augmentJob} />
      ) : null}
      {state.forks.length === 0 ? null : <ForkTabBar state={state} />}
      <ChromeRowsContext.Provider
        value={(state.forks.length === 0 ? 0 : forkTabBarRows) + (showsAugmentStatusBar(state) ? augmentStatusRows : 0) + inlineErrorRows}
      >
        {activeWizardStep === undefined ? null : <WizardBreadcrumbs activeStep={activeWizardStep} />}
        {inlineError === undefined ? null : <Box paddingX={1}><Text color="yellow">Error: {inlineError}</Text></Box>}
        {stageRenderer[state.stage]({ props, state, herdrEnabled, herdrContext, dispatch, submitGoal })}
      </ChromeRowsContext.Provider>
    </Box>
  )
}

/**
 * The exported `trx guide` interactive UI. Side effects and stage-specific
 * input/render behavior are delegated to focused helpers.
 */
export const GuideApp = (props: GuideUiProps): React.ReactElement => {
  const { exit } = useApp()
  const [catalog, setCatalog] = useState(props.catalog)
  const resolveCatalog = useCallback(
    async (signal?: AbortSignal): Promise<CompositionCatalog> => {
      const refreshed = props.resolveCatalog === undefined ? props.catalog : await props.resolveCatalog(signal)
      signal?.throwIfAborted()
      setCatalog(refreshed)
      return refreshed
    },
    [props.catalog, props.resolveCatalog],
  )
  const effectiveProps = useMemo<GuideUiProps>(
    () => ({
      ...props,
      catalog,
      ...(props.resolveCatalog === undefined ? {} : { resolveCatalog }),
    }),
    [catalog, props, props.resolveCatalog, resolveCatalog],
  )
  const [state, dispatch] = useReducer(guideUiReducer, props.initialIntent, (intent) => createInitialGuideUiState(intent, props.openOptimize))
  const herdrContext = getHerdrContext(effectiveProps.herdrEnv)
  const herdrEnabled = herdrContext !== null && effectiveProps.herdrAvailabilityProbe
  const { columns } = useWindowSize()
  const inlineError = inlineErrorStages.has(state.stage) ? state.errorMessage : undefined
  const inlineErrorRows = inlineError === undefined ? 0 : wrapGuideText(`Error: ${inlineError}`, Math.max(1, columns - 2)).length
  const complete = (result: GuideUiResult): void => exit(result)
  const cancel = (): void => complete(buildCancelResult())

  // The main screen owns only its own async work; each fork's runs in its own
  // ForkWorker below, so parking a fork never abandons the call it started.
  const mainState = state.activeForkId === undefined ? state : { ...state, ...mainForkSlice }
  const submitGoal = useGuideAugmentEffect(effectiveProps, mainState, dispatch)
  useGuideMatchEffect(effectiveProps, mainState, dispatch)
  useGuideGenerationEffect(effectiveProps, mainState, dispatch)
  useGuideRefinementEffect(effectiveProps, mainState, dispatch)
  useGuideReadinessEffect(effectiveProps, mainState, dispatch)
  useGuideWorktreeEffect(effectiveProps, mainState, dispatch)
  useGuideLaunchEffect(effectiveProps, mainState, dispatch, complete)

  const inputContext: GuideInputContext = {
    props: effectiveProps,
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

  return (
    <GuideAppView
      props={effectiveProps}
      state={state}
      herdrContext={herdrContext}
      herdrEnabled={herdrEnabled}
      dispatch={dispatch}
      submitGoal={submitGoal}
      inlineError={inlineError}
      inlineErrorRows={inlineErrorRows}
    />
  )
}
