import { randomUUID } from "node:crypto"
import path from "node:path"
import {
  buildHerdrGuideLaunch,
  buildGuideLaunchCommand,
  createHerdrTab,
  createHerdrWorktree,
  launchInHerdrPaneAndPrompt,
  openHerdrWorktree,
  parseSelectedProfile,
  sameGuideCommand,
  splitHerdrPane,
  type CommandRunner,
  type CommandSpec,
  type HerdrLaunchPhase,
  type HerdrPromptDeliveryMode,
  type HerdrSplitDirection,
  type SelectedProfile,
  type TimeController,
} from "./guide-launch.ts"
import { checkSelectedProfileReadiness, ProfilePreflightError, ProfileReadinessKind } from "./guide-preflight.ts"
import { composeGuideGoalCandidate, guideGoalPromptMaximumLength, type GuideGoalCandidateContext } from "./guide-goal-execution.ts"
import { freezeGuideGoalCandidateContext, guideGoalInputInstructions } from "./guide-goal-transport.ts"
import { GuideGoalError } from "./guide-goal-augment.ts"
import type {
  FirstmateFleetIdentityV1,
  FirstmateFleetReadinessV1,
  FirstmateSubmissionReceiptV1,
  FirstmateSubmissionRequestV1,
  GuideProjectTargetV1,
  ProfileGuideWorkflow,
} from "@trellage/guide-core"
import {
  createFirstmateJournalFactory,
  scopeFirstmateJournal,
  type FirstmateJournalFactory,
  type FirstmateJournalEntry,
  type FirstmateSubmissionJournal,
} from "./guide-firstmate-journal.ts"
import { executeFirstmateBatchGroup, isFirstmateBatchJob, type FirstmateBatchItem } from "./guide-firstmate-batch.ts"
import {
  completeSinglePromptArtifact, guideModelBodyCandidate, validateLegacyFirstmateArtifact,
  type GuideLegacyFirstmateContext, type GuideTaskContext,
} from "./guide-context.ts"
import { firstmateSupervisorStatusText } from "./guide-firstmate.ts"
import { validateFirstmateTerminalHandoff, type FirstmateTerminalHandoff } from "./guide-firstmate-terminal.ts"
import { renderWorkflowBodyCandidate, validateFinalGuideCandidate } from "./guide-workflow-prompt.ts"
import { selectedFirstmateInstance } from "./guide-firstmate-instance-selection.ts"
import { firstmateInstanceLabel, firstmateJobInstanceKey, sameFirstmateJobInstance } from "./guide-firstmate-group.ts"

export type { FirstmateTerminalHandoff } from "./guide-firstmate-terminal.ts"

export interface GuideQueuedContext {
  readonly originalIntent: string
  readonly workflowId: string
  readonly projectTarget: GuideProjectTargetV1 | null
  readonly projectTargetConfirmed?: boolean
  readonly workflow: ProfileGuideWorkflow
}

export const legacyFirstmateQueuedContext = (
  profile: SelectedProfile,
  context: GuideQueuedContext | undefined,
): GuideLegacyFirstmateContext | undefined => {
  if (profile.surface !== "native" || profile.launcher !== "fmx" || profile.orchestration !== undefined) return undefined
  if (context?.projectTargetConfirmed !== true) {
    throw new Error("Legacy Firstmate delivery requires confirmed original intent, project target, and workflow.")
  }
  return { ...context, projectTargetConfirmed: true }
}

const queuedTaskContext = (profile: SelectedProfile, context: GuideQueuedContext): GuideTaskContext => ({
  ...(profile.surface === "native" ? { profileRef: `native:${profile.launcher}/${profile.profile}` } : {}),
  originalIntent: context.originalIntent,
  projectTarget: context.projectTarget,
  ...(profile.surface === "native" && profile.orchestration !== undefined ? { orchestration: profile.orchestration } : {}),
})

export type FirstmateGuideAction = keyof FirstmateFleetReadinessV1["actions"]

export interface FirstmateQueuedSubmission {
  readonly action: FirstmateGuideAction
  readonly requestId: string
  readonly expectedFleet?: FirstmateFleetIdentityV1
}

const startupTimeoutMs = 60_000
const promptTimeoutMs = 60_000

/**
 * Ordinary jobs need a Herdr destination. Firstmate can reuse a fleet or
 * hand off the current terminal after the guide exits.
 */
export type JobPlacement =
  | { readonly kind: "current-workspace-pane"; readonly direction: HerdrSplitDirection }
  | { readonly kind: "new-tab" }
  | { readonly kind: "new-worktree"; readonly branch: string; readonly baseRef: string }
  | { readonly kind: "existing-worktree"; readonly path: string }
  | { readonly kind: "existing-fleet" }
  | { readonly kind: "current-terminal" }

export interface QueuedGuideJob {
  readonly id: number
  readonly profile: SelectedProfile
  readonly prompt: string
  readonly command: CommandSpec
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly placement: JobPlacement
  readonly privatePrompt?: boolean
  readonly goalExecution?: GuideGoalCandidateContext
  readonly guideContext?: GuideQueuedContext
  readonly firstmate?: FirstmateQueuedSubmission
  readonly primaryCheckoutPath?: string
}

export interface GuideQueueState {
  readonly entries: ReadonlyArray<QueuedGuideJob>
  readonly nextId: number
  readonly selectedIndex: number
  readonly editingId?: number
}

/**
 * What every placement resolves against. This decides nothing on its own: it
 * only says where the guide is running, so each entry's own placement can be
 * turned into a pane.
 */
export interface GuideBatchContext {
  readonly workspaceId?: string
  readonly cwd: string
  readonly callerPaneId?: string
  readonly primaryCheckoutPath?: string
}

export interface GuideBatch {
  readonly jobs: ReadonlyArray<QueuedGuideJob>
  readonly context: GuideBatchContext
}

