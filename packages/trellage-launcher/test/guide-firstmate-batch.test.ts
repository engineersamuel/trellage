import { describe, expect, it, vi } from "vitest"
import {
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  parseFirstmateFleetIdentityV1,
  parseFirstmateFleetReadinessV1,
  parseFirstmateOrchestrationV1,
  parseFirstmateReceiptRequestV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  parseGuideProjectTargetV1,
  sameFirstmateFleet,
  type FirstmateFleetIdentityV1,
  type FirstmateFleetReadinessV1,
  type FirstmateSubmissionReceiptV1,
  type FirstmateSubmissionRequestV1,
  type GuideProjectTargetV1,
  type ProfileGuideV1,
} from "@trellage/guide-core"
import {
  createQueuedGuideJob,
  executeGuideBatch,
  guideBatchRequiresHerdr,
  type FirstmateGuideAction,
  type GuideBatchContext,
  type GuideBatchExecutionResult,
  type GuideBatchExecutionServices,
  type FirstmateTerminalHandoff,
  type JobPlacement,
  type QueuedGuideJob,
} from "../src/guide-batch.ts"
import { prepareGuidePrompt } from "../src/guide-context.ts"
import { executeGuideUiResult, type GuideInteractiveExecutionServices } from "../src/guide-interactive-execution.ts"
import type { FirstmateSubmissionOutcome } from "../src/guide-firstmate.ts"
import {
  FileFirstmateSubmissionJournal,
  FirstmateJournalError,
  FirstmateJournalErrorCode,
  type FirstmateJournalEntry,
  type FirstmateJournalStatus,
  type FirstmateSubmissionJournal,
} from "../src/guide-firstmate-journal.ts"
import {
  CommandRunnerError,
  renderCommandPreview,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
  type NativeSelectedProfile,
  type TimeController,
} from "../src/guide-launch.ts"
import { renderWorkflowBodyCandidate, workflowPromptFrame } from "../src/guide-workflow-prompt.ts"

type ProfileName = "default" | "pstack-workers"
const sourceRevision = "b".repeat(40)
const uuid = (id: number): string => `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`
const identity = (profile: ProfileName): FirstmateFleetIdentityV1 => ({
  profile, instanceId: uuid(profile === "default" ? 100 : 200),
  home: `/fixture/fleets/${profile}/home`, sourceRevision,
})
const selected = (profile: ProfileName): NativeSelectedProfile => ({
  surface: "native", launcher: "fmx", commandPath: "/fixture/bin/fmx", profile, headlessPrompt: false,
  orchestration: parseFirstmateOrchestrationV1({
    schemaVersion: 1, kind: "firstmate", sourceRevision,
    taskIdPrefix: profile === "default" ? "fmd" : "fmp",
    workerPolicy: profile === "default" ? null : { name: "pstack-workers", digest: "c".repeat(64) },
    workerHarness: "claude", workerEfforts: ["low", "medium", "high"], dispatchRules: "claude-single",
    submission: { schemaVersion: 1, maxRequestBytes: 524288 },
  }),
})
const allowed = { allowed: true, reason: null } as const
const refused = (reason = "This action is not allowed.") => ({ allowed: false, reason })
const fleet = (
  profile: ProfileName,
  state: "running" | "stopped" | "stale" = "running",
  backend: "herdr" | "tmux" = "herdr",
  activeWorkers = state === "stopped" ? 0 : 3,
): FirstmateFleetReadinessV1 => parseFirstmateFleetReadinessV1({
  schemaVersion: 1, identity: identity(profile), runtime: "ready", backend,
  supervisor: { state, pid: state === "running" ? 3456 : null }, activeWorkers,
  prerequisites: [{ id: backend, ready: true, description: `${backend} is available.` }],
  consentRequired: false,
  actions: {
    start: state === "stopped" && activeWorkers === 0 ? allowed : refused(),
    recover: state === "stale" ? allowed : refused(),
    submit: allowed,
  },
})
const guide: ProfileGuideV1 = {
  schemaVersion: 1, capabilities: [], bestFor: [], avoidFor: [], prerequisites: [],
  workflows: [
    {
      id: "fleet-status", frame: "fixed", scope: "fleet", description: "Read fleet status.",
      promptTemplate: "Read the existing fleet.\n\nSpecification:\n{{intent}}\n\nReport observations only.",
      examples: ["Read the fleet.", "Show pending decisions."],
    },
    {
      id: "project-review", frame: "fixed", scope: "project", description: "Review a confirmed project.",
      promptTemplate: "Review the confirmed project.\n\nSpecification:\n{{intent}}\n\nKeep the human's restrictions.",
      examples: ["Review project C.", "Inspect the selected project."],
    },
  ],
}
const projectC = parseGuideProjectTargetV1({
  schemaVersion: 1, projectName: null, source: { kind: "local", location: "/fixture/project-c" },
  entryWorktree: "/fixture/project-c", baseRevision: "c".repeat(40), dirty: true, dirtyChanges: "excluded",
})
const projectD = parseGuideProjectTargetV1({
  schemaVersion: 1, projectName: "project-d", source: null,
  entryWorktree: null, baseRevision: null, dirty: null, dirtyChanges: "excluded",
})
const here: JobPlacement = { kind: "current-workspace-pane", direction: "right" }
const herdrContext: GuideBatchContext = {
  cwd: "/fixture/caller-a", workspaceId: "9", callerPaneId: "9-1", primaryCheckoutPath: "/fixture/caller-a",
}

const queued = (id: number, options: {
  readonly name?: ProfileName
  readonly profile?: NativeSelectedProfile
  readonly action?: FirstmateGuideAction
  readonly placement?: JobPlacement
  readonly originalIntent?: string
  readonly body?: string
  readonly target?: GuideProjectTargetV1 | null
} = {}): QueuedGuideJob => {
  const name = options.name ?? "default"
  const profile = options.profile ?? selected(name)
  const action = options.action ?? "submit"
  const projectTarget = options.target ?? null
  const workflowId = projectTarget === null ? "fleet-status" : "project-review"
  const originalIntent = options.originalIntent ?? `  Inspect request ${id}.\r\nKeep every restriction. 😀  `
  const prepared = prepareGuidePrompt(guide, workflowId, `native:fmx/${profile.profile}`, originalIntent, {
    originalIntent, projectTarget, orchestration: profile.orchestration!,
  })
  const candidate = renderWorkflowBodyCandidate(prepared.workflow, {
    title: `Request ${id}`, prompt: options.body ?? `Inspect request ${id} without starting implementation workers.`,
    notes: "A confirmed specification.",
  })
  return createQueuedGuideJob(id, profile, candidate.prompt, options.placement ?? (action === "submit" ? { kind: "existing-fleet" } : here), {
    originalIntent, workflowId, projectTarget, workflow: prepared.workflow,
  }, { action, requestId: uuid(id), expectedFleet: identity(name) })
}

const requestFor = (job: QueuedGuideJob): FirstmateSubmissionRequestV1 => parseFirstmateSubmissionRequestV1({
  schemaVersion: 1, requestId: job.firstmate!.requestId, expectedFleet: job.firstmate!.expectedFleet,
  originalIntent: job.guideContext!.originalIntent, generatedSpec: job.prompt,
  workflowId: job.guideContext!.workflowId, projectTarget: job.guideContext!.projectTarget,
})
const receiptFor = (
  request: FirstmateSubmissionRequestV1,
  overrides: Partial<FirstmateSubmissionReceiptV1> = {},
): FirstmateSubmissionReceiptV1 => parseFirstmateSubmissionReceiptV1({
  schemaVersion: 1, requestId: request.requestId, digest: firstmateSubmissionDigest(request),
  fleet: request.expectedFleet, state: "saved", noteId: `note-${request.requestId}`,
  announcement: "sent", supervisorState: "running", error: null, ...overrides,
})
const ok = (value: unknown = ""): CommandRunResult => ({
  stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", exitCode: 0,
})

type JournalOperation = "prepare" | "begin" | "record"
class MemoryJournal implements FirstmateSubmissionJournal {
  readonly entries = new Map<string, FirstmateJournalEntry>()
  fail: ((operation: JournalOperation, request: FirstmateSubmissionRequestV1) => void) | undefined
  constructor(readonly events: string[] = []) {}

  seed(request: FirstmateSubmissionRequestV1, status: FirstmateJournalStatus, receipt: FirstmateSubmissionReceiptV1 | null = null): void {
    this.entries.set(request.requestId, {
      schemaVersion: 1, request, digest: firstmateSubmissionDigest(request), status, receipt,
      message: `Durable ${status} request.`,
    })
  }

