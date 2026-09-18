import {
  FIRSTMATE_MAX_REQUEST_BYTES,
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  parseFirstmateSubmissionRequestV1,
  sameFirstmateFleet,
  sameFirstmateInstance,
  type FirstmateFleetReadinessV1,
  type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import type {
  FirstmateGuideAction,
  GuideBatchContext,
  GuideBatchEntryResult,
  GuideBatchExecutionResult,
  GuideBatchExecutionServices,
  GuideBatchPhase,
  QueuedGuideJob,
} from "./guide-batch.ts"
import { validateFirstmatePromptFrame } from "./guide-context.ts"
import { FirstmateSubmissionClient, firstmateOutcomeFromReceipt, firstmateSupervisorStatusText, type FirstmateSubmissionOutcome } from "./guide-firstmate.ts"
import {
  buildFirstmateSupervisorCommand,
  validateFirstmateTerminalHandoff,
  type FirstmateTerminalHandoff,
} from "./guide-firstmate-terminal.ts"
import {
  FirstmateJournalError,
  FirstmateJournalErrorCode,
  type FirstmateJournalEntry,
  type FirstmateSubmissionJournal,
} from "./guide-firstmate-journal.ts"
import {
  launchInHerdrPane,
  parseSelectedProfile,
  validateGitBranchName,
  type CommandRunner,
  type NativeSelectedProfile,
  type TimeController,
} from "./guide-launch.ts"
import { firstmateActionReadiness, inspectFirstmateReadiness, ProfileReadinessKind } from "./guide-preflight.ts"
import { selectedFirstmateInstance } from "./guide-firstmate-instance-selection.ts"

export interface FirstmateBatchItem {
  readonly index: number
  readonly job: QueuedGuideJob
}

interface RequestItem extends FirstmateBatchItem {
  readonly request: FirstmateSubmissionRequestV1
}

interface FleetGroup {
  readonly items: ReadonlyArray<RequestItem>
  readonly profile: NativeSelectedProfile
  readonly starter?: RequestItem
}

interface Destination {
  readonly paneId: string
  readonly workspaceId: string
  readonly cwd: string
}

interface GroupOperations {
  readonly journal: () => FirstmateSubmissionJournal
  readonly allocate: (job: QueuedGuideJob) => Promise<Destination>
}

type AcceptedResult = Extract<GuideBatchEntryResult, { status: "accepted" }>
type SupervisorState = AcceptedResult["supervisor"]

const systemTime: TimeController = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

const describeError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "An unknown error occurred."

export const isFirstmateBatchJob = (job: QueuedGuideJob): boolean =>
  job.firstmate !== undefined ||
  (job.profile?.surface === "native" && job.profile.launcher === "fmx" && job.profile.orchestration !== undefined)

const selectedFirstmateProfile = (job: QueuedGuideJob): NativeSelectedProfile => {
  const profile = parseSelectedProfile(job.profile)
  if (profile.surface !== "native" || profile.launcher !== "fmx" || profile.orchestration === undefined) {
    throw new Error("Firstmate queue delivery requires a native fmx profile with a supported orchestration contract.")
  }
  return profile
}

const validateActionPlacement = (job: QueuedGuideJob): FirstmateGuideAction => {
  const action = job.firstmate?.action
  if (action !== "start" && action !== "recover" && action !== "submit") {
    throw new Error("Choose Start fleet, Recover fleet, or Send work explicitly before queue delivery.")
  }
  if ((action === "submit") !== (job.placement.kind === "existing-fleet")) {
    throw new Error("Send work requires an existing-fleet placement; Start and Recover require an explicit supervisor destination.")
  }
  return action
}

const requireWorkflowContext = (job: QueuedGuideJob) => {
  const context = job.guideContext
  if (context === undefined) throw new Error("Firstmate delivery requires the confirmed original intent, workflow, and project context.")
  const workflow = context.workflow
  if (workflow.id !== context.workflowId || workflow.frame !== "fixed") {
    throw new Error("Firstmate delivery requires the selected workflow ID and its fixed contextual frame.")
  }
  if (workflow.scope !== undefined && workflow.scope !== "fleet" && workflow.scope !== "project") {
    throw new Error("Firstmate workflow scope is not supported.")
  }
  if (workflow.scope !== "fleet" && context.projectTarget === null) {
    throw new Error("A project workflow requires a confirmed project target.")
  }
  return context
}

const validateRequestFrame = (job: QueuedGuideJob, profile: NativeSelectedProfile): void => {
  const context = requireWorkflowContext(job)
  validateFirstmatePromptFrame(`native:fmx/${profile.profile}`, context.workflow, job.prompt, {
    originalIntent: context.originalIntent,
    projectTarget: context.projectTarget,
    orchestration: profile.orchestration!,
  })
}

const requestForJob = (job: QueuedGuideJob, profile: NativeSelectedProfile): FirstmateSubmissionRequestV1 => {
  validateActionPlacement(job)
  validateRequestFrame(job, profile)
  if (job.firstmate?.expectedFleet === undefined) {
    throw new Error("Confirm the expected owned fleet identity before Firstmate execution; the current fleet cannot replace it.")
  }
  const context = job.guideContext!
  const original: FirstmateSubmissionRequestV1 = {
    schemaVersion: 1,
    requestId: job.firstmate.requestId,
    expectedFleet: job.firstmate.expectedFleet,
    originalIntent: context.originalIntent,
    generatedSpec: job.prompt,
    workflowId: context.workflowId,
    projectTarget: context.projectTarget,
  }
  const request = parseFirstmateSubmissionRequestV1(original)
  if (canonicalFirstmateJson(request) !== canonicalFirstmateJson(original)) {
    throw new Error("Firstmate request fields must be valid without changing the confirmed content.")
  }
  if (request.expectedFleet.profile !== profile.profile ||
      request.expectedFleet.sourceRevision !== profile.orchestration!.sourceRevision) {
    throw new Error("The confirmed fleet does not match the selected Firstmate profile and source revision.")
  }
  selectedFirstmateInstance(profile, request.expectedFleet)
  if (Buffer.byteLength(canonicalFirstmateJson(request), "utf8") >
      Math.min(FIRSTMATE_MAX_REQUEST_BYTES, profile.orchestration!.submission.maxRequestBytes)) {
    throw new Error("The complete Firstmate request exceeds the profile's canonical byte limit.")
  }
  return request
}

const supervisorPlacementKey = (job: QueuedGuideJob): string => {
  const placement = job.placement
  switch (placement.kind) {
    case "current-workspace-pane": return JSON.stringify([placement.kind, placement.direction])
    case "new-worktree": return JSON.stringify([placement.kind, placement.branch, placement.baseRef])
    case "existing-worktree": return JSON.stringify([placement.kind, placement.path])
    default: return placement.kind
  }
}

const validateGroup = (items: ReadonlyArray<FirstmateBatchItem>): FleetGroup => {
  const first = items[0]
  if (first === undefined) throw new Error("A Firstmate fleet group must not be empty.")
  const profile = selectedFirstmateProfile(first.job)
  const requests = items.map((item) => {
    const selected = selectedFirstmateProfile(item.job)
    if (selected.profile !== profile.profile || selected.commandPath !== profile.commandPath ||
        JSON.stringify(selected.orchestration) !== JSON.stringify(profile.orchestration) ||
        JSON.stringify(selected.firstmateInstanceContext) !== JSON.stringify(profile.firstmateInstanceContext)) {
      throw new Error("One Firstmate profile cannot use mixed command paths, source pins, or orchestration controls.")
    }
    return { ...item, request: requestForJob(item.job, selected) }
  })
  const expected = requests[0]!.request.expectedFleet
  const reference = selectedFirstmateInstance(profile, expected)
  if (requests.some(({ job, request }) =>
    !sameFirstmateInstance(reference, selectedFirstmateInstance(selectedFirstmateProfile(job), request.expectedFleet)))) {
    throw new Error("One fleet UUID cannot use conflicting instance modes or references.")
  }
  if (requests.some(({ request }) => !sameFirstmateFleet(request.expectedFleet, expected))) {
    throw new Error("One Firstmate profile cannot use different confirmed fleet instances or homes.")
  }
  const firstRequest = requests[0]!
  if (requests.some(({ job }) =>
    job.firstmate!.action !== firstRequest.job.firstmate!.action || supervisorPlacementKey(job) !== supervisorPlacementKey(firstRequest.job))) {
    throw new Error("One fleet group cannot mix actions or supervisor destinations. Use one shared action and placement.")
  }
  const starter = firstRequest.job.firstmate!.action === "submit" ? undefined : firstRequest
  return { items: requests, profile, ...(starter === undefined ? {} : { starter }) }
}

const requireGroupReadiness = (group: FleetGroup, fleet: FirstmateFleetReadinessV1): void => {
  if (!fleet.actions.submit.allowed) {
    throw new Error(`Firstmate cannot save requests: ${fleet.actions.submit.reason ?? "submission is not permitted."}`)
  }
  const action = fleet.supervisor.state === "running" ? "submit" : group.starter?.job.firstmate!.action ?? "submit"
  const readiness = firstmateActionReadiness(group.profile, fleet, action)
  if (readiness.kind === ProfileReadinessKind.Blocked) {
    throw new Error(`${readiness.summary}. ${readiness.diagnostic}`)
  }
}

class FleetIdentityChangedError extends Error {}

const checkedTiming = (services: GuideBatchExecutionServices): { timeoutMs: number; pollIntervalMs: number } => {
  const timeoutMs = services.firstmateStartupTimeoutMs ?? 60_000
  const pollIntervalMs = services.firstmatePollIntervalMs ?? 250
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000) {
    throw new Error("Firstmate startup timeout and poll interval must be between 1 and 60000 milliseconds.")
  }
  return { timeoutMs, pollIntervalMs }
}

