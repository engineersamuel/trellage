import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { CopilotClientOptions, ModelInfo } from "@github/copilot-sdk"
import {
  ContinuationOutcome,
  ConversationRole,
  conversationLimits,
  validateContinuationAssessment,
  validateConversationSnapshot,
  type ContinuationAssessment,
  type ConversationMessage,
  type ConversationSnapshot,
  type ConversationSummary,
} from "@trellage/guide-core/conversation"
import { sanitizeConversationSnapshot } from "@trellage/guide-core"
import {
  GuideModelCapabilityError,
  RestrictedGuideModelError,
  runRestrictedGuideModelRequest,
  type RestrictedGuideModelClient,
} from "./copilot-guide-provider.ts"
import type { GuideMatchCatalogEntry } from "./guide-catalog.ts"
import { defaultGuideModelRouting, type GuideReasoningEffort } from "./guide-model-routing.ts"
import rawPolicy from "./continuation-policy.json" with { type: "json" }

export interface ContinuationPolicy {
  readonly schemaVersion: 1
  readonly maxSnapshotBytes: number
  readonly maxMessages: number
  readonly maxInputBytes: number
  readonly maxSummaryInputBytes: number
  readonly maxResponseBytes: number
  readonly maxSummaryTextBytes: number
  readonly maxSummaryEvidenceBytes: number
  readonly maxSummaryPoints: number
  readonly systemPromptReserveBytes: number
  readonly protocolReserveBytes: number
  readonly outputReserveTokens: number
  readonly runtimeReserveTokens: number
  readonly recentMessages: number
  readonly maxSummaryChunks: number
  readonly maxReductionLevels: number
  readonly maxCalls: number
  readonly schemaRepairAttempts: 1
  readonly requestTimeoutMs: number
  readonly cleanupTimeoutMs: number
  readonly allowedTools: ReadonlyArray<never>
  readonly contentRules: ReadonlyArray<{ readonly id: string; readonly pattern: string; readonly flags: string }>
}

export class ContinuationAnalysisError extends Error {
  constructor(
    readonly code: string,
    readonly summaries: ReadonlyArray<ConversationSummary> = [],
  ) {
    super(`Conversation analysis stopped: ${code}. No source history was silently omitted.`)
    this.name = code === "cancelled" ? "AbortError" : "ContinuationAnalysisError"
  }
}

export class ContinuationSafetyError extends ContinuationAnalysisError {
  constructor(readonly ruleIds: ReadonlyArray<string>) {
    super(`content-policy (${ruleIds.join(", ")})`)
    this.name = "ContinuationSafetyError"
  }
}

const fail = (code: string): never => { throw new ContinuationAnalysisError(code) }
const bytes = (value: string): number => Buffer.byteLength(value, "utf8")
const jsonBytes = (value: unknown): number => bytes(JSON.stringify(value))
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const unique = (values: ReadonlyArray<string>): string[] => [...new Set(values)]

const object = (value: unknown, keys: ReadonlyArray<string>, code: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(code)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail(code)
  if (Reflect.ownKeys(value).length !== keys.length) return fail(code)
  const fields: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return fail(code)
    fields[key] = descriptor.value
  }
  return fields
}

const string = (value: unknown, maximum: number, code: string): string => {
  if (typeof value !== "string" || value.trim().length === 0 || bytes(value) > maximum) return fail(code)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) return fail(code)
  return value
}

const validateContentRules = (rules: unknown): void => {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 32) {
    fail("invalid-policy-content-rules")
  }
  const ruleIds = new Set<string>()
  for (const rule of rules as unknown[]) {
    const entry = object(rule, ["id", "pattern", "flags"], "invalid-policy-rule")
    const id = string(entry.id, 80, "invalid-policy-rule-id")
    if (!/^[a-z][a-z0-9-]*$/u.test(id) || ruleIds.has(id)) fail("invalid-policy-rule-id")
    ruleIds.add(id)
    const flags = string(entry.flags, 2, "invalid-policy-rule-flags")
    if (flags !== "u" && flags !== "iu") fail("invalid-policy-rule-flags")
    try {
      new RegExp(string(entry.pattern, 1024, "invalid-policy-pattern"), flags)
    } catch {
      fail("invalid-policy-pattern")
    }
  }
}