  async prepare(request: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry> {
    this.fail?.("prepare", request)
    const existing = this.entries.get(request.requestId)
    if (existing !== undefined && canonicalFirstmateJson(existing.request) !== canonicalFirstmateJson(request)) {
      throw new FirstmateJournalError(FirstmateJournalErrorCode.Conflict, "The request ID already has different content.")
    }
    if (existing === undefined) this.seed(request, "prepared")
    this.events.push(`prepare:${request.requestId}`)
    return this.entries.get(request.requestId)!
  }

  async get(requestId: string): Promise<FirstmateJournalEntry | undefined> {
    this.events.push(`get:${requestId}`)
    return this.entries.get(requestId)
  }

  async begin(request: FirstmateSubmissionRequestV1): Promise<FirstmateJournalEntry> {
    this.fail?.("begin", request)
    const existing = this.entries.get(request.requestId)!
    if (existing.status !== "prepared") {
      throw new FirstmateJournalError(FirstmateJournalErrorCode.AttemptProtected, "The original request was already attempted.")
    }
    const entry = { ...existing, status: "sending" as const, message: "The original request may be sending." }
    this.entries.set(request.requestId, entry)
    this.events.push(`begin:${request.requestId}`)
    return entry
  }

  async record(request: FirstmateSubmissionRequestV1, outcome: FirstmateSubmissionOutcome): Promise<FirstmateJournalEntry> {
    this.fail?.("record", request)
    const existing = this.entries.get(request.requestId)!
    if (existing.status === "accepted" && outcome.status !== "accepted") return existing
    const entry: FirstmateJournalEntry = {
      ...existing, status: outcome.status === "not-found" ? "unknown" : outcome.status,
      receipt: outcome.receipt ?? existing.receipt, message: outcome.message,
    }
    this.entries.set(request.requestId, entry)
    this.events.push(`record:${entry.status}:${request.requestId}`)
    return entry
  }

  async listPending(): Promise<ReadonlyArray<FirstmateJournalEntry>> {
    return [...this.entries.values()].filter(({ status }) => status !== "accepted" && status !== "rejected")
  }
}

interface Call {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly options?: CommandRunOptions
}
class FleetRunner implements CommandRunner {
  readonly calls: Call[] = []
  readonly inventories = new Map<string, FirstmateFleetReadinessV1>([
    ["default", fleet("default")], ["pstack-workers", fleet("pstack-workers")],
  ])
  readonly requests = new Map<string, FirstmateSubmissionRequestV1>()
  readonly receipts = new Map<string, FirstmateSubmissionReceiptV1>()
  readonly supervisorStarts: Array<FirstmateFleetIdentityV1> = []
  intercept?: (call: Call) => CommandRunResult | Error | undefined
  private pane = 0
  constructor(readonly events: string[] = []) {}

  private inventory(profile: string): CommandRunResult {
    return ok({ schemaVersion: 1, launcher: "fmx", profile, readiness: "busy", fleet: this.inventories.get(profile) })
  }

  private submit(call: Call): CommandRunResult {
    const request = parseFirstmateSubmissionRequestV1(JSON.parse(call.options!.stdin!))
    this.requests.set(request.requestId, request)
    const running = this.inventories.get(request.expectedFleet.profile)!.supervisor.state === "running"
    const receipt = receiptFor(request, {
      announcement: running ? "sent" : "pending",
      supervisorState: running ? "running" : "stopped",
    })
    this.receipts.set(request.requestId, receipt)
    return ok(receipt)
  }

  private receipt(call: Call): CommandRunResult {
    const lookup = parseFirstmateReceiptRequestV1(JSON.parse(call.options!.stdin!))
    return ok(this.receipts.get(lookup.requestId) ?? {
      schemaVersion: 1, requestId: lookup.requestId, digest: null, fleet: lookup.expectedFleet,
      state: "not-found", noteId: null, announcement: "not-needed", supervisorState: "running", error: null,
    })
  }

  private herdr(call: Call): CommandRunResult {
    const { args } = call
    if (args[0] === "pane" && args[1] === "run") {
      const match = /^env TRELLAGE_AUTOMATION=1 \/fixture\/bin\/fmx (default|pstack-workers) --fmx-expected-fleet-json '(.+)'$/u.exec(args[3]!)
      if (match === null) throw new Error("Fixture supervisor launch requires an explicit identity guard.")
      const encoded = match[2]!.replaceAll("'\"'\"'", "'")
      expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(65_536)
      const expected = parseFirstmateFleetIdentityV1(JSON.parse(encoded))
      const profile = match[1]
      if (profile !== "default" && profile !== "pstack-workers") throw new Error("Unknown fixture fleet.")
      const current = this.inventories.get(profile)!
      if (current.identity === null || !sameFirstmateFleet(current.identity, expected)) {
        throw new CommandRunnerError({
          kind: "exited", executable: call.executable, args, exitCode: 1,
          message: "Native startup refused the expected fleet identity before mutation.",
        })
      }
      this.supervisorStarts.push(expected)
      this.inventories.set(profile, { ...fleet(profile, "running", current.backend ?? "herdr", current.activeWorkers), identity: expected })
      return ok()
    }
    this.pane += 1
    if (args[0] === "pane" && args[1] === "split") return ok({ result: { pane: { pane_id: `9-${this.pane + 1}` } } })
    if (args[0] === "tab") return ok({ result: { root_pane: { pane_id: `9-${this.pane + 1}` } } })
    if (args[0] === "worktree") return ok({
      result: {
        workspace: { workspace_id: "10" }, root_pane: { pane_id: "10-1" },
        worktree: { path: "/fixture/supervisor-destination" },
      },
    })
    throw new Error(`Unexpected Herdr operation: ${args.slice(0, 2).join(" ")}`)
  }

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    const call = { executable, args: [...args], ...(options === undefined ? {} : { options }) }
    this.calls.push(call)
    this.events.push(`command:${args[0]}:${options?.stdin === undefined ? args[1] : JSON.parse(options.stdin).requestId}`)
    const intercepted = this.intercept?.(call)
    if (intercepted instanceof Error) throw intercepted
    if (intercepted !== undefined) return intercepted
    if (executable === "herdr") return this.herdr(call)
    if (executable === "git") return ok()
    switch (args[0]) {
      case "inventory": return this.inventory(args[1]!)
      case "submit": return this.submit(call)
      case "receipt": return this.receipt(call)
      default: throw new Error(`Unexpected profile operation: ${args[0]}`)
    }
  }
}

class FakeTime implements TimeController {
  private milliseconds = 0
  readonly sleeps: number[] = []
  now = () => this.milliseconds
  sleep = async (milliseconds: number) => {
    this.sleeps.push(milliseconds)
    this.milliseconds += milliseconds
  }
}
const run = async (jobs: ReadonlyArray<QueuedGuideJob>, options: {
  readonly runner?: FleetRunner
  readonly journal?: MemoryJournal
  readonly context?: GuideBatchContext
  readonly services?: Partial<GuideBatchExecutionServices>
} = {}) => {
  const events: string[] = options.journal?.events ?? options.runner?.events ?? []
  const runner = options.runner ?? new FleetRunner(events)
  const journal = options.journal ?? new MemoryJournal(events)
  const time = new FakeTime()
  const writes: string[] = []
  const outcome = await executeGuideBatch({ jobs, context: options.context ?? herdrContext }, {
    runner, firstmateJournal: journal, firstmateTime: time, firstmateStartupTimeoutMs: 20, firstmatePollIntervalMs: 5,
    write: (text) => writes.push(text),
    onFirstmateUpdate: async (_, entry) => { events.push(`callback:${entry.status}:${entry.request.requestId}`) },
    ...options.services,
  })
  return { ...outcome, runner, journal, time, events, output: writes.join("") }
}
const commands = (runner: FleetRunner, operation: string): ReadonlyArray<Call> =>
  runner.calls.filter(({ args }) => args[0] === operation)
const paneRuns = (runner: FleetRunner): ReadonlyArray<Call> =>
  runner.calls.filter(({ args }) => args[0] === "pane" && args[1] === "run")
const expectedSupervisorCommand = (profile: ProfileName): string =>
  `env TRELLAGE_AUTOMATION=1 ${renderCommandPreview({
    executable: "/fixture/bin/fmx",
    args: [profile, "--fmx-expected-fleet-json", JSON.stringify(identity(profile))],
  })}`
const submissionIds = (runner: FleetRunner) =>
  commands(runner, "submit").map(({ options }) => JSON.parse(options!.stdin!).requestId)

const currentTerminal: JobPlacement = { kind: "current-terminal" }
const terminalBatch = async (jobs = [queued(1, { action: "start", placement: currentTerminal })]) => {
  const runner = new FleetRunner()
  runner.inventories.set("default", fleet("default", "stopped", "tmux"))
  return run(jobs, { runner, context: { cwd: "/fixture/caller-a" } })
}
const finishTerminalBatch = async (
  batch: { readonly result: GuideBatchExecutionResult; readonly runner: FleetRunner },
  foreground: NonNullable<GuideInteractiveExecutionServices["runInteractive"]> = async () => undefined,
) => {
  const writes: string[] = []
  const runInteractive = vi.fn(foreground)
  const exitCode = await executeGuideUiResult({ action: "batch", result: batch.result }, {
    runner: batch.runner, write: (text) => writes.push(text), runInteractive,
  })
  return { exitCode, runInteractive, output: writes.join("") }
}

