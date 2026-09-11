/**
 * Copilot SDK-backed implementation of `GuideProvider` for `trx guide`.
 *
 * Model session policy (per the approved `trx guide` design):
 * - Match, optimize, and refine default to `gpt-5.6-sol` at `medium`;
 *   generate defaults to `gpt-5.6-luna` at `medium`. Callers can supply a
 *   phase routing table or force one model/effort across every phase.
 * - `client.listModels()` is checked before every phase call: the model must
 *   exist, support reasoning effort, and support the configured effort
 *   level. Otherwise the call is rejected before any session is created,
 *   with the model's actually-supported effort values in the error.
 * - Client mode is `"empty"` (the SDK's opt-in-everything mode) with no
 *   built-in plugin directories and an explicit `baseDirectory`. Both the
 *   client and the session run with a `workingDirectory` outside the
 *   repository (default: a directory under `os.tmpdir()`), so no tool or
 *   file operation the session might otherwise attempt can resolve into
 *   this checkout.
 * - Sessions request `tools: []` and `availableTools: []` (no tools at
 *   all), and explicitly disable every unrelated discovery, extension, and
 *   persistence surface the SDK exposes: `enableConfigDiscovery`, `mcpServers`,
 *   `customAgents`, `skillDirectories`, `pluginDirectories`,
 *   `instructionDirectories`, `requestExtensions`,
 *   `requestCanvasRenderer`, `manageScheduleEnabled`,
 *   `skipCustomInstructions`, `enableOnDemandInstructionDiscovery`,
 *   `enableFileHooks`, `enableHostGitOperations`, `enableSessionStore`,
 *   `enableSkills`, `infiniteSessions`, `memory`, `skipEmbeddingRetrieval`,
 *   `embeddingCacheStorage`, `enableFileChangeTracking`,
 *   `enableSessionTelemetry`, and `remoteSession`. Only the optimize phase
 *   enables skills, with one exact `prompt-master` directory. The session is also
 *   deleted from the client after use, so no on-disk session store
 *   persists.
 * - The permission handler always rejects — this provider never grants any
 *   tool, file, or shell permission.
 * - The per-phase Markdown instructions (see `guide-prompts.ts` and
 *   `prompts/*.md`) are installed as the session's system message, in
 *   either `"append"` (default; keeps the SDK's own guardrails) or
 *   `"replace"` mode, and are scoped entirely to demanding raw JSON output —
 *   they carry no other behavioral instructions.
 * - Requests use `sendAndWait`: 30s for `match`, 60s for `generate` and
 *   `refine` by default (all configurable).
 * - Exactly one repair request is sent when a *completed* response fails
 *   JSON parsing or schema validation. A thrown error or an `undefined`
 *   result from `sendAndWait` (network failure, timeout, or no assistant
 *   message) is never retried. Completed response content is bounded
 *   before `JSON.parse` so an oversized response cannot create unbounded
 *   parsing work.
 * - Cleanup always attempts, in order, `session.disconnect()`,
 *   `client.deleteSession()`, and `client.stop()` — even if an earlier
 *   cleanup step throws. A primary request/validation error is never
 *   masked by a cleanup failure; if cleanup fails and there was no primary
 *   error, the cleanup failure is surfaced instead.
 */
import { accessSync, constants, lstatSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type ModelInfo,
  type SessionConfig,
} from "@github/copilot-sdk"
import {
  defaultGuideModelRouting,
  type GuideModelPhase,
  type GuideModelRouting,
  type GuideReasoningEffort,
} from "./guide-model-routing.js"
import type { GuideModelPrompts } from "./guide-prompts.js"
import {
  guideGoalApproachBudget,
  guideGoalCandidateBody,
  resolveGuideGoalExecution,
  type GuideGoalExecution,
} from "./guide-goal-execution.js"
import { workflowPromptFrame } from "./guide-workflow-prompt.js"
import {
  assertGuideEnrichInput,
  assertGuideGenerateInput,
  assertGuideMatchInput,
  assertGuideOptimizeInput,
  validateGuideEnrichResult,
  validateGuideGenerateResult,
  validateGuideMatchResult,
  validateGuideOptimizeResult,
  validateGuideRefineResult,
  type GuideEnrichInput,
  type GuideEnrichResult,
  type GuideGenerateInput,
  type GuideGenerateResult,
  type GuideMatchInput,
  type GuideMatchResult,
  type GuideOptimizeInput,
  type GuideOptimizeResult,
  type GuideProvider,
  type GuideRefineInput,
  type GuideRefineResult,
} from "./guide-provider.js"

/** A response message shape narrow enough to be satisfied by both `AssistantMessageEvent` and test fakes. */
export interface GuideModelMessage {
  readonly data: { readonly content: string }
}