const validatePolicyBudgets = (policy: ContinuationPolicy): void => {
  const ceilings: ReadonlyArray<readonly [number, number]> = [
    [policy.maxSummaryPoints, 64], [policy.maxCalls, 128], [policy.maxSummaryChunks, 64],
    [policy.maxReductionLevels, 8], [policy.requestTimeoutMs, 600_000], [policy.cleanupTimeoutMs, 10_000],
  ]
  if (
    policy.maxInputBytes <= policy.systemPromptReserveBytes + policy.protocolReserveBytes ||
    policy.maxSummaryInputBytes > policy.maxInputBytes ||
    policy.maxSummaryTextBytes >= policy.maxSummaryInputBytes ||
    policy.maxSummaryEvidenceBytes >= policy.maxSummaryTextBytes ||
    policy.maxResponseBytes > policy.outputReserveTokens ||
    policy.maxCalls < 2 ||
    ceilings.some(([value, maximum]) => value > maximum)
  ) fail("inconsistent-policy-budgets")
}

export const validateContinuationPolicy = (value: unknown): ContinuationPolicy => {
  const fields = object(value, Object.keys(rawPolicy), "invalid-policy")
  for (const [key, entry] of Object.entries(fields)) {
    if (key === "allowedTools" || key === "contentRules") continue
    if (!Number.isSafeInteger(entry) || Number(entry) <= 0 || Number(entry) > 64 * 1024 * 1024) {
      fail("invalid-policy-limit")
    }
  }
  if (fields.schemaVersion !== 1 || fields.schemaRepairAttempts !== 1) fail("invalid-policy-version-or-repair")
  if (!Array.isArray(fields.allowedTools) || fields.allowedTools.length !== 0) fail("policy-tools-must-be-empty")
  validateContentRules(fields.contentRules)
  const policy = fields as unknown as ContinuationPolicy
  validatePolicyBudgets(policy)
  return structuredClone(policy)
}

const validatedPolicy = validateContinuationPolicy(rawPolicy)
export const continuationPolicy: ContinuationPolicy = Object.freeze({
  ...validatedPolicy,
  allowedTools: Object.freeze([]),
  contentRules: Object.freeze(validatedPolicy.contentRules.map((rule) => Object.freeze(rule))),
})
export const continuationPolicyDigest = digest(continuationPolicy)

const assertContentSafety = (value: unknown): void => {
  const strings: string[] = []
  const pending: unknown[] = [value]
  const visited = new Set<object>()
  while (pending.length > 0) {
    const item = pending.pop()
    if (typeof item === "string") strings.push(item.normalize("NFKC"))
    if (item !== null && typeof item === "object" && !visited.has(item)) {
      visited.add(item)
      pending.push(...Object.values(item))
    }
  }
  const content = strings.join("\n")
  const rules = continuationPolicy.contentRules
    .filter(({ pattern, flags }) => new RegExp(pattern, flags).test(content))
    .map(({ id }) => id)
  if (rules.length > 0) throw new ContinuationSafetyError(rules)
}

/** Applies the same content policy to edited briefs before preparation or launch, without inference. */
export const validateContinuationContent = (text: string): void => {
  if (typeof text !== "string") fail("invalid-continuation-content")
  assertContentSafety(text)
}

export interface ContinuationCallPlan {
  readonly summarizationCalls: number
  readonly assessmentCalls: number
  /** Includes exactly one possible schema repair per completed invalid response. */
  readonly maxCalls: number
}

export interface ContinuationModelPrompts {
  readonly assess: string
  readonly summarize: string
}

export interface ContinuationRequestOptions {
  readonly signal?: AbortSignal
  readonly repair?: "invalid-summary" | "invalid-assessment"
}

type SnapshotContext = Pick<ConversationSnapshot, "id" | "cutoff" | "coverage"> & {
  readonly source: Pick<ConversationSnapshot["source"], "agent" | "surface" | "profile">
}

interface ContinuationInputLimits {
  readonly summaryTextBytes: number
  readonly responseBytes: number
}

export interface ContinuationSummaryInput {
  readonly snapshot: SnapshotContext
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly summaries: ReadonlyArray<ConversationSummary>
  readonly evidenceIds: ReadonlyArray<string>
  readonly limits: ContinuationInputLimits
}

export interface ContinuationAssessmentInput {
  readonly snapshot: SnapshotContext
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly summaries: ReadonlyArray<ConversationSummary>
  readonly entries: ReadonlyArray<GuideMatchCatalogEntry>
  readonly progressStatus: "reported-not-verified"
  readonly readinessStatus: "not-checked"
  readonly limits: ContinuationInputLimits
}

/** Methods return completed raw JSON or decoded JSON; thrown transport failures are never repaired. */
export interface ContinuationProvider {
  readonly model: string
  readonly effort: GuideReasoningEffort
  promptDigest(): Promise<string>
  summarize(input: ContinuationSummaryInput, options: ContinuationRequestOptions): Promise<unknown>
  assess(input: ContinuationAssessmentInput, options: ContinuationRequestOptions): Promise<unknown>
}