describe("Firstmate current-terminal handoff", () => {
  it("starts in a fresh Herdr pane without treating a primary checkout or pane directory as the project", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped", "herdr"))
    const job = queued(1, { action: "start", placement: here, target: projectC })
    const result = await run([job], {
      runner, context: { cwd: "/fixture/caller-a", workspaceId: "9", callerPaneId: "9-0" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.result.entries[0]).toMatchObject({ status: "accepted", supervisor: "running" })
    expect(paneRuns(runner)).toHaveLength(1)
    expect([...runner.requests.values()][0]?.projectTarget).toEqual(projectC)
    expect(result.result.firstmateTerminalHandoff).toBeUndefined()
  })

  it.each([
    { name: "default", action: "start", state: "stopped" },
    { name: "pstack-workers", action: "start", state: "stopped" },
    { name: "default", action: "recover", state: "stale" },
    { name: "pstack-workers", action: "recover", state: "stale" },
  ] as const)("saves two $name requests once before one guarded terminal $action", async ({ name, action, state }) => {
    const events: string[] = []
    const runner = new FleetRunner(events)
    const journal = new MemoryJournal(events)
    runner.inventories.set(name, fleet(name, state, "tmux"))
    runner.intercept = ({ args, options }) => {
      if (args[0] !== "submit") return undefined
      const request = parseFirstmateSubmissionRequestV1(JSON.parse(options!.stdin!))
      const receipt = receiptFor(request, { announcement: "sent", supervisorState: "stopped" })
      runner.requests.set(request.requestId, request)
      runner.receipts.set(request.requestId, receipt)
      return ok(receipt)
    }
    const jobs = [
      queued(1, { name, action, placement: currentTerminal, target: projectC }),
      queued(2, { name, action, placement: currentTerminal, target: projectD }),
    ]
    const onAllocated = vi.fn(async () => undefined)
    const result = await run(jobs, {
      runner, journal, context: { cwd: "/fixture/caller-a" }, services: { onAllocated },
    })
    expect(result.exitCode).toBe(0)
    expect(guideBatchRequiresHerdr(jobs)).toBe(false)
    expect(result.result.firstmateTerminalHandoff).toEqual({
      kind: "current-terminal", status: "handoff-ready",
      expectedFleet: identity(name), profile: selected(name), action, cwd: "/fixture/caller-a",
      requestIds: [uuid(1), uuid(2)],
    })
    expect(result.result.entries).toEqual(jobs.map((job) => expect.objectContaining({
      job, status: "accepted", supervisor: state, cwd: "/fixture/caller-a",
      receipt: expect.objectContaining({ state: "saved", announcement: "sent", supervisorState: "stopped" }),
    })))
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
    expect([...runner.requests.values()]).toEqual(jobs.map(requestFor))
    expect(events.indexOf(`callback:prepared:${uuid(2)}`)).toBeLessThan(events.indexOf(`command:submit:${uuid(1)}`))
    expect(events.indexOf(`callback:accepted:${uuid(1)}`)).toBeLessThan(events.indexOf(`command:submit:${uuid(2)}`))
    expect(onAllocated).not.toHaveBeenCalled()
    expect(runner.calls.every(({ executable }) => executable === "/fixture/bin/fmx")).toBe(true)
    expect(paneRuns(runner)).toEqual([])
    expect(result.time.sleeps).toEqual([])
    const frozen = JSON.stringify(result.result)
    const finished = await finishTerminalBatch(result, async (command, options) => {
      events.push("terminal-launch")
      expect(command).toEqual({
        executable: "/fixture/bin/fmx",
        args: [name, "--fmx-expected-fleet-json", JSON.stringify(identity(name))],
      })
      expect(Buffer.byteLength(command.args[2]!, "utf8")).toBeLessThanOrEqual(65_536)
      expect(options).toEqual({
        cwd: "/fixture/caller-a", env: expect.objectContaining({ TRELLAGE_AUTOMATION: "1" }),
      })
      expect([...journal.entries.values()].map(({ status }) => status)).toEqual(["accepted", "accepted"])
    })
    expect(finished.exitCode).toBe(0)
    expect(finished.runInteractive).toHaveBeenCalledTimes(1)
    expect(events.indexOf(`callback:accepted:${uuid(2)}`)).toBeLessThan(events.indexOf("terminal-launch"))
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
    expect(commands(runner, "receipt")).toEqual([])
    expect(commands(runner, "agent")).toEqual([])
    expect(JSON.stringify(result.result)).toBe(frozen)
    expect(finished.output).toContain("Current-terminal handoff ready")
    expect(finished.output).toContain("Current terminal handed off")
    expect(finished.output).toContain("with a startup instruction")
    expect(finished.output).toContain("Saved request bodies stay in the inbox")
    expect(finished.output).toContain("Dispatch and task completion are not confirmed")
    for (const job of jobs) {
      expect(job.command.args).toEqual([name])
      expect(finished.output).not.toContain(job.prompt)
      expect(finished.output).not.toContain(job.guideContext!.originalIntent)
    }
  })

  it.each([
    ["another fleet", queued(2, { name: "pstack-workers", action: "start", placement: currentTerminal })],
    ["a different action", queued(2, { action: "recover", placement: currentTerminal })],
    ["a Herdr destination", queued(2, { action: "start", placement: here })],
    ["Send work", queued(2)],
  ] as const)("rejects current-terminal groups with %s before preparing or saving requests", async (_, conflicting) => {
    const result = await run([queued(1, { action: "start", placement: currentTerminal }), conflicting])
    expect(result.result.entries.map(({ status }) => status)).toEqual(["invalid", "invalid"])
    expect(result.result.firstmateTerminalHandoff).toBeUndefined()
    expect(result.journal.entries.size).toBe(0)
    expect(result.runner.calls).toEqual([])
    const finished = await finishTerminalBatch(result)
    expect(finished.exitCode).toBe(1)
    expect(finished.runInteractive).not.toHaveBeenCalled()
  })

  it("rejects Send work in the current terminal instead of starting an implicit supervisor", async () => {
    const result = await terminalBatch([queued(1, { placement: currentTerminal })])
    expect(result.result.entries[0]?.status).toBe("invalid")
    expect(result.result.firstmateTerminalHandoff).toBeUndefined()
    expect(result.journal.entries.size).toBe(0)
    expect(result.runner.calls).toEqual([])
  })

  it("preserves partial acceptance and does not hand off an unknown save", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped", "tmux"))
    runner.intercept = ({ args, options }) =>
      args[0] === "submit" && JSON.parse(options!.stdin!).requestId === uuid(2) ? ok("lost receipt") : undefined
    const jobs = [1, 2, 3].map((id) => queued(id, { action: "start", placement: currentTerminal }))
    const result = await run(jobs, { runner, context: { cwd: "/fixture/caller-a" } })
    expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "submission-unknown", "not-submitted"])
    expect(result.result.firstmateTerminalHandoff).toBeUndefined()
    expect(result.journal.entries.get(uuid(1))?.status).toBe("accepted")
    expect(result.journal.entries.get(uuid(2))?.status).toBe("unknown")
    expect(result.journal.entries.get(uuid(3))?.status).toBe("prepared")
    const finished = await finishTerminalBatch(result)
    expect(finished.exitCode).toBe(1)
    expect(finished.runInteractive).not.toHaveBeenCalled()
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
    expect(commands(runner, "receipt")).toHaveLength(1)
    expect(runner.calls.every(({ executable }) => executable === "/fixture/bin/fmx")).toBe(true)
    expect(finished.output).toContain("reconcile the same request ID and payload")
  })

  it.each(["home", "instanceId", "sourceRevision"] as const)("preserves saved receipts when %s changes after Ink's batch finishes", async (field) => {
    const result = await terminalBatch()
    const frozen = JSON.stringify(result.result)
    const replacement = {
      ...identity("default"),
      [field]: field === "home" ? "/replacement/home" : field === "instanceId" ? uuid(999) : "c".repeat(40),
    }
    result.runner.inventories.set("default", { ...fleet("default", "running", "tmux"), identity: replacement })
    const finished = await finishTerminalBatch(result)
    expect(finished.exitCode).toBe(1)
    expect(finished.runInteractive).not.toHaveBeenCalled()
    expect(finished.output).toContain("identity")
    expect(finished.output).toContain("Saved receipts are preserved")
    expect(result.journal.entries.get(uuid(1))).toMatchObject({
      status: "accepted", receipt: { fleet: identity("default") },
    })
    expect(JSON.stringify(result.result)).toBe(frozen)
    expect(submissionIds(result.runner)).toEqual([uuid(1)])
  })

  it.each([
    { label: "recovery is now required", change: fleet("default", "stale", "tmux") },
    { label: "startup consent is missing", change: { ...fleet("default", "stopped", "tmux"), consentRequired: true } },
    { label: "runtime is busy", change: { ...fleet("default", "stopped", "tmux"), runtime: "busy" as const } },
    { label: "worker prerequisites are missing", change: {
      ...fleet("default", "stopped", "tmux"),
      prerequisites: [{ id: "claude", ready: false, description: "Worker harness is unavailable." }],
    } },
  ])("does not change the confirmed action or prerequisites when $label", async ({ change }) => {
    const result = await terminalBatch()
    result.runner.inventories.set("default", change)
    const finished = await finishTerminalBatch(result)
    expect(finished.exitCode).toBe(1)
    expect(finished.runInteractive).not.toHaveBeenCalled()
    expect(submissionIds(result.runner)).toEqual([uuid(1)])
    expect(result.runner.calls.every(({ args }) => ["inventory", "submit"].includes(args[0]!))).toBe(true)
    expect(result.journal.entries.get(uuid(1))?.status).toBe("accepted")
  })

  it("uses verified matching running identity when another caller starts the fleet before handoff", async () => {
    const result = await terminalBatch()
    result.runner.inventories.set("default", fleet("default", "running", "tmux", 12))
    const finished = await finishTerminalBatch(result)
    expect(finished.exitCode).toBe(0)
    expect(finished.runInteractive).not.toHaveBeenCalled()
    expect(finished.output).toContain("confirmed owned Firstmate supervisor is already running")
    expect(finished.output).not.toContain("Current terminal handed off")
    expect(submissionIds(result.runner)).toEqual([uuid(1)])
    expect(commands(result.runner, "agent")).toEqual([])
  })

  it.each([
    { label: "matching owned running fleet", observed: fleet("default", "running", "tmux"), exitCode: 0 },
    { label: "stopped fleet", observed: fleet("default", "stopped", "tmux"), exitCode: 7 },
    { label: "changed home", observed: {
      ...fleet("default", "running", "tmux"), identity: { ...identity("default"), home: "/replacement/home" },
    }, exitCode: 7 },
    { label: "changed instance", observed: {
      ...fleet("default", "running", "tmux"), identity: { ...identity("default"), instanceId: uuid(999) },
    }, exitCode: 7 },
    { label: "changed source revision", observed: {
      ...fleet("default", "running", "tmux"), identity: { ...identity("default"), sourceRevision: "c".repeat(40) },
    }, exitCode: 7 },
    { label: "busy runtime", observed: { ...fleet("default", "running", "tmux"), runtime: "busy" as const }, exitCode: 7 },
    { label: "generic busy inventory", observed: undefined, exitCode: 7 },
  ])("handles a native nonzero race with $label without another start", async ({ observed, exitCode }) => {
    const result = await terminalBatch()
    const frozen = JSON.stringify(result.result)
    const finished = await finishTerminalBatch(result, async (command) => {
      if (observed === undefined) {
        result.runner.intercept = ({ args }) => args[0] === "inventory" ? ok({
          schemaVersion: 1, launcher: "fmx", profile: "default", readiness: "busy",
        }) : undefined
      } else result.runner.inventories.set("default", observed)
      throw new CommandRunnerError({
        kind: "exited", executable: command.executable, args: command.args,
        exitCode: 7, stdout: "busy", message: "Native supervisor admission lost a race.",
      })
    })
    expect(finished.exitCode).toBe(exitCode)
    expect(finished.runInteractive).toHaveBeenCalledTimes(1)
    expect(commands(result.runner, "inventory")).toHaveLength(4)
    expect(submissionIds(result.runner)).toEqual([uuid(1)])
    expect(commands(result.runner, "receipt")).toEqual([])
    expect(commands(result.runner, "agent")).toEqual([])
    expect(result.journal.entries.get(uuid(1))?.status).toBe("accepted")
    expect(JSON.stringify(result.result)).toBe(frozen)
    expect(finished.output).toContain(exitCode === 0 ? "supervisor is already running" : "handoff failed")
    expect(finished.output).not.toContain("Current terminal handed off")
  })

  it("awaits only the foreground lifetime and does not poll task or worker readiness", async () => {
    const result = await terminalBatch()
    let release: () => void = () => {}
    let started: () => void = () => {}
    const foreground = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    let finished = false
    const execution = finishTerminalBatch(result, async () => { started(); await foreground })
    void execution.then(() => { finished = true })
    await entered
    expect(finished).toBe(false)
    expect(commands(result.runner, "inventory")).toHaveLength(3)
    expect(commands(result.runner, "agent")).toEqual([])
    release()
    const outcome = await execution
    expect(outcome.exitCode).toBe(0)
    expect(outcome.runInteractive).toHaveBeenCalledTimes(1)
    expect(commands(result.runner, "inventory")).toHaveLength(3)
    expect(outcome.output).toContain("foreground process has exited")
  })

  it.each([
    { label: "missing request ID", patch: { requestIds: [uuid(1)] } },
    { label: "reordered request IDs", patch: { requestIds: [uuid(2), uuid(1)] } },
    { label: "duplicate request IDs", patch: { requestIds: [uuid(1), uuid(1)] } },
    { label: "extra request ID", patch: { requestIds: [uuid(1), uuid(2), uuid(3)] } },
    { label: "different action", patch: { action: "recover" } },
    { label: "different cwd", patch: { cwd: "/other/project" } },
    { label: "different fleet", patch: { expectedFleet: { ...identity("default"), home: "/replacement/home" } } },
    { label: "different launcher path", patch: { profile: { ...selected("default"), commandPath: "/other/bin/fmx" } } },
  ] satisfies ReadonlyArray<{ label: string; patch: Partial<FirstmateTerminalHandoff> }>)(
    "refuses a handoff descriptor with $label before inventory or launch",
    async ({ patch }) => {
      const result = await terminalBatch([1, 2].map((id) => queued(id, { action: "start", placement: currentTerminal })))
      const calls = result.runner.calls.length
      const changed = {
        ...result, result: {
          ...result.result, firstmateTerminalHandoff: { ...result.result.firstmateTerminalHandoff!, ...patch },
        },
      }
      const finished = await finishTerminalBatch(changed)
      expect(finished.exitCode).toBe(1)
      expect(finished.runInteractive).not.toHaveBeenCalled()
      expect(result.runner.calls).toHaveLength(calls)
      expect(submissionIds(result.runner)).toEqual([uuid(1), uuid(2)])
      expect([...result.journal.entries.values()].map(({ status }) => status)).toEqual(["accepted", "accepted"])
    },
  )

  it.each(["receipt digest", "unknown save", "confirmed payload"] as const)("validates the %s behind a handoff descriptor", async (change) => {
    const result = await terminalBatch()
    const original = result.result.entries[0]!
    if (original.status !== "accepted") throw new Error("The test requires an accepted request.")
    const changed = change === "receipt digest"
      ? { ...original, receipt: { ...original.receipt, digest: "0".repeat(64) } }
      : change === "confirmed payload"
        ? { ...original, request: { ...original.request, originalIntent: "Different original input." } }
        : {
            job: original.job, request: original.request, status: "submission-unknown" as const,
            stage: "submission" as const, message: "This save is not confirmed.",
          }
    const calls = result.runner.calls.length
    const finished = await finishTerminalBatch({
      ...result, result: { ...result.result, entries: [changed] },
    })
    expect(finished.exitCode).toBe(1)
    expect(finished.runInteractive).not.toHaveBeenCalled()
    expect(result.runner.calls).toHaveLength(calls)
    expect(result.journal.entries.get(uuid(1))?.receipt).toEqual(original.receipt)
  })
})