/**
 * The subset of `CopilotSession` this adapter uses. Structurally satisfied
 * by the real `CopilotSession`, so tests can inject a minimal fake instead
 * of a live SDK connection.
 */
export interface GuideModelSession {
  readonly sessionId: string
  sendAndWait(options: { readonly prompt: string }, timeoutMs: number): Promise<GuideModelMessage | undefined>
  disconnect(): Promise<void>
  send?(options: { readonly prompt: string }): Promise<string>
  on?(handler: (event: { readonly type: string; readonly data: unknown }) => void): () => void
  abort?(): Promise<void>
}

/**
 * The subset of `CopilotClient` this adapter uses. Structurally satisfied
 * by the real `CopilotClient`, so tests can inject a fake client that makes
 * no live calls.
 */
export interface GuideModelClient {
  start(): Promise<void>
  listModels(): Promise<ReadonlyArray<ModelInfo>>
  createSession(config: SessionConfig): Promise<GuideModelSession>
  deleteSession(sessionId: string): Promise<void>
  stop(): Promise<ReadonlyArray<Error>>
  forceStop?(): Promise<void>
}

/** Thrown when the configured model is missing or does not support the configured reasoning effort. */
export class GuideModelCapabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "GuideModelCapabilityError"
  }
}

/** Thrown when a completed model response is not parseable/valid JSON matching the phase's schema. */
export class GuideModelResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GuideModelResponseError"
  }
}

/**
 * Thrown when one or more cleanup steps (`session.disconnect()`,
 * `client.deleteSession()`, `client.stop()`) fail after an otherwise
 * successful request. Never thrown when a primary request/validation error
 * already occurred — that error always takes precedence.
 */
export class GuideModelCleanupError extends Error {
  readonly causes: ReadonlyArray<unknown>

  constructor(causes: ReadonlyArray<unknown>) {
    super(
      `guide model session cleanup failed: ${causes
        .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
        .join("; ")}`,
    )
    this.name = "GuideModelCleanupError"
    this.causes = causes
  }
}

export interface CopilotGuideProviderOptions {
  /** Forces one model across every phase when set. */
  readonly model?: string
  /** Forces one reasoning effort across every phase when set. */
  readonly effort?: GuideReasoningEffort
  /** Phase-specific routing used when no global model or effort override is set. */
  readonly routing?: GuideModelRouting
  /** Authored match/generate/refine system instructions. See `guide-prompts.ts`. */
  readonly prompts: GuideModelPrompts
  /** Copilot runtime data directory (required by client `mode: "empty"`). @default "<home>/.copilot/trx-guide" */
  readonly baseDirectory?: string
  /** Working directory for both the client runtime process and every session, kept outside the repository. @default os.tmpdir() */
  readonly workingDirectory?: string
  /** Client identifier included in the User-Agent header. @default "trellage-trx-guide" */
  readonly clientName?: string
  /** Copilot CLI executable. Defaults to the first executable `copilot` entry on PATH. */
  readonly copilotCliPath?: string
  /** @default "append" */
  readonly systemMessageMode?: "append" | "replace"
  /** Milliseconds allowed for the match phase's `sendAndWait`. @default 30000 */
  readonly matchTimeoutMs?: number
  /** Milliseconds allowed for the generate phase's `sendAndWait`. @default 60000 */
  readonly generateTimeoutMs?: number
  /** Milliseconds allowed for the refine phase's `sendAndWait`. @default 60000 */
  readonly refineTimeoutMs?: number
  /** Exact `prompt-master` skill directory used only by the optimize phase. */
  readonly promptMasterSkillDirectory?: string
  /** Milliseconds allowed for the Prompt Master phase's `sendAndWait`. @default 60000 */
  readonly optimizeTimeoutMs?: number
  /** Milliseconds allowed for the enrich phase's `sendAndWait`. Longer than the other phases: it reads a packed repository. @default 180000 */
  readonly enrichTimeoutMs?: number
  /** Injectable client constructor, so unit tests never spawn a real Copilot runtime. */
  readonly clientFactory?: (options: CopilotClientOptions) => GuideModelClient
  /** When supplied, requests use real SDK abort and bounded cleanup. */
  readonly signal?: AbortSignal
}

const defaultClientFactory = (options: CopilotClientOptions): GuideModelClient => new CopilotClient(options)

const applyGlobalModelOverrides = (
  config: GuideModelRouting[GuideModelPhase],
  options: Pick<CopilotGuideProviderOptions, "model" | "effort">,
): GuideModelRouting[GuideModelPhase] => ({
  model: options.model ?? config.model,
  effort: options.effort ?? config.effort,
})