export const guideBatchCheckoutProblem = (batch: GuideBatch): string | undefined => {
  const roots = new Set(batch.jobs.flatMap((job) =>
    job.placement?.kind === "new-worktree"
      ? [job.primaryCheckoutPath ?? batch.context.primaryCheckoutPath].filter((root): root is string => root !== undefined)
      : []))
  if (roots.size > 1) return "New supervisor worktrees must use one checked checkout root. Conflicting roots were not saved or launched."
  const root = [...roots][0]
  if (root !== undefined && batch.context.primaryCheckoutPath !== undefined && root !== batch.context.primaryCheckoutPath) {
    return "The batch checkout root differs from its confirmed worktree allocation. Nothing was saved or launched."
  }
  return undefined
}

interface GuideBatchStartedEntry {
  readonly job: QueuedGuideJob
  readonly paneId: string
  readonly workspaceId: string
  readonly cwd: string
}

export type GuideBatchEntryResult =
  | (GuideBatchStartedEntry & { readonly status: "launched" })
  | (GuideBatchStartedEntry & { readonly status: "needs-input" })
  | { readonly job: QueuedGuideJob; readonly status: "invalid"; readonly stage: "validation"; readonly message: string }
  | {
      readonly job: QueuedGuideJob
      readonly status: "not-ready"
      readonly stage: "readiness"
      readonly message: string
      readonly paneId?: string
      readonly workspaceId?: string
      readonly cwd?: string
    }
  | {
      readonly job: QueuedGuideJob
      readonly status: "accepted"
      readonly request: FirstmateSubmissionRequestV1
      readonly receipt: FirstmateSubmissionReceiptV1
      readonly supervisor: FirstmateSubmissionReceiptV1["supervisorState"] | "unknown"
      readonly startupError?: string
      readonly paneId?: string
      readonly workspaceId?: string
      readonly cwd?: string
    }
  | {
      readonly job: QueuedGuideJob
      readonly status: "submission-unknown" | "submission-rejected"
      readonly stage: "submission"
      readonly request: FirstmateSubmissionRequestV1
      readonly receipt?: FirstmateSubmissionReceiptV1
      readonly message: string
    }
  | {
      readonly job: QueuedGuideJob
      readonly status: "not-submitted"
      readonly stage: "submission"
      readonly message: string
    }
  | {
      readonly job: QueuedGuideJob
      readonly status: "workspace-create-failed"
      readonly stage: "worktree-create"
      readonly message: string
    }
  | {
      readonly job: QueuedGuideJob
      readonly status: "allocation-failed"
      readonly stage: "pane-allocation"
      readonly message: string
    }
  | {
      readonly job: QueuedGuideJob
      readonly status: "launch-failed"
      readonly stage: "launch"
      readonly paneId: string
      readonly workspaceId?: string
      readonly cwd?: string
      readonly message: string
    }

export interface GuideBatchExecutionResult {
  readonly entries: ReadonlyArray<GuideBatchEntryResult>
  readonly firstmateTerminalHandoff?: FirstmateTerminalHandoff
}

/** One step of one queued job, so a caller can narrate the launch while it runs. */
export type GuideBatchPhase = "checking" | "allocating" | "saving" | "reconciling" | "starting" | "waiting" | "prompting" | "done" | "needs-input" | "failed"

export interface GuideBatchProgressEvent {
  readonly jobId: number
  readonly phase: GuideBatchPhase
  readonly detail: string
}

export interface GuideBatchExecutionServices {
  readonly runner: CommandRunner
  readonly write: (text: string) => void
  readonly onProgress?: (event: GuideBatchProgressEvent) => void
  readonly onAllocated?: (
    job: QueuedGuideJob,
    destination: {
      readonly paneId: string
      readonly workspaceId: string
      readonly cwd: string
    },
  ) => Promise<void>
  readonly onResult?: (entry: GuideBatchEntryResult) => Promise<void>
  readonly launchPrivate?: typeof launchInHerdrPaneAndPrompt
  readonly checkReadiness?: typeof checkSelectedProfileReadiness
  readonly firstmateJournal?: FirstmateSubmissionJournal
  readonly firstmateJournalFor?: FirstmateJournalFactory
  readonly onFirstmateUpdate?: (job: QueuedGuideJob, entry: FirstmateJournalEntry) => Promise<void>
  readonly firstmateTime?: TimeController
  readonly firstmateStartupTimeoutMs?: number
  readonly firstmatePollIntervalMs?: number
}

export const emptyGuideQueue = (): GuideQueueState => ({ entries: [], nextId: 1, selectedIndex: 0 })

export const reservedWorktreeBranches = (queue: GuideQueueState, excludedId?: number): ReadonlyArray<string> =>
  queue.entries.flatMap((job) =>
    job.id !== excludedId && job.placement.kind === "new-worktree" ? [job.placement.branch.trim()] : [],
  )

export class GuideQueueConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly job: QueuedGuideJob,
  ) {
    const launcher = job.profile.surface === "native" ? job.profile.launcher : "sandbox"
    super(
      `Branch "${branch}" is already queued by job ${job.id} (${launcher} ${job.profile.profile}). Choose another branch.`,
    )
    this.name = "GuideQueueConflictError"
  }
}

export const findGuideQueueConflict = (
  queue: GuideQueueState,
  branch: string,
  excludedId?: number,
): GuideQueueConflictError | undefined => {
  const key = branch.trim()
  const job = queue.entries.find(
    (entry) =>
      entry.id !== excludedId && entry.placement.kind === "new-worktree" && entry.placement.branch.trim() === key,
  )
  return job === undefined ? undefined : new GuideQueueConflictError(key, job)
}

const guardQueuePlacement = (queue: GuideQueueState, placement: JobPlacement, excludedId?: number): void => {
  if (placement.kind !== "new-worktree") return
  const conflict = findGuideQueueConflict(queue, placement.branch, excludedId)
  if (conflict !== undefined) throw conflict
}

