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
} from "./guide-launch.ts"
import { checkSelectedProfileReadiness, ProfilePreflightError, ProfileReadinessKind } from "./guide-preflight.ts"
import { composeGuideGoalCandidate, guideGoalPromptMaximumLength, type GuideGoalCandidateContext } from "./guide-goal-execution.ts"
import { freezeGuideGoalCandidateContext, guideGoalInputInstructions } from "./guide-goal-transport.ts"
import { GuideGoalError } from "./guide-goal-augment.ts"

const startupTimeoutMs = 60_000
const promptTimeoutMs = 60_000

/**
 * Where one queued job runs. Every placement is a Herdr pane, so a queue always
 * fans out in parallel and this terminal stays with the guide. Running a job in
 * this terminal seizes its stdio until the agent exits, which no other entry
 * could survive, so the queue does not offer it.
 */
export type JobPlacement =
  | { readonly kind: "current-workspace-pane"; readonly direction: HerdrSplitDirection }
  | { readonly kind: "new-tab" }
  | { readonly kind: "new-worktree"; readonly branch: string; readonly baseRef: string }
  | { readonly kind: "existing-worktree"; readonly path: string }

export interface QueuedGuideJob {
  readonly id: number
  readonly profile: SelectedProfile
  readonly prompt: string
  readonly command: CommandSpec
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly placement: JobPlacement
  readonly privatePrompt?: boolean
  readonly goalExecution?: GuideGoalCandidateContext
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
  readonly workspaceId: string
  readonly cwd: string
  readonly callerPaneId: string
  readonly primaryCheckoutPath: string
}

export interface GuideBatch {
  readonly jobs: ReadonlyArray<QueuedGuideJob>
  readonly context: GuideBatchContext
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
}

/** One step of one queued job, so a caller can narrate the launch while it runs. */
export type GuideBatchPhase = "checking" | "allocating" | "starting" | "waiting" | "prompting" | "done" | "needs-input" | "failed"

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
  goalExecution?: GuideGoalCandidateContext,
): QueuedGuideJob => {
  const selected = Object.freeze(parseSelectedProfile(profile))
  const frozenGoal = goalExecution === undefined ? undefined : freezeGuideGoalCandidateContext(goalExecution)
  const built = buildHerdrGuideLaunch(selected, prompt, frozenGoal)
  return Object.freeze({
    id,
    profile: selected,
    prompt,
    command: Object.freeze({ ...built.command, args: Object.freeze([...built.command.args]) }),
    promptDelivery: built.promptDelivery,
    placement: Object.freeze({ ...placement }),
    ...(frozenGoal === undefined ? {} : { goalExecution: frozenGoal }),
  })
}