export interface AnalyzeConversationOptions {
  readonly signal?: AbortSignal
  /** Content-free status suitable for terminal progress displays. */
  readonly onProgress?: (message: string) => void
  readonly summaries?: ReadonlyArray<ConversationSummary>
  /** Awaited after each new chunk or reduction, before another model call. */
  readonly onSummaries?: (summaries: ReadonlyArray<ConversationSummary>) => Promise<void>
}

export interface CopilotContinuationProviderOptions {
  readonly model?: string
  readonly effort?: GuideReasoningEffort
  readonly prompts?: ContinuationModelPrompts
  readonly baseDirectory?: string
  readonly workingDirectory?: string
  readonly copilotCliPath?: string
  readonly clientFactory?: (options: CopilotClientOptions) => RestrictedGuideModelClient
}

const loadPrompts = async (): Promise<ContinuationModelPrompts> => {
  const [assess, summarize] = await Promise.all([
    readFile(new URL("../prompts/continuation-assess.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/continuation-summarize.md", import.meta.url), "utf8"),
  ])
  return { assess, summarize }
}

const checkPrompts = (prompts: ContinuationModelPrompts): ContinuationModelPrompts => {
  return Object.freeze({
    assess: string(prompts.assess, continuationPolicy.systemPromptReserveBytes, "assessment-system-prompt-budget"),
    summarize: string(prompts.summarize, continuationPolicy.systemPromptReserveBytes, "summary-system-prompt-budget"),
  })
}

/** One UTF-8 byte per token is a conservative bound, not a characters/4 estimate. */
export const continuationModelInputBudget = (model: ModelInfo): number => {
  const limits = model.capabilities.limits
  const context = limits.max_context_window_tokens
  const prompt = limits.max_prompt_tokens ?? context
  if (![context, prompt].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new GuideModelCapabilityError("Continuation requires valid model context/prompt limits from SDK metadata.")
  }
  const budget = Math.min(prompt, context - continuationPolicy.outputReserveTokens) - continuationPolicy.runtimeReserveTokens
  if (budget <= 0) {
    throw new GuideModelCapabilityError("The selected model has no continuation input capacity after output/runtime reserves.")
  }
  return Math.min(continuationPolicy.maxInputBytes, budget)
}

export const createCopilotContinuationProvider = (
  options: CopilotContinuationProviderOptions = {},
): ContinuationProvider => {
  const model = options.model ?? defaultGuideModelRouting.match.model
  const effort = options.effort ?? defaultGuideModelRouting.match.effort
  let prompts: Promise<ContinuationModelPrompts> | undefined
  const instructions = (): Promise<ContinuationModelPrompts> =>
    prompts ??= (options.prompts === undefined ? loadPrompts() : Promise.resolve(options.prompts)).then(checkPrompts)
  const request = async (
    phase: keyof ContinuationModelPrompts,
    input: ContinuationSummaryInput | ContinuationAssessmentInput,
    requestOptions: ContinuationRequestOptions,
  ): Promise<unknown> => {
    const systemPrompt = (await instructions())[phase]
    const prompt = JSON.stringify({ untrustedData: input, repair: requestOptions.repair ?? null })
    const inputBytes = bytes(systemPrompt) + bytes(prompt)
    if (inputBytes > continuationPolicy.maxInputBytes) fail("model-input-budget")
    assertContentSafety(input)
    return runRestrictedGuideModelRequest({
      model, effort, systemPrompt, prompt,
      timeoutMs: continuationPolicy.requestTimeoutMs,
      cleanupTimeoutMs: continuationPolicy.cleanupTimeoutMs,
      maximumResponseBytes: continuationPolicy.maxResponseBytes,
      inspectModel: (metadata) => {
        const verifiedBudget = continuationModelInputBudget(metadata)
        if (inputBytes > verifiedBudget) {
          throw new GuideModelCapabilityError(
            `Selected model permits ${verifiedBudget} input bytes; this planned request needs ${inputBytes}. Choose a larger-context model. No history was omitted.`,
          )
        }
      },
      ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      ...(options.baseDirectory === undefined ? {} : { baseDirectory: options.baseDirectory }),
      ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
      ...(options.copilotCliPath === undefined ? {} : { copilotCliPath: options.copilotCliPath }),
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    }).catch((error: unknown) => {
      // This is a completed response budget violation, not a transport retry.
      if (error instanceof RestrictedGuideModelError && error.code === "response-too-large" && error.cleanupFailures.length === 0) {
        return { invalidCompletedResponse: "response-too-large" }
      }
      throw error
    })
  }
  return {
    model,
    effort,
    promptDigest: async () => digest(await instructions()),
    summarize: (input, requestOptions) => request("summarize", input, requestOptions),
    assess: (input, requestOptions) => request("assess", input, requestOptions),
  }
}