class FleetGroupExecution {
  private readonly results = new Map<number, GuideBatchEntryResult>()
  private readonly records = new Map<number, FirstmateJournalEntry>()
  private readonly client: FirstmateSubmissionClient
  private readonly time: TimeController
  private fleet: FirstmateFleetReadinessV1 | undefined
  private terminalHandoff: FirstmateTerminalHandoff | undefined

  constructor(
    private readonly group: FleetGroup,
    private readonly context: GuideBatchContext,
    private readonly services: GuideBatchExecutionServices,
    private readonly journal: FirstmateSubmissionJournal,
    private readonly operations: GroupOperations,
    private readonly timing: { readonly timeoutMs: number; readonly pollIntervalMs: number },
  ) {
    this.client = new FirstmateSubmissionClient(services.runner, group.profile, context.cwd)
    this.time = services.firstmateTime ?? systemTime
  }

  private report(item: RequestItem, phase: GuideBatchPhase, detail: string): void {
    this.services.onProgress?.({ jobId: item.job.id, phase, detail })
  }

  private outcomeResult(item: RequestItem, outcome: FirstmateSubmissionOutcome): GuideBatchEntryResult {
    if (outcome.status === "accepted") {
      return {
        job: item.job, status: "accepted", request: item.request, receipt: outcome.receipt, supervisor: outcome.receipt.supervisorState,
        ...(item.job.placement.kind === "current-terminal" ? { cwd: this.context.cwd } : {}),
      }
    }
    return {
      job: item.job, request: item.request, stage: "submission",
      status: outcome.status === "rejected" ? "submission-rejected" : "submission-unknown",
      message: outcome.message,
      ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt }),
    }
  }

  private remember(item: RequestItem, entry: FirstmateJournalEntry): void {
    if (entry.digest !== firstmateSubmissionDigest(item.request) ||
        canonicalFirstmateJson(entry.request) !== canonicalFirstmateJson(item.request)) {
      throw new Error("The durable Firstmate entry does not match the original request ID and payload.")
    }
    if (entry.status === "accepted") {
      const outcome = firstmateOutcomeFromReceipt(item.request, entry.receipt)
      if (outcome.status !== "accepted") throw new Error("The durable Firstmate acceptance has no valid same-request receipt.")
      this.results.set(item.index, this.outcomeResult(item, outcome))
    } else if (entry.status !== "prepared") {
      this.results.set(item.index, {
        job: item.job, request: item.request, stage: "submission",
        status: entry.status === "rejected" ? "submission-rejected" : "submission-unknown",
        message: entry.message,
        ...(entry.receipt === null ? {} : { receipt: entry.receipt }),
      })
    }
    this.records.set(item.index, entry)
  }

  private async update(item: RequestItem, entry: FirstmateJournalEntry): Promise<void> {
    this.remember(item, entry)
    await this.services.onFirstmateUpdate?.(item.job, entry)
  }

  private rememberFailure(item: RequestItem, message: string): void {
    const previous = this.results.get(item.index)
    if (previous?.status === "accepted") {
      this.results.set(item.index, { ...previous, startupError: message })
    } else if (previous?.status === "submission-unknown" || previous?.status === "submission-rejected") {
      this.results.set(item.index, { ...previous, message: `${previous.message} ${message}` })
    } else {
      this.results.set(item.index, { job: item.job, status: "not-submitted", stage: "submission", message })
    }
  }

  private failItem(item: RequestItem, message: string): void {
    this.rememberFailure(item, message)
    this.report(item, "failed", message)
  }

  private finish(reason?: string): GuideBatchExecutionResult {
    const entries: ReadonlyArray<GuideBatchEntryResult> = this.group.items.map((item) => {
      const result = this.results.get(item.index)
      if (result?.status === "accepted" && reason !== undefined && this.group.starter !== undefined &&
          result.supervisor !== "running" && result.startupError === undefined) {
        return { ...result, startupError: `Supervisor startup was not attempted. ${reason}` }
      }
      return result ?? {
        job: item.job, status: "not-submitted", stage: "submission",
        message: reason ?? "This request was not submitted.",
      }
    })
    return { entries, ...(this.terminalHandoff === undefined ? {} : { firstmateTerminalHandoff: this.terminalHandoff }) }
  }

  private async prepareAll(): Promise<string | undefined> {
    for (const item of this.group.items) {
      this.report(item, "saving", `Saving durable request ${item.request.requestId}`)
      try {
        await this.update(item, await this.journal.prepare(item.request))
      } catch (error) {
        const message = `Durable request preparation or its status update failed: ${describeError(error)}`
        this.failItem(item, message)
        return message
      }
    }
    return undefined
  }

  private async inspect(signal?: AbortSignal): Promise<FirstmateFleetReadinessV1> {
    this.fleet = undefined
    const fleet = await inspectFirstmateReadiness(this.services.runner, this.group.profile, this.context.cwd, signal)
    if (fleet.identity === null || !sameFirstmateFleet(fleet.identity, this.group.items[0]!.request.expectedFleet)) {
      throw new FleetIdentityChangedError("The owned Firstmate fleet identity changed. The confirmed instance, home, and source must not be replaced.")
    }
    this.fleet = fleet
    return fleet
  }

  private supervisor(state: SupervisorState, startupError?: string, destination?: Destination): void {
    for (const [index, result] of this.results) {
      if (result.status !== "accepted") continue
      this.results.set(index, {
        ...result, supervisor: state,
        ...(startupError === undefined ? {} : { startupError }),
        ...(destination === undefined ? {} : destination),
      })
    }
  }

  private async checkReadiness(): Promise<boolean> {
    for (const item of this.group.items) this.report(item, "checking", "Checking the confirmed owned fleet and action")
    try {
      const fleet = await this.inspect()
      requireGroupReadiness(this.group, fleet)
      this.supervisor(fleet.supervisor.state)
      return true
    } catch (error) {
      const message = describeError(error)
      this.supervisor(this.fleet?.supervisor.state ?? "unknown", message)
      for (const item of this.group.items) {
        const result = this.results.get(item.index)
        if (result === undefined) this.results.set(item.index, { job: item.job, status: "not-ready", stage: "readiness", message })
        else if (result.status === "submission-unknown") this.results.set(item.index, { ...result, message: `${result.message} ${message}` })
        this.report(item, "failed", message)
      }
      return false
    }
  }

  private async transport(item: RequestItem, operation: "submit" | "receipt"): Promise<FirstmateSubmissionOutcome> {
    try {
      return await this.client[operation](item.request)
    } catch (error) {
      return { status: "unknown", message: describeError(error) }
    }
  }

  private async record(item: RequestItem, outcome: FirstmateSubmissionOutcome): Promise<FirstmateJournalEntry> {
    this.results.set(item.index, this.outcomeResult(item, outcome))
    const saved = await this.journal.record(item.request, outcome)
    await this.update(item, saved)
    return saved
  }

  private accepted(item: RequestItem, entry: FirstmateJournalEntry): boolean {
    const result = this.results.get(item.index)
    return entry.status === "accepted" && entry.receipt !== null && entry.receipt.announcement !== "failed" &&
      result?.status === "accepted" && result.supervisor !== "unsafe" &&
      (this.group.starter !== undefined || result.supervisor === "running")
  }

  private async reconcile(item: RequestItem): Promise<boolean> {
    this.report(item, "reconciling", `Checking the same request ID ${item.request.requestId}; no resubmission`)
    return this.accepted(item, await this.record(item, await this.transport(item, "receipt")))
  }

  private async begin(item: RequestItem): Promise<boolean> {
    let entry: FirstmateJournalEntry
    try {
      entry = await this.journal.begin(item.request)
    } catch (error) {
      if (!(error instanceof FirstmateJournalError) || error.code !== FirstmateJournalErrorCode.AttemptProtected) throw error
      const existing = await this.journal.get(item.request.requestId)
      if (existing === undefined) throw new Error("The protected Firstmate request has no durable record. Do not submit again.")
      await this.update(item, existing)
      return false
    }
    await this.update(item, entry)
    return true
  }

  private async resume(item: RequestItem): Promise<boolean> {
    const entry = this.records.get(item.index)!
    if (entry.status === "accepted") return this.accepted(item, entry)
    if (entry.status === "rejected") return false
    if (entry.status === "prepared") throw new Error("The durable submission claim was not acquired; nothing was sent.")
    return this.reconcile(item)
  }

  private async save(item: RequestItem): Promise<boolean> {
    if (this.records.get(item.index)!.status !== "prepared") return this.resume(item)
    this.report(item, "saving", `Submitting request ${item.request.requestId} once`)
    if (!(await this.begin(item))) return this.resume(item)
    const saved = await this.record(item, await this.transport(item, "submit"))
    if (saved.status === "accepted") return this.accepted(item, saved)
    if (saved.status === "rejected") return false
    return this.reconcile(item)
  }

  private reportAcceptance(item: RequestItem): void {
    const result = this.results.get(item.index)
    if (result?.status !== "accepted") throw new Error("A request needs accepted evidence before reporting its supervisor status.")
    this.report(item, result.supervisor === "running" ? "done" : "waiting",
      `Request ${item.request.requestId} accepted; ${firstmateSupervisorStatusText(result.supervisor)}. ` +
      "Dispatch and task completion are not confirmed.")
  }

  private async saveAll(): Promise<string | undefined> {
    for (const item of this.group.items) {
      try {
        if (!(await this.save(item))) {
          const message = `Request ${item.request.requestId} stopped this fleet group. Resolve its receipt, supervisor state, or announcement before further submission or startup.`
          this.report(item, "failed", message)
          return message
        }
        this.reportAcceptance(item)
      } catch (error) {
        const message = `Firstmate journal or status update failed: ${describeError(error)}`
        this.failItem(item, message)
        return message
      }
    }
    return undefined
  }

  private startupRunner(timeoutMs: number): CommandRunner {
    return {
      run: (executable, args, options) => this.services.runner.run(executable, args, { ...options, timeoutMs }),
    }
  }

  private async waitForSupervisor(deadline: number): Promise<void> {
    let diagnostic = "The owned supervisor is not running."
    do {
      try {
        const remaining = Math.max(1, Math.ceil(deadline - this.time.now()))
        const fleet = await this.inspect(AbortSignal.timeout(remaining))
        const readiness = firstmateActionReadiness(this.group.profile, fleet, "submit")
        if (readiness.kind === ProfileReadinessKind.Ready) return
        diagnostic = readiness.diagnostic
      } catch (error) {
        if (error instanceof FleetIdentityChangedError) throw error
        diagnostic = describeError(error)
      }
      if (this.time.now() >= deadline) break
      await this.time.sleep(Math.min(this.timing.pollIntervalMs, deadline - this.time.now()))
    } while (this.time.now() <= deadline)
    throw new Error(`Supervisor startup was not confirmed within ${this.timing.timeoutMs} ms. ${diagnostic}`)
  }

  private async launchSupervisor(starter: RequestItem): Promise<void> {
    const fleet = await this.inspect()
    requireGroupReadiness(this.group, fleet)
    this.supervisor(fleet.supervisor.state)
    if (fleet.supervisor.state === "running") return
    this.report(starter, "allocating", "Allocating one shared supervisor destination")
    const destination = await this.operations.allocate(starter.job)
    this.supervisor(fleet.supervisor.state, undefined, destination)
    for (const item of this.group.items) await this.services.onAllocated?.(item.job, destination)
    const beforeLaunch = await this.inspect()
    requireGroupReadiness(this.group, beforeLaunch)
    this.supervisor(beforeLaunch.supervisor.state)
    if (beforeLaunch.supervisor.state === "running") return
    const deadline = this.time.now() + this.timing.timeoutMs
    let launchError: string | undefined
    try {
      await launchInHerdrPane(this.startupRunner(this.timing.timeoutMs), {
        paneId: destination.paneId,
        cwd: destination.cwd,
        command: buildFirstmateSupervisorCommand(this.group.profile, this.group.items[0]!.request.expectedFleet),
        onPhase: () => this.report(starter, "starting", "Starting one Firstmate supervisor without a task prompt"),
      })
    } catch (error) {
      launchError = describeError(error)
    }
    this.report(starter, "waiting", "Verifying the same owned Firstmate supervisor")
    try {
      await this.waitForSupervisor(deadline)
    } catch (error) {
      throw new Error(`${describeError(error)}${launchError === undefined ? "" : ` Pane launch: ${launchError}`}`)
    }
    this.supervisor("running")
  }

  private async prepareTerminalHandoff(starter: RequestItem): Promise<void> {
    const fleet = await this.inspect()
    requireGroupReadiness(this.group, fleet)
    this.supervisor(fleet.supervisor.state)
    const action = starter.job.firstmate!.action
    if (action !== "start" && action !== "recover") throw new Error("A terminal handoff requires Start or Recover.")
    const handoff = validateFirstmateTerminalHandoff({
      kind: "current-terminal", status: "handoff-ready",
      expectedFleet: this.group.items[0]!.request.expectedFleet,
      profile: this.group.profile, action, cwd: this.context.cwd,
      requestIds: this.group.items.map(({ request }) => request.requestId),
    }, this.finish().entries)
    for (const item of this.group.items) {
      this.report(item, "waiting",
        `Request ${item.request.requestId} saved; current-terminal handoff ready after the guide exits. ` +
        "Dispatch and task completion are not confirmed.")
    }
    this.terminalHandoff = handoff
  }

  private async handoffOrLaunchSupervisor(starter: RequestItem): Promise<void> {
    if (starter.job.placement.kind === "current-terminal") {
      await this.prepareTerminalHandoff(starter)
      return
    }
    await this.launchSupervisor(starter)
    for (const item of this.group.items) this.reportAcceptance(item)
  }

  private async execute(): Promise<GuideBatchExecutionResult> {
    const preparationFailure = await this.prepareAll()
    if (preparationFailure !== undefined) return this.finish(preparationFailure)
    if (!(await this.checkReadiness())) return this.finish()
    const savingFailure = await this.saveAll()
    if (savingFailure !== undefined) return this.finish(savingFailure)
    const starter = this.group.starter
    if (starter !== undefined) {
      try {
        await this.handoffOrLaunchSupervisor(starter)
      } catch (error) {
        const message = describeError(error)
        this.supervisor(this.fleet?.supervisor.state ?? "unknown", message)
        this.report(starter, "failed", message)
      }
    }
    return this.finish()
  }

  async run(): Promise<GuideBatchExecutionResult> {
    try {
      return await this.execute()
    } catch (error) {
      const message = `Firstmate execution stopped: ${describeError(error)}`
      for (const item of this.group.items) this.rememberFailure(item, message)
      return this.finish(message)
    }
  }
}

export const executeFirstmateBatchGroup = async (
  items: ReadonlyArray<FirstmateBatchItem>,
  context: GuideBatchContext,
  services: GuideBatchExecutionServices,
  operations: GroupOperations,
): Promise<GuideBatchExecutionResult> => {
  let group: FleetGroup
  let timing: ReturnType<typeof checkedTiming>
  try {
    group = validateGroup(items)
    timing = checkedTiming(services)
    const placement = group.starter?.job.placement
    if (placement?.kind === "new-worktree") {
      await validateGitBranchName(services.runner, context.primaryCheckoutPath!, placement.branch)
    }
  } catch (error) {
    return { entries: items.map(({ job }) => ({ job, status: "invalid", stage: "validation", message: describeError(error) })) }
  }
  let execution: FleetGroupExecution
  try {
    execution = new FleetGroupExecution(group, context, services, operations.journal(), operations, timing)
  } catch (error) {
    return { entries: items.map(({ job }) => ({
      job, status: "not-submitted", stage: "submission",
      message: `Firstmate execution could not preserve durable state: ${describeError(error)}`,
    })) }
  }
  return execution.run()
}