export const enqueueGuideJob = (
  queue: GuideQueueState,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
  goalExecution?: GuideGoalCandidateContext,
): GuideQueueState => {
  guardQueuePlacement(queue, placement)
  return {
    entries: [...queue.entries, createQueuedGuideJob(queue.nextId, profile, prompt, placement, goalExecution)],
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

export const replaceQueuedGuideJobPrompt = (
  job: QueuedGuideJob,
  prompt: string,
  goalExecution: GuideGoalCandidateContext | undefined = job.goalExecution,
): QueuedGuideJob => {
  if (job.goalExecution !== undefined && JSON.stringify(goalExecution) !== JSON.stringify(job.goalExecution)) {
    throw new GuideGoalError("Editing a queued approach cannot change its approved goal or controller.")
  }
  if (goalExecution === undefined) return createQueuedGuideJob(job.id, job.profile, prompt, job.placement)
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
  goalExecution?: GuideGoalCandidateContext,
): GuideQueueState => {
  const index = queue.entries.findIndex((job) => job.id === id)
  if (index >= 0) guardQueuePlacement(queue, placement, id)
  return index < 0
    ? queue
    : {
        ...queue,
        entries: queue.entries.map((job) => (job.id === id ? createQueuedGuideJob(id, profile, prompt, placement, goalExecution) : job)),
        selectedIndex: index,
      }
}

/** One dense line naming where a queued job will run, for the queue review screen. */
export const describeJobPlacement = (placement: JobPlacement): string => {
  if (placement.kind === "current-workspace-pane") return `pane here (split ${placement.direction})`
  if (placement.kind === "new-tab") return "new tab in this Herdr worktree"
  if (placement.kind === "new-worktree") return `new worktree ${placement.branch} from ${placement.baseRef}`
  return `existing worktree ${placement.path}`
}

const describeError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "An unknown error occurred."

const validatePlacement = (placement: JobPlacement): string | undefined => {
  if (placement.kind === "new-worktree") {
    if (placement.branch.trim().length === 0) return "Queued worktree branch must not be empty."
    if (placement.baseRef.trim().length === 0) return "Queued worktree base ref must not be empty."
  }
  if (placement.kind === "existing-worktree" && placement.path.trim().length === 0) {
    return "Queued worktree path must not be empty."
  }
  return undefined
}

const validateQueuedJob = (job: QueuedGuideJob): string | undefined => {
  if (!Number.isSafeInteger(job.id) || job.id < 1) return "Queue entry ID must be a positive integer."
  if (job.prompt.trim().length === 0) return "Queued prompt must not be empty."
  const maximumLength = job.goalExecution === undefined ? 8000 : guideGoalPromptMaximumLength
  if ([...job.prompt].length > maximumLength) return `Queued prompt exceeds ${maximumLength} characters.`
  const placementMessage = validatePlacement(job.placement)
  if (placementMessage !== undefined) return placementMessage
  try {
    const profile = parseSelectedProfile(job.profile)
    if (job.privatePrompt && job.goalExecution !== undefined) {
      return "Private prompt delivery does not support goal execution."
    }
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
  seenBranches: Set<string>,
): string | undefined => {
  if (seenIds.has(job.id)) return `Queue entry ID ${job.id} is duplicated.`
  if (job.placement.kind !== "new-worktree") return undefined
  const branch = job.placement.branch.trim()
  return seenBranches.has(branch) ? `Two queued jobs would both create branch ${branch}.` : undefined
}

const rememberEntry = (job: QueuedGuideJob, seenIds: Set<number>, seenBranches: Set<string>): void => {
  seenIds.add(job.id)
  if (job.placement.kind === "new-worktree") seenBranches.add(job.placement.branch.trim())
}

/** Turns one entry's placement into a pane. Every kind ends with a pane to launch into. */
const allocateJob = async (
  runner: CommandRunner,
  context: GuideBatchContext,
  placement: JobPlacement,
): Promise<{ readonly paneId: string; readonly cwd: string; readonly workspaceId: string }> => {
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
  const handle =
    placement.kind === "new-worktree"
      ? await createHerdrWorktree(runner, {
          primaryCheckoutPath: context.primaryCheckoutPath,
          branch: placement.branch,
          baseRef: placement.baseRef,
        })
      : await openHerdrWorktree(runner, { primaryCheckoutPath: context.primaryCheckoutPath, path: placement.path })
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
      const destination = await allocateJob(services.runner, context, item.job.placement)
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
  entry: Exclude<GuideBatchEntryResult, { readonly status: "launched" | "needs-input" }>,
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

/** Prints the per-entry outcome. The interactive guide prints this after Ink exits. */
export const writeGuideBatchSummary = (result: GuideBatchExecutionResult, write: (text: string) => void): void => {
  write(`Batch launch summary: ${result.entries.length} job${result.entries.length === 1 ? "" : "s"}\n`)
  for (const entry of result.entries) {
    if (entry.status === "launched" || entry.status === "needs-input") writeStartedJob(entry, write)
    else writeFailedJob(entry, write)
  }
}

export const guideBatchExitCode = (result: GuideBatchExecutionResult): number =>
  result.entries.some((entry) => entry.status !== "launched" && entry.status !== "needs-input")
    ? 1
    : result.entries.some((entry) => entry.status === "needs-input") ? 2 : 0

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

export const executeGuideBatch = async (
  batch: GuideBatch,
  services: GuideBatchExecutionServices,
): Promise<{ readonly exitCode: number; readonly result: GuideBatchExecutionResult }> => {
  if (batch.jobs.length === 0) {
    services.write("Batch queue is empty.\n")
    return { exitCode: 1, result: { entries: [] } }
  }

  const entries: Array<GuideBatchEntryResult | undefined> = new Array(batch.jobs.length)
  const structurallyValid: Array<LaunchableJob> = []
  const seenIds = new Set<number>()
  const seenBranches = new Set<string>()
  batch.jobs.forEach((job, index) => {
    const message =
      (job.privatePrompt && services.launchPrivate === undefined
        ? "Private prompt delivery is unavailable."
        : undefined) ??
      collidingEntryMessage(job, seenIds, seenBranches) ??
      validateQueuedJob(job)
    rememberEntry(job, seenIds, seenBranches)
    if (message === undefined) structurallyValid.push({ index, job })
    else {
      entries[index] = { job, status: "invalid", stage: "validation", message }
      report(services, job.id, "failed", message)
    }
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

  const result: GuideBatchExecutionResult = {
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