const context = (snapshot: ConversationSnapshot): SnapshotContext => ({
  id: snapshot.id,
  cutoff: snapshot.cutoff,
  coverage: snapshot.coverage,
  source: {
    agent: snapshot.source.agent,
    surface: snapshot.source.surface,
    ...(snapshot.source.profile === undefined ? {} : { profile: snapshot.source.profile }),
  },
})

const inputLimits: ContinuationInputLimits = {
  summaryTextBytes: continuationPolicy.maxSummaryTextBytes,
  responseBytes: continuationPolicy.maxResponseBytes,
}

const summaryInput = (
  snapshot: ConversationSnapshot,
  messages: ReadonlyArray<ConversationMessage>,
  summaries: ReadonlyArray<ConversationSummary>,
): ContinuationSummaryInput => ({
  snapshot: context(snapshot),
  messages,
  summaries,
  evidenceIds: unique([...messages.map(({ id }) => id), ...summaries.flatMap(({ evidenceIds }) => evidenceIds)]),
  limits: inputLimits,
})

const assessmentInput = (
  snapshot: ConversationSnapshot,
  entries: ReadonlyArray<GuideMatchCatalogEntry>,
  messages: ReadonlyArray<ConversationMessage>,
  summaries: ReadonlyArray<ConversationSummary>,
): ContinuationAssessmentInput => ({
  snapshot: context(snapshot), messages, summaries, entries,
  progressStatus: "reported-not-verified",
  readinessStatus: "not-checked",
  limits: inputLimits,
})

const projectCatalog = (entries: ReadonlyArray<GuideMatchCatalogEntry>): GuideMatchCatalogEntry[] => {
  if (entries.length === 0 || entries.length > 512) fail("invalid-catalog-size")
  const projected = entries.map((entry) => ({
    ref: string(entry.ref, 256, "invalid-catalog-ref"),
    surface: entry.surface,
    name: entry.name,
    ...(entry.launcher === undefined ? {} : { launcher: entry.launcher }),
    ...(entry.harness === undefined ? {} : { harness: entry.harness }),
    description: entry.description,
    sandbox: entry.sandbox,
    guide: {
      schemaVersion: entry.guide.schemaVersion,
      capabilities: [...entry.guide.capabilities],
      bestFor: [...entry.guide.bestFor],
      avoidFor: [...entry.guide.avoidFor],
      prerequisites: entry.guide.prerequisites.map(({ id, description }) => ({ id, description })),
      workflows: entry.guide.workflows.map(({ id, description, examples }) => ({ id, description, examples: [...examples] })),
    },
  }))
  if (new Set(projected.map(({ ref }) => ref)).size !== projected.length) fail("duplicate-catalog-ref")
  for (const entry of projected) {
    const workflows = entry.guide.workflows.map(({ id }) => string(id, 128, "invalid-workflow-id"))
    if (workflows.length === 0 || new Set(workflows).size !== workflows.length) fail("invalid-catalog-workflows")
  }
  if (jsonBytes(projected) > bodyBudget) fail("catalog-exceeds-input-budget")
  return projected
}

const checkedSnapshot = (supplied: ConversationSnapshot): ConversationSnapshot => {
  if (
    supplied.messages.length > continuationPolicy.maxMessages ||
    jsonBytes(supplied) > continuationPolicy.maxSnapshotBytes
  ) fail("snapshot-budget-or-schema")
  try {
    const sanitized = sanitizeConversationSnapshot(supplied)
    if (
      sanitized.messages.length > continuationPolicy.maxMessages ||
      jsonBytes(sanitized) > continuationPolicy.maxSnapshotBytes
    ) fail("snapshot-budget-or-schema")
    return validateConversationSnapshot(sanitized)
  } catch {
    return fail("invalid-conversation-snapshot")
  }
}

interface SummaryNode {
  readonly id: string
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly children: ReadonlyArray<SummaryNode>
  readonly evidenceIds: ReadonlyArray<string>
}

interface HistoryPlan {
  readonly calls: ContinuationCallPlan
  readonly nodes: ReadonlyArray<SummaryNode>
  readonly roots: ReadonlyArray<SummaryNode>
  readonly recent: ReadonlyArray<ConversationMessage>
}