export const createQueuedGuideJob = (
  id: number,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
  context?: GuideQueuedContext | GuideGoalCandidateContext,
  firstmate?: FirstmateQueuedSubmission,
  primaryCheckoutPath?: string,
): QueuedGuideJob => {
  const guideContext = context !== undefined && !("goal" in context) ? context : undefined
  const goalExecution = context !== undefined && "goal" in context ? freezeGuideGoalCandidateContext(context) : undefined
  profile = Object.freeze(parseSelectedProfile(profile))
  const deliveredPrompt = guideContext !== undefined
    ? completeSinglePromptArtifact(guideContext.workflow, {
        title: "Queued request", prompt, notes: "Preserve the complete original input.",
      }, queuedTaskContext(profile, guideContext)).prompt
    : prompt
  const legacy = legacyFirstmateQueuedContext(profile, guideContext)
  if (legacy !== undefined) validateLegacyFirstmateArtifact(`native:fmx/${profile.profile}`, deliveredPrompt, legacy)
  const built = buildHerdrGuideLaunch(profile, deliveredPrompt, goalExecution)
  return Object.freeze({
    id, profile, prompt: deliveredPrompt, command: Object.freeze({ ...built.command, args: Object.freeze([...built.command.args]) }), promptDelivery: built.promptDelivery, placement: Object.freeze({ ...placement }),
    ...(goalExecution === undefined ? {} : { goalExecution }),
    ...(guideContext === undefined ? {} : { guideContext }),
    ...(firstmate === undefined ? {} : { firstmate }),
    ...((placement.kind !== "new-worktree" && placement.kind !== "existing-worktree") || primaryCheckoutPath === undefined
      ? {} : { primaryCheckoutPath }),
  })
}

export const createFirstmateQueuedSubmission = (
  action: FirstmateGuideAction,
  expectedFleet?: FirstmateFleetIdentityV1,
): FirstmateQueuedSubmission =>
  ({ action, requestId: randomUUID(), ...(expectedFleet === undefined ? {} : { expectedFleet }) })

export const guideBatchRequiresHerdr = (jobs: ReadonlyArray<QueuedGuideJob>): boolean =>
  jobs.some((job) => !isFirstmateBatchJob(job) ||
    (job.placement?.kind !== "existing-fleet" && job.placement?.kind !== "current-terminal"))

export const enqueueGuideJob = (
  queue: GuideQueueState,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
  guideContext?: GuideQueuedContext | GuideGoalCandidateContext,
  firstmate?: FirstmateQueuedSubmission,
  primaryCheckoutPath?: string,
): GuideQueueState => {
  guardQueuePlacement(queue, placement)
  return {
  entries: [...queue.entries, createQueuedGuideJob(queue.nextId, profile, prompt, placement, guideContext, firstmate, primaryCheckoutPath)],
  nextId: queue.nextId + 1,
  selectedIndex: queue.entries.length,
  }
}

export const selectQueuedGuideJob = (queue: GuideQueueState, delta: 1 | -1): GuideQueueState =>
  queue.entries.length === 0
    ? queue
    : { ...queue, selectedIndex: (queue.selectedIndex + delta + queue.entries.length) % queue.entries.length }

export const startQueuedGuidePromptEdit = (queue: GuideQueueState): GuideQueueState => {
  const selected = queue.entries[queue.selectedIndex]
  return selected === undefined ? queue : { ...queue, editingId: selected.id }
}

export const queuedGuideJobEditText = (job: QueuedGuideJob): string =>
  job.guideContext === undefined
    ? job.prompt
    : guideModelBodyCandidate(job.guideContext.workflow, {
        title: "Queued request", prompt: job.prompt, notes: "User-selected specification.",
      }, queuedTaskContext(job.profile, job.guideContext)).prompt

export const replaceQueuedGuideJobPrompt = (
  job: QueuedGuideJob,
  prompt: string,
  goalExecution: GuideGoalCandidateContext | undefined = job.goalExecution,
): QueuedGuideJob => {
  if (job.goalExecution !== undefined && JSON.stringify(goalExecution) !== JSON.stringify(job.goalExecution)) {
    throw new GuideGoalError("Editing a queued approach cannot change its approved goal or controller.")
  }
  if (goalExecution === undefined) {
  const candidate = { title: "Queued request", prompt, notes: "User-edited specification." }
  const rendered = validateFinalGuideCandidate(job.guideContext === undefined
    ? candidate
    : renderWorkflowBodyCandidate(job.guideContext.workflow, candidate))
  return createQueuedGuideJob(
    job.id, job.profile, rendered.prompt, job.placement, job.guideContext,
    job.firstmate === undefined ? undefined : createFirstmateQueuedSubmission(job.firstmate.action, job.firstmate.expectedFleet),
    job.primaryCheckoutPath,
  )
  }
  const candidate = composeGuideGoalCandidate(goalExecution, { title: "Queued goal", prompt, notes: "" })
  return createQueuedGuideJob(job.id, job.profile, candidate.prompt, job.placement, candidate.goalExecution)
}

export const submitQueuedGuidePromptEdit = (queue: GuideQueueState, prompt: string): GuideQueueState => {
  if (queue.editingId === undefined || prompt.trim().length === 0) return queue
  const { editingId, ...rest } = queue
  return {
    ...rest,
    entries: queue.entries.map((job) => (job.id === editingId ? replaceQueuedGuideJobPrompt(job, prompt) : job)),
  }
}

export const removeSelectedQueuedGuideJob = (queue: GuideQueueState): GuideQueueState => {
  if (queue.entries[queue.selectedIndex] === undefined) return queue
  const entries = queue.entries.filter((_, index) => index !== queue.selectedIndex)
  return { entries, nextId: queue.nextId, selectedIndex: Math.min(queue.selectedIndex, Math.max(0, entries.length - 1)) }
}