export const resolveProviderRouting = (
  options: Pick<CopilotGuideProviderOptions, "model" | "effort" | "routing">,
): GuideModelRouting => {
  const routing = options.routing ?? defaultGuideModelRouting
  return {
    match: applyGlobalModelOverrides(routing.match, options),
    generate: applyGlobalModelOverrides(routing.generate, options),
    optimize: applyGlobalModelOverrides(routing.optimize, options),
    refine: applyGlobalModelOverrides(routing.refine, options),
    enrich: applyGlobalModelOverrides(routing.enrich, options),
  }
}

export const findExecutableOnPath = (name: string, searchPath = process.env.PATH): string | undefined => {
  if (searchPath === undefined) return undefined
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue
    const candidate = path.resolve(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue until an executable entry is found.
    }
  }
  return undefined
}

/** Maximum size (in UTF-8 bytes) of a completed assistant message accepted before attempting `JSON.parse`. */
const maximumResponseBytes = 64 * 1024

const untrustedMessage = (payload: string): string =>
  ["Respond with raw JSON only, per your instructions.", "", "<untrusted-data>", payload, "</untrusted-data>"].join(
    "\n",
  )

const repairMessage = (cause: unknown): string => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return [
    "Your previous response was invalid.",
    `Validation error: ${reason}`,
    "Respond again with corrected raw JSON only, matching the schema in your instructions exactly.",
    "No Markdown code fences, no prose before or after the JSON.",
  ].join("\n")
}

const promptMasterMessage = (input: Pick<GuideOptimizeInput, "targetTool" | "profileRef">): string =>
  [
    `/prompt-master Optimize these prompts for ${input.targetTool} in Trellage profile ${input.profileRef}.`,
    "Return only the JSON required by the system message.",
    "",
    "<untrusted-data>",
    JSON.stringify(input),
    "</untrusted-data>",
  ].join("\n")

const goalModelContext = (execution: GuideGoalExecution) => ({
  goal: { ...execution.goal.draft, minimumScore: 8 },
  goalController: execution.controller,
  approachMaximumLength: guideGoalApproachBudget(execution),
  fixedFrame: workflowPromptFrame(execution.workflow),
})

const generationModelInput = (input: GuideGenerateInput, execution?: GuideGoalExecution) =>
  execution === undefined
    ? input
    : { ...input, intent: execution.goal.draft.task, ...goalModelContext(execution) }

const skillSessionPolicy = (
  skillDirectory: string | undefined,
): Pick<SessionConfig, "enableSkills" | "skillDirectories"> =>
  skillDirectory === undefined
    ? { enableSkills: false, skillDirectories: [] }
    : { enableSkills: true, skillDirectories: [skillDirectory] }

const requestMessage = <Input>(
  input: Input,
  message: ((input: Input) => string) | undefined,
): string => (message === undefined ? untrustedMessage(JSON.stringify(input)) : message(input))

const parseJson = (content: string): unknown => {
  const byteLength = Buffer.byteLength(content, "utf8")
  if (byteLength > maximumResponseBytes) {
    throw new GuideModelResponseError(
      `model response was too large to parse: ${byteLength} bytes exceeds the ${maximumResponseBytes}-byte limit`,
    )
  }
  try {
    return JSON.parse(content)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new GuideModelResponseError(`model response was not valid JSON: ${reason}`)
  }
}

/** Runs `step`, appending any thrown error to `errors` instead of propagating it, so later cleanup steps still run. */
export const runCleanupStep = async (errors: unknown[], step: () => Promise<unknown>): Promise<void> => {
  try {
    await step()
  } catch (error) {
    errors.push(error)
  }
}

const collectClientStopErrors = async (client: GuideModelClient, cleanupErrors: unknown[]): Promise<void> => {
  try {
    cleanupErrors.push(...(await client.stop()))
  } catch (error) {
    cleanupErrors.push(error)
  }
}

export const assertGuideModelCapability = (
  models: ReadonlyArray<ModelInfo>,
  config: GuideModelRouting[GuideModelPhase],
): void => {
  const modelInfo = models.find((candidate) => candidate.id === config.model)
  if (modelInfo === undefined) {
    throw new GuideModelCapabilityError(`model is not available: ${config.model}`)
  }
  if (!modelInfo.capabilities.supports.reasoningEffort) {
    throw new GuideModelCapabilityError(`model does not support reasoning effort: ${config.model}`)
  }
  const supportedEfforts = modelInfo.supportedReasoningEfforts ?? []
  if (!supportedEfforts.includes(config.effort)) {
    throw new GuideModelCapabilityError(
      `model does not support effort "${config.effort}": ${config.model} supports: ${supportedEfforts.join(", ") || "(none)"}`,
    )
  }
}

