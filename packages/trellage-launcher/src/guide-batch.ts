import {
  buildHerdrGuideLaunch,
  createHerdrWorktree,
  launchInHerdrPaneAndPrompt,
  parseSelectedProfile,
  splitHerdrPane,
  type CommandRunner,
  type CommandSpec,
  type HerdrPromptDeliveryMode,
  type HerdrSplitDirection,
  type SelectedProfile,
} from "./guide-launch.js"
import { checkSelectedProfileReadiness, ProfileReadinessKind } from "./guide-preflight.js"

const startupTimeoutMs = 60_000
const promptTimeoutMs = 60_000

export interface QueuedGuideJob {
  readonly id: number
  readonly profile: SelectedProfile
  readonly prompt: string
  readonly command: CommandSpec
  readonly promptDelivery: HerdrPromptDeliveryMode
}

export interface GuideQueueState {
  readonly entries: ReadonlyArray<QueuedGuideJob>
  readonly nextId: number
  readonly selectedIndex: number
  readonly editingId?: number
}

export type GuideBatchPolicy =
  | {
      readonly kind: "current-herdr-workspace"
      readonly workspaceId: string
      readonly cwd: string
      readonly callerPaneId: string
      readonly direction: HerdrSplitDirection
    }
  | {
      readonly kind: "fresh-herdr-worktree"
      readonly primaryCheckoutPath: string
      readonly branch: string
      readonly baseRef: string
    }

export interface GuideBatch {
  readonly jobs: ReadonlyArray<QueuedGuideJob>
  readonly policy: GuideBatchPolicy
}

export type GuideBatchEntryResult =
  | { readonly job: QueuedGuideJob; readonly status: "launched"; readonly paneId: string }
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
  readonly workspace:
    | { readonly status: "not-allocated" }
    | { readonly status: "existing"; readonly workspaceId: string }
    | { readonly status: "created"; readonly workspaceId: string; readonly checkoutPath: string }
    | { readonly status: "creation-failed"; readonly message: string }
  readonly entries: ReadonlyArray<GuideBatchEntryResult>
}

export interface GuideBatchExecutionServices {
  readonly runner: CommandRunner
  readonly write: (text: string) => void
}

export const emptyGuideQueue = (): GuideQueueState => ({ entries: [], nextId: 1, selectedIndex: 0 })

export const createQueuedGuideJob = (id: number, profile: SelectedProfile, prompt: string): QueuedGuideJob => {
  const built = buildHerdrGuideLaunch(profile, prompt)
  return { id, profile, prompt, command: built.command, promptDelivery: built.promptDelivery }
}