/** Removes one entry by its id, for a tab that is dropped while it holds a queued job. */
export const removeQueuedGuideJobById = (queue: GuideQueueState, id: number): GuideQueueState => {
  const entries = queue.entries.filter((job) => job.id !== id)
  return entries.length === queue.entries.length
    ? queue
    : { ...queue, entries, selectedIndex: Math.min(queue.selectedIndex, Math.max(0, entries.length - 1)) }
}

/**
 * Rewrites one entry in place, keeping its id and its position. A tab and its
 * queued job are one thing, so re-finishing a tab must update its job rather
 * than add a second one.
 */
export const replaceQueuedGuideJob = (
  queue: GuideQueueState,
  id: number,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
  guideContext?: GuideQueuedContext | GuideGoalCandidateContext,
  firstmate?: FirstmateQueuedSubmission,
  primaryCheckoutPath?: string,
): GuideQueueState => {
  const index = queue.entries.findIndex((job) => job.id === id)
  if (index >= 0) guardQueuePlacement(queue, placement, id)
  return index < 0
    ? queue
    : {
        ...queue,
        entries: queue.entries.map((job) => (job.id === id ? createQueuedGuideJob(id, profile, prompt, placement, guideContext, firstmate, primaryCheckoutPath) : job)),
        selectedIndex: index,
      }
}

/** One dense line naming where a queued job will run, for the queue review screen. */
export const describeJobPlacement = (placement: JobPlacement): string => {
  if (placement === null || typeof placement !== "object") return "invalid placement"
  if (placement.kind === "existing-fleet") return "existing owned fleet; no new terminal"
  if (placement.kind === "current-terminal") return "current terminal after the guide exits"
  if (placement.kind === "current-workspace-pane") return `pane here (split ${placement.direction})`
  if (placement.kind === "new-tab") return "new tab in this Herdr worktree"
  if (placement.kind === "new-worktree") return `new worktree ${placement.branch} from ${placement.baseRef}`
  return placement.kind === "existing-worktree" ? `existing worktree ${placement.path}` : "invalid placement"
}

const describeError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "An unknown error occurred."

const validateWorktreeRefs = (placement: Extract<JobPlacement, { kind: "new-worktree" }>): string | undefined => {
  if (typeof placement.branch !== "string" || placement.branch.trim().length === 0) return "Queued worktree branch must not be empty."
  if (typeof placement.baseRef !== "string" || placement.baseRef.trim().length === 0) return "Queued worktree base ref must not be empty."
  if ([placement.branch, placement.baseRef].some((value) =>
    value !== value.trim() || value.startsWith("-") || /[\u0000-\u0020\u007f-\u009f]/u.test(value))) {
    return "Queued worktree refs must not contain whitespace, control characters, or option prefixes."
  }
  return undefined
}

const validateExistingWorktree = (location: string): string | undefined => {
  if (typeof location !== "string" || location.trim().length === 0) return "Queued worktree path must not be empty."
  return path.isAbsolute(location) && !/[\u0000-\u001f\u007f-\u009f]/u.test(location)
    ? undefined
    : "Queued worktree path must be an absolute path without control characters."
}

const validatePlacement = (placement: JobPlacement): string | undefined => {
  if (placement === null || typeof placement !== "object") return "Queued placement is required."
  switch (placement.kind) {
    case "current-workspace-pane":
      return placement.direction === "right" || placement.direction === "down"
        ? undefined
        : "Queued pane direction must be right or down."
    case "new-tab":
    case "current-terminal":
    case "existing-fleet": return undefined
    case "new-worktree": return validateWorktreeRefs(placement)
    case "existing-worktree": return validateExistingWorktree(placement.path)
    default: return "Queued placement is not supported."
  }
}

const validateQueuedPlacement = (job: QueuedGuideJob): string | undefined => {
  const message = validatePlacement(job.placement)
  if (message !== undefined) return message
  if (job.placement.kind === "existing-fleet" && !isFirstmateBatchJob(job)) {
    return "An existing fleet placement requires a Firstmate submission."
  }
  if (job.placement.kind === "current-terminal" && !isFirstmateBatchJob(job)) {
    return "A queued current-terminal placement requires an inbox-capable Firstmate Start or Recover action."
  }
  return undefined
}

const validateQueuedJob = (job: QueuedGuideJob): string | undefined => {
  if (!Number.isSafeInteger(job.id) || job.id < 1) return "Queue entry ID must be a positive integer."
  if (typeof job.prompt !== "string" || job.prompt.trim().length === 0) return "Queued prompt must not be empty."
  const maximumLength = job.goalExecution === undefined ? 8000 : guideGoalPromptMaximumLength
  if ([...job.prompt].length > maximumLength) return `Queued prompt exceeds ${maximumLength} characters.`
  const placementMessage = validateQueuedPlacement(job)
  if (placementMessage !== undefined) return placementMessage
  try {
    const profile = parseSelectedProfile(job.profile)
    if (job.privatePrompt && job.goalExecution !== undefined) {
      return "Private prompt delivery does not support goal execution."
    }
    const legacy = legacyFirstmateQueuedContext(profile, job.guideContext)
    if (legacy !== undefined) validateLegacyFirstmateArtifact(`native:fmx/${profile.profile}`, job.prompt, legacy)
    const built = job.privatePrompt
      ? { command: buildGuideLaunchCommand(profile).command, promptDelivery: "agent" }
      : buildHerdrGuideLaunch(profile, job.prompt, job.goalExecution)
    if (
      built.promptDelivery !== job.promptDelivery ||
      !sameGuideCommand(built.command, job.command)
    ) {
      return "Queued command does not match its profile and prompt."
    }
  } catch (error) {
    return describeError(error)
  }
  return undefined
}

const allocationDetail = (placement: JobPlacement): string => {
  if (placement.kind === "current-workspace-pane") return `Splitting a pane (${placement.direction})`
  if (placement.kind === "new-tab") return "Creating a new tab"
  if (placement.kind === "new-worktree") return `Creating worktree ${placement.branch}`
  if (placement.kind === "existing-fleet") return "Using the existing owned fleet"
  if (placement.kind === "current-terminal") return "Preparing the current-terminal handoff"
  return `Opening worktree ${placement.path}`
}