/** The tool-denied baseline; interactive adapters must name each permitted tool. */
export const restrictedGuideSessionConfig = (options: {
  readonly model: string
  readonly effort: GuideReasoningEffort
  readonly clientName: string
  readonly workingDirectory: string
  readonly systemPrompt: string
  readonly systemMessageMode?: "append" | "replace"
  readonly skillDirectory?: string
  readonly onActivity?: (event: { readonly type: string }) => void
}): SessionConfig => ({
  clientName: options.clientName,
  model: options.model,
  reasoningEffort: options.effort,
  workingDirectory: options.workingDirectory,
  enableConfigDiscovery: false,
  tools: [],
  availableTools: [],
  mcpServers: {},
  customAgents: [],
  ...skillSessionPolicy(options.skillDirectory),
  pluginDirectories: [],
  instructionDirectories: [],
  hooks: {},
  requestExtensions: false,
  requestCanvasRenderer: false,
  manageScheduleEnabled: false,
  skipCustomInstructions: true,
  enableOnDemandInstructionDiscovery: false,
  enableFileHooks: false,
  enableHostGitOperations: false,
  enableSessionStore: false,
  infiniteSessions: { enabled: false },
  memory: { enabled: false },
  skipEmbeddingRetrieval: true,
  embeddingCacheStorage: "in-memory",
  enableFileChangeTracking: false,
  enableSessionTelemetry: false,
  remoteSession: "off",
  onPermissionRequest: () => ({ kind: "reject" }),
  ...(options.onActivity === undefined ? {} : { onEvent: options.onActivity }),
  systemMessage: { mode: options.systemMessageMode ?? "append", content: options.systemPrompt },
})

export enum RestrictedGuideEventType {
  Message = "assistant.message",
  Idle = "session.idle",
  Error = "session.error",
}

export interface RestrictedGuideModelSession {
  readonly sessionId: string
  send(options: { readonly prompt: string }): Promise<string>
  on(handler: (event: { readonly type: string; readonly data: unknown }) => void): () => void
  abort(): Promise<void>
  disconnect(): Promise<void>
}

export interface RestrictedGuideModelClient {
  start(): Promise<void>
  listModels(): Promise<ReadonlyArray<ModelInfo>>
  createSession(config: SessionConfig): Promise<RestrictedGuideModelSession>
  deleteSession(sessionId: string): Promise<void>
  stop(): Promise<ReadonlyArray<Error>>
  forceStop(): Promise<void>
}

export interface RestrictedGuideModelRequest {
  readonly model: string
  readonly effort: GuideReasoningEffort
  readonly systemPrompt: string
  readonly prompt: string
  readonly timeoutMs: number
  readonly cleanupTimeoutMs: number
  readonly maximumResponseBytes: number
  readonly inspectModel: (model: ModelInfo) => void
  readonly signal?: AbortSignal
  readonly baseDirectory?: string
  readonly workingDirectory?: string
  readonly copilotCliPath?: string
  readonly clientFactory?: (options: CopilotClientOptions) => RestrictedGuideModelClient
  readonly skillDirectory?: string
  readonly systemMessageMode?: "append" | "replace"
  readonly clientName?: string
  readonly onActivity?: (event: { readonly type: string }) => void
}

export class RestrictedGuideModelError extends Error {
  constructor(
    readonly code: string,
    readonly cleanupFailures: ReadonlyArray<string> = [],
  ) {
    super(
      `restricted model request ${code}${cleanupFailures.length === 0 ? "" : `; cleanup failed: ${cleanupFailures.join(", ")}`}`,
    )
    this.name = code === "cancelled" ? "AbortError" : "RestrictedGuideModelError"
  }
}

const within = async <Value>(
  step: () => Promise<Value>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Value> => {
  if (signal?.aborted) throw new RestrictedGuideModelError("cancelled")
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RestrictedGuideModelError("timed-out")), timeoutMs)
    cancel = () => reject(new RestrictedGuideModelError("cancelled"))
    signal?.addEventListener("abort", cancel, { once: true })
  })
  try {
    return await Promise.race([step(), interruption])
  } finally {
    clearTimeout(timer)
    if (cancel !== undefined) signal?.removeEventListener("abort", cancel)
  }
}

/**
 * One inference request, without schema repair. Unlike SDK sendAndWait, the
 * event waiter can be removed immediately after an acknowledged abort; it
 * does not leave the SDK's idle timer alive after disconnect.
 */
class RestrictedGuideRequest {
  private readonly client: RestrictedGuideModelClient
  private readonly workingDirectory: string
  private readonly deadline: number
  private readonly pending = new Set<Promise<unknown>>()
  private readonly cleanupFailures: string[] = []
  private stage = "start"
  private closing = false
  private session: RestrictedGuideModelSession | undefined
  private unsubscribe: (() => void) | undefined
  private content: string | undefined
  private failure: unknown