const bodyBudget = continuationPolicy.maxInputBytes - continuationPolicy.systemPromptReserveBytes - continuationPolicy.protocolReserveBytes
const summaryBodyBudget = Math.min(bodyBudget, continuationPolicy.maxSummaryInputBytes)
// Backslashes reserve the worst permitted JSON escaping expansion.
const reservedSummaryText = "\\".repeat(continuationPolicy.maxSummaryTextBytes)
const placeholder = (node: SummaryNode): ConversationSummary => ({
  key: "x".repeat(160), text: reservedSummaryText, evidenceIds: node.evidenceIds,
})

const citationsFit = (ids: ReadonlyArray<string>): boolean =>
  ids.reduce((total, id) => total + bytes(id) + 2, 0) <= continuationPolicy.maxSummaryEvidenceBytes

const summaryFits = (input: ContinuationSummaryInput): boolean =>
  jsonBytes(input) <= summaryBodyBudget && citationsFit(input.evidenceIds)

const leafNodes = (snapshot: ConversationSnapshot, older: ReadonlyArray<ConversationMessage>): SummaryNode[] => {
  const nodes: SummaryNode[] = []
  let messages: ConversationMessage[] = []
  const append = (): void => {
    nodes.push({ id: `chunk-${nodes.length}`, messages, children: [], evidenceIds: messages.map(({ id }) => id) })
    messages = []
    if (nodes.length > continuationPolicy.maxSummaryChunks) fail("summary-chunk-cap")
  }
  for (const message of older) {
    const candidate = [...messages, message]
    if (summaryFits(summaryInput(snapshot, candidate, []))) {
      messages = candidate
      continue
    }
    if (messages.length > 0) append()
    if (!summaryFits(summaryInput(snapshot, [message], []))) fail("single-evidence-message-exceeds-summary-budget")
    messages = [message]
  }
  if (messages.length > 0) append()
  return nodes
}

const reduceNodes = (
  snapshot: ConversationSnapshot,
  roots: ReadonlyArray<SummaryNode>,
  nodes: SummaryNode[],
): SummaryNode[] => {
  const result: SummaryNode[] = []
  let group: SummaryNode[] = []
  const append = (): void => {
    if (group.length === 1) result.push(group[0]!)
    if (group.length > 1) {
      const node = {
        id: `reduction-${nodes.length}`, messages: [], children: group,
        evidenceIds: unique(group.flatMap(({ evidenceIds }) => evidenceIds)),
      }
      nodes.push(node)
      result.push(node)
    }
    group = []
  }
  for (const node of roots) {
    const candidate = [...group, node]
    if (!summaryFits(summaryInput(snapshot, [], candidate.map(placeholder))) && group.length > 0) {
      append()
    }
    group.push(node)
  }
  append()
  return result
}

const historyPlan = (snapshot: ConversationSnapshot, entries: ReadonlyArray<GuideMatchCatalogEntry>): HistoryPlan => {
  const fits = (messages: ReadonlyArray<ConversationMessage>, roots: ReadonlyArray<SummaryNode>): boolean =>
    jsonBytes(assessmentInput(snapshot, entries, messages, roots.map(placeholder))) <= bodyBudget
  if (fits(snapshot.messages, [])) {
    return { calls: { summarizationCalls: 0, assessmentCalls: 1, maxCalls: 2 }, nodes: [], roots: [], recent: snapshot.messages }
  }
  let start = Math.max(0, snapshot.messages.length - continuationPolicy.recentMessages)
  while (start > 0 && snapshot.messages[start]?.role !== ConversationRole.User) start -= 1
  let recent = snapshot.messages.slice(start)
  let nodes: SummaryNode[] = []
  let roots: ReadonlyArray<SummaryNode> = []
  let reductions = 0
  while (true) {
    if (!fits(recent, [])) {
      const nextStart = snapshot.messages.findIndex(({ role }, index) => index > start && role === ConversationRole.User)
      if (nextStart < 0) fail("recent-history-or-catalog-exceeds-input-budget")
      start = nextStart
      recent = snapshot.messages.slice(start)
      continue
    }
    nodes = leafNodes(snapshot, snapshot.messages.slice(0, start))
    roots = [...nodes]
    reductions = 0
    while (!fits(recent, roots)) {
      if (roots.length <= 1 || reductions >= continuationPolicy.maxReductionLevels) break
      const reduced = reduceNodes(snapshot, roots, nodes)
      if (reduced.length >= roots.length) break
      roots = reduced
      reductions += 1
    }
    if (fits(recent, roots)) break
    // Reserve room for at least one summary by moving the oldest complete
    // user turn into summarization. The newest user turn always stays verbatim.
    const nextStart = snapshot.messages.findIndex(({ role }, index) => index > start && role === ConversationRole.User)
    if (nextStart < 0) fail("recent-history-or-catalog-exceeds-input-budget")
    start = nextStart
    recent = snapshot.messages.slice(start)
  }
  const maxCalls = (nodes.length + 1) * (1 + continuationPolicy.schemaRepairAttempts)
  if (maxCalls > continuationPolicy.maxCalls) fail("model-call-cap")
  return { calls: { summarizationCalls: nodes.length, assessmentCalls: 1, maxCalls }, nodes, roots, recent }
}

