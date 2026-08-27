/**
 * Copilot SDK-backed implementation of `GuideProvider` for `trx guide`.
 *
 * Model session policy (per the approved `trx guide` design):
 * - Model defaults to `mai-code-1.1-flash` at `medium` reasoning effort;
 *   both are constructor-configurable.
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
 *   all), and explicitly disable every discovery/extension/persistence
 *   surface the SDK exposes: `enableConfigDiscovery`, `mcpServers`,
 *   `customAgents`, `skillDirectories`, `pluginDirectories`,
 *   `instructionDirectories`, `requestExtensions`,
 *   `requestCanvasRenderer`, `manageScheduleEnabled`,
 *   `skipCustomInstructions`, `enableOnDemandInstructionDiscovery`,
 *   `enableFileHooks`, `enableHostGitOperations`, `enableSessionStore`,
 *   `enableSkills`, `infiniteSessions`, `memory`, `skipEmbeddingRetrieval`,
 *   `embeddingCacheStorage`, `enableFileChangeTracking`,
 *   `enableSessionTelemetry`, and `remoteSession`. The session is also
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
import os from "node:os"
import path from "node:path"
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type ModelInfo,
  type SessionConfig,
} from "@github/copilot-sdk"
import type { GuideModelPrompts } from "./guide-prompts.js"
import {
  assertGuideGenerateInput,
  assertGuideMatchInput,
  validateGuideGenerateResult,
  validateGuideMatchResult,
  validateGuideRefineResult,
  type GuideGenerateInput,
  type GuideGenerateResult,
  type GuideMatchInput,
  type GuideMatchResult,
  type GuideProvider,
  type GuideRefineInput,
  type GuideRefineResult,
} from "./guide-provider.js"

/** `ReasoningEffort` is not re-exported from `@github/copilot-sdk`'s public entry point; mirrored here structurally. */
export type GuideReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"

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
}

