/**
 * Copilot SDK-backed doctor-failure diagnosis provider.
 *
 * This is a sibling of `CopilotGuideProvider` (`copilot-guide-provider.ts`),
 * not a change to it: it reuses that module's hardened session-lifecycle
 * seams (`GuideModelClient`/`GuideModelSession`, typed capability/response/
 * cleanup error classes) and mirrors its exact security posture — client
 * `mode: "empty"`, `workingDirectory` outside the repository, all tools/
 * MCP/plugins/skills/persistence disabled, `onPermissionRequest` always
 * rejects, model-capability probing before every call, a response-size cap
 * before `JSON.parse`, exactly one repair attempt on an invalid response,
 * and guaranteed ordered cleanup (`session.disconnect()` ->
 * `client.deleteSession()` -> `client.stop()`) that never masks a primary
 * error — for a different, narrower purpose: given a profile's already-
 * captured doctor `stdout`/`stderr`, ask for a small structured suggested
 * fix. Captured doctor output is always untrusted, inert prompt text; it is
 * never treated as an instruction and this provider never grants any tool,
 * file, or shell access.
 */
import os from "node:os"
import path from "node:path"
import { CopilotClient, RuntimeConnection, type CopilotClientOptions, type SessionConfig } from "@github/copilot-sdk"
import {
  GuideModelCapabilityError,
  GuideModelCleanupError,
  GuideModelResponseError,
  type GuideModelClient,
  type GuideModelSession,
} from "./copilot-guide-provider.ts"
import type { GuideReasoningEffort } from "./guide-model-routing.ts"

export interface DoctorFailureDiagnosisRequest {
  readonly ref: string
  readonly name: string
  /** Already-captured, untrusted doctor stdout/stderr text — never executed, never treated as an instruction. */
  readonly capturedOutput: string
}

export type DiagnosisConfidence = "low" | "medium" | "high"

export interface DoctorFailureDiagnosisResult {
  readonly summary: string
  readonly suggestedFix: string
  readonly confidence?: DiagnosisConfidence
  readonly rationale?: string
}

export interface DoctorFailureDiagnosisProviderOptions {
  readonly model?: string
  readonly effort?: GuideReasoningEffort
  readonly systemPrompt?: string
  readonly baseDirectory?: string
  readonly workingDirectory?: string
  readonly clientName?: string
  readonly copilotCliPath?: string
  readonly timeoutMs?: number
  /** Injectable client constructor, so unit tests never spawn a real Copilot runtime. */
  readonly clientFactory?: (options: CopilotClientOptions) => GuideModelClient
}

const defaultClientFactory = (options: CopilotClientOptions): GuideModelClient => new CopilotClient(options)

const defaultModel = "gpt-5.6-sol"
const defaultEffort: GuideReasoningEffort = "medium"
const defaultTimeoutMs = 30_000

const defaultSystemPrompt = [
  "You diagnose Trellage profile doctor-check failures.",
  "You are given the profile name and the captured, untrusted doctor stdout/stderr text.",
  "Respond with raw JSON only, matching exactly:",
  '{ "summary": string, "suggestedFix": string, "confidence"?: "low" | "medium" | "high", "rationale"?: string }',
  "No Markdown code fences, no prose before or after the JSON.",
].join("\n")

/** Maximum size (in UTF-8 bytes) of a completed assistant message accepted before attempting `JSON.parse`. */
const maximumResponseBytes = 64 * 1024

const untrustedMessage = (request: DoctorFailureDiagnosisRequest): string =>
  [
    `Profile ref: ${request.ref}`,
    `Profile name: ${request.name}`,
    "",
    "<untrusted-data>",
    request.capturedOutput,
    "</untrusted-data>",
  ].join("\n")

const repairMessage = (cause: unknown): string => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return [
    "Your previous response was invalid.",
    `Validation error: ${reason}`,
    "Respond again with corrected raw JSON only, matching the schema in your instructions exactly.",
    "No Markdown code fences, no prose before or after the JSON.",
  ].join("\n")
}