const launchPhaseDetail: Record<HerdrLaunchPhase, string> = {
  starting: "Starting the profile",
  waiting: "Waiting for the agent to be ready",
  prompting: "Delivering the prompt",
}

const report = (
  services: GuideBatchExecutionServices,
  jobId: number,
  phase: GuideBatchPhase,
  detail: string,
): void => services.onProgress?.({ jobId, phase, detail })

interface LaunchableJob {
  readonly index: number
  readonly job: QueuedGuideJob
}

interface AllocatedJob extends LaunchableJob {
  readonly paneId: string
  readonly cwd: string
  readonly workspaceId: string
}

/**
 * Rejects the entries a queue cannot run as a set: a repeated ID, or two
 * entries that would create the same branch. Git would fail the second
 * `worktree add` with a lock or collision error long after the first one
 * launched, so catching it here keeps the failure legible.
 */
const collidingEntryMessage = (
  job: QueuedGuideJob,
  seenIds: Set<number>,
  seenBranches: Map<string, QueuedGuideJob>,
): string | undefined => {
  if (seenIds.has(job.id)) return `Queue entry ID ${job.id} is duplicated.`
  if (job.placement.kind !== "new-worktree") return undefined
  const branch = job.placement.branch.trim()
  const previous = seenBranches.get(branch)
  if (previous === undefined) return undefined
  if (
    job.profile.surface === "native" && previous.profile.surface === "native" &&
    isFirstmateBatchJob(job) && isFirstmateBatchJob(previous) &&
    job.profile.launcher === "fmx" && previous.profile.launcher === "fmx" &&
    sameFirstmateJobInstance(job, previous)
  ) return undefined
  return `Two queued jobs would both create branch ${branch}.`
}

const rememberEntry = (job: QueuedGuideJob, seenIds: Set<number>, seenBranches: Map<string, QueuedGuideJob>): void => {
  seenIds.add(job.id)
  if (job.placement?.kind === "new-worktree" && typeof job.placement.branch === "string") {
    const branch = job.placement.branch.trim()
    if (!seenBranches.has(branch)) seenBranches.set(branch, job)
  }
}

type HerdrBatchContext = GuideBatchContext & { readonly workspaceId: string; readonly callerPaneId: string }

const requirePrimaryCheckout = (context: GuideBatchContext): string => {
  const root = context.primaryCheckoutPath
  if (root === undefined || validateExistingWorktree(root) !== undefined) {
    throw new Error("A worktree destination requires an inspected absolute primary checkout path.")
  }
  return root
}

const requireHerdrBatchContext = (context: GuideBatchContext): HerdrBatchContext => {
  const { cwd, workspaceId, callerPaneId, primaryCheckoutPath } = context
  if (
    typeof workspaceId !== "string" || workspaceId.trim().length === 0 ||
    typeof callerPaneId !== "string" || callerPaneId.trim().length === 0 ||
    typeof cwd !== "string" || !path.isAbsolute(cwd) ||
    [workspaceId, callerPaneId, cwd].some((value) => /[\u0000-\u001f\u007f-\u009f]/u.test(value))
  ) {
    throw new Error("This placement requires a real Herdr workspace, caller pane, and absolute working directory.")
  }
  if (primaryCheckoutPath !== undefined) requirePrimaryCheckout(context)
  return { cwd, workspaceId, callerPaneId, ...(primaryCheckoutPath === undefined ? {} : { primaryCheckoutPath }) }
}

const jobAllocationContext = (context: GuideBatchContext, job: QueuedGuideJob): HerdrBatchContext =>
  requireHerdrBatchContext({
    ...context,
    ...(job.primaryCheckoutPath === undefined ? {} : { primaryCheckoutPath: job.primaryCheckoutPath }),
  })

/** Resolves only Herdr placements. Inbox delivery does not allocate a pane here. */
const allocateJob = async (
  runner: CommandRunner,
  context: HerdrBatchContext,
  placement: JobPlacement,
): Promise<{ readonly paneId: string; readonly cwd: string; readonly workspaceId: string }> => {
  if (placement.kind === "existing-fleet" || placement.kind === "current-terminal") {
    throw new Error("This Firstmate placement does not allocate a Herdr destination.")
  }
  if (placement.kind === "current-workspace-pane") {
    const paneId = await splitHerdrPane(runner, {
      anchorPaneId: context.callerPaneId,
      cwd: context.cwd,
      direction: placement.direction,
    })
    return { paneId, cwd: context.cwd, workspaceId: context.workspaceId }
  }
  if (placement.kind === "new-tab") {
    const paneId = await createHerdrTab(runner, { workspaceId: context.workspaceId, cwd: context.cwd })
    return { paneId, cwd: context.cwd, workspaceId: context.workspaceId }
  }
  const primaryCheckoutPath = requirePrimaryCheckout(context)
  const handle =
    placement.kind === "new-worktree"
      ? await createHerdrWorktree(runner, {
          primaryCheckoutPath,
          branch: placement.branch,
          baseRef: placement.baseRef,
        })
      : await openHerdrWorktree(runner, { primaryCheckoutPath, path: placement.path })
  return { paneId: handle.rootPaneId, cwd: handle.checkoutPath, workspaceId: handle.workspaceId }
}

const allocationFailure = (job: QueuedGuideJob, message: string): GuideBatchEntryResult =>
  job.placement.kind === "current-workspace-pane" || job.placement.kind === "new-tab"
    ? { job, status: "allocation-failed", stage: "pane-allocation", message }
    : { job, status: "workspace-create-failed", stage: "worktree-create", message }