/** Thrown when the configured model is missing or does not support the configured reasoning effort. */
export class GuideModelCapabilityError extends Error {
  constructor(message: string) {
    super(message)
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
  /** @default "mai-code-1.1-flash" */
  readonly model?: string
  /** @default "medium" */
  readonly effort?: GuideReasoningEffort
  /** Authored match/generate/refine system instructions. See `guide-prompts.ts`. */
  readonly prompts: GuideModelPrompts
  /** Copilot runtime data directory (required by client `mode: "empty"`). @default "<home>/.copilot/trx-guide" */
  readonly baseDirectory?: string
  /** Working directory for both the client runtime process and every session, kept outside the repository. @default os.tmpdir() */
  readonly workingDirectory?: string
  /** Client identifier included in the User-Agent header. @default "trellage-trx-guide" */
  readonly clientName?: string
  /** @default "append" */
  readonly systemMessageMode?: "append" | "replace"
  /** Milliseconds allowed for the match phase's `sendAndWait`. @default 30000 */
  readonly matchTimeoutMs?: number
  /** Milliseconds allowed for the generate phase's `sendAndWait`. @default 60000 */
  readonly generateTimeoutMs?: number
  /** Milliseconds allowed for the refine phase's `sendAndWait`. @default 60000 */
  readonly refineTimeoutMs?: number
  /** Injectable client constructor, so unit tests never spawn a real Copilot runtime. */
  readonly clientFactory?: (options: CopilotClientOptions) => GuideModelClient
}

const defaultClientFactory = (options: CopilotClientOptions): GuideModelClient => new CopilotClient(options)

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
const runCleanupStep = async (errors: unknown[], step: () => Promise<unknown>): Promise<void> => {
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

export class CopilotGuideProvider implements GuideProvider {
  private readonly model: string
  private readonly effort: GuideReasoningEffort
  private readonly prompts: GuideModelPrompts
  private readonly baseDirectory: string
  private readonly workingDirectory: string
  private readonly clientName: string
  private readonly systemMessageMode: "append" | "replace"
  private readonly matchTimeoutMs: number
  private readonly generateTimeoutMs: number
  private readonly refineTimeoutMs: number
  private readonly clientFactory: (options: CopilotClientOptions) => GuideModelClient

  constructor(options: CopilotGuideProviderOptions) {
    this.model = options.model ?? "mai-code-1.1-flash"
    this.effort = options.effort ?? "medium"
    this.prompts = options.prompts
    this.baseDirectory = options.baseDirectory ?? path.join(os.homedir(), ".copilot", "trx-guide")
    this.workingDirectory = options.workingDirectory ?? os.tmpdir()
    this.clientName = options.clientName ?? "trellage-trx-guide"
    this.systemMessageMode = options.systemMessageMode ?? "append"
    this.matchTimeoutMs = options.matchTimeoutMs ?? 30_000
    this.generateTimeoutMs = options.generateTimeoutMs ?? 60_000
    this.refineTimeoutMs = options.refineTimeoutMs ?? 60_000
    this.clientFactory = options.clientFactory ?? defaultClientFactory
  }

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    assertGuideMatchInput(input)
    const workflowIndex = new Map(
      input.entries.map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]),
    )
    return this.run(this.prompts.match, input, this.matchTimeoutMs, (value) =>
      validateGuideMatchResult(value, workflowIndex),
    )
  }

  async generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    assertGuideGenerateInput(input)
    return this.run(this.prompts.generate, input, this.generateTimeoutMs, validateGuideGenerateResult)
  }

  async refine(input: GuideRefineInput): Promise<GuideRefineResult> {
    assertGuideGenerateInput(input)
    return this.run(this.prompts.refine, input, this.refineTimeoutMs, validateGuideRefineResult)
  }

  private async run<Input, Output>(
    systemPrompt: string,
    input: Input,
    timeoutMs: number,
    validate: (value: unknown) => Output,
  ): Promise<Output> {
    const client = this.clientFactory({
      mode: "empty",
      connection: RuntimeConnection.forStdio({ path: "copilot" }),
      baseDirectory: this.baseDirectory,
      workingDirectory: this.workingDirectory,
    })
    let session: GuideModelSession | undefined
    let outcome: { readonly ok: true; readonly value: Output } | { readonly ok: false; readonly error: unknown }
    try {
      await client.start()
      const models = await client.listModels()
      const modelInfo = models.find((candidate) => candidate.id === this.model)
      if (modelInfo === undefined) {
        throw new GuideModelCapabilityError(`model is not available: ${this.model}`)
      }
      if (!modelInfo.capabilities.supports.reasoningEffort) {
        throw new GuideModelCapabilityError(`model does not support reasoning effort: ${this.model}`)
      }
      const supportedEfforts = modelInfo.supportedReasoningEfforts ?? []
      if (!supportedEfforts.includes(this.effort)) {
        throw new GuideModelCapabilityError(
          `model does not support effort "${this.effort}": ${this.model} supports: ${supportedEfforts.join(", ") || "(none)"}`,
        )
      }

      const sessionConfig: SessionConfig = {
        clientName: this.clientName,
        model: this.model,
        reasoningEffort: this.effort,
        workingDirectory: this.workingDirectory,
        enableConfigDiscovery: false,
        tools: [],
        availableTools: [],
        mcpServers: {},
        customAgents: [],
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        requestExtensions: false,
        requestCanvasRenderer: false,
        manageScheduleEnabled: false,
        skipCustomInstructions: true,
        enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableSkills: false,
        infiniteSessions: { enabled: false },
        memory: { enabled: false },
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: "in-memory",
        enableFileChangeTracking: false,
        enableSessionTelemetry: false,
        remoteSession: "off",
        onPermissionRequest: () => ({ kind: "reject" }),
        systemMessage:
          this.systemMessageMode === "replace"
            ? { mode: "replace", content: systemPrompt }
            : { mode: "append", content: systemPrompt },
      }
      session = await client.createSession(sessionConfig)
      const first = await session.sendAndWait({ prompt: untrustedMessage(JSON.stringify(input)) }, timeoutMs)
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