  constructor(private readonly options: RestrictedGuideModelRequest) {
    const baseDirectory = options.baseDirectory ?? path.join(os.homedir(), ".copilot", "trx-guide")
    this.workingDirectory = options.workingDirectory ?? os.homedir()
    this.deadline = Date.now() + options.timeoutMs
    const cliPath = options.copilotCliPath ?? findExecutableOnPath("copilot")
    this.client = (options.clientFactory ?? ((config) => new CopilotClient(config)))({
      mode: "empty",
      builtinPluginDirectories: [],
      ...(cliPath === undefined ? {} : { connection: RuntimeConnection.forStdio({ path: cliPath }) }),
      baseDirectory,
      workingDirectory: this.workingDirectory,
    })
  }

  private tracked<Value>(step: () => Promise<Value>): Promise<Value> {
    const promise = Promise.resolve().then(step)
    this.pending.add(promise)
    const settled = async (): Promise<void> => {
      this.pending.delete(promise)
      if (this.closing) await this.cleanupStep("late-operation-force-stop", () => this.client.forceStop())
    }
    void promise.then(settled, settled)
    return promise
  }

  private async cleanupStep(label: string, step: () => Promise<unknown>): Promise<boolean> {
    try {
      await within(step, this.options.cleanupTimeoutMs)
      return true
    } catch {
      this.cleanupFailures.push(label)
      return false
    }
  }

  private requestStep<Value>(step: () => Promise<Value>): Promise<Value> {
    return within(() => this.tracked(step), Math.max(1, this.deadline - Date.now()), this.options.signal)
  }

  private checkModel(models: ReadonlyArray<ModelInfo>): void {
    const model = models.find(({ id }) => id === this.options.model)
    if (model === undefined) throw new GuideModelCapabilityError(`model is not available: ${this.options.model}`)
    if (model.policy?.state === "disabled") throw new GuideModelCapabilityError(`model is disabled by policy: ${model.id}`)
    if (!model.capabilities.supports.reasoningEffort) {
      throw new GuideModelCapabilityError(`model does not support reasoning effort: ${model.id}`)
    }
    const efforts = model.supportedReasoningEfforts ?? []
    if (!efforts.includes(this.options.effort)) {
      throw new GuideModelCapabilityError(
        `model does not support effort "${this.options.effort}": ${model.id} supports: ${efforts.join(", ") || "(none)"}`,
      )
    }
    this.options.inspectModel(model)
  }

  private async open(): Promise<RestrictedGuideModelSession> {
    await this.requestStep(() => this.client.start())
    this.stage = "model-metadata"
    this.checkModel(await this.requestStep(() => this.client.listModels()))
    this.stage = "create-session"
    return this.requestStep(async () => {
      const created = await this.client.createSession(restrictedGuideSessionConfig({
        model: this.options.model,
        effort: this.options.effort,
        workingDirectory: this.workingDirectory,
        clientName: this.options.clientName ?? "trellage-trx-continuation",
        systemPrompt: this.options.systemPrompt,
        ...(this.options.skillDirectory === undefined ? {} : { skillDirectory: this.options.skillDirectory }),
        ...(this.options.systemMessageMode === undefined ? {} : { systemMessageMode: this.options.systemMessageMode }),
        ...(this.options.onActivity === undefined ? {} : { onActivity: this.options.onActivity }),
      }))
      this.session = created
      // A delayed create response must not resurrect a cancelled request.
      if (this.closing) {
        await this.cleanupStep("late-session-abort", () => created.abort())
        await this.cleanupStep("late-session-disconnect", () => created.disconnect())
        await this.cleanupStep("late-session-delete", () => this.client.deleteSession(created.sessionId))
        await this.cleanupStep("late-session-force-stop", () => this.client.forceStop())
      }
      return created
    })
  }

  private acceptMessage(data: unknown): void {
    if (typeof data !== "object" || data === null || !("content" in data) || typeof data.content !== "string") {
      throw new RestrictedGuideModelError("invalid-message")
    }
    if (Buffer.byteLength(data.content, "utf8") > this.options.maximumResponseBytes) {
      throw new RestrictedGuideModelError("response-too-large")
    }
    this.content = data.content
  }

  private async send(activeSession: RestrictedGuideModelSession): Promise<void> {
    let resolveIdle: (() => void) | undefined
    let rejectIdle: ((error: Error) => void) | undefined
    const idle = new Promise<void>((resolve, reject) => {
      resolveIdle = resolve
      rejectIdle = reject
    })
    // A synchronous fake, or an early runtime event, may arrive during send.
    void idle.catch(() => undefined)
    this.unsubscribe = activeSession.on((event) => {
      try {
        switch (event.type) {
          case RestrictedGuideEventType.Message:
            this.acceptMessage(event.data)
            break
          case RestrictedGuideEventType.Idle:
            resolveIdle?.()
            break
          case RestrictedGuideEventType.Error:
            throw new RestrictedGuideModelError("runtime-error")
        }
      } catch (error) {
        rejectIdle?.(error as Error)
      }
    })
    this.stage = "send"
    await this.requestStep(() => activeSession.send({ prompt: this.options.prompt }))
    this.stage = "response"
    await within(() => idle, Math.max(1, this.deadline - Date.now()), this.options.signal)
    if (this.content === undefined) throw new RestrictedGuideModelError("no-assistant-message")
    if (this.options.signal?.aborted) throw new RestrictedGuideModelError("cancelled")
  }