/**
 * Allocates one entry at a time. Git serializes `worktree add` on the primary
 * checkout anyway, and a failure must stop only its own entry, so a sequential
 * loop is both correct and simpler than fanning the allocation out.
 */
const allocateJobs = async (
  services: GuideBatchExecutionServices,
  context: GuideBatchContext,
  launchable: ReadonlyArray<LaunchableJob>,
  entries: Array<GuideBatchEntryResult | undefined>,
): Promise<ReadonlyArray<AllocatedJob>> => {
  const allocated: Array<AllocatedJob> = []
  for (const item of launchable) {
    report(services, item.job.id, "allocating", allocationDetail(item.job.placement))
    try {
      const destination = await allocateJob(services.runner, jobAllocationContext(context, item.job), item.job.placement)
      await services.onAllocated?.(item.job, destination)
      allocated.push({ ...item, ...destination })
    } catch (error) {
      const message = describeError(error)
      entries[item.index] = allocationFailure(item.job, message)
      report(services, item.job.id, "failed", message)
    }
  }
  return allocated
}

const checkReadiness = async (
  services: GuideBatchExecutionServices,
  context: GuideBatchContext,
  structurallyValid: ReadonlyArray<LaunchableJob>,
  entries: Array<GuideBatchEntryResult | undefined>,
): Promise<ReadonlyArray<LaunchableJob>> => {
  const checked = await Promise.all(
    structurallyValid.map(async (item) => {
      report(services, item.job.id, "checking", "Checking profile readiness")
      try {
        const cwd = item.job.goalExecution !== undefined && item.job.placement.kind === "existing-worktree"
          ? item.job.placement.path
          : context.cwd
        return {
          item,
          result: await (services.checkReadiness ?? checkSelectedProfileReadiness)(
            services.runner, item.job.profile, cwd, undefined, item.job.goalExecution,
          ),
        }
      } catch (error) {
        return { item, error }
      }
    }),
  )
  const launchable: Array<LaunchableJob> = []
  for (const outcome of checked) {
    const message =
      "error" in outcome
        ? describeError(outcome.error)
        : outcome.result.kind === ProfileReadinessKind.Blocked
          ? `${outcome.result.summary}. ${outcome.result.diagnostic}`
          : undefined
    if (message === undefined) launchable.push(outcome.item)
    else {
      entries[outcome.item.index] = {
        job: outcome.item.job,
        status: "not-ready",
        stage: "readiness",
        message,
      }
      report(services, outcome.item.job.id, "failed", message)
    }
  }
  return launchable
}

const writeStartedJob = (
  entry: Extract<GuideBatchEntryResult, { readonly status: "launched" | "needs-input" }>,
  write: (text: string) => void,
): void => {
  write(`${entry.job.id}. ${entry.job.profile.profile}: ${entry.status} in pane ${entry.paneId} · ${entry.cwd}\n`)
  if (entry.status !== "needs-input") return
  write(`Workspace: ${entry.workspaceId}. The goal has not been activated.\n`)
  write(entry.job.goalExecution === undefined
    ? `Selected prompt:\n\n${entry.job.prompt}\n`
    : `${guideGoalInputInstructions(entry.job.goalExecution, entry.job.prompt)}\n`)
}

const writeFailedJob = (
  entry: Exclude<GuideBatchEntryResult, { readonly status: "launched" | "needs-input" | "accepted" }>,
  write: (text: string) => void,
): void => {
  write(`${entry.job.id}. ${entry.job.profile.profile} (${describeJobPlacement(entry.job.placement)}): ${entry.stage} failed: ${entry.message}\n`)
  if ("paneId" in entry && entry.paneId !== undefined) {
    write(`Allocated pane: ${entry.paneId}; workspace: ${entry.workspaceId ?? "unknown"}; directory: ${entry.cwd ?? "unknown"}.\n`)
  }
  if (entry.job.goalExecution !== undefined && entry.status !== "invalid") {
    write(`Resolve the error before native input.\n${guideGoalInputInstructions(entry.job.goalExecution, entry.job.prompt)}\n`)
  } else {
    write(`Selected prompt:\n\n${entry.job.prompt}\n`)
  }
}

const writeAcceptedSummary = (
  entry: Extract<GuideBatchEntryResult, { status: "accepted" }>,
  identity: string,
  write: (text: string) => void,
): void => {
  write(
    `${identity}: accepted request ${entry.request.requestId}; note ${entry.receipt.noteId} (${entry.receipt.state}); ` +
    `announcement ${entry.receipt.announcement}; supervisor ${entry.supervisor}` +
    `${entry.paneId === undefined ? "" : ` in pane ${entry.paneId}`}\n`,
  )
  write(`Fleet status: ${firstmateSupervisorStatusText(entry.supervisor)}.\n`)
  write("Acceptance does not confirm dispatch or task completion.\n")
  if (entry.receipt.announcement === "failed") write(`Announcement failed: ${entry.receipt.error?.message ?? "The supervisor was not notified."}\n`)
  if (entry.startupError !== undefined) write(`Supervisor startup/status: ${entry.startupError}\n`)
}

const writeBatchEntrySummary = (entry: GuideBatchEntryResult, write: (text: string) => void): void => {
  const profile = entry.job.profile
  const identity = `${entry.job.id}. ${profile?.surface === "native" && profile.firstmateInstance !== undefined
    ? firstmateInstanceLabel(profile) : profile?.profile ?? "invalid profile"}`
  if (entry.status === "launched" || entry.status === "needs-input") {
    writeStartedJob(entry, write)
  } else if (entry.status === "accepted") {
    writeAcceptedSummary(entry, identity, write)
  } else if (entry.status === "submission-unknown" || entry.status === "submission-rejected") {
    write(`${identity}: ${entry.status} for request ${entry.request.requestId}: ${entry.message}\n`)
    if (entry.status === "submission-unknown") write("reconcile the same request ID and payload; do not paste or submit a new ID.\n")
  } else if (isFirstmateBatchJob(entry.job)) {
    write(
      `${identity} (${describeJobPlacement(entry.job.placement)}): ${entry.status}` +
      `${entry.job.firstmate == null ? "" : `; request ${entry.job.firstmate.requestId}`}: ${entry.message}\n`,
    )
  } else {
    writeFailedJob(entry, write)
  }
}

