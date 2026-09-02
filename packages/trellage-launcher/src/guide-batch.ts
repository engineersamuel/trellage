import {
  buildHerdrGuideLaunch,
  createHerdrTab,
  createHerdrWorktree,
  launchInHerdrPaneAndPrompt,
  openHerdrWorktree,
  parseSelectedProfile,
  splitHerdrPane,
  type CommandRunner,
  type CommandSpec,
  type HerdrLaunchPhase,
  type HerdrPromptDeliveryMode,
  type HerdrSplitDirection,
  type SelectedProfile,
} from "./guide-launch.js"
import { checkSelectedProfileReadiness, ProfileReadinessKind } from "./guide-preflight.js"

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

export type GuideBatchEntryResult =
  | {
      readonly job: QueuedGuideJob
      readonly status: "launched"
      readonly paneId: string
      readonly workspaceId: string
      readonly cwd: string
    }
  | { readonly job: QueuedGuideJob; readonly status: "invalid"; readonly stage: "validation"; readonly message: string }
  | { readonly job: QueuedGuideJob; readonly status: "not-ready"; readonly stage: "readiness"; readonly message: string }
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
      readonly message: string
    }

export interface GuideBatchExecutionResult {
  readonly entries: ReadonlyArray<GuideBatchEntryResult>
}

/** One step of one queued job, so a caller can narrate the launch while it runs. */
export type GuideBatchPhase = "checking" | "allocating" | "starting" | "waiting" | "prompting" | "done" | "failed"

export interface GuideBatchProgressEvent {
  readonly jobId: number
  readonly phase: GuideBatchPhase
  readonly detail: string
}

export interface GuideBatchExecutionServices {
  readonly runner: CommandRunner
  readonly write: (text: string) => void
  readonly onProgress?: (event: GuideBatchProgressEvent) => void
}

export const emptyGuideQueue = (): GuideQueueState => ({ entries: [], nextId: 1, selectedIndex: 0 })

export const createQueuedGuideJob = (
  id: number,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
): QueuedGuideJob => {
  const built = buildHerdrGuideLaunch(profile, prompt)
  return { id, profile, prompt, command: built.command, promptDelivery: built.promptDelivery, placement }
}

export const enqueueGuideJob = (
  queue: GuideQueueState,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
): GuideQueueState => ({
  entries: [...queue.entries, createQueuedGuideJob(queue.nextId, profile, prompt, placement)],
  nextId: queue.nextId + 1,
  selectedIndex: queue.entries.length,
})

export const selectQueuedGuideJob = (queue: GuideQueueState, delta: 1 | -1): GuideQueueState =>
  queue.entries.length === 0
    ? queue
    : { ...queue, selectedIndex: (queue.selectedIndex + delta + queue.entries.length) % queue.entries.length }

export const startQueuedGuidePromptEdit = (queue: GuideQueueState): GuideQueueState => {
  const selected = queue.entries[queue.selectedIndex]
  return selected === undefined ? queue : { ...queue, editingId: selected.id }
}

export const replaceQueuedGuideJobPrompt = (job: QueuedGuideJob, prompt: string): QueuedGuideJob =>
  createQueuedGuideJob(job.id, job.profile, prompt, job.placement)

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
): GuideQueueState => {
  const index = queue.entries.findIndex((job) => job.id === id)
  return index < 0
    ? queue
    : {
        ...queue,
        entries: queue.entries.map((job) => (job.id === id ? createQueuedGuideJob(id, profile, prompt, placement) : job)),
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
  if ([...job.prompt].length > 8000) return "Queued prompt exceeds 8000 characters."
  const placementMessage = validatePlacement(job.placement)
  if (placementMessage !== undefined) return placementMessage
  try {
    const profile = parseSelectedProfile(job.profile)
    const built = buildHerdrGuideLaunch(profile, job.prompt)
    if (
      built.promptDelivery !== job.promptDelivery ||
      built.command.executable !== job.command.executable ||
      built.command.args.length !== job.command.args.length ||
      built.command.args.some((arg, index) => arg !== job.command.args[index])
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
      allocated.push({ ...item, ...(await allocateJob(services.runner, context, item.job.placement)) })
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
        return { item, result: await checkSelectedProfileReadiness(services.runner, item.job.profile, context.cwd) }
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
      entries[outcome.item.index] = { job: outcome.item.job, status: "not-ready", stage: "readiness", message }
      report(services, outcome.item.job.id, "failed", message)
    }
  }
  return launchable
}

/** Prints the per-entry outcome. The interactive guide prints this after Ink exits. */
export const writeGuideBatchSummary = (
  result: GuideBatchExecutionResult,
  write: (text: string) => void,
): void => {
  write(`Batch launch summary: ${result.entries.length} job${result.entries.length === 1 ? "" : "s"}\n`)
  for (const entry of result.entries) {
    const identity = `${entry.job.id}. ${entry.job.profile.profile}`
    if (entry.status === "launched") {
      write(`${identity}: launched in pane ${entry.paneId} · ${entry.cwd}\n`)
    } else {
      write(
        `${identity} (${describeJobPlacement(entry.job.placement)}): ${entry.stage} failed: ${entry.message}\nSelected prompt:\n\n${entry.job.prompt}\n`,
      )
    }
  }
}

export const guideBatchExitCode = (result: GuideBatchExecutionResult): number =>
  result.entries.every((entry) => entry.status === "launched") ? 0 : 1

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
    const message = collidingEntryMessage(job, seenIds, seenBranches) ?? validateQueuedJob(job)
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
      launchInHerdrPaneAndPrompt(services.runner, {
        paneId: item.paneId,
        cwd: item.cwd,
        command: item.job.command,
        prompt: item.job.prompt,
        promptDelivery: item.job.promptDelivery,
        timeoutMs: startupTimeoutMs,
        promptTimeoutMs,
        onPhase: (phase) => report(services, item.job.id, phase, launchPhaseDetail[phase]),
      }),
    ),
  )
  launches.forEach((launch, launchIndex) => {
    const item = allocated[launchIndex]
    if (item === undefined) return
    if (launch.status === "fulfilled") {
      entries[item.index] = {
        job: item.job,
        status: "launched",
        paneId: item.paneId,
        workspaceId: item.workspaceId,
        cwd: item.cwd,
      }
      report(services, item.job.id, "done", `Launched in pane ${item.paneId}`)
      return
    }
    const message = describeError(launch.reason)
    entries[item.index] = { job: item.job, status: "launch-failed", stage: "launch", paneId: item.paneId, message }
    report(services, item.job.id, "failed", message)
  })

  const result: GuideBatchExecutionResult = {
    entries: entries.map((entry, index) => {
      if (entry !== undefined) return entry
      const job = batch.jobs[index]
      if (job === undefined) throw new Error("Batch result lost its queue entry.")
      return { job, status: "invalid", stage: "validation", message: "Batch entry was not processed." }
    }),
  }
  writeGuideBatchSummary(result, services.write)
  return { exitCode: guideBatchExitCode(result), result }
}