  private async abortFailedRequest(): Promise<void> {
    if (this.failure === undefined) return
    const session = this.session
    if (session === undefined) {
      await this.cleanupStep("force-stop", () => this.client.forceStop())
    } else if (!(await this.cleanupStep("abort", () => session.abort()))) {
      await this.cleanupStep("force-stop", () => this.client.forceStop())
    }
  }

  private async cleanup(): Promise<void> {
    this.closing = true
    await this.abortFailedRequest()
    await this.cleanupStep("event-unsubscribe", async () => this.unsubscribe?.())
    if (this.session !== undefined) {
      const session = this.session
      await this.cleanupStep("disconnect", () => session.disconnect())
      await this.cleanupStep("delete-session", () => this.client.deleteSession(session.sessionId))
    }
    const stopped = await this.cleanupStep("stop", async () => {
      const errors = await this.client.stop()
      if (errors.length > 0) throw new Error("stop")
    })
    if (!stopped || this.cleanupFailures.length > 0) {
      await this.cleanupStep("force-stop", () => this.client.forceStop())
    }
    if (this.pending.size > 0) {
      await this.cleanupStep("pending-operation", () => Promise.allSettled([...this.pending]))
      // start/create may have finished while stop was running.
      await this.cleanupStep("force-stop", () => this.client.forceStop())
    }
  }

  async run(): Promise<string> {
    try {
      await this.send(await this.open())
    } catch (error) {
      this.failure = error
    } finally {
      await this.cleanup()
    }
    if (this.failure instanceof RestrictedGuideModelError) {
      throw new RestrictedGuideModelError(this.failure.code, this.cleanupFailures)
    }
    if (this.failure instanceof GuideModelCapabilityError) {
      if (this.cleanupFailures.length === 0) throw this.failure
      throw new RestrictedGuideModelError(this.failure.message, this.cleanupFailures)
    }
    if (this.failure !== undefined) throw new RestrictedGuideModelError(`${this.stage}-failed`, this.cleanupFailures)
    if (this.cleanupFailures.length > 0) throw new RestrictedGuideModelError("cleanup-failed", this.cleanupFailures)
    return this.content!
  }
}