export const enqueueGuideJob = (
  queue: GuideQueueState,
  profile: SelectedProfile,
  prompt: string,
): GuideQueueState => ({
  entries: [...queue.entries, createQueuedGuideJob(queue.nextId, profile, prompt)],
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
  createQueuedGuideJob(job.id, job.profile, prompt)

export const submitQueuedGuidePromptEdit = (queue: GuideQueueState, prompt: string): GuideQueueState => {
  if (queue.editingId === undefined || prompt.trim().length === 0) return queue
  const { editingId, ...rest } = queue
  return {
    ...rest,
    entries: queue.entries.map((job) =>
      job.id === editingId ? replaceQueuedGuideJobPrompt(job, prompt) : job,
    ),
  }
}

export const removeSelectedQueuedGuideJob = (queue: GuideQueueState): GuideQueueState => {
  if (queue.entries[queue.selectedIndex] === undefined) return queue
  const entries = queue.entries.filter((_, index) => index !== queue.selectedIndex)
  return { entries, nextId: queue.nextId, selectedIndex: Math.min(queue.selectedIndex, Math.max(0, entries.length - 1)) }
}

const describeError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "An unknown error occurred."

const validateQueuedJob = (job: QueuedGuideJob): string | undefined => {
  if (!Number.isSafeInteger(job.id) || job.id < 1) return "Queue entry ID must be a positive integer."
  if (job.prompt.trim().length === 0) return "Queued prompt must not be empty."
  if ([...job.prompt].length > 8000) return "Queued prompt exceeds 8000 characters."
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

interface LaunchableJob {
  readonly index: number
  readonly job: QueuedGuideJob
}

interface AllocatedJob extends LaunchableJob {
  readonly paneId: string
  readonly cwd: string
}

const writeSummary = (services: GuideBatchExecutionServices, result: GuideBatchExecutionResult): void => {
  services.write(`Batch launch summary: ${result.entries.length} job${result.entries.length === 1 ? "" : "s"}\n`)
  for (const entry of result.entries) {
    const identity = `${entry.job.id}. ${entry.job.profile.profile}`
    if (entry.status === "launched") {
      services.write(`${identity}: launched in pane ${entry.paneId}\n`)
    } else {
      services.write(`${identity}: ${entry.stage} failed: ${entry.message}\nSelected prompt:\n\n${entry.job.prompt}\n`)
    }
  }
}

export const executeGuideBatch = async (
  batch: GuideBatch,
  services: GuideBatchExecutionServices,
): Promise<{ readonly exitCode: number; readonly result: GuideBatchExecutionResult }> => {
  if (batch.jobs.length === 0) {
    const result: GuideBatchExecutionResult = { workspace: { status: "not-allocated" }, entries: [] }
    services.write("Batch queue is empty.\n")
    return { exitCode: 1, result }
  }

  const entries: Array<GuideBatchEntryResult | undefined> = new Array(batch.jobs.length)
  const structurallyValid: Array<LaunchableJob> = []
  const seenIds = new Set<number>()
  batch.jobs.forEach((job, index) => {
    const message = seenIds.has(job.id) ? `Queue entry ID ${job.id} is duplicated.` : validateQueuedJob(job)
    seenIds.add(job.id)
    if (message === undefined) structurallyValid.push({ index, job })
    else entries[index] = { job, status: "invalid", stage: "validation", message }
  })

  const readiness = await Promise.all(
    structurallyValid.map(async (item) => {
      try {
        return { item, result: await checkSelectedProfileReadiness(services.runner, item.job.profile, policyCwd(batch.policy)) }
      } catch (error) {
        return { item, error }
      }
    }),
  )
  const launchable: Array<LaunchableJob> = []
  for (const checked of readiness) {
    if ("error" in checked) {
      entries[checked.item.index] = {
        job: checked.item.job,
        status: "not-ready",
        stage: "readiness",
        message: describeError(checked.error),
      }
    } else if (checked.result.kind === ProfileReadinessKind.Blocked) {
      entries[checked.item.index] = {
        job: checked.item.job,
        status: "not-ready",
        stage: "readiness",
        message: `${checked.result.summary}. ${checked.result.diagnostic}`,
      }
    } else launchable.push(checked.item)
  }

  let workspace: GuideBatchExecutionResult["workspace"] = { status: "not-allocated" }
  const allocated: Array<AllocatedJob> = []
  if (launchable.length > 0 && batch.policy.kind === "fresh-herdr-worktree") {
    try {
      const handle = await createHerdrWorktree(services.runner, batch.policy)
      workspace = { status: "created", workspaceId: handle.workspaceId, checkoutPath: handle.checkoutPath }
      const [first, ...rest] = launchable
      if (first !== undefined) allocated.push({ ...first, paneId: handle.rootPaneId, cwd: handle.checkoutPath })
      for (const item of rest) {
        try {
          const paneId = await splitHerdrPane(services.runner, {
            anchorPaneId: handle.rootPaneId,
            cwd: handle.checkoutPath,
            direction: "right",
          })
          allocated.push({ ...item, paneId, cwd: handle.checkoutPath })
        } catch (error) {
          entries[item.index] = {
            job: item.job,
            status: "allocation-failed",
            stage: "pane-allocation",
            message: describeError(error),
          }
        }
      }
    } catch (error) {
      const message = describeError(error)
      workspace = { status: "creation-failed", message }
      for (const item of launchable) {
        entries[item.index] = { job: item.job, status: "workspace-create-failed", stage: "worktree-create", message }
      }
    }
  } else if (launchable.length > 0) {
    const policy = batch.policy
    if (policy.kind !== "current-herdr-workspace") throw new Error("Unsupported batch workspace policy.")
    workspace = { status: "existing", workspaceId: policy.workspaceId }
    for (const item of launchable) {
      try {
        const paneId = await splitHerdrPane(services.runner, {
          anchorPaneId: policy.callerPaneId,
          cwd: policy.cwd,
          direction: policy.direction,
        })
        allocated.push({ ...item, paneId, cwd: policy.cwd })
      } catch (error) {
        entries[item.index] = {
          job: item.job,
          status: "allocation-failed",
          stage: "pane-allocation",
          message: describeError(error),
        }
      }
    }
  }

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
      }),
    ),
  )
  launches.forEach((launch, launchIndex) => {
    const item = allocated[launchIndex]
    if (item === undefined) return
    entries[item.index] =
      launch.status === "fulfilled"
        ? { job: item.job, status: "launched", paneId: item.paneId }
        : {
            job: item.job,
            status: "launch-failed",
            stage: "launch",
            paneId: item.paneId,
            message: describeError(launch.reason),
          }
  })

  const result: GuideBatchExecutionResult = {
    workspace,
    entries: entries.map((entry, index) => {
      if (entry !== undefined) return entry
      const job = batch.jobs[index]
      if (job === undefined) throw new Error("Batch result lost its queue entry.")
      return { job, status: "invalid", stage: "validation", message: "Batch entry was not processed." }
    }),
  }
  writeSummary(services, result)
  return { exitCode: result.entries.every((entry) => entry.status === "launched") ? 0 : 1, result }
}

const policyCwd = (policy: GuideBatchPolicy): string =>
  policy.kind === "current-herdr-workspace" ? policy.cwd : policy.primaryCheckoutPath