/**
 * Offline cold-cache upper bound, including reduction and one repair per
 * request. SDK metadata may tighten this policy budget before inference,
 * but never silently expand this reviewed plan or switch models.
 */
export const continuationCallPlan = (
  snapshot: ConversationSnapshot,
  entries: ReadonlyArray<GuideMatchCatalogEntry>,
): ContinuationCallPlan => {
  return historyPlan(checkedSnapshot(snapshot), projectCatalog(entries)).calls
}

enum SummaryPointKind {
  Goal = "goal",
  Decision = "decision",
  Correction = "correction",
  ReportedProgress = "reported-progress",
  UnresolvedWork = "unresolved-work",
  Constraint = "constraint",
  Blocker = "blocker",
  Contradiction = "contradiction",
}

const evidenceList = (value: unknown, allowed: ReadonlyArray<string>): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length) return fail("invalid-summary-evidence")
  const ids = Array.from(value, (entry) => string(entry, 256, "invalid-summary-evidence"))
  const known = new Set(allowed)
  if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) fail("invalid-summary-evidence")
  return ids
}

const sameIds = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean =>
  actual.length === expected.length && actual.every((id, index) => id === expected[index])

const parseResponse = (value: unknown): unknown => {
  if (typeof value !== "string") {
    if (value === undefined || jsonBytes(value) > continuationPolicy.maxResponseBytes) fail("invalid-response-size")
    return value
  }
  if (bytes(value) > continuationPolicy.maxResponseBytes) fail("invalid-response-size")
  try {
    return JSON.parse(value)
  } catch {
    return fail("invalid-response-json")
  }
}

const summaryValue = (value: unknown, expected: ReadonlyArray<string>): Omit<ConversationSummary, "key"> => {
  const fields = object(value, ["evidenceIds", "points"], "invalid-summary-schema")
  const evidenceIds = evidenceList(fields.evidenceIds, expected)
  if (!sameIds(evidenceIds, expected)) fail("summary-coverage-mismatch")
  if (!Array.isArray(fields.points) || fields.points.length === 0 || fields.points.length > continuationPolicy.maxSummaryPoints) {
    fail("invalid-summary-points")
  }
  const cited = new Set<string>()
  const lines = Array.from(fields.points as unknown[], (point) => {
    const entry = object(point, ["kind", "text", "evidenceIds"], "invalid-summary-point")
    if (!Object.values(SummaryPointKind).includes(entry.kind as SummaryPointKind)) fail("invalid-summary-point-kind")
    const ids = evidenceList(entry.evidenceIds, expected)
    ids.forEach((id) => cited.add(id))
    const label = entry.kind === SummaryPointKind.ReportedProgress ? "Reported progress (not verified)" : entry.kind
    return `${label}: ${string(entry.text, 2048, "invalid-summary-point-text")} [${ids.join(", ")}]`
  })
  if (cited.size !== expected.length) fail("summary-point-coverage-mismatch")
  const text = lines.join("\n")
  if (bytes(text) > continuationPolicy.maxSummaryTextBytes) fail("summary-text-budget")
  assertContentSafety({ text, evidenceIds })
  return { text, evidenceIds }
}

const normalizedWords = (value: string): string[] =>
  value.toLocaleLowerCase("en").normalize("NFKC").match(/[\p{L}]+/gu) ?? []

const similarity = (left: string, right: string): number => {
  const a = new Set(normalizedWords(left))
  const b = new Set(normalizedWords(right))
  const overlap = [...a].filter((word) => b.has(word)).length
  return overlap / Math.max(1, new Set([...a, ...b]).size)
}

const assertDistinctActions = (assessment: ContinuationAssessment): void => {
  const actions = assessment.actions
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!
    for (const earlier of actions.slice(0, index)) {
      if (
        normalizedWords(action.title).join(" ") === normalizedWords(earlier.title).join(" ") ||
        normalizedWords(action.brief).join(" ") === normalizedWords(earlier.brief).join(" ") ||
        (similarity(action.brief, earlier.brief) >= 0.85 && similarity(action.expectedOutput, earlier.expectedOutput) >= 0.85)
      ) fail("actions-are-not-distinct")
    }
  }
}