export const runRestrictedGuideModelRequest = async (options: RestrictedGuideModelRequest): Promise<string> => {
  if (options.signal?.aborted) throw new RestrictedGuideModelError("cancelled")
  for (const value of [options.timeoutMs, options.cleanupTimeoutMs, options.maximumResponseBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RestrictedGuideModelError("invalid-limits")
  }
  return new RestrictedGuideRequest(options).run()
}

const cancellableClient = (client: GuideModelClient): RestrictedGuideModelClient => {
  if (client.forceStop === undefined) throw new GuideModelCapabilityError("The model client does not support forceStop.")
  return {
    start: () => client.start(),
    listModels: () => client.listModels(),
    deleteSession: (id) => client.deleteSession(id),
    stop: () => client.stop(),
    forceStop: () => client.forceStop!(),
    createSession: async (config) => {
      const session = await client.createSession(config)
      return {
        sessionId: session.sessionId,
        disconnect: () => session.disconnect(),
        abort: async () => {
          if (session.abort === undefined) throw new GuideModelCapabilityError("The model session does not support abort.")
          await session.abort()
        },
        on: (handler) => {
          if (session.on === undefined || session.send === undefined || session.abort === undefined) {
            throw new GuideModelCapabilityError("The model session does not support cancellable requests.")
          }
          return session.on(handler)
        },
        send: (input) => session.send!(input),
      }
    },
  }
}

interface GuideRunOptions<Input> {
  readonly message?: (input: Input) => string
  readonly skillDirectory?: string
  readonly onActivity?: (line: string) => void
}

export class CopilotGuideProvider implements GuideProvider {
  private readonly routing: GuideModelRouting
  private readonly prompts: GuideModelPrompts
  private readonly baseDirectory: string
  private readonly workingDirectory: string
  private readonly clientName: string
  private readonly copilotCliPath: string | undefined
  private readonly systemMessageMode: "append" | "replace"
  private readonly matchTimeoutMs: number
  private readonly generateTimeoutMs: number
  private readonly refineTimeoutMs: number
  private readonly promptMasterSkillDirectory: string | undefined
  private readonly optimizeTimeoutMs: number
  private readonly enrichTimeoutMs: number
  private readonly clientFactory: (options: CopilotClientOptions) => GuideModelClient
  private readonly signal: AbortSignal | undefined

  constructor(options: CopilotGuideProviderOptions) {
    this.routing = resolveProviderRouting(options)
    this.prompts = options.prompts
    this.baseDirectory = options.baseDirectory ?? path.join(os.homedir(), ".copilot", "trx-guide")
    this.workingDirectory = options.workingDirectory ?? os.tmpdir()
    this.clientName = options.clientName ?? "trellage-trx-guide"
    this.copilotCliPath = options.copilotCliPath ?? findExecutableOnPath("copilot")
    this.systemMessageMode = options.systemMessageMode ?? "append"
    this.matchTimeoutMs = options.matchTimeoutMs ?? 30_000
    this.generateTimeoutMs = options.generateTimeoutMs ?? 60_000
    this.refineTimeoutMs = options.refineTimeoutMs ?? 60_000
    this.promptMasterSkillDirectory = options.promptMasterSkillDirectory
    this.optimizeTimeoutMs = options.optimizeTimeoutMs ?? 60_000
    this.enrichTimeoutMs = options.enrichTimeoutMs ?? 180_000
    this.clientFactory = options.clientFactory ?? defaultClientFactory
    this.signal = options.signal
  }

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    assertGuideMatchInput(input)
    const workflowIndex = new Map(
      input.entries.map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]),
    )
    const payload = input.goal === undefined
      ? input
      : {
          intent: input.goal.draft.task,
          entries: input.entries,
          goal: { ...input.goal.draft, minimumScore: 8 },
          ...(input.preferredProfileRefs === undefined ? {} : { preferredProfileRefs: input.preferredProfileRefs }),
        }
    return this.run("match", this.prompts.match, payload, this.matchTimeoutMs, (value) =>
      validateGuideMatchResult(value, workflowIndex, input.goal, input.preferredProfileRefs),
    )
  }

  async generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    assertGuideGenerateInput(input)
    const execution = input.goal === undefined ? undefined : resolveGuideGoalExecution(input.goal, input.guide, input.workflowId)
    return this.run(
      "generate",
      this.prompts.generate,
      generationModelInput(input, execution),
      this.generateTimeoutMs,
      (value) => validateGuideGenerateResult(value, execution),
    )
  }

  async refine(input: GuideRefineInput): Promise<GuideRefineResult> {
    assertGuideGenerateInput(input)
    const execution = input.goal === undefined ? undefined : resolveGuideGoalExecution(input.goal, input.guide, input.workflowId)
    const payload = execution === undefined
      ? input
      : {
          ...generationModelInput(input, execution),
          candidate: validateGuideRefineResult({ candidate: guideGoalCandidateBody(input.candidate) }, execution).candidate,
          feedback: input.feedback,
        }
    return this.run("refine", this.prompts.refine, payload, this.refineTimeoutMs, (value) =>
      validateGuideRefineResult(value, execution),
    )
  }

  async optimize(input: GuideOptimizeInput): Promise<GuideOptimizeResult> {
    assertGuideOptimizeInput(input)
    const skillDirectory = this.promptMasterSkillDirectory
    if (skillDirectory === undefined) {
      throw new GuideModelCapabilityError("Prompt Master skill directory is not configured")
    }
    let status
    try {
      status = lstatSync(path.join(skillDirectory, "SKILL.md"))
    } catch (cause) {
      throw new GuideModelCapabilityError(`Prompt Master skill is unavailable: ${skillDirectory}`, { cause })
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new GuideModelCapabilityError(`Prompt Master SKILL.md is not a regular file: ${skillDirectory}`)
    }
    const { goalExecution, ...plainInput } = input
    const payload = goalExecution === undefined ? input : { ...plainInput, ...goalModelContext(goalExecution) }
    return this.run(
      "optimize",
      this.prompts.optimize,
      payload,
      this.optimizeTimeoutMs,
      (value) => validateGuideOptimizeResult(value, input.candidates.length, goalExecution),
      { message: promptMasterMessage, skillDirectory },
    )
  }

  /**
   * Rewrites a thin intent with the user's packed repository as reference.
   * The pack travels as prompt content inside `<untrusted-data>`, so this
   * phase keeps the same locked-down session policy as every other phase: no
   * tools, no plugins, and a working directory outside the repository.
   */
  async enrich(input: GuideEnrichInput, onActivity?: (line: string) => void): Promise<GuideEnrichResult> {
    assertGuideEnrichInput(input)
    return this.run("enrich", this.prompts.enrich, input, this.enrichTimeoutMs, validateGuideEnrichResult, {
      ...(onActivity === undefined ? {} : { onActivity }),
    })
  }

  private sessionConfig<Input>(phase: GuideModelPhase, systemPrompt: string, options: GuideRunOptions<Input>): SessionConfig {
    const config = this.routing[phase]
    return restrictedGuideSessionConfig({
      clientName: this.clientName,
      model: config.model,
      effort: config.effort,
      workingDirectory: this.workingDirectory,
      systemPrompt,
      systemMessageMode: this.systemMessageMode,
      ...(options.skillDirectory === undefined ? {} : { skillDirectory: options.skillDirectory }),
      ...(options.onActivity === undefined
        ? {}
        : { onActivity: (event: { readonly type: string }) => options.onActivity?.(`${phase}: ${event.type}`) }),
    })
  }

  private async runCancellable<Input, Output>(
    phase: GuideModelPhase,
    systemPrompt: string,
    input: Input,
    timeoutMs: number,
    validate: (value: unknown) => Output,
    options: GuideRunOptions<Input>,
  ): Promise<Output> {
    const config = this.routing[phase]
    const original = requestMessage(input, options.message)
    const execute = (prompt: string): Promise<string> => runRestrictedGuideModelRequest({
      ...config, systemPrompt, prompt, timeoutMs,
      cleanupTimeoutMs: 3_000,
      maximumResponseBytes,
      baseDirectory: this.baseDirectory,
      workingDirectory: this.workingDirectory,
      systemMessageMode: this.systemMessageMode,
      clientName: this.clientName,
      inspectModel: () => undefined,
      clientFactory: (clientOptions) => cancellableClient(this.clientFactory(clientOptions)),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
      ...(this.copilotCliPath === undefined ? {} : { copilotCliPath: this.copilotCliPath }),
      ...(options.skillDirectory === undefined ? {} : { skillDirectory: options.skillDirectory }),
      ...(options.onActivity === undefined
        ? {}
        : { onActivity: (event) => options.onActivity?.(`${phase}: ${event.type}`) }),
    })
    options.onActivity?.(`${phase}: requesting`)
    const response = await execute(original).catch((error: unknown) => {
      if (error instanceof RestrictedGuideModelError && error.code === "response-too-large" && error.cleanupFailures.length === 0) return undefined
      throw error
    })
    try {
      if (response === undefined) throw new GuideModelResponseError("completed response exceeded the byte limit")
      return validate(parseJson(response))
    } catch {
      const repaired = await execute(`${original}\n\nThe previous completed response was invalid. Return corrected raw JSON matching the system schema exactly.`)
      try {
        return validate(parseJson(repaired))
      } catch {
        throw new GuideModelResponseError("model returned invalid JSON or schema after one repair")
      }
    }
  }

  private async run<Input, Output>(
    phase: GuideModelPhase,
    systemPrompt: string,
    input: Input,
    timeoutMs: number,
    validate: (value: unknown) => Output,
    options: GuideRunOptions<Input> = {},
  ): Promise<Output> {
    if (this.signal !== undefined) return this.runCancellable(phase, systemPrompt, input, timeoutMs, validate, options)
    const config = this.routing[phase]
    const client = this.clientFactory({
      mode: "empty",
      ...(this.copilotCliPath === undefined
        ? {}
        : { connection: RuntimeConnection.forStdio({ path: this.copilotCliPath }) }),
      baseDirectory: this.baseDirectory,
      workingDirectory: this.workingDirectory,
    })
    let session: GuideModelSession | undefined
    let outcome: { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly error: unknown }
    try {
      await client.start()
      const models = await client.listModels()
      assertGuideModelCapability(models, config)

      const sessionConfig = this.sessionConfig(phase, systemPrompt, options)
      session = await client.createSession(sessionConfig)
      const first = await session.sendAndWait({ prompt: requestMessage(input, options.message) }, timeoutMs)
      if (first === undefined) {
        throw new GuideModelResponseError("model did not return an assistant message")
      }
      try {
        outcome = { ok: true, value: validate(parseJson(first.data.content)) }
      } catch (validationError) {
        // Exactly one repair attempt: only for a *completed* response that
        // failed parsing or schema validation. A thrown/undefined result
        // from `sendAndWait` is never itself retried.
        const repaired = await session.sendAndWait({ prompt: repairMessage(validationError) }, timeoutMs)
        if (repaired === undefined) {
          throw new GuideModelResponseError("model did not return an assistant message after repair request")
        }
        outcome = { ok: true, value: validate(parseJson(repaired.data.content)) }
      }
    } catch (error) {
      outcome = { ok: false, error }
    }

    const cleanupErrors: unknown[] = []
    if (session !== undefined) {
      const activeSession = session
      await runCleanupStep(cleanupErrors, () => activeSession.disconnect())
      await runCleanupStep(cleanupErrors, () => client.deleteSession(activeSession.sessionId))
    }
    await collectClientStopErrors(client, cleanupErrors)

    if (!outcome.ok) throw outcome.error
    if (cleanupErrors.length > 0) throw new GuideModelCleanupError(cleanupErrors)
    return outcome.value
  }
}