describe("Firstmate queue delivery", () => {
  it.each(["default", "pstack-workers"] as const)("sends exact %s requests to a live tmux fleet outside Herdr", async (name) => {
    const runner = new FleetRunner()
    runner.inventories.set(name, fleet(name, "running", "tmux", 17))
    const job = queued(1, { name })
    const snapshot = JSON.stringify(job)
    const result = await run([job], { runner, context: { cwd: "/fixture/caller-a" } })

    expect(result.exitCode).toBe(0)
    expect(guideBatchRequiresHerdr([job])).toBe(false)
    expect(result.result.entries[0]).toMatchObject({ status: "accepted", supervisor: "running", receipt: { announcement: "sent" } })
    expect(commands(runner, "submit")).toHaveLength(1)
    expect(commands(runner, "submit")[0]).toMatchObject({
      executable: "/fixture/bin/fmx", args: ["submit", name, "--json"],
      options: { cwd: "/fixture/caller-a", stdin: canonicalFirstmateJson(requestFor(job)) },
    })
    expect(runner.calls.every(({ executable }) => executable === "/fixture/bin/fmx")).toBe(true)
    expect(runner.calls.every(({ args }) => !args.includes(job.prompt))).toBe(true)
    expect(JSON.stringify(job)).toBe(snapshot)
    expect(result.output).toContain(job.firstmate!.requestId)
    expect(result.output).toContain(`note-${job.firstmate!.requestId}`)
    expect(result.output).not.toContain(job.prompt)
  })

  it.each(["default", "pstack-workers"] as const)("saves all %s requests before one shared worktree startup without a second prompt channel", async (name) => {
    const events: string[] = []
    const runner = new FleetRunner(events)
    const journal = new MemoryJournal(events)
    runner.inventories.set(name, fleet(name, "stopped"))
    const placement: JobPlacement = { kind: "new-worktree", branch: "worktree/shared-fleet", baseRef: "main" }
    const originalIntent = `  ${"x".repeat(59000)}\r\nNo merge.  `
    const jobs = [
      queued(1, { name, action: "start", placement, target: projectC, originalIntent }),
      queued(2, { name, action: "start", placement, target: projectD }),
    ]
    const allocations: Array<{ id: number; paneId: string }> = []
    const result = await run(jobs, { runner, journal, services: {
      onAllocated: async (job, destination) => { allocations.push({ id: job.id, paneId: destination.paneId }) },
    } })

    expect(result.exitCode).toBe(0)
    expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "accepted"])
    expect([...runner.requests.values()].map(({ projectTarget }) => projectTarget)).toEqual([projectC, projectD])
    expect(runner.requests.get(uuid(1))?.originalIntent).toBe(originalIntent)
    expect([...runner.requests.values()].map(({ generatedSpec }) => generatedSpec)).toEqual(jobs.map(({ prompt }) => prompt))
    expect(commands(runner, "worktree")).toHaveLength(1)
    expect(paneRuns(runner)).toHaveLength(1)
    expect(paneRuns(runner)[0]).toMatchObject({
      args: ["pane", "run", "10-1", expectedSupervisorCommand(name)],
      options: { cwd: "/fixture/supervisor-destination", timeoutMs: 20 },
    })
    expect(commands(runner, "agent")).toEqual([])
    expect(allocations).toEqual([{ id: 1, paneId: "10-1" }, { id: 2, paneId: "10-1" }])
    expect(events.indexOf(`callback:prepared:${uuid(2)}`)).toBeLessThan(events.indexOf(`begin:${uuid(1)}`))
    expect(events.indexOf(`begin:${uuid(1)}`)).toBeLessThan(events.indexOf(`callback:sending:${uuid(1)}`))
    expect(events.indexOf(`callback:sending:${uuid(1)}`)).toBeLessThan(events.indexOf(`command:submit:${uuid(1)}`))
    expect(events.indexOf(`callback:accepted:${uuid(1)}`)).toBeLessThan(events.indexOf(`command:submit:${uuid(2)}`))
    expect(events.indexOf(`callback:accepted:${uuid(2)}`)).toBeLessThan(events.indexOf("command:worktree:create"))
    expect(journal.entries.get(uuid(1))?.receipt?.announcement).toBe("pending")
  })

  it.each([
    { name: "default", action: "start" },
    { name: "pstack-workers", action: "start" },
    { name: "default", action: "recover" },
    { name: "pstack-workers", action: "recover" },
  ] as const)("keeps saved/sent/stopped $name requests waiting until one explicit $action is observed", async ({ name, action }) => {
    const runner = new FleetRunner()
    runner.inventories.set(name, fleet(name, action === "start" ? "stopped" : "stale", "herdr", action === "start" ? 0 : 5))
    runner.intercept = ({ args, options }) => {
      if (args[0] !== "submit") return undefined
      const request = parseFirstmateSubmissionRequestV1(JSON.parse(options!.stdin!))
      const receipt = receiptFor(request, { announcement: "sent", supervisorState: "stopped" })
      runner.requests.set(request.requestId, request)
      runner.receipts.set(request.requestId, receipt)
      return ok(receipt)
    }
    const progress: Array<{ jobId: number; phase: string; detail: string; started: boolean }> = []
    const jobs = [queued(1, { name, action }), queued(2, { name, action })]
    const result = await run(jobs, { runner, services: {
      onProgress: (event) => { progress.push({ ...event, started: paneRuns(runner).length > 0 }) },
    } })
    expect(result.exitCode).toBe(0)
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
    expect(paneRuns(runner)).toHaveLength(1)
    expect(runner.supervisorStarts).toHaveLength(1)
    for (const job of jobs) {
      expect(progress).toContainEqual({
        jobId: job.id, phase: "waiting", started: false,
        detail: expect.stringContaining("accepted; waiting for supervisor start"),
      })
      expect(progress.filter(({ jobId }) => jobId === job.id).at(-1)).toMatchObject({
        phase: "done", started: true, detail: expect.stringContaining("supervisor running"),
      })
    }
    for (const entry of result.result.entries) expect(entry).toMatchObject({
      status: "accepted", supervisor: "running",
      receipt: { state: "saved", announcement: "sent", supervisorState: "stopped" },
    })
    expect(result.output).toContain("Acceptance does not confirm dispatch or task completion")
    expect(result.output).not.toContain("Fleet status: waiting")
  })

  it("recovers one stale supervisor with surviving workers and never runs setup or repair", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stale", "herdr", 5))
    const result = await run([queued(1, { action: "recover" }), queued(2, { action: "recover" })], { runner })
    expect(result.exitCode).toBe(0)
    expect(paneRuns(runner)).toHaveLength(1)
    expect(runner.inventories.get("default")?.activeWorkers).toBe(5)
    expect(runner.calls.some(({ args }) => ["setup", "repair", "install"].includes(args[0]!))).toBe(false)
  })

  it("keeps two profile groups independent while preserving each group's submission order", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    runner.inventories.set("pstack-workers", fleet("pstack-workers", "stopped"))
    const jobs = [
      queued(1, { action: "start" }), queued(2, { name: "pstack-workers", action: "start" }),
      queued(3, { action: "start" }), queued(4, { name: "pstack-workers", action: "start" }),
    ]
    const result = await run(jobs, { runner })
    expect(result.exitCode).toBe(0)
    expect(result.result.entries.map(({ job }) => job.id)).toEqual([1, 2, 3, 4])
    expect(commands(runner, "submit").filter(({ args }) => args[1] === "default").map(({ options }) => JSON.parse(options!.stdin!).requestId)).toEqual([uuid(1), uuid(3)])
    expect(commands(runner, "submit").filter(({ args }) => args[1] === "pstack-workers").map(({ options }) => JSON.parse(options!.stdin!).requestId)).toEqual([uuid(2), uuid(4)])
    expect(paneRuns(runner).map(({ args }) => args[3]).sort()).toEqual([
      expectedSupervisorCommand("default"),
      expectedSupervisorCommand("pstack-workers"),
    ])
  })

  it.each([
    ["different action", queued(2, { action: "recover" })],
    ["different pane", queued(2, { action: "start", placement: { kind: "current-workspace-pane", direction: "down" } })],
    ["different destination", queued(2, { action: "start", placement: { kind: "new-tab" } })],
  ])("rejects a group with %s before journal or native mutation", async (_, conflicting) => {
    const result = await run([queued(1, { action: "start" }), conflicting as QueuedGuideJob])
    expect(result.result.entries.map(({ status }) => status)).toEqual(["invalid", "invalid"])
    expect(result.journal.entries.size).toBe(0)
    expect(result.runner.calls).toEqual([])
  })

  it.each(["command path", "source pin", "policy"] as const)("rejects mixed %s metadata for one profile instead of creating separate fleets", async (change) => {
    const profile = selected("default")
    const changed: NativeSelectedProfile = change === "command path"
      ? { ...profile, commandPath: "/different/bin/fmx" }
      : {
          ...profile,
          orchestration: {
            ...profile.orchestration!,
            ...(change === "source pin" ? { sourceRevision: "a".repeat(40) } : { workerPolicy: { name: "different", digest: "a".repeat(64) } }),
          },
        }
    const result = await run([queued(1), queued(2, { profile: changed })])
    expect(result.result.entries.every(({ status }) => status === "invalid")).toBe(true)
    expect(result.journal.entries.size).toBe(0)
    expect(result.runner.calls).toEqual([])
  })

  it.each(["instanceId", "home"] as const)("rejects different confirmed %s values in one group", async (field) => {
    const job = queued(2)
    const conflicting = { ...job, firstmate: { ...job.firstmate!, expectedFleet: {
      ...job.firstmate!.expectedFleet!, [field]: field === "home" ? "/other/home" : uuid(301),
    } } }
    const result = await run([queued(1), conflicting])
    expect(result.result.entries.every(({ status }) => status === "invalid")).toBe(true)
    expect(result.runner.calls).toEqual([])
  })

  it("rejects a missing confirmed identity without substituting inventory identity", async () => {
    const job = queued(1)
    const result = await run([{ ...job, firstmate: { action: "submit", requestId: uuid(1) } }])
    expect(result.result.entries[0]).toMatchObject({ status: "invalid", message: expect.stringContaining("expected owned fleet identity") })
    expect(result.runner.calls).toEqual([])
  })

  it.each(["missing action", "old backend", "wrong launcher"] as const)("rejects %s instead of falling back to prompt delivery", async (kind) => {
    const job = queued(1)
    const { firstmate: _firstmate, ...withoutAction } = job
    const { orchestration: _orchestration, ...oldProfile } = selected("default")
    const invalid = kind === "missing action" ? withoutAction
      : kind === "old backend" ? { ...job, profile: oldProfile }
      : { ...job, profile: { ...oldProfile, launcher: "cpx" } }
    const result = await run([invalid])
    expect(result.result.entries[0]?.status).toBe("invalid")
    expect(result.runner.calls).toEqual([])
    expect(result.output).not.toContain(job.prompt)
    expect(result.output).not.toContain("Selected prompt")
  })

  it.each([
    queued(1, { placement: here }),
    queued(1, { action: "start", placement: { kind: "existing-fleet" } }),
  ])("requires the action's explicit placement", async (job) => {
    const result = await run([job])
    expect(result.result.entries[0]?.status).toBe("invalid")
    expect(result.runner.calls).toEqual([])
  })

  it("rejects duplicate request IDs across profiles before either can submit", async () => {
    const other = queued(2, { name: "pstack-workers" })
    const result = await run([queued(1), { ...other, firstmate: { ...other.firstmate!, requestId: uuid(1) } }])
    expect(result.result.entries.map(({ status }) => status)).toEqual(["invalid", "invalid"])
    expect(result.runner.calls).toEqual([])
  })

  it("reports malformed placement metadata without crashing or submitting another group member", async () => {
    const invalid = { ...queued(2), placement: null } as unknown as QueuedGuideJob
    const result = await run([queued(1), invalid])
    expect(result.exitCode).toBe(1)
    expect(result.result.entries.map(({ status }) => status)).toEqual(["invalid", "invalid"])
    expect(result.runner.calls).toEqual([])
    expect(result.output).toContain("invalid placement")
    expect(result.output).not.toContain(invalid.prompt)
  })

  it.each(["oversized intent", "oversized specification", "canonical byte overflow", "wrong workflow", "missing frame", "duplicate frame", "changed target"] as const)(
    "validates every payload before any note for %s",
    async (kind) => {
      const valid = queued(1)
      const job = queued(2)
      let invalid = job
      if (kind === "oversized intent" || kind === "canonical byte overflow") {
        invalid = { ...job, guideContext: { ...job.guideContext!, originalIntent: kind === "oversized intent" ? "x".repeat(60001) : "😀".repeat(60000) } }
      } else if (kind === "oversized specification") invalid = { ...job, prompt: "x".repeat(8001) }
      else if (kind === "wrong workflow") invalid = { ...job, guideContext: { ...job.guideContext!, workflowId: "different-workflow" } }
      else if (kind === "missing frame") invalid = { ...job, prompt: "Only the body." }
      else if (kind === "duplicate frame") {
        const frame = workflowPromptFrame(job.guideContext!.workflow)
        invalid = { ...job, prompt: `${frame.beforeBody}${job.prompt}${frame.afterBody}` }
      } else invalid = { ...job, guideContext: { ...job.guideContext!, projectTarget: projectC } }
      const snapshot = JSON.stringify(invalid)
      const result = await run([valid, invalid])
      expect(result.result.entries.map(({ status }) => status)).toEqual(["invalid", "invalid"])
      expect(result.runner.calls).toEqual([])
      expect(result.journal.entries.size).toBe(0)
      expect(JSON.stringify(invalid)).toBe(snapshot)
    },
  )

  it("enforces the profile's smaller byte bound after rendering and retains the full original intent", async () => {
    const profile = selected("default")
    const limited = { ...profile, orchestration: {
      ...profile.orchestration!, submission: { schemaVersion: 1 as const, maxRequestBytes: 2048 },
    } }
    const job = queued(1, { profile: limited, originalIntent: "é".repeat(1000) })
    const result = await run([job])
    expect(result.result.entries[0]).toMatchObject({ status: "invalid", message: expect.stringContaining("byte limit") })
    expect(result.runner.calls).toEqual([])
    expect(job.guideContext!.originalIntent).toBe("é".repeat(1000))
  })

  it("does not allow a project workflow without a confirmed target", async () => {
    const job = queued(1, { target: projectC })
    const result = await run([{ ...job, guideContext: { ...job.guideContext!, projectTarget: null } }])
    expect(result.result.entries[0]).toMatchObject({ status: "invalid", message: expect.stringContaining("confirmed project target") })
    expect(result.runner.calls).toEqual([])
  })

  it("accepts the exact 60000-character intent and 8000-character rendered specification bounds", async () => {
    const base = queued(1)
    const frame = workflowPromptFrame(base.guideContext!.workflow)
    const prompt = `${frame.beforeBody}${"s".repeat(8000 - [...frame.beforeBody + frame.afterBody].length)}${frame.afterBody}`
    const job = { ...base, prompt, guideContext: { ...base.guideContext!, originalIntent: "i".repeat(60000) } }
    const result = await run([job])
    expect(result.exitCode).toBe(0)
    const delivered = result.runner.requests.get(uuid(1))!
    expect(delivered.originalIntent).toBe(job.guideContext.originalIntent)
    expect(delivered.generatedSpec).toBe(prompt)
    expect([...delivered.generatedSpec]).toHaveLength(8000)
  })

  it("requires real Herdr context for an explicit startup before saving any request", async () => {
    const result = await run([queued(1, { action: "start" })], { context: { cwd: "/fixture/caller-a" } })
    expect(guideBatchRequiresHerdr([queued(1, { action: "start" })])).toBe(true)
    expect(result.result.entries[0]).toMatchObject({ status: "invalid", message: expect.stringContaining("real Herdr workspace") })
    expect(result.runner.calls).toEqual([])
    expect(result.journal.entries.size).toBe(0)
  })

  it.each(["instanceId", "home", "sourceRevision"] as const)("fails closed when inventory changes the confirmed %s", async (field) => {
    const runner = new FleetRunner()
    const initial = fleet("default")
    runner.inventories.set("default", { ...initial, identity: {
      ...initial.identity!, [field]: field === "home" ? "/changed/home" : field === "sourceRevision" ? "a".repeat(40) : uuid(999),
    } })
    const result = await run([queued(1)], { runner })
    expect(result.result.entries[0]?.status).toBe("not-ready")
    expect(commands(runner, "submit")).toEqual([])
    expect(paneRuns(runner)).toEqual([])
  })

  it("requires save permission as well as explicit start permission before saving notes", async () => {
    const runner = new FleetRunner()
    const stopped = fleet("default", "stopped")
    runner.inventories.set("default", { ...stopped, actions: { ...stopped.actions, submit: refused("Submission gate is busy.") } })
    const result = await run([queued(1, { action: "start" })], { runner })
    expect(result.result.entries[0]).toMatchObject({ status: "not-ready", message: expect.stringContaining("Submission gate is busy") })
    expect(commands(runner, "submit")).toEqual([])
    expect(paneRuns(runner)).toEqual([])
  })

  it("reuses a durable handled receipt without submission, lookup, or another supervisor", async () => {
    const job = queued(1, { action: "start" })
    const journal = new MemoryJournal()
    const request = requestFor(job)
    journal.seed(request, "accepted", receiptFor(request, { state: "handled", announcement: "not-needed" }))
    const result = await run([job], { journal })
    expect(result.exitCode).toBe(0)
    expect(result.result.entries[0]).toMatchObject({ status: "accepted", receipt: { state: "handled" }, supervisor: "running" })
    expect(commands(result.runner, "submit")).toEqual([])
    expect(commands(result.runner, "receipt")).toEqual([])
    expect(paneRuns(result.runner)).toEqual([])
    expect(result.events).toContain(`callback:accepted:${uuid(1)}`)
  })

  it.each(["sending", "unknown"] as const)("reconciles a reopened %s request by its original ID and payload", async (status) => {
    const job = queued(1)
    const request = requestFor(job)
    const journal = new MemoryJournal()
    journal.seed(request, status)
    const runner = new FleetRunner()
    runner.receipts.set(request.requestId, receiptFor(request))
    const result = await run([job], { journal, runner })
    expect(result.exitCode).toBe(0)
    expect(commands(runner, "submit")).toEqual([])
    expect(commands(runner, "receipt")).toHaveLength(1)
    expect(commands(runner, "receipt")[0]!.options!.stdin).toBe(canonicalFirstmateJson({
      schemaVersion: 1, requestId: request.requestId, expectedFleet: request.expectedFleet,
    }))
    expect(journal.entries.get(request.requestId)).toMatchObject({ status: "accepted", request })
  })

  it("does not retry rejected durable records and does not send later notes", async () => {
    const jobs = [queued(1), queued(2)]
    const journal = new MemoryJournal()
    journal.seed(requestFor(jobs[0]!), "rejected")
    const result = await run(jobs, { journal })
    expect(result.result.entries.map(({ status }) => status)).toEqual(["submission-rejected", "not-submitted"])
    expect(commands(result.runner, "submit")).toEqual([])
    expect(commands(result.runner, "receipt")).toEqual([])
    expect(journal.entries.get(uuid(2))?.status).toBe("prepared")
  })

  it("refuses changed content for a saved request ID without overwriting its original evidence", async () => {
    const job = queued(1)
    const request = requestFor(job)
    const journal = new MemoryJournal()
    journal.seed(request, "accepted", receiptFor(request))
    const changed = queued(1, { body: "A different specification." })
    const result = await run([changed], { journal })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries[0]).toMatchObject({ status: "not-submitted", message: expect.stringContaining("different content") })
    expect(result.runner.calls).toEqual([])
    expect(journal.entries.get(uuid(1))).toMatchObject({ request, receipt: receiptFor(request) })
  })

  it("keeps earlier notes accepted after a native rejection and lets an ordinary job proceed", async () => {
    const runner = new FleetRunner()
    const jobs = [queued(1), queued(2), queued(3)]
    const request = requestFor(jobs[1]!)
    runner.intercept = ({ executable, args, options }) => {
      if (executable === "/fixture/cpx") return ok({
        schemaVersion: 1, launcher: "cpx", profile: args[1], readiness: "healthy",
      })
      if (args[0] === "pane" && args[1] === "run" && args[3]!.includes("/fixture/cpx")) return ok()
      if (args[0] !== "submit" || JSON.parse(options!.stdin!).requestId !== request.requestId) return undefined
      return ok(receiptFor(request, {
        state: "rejected", noteId: null, announcement: "not-needed",
        error: { code: "submission-blocked", message: "The native mutation gate refused this note." },
      }))
    }
    const normal = createQueuedGuideJob(4, {
      surface: "native", launcher: "cpx", commandPath: "/fixture/cpx", profile: "default", headlessPrompt: true,
    }, "An independent ordinary task.", here)
    const result = await run([...jobs, normal], { runner })
    expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "submission-rejected", "not-submitted", "launched"])
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
    expect(commands(runner, "receipt")).toEqual([])
    expect(result.journal.entries.get(uuid(2))?.status).toBe("rejected")
    expect(result.result.entries[0]).toMatchObject({ receipt: { noteId: `note-${uuid(1)}` } })
  })

  it("reconciles instead of sending when another caller acquires the journal claim", async () => {
    const job = queued(1)
    const request = requestFor(job)
    const journal = new MemoryJournal()
    const runner = new FleetRunner()
    runner.receipts.set(request.requestId, receiptFor(request))
    journal.fail = (operation) => {
      if (operation !== "begin") return
      journal.seed(request, "sending")
      throw new FirstmateJournalError(FirstmateJournalErrorCode.AttemptProtected, "Another caller owns this attempt.")
    }
    const result = await run([job], { runner, journal })
    expect(result.exitCode).toBe(0)
    expect(commands(runner, "submit")).toEqual([])
    expect(commands(runner, "receipt")).toHaveLength(1)
    expect(journal.entries.get(request.requestId)?.status).toBe("accepted")
  })

  it.each(["lost output", "unstructured error"] as const)("records unknown after %s and queries once without resubmitting", async (kind) => {
    const events: string[] = []
    const runner = new FleetRunner(events)
    const journal = new MemoryJournal(events)
    const job = queued(1)
    const request = requestFor(job)
    runner.intercept = ({ args }) => {
      if (args[0] !== "submit") return undefined
      runner.receipts.set(request.requestId, receiptFor(request))
      return kind === "lost output" ? ok("not JSON") : new Error("Transport closed after native publication.")
    }
    const result = await run([job], { runner, journal })
    expect(result.exitCode).toBe(0)
    expect(submissionIds(runner)).toEqual([request.requestId])
    expect(commands(runner, "receipt")).toHaveLength(1)
    expect(events.indexOf(`callback:unknown:${request.requestId}`)).toBeLessThan(events.indexOf(`command:receipt:${request.requestId}`))
    expect(journal.entries.get(request.requestId)?.status).toBe("accepted")
  })

  it.each(["wrong ID", "wrong digest", "wrong fleet", "not-found", "refused lookup"] as const)(
    "keeps partial acceptance and blocks only the affected group after %s",
    async (kind) => {
      const runner = new FleetRunner()
      const jobs = [queued(1), queued(2), queued(3), queued(4, { name: "pstack-workers" })]
      const uncertain = requestFor(jobs[1]!)
      runner.intercept = ({ args, options }) => {
        if (options?.stdin === undefined || JSON.parse(options.stdin).requestId !== uncertain.requestId) return undefined
        if (args[0] === "submit") return ok("lost response")
        if (args[0] !== "receipt" || kind === "not-found") return undefined
        if (kind === "refused lookup") return ok(receiptFor(uncertain, {
          state: "rejected", noteId: null, announcement: "not-needed",
          error: { code: "not-ready", message: "The lookup was refused." },
        }))
        return ok(receiptFor(uncertain, kind === "wrong ID" ? { requestId: uuid(99) }
          : kind === "wrong digest" ? { digest: "a".repeat(64) }
          : { fleet: { ...uncertain.expectedFleet, home: "/other/home" } }))
      }
      const result = await run(jobs, { runner })
      expect(result.exitCode).toBe(1)
      expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "submission-unknown", "not-submitted", "accepted"])
      expect(submissionIds(runner).filter((id) => id !== uuid(4))).toEqual([uuid(1), uuid(2)])
      expect(commands(runner, "receipt")).toHaveLength(1)
      expect(result.journal.entries.get(uuid(2))?.status).toBe("unknown")
      expect(result.journal.entries.get(uuid(3))?.status).toBe("prepared")
      expect(result.output).toContain("reconcile the same request ID and payload")
      expect(result.output).not.toContain(jobs[1]!.prompt)
    },
  )

  it("keeps a nonzero saved-note wake failure accepted and stops further sends and startup", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    const jobs = [queued(1, { action: "start" }), queued(2, { action: "start" })]
    const receipt = receiptFor(requestFor(jobs[0]!), {
      announcement: "failed", supervisorState: "stopped", error: { code: "wake-failed", message: "The note exists but the wake failed." },
    })
    runner.intercept = ({ executable, args }) => args[0] === "submit" ? new CommandRunnerError({
      kind: "exited", executable, args, exitCode: 1, stdout: JSON.stringify(receipt), message: "Native wake failed.",
    }) : undefined
    const result = await run(jobs, { runner })
    expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "not-submitted"])
    expect(result.result.entries[0]).toMatchObject({ receipt })
    expect(result.exitCode).toBe(1)
    expect(submissionIds(runner)).toEqual([uuid(1)])
    expect(commands(runner, "receipt")).toEqual([])
    expect(paneRuns(runner)).toEqual([])
    expect(result.output).toContain("announcement failed")
    expect(result.output).toContain("The note exists but the wake failed.")
  })

  it.each(["stopped", "unsafe"] as const)("stops send-only mutation when an accepted receipt reports the supervisor is %s", async (supervisorState) => {
    const runner = new FleetRunner()
    const jobs = [queued(1), queued(2)]
    const receipt = receiptFor(requestFor(jobs[0]!), { announcement: "pending", supervisorState })
    runner.intercept = ({ args }) => args[0] === "submit" ? ok(receipt) : undefined
    const result = await run(jobs, { runner, context: { cwd: "/fixture/caller-a" } })
    expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "not-submitted"])
    expect(result.exitCode).toBe(1)
    expect(submissionIds(runner)).toEqual([uuid(1)])
    expect(paneRuns(runner)).toEqual([])
    expect(result.result.entries[0]).toMatchObject({ receipt, supervisor: supervisorState })
  })

  it("does not start a supervisor after a save reports unsafe supervisor ownership", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    const job = queued(1, { action: "start" })
    runner.intercept = ({ args }) => args[0] === "submit"
      ? ok(receiptFor(requestFor(job), { announcement: "pending", supervisorState: "unsafe" })) : undefined
    const result = await run([job], { runner })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries[0]).toMatchObject({
      status: "accepted", supervisor: "unsafe", startupError: expect.stringContaining("not attempted"),
    })
    expect(paneRuns(runner)).toEqual([])
  })

  it("does not treat generic busy output or a successful pane command as a running supervisor", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    runner.intercept = ({ args }) => args[0] === "pane" && args[1] === "run" ? ok("busy") : undefined
    const result = await run([queued(1, { action: "start" })], { runner })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries[0]).toMatchObject({
      status: "accepted", supervisor: "stopped", startupError: expect.stringContaining("not confirmed"),
    })
    expect(paneRuns(runner)).toHaveLength(1)
    expect(result.time.sleeps).toEqual([5, 5, 5, 5])
    expect(commands(runner, "agent")).toEqual([])
  })

  it.each(["instanceId", "home", "sourceRevision"] as const)("carries the original guard when %s changes at native startup entry", async (field) => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    runner.intercept = ({ args }) => {
      if (args[0] !== "pane" || args[1] !== "run") return undefined
      const current = fleet("default", "stopped")
      runner.inventories.set("default", {
        ...current,
        identity: {
          ...current.identity!,
          [field]: field === "home" ? "/replacement/home" : field === "sourceRevision" ? "c".repeat(40) : uuid(999),
        },
      })
      return undefined
    }
    const job = queued(1, { action: "start" })
    const result = await run([job], { runner })
    expect(result.exitCode).toBe(1)
    expect(paneRuns(runner)[0]?.args[3]).toBe(expectedSupervisorCommand("default"))
    expect(runner.supervisorStarts).toEqual([])
    expect(runner.inventories.get("default")?.supervisor.state).toBe("stopped")
    expect(result.result.entries[0]).toMatchObject({
      status: "accepted", supervisor: "unknown", startupError: expect.stringContaining("identity"),
      request: { expectedFleet: identity("default") },
    })
    expect(job.command.args).toEqual(["default"])
  })

  it.each([
    { kind: "quoted", home: "/fixture/owner's fleet/home" },
    { kind: "maximum-length Unicode", home: `/${"\u0800".repeat(4095)}` },
  ])("bounds and quotes $kind identity data without changing public commands or copying task text into startup argv", async ({ home }) => {
    const runner = new FleetRunner()
    const expected = { ...identity("default"), home }
    runner.inventories.set("default", { ...fleet("default", "stopped"), identity: expected })
    const base = queued(1, { action: "start" })
    const job = { ...base, firstmate: { ...base.firstmate!, expectedFleet: expected } }
    const result = await run([job], { runner })
    expect(result.exitCode).toBe(0)
    expect(runner.supervisorStarts).toEqual([expected])
    expect(job.command.args).toEqual(["default"])
    expect(job.prompt).not.toContain(expected.home)
    expect(paneRuns(runner)[0]?.args[3]).not.toContain(job.prompt)
    expect(paneRuns(runner)[0]?.args[3]).not.toContain(job.guideContext!.originalIntent)
  })

  it.each([false, true])("converges a failed startup command only with exact live fleet evidence: %s", async (running) => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    runner.intercept = ({ executable, args }) => {
      if (args[0] !== "pane" || args[1] !== "run") return undefined
      if (running) runner.inventories.set("default", fleet("default", "running"))
      return new CommandRunnerError({ kind: "timed-out", executable, args, message: "busy: another supervisor start may have won." })
    }
    const result = await run([queued(1, { action: "start" })], { runner })
    expect(result.exitCode).toBe(running ? 0 : 1)
    expect(result.result.entries[0]).toMatchObject({ status: "accepted", supervisor: running ? "running" : "stopped" })
    expect("startupError" in result.result.entries[0]!).toBe(!running)
    expect(paneRuns(runner)).toHaveLength(1)
    expect(submissionIds(runner)).toEqual([uuid(1)])
  })

  it.each(["home", "instanceId", "sourceRevision"] as const)("preserves accepted receipts when startup reports a different %s", async (field) => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    runner.intercept = ({ args }) => {
      if (args[0] !== "pane" || args[1] !== "run") return undefined
      const running = fleet("default")
      runner.inventories.set("default", { ...running, identity: {
        ...running.identity!, [field]: field === "home" ? "/changed/home" : field === "instanceId" ? uuid(999) : "a".repeat(40),
      } })
      return ok()
    }
    const result = await run([queued(1, { action: "start" })], { runner })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries[0]).toMatchObject({ status: "accepted", supervisor: "unknown", startupError: expect.any(String) })
    expect(result.journal.entries.get(uuid(1))?.status).toBe("accepted")
    expect(paneRuns(runner)).toHaveLength(1)
  })

  it.each(["running", "changed identity", "requires recovery"] as const)("rechecks after saving and before allocation: %s", async (change) => {
    const runner = new FleetRunner()
    const journal = new MemoryJournal()
    runner.inventories.set("default", fleet("default", "stopped"))
    const result = await run([queued(1, { action: "start" })], { runner, journal, services: {
      onFirstmateUpdate: async (_, entry) => {
        if (entry.status !== "accepted") return
        const next = fleet("default", change === "requires recovery" ? "stale" : "running")
        runner.inventories.set("default", change === "changed identity"
          ? { ...next, identity: { ...next.identity!, home: "/different/home" } } : next)
      },
    } })
    expect(result.exitCode).toBe(change === "running" ? 0 : 1)
    expect(result.result.entries[0]?.status).toBe("accepted")
    expect(runner.calls.some(({ executable }) => executable === "herdr")).toBe(false)
    expect(submissionIds(runner)).toEqual([uuid(1)])
  })

  it.each(["prepared", "sending", "accepted"] as const)("stops when the durable %s callback fails and preserves the request", async (status) => {
    const job = queued(1, { action: "start" })
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    const result = await run([job, queued(2, { action: "start" })], { runner, services: {
      onFirstmateUpdate: async (_, entry) => {
        if (entry.status === status && entry.request.requestId === uuid(1)) throw new Error("Continuation storage failed.")
      },
    } })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries[0]?.status).toBe(status === "prepared" ? "not-submitted" : status === "sending" ? "submission-unknown" : "accepted")
    expect(result.result.entries[1]?.status).toBe("not-submitted")
    expect(result.journal.entries.get(uuid(1))).toMatchObject({ status, request: requestFor(job) })
    expect(submissionIds(runner)).toEqual(status === "accepted" ? [uuid(1)] : [])
    expect(paneRuns(runner)).toEqual([])
    expect(result.output).toContain("Continuation storage failed.")
  })

  it.each(["prepare", "begin", "record"] as const)("surfaces journal %s failure without unsafe fallback or further sends", async (operation) => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    const journal = new MemoryJournal()
    journal.fail = (step, request) => {
      if (step === operation && request.requestId === uuid(operation === "prepare" ? 2 : 1)) {
        throw new Error("Private journal I/O failed.")
      }
    }
    const result = await run([queued(1, { action: "start" }), queued(2, { action: "start" })], { runner, journal })
    expect(result.exitCode).toBe(1)
    expect(submissionIds(runner)).toEqual(operation === "record" ? [uuid(1)] : [])
    expect(paneRuns(runner)).toEqual([])
    expect(result.output).toContain("Private journal I/O failed.")
    if (operation === "record") expect(result.result.entries[0]).toMatchObject({
      status: "accepted", receipt: { noteId: `note-${uuid(1)}` }, startupError: expect.stringContaining("I/O failed"),
    })
  })

  it("recovers receipt persistence failure with lookup of the original request on the next run", async () => {
    const runner = new FleetRunner()
    const journal = new MemoryJournal()
    const job = queued(1)
    journal.fail = (operation) => { if (operation === "record") throw new Error("Disk unavailable.") }
    const initial = await run([job], { runner, journal })
    expect(initial.exitCode).toBe(1)
    expect(initial.result.entries[0]?.status).toBe("accepted")
    expect(journal.entries.get(uuid(1))?.status).toBe("sending")
    journal.fail = undefined
    const resumed = await run([job], { runner, journal })
    expect(resumed.exitCode).toBe(0)
    expect(submissionIds(runner)).toEqual([uuid(1)])
    expect(commands(runner, "receipt")).toHaveLength(1)
  })

  it("retains acceptance when recording the shared destination fails and does not start", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    const result = await run([queued(1, { action: "start" }), queued(2, { action: "start" })], { runner, services: {
      onAllocated: async () => { throw new Error("Destination persistence failed.") },
    } })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries.every((entry) => entry.status === "accepted" && entry.startupError?.includes("Destination persistence failed"))).toBe(true)
    expect(paneRuns(runner)).toEqual([])
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
  })

  it("does not launch a different home that appears while saving the allocated destination", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    const result = await run([queued(1, { action: "start" })], { runner, services: {
      onAllocated: async () => {
        const replaced = fleet("default", "stopped")
        runner.inventories.set("default", { ...replaced, identity: { ...replaced.identity!, home: "/different/home" } })
      },
    } })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries[0]).toMatchObject({ status: "accepted", supervisor: "unknown", startupError: expect.stringContaining("identity changed") })
    expect(paneRuns(runner)).toEqual([])
  })

  it("reports allocation failure separately after saving all notes", async () => {
    const runner = new FleetRunner()
    runner.inventories.set("default", fleet("default", "stopped"))
    runner.intercept = ({ args }) => args[0] === "pane" && args[1] === "split" ? new Error("Pane allocation was refused.") : undefined
    const result = await run([queued(1, { action: "start" }), queued(2, { action: "start" })], { runner })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries.every((entry) => entry.status === "accepted" && entry.startupError === "Pane allocation was refused.")).toBe(true)
    expect(submissionIds(runner)).toEqual([uuid(1), uuid(2)])
    expect(paneRuns(runner)).toEqual([])
  })

  it("preserves accepted evidence if a progress callback fails and allows a different fleet to proceed", async () => {
    const result = await run([queued(1), queued(2), queued(3, { name: "pstack-workers" })], { services: {
      onProgress: ({ jobId, phase }) => {
        if (jobId === 1 && phase === "done") throw new Error("Progress output failed.")
      },
    } })
    expect(result.exitCode).toBe(1)
    expect(result.result.entries.map(({ status }) => status)).toEqual(["accepted", "not-submitted", "accepted"])
    expect(result.result.entries[0]).toMatchObject({ startupError: expect.stringContaining("Progress output failed") })
    expect(submissionIds(result.runner)).not.toContain(uuid(2))
  })

  it("uses the default durable journal when no journal is injected", async () => {
    const memory = new MemoryJournal()
    const prepare = vi.spyOn(FileFirstmateSubmissionJournal.prototype, "prepare").mockImplementation(memory.prepare.bind(memory))
    vi.spyOn(FileFirstmateSubmissionJournal.prototype, "begin").mockImplementation(memory.begin.bind(memory))
    vi.spyOn(FileFirstmateSubmissionJournal.prototype, "record").mockImplementation(memory.record.bind(memory))
    try {
      const job = queued(1)
      const result = await executeGuideBatch({ jobs: [job], context: { cwd: "/fixture/caller-a" } }, {
        runner: new FleetRunner(), write: () => undefined,
      })
      expect(result.exitCode).toBe(0)
      expect(prepare).toHaveBeenCalledWith(requestFor(job))
      expect(memory.entries.get(uuid(1))?.status).toBe("accepted")
    } finally {
      vi.restoreAllMocks()
    }
  })
})