const assessmentValue = (
  value: unknown,
  snapshot: ConversationSnapshot,
  entries: ReadonlyArray<GuideMatchCatalogEntry>,
): ContinuationAssessment => {
  const catalogRefs = new Map(entries.map(({ ref, guide }) => [ref, new Set(guide.workflows.map(({ id }) => id))]))
  const assessment = validateContinuationAssessment(value, snapshot, catalogRefs)
  if (assessment.outcome === ContinuationOutcome.Recommendations && assessment.questions.length > 0) {
    fail("recommendations-must-not-contain-clarification")
  }
  assertDistinctActions(assessment)
  assertContentSafety(assessment)
  const reportedProgress = assessment.reportedProgress.map((text) =>
    text.startsWith("Reported (not verified): ") ? text : `Reported (not verified): ${text}`)
  if (
    reportedProgress.some((text) => text.length > conversationLimits.noticeChars) ||
    unique(reportedProgress).length !== reportedProgress.length
  ) {
    fail("reported-progress-length-or-duplicates")
  }
  return { ...assessment, reportedProgress }
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) fail("cancelled")
}

interface AnalysisRun {
  readonly options: AnalyzeConversationOptions
  readonly maxCalls: number
  calls: number
}

enum ContinuationPhase {
  Summary = "summary",
  Assessment = "assessment",
}

const tryResponse = <Value>(
  response: unknown,
  validate: (value: unknown) => Value,
): { readonly value: Value } | undefined => {
  try {
    return { value: validate(parseResponse(response)) }
  } catch (error) {
    if (error instanceof ContinuationSafetyError) throw error
    return undefined
  }
}

const requestValidated = async <Value>(
  run: AnalysisRun,
  phase: ContinuationPhase,
  request: (options: ContinuationRequestOptions) => Promise<unknown>,
  validate: (value: unknown) => Value,
): Promise<Value> => {
  for (let attempt = 0; attempt <= continuationPolicy.schemaRepairAttempts; attempt += 1) {
    throwIfAborted(run.options.signal)
    if (run.calls >= Math.min(run.maxCalls, continuationPolicy.maxCalls)) fail("model-call-cap")
    run.calls += 1
    const response = await request({
      ...(run.options.signal === undefined ? {} : { signal: run.options.signal }),
      ...(attempt === 0 ? {} : { repair: phase === ContinuationPhase.Summary ? "invalid-summary" : "invalid-assessment" }),
    })
    throwIfAborted(run.options.signal)
    const parsed = tryResponse(response, validate)
    if (parsed !== undefined) return parsed.value
    if (attempt === continuationPolicy.schemaRepairAttempts) fail(`${phase}-invalid-after-one-repair`)
    run.options.onProgress?.(`Repairing one completed invalid ${phase} response (one attempt only).`)
  }
  return fail("model-call-cap")
}

const summaryPrefix = (
  snapshotDigest: string,
  input: ContinuationSummaryInput,
  provider: ContinuationProvider,
  promptDigest: string,
): string => `continuation-v1:${digest({
  snapshotDigest, chunk: input, model: provider.model, effort: provider.effort, promptDigest,
  policyDigest: continuationPolicyDigest, schemaVersion: 1,
})}`

const summaryKey = (prefix: string, value: Omit<ConversationSummary, "key">): string => `${prefix}:${digest(value)}`

const cachedSummary = (
  cache: ReadonlyArray<ConversationSummary>,
  prefix: string,
  expected: ReadonlyArray<string>,
): ConversationSummary | undefined => {
  const candidates = cache.filter(({ key }) => key.startsWith(`${prefix}:`))
  if (candidates.length > 1) fail("duplicate-summary-cache-entry")
  const cached = candidates[0]
  if (cached === undefined) return undefined
  const fields = object(cached, ["key", "text", "evidenceIds"], "invalid-summary-cache")
  const text = string(fields.text, continuationPolicy.maxSummaryTextBytes, "invalid-summary-cache-text")
  const evidenceIds = evidenceList(fields.evidenceIds, expected)
  const value = { text, evidenceIds }
  if (!sameIds(evidenceIds, expected) || fields.key !== summaryKey(prefix, value)) fail("summary-cache-integrity-or-coverage")
  assertContentSafety(value)
  return { key: cached.key, ...value }
}

const safeFailureCode = (error: unknown): string => {
  if (error instanceof ContinuationAnalysisError) return error.code
  if (error instanceof RestrictedGuideModelError) {
    return error.cleanupFailures.length === 0 ? error.code : `${error.code}; cleanup failed: ${error.cleanupFailures.join(", ")}`
  }
  if (error instanceof GuideModelCapabilityError) return error.message
  if (error instanceof Error && error.name === "AbortError") return "cancelled"
  return "provider-or-progress-failed"
}