/** Prints the per-entry outcome. The interactive guide prints this after Ink exits. */
export const writeGuideBatchSummary = (result: GuideBatchExecutionResult, write: (text: string) => void): void => {
  write(`Batch launch summary: ${result.entries.length} job${result.entries.length === 1 ? "" : "s"}\n`)
  for (const entry of result.entries) writeBatchEntrySummary(entry, write)
}

export const guideBatchExitCode = (result: GuideBatchExecutionResult): number => {
  try {
    const handoff = result.firstmateTerminalHandoff
    const readyRequests = new Set(handoff === undefined
      ? []
      : validateFirstmateTerminalHandoff(handoff, result.entries).requestIds)
    return result.entries.every((entry) =>
      (entry.status === "launched" || entry.status === "needs-input") ||
      (entry.status === "accepted" && (entry.supervisor === "running" || readyRequests.has(entry.request.requestId)) &&
        entry.startupError === undefined && entry.receipt.announcement !== "failed")) ? (result.entries.some((entry) => entry.status === "needs-input") ? 2 : 0) : 1
  } catch {
    return 1
  }
}

const executionValidationMessage = (
  job: QueuedGuideJob,
  context: GuideBatchContext,
  services: GuideBatchExecutionServices,
): string | undefined => {
  if (job.privatePrompt && !isFirstmateBatchJob(job) && services.launchPrivate === undefined) {
    return "Private prompt delivery is unavailable."
  }
  const message = validateQueuedJob(job)
  if (message !== undefined || job.placement.kind === "existing-fleet" || job.placement.kind === "current-terminal") return message
  try {
    const allocationContext = jobAllocationContext(context, job)
    if (job.placement.kind === "new-worktree" || job.placement.kind === "existing-worktree") requirePrimaryCheckout(allocationContext)
    return undefined
  } catch (error) {
    return describeError(error)
  }
}

const registerFirstmateGroup = (groups: Map<string, FirstmateBatchItem[]>, item: FirstmateBatchItem): boolean => {
  const { job } = item
  if (!isFirstmateBatchJob(job)) return false
  let key = `invalid:${job.profile?.profile}`
  try {
    key = firstmateJobInstanceKey(job) ?? key
  } catch {
    // Structural validation reports malformed references before any journal is opened.
  }
  const group = groups.get(key) ?? []
  group.push(item)
  groups.set(key, group)
  return true
}

const duplicateRequestMessage = (
  job: QueuedGuideJob,
  index: number,
  jobs: ReadonlyArray<QueuedGuideJob>,
  seen: Map<string, number>,
  entries: Array<GuideBatchEntryResult | undefined>,
): string | undefined => {
  if (job.firstmate == null) return undefined
  const previous = seen.get(job.firstmate.requestId)
  if (previous === undefined) {
    seen.set(job.firstmate.requestId, index)
    return undefined
  }
  const message = `Firstmate request ID ${job.firstmate.requestId} is duplicated in the queue.`
  entries[previous] = { job: jobs[previous]!, status: "invalid", stage: "validation", message }
  return message
}

const rejectConflictingTerminalGroups = (
  groups: ReadonlyMap<string, ReadonlyArray<FirstmateBatchItem>>,
  entries: Array<GuideBatchEntryResult | undefined>,
  services: GuideBatchExecutionServices,
): boolean => {
  const claimants = [...groups.values()].filter((items) =>
    items.some(({ job }) => job.placement?.kind === "current-terminal"))
  if (claimants.length < 2) return false
  const message = "Different Firstmate fleets cannot share the current terminal. Choose one fleet before saving requests."
  for (const items of claimants) {
    for (const { job, index } of items) {
      entries[index] = { job, status: "invalid", stage: "validation", message }
      report(services, job.id, "failed", message)
    }
  }
  return true
}

const checkAllocatedGoalReadiness = async (
  services: GuideBatchExecutionServices,
  job: QueuedGuideJob,
  cwd: string,
): Promise<void> => {
  if (job.goalExecution === undefined) return
  const readiness = await (services.checkReadiness ?? checkSelectedProfileReadiness)(
    services.runner, job.profile, cwd, undefined, job.goalExecution,
  )
  if (readiness.kind === ProfileReadinessKind.Blocked) {
    throw new ProfilePreflightError(`${readiness.summary}. ${readiness.diagnostic}`)
  }
}

const rejectConflictingLegacyGroups = (
  groups: ReadonlyMap<string, ReadonlyArray<FirstmateBatchItem>>,
  entries: Array<GuideBatchEntryResult | undefined>,
): void => {
  const legacy = new Map<string, ReadonlyArray<FirstmateBatchItem>>()
  for (const items of groups.values()) {
    const { job } = items[0]!
    if (job.profile.surface !== "native" || job.firstmate?.expectedFleet === undefined) continue
    try {
      const reference = selectedFirstmateInstance(job.profile, job.firstmate.expectedFleet)
      if (reference.mode !== "legacy") continue
      const previous = legacy.get(reference.profile)
      if (previous !== undefined) {
        const message = "One legacy Firstmate profile cannot address different confirmed fleet instances."
        for (const { job, index } of [...previous, ...items]) {
          entries[index] = { job, status: "invalid", stage: "validation", message }
        }
      } else legacy.set(reference.profile, items)
    } catch {
      // The normal structural validator reports invalid selections.
    }
  }
}