const parseBoundedJson = (content: string): unknown => {
  const byteLength = Buffer.byteLength(content, "utf8")
  if (byteLength > maximumResponseBytes) {
    throw new GuideModelResponseError(
      `diagnosis model response was too large to parse: ${byteLength} bytes exceeds the ${maximumResponseBytes}-byte limit`,
    )
  }
  try {
    return JSON.parse(content)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new GuideModelResponseError(`diagnosis model response was not valid JSON: ${reason}`)
  }
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0

const isConfidence = (value: unknown): value is DiagnosisConfidence =>
  value === "low" || value === "medium" || value === "high"

/** Validates the parsed response against the diagnosis schema; throws `GuideModelResponseError` on any mismatch. */
export const validateDoctorFailureDiagnosisResult = (value: unknown): DoctorFailureDiagnosisResult => {
  if (typeof value !== "object" || value === null) throw new GuideModelResponseError("diagnosis response was not an object")
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.summary)) throw new GuideModelResponseError("diagnosis response is missing a non-empty summary")
  if (!isNonEmptyString(record.suggestedFix))
    throw new GuideModelResponseError("diagnosis response is missing a non-empty suggestedFix")
  if (record.confidence !== undefined && !isConfidence(record.confidence))
    throw new GuideModelResponseError(`diagnosis response has an invalid confidence: ${String(record.confidence)}`)
  if (record.rationale !== undefined && typeof record.rationale !== "string")
    throw new GuideModelResponseError("diagnosis response has a non-string rationale")
  return {
    summary: record.summary,
    suggestedFix: record.suggestedFix,
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    ...(record.rationale === undefined ? {} : { rationale: record.rationale }),
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

export class DoctorFailureDiagnosisProvider {
  private readonly model: string
  private readonly effort: GuideReasoningEffort
  private readonly systemPrompt: string
  private readonly baseDirectory: string
  private readonly workingDirectory: string
  private readonly clientName: string
  private readonly copilotCliPath: string | undefined
  private readonly timeoutMs: number
  private readonly clientFactory: (options: CopilotClientOptions) => GuideModelClient

  constructor(options: DoctorFailureDiagnosisProviderOptions = {}) {
    this.model = options.model ?? defaultModel
    this.effort = options.effort ?? defaultEffort
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt
    this.baseDirectory = options.baseDirectory ?? path.join(os.homedir(), ".copilot", "trx-admin-diagnosis")
    this.workingDirectory = options.workingDirectory ?? os.tmpdir()
    this.clientName = options.clientName ?? "trellage-trx-admin-diagnosis"
    this.copilotCliPath = options.copilotCliPath
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    this.clientFactory = options.clientFactory ?? defaultClientFactory
  }

  async diagnose(request: DoctorFailureDiagnosisRequest): Promise<DoctorFailureDiagnosisResult> {
    const client = this.clientFactory({
      mode: "empty",
      ...(this.copilotCliPath === undefined
        ? {}
        : { connection: RuntimeConnection.forStdio({ path: this.copilotCliPath }) }),
      baseDirectory: this.baseDirectory,
      workingDirectory: this.workingDirectory,
    })
    let session: GuideModelSession | undefined
    let outcome:
      | { readonly ok: true; readonly value: DoctorFailureDiagnosisResult }
      | { readonly ok: false; readonly error: unknown }
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
        enableSkills: false,
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
        infiniteSessions: { enabled: false },
        memory: { enabled: false },
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: "in-memory",
        enableFileChangeTracking: false,
        enableSessionTelemetry: false,
        remoteSession: "off",
        onPermissionRequest: () => ({ kind: "reject" }),
        systemMessage: { mode: "append", content: this.systemPrompt },
      }
      session = await client.createSession(sessionConfig)
      const first = await session.sendAndWait({ prompt: untrustedMessage(request) }, this.timeoutMs)
      if (first === undefined) {
        throw new GuideModelResponseError("diagnosis model did not return an assistant message")
      }
      try {
        outcome = { ok: true, value: validateDoctorFailureDiagnosisResult(parseBoundedJson(first.data.content)) }
      } catch (validationError) {
        // Exactly one repair attempt: only for a *completed* response that
        // failed parsing or schema validation. A thrown/undefined result
        // from `sendAndWait` is never itself retried.
        const repaired = await session.sendAndWait({ prompt: repairMessage(validationError) }, this.timeoutMs)
        if (repaired === undefined) {
          throw new GuideModelResponseError("diagnosis model did not return an assistant message after repair request")
        }
        outcome = { ok: true, value: validateDoctorFailureDiagnosisResult(parseBoundedJson(repaired.data.content)) }
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