const persistSummary = async (
  options: AnalyzeConversationOptions,
  summaries: ReadonlyArray<ConversationSummary>,
): Promise<void> => {
  try {
    await options.onSummaries?.(structuredClone(summaries))
  } catch {
    fail("summary-save-failed")
  }
}

const executeSummaries = async (
  snapshot: ConversationSnapshot,
  plan: HistoryPlan,
  provider: ContinuationProvider,
  promptDigest: string,
  run: AnalysisRun,
  summaries: ConversationSummary[],
): Promise<ReadonlyArray<ConversationSummary>> => {
  const snapshotDigest = digest(snapshot)
  const completed = new Map<string, ConversationSummary>()
  const cache = structuredClone(run.options.summaries ?? [])
  if (cache.length > continuationPolicy.maxCalls) fail("summary-cache-size")
  for (const node of plan.nodes) {
    throwIfAborted(run.options.signal)
    const children = node.children.map(({ id }) => completed.get(id) ?? fail("missing-summary-child"))
    const input = summaryInput(snapshot, node.messages, children)
    if (!summaryFits(input)) fail("summary-input-budget")
    const prefix = summaryPrefix(snapshotDigest, input, provider, promptDigest)
    let summary = cachedSummary(cache, prefix, node.evidenceIds)
    const reused = summary !== undefined
    run.options.onProgress?.(
      `${summary === undefined ? "Summarizing" : "Reusing summary"} ${summaries.length + 1}/${plan.nodes.length}: ${node.evidenceIds.length} evidence messages.`,
    )
    if (summary === undefined) {
      const value = await requestValidated(run, ContinuationPhase.Summary, (requestOptions) => provider.summarize(input, requestOptions),
        (response) => summaryValue(response, node.evidenceIds))
      summary = { key: summaryKey(prefix, value), ...value }
    }
    completed.set(node.id, summary)
    summaries.push(summary)
    if (!reused) await persistSummary(run.options, summaries)
  }
  return plan.roots.map(({ id }) => completed.get(id) ?? fail("missing-assessment-summary"))
}

/**
 * No tail-only fallback is possible: the entire plan and its worst-case
 * repair budget are checked before the first call. Errors retain validated
 * summaries for a deliberate retry; onSummaries supports incremental saves.
 */
export const analyzeConversation = async (
  suppliedSnapshot: ConversationSnapshot,
  suppliedEntries: ReadonlyArray<GuideMatchCatalogEntry>,
  provider: ContinuationProvider,
  options: AnalyzeConversationOptions = {},
): Promise<{ assessment: ContinuationAssessment; summaries: ConversationSummary[] }> => {
  const summaries: ConversationSummary[] = []
  try {
    throwIfAborted(options.signal)
    const snapshot = checkedSnapshot(suppliedSnapshot)
    const entries = projectCatalog(suppliedEntries)
    assertContentSafety({ snapshot: context(snapshot), messages: snapshot.messages, entries })
    const plan = historyPlan(snapshot, entries)
    options.onProgress?.(
      `Snapshot: ${snapshot.messages.length} evidence messages; source history ${snapshot.coverage.complete ? "complete" : "incomplete"}; ${snapshot.coverage.notices.length} coverage notices.`,
    )
    options.onProgress?.(
      `Call plan: ${plan.calls.summarizationCalls} summaries, 1 assessment, at most ${plan.calls.maxCalls} calls including repairs.`,
    )
    const promptDigest = await provider.promptDigest()
    string(provider.model, 256, "invalid-provider-model")
    if (!/^[a-f0-9]{64}$/u.test(promptDigest)) fail("invalid-provider-prompt-digest")
    const run: AnalysisRun = { options, maxCalls: plan.calls.maxCalls, calls: 0 }
    const roots = await executeSummaries(snapshot, plan, provider, promptDigest, run, summaries)
    throwIfAborted(options.signal)
    const input = assessmentInput(snapshot, entries, plan.recent, roots)
    if (jsonBytes(input) > bodyBudget) fail("assessment-input-budget")
    options.onProgress?.(
      `Assessing ${snapshot.messages.length} evidence messages: ${plan.recent.length} verbatim, ${roots.length} older-history summaries. Progress is reported, not verified; readiness is not checked.`,
    )
    const assessment = await requestValidated(run, ContinuationPhase.Assessment, (requestOptions) => provider.assess(input, requestOptions),
      (response) => assessmentValue(response, snapshot, entries))
    throwIfAborted(options.signal)
    return { assessment, summaries }
  } catch (error) {
    throw new ContinuationAnalysisError(safeFailureCode(error), structuredClone(summaries))
  }
}