export const executeGuideBatch = async (
  batch: GuideBatch,
  services: GuideBatchExecutionServices,
): Promise<{ readonly exitCode: number; readonly result: GuideBatchExecutionResult }> => {
  if (batch.jobs.length === 0) {
    services.write("Batch queue is empty.\n")
    return { exitCode: 1, result: { entries: [] } }
  }
  const checkoutProblem = guideBatchCheckoutProblem(batch)
  if (checkoutProblem !== undefined) return {
    exitCode: 1,
    result: { entries: batch.jobs.map((job) => ({ job, status: "invalid", stage: "validation", message: checkoutProblem })) },
  }

  const entries: Array<GuideBatchEntryResult | undefined> = new Array(batch.jobs.length)
  const structurallyValid: Array<LaunchableJob> = []
  const firstmateGroups = new Map<string, FirstmateBatchItem[]>()
  const seenIds = new Set<number>()
  const seenBranches = new Map<string, QueuedGuideJob>()
  const seenRequestIds = new Map<string, number>()
  batch.jobs.forEach((job, index) => {
    const firstmate = registerFirstmateGroup(firstmateGroups, { job, index })
    const duplicate = duplicateRequestMessage(job, index, batch.jobs, seenRequestIds, entries)
    const message = duplicate ??
      executionValidationMessage(job, batch.context, services) ??
      collidingEntryMessage(job, seenIds, seenBranches)
    rememberEntry(job, seenIds, seenBranches)
    if (message === undefined) {
      if (!firstmate) structurallyValid.push({ index, job })
    }
    else {
      entries[index] = { job, status: "invalid", stage: "validation", message }
      report(services, job.id, "failed", message)
    }
  })

  if (rejectConflictingTerminalGroups(firstmateGroups, entries, services)) return {
    exitCode: 1,
    result: { entries: batch.jobs.map((job, index) => entries[index] ?? {
      job, status: "invalid", stage: "validation",
      message: "The batch has multiple current-terminal fleet claimants. Nothing was saved or launched.",
    }) },
  }
  rejectConflictingLegacyGroups(firstmateGroups, entries)
  const journalFor = services.firstmateJournalFor ?? createFirstmateJournalFactory()
  const firstmateExecutions = [...firstmateGroups.values()].map(async (items) => {
    const invalid = items.map(({ index }) => entries[index]).find((entry) => entry !== undefined)
    if (invalid !== undefined && "message" in invalid) {
      for (const { index, job } of items) {
        entries[index] ??= { job, status: "invalid", stage: "validation", message: `Fleet group validation failed: ${invalid.message}` }
      }
      return
    }
    const outcomes = await executeFirstmateBatchGroup(items, batch.context, services, {
      journal: () => {
        const job = items[0]!.job
        if (job.profile.surface !== "native" || job.firstmate?.expectedFleet === undefined) {
          throw new Error("A fleet journal requires a confirmed native instance.")
        }
        const reference = selectedFirstmateInstance(job.profile, job.firstmate.expectedFleet)
        return reference.mode === "legacy" && services.firstmateJournal !== undefined
          ? scopeFirstmateJournal(reference, services.firstmateJournal) : journalFor(reference)
      },
      allocate: (job) => allocateJob(services.runner, jobAllocationContext(batch.context, job), job.placement),
    })
    items.forEach(({ index }, offset) => { entries[index] = outcomes.entries[offset] })
    return outcomes.firstmateTerminalHandoff
  })

  const launchable = await checkReadiness(services, batch.context, structurallyValid, entries)
  const allocated = await allocateJobs(services, batch.context, launchable, entries)

  const launches = await Promise.allSettled(
    allocated.map((item) =>
      (item.job.privatePrompt ? services.launchPrivate! : launchInHerdrPaneAndPrompt)(services.runner, {
        paneId: item.paneId,
        cwd: item.cwd,
        command: item.job.command,
        prompt: item.job.prompt,
        promptDelivery: item.job.promptDelivery,
        timeoutMs: startupTimeoutMs,
        promptTimeoutMs,
        ...(item.job.goalExecution === undefined ? {} : {
          beforeLaunch: (cwd: string) => checkAllocatedGoalReadiness(services, item.job, cwd),
        }),
        onPhase: (phase) => report(services, item.job.id, phase, launchPhaseDetail[phase]),
      }),
    ),
  )
  launches.forEach((launch, launchIndex) => {
    const item = allocated[launchIndex]
    if (item === undefined) return
    if (launch.status === "fulfilled") {
      const status = launch.value.status === "needs-input" || item.job.promptDelivery === "manual" ? "needs-input" : "launched"
      entries[item.index] = {
        job: item.job,
        status,
        paneId: item.paneId,
        workspaceId: item.workspaceId,
        cwd: item.cwd,
      }
      report(
        services, item.job.id, status === "needs-input" ? "needs-input" : "done",
        `${status === "needs-input" ? "Needs input" : "Launched"} in pane ${item.paneId}`,
      )
      return
    }
    const message = describeError(launch.reason)
    entries[item.index] = {
      job: item.job,
      ...(launch.reason instanceof ProfilePreflightError
        ? { status: "not-ready" as const, stage: "readiness" as const }
        : { status: "launch-failed" as const, stage: "launch" as const }),
      paneId: item.paneId, workspaceId: item.workspaceId, cwd: item.cwd, message,
    }
    report(services, item.job.id, "failed", message)
  })
  const firstmateTerminalHandoff = (await Promise.all(firstmateExecutions)).find((handoff) => handoff !== undefined)

  const result: GuideBatchExecutionResult = {
    ...(firstmateTerminalHandoff === undefined ? {} : { firstmateTerminalHandoff }),
    entries: entries.map((entry, index) => {
      if (entry !== undefined) return entry
      const job = batch.jobs[index]
      if (job === undefined) throw new Error("Batch result lost its queue entry.")
      return {
        job,
        status: "invalid",
        stage: "validation",
        message: "Batch entry was not processed.",
      }
    }),
  }
  for (const entry of result.entries) await services.onResult?.(entry)
  writeGuideBatchSummary(result, services.write)
  return { exitCode: guideBatchExitCode(result), result }
}
