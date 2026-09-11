/**
 * Provider-neutral, side-effect-free headless service for `trx guide --json`.
 *
 * This module owns:
 * - Strict parsing of headless argv and stdin JSON service requests.
 * - Model/effort configuration resolution (CLI/request > environment > defaults).
 * - The `match` and `generate` phase services, which call an injected
 *   `GuideProvider` and project its validated output into stable, minimal,
 *   read-only response DTOs that never leak absolute command paths, prompt
 *   templates, or the full authored guide.
 * - Deterministic literal fallbacks (`literalGuideMatch`,
 *   `templatePromptCandidates`) for a future TUI that does not go through a
 *   model at all.
 *
 * Nothing here spawns a process, reads unrelated files, or talks to a model
 * directly: `runGuideMatch`/`runGuideGenerate` accept a `GuideProvider` and a
 * pre-parsed `CombinedGuideCatalog` as arguments, and only `runGuideGenerate`
 * performs I/O, via the injected `loadSelectedGuide`, to read the one
 * selected profile's authored Markdown guide.
 */
import type {
  ProfileGuideGoalController,
  ProfileGuidePrerequisite,
  ProfileGuideV1,
  ProfileGuideWorkflow,
} from "../../trellage-guide-core/dist/index.js"
import { profileGuideIdentityKey } from "../../trellage-guide-core/dist/index.js"
import {
  compactProfileGuide,
  guideCatalogEntries,
  guideMatchCatalogEntries,
  toGuideMatchCatalogEntry,
  type CombinedGuideCatalog,
  type CompactProfileGuideWorkflow,
  type GuideMatchCatalogEntry,
  type GuideCatalogSurface,
  type HeadlessCapabilitiesV1,
  type HerdrCompatibilityInfo,
  type NativeGuideCatalogEntry,
  type SandboxGuideCatalogEntry,
} from "./guide-catalog.js"
import { GuideGoalError, validateGuideGoalDraft } from "./guide-goal-augment.js"
import {
  assertPreparedGuideGoal,
  guideGoalControllerLabel,
  prepareGuideGoal,
  resolveGuideGoalExecution,
  type GuideGoalCandidateContext,
  type PreparedGuideGoal,
} from "./guide-goal-execution.js"
import { runGuideGoalGeneration, templateGuideGoalCandidates } from "./guide-goal-generation.js"
import { resolveGuideGoalTransport, type GuideGoalTransport } from "./guide-goal-transport.js"
import {
  buildGuideLaunchCommand,
  parseSelectedProfile,
  renderCommandPreview,
  type CommandSpec,
  type PromptHandlingMode,
  type SelectedProfile,
} from "./guide-launch.js"
import {
  defaultGuideModelRouting as baseDefaultGuideModelRouting,
  type GuideModelConfig as BaseGuideModelConfig,
  type GuideModelRouting,
} from "./guide-model-routing.js"
import type { GuideArtifactCache } from "./guide-match-cache.js"
import {
  assertGuideMatchInput,
  validateGuideGenerateResult,
  validateGuideMatchResult,
  validateGuideOptimizeResult,
  type GuideGenerateCandidate,
  type GuideMatchCandidate,
  type GuideProvider,
} from "./guide-provider.js"
import { loadSelectedGuide } from "./guide-selected.js"
import { exactKeys, fail, GuideValidationError, literal, record, text } from "./guide-text.js"
import {
  GuideCandidatePromptCollisionError,
  GuideCandidatePromptStage,
  GuideWorkflowBodyError,
  renderWorkflowBodyCandidate,
  requireDistinctGuideCandidatePrompts,
  resolveGeneratedWorkflowBodyCandidate,
  resolveWorkflowBodyCandidate,
  restoreWorkflowCandidateFrame,
  workflowAuthorizationBody,
  workflowHasAuthoredCommandSuffix,
  workflowOptimizeFixedFrame,
  workflowPromptFrame,
} from "./guide-workflow-prompt.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for malformed headless argv. */
export class GuideArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GuideArgsError"
  }
}

/** Thrown for a request that is well-formed but cannot be serviced (e.g. an unknown profile reference). */
export class GuideServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options === undefined ? undefined : options)
    this.name = "GuideServiceError"
  }
}

// ---------------------------------------------------------------------------
// Discriminated enums (per repository TypeScript convention: narrow with a
// string enum, never a bare string literal).
// ---------------------------------------------------------------------------

export enum GuidePhase {
  Match = "match",
  Generation = "generation",
}

export enum GuideEffort {
  Low = "low",
  Medium = "medium",
  High = "high",
  XHigh = "xhigh",
  Max = "max",
}

export enum GuideLongPromptVariant {
  Pager = "pager",
  Split = "split",
  Focus = "focus",
  Bookends = "bookends",
  Dashboard = "dashboard",
}

const guideLongPromptVariantLiterals = [
  GuideLongPromptVariant.Pager,
  GuideLongPromptVariant.Split,
  GuideLongPromptVariant.Focus,
  GuideLongPromptVariant.Bookends,
  GuideLongPromptVariant.Dashboard,
] as const

const guideEffortLiterals = ["low", "medium", "high", "xhigh", "max"] as const
type GuideEffortLiteral = (typeof guideEffortLiterals)[number]

const guideEffortFromLiteral = (raw: GuideEffortLiteral): GuideEffort => {
  switch (raw) {
    case "low":
      return GuideEffort.Low
    case "medium":
      return GuideEffort.Medium
    case "high":
      return GuideEffort.High
    case "xhigh":
      return GuideEffort.XHigh
    case "max":
      return GuideEffort.Max
  }
}

const parseGuideEffort = (value: unknown, path: string): GuideEffort =>
  guideEffortFromLiteral(literal(value, path, guideEffortLiterals))

// ---------------------------------------------------------------------------
// Shared bounds and validators.
// ---------------------------------------------------------------------------

export const guideIntentMaximumLength = 60_000
const profileRefMaximumLength = 256
const modelIdentifierMaximumLength = 128
const modelIdentifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u

export const validateGuideIntent = (value: unknown, path: string): string =>
  text(value, path, guideIntentMaximumLength, { multiline: true })

const validateProfileRef = (value: unknown, path: string): string => text(value, path, profileRefMaximumLength)

const validateModelId = (value: unknown, path: string): string => {
  const trimmed = text(value, path, modelIdentifierMaximumLength)
  if (!modelIdentifierPattern.test(trimmed)) fail(path, "must be a safe lowercase model identifier")
  return trimmed
}

const tokenize = (value: string): ReadonlySet<string> =>
  new Set(
    value
      .toLocaleLowerCase("en")
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 0),
  )

const tokenOverlapCount = (tokens: ReadonlySet<string>, intentTokens: ReadonlySet<string>): number => {
  let overlap = 0
  for (const token of tokens) if (intentTokens.has(token)) overlap += 1
  return overlap
}

const normalizedTokenOverlapScore = (value: string, intentTokens: ReadonlySet<string>): number => {
  const tokens = tokenize(value)
  if (tokens.size === 0 || intentTokens.size === 0) return 0
  return tokenOverlapCount(tokens, intentTokens) / Math.sqrt(tokens.size * intentTokens.size)
}

const normalizeIdentityPhrase = (value: string): string =>
  value
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()

// ---------------------------------------------------------------------------
// Headless argv parsing.
// ---------------------------------------------------------------------------

export interface GuideHeadlessArgs {
  readonly help: boolean
  readonly json: boolean
  readonly intent: string | undefined
  readonly intentStdin: boolean
  readonly profile: string | undefined
  readonly model: string | undefined
  readonly effort: GuideEffort | undefined
  readonly uiVariant?: GuideLongPromptVariant
  readonly nextSteps?: boolean
}

const helpFlag = "--help"
const jsonFlag = "--json"
const intentFlag = "--intent"
const intentStdinFlag = "--intent-stdin"
const inlineIntentPrefix = `${intentFlag}=`
const profileFlag = "--profile"
const modelFlag = "--model"
const effortFlag = "--effort"
const uiVariantFlag = "--ui-variant"
const nextStepsFlag = "--next-steps"

const booleanFlags = new Set([helpFlag, jsonFlag, intentStdinFlag, nextStepsFlag])
const valueFlags = new Set([intentFlag, profileFlag, modelFlag, effortFlag, uiVariantFlag])
const knownFlags = new Set([...booleanFlags, ...valueFlags])

interface MutableGuideArgs {
  help: boolean
  json: boolean
  intentStdin: boolean
  nextSteps: boolean
  intentFromFlag: string | undefined
  profile: string | undefined
  model: string | undefined
  effort: GuideEffort | undefined
  uiVariant: GuideLongPromptVariant | undefined
  readonly positionals: string[]
  readonly seenFlags: Set<string>
}

const setGuideValueFlag = (state: MutableGuideArgs, token: string, value: string): void => {
  if (token === intentFlag) state.intentFromFlag = validateGuideIntent(value, "--intent")
  else if (token === profileFlag) state.profile = validateProfileRef(value, "--profile")
  else if (token === modelFlag) state.model = validateModelId(value, "--model")
  else if (token === effortFlag) state.effort = parseGuideEffort(value, "--effort")
  else state.uiVariant = literal(value, "--ui-variant", guideLongPromptVariantLiterals)
}

const consumeGuideFlag = (argv: ReadonlyArray<string>, index: number, state: MutableGuideArgs): number => {
  const token = argv[index]
  if (token === undefined || !knownFlags.has(token)) throw new GuideArgsError(`Unknown flag: ${token ?? ""}`)
  if (state.seenFlags.has(token)) throw new GuideArgsError(`Duplicate flag: ${token}`)
  state.seenFlags.add(token)
  if (token === helpFlag) {
    state.help = true
    return index
  }
  if (token === jsonFlag) {
    state.json = true
    return index
  }
  if (token === intentStdinFlag) {
    state.intentStdin = true
    return index
  }
  if (token === nextStepsFlag) {
    state.nextSteps = true
    return index
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new GuideArgsError(`Missing value for flag: ${token}`)
  }
  setGuideValueFlag(state, token, value)
  return index + 1
}

const validateGuideIntentSource = (state: MutableGuideArgs): void => {
  if (state.positionals.length > 1) throw new GuideArgsError("Only one positional intent argument is allowed")
  if (state.intentFromFlag !== undefined && state.positionals.length === 1) {
    throw new GuideArgsError("Provide intent via --intent or a positional argument, not both")
  }
  if (state.intentStdin && (state.intentFromFlag !== undefined || state.positionals.length > 0)) {
    throw new GuideArgsError("Provide intent via --intent-stdin, --intent, or a positional argument, not more than one")
  }
  if (state.intentStdin && state.json) {
    throw new GuideArgsError("--intent-stdin is available only for the interactive guide")
  }
}

const resolveGuideIntent = (state: MutableGuideArgs): string | undefined => {
  const positionalIntent = state.positionals[0]
  return (
    state.intentFromFlag ??
    (positionalIntent === undefined ? undefined : validateGuideIntent(positionalIntent, "intent"))
  )
}

const validateGuideModeFlags = (state: MutableGuideArgs): void => {
  if (
    state.nextSteps &&
    (state.json ||
      state.intentStdin ||
      state.intentFromFlag !== undefined ||
      state.positionals.length > 0 ||
      state.profile !== undefined ||
      state.uiVariant !== undefined)
  ) {
    throw new GuideArgsError("--next-steps requires a private conversation request, not another guide input or mode")
  }
  if (state.profile !== undefined && !state.json) throw new GuideArgsError("--profile requires --json")
  if (state.uiVariant !== undefined && state.json) throw new GuideArgsError("--ui-variant is interactive-only")
}

const finalizeGuideArgs = (state: MutableGuideArgs): GuideHeadlessArgs => {
  validateGuideIntentSource(state)
  validateGuideModeFlags(state)
  const intent = resolveGuideIntent(state)
  return {
    help: state.help,
    json: state.json,
    intent,
    intentStdin: state.intentStdin,
    profile: state.profile,
    model: state.model,
    effort: state.effort,
    ...(state.uiVariant === undefined ? {} : { uiVariant: state.uiVariant }),
    ...(state.nextSteps ? { nextSteps: true } : {}),
  }
}

export const guideHeadlessHelpText = [
  "Usage: trx guide [intent] [options]",
  "       trx guide --intent-stdin [options]",
  "       trx guide --json --intent <text> [options]",
  "       trx guide --json <text> [options]",
  "",
  "Options:",
  "  <intent>             Start the interactive guide with an initial intent.",
  "  --json               Emit a machine-readable JSON response.",
  "  --intent <text>       Multiline task description, up to 60,000 characters.",
  "                         May instead be given as a single positional argument.",
  "  --intent-stdin        Read the interactive guide intent as plain text from stdin.",
  "  --next-steps          Analyze the focused conversation from a private Herdr popup request.",
  "  --profile <ref>        Generate prompts for one specific catalog profile",
  "                         reference instead of matching. Requires --json.",
  "  --model <id>            Override the configured model.",
  "  --effort <level>       Override the configured reasoning effort:",
  "                         low, medium, high, xhigh, or max.",
  "  --ui-variant <name>    Select the on-demand prompt viewer:",
  "                         pager, split, focus, bookends, or dashboard.",
  "  --help                Show this help text.",
].join("\n")

/**
 * Strictly parses headless `trx guide` argv. Rejects unknown or duplicate
 * flags, flags missing a value, more than one positional argument, and
 * empty/control-containing/oversized text. `--profile` requires `--json`.
 * An omitted intent is supplied by stdin JSON mode or the interactive editor.
 * Interactive plain-text stdin requires `--intent-stdin`.
 */
export const parseGuideHeadlessArgv = (argv: ReadonlyArray<string>): GuideHeadlessArgs => {
  const state: MutableGuideArgs = {
    help: false,
    json: false,
    intentStdin: false,
    nextSteps: false,
    intentFromFlag: undefined,
    profile: undefined,
    model: undefined,
    effort: undefined,
    uiVariant: undefined,
    positionals: [],
    seenFlags: new Set(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token.startsWith(inlineIntentPrefix)) {
      if (state.seenFlags.has(intentFlag)) throw new GuideArgsError(`Duplicate flag: ${intentFlag}`)
      state.seenFlags.add(intentFlag)
      state.intentFromFlag = validateGuideIntent(token.slice(inlineIntentPrefix.length), "--intent")
      continue
    }
    if (!token.startsWith("--")) {
      state.positionals.push(token)
      continue
    }
    index = consumeGuideFlag(argv, index, state)
  }
  return finalizeGuideArgs(state)
}

// ---------------------------------------------------------------------------
// Stdin JSON service request parsing.
// ---------------------------------------------------------------------------

export interface GuideServiceRequest {
  readonly schemaVersion: 1
  readonly intent: string
  readonly profile?: string
  readonly model?: string
  readonly effort?: GuideEffort
  readonly goal?: PreparedGuideGoal
  readonly workflowId?: string
}

const parseRequestedGuideGoal = (value: unknown, intent: string): PreparedGuideGoal | undefined => {
  if (value === undefined) return undefined
  const draft = record(value, "request.goal")
  exactKeys(draft, "request.goal", ["artifact", "task", "criteria"])
  return prepareGuideGoal({ draft: validateGuideGoalDraft(draft), prompt: intent })
}

/** Structured goal fields are explicit caller input, not inferred Goal-me approval. */
export const parseGuideServiceRequestJson = (source: string, defaultProfileRef?: string): GuideServiceRequest => {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return fail("request", "must contain valid JSON")
  }
  const fields = record(payload, "request")
  exactKeys(fields, "request", ["schemaVersion", "intent"], ["profile", "model", "effort", "goal", "workflowId"])
  if (fields.schemaVersion !== 1) fail("request.schemaVersion", "must equal 1")
  const intent = validateGuideIntent(fields.intent, "request.intent")
  const profileValue = fields.profile === undefined ? defaultProfileRef : fields.profile
  const profile = profileValue === undefined ? undefined : validateProfileRef(profileValue, "request.profile")
  const model = fields.model === undefined ? undefined : validateModelId(fields.model, "request.model")
  const effort = fields.effort === undefined ? undefined : parseGuideEffort(fields.effort, "request.effort")
  const workflowId = fields.workflowId === undefined ? undefined : text(fields.workflowId, "request.workflowId", 128)
  const goal = parseRequestedGuideGoal(fields.goal, intent)
  if (workflowId !== undefined && profile === undefined) fail("request.workflowId", "requires a selected profile")
  return {
    schemaVersion: 1,
    intent,
    ...(profile === undefined ? {} : { profile }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(goal === undefined ? {} : { goal }),
    ...(workflowId === undefined ? {} : { workflowId }),
  }
}

// ---------------------------------------------------------------------------
// Model/effort configuration resolution.
// ---------------------------------------------------------------------------

export const defaultGuideMatchModelId = baseDefaultGuideModelRouting.match.model
export const defaultGuideGenerateModelId = baseDefaultGuideModelRouting.generate.model
export const defaultGuideOptimizeModelId = baseDefaultGuideModelRouting.optimize.model
export const defaultGuideRefineModelId = baseDefaultGuideModelRouting.refine.model
export const defaultGuideEnrichModelId = baseDefaultGuideModelRouting.enrich.model
export const defaultGuideModelId = defaultGuideMatchModelId
export const defaultGuideEffort = GuideEffort.Medium

export interface GuideModelOverrides {
  readonly model?: string
  readonly effort?: GuideEffort
}

export type GuideModelConfig = BaseGuideModelConfig<GuideEffort>
export type GuideResolvedModelRouting = GuideModelRouting<GuideEffort>

export const defaultGuideModelRouting: GuideResolvedModelRouting = {
  match: { model: defaultGuideMatchModelId, effort: defaultGuideEffort },
  generate: { model: defaultGuideGenerateModelId, effort: defaultGuideEffort },
  optimize: { model: defaultGuideOptimizeModelId, effort: defaultGuideEffort },
  refine: { model: defaultGuideRefineModelId, effort: defaultGuideEffort },
  enrich: { model: defaultGuideEnrichModelId, effort: defaultGuideEffort },
}

const applyResolvedOverrides = (
  config: GuideModelConfig,
  model: string | undefined,
  effort: GuideEffort | undefined,
): GuideModelConfig => ({
  model: model ?? config.model,
  effort: effort ?? config.effort,
})

const resolveModelOverride = (
  overrides: GuideModelOverrides,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (overrides.model !== undefined) return overrides.model
  return env.TRELLAGE_GUIDE_MODEL === undefined
    ? undefined
    : validateModelId(env.TRELLAGE_GUIDE_MODEL, "TRELLAGE_GUIDE_MODEL")
}

const resolveEffortOverride = (
  overrides: GuideModelOverrides,
  env: Readonly<Record<string, string | undefined>>,
): GuideEffort | undefined => {
  if (overrides.effort !== undefined) return overrides.effort
  return env.TRELLAGE_GUIDE_EFFORT === undefined
    ? undefined
    : parseGuideEffort(env.TRELLAGE_GUIDE_EFFORT, "TRELLAGE_GUIDE_EFFORT")
}

/** Resolves phase routing with precedence: explicit overrides > environment > phase defaults. */
export const resolveGuideModelRouting = (
  overrides: GuideModelOverrides,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GuideResolvedModelRouting => {
  const model = resolveModelOverride(overrides, env)
  const effort = resolveEffortOverride(overrides, env)
  return {
    match: applyResolvedOverrides(defaultGuideModelRouting.match, model, effort),
    generate: applyResolvedOverrides(defaultGuideModelRouting.generate, model, effort),
    optimize: applyResolvedOverrides(defaultGuideModelRouting.optimize, model, effort),
    refine: applyResolvedOverrides(defaultGuideModelRouting.refine, model, effort),
    enrich: applyResolvedOverrides(defaultGuideModelRouting.enrich, model, effort),
  }
}

/** Resolves the Match model for callers that still need one global model/effort pair. */
export const resolveGuideModelConfig = (
  overrides: GuideModelOverrides,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GuideModelConfig => resolveGuideModelRouting(overrides, env).match

// ---------------------------------------------------------------------------
// Catalog lookup helpers shared by the match/generate services.
// ---------------------------------------------------------------------------

const findFullCatalogEntry = (
  catalog: CombinedGuideCatalog,
  ref: string,
): NativeGuideCatalogEntry | SandboxGuideCatalogEntry | undefined => {
  const native = catalog.native.find(
    (entry) =>
      profileGuideIdentityKey({
        surface: "native",
        launcher: entry.launcher,
        profile: entry.name,
      }) === ref,
  )
  if (native !== undefined) return native
  return catalog.sandbox.find((entry) => profileGuideIdentityKey({ surface: "sandbox", profile: entry.name }) === ref)
}

const isNativeEntry = (entry: NativeGuideCatalogEntry | SandboxGuideCatalogEntry): entry is NativeGuideCatalogEntry =>
  "launcher" in entry

/** Returns the underlying harness name Prompt Master should optimize for. */
export const guideTargetTool = (catalog: CombinedGuideCatalog, profileRef: string): string => {
  const entry = findFullCatalogEntry(catalog, profileRef)
  if (entry === undefined) throw new GuideServiceError(`Unknown profile reference: ${profileRef}`)
  return isNativeEntry(entry) ? entry.harness : entry.harness.kind
}

const assertTriple = <T>(items: ReadonlyArray<T>, label: string): readonly [T, T, T] => {
  if (items.length !== 3) throw new GuideServiceError(`${label} must contain exactly 3 items: got ${items.length}`)
  const [first, second, third] = items
  if (first === undefined || second === undefined || third === undefined) {
    throw new GuideServiceError(`${label} must contain exactly 3 items`)
  }
  return [first, second, third]
}

const assertRecommendationSet = <T>(
  items: ReadonlyArray<T>,
  label: string,
  goal?: PreparedGuideGoal,
): ReadonlyArray<T> => {
  const minimum = goal === undefined ? 3 : 1
  if (items.length < minimum || items.length > 5) {
    throw new GuideServiceError(`${label} must contain ${minimum} to 5 items: got ${items.length}`)
  }
  return items
}

// ---------------------------------------------------------------------------
// Match service.
// ---------------------------------------------------------------------------

export interface GuideGoalPolicySummary {
  readonly controller: ProfileGuideGoalController
  readonly label: string
}

const goalPolicySummary = (controller: ProfileGuideGoalController): GuideGoalPolicySummary => ({
  controller,
  label: guideGoalControllerLabel(controller),
})

export interface GuideRecommendation {
  readonly profileRef: string
  readonly workflowId: string
  readonly confidence: number
  readonly reason: string
  readonly tradeoff: string
  readonly surface: GuideCatalogSurface
  readonly name: string
  readonly launcher?: string
  readonly harness?: string
  readonly description: string
  readonly sandbox: boolean
  readonly workflow: CompactProfileGuideWorkflow
  readonly prerequisites: ReadonlyArray<ProfileGuidePrerequisite>
  readonly headless: HeadlessCapabilitiesV1
  readonly herdrCompatibility: HerdrCompatibilityInfo
  readonly goalExecution?: GuideGoalPolicySummary
}

export interface GuideMatchResponse {
  readonly schemaVersion: 1
  readonly phase: GuidePhase.Match
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly recommendations: ReadonlyArray<GuideRecommendation>
}

export interface GuideMatchRequest {
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly goal?: PreparedGuideGoal
}

const enrichRecommendation = (
  catalog: CombinedGuideCatalog,
  candidate: GuideMatchCandidate,
  goal?: PreparedGuideGoal,
): GuideRecommendation => {
  const entry = findFullCatalogEntry(catalog, candidate.profileRef)
  if (entry === undefined) {
    throw new GuideServiceError(`Match result references an unknown profile: ${candidate.profileRef}`)
  }
  const workflow = compactProfileGuide(entry.guide).workflows.find(({ id }) => id === candidate.workflowId)
  if (workflow === undefined) {
    throw new GuideServiceError(
      `Match result references an unknown workflow of ${candidate.profileRef}: ${candidate.workflowId}`,
    )
  }
  const native = isNativeEntry(entry)
  const execution = goal === undefined ? undefined : resolveGuideGoalExecution(goal, entry.guide, candidate.workflowId)
  return {
    profileRef: candidate.profileRef,
    workflowId: candidate.workflowId,
    confidence: candidate.confidence,
    reason: candidate.reason,
    tradeoff: candidate.tradeoff,
    surface: native ? "native" : "sandbox",
    name: entry.name,
    ...(native ? { launcher: entry.launcher } : { harness: entry.harness.kind }),
    description: entry.description,
    sandbox: entry.sandbox,
    workflow,
    prerequisites: entry.guide.prerequisites,
    headless: entry.headless,
    herdrCompatibility: entry.herdrCompatibility,
    ...(execution === undefined ? {} : { goalExecution: goalPolicySummary(execution.controller) }),
  }
}

/**
 * Calls `provider.match` with the compact, path-free catalog projection and
 * returns three to five ordinary recommendations or one to five goal
 * recommendations. Never exposes `commandPath`, Sandbox `path`, prompt templates, absolute paths,
 * or the full authored guide.
 */
export const runGuideMatch = async (
  provider: GuideProvider,
  catalog: CombinedGuideCatalog,
  request: GuideMatchRequest,
  cache?: GuideArtifactCache,
): Promise<GuideMatchResponse> => {
  const goalCatalog = request.goal === undefined ? undefined : goalMatchCatalog(catalog, request.intent, request.goal)
  const rankingIntent = request.goal === undefined ? request.intent : goalMatchIntent(request.goal)
  const entries = prefilterMatchEntries(
    goalCatalog?.entries ?? guideMatchCatalogEntries(catalog),
    rankingIntent,
    request.goal === undefined ? undefined : request.intent,
  )
  const input = assertGuideMatchInput({
    intent: request.intent,
    entries,
    ...(request.goal === undefined ? {} : { goal: request.goal }),
    ...(goalCatalog === undefined || goalCatalog.explicitProfileRefs.length === 0
      ? {}
      : { preferredProfileRefs: goalCatalog.explicitProfileRefs }),
  })
  const workflowIndex = new Map(entries.map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]))
  const validate = (value: unknown) => {
    let result
    try {
      result = validateGuideMatchResult(value, workflowIndex, request.goal, input.preferredProfileRefs)
    } catch (error) {
      if (!(error instanceof GuideValidationError)) throw error
      throw new GuideServiceError(error.message, { cause: error })
    }
    return result
  }
  const produce = async () => validate(await provider.match(input))
  const result = validate(await (cache === undefined
    ? produce()
    : cache.match(
        { ...input, intent: request.intent, ...(goalCatalog === undefined ? {} : { goalFraming: goalCatalog.framing }) },
        produce,
      )))
  const recommendations = assertRecommendationSet(
    result.candidates.map((candidate) => enrichRecommendation(catalog, candidate, request.goal)),
    "match recommendations",
    request.goal,
  )
  return {
    schemaVersion: 1,
    phase: GuidePhase.Match,
    intent: request.intent,
    model: request.model,
    effort: request.effort,
    recommendations,
  }
}

// ---------------------------------------------------------------------------
// Deterministic workflow selection fallback (shared by generation and the
// literal fallback below).
// ---------------------------------------------------------------------------

const workflowTokenOverlapScore = (
  workflow: {
    readonly id: string
    readonly description: string
    readonly examples: ReadonlyArray<string>
  },
  intentTokens: ReadonlySet<string>,
): number => {
  return normalizedTokenOverlapScore([workflow.id, workflow.description, ...workflow.examples].join(" "), intentTokens)
}

/** Deterministically picks the best workflow of `workflows` by token overlap with `intent`, source order as tie-break. */
const selectBestWorkflowByTokenOverlap = (workflows: ReadonlyArray<ProfileGuideWorkflow>, intent: string): string => {
  const intentTokens = tokenize(intent)
  let best: { readonly id: string; readonly score: number } | undefined
  for (const workflow of workflows) {
    const score = workflowTokenOverlapScore(workflow, intentTokens)
    if (best === undefined || score > best.score) best = { id: workflow.id, score }
  }
  if (best === undefined) throw new GuideServiceError("Profile guide has no workflows to select from")
  return best.id
}

// ---------------------------------------------------------------------------
// Public (path-free) command projection, for prompt candidates in the
// generation response. Never exposes an internal absolute commandPath.
// ---------------------------------------------------------------------------

/** Describes delivery only, not runtime readiness or goal activation. */
export type PublicGuideGoalTransport = {
  readonly controller: ProfileGuideGoalController
  readonly reason: string
} & (
  | { readonly mode: "argv" }
  | { readonly mode: "manual"; readonly commandInput: Pick<GuideGoalTransport, "command" | "body"> }
)

export interface PublicGuideCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly preview: string
  readonly promptHandling: PromptHandlingMode
  readonly goalTransport?: PublicGuideGoalTransport
}

const publicGoalTransport = (
  controller: ProfileGuideGoalController,
  transport: GuideGoalTransport,
): PublicGuideGoalTransport =>
  transport.mode === "manual"
    ? {
        controller,
        mode: "manual",
        reason: `Type '${transport.command} ' in the native command input, then paste only commandInput.body and submit. Starting the profile does not activate this goal.`,
        commandInput: { command: transport.command, body: transport.body },
      }
    : {
        controller,
        mode: "argv",
        reason: "The validated goal uses the selected launcher's existing argv prompt route.",
      }

/**
 * Builds the current-terminal command a user would run to launch the given
 * catalog profile with `prompt`, using the launcher alias (native) or
 * `trellage` (Sandbox) as the public executable — never the internal
 * absolute `commandPath`. Ordinary prompts use `-p <prompt>` only when the
 * profile's `headless.prompt` capability is true; otherwise they use manual
 * paste. Goals use the declared controller transport and expose its input
 * requirement through `goalTransport`. Resolves the
 * selected workflow's agent through the same launch state as the interactive UI.
 */
export const publicGuideLaunchCommand = (
  catalog: CombinedGuideCatalog,
  ref: string,
  prompt: string,
  workflowId: string,
  goalExecution?: GuideGoalCandidateContext,
): PublicGuideCommand => {
  const selected = selectedProfileFromCatalogRef(catalog, ref, workflowId)
  const executable = selected.surface === "native" ? selected.launcher : "trellage"
  if (goalExecution !== undefined) {
    if (goalExecution.workflow.id !== workflowId) {
      throw new GuideServiceError("The goal candidate does not belong to the selected workflow.")
    }
    const built = buildGuideLaunchCommand(selected, { mode: "argv", prompt }, goalExecution)
    const command: CommandSpec = { executable, args: built.command.args }
    const transport = resolveGuideGoalTransport(selected, prompt, goalExecution, "current-terminal")
    return {
      ...command,
      preview: renderCommandPreview(command),
      promptHandling: built.promptHandling,
      goalTransport: publicGoalTransport(goalExecution.controller, transport),
    }
  }
  const baseArgs = buildGuideLaunchCommand(selected).command.args
  const headlessPrompt = selected.headlessPrompt
  const args = headlessPrompt ? [...baseArgs, "-p", prompt] : baseArgs
  const promptHandling: PromptHandlingMode = headlessPrompt ? "argv" : "manual-paste"
  const command: CommandSpec = { executable, args }
  return { executable, args, preview: renderCommandPreview(command), promptHandling }
}

/**
 * Converts a catalog reference and workflow into the validated `SelectedProfile`
 * used for later launch: the root `sandboxCommandPath` for Sandbox profiles,
 * the native entry's own `commandPath` for native profiles, and
 * `headless.prompt` from the catalog as `headlessPrompt`, and the authored
 * workflow's `launchAgent` as `agent`.
 */
export const selectedProfileFromCatalogRef = (
  catalog: CombinedGuideCatalog,
  ref: string,
  workflowId: string,
): SelectedProfile => {
  const entry = findFullCatalogEntry(catalog, ref)
  if (entry === undefined) throw new GuideServiceError(`Unknown profile reference: ${ref}`)
  const agent = findGuideWorkflow(entry.guide, workflowId).launchAgent
  if (isNativeEntry(entry)) {
    return parseSelectedProfile({
      surface: "native",
      launcher: entry.launcher,
      commandPath: entry.commandPath,
      profile: entry.name,
      headlessPrompt: entry.headless.prompt,
      ...(agent === undefined ? {} : { agent }),
      ...(entry.guide.goalExecution === undefined ? {} : { goalExecutionPolicy: entry.guide.goalExecution }),
    })
  }
  if (agent !== undefined && entry.harness.kind !== "copilot") {
    throw new GuideServiceError(`Workflow launchAgent is supported only for Copilot Sandbox profiles: ${ref}`)
  }
  return parseSelectedProfile({
    surface: "sandbox",
    commandPath: catalog.sandboxCommandPath,
    profile: entry.name,
    headlessPrompt: entry.headless.prompt,
    ...(agent === undefined ? {} : { agent }),
    ...(entry.guide.goalExecution === undefined ? {} : { goalExecutionPolicy: entry.guide.goalExecution }),
  })
}

// ---------------------------------------------------------------------------
// Generation service.
// ---------------------------------------------------------------------------

export interface GuideSelectedProfileSummary {
  readonly profileRef: string
  readonly workflowId: string
  readonly surface: GuideCatalogSurface
  readonly name: string
  readonly launcher?: string
  readonly harness?: string
  readonly description: string
  readonly sandbox: boolean
  readonly workflow: CompactProfileGuideWorkflow
  readonly prerequisites: ReadonlyArray<ProfileGuidePrerequisite>
  readonly headless: HeadlessCapabilitiesV1
  readonly herdrCompatibility: HerdrCompatibilityInfo
  readonly goalExecution?: GuideGoalPolicySummary
}

export interface GuidePromptCandidate {
  readonly title: string
  readonly prompt: string
  readonly notes: string
  readonly command: PublicGuideCommand
  readonly goalExecution?: GuideGoalPolicySummary
}

export interface GuideGenerationResponse {
  readonly schemaVersion: 1
  readonly phase: GuidePhase.Generation
  readonly intent: string
  readonly model: string
  readonly effort: GuideEffort
  readonly profile: GuideSelectedProfileSummary
  readonly candidates: readonly [GuidePromptCandidate, GuidePromptCandidate, GuidePromptCandidate]
}

export interface GuideGenerateRequest extends GuideMatchRequest {
  readonly profileRef: string
  readonly workflowId?: string
}

const selectGuideGenerationWorkflow = (guide: ProfileGuideV1, request: GuideGenerateRequest): string => {
  if (request.workflowId !== undefined) {
    if (request.goal !== undefined) {
      try {
        resolveGuideGoalExecution(request.goal, guide, request.workflowId)
      } catch (error) {
        if (!(error instanceof GuideGoalError || error instanceof GuideValidationError)) throw error
        throw new GuideServiceError(
          `Workflow ${request.profileRef}/${request.workflowId} cannot execute this goal: ${error.message}`,
          { cause: error },
        )
      }
    }
    return request.workflowId
  }
  if (request.goal === undefined) return selectBestWorkflowByTokenOverlap(guide.workflows, request.intent)
  assertPreparedGuideGoal(request.goal)
  const compatibility = compatibleGoalWorkflows(guide, request.goal)
  if (compatibility.workflows.length === 0) {
    throw new GuideServiceError(`Profile ${request.profileRef} cannot execute this goal: ${compatibility.reason}`)
  }
  return selectBestWorkflowByTokenOverlap(compatibility.workflows, goalMatchIntent(request.goal))
}

const findGuideWorkflow = (guide: ProfileGuideV1, workflowId: string): ProfileGuideWorkflow => {
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${workflowId}`)
  return workflow
}

const escapeRegularExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

const flexibleWhitespacePattern = (value: string): string =>
  value
    .split(/(\s+)/u)
    .map((part) => (/\s+/u.test(part) ? "\\s+" : escapeRegularExpression(part)))
    .join("")

const isCompleteWorkflowPrompt = (template: string, prompt: string): boolean => {
  const pattern = template.trim().split("{{intent}}").map(flexibleWhitespacePattern).join("[\\s\\S]+")
  return new RegExp(`^${pattern}$`, "u").test(prompt.trim())
}

const removePartialTemplateBoundary = (template: string, prompt: string): string => {
  const [prefix = "", ...remainingSegments] = template.trim().split("{{intent}}")
  const suffix = remainingSegments.at(-1) ?? ""
  let body = prompt.trim()
  if (prefix.length > 0) body = body.replace(new RegExp(`^${flexibleWhitespacePattern(prefix)}`, "u"), "").trimStart()
  if (suffix.length > 0) body = body.replace(new RegExp(`${flexibleWhitespacePattern(suffix)}$`, "u"), "").trimEnd()
  return body
}

/**
 * Restores the selected skill workflow's exact authored frame once. Exact
 * frames are first reduced to their body; every other edit is treated as body
 * text in full. Workflows without a skill stay unchanged.
 */
export const applyWorkflowPromptTemplate = (
  guide: ProfileGuideV1,
  workflowId: string,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => restoreWorkflowCandidateFrame(findGuideWorkflow(guide, workflowId), candidate)

const requiredProfilePromptTemplateRefs: ReadonlySet<string> = new Set([
  "native:fmx/default",
  "native:fmx/pstack-workers",
])

const firstmateContractHeadings: ReadonlySet<string> = new Set([
  "firstmate fleet operating contract",
  "firstmate fleet investigation contract",
  "firstmate operating contract",
  "firstmate investigation contract",
  "firstmate pstack-worker operating contract",
  "firstmate pstack-worker investigation contract",
  "firstmate router operating contract",
  "firstmate router investigation contract",
  "operating contract",
  "investigation contract",
])

const removeLeadingFirstmateContract = (prompt: string): string => {
  const lines = prompt.trim().split("\n")
  const firstHeading = lines[0]?.match(/^#{1,6}\s+(.+?)\s*$/u)
  const heading = firstHeading?.[1]?.trim().toLowerCase()
  if (heading === undefined || !firstmateContractHeadings.has(heading)) return prompt.trim()

  const nextHeadingIndex = lines.findIndex((line, index) => index > 0 && /^#{1,6}\s+\S/u.test(line))
  if (nextHeadingIndex < 0) return prompt.trim()

  const nextHeading = normalizeIdentityPhrase(lines[nextHeadingIndex] ?? "")
  if (nextHeading !== "task" && nextHeading !== "investigation") return prompt.trim()
  const body = lines
    .slice(nextHeadingIndex + 1)
    .join("\n")
    .trim()
  return body.length > 0 ? body : prompt.trim()
}

/**
 * Reapplies the authored Firstmate operating contract after prompt
 * optimization. This keeps profile-specific captain and worker rules in every
 * final candidate even when a model paraphrases or drops the guide template.
 */
export const applyRequiredProfilePromptTemplate = (
  profileRef: string,
  guide: ProfileGuideV1,
  workflowId: string,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  if (!requiredProfilePromptTemplateRefs.has(profileRef)) return candidate
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${workflowId}`)
  if (isCompleteWorkflowPrompt(workflow.promptTemplate, candidate.prompt)) return candidate
  const promptBody = removePartialTemplateBoundary(
    workflow.promptTemplate,
    removeLeadingFirstmateContract(candidate.prompt),
  )
  return {
    ...candidate,
    prompt: workflow.promptTemplate.replaceAll("{{intent}}", promptBody),
  }
}

/**
 * Generates prompts for one exact profile and preserves an explicit workflow
 * selection. Otherwise selects the best eligible workflow by token overlap.
 * Loads only that profile's full guide. Goal mode delegates approach drafting
 * and protected composition to the same service used by the UI.
 */
export const runGuideGenerate = async (
  provider: GuideProvider,
  catalog: CombinedGuideCatalog,
  guideRoot: string,
  request: GuideGenerateRequest,
  cache?: GuideArtifactCache,
): Promise<GuideGenerationResponse> => {
  const entry = findFullCatalogEntry(catalog, request.profileRef)
  if (entry === undefined) throw new GuideServiceError(`Unknown profile reference: ${request.profileRef}`)

  const workflowId = selectGuideGenerationWorkflow(entry.guide, request)

  const loaded = await loadSelectedGuide(catalog, guideRoot, request.profileRef)

  const compactWorkflow = compactProfileGuide(entry.guide).workflows.find(({ id }) => id === workflowId)
  if (compactWorkflow === undefined) {
    throw new GuideServiceError(`Selected workflow is unknown for ${request.profileRef}: ${workflowId}`)
  }
  const authoredWorkflow = findGuideWorkflow(loaded.guide, workflowId)
  const execution = request.goal === undefined
    ? undefined
    : resolveGuideGoalExecution(request.goal, loaded.guide, workflowId)

  const native = isNativeEntry(entry)
  const profile: GuideSelectedProfileSummary = {
    profileRef: request.profileRef,
    workflowId,
    surface: native ? "native" : "sandbox",
    name: entry.name,
    ...(native ? { launcher: entry.launcher } : { harness: entry.harness.kind }),
    description: entry.description,
    sandbox: entry.sandbox,
    workflow: compactWorkflow,
    prerequisites: entry.guide.prerequisites,
    headless: entry.headless,
    herdrCompatibility: entry.herdrCompatibility,
    ...(execution === undefined ? {} : { goalExecution: goalPolicySummary(execution.controller) }),
  }

  const fixedFrame = workflowOptimizeFixedFrame(authoredWorkflow)
  const targetTool = isNativeEntry(entry) ? entry.harness : entry.harness.kind
  const produce = async () => {
    const generated = validateGuideGenerateResult(await provider.generate({
      intent: request.intent,
      profileRef: request.profileRef,
      workflowId,
      guide: loaded.guide,
      guideBody: loaded.body,
    }))
    let bodyCandidates: readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate]
    try {
      bodyCandidates = requireDistinctGuideCandidatePrompts(
        assertTriple(
          generated.candidates.map((candidate) =>
            resolveGeneratedWorkflowBodyCandidate(loaded.guide, authoredWorkflow, request.intent, candidate),
          ),
          "workflow body candidates",
        ),
        GuideCandidatePromptStage.GeneratedBodyNormalization,
      )
    } catch (cause) {
      if (cause instanceof GuideWorkflowBodyError || cause instanceof GuideCandidatePromptCollisionError) {
        throw new GuideServiceError(cause.message, { cause })
      }
      throw cause
    }
    const optimized = validateGuideOptimizeResult(await provider.optimize({
      targetTool,
      profileRef: request.profileRef,
      candidates: bodyCandidates,
      ...(fixedFrame === undefined ? {} : { fixedFrame }),
    }), 3)
    const [bodyFirst, bodySecond, bodyThird] = bodyCandidates
    const [optimizedFirst, optimizedSecond, optimizedThird] = assertTriple(
      optimized.candidates,
      "optimized prompt candidates",
    )
    const safeBodyCandidates = [
      resolveWorkflowBodyCandidate(loaded.guide, authoredWorkflow, bodyFirst, optimizedFirst),
      resolveWorkflowBodyCandidate(loaded.guide, authoredWorkflow, bodySecond, optimizedSecond),
      resolveWorkflowBodyCandidate(loaded.guide, authoredWorkflow, bodyThird, optimizedThird),
    ] as const
    let renderedCandidates: readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate]
    try {
      const exactRenderedCandidates = requireDistinctGuideCandidatePrompts(
        [
          renderWorkflowBodyCandidate(authoredWorkflow, safeBodyCandidates[0]),
          renderWorkflowBodyCandidate(authoredWorkflow, safeBodyCandidates[1]),
          renderWorkflowBodyCandidate(authoredWorkflow, safeBodyCandidates[2]),
        ],
        GuideCandidatePromptStage.FinalRendering,
      )
      renderedCandidates = requireDistinctGuideCandidatePrompts(
        [
          applyRequiredProfilePromptTemplate(request.profileRef, loaded.guide, workflowId, exactRenderedCandidates[0]),
          applyRequiredProfilePromptTemplate(request.profileRef, loaded.guide, workflowId, exactRenderedCandidates[1]),
          applyRequiredProfilePromptTemplate(request.profileRef, loaded.guide, workflowId, exactRenderedCandidates[2]),
        ],
        GuideCandidatePromptStage.FinalRendering,
      )
    } catch (cause) {
      if (cause instanceof GuideCandidatePromptCollisionError) {
        throw new GuideServiceError(cause.message, { cause })
      }
      throw cause
    }
    return { candidates: renderedCandidates }
  }
  const generated = await (request.goal === undefined
    ? cache === undefined
      ? produce()
      : cache.generation(
          {
            intent: request.intent,
            profileRef: request.profileRef,
            workflowId,
            guide: loaded.guide,
            guideBody: loaded.body,
            targetTool,
            ...(fixedFrame === undefined ? {} : { fixedFrame }),
          },
          produce,
        )
    : runGuideGoalGeneration(
        provider,
        {
          intent: request.intent,
          profileRef: request.profileRef,
          workflowId,
          guide: loaded.guide,
          guideBody: loaded.body,
          targetTool,
          goal: request.goal,
        },
        cache === undefined ? {} : { cache },
      ))
  const renderedCandidates = assertTriple(generated.candidates, "cached generation prompt candidates")
  const candidates = assertTriple(
    renderedCandidates.map(
      (candidate): GuidePromptCandidate => ({
        title: candidate.title,
        prompt: candidate.prompt,
        notes: candidate.notes,
        command: publicGuideLaunchCommand(catalog, request.profileRef, candidate.prompt, workflowId, candidate.goalExecution),
        ...(candidate.goalExecution === undefined ? {} : { goalExecution: goalPolicySummary(candidate.goalExecution.controller) }),
      }),
    ),
    "generation prompt candidates",
  )

  return {
    schemaVersion: 1,
    phase: GuidePhase.Generation,
    intent: request.intent,
    model: request.model,
    effort: request.effort,
    profile,
    candidates,
  }
}

// ---------------------------------------------------------------------------
// Deterministic literal fallbacks for a future TUI. Never call a model.
// ---------------------------------------------------------------------------

export interface LiteralGuideCandidate {
  readonly profileRef: string
  readonly workflowId: string
  readonly confidence: number
  readonly reason: string
  readonly tradeoff: string
  readonly goalExecution?: GuideGoalPolicySummary
}

const profileTokenOverlapScore = (
  entry: GuideMatchCatalogEntry,
  intentTokens: ReadonlySet<string>,
  normalizedIntent: string,
): {
  readonly score: number
  readonly explicitIdentity: boolean
  readonly identitySignals: string
} => {
  const identityAliases =
    entry.launcher === undefined
      ? [entry.ref, `sandbox/${entry.name}`, `sandbox ${entry.name}`]
      : [entry.ref, `${entry.launcher}/${entry.name}`, `${entry.launcher} ${entry.name}`]
  const identitySignals = [...identityAliases, entry.name, entry.launcher ?? "", entry.harness ?? ""].join(" ")
  const boundedIntent = ` ${normalizedIntent} `
  const explicitIdentity = identityAliases.some((alias) => {
    const normalizedAlias = normalizeIdentityPhrase(alias)
    return normalizedAlias.length > 0 && boundedIntent.includes(` ${normalizedAlias} `)
  })
  const description = normalizedTokenOverlapScore(entry.description, intentTokens)
  const capabilities = normalizedTokenOverlapScore(entry.guide.capabilities.join(" "), intentTokens)
  const bestFor = normalizedTokenOverlapScore(entry.guide.bestFor.join(" "), intentTokens)
  const identity = normalizedTokenOverlapScore(identitySignals, intentTokens)
  return {
    score: identity * 0.25 + (explicitIdentity ? 2 : 0) + description * 0.15 + capabilities * 0.1 + bestFor * 0.2,
    explicitIdentity,
    identitySignals,
  }
}

const bestWorkflowForEntry = (
  workflows: ReadonlyArray<CompactProfileGuideWorkflow>,
  intentTokens: ReadonlySet<string>,
): { readonly id: string; readonly score: number } => {
  let best: { readonly id: string; readonly score: number } | undefined
  for (const workflow of workflows) {
    const score = workflowTokenOverlapScore(workflow, intentTokens)
    if (best === undefined || score > best.score) best = { id: workflow.id, score }
  }
  if (best === undefined) throw new GuideServiceError("Profile guide has no workflows to rank")
  return best
}

interface ScoredGuideEntry {
  readonly entry: GuideMatchCatalogEntry
  readonly workflowId: string
  readonly score: number
  readonly matchedTerms: number
  readonly explicitIdentity: boolean
  readonly index: number
}

const scoreGuideMatchEntries = (
  entries: ReadonlyArray<GuideMatchCatalogEntry>,
  intent: string,
  explicitIntent = intent,
): ReadonlyArray<ScoredGuideEntry> => {
  const intentTokens = tokenize(intent)
  const normalizedIntent = normalizeIdentityPhrase(explicitIntent)
  return entries
    .map((entry, index): ScoredGuideEntry => {
      const bestWorkflow = bestWorkflowForEntry(entry.guide.workflows, intentTokens)
      const workflow = entry.guide.workflows.find(({ id }) => id === bestWorkflow.id)
      if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${bestWorkflow.id}`)
      const profileScore = profileTokenOverlapScore(entry, intentTokens, normalizedIntent)
      const matchedTerms = tokenOverlapCount(
        tokenize(
          [
            profileScore.identitySignals,
            entry.description,
            ...entry.guide.capabilities,
            ...entry.guide.bestFor,
            workflow.id,
            workflow.description,
            ...workflow.examples,
          ].join(" "),
        ),
        intentTokens,
      )
      return {
        entry,
        workflowId: bestWorkflow.id,
        score: profileScore.score + bestWorkflow.score * 0.55,
        matchedTerms,
        explicitIdentity: profileScore.explicitIdentity,
        index,
      }
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
}

const pinnedGuideProfileRefs: ReadonlySet<string> = new Set([
  "native:cpx/hve",
  "sandbox:claude-council",
  "sandbox:claude-research",
])

const crossCuttingGuideProfileRefs: ReadonlyArray<string> = ["native:cdx/pstack", "sandbox:headlong"]
const guideMatchPrefilterTarget = 12
const lowSignalMatchedTermMaximum = 2

const goalMatchIntent = (goal: PreparedGuideGoal): string =>
  [goal.draft.artifact, goal.draft.task, ...goal.draft.criteria].join("\n")

const compatibleGoalWorkflows = (
  guide: ProfileGuideV1,
  goal: PreparedGuideGoal,
): { readonly workflows: ReadonlyArray<ProfileGuideWorkflow>; readonly reason: string } => {
  const workflows: ProfileGuideWorkflow[] = []
  const reasons: string[] = []
  for (const workflow of guide.workflows) {
    try {
      resolveGuideGoalExecution(goal, guide, workflow.id)
      workflows.push(workflow)
    } catch (error) {
      if (!(error instanceof GuideGoalError || error instanceof GuideValidationError)) throw error
      reasons.push(error.message)
    }
  }
  return {
    workflows,
    reason: reasons[0] ?? "The profile has no supported workflow for this goal.",
  }
}

const goalMatchCatalog = (catalog: CombinedGuideCatalog, intent: string, goal: PreparedGuideGoal) => {
  assertPreparedGuideGoal(goal)
  const fullEntries = guideCatalogEntries(catalog)
  const identityIntent = `${intent}\n${goalMatchIntent(goal)}`
  const knownRefs = new Set(fullEntries.map(({ ref }) => ref))
  for (const match of identityIntent.matchAll(/\b(?:native:[a-z0-9-]+\/[a-z0-9._-]+|sandbox:[a-z0-9._-]+)\b/giu)) {
    if (!knownRefs.has(match[0].toLocaleLowerCase("en"))) {
      throw new GuideServiceError(`Unknown explicitly requested goal profile: ${match[0]}`)
    }
  }
  const normalizedIntent = normalizeIdentityPhrase(identityIntent)
  const entries: GuideMatchCatalogEntry[] = []
  const explicitProfileRefs: string[] = []
  const framing: Array<{
    readonly ref: string
    readonly controller: ProfileGuideGoalController
    readonly workflows: ReadonlyArray<ProfileGuideWorkflow>
  }> = []
  for (const entry of fullEntries) {
    const compact = toGuideMatchCatalogEntry(entry, true)
    const explicit = profileTokenOverlapScore(compact, new Set(), normalizedIntent).explicitIdentity
    const compatibility = compatibleGoalWorkflows(entry.guide, goal)
    const policy = entry.guide.goalExecution
    if (policy === undefined || compatibility.workflows.length === 0) {
      if (explicit) {
        throw new GuideServiceError(`Explicit profile ${entry.ref} cannot execute this goal: ${compatibility.reason}`)
      }
      continue
    }
    const ids = new Set(compatibility.workflows.map(({ id }) => id))
    entries.push({
      ...compact,
      goalExecution: { controller: policy.controller, workflowIds: [...ids] },
      guide: { ...compact.guide, workflows: compact.guide.workflows.filter(({ id }) => ids.has(id)) },
    })
    if (explicit) explicitProfileRefs.push(entry.ref)
    framing.push({ ref: entry.ref, controller: policy.controller, workflows: compatibility.workflows })
  }
  if (entries.length === 0) {
    throw new GuideServiceError(
      "No goal-compatible workflows are available. Choose a declared goal controller that can fit the complete objective.",
    )
  }
  if (explicitProfileRefs.length > 5) {
    throw new GuideServiceError("A goal can recommend at most five explicitly selected profiles.")
  }
  return { entries, framing, explicitProfileRefs }
}

const prefilterMatchEntries = (
  entries: ReadonlyArray<GuideMatchCatalogEntry>,
  intent: string,
  goalIdentityIntent?: string,
): ReadonlyArray<GuideMatchCatalogEntry> => {
  if (entries.length <= guideMatchPrefilterTarget) return entries

  const ranked = scoreGuideMatchEntries(
    entries,
    intent,
    goalIdentityIntent === undefined ? intent : `${goalIdentityIntent}\n${intent}`,
  )
  const explicitProfileRefs = new Set(
    ranked.filter(({ explicitIdentity }) => explicitIdentity).map(({ entry }) => entry.ref),
  )
  if (explicitProfileRefs.size === 0 && (ranked[0]?.matchedTerms ?? 0) <= lowSignalMatchedTermMaximum) return entries

  const crossCutting = goalIdentityIntent === undefined
    ? crossCuttingGuideProfileRefs.filter((profileRef) => entries.some(({ ref }) => ref === profileRef))
    : []
  const retainedProfileRefs = new Set([...explicitProfileRefs, ...crossCutting])
  for (const item of ranked) {
    if (retainedProfileRefs.size >= guideMatchPrefilterTarget) break
    if (!pinnedGuideProfileRefs.has(item.entry.ref) || item.explicitIdentity) {
      retainedProfileRefs.add(item.entry.ref)
    }
  }
  return entries.filter(({ ref }) => retainedProfileRefs.has(ref))
}

/**
 * Reduces a large match catalog before model ranking. Exact identities and the
 * two model-prompt cross-cutting profiles are retained. Low-signal intents keep
 * the full catalog because lexical ordering would be arbitrary.
 */
export const prefilterGuideMatchCatalogEntries = (
  catalog: CombinedGuideCatalog,
  intent: string,
  goal?: PreparedGuideGoal,
): ReadonlyArray<GuideMatchCatalogEntry> => {
  return goal === undefined
    ? prefilterMatchEntries(guideMatchCatalogEntries(catalog), intent)
    : prefilterMatchEntries(goalMatchCatalog(catalog, intent, goal).entries, goalMatchIntent(goal), intent)
}

/**
 * Deterministic, model-free ranking of up to five known catalog profiles
 * by normalized token overlap between `intent` and each profile's
 * identity/description/capabilities/bestFor and its best-matching workflow's
 * id/description/examples. Explicit profile identities take priority. Stable
 * source-order tie-break; distinct refs; confidence bounded to `[0, 1]`.
 */
export const literalGuideMatch = (
  catalog: CombinedGuideCatalog,
  intent: string,
  goal?: PreparedGuideGoal,
): ReadonlyArray<LiteralGuideCandidate> => {
  const goalCatalog = goal === undefined ? undefined : goalMatchCatalog(catalog, intent, goal)
  const entries = (goalCatalog?.entries ?? guideMatchCatalogEntries(catalog)).filter(
    ({ ref }) => !pinnedGuideProfileRefs.has(ref) || goalCatalog?.explicitProfileRefs.includes(ref),
  )
  if (goal === undefined && entries.length < 3) {
    throw new GuideServiceError(`Catalog must contain at least 3 profiles to rank literally: got ${entries.length}`)
  }
  if (entries.length === 0) {
    throw new GuideServiceError("No goal-compatible execution profiles are available. Research lenses cannot execute this goal.")
  }
  const rankingIntent = goal === undefined ? intent : goalMatchIntent(goal)
  const top = scoreGuideMatchEntries(entries, rankingIntent, `${intent}\n${rankingIntent}`).slice(0, 5)
  const maxScore = Math.max(1, ...top.map((item) => item.score))
  const candidates = top.map(
    (item): LiteralGuideCandidate => ({
      profileRef: item.entry.ref,
      workflowId: item.workflowId,
      confidence: item.score / maxScore,
      reason: item.explicitIdentity
        ? `The intent explicitly names ${item.entry.ref}; its "${item.workflowId}" workflow is the closest fit.`
        : item.matchedTerms > 0
          ? `Matches ${item.matchedTerms} intent term(s) across normalized profile signals and the "${item.workflowId}" workflow.`
          : goal === undefined
            ? `No strong term overlap with "${intent}" was found; offered as a fallback candidate.`
            : "No strong objective term overlap was found; this workflow declares a compatible goal controller.",
      tradeoff: item.entry.guide.avoidFor[0] ?? "No specific tradeoffs recorded for this profile.",
      ...(goal === undefined || item.entry.goalExecution === undefined
        ? {}
        : { goalExecution: goalPolicySummary(item.entry.goalExecution.controller) }),
    }),
  )
  return assertRecommendationSet(candidates, "literal match candidates", goal)
}

/**
 * Deterministic, model-free prompt candidates derived from the profile's
 * authored `promptTemplate` for `workflowId`, with every `{{intent}}`
 * placeholder replaced. Produces exactly three distinct, provider-shaped
 * candidates without inventing commands or profile features. Structured
 * sections stay inside bodies for command suffixes and empty suffixes. Prose
 * suffixes receive concise inline constraints before the exact authored text.
 * This is a user-triggered fallback only; it is never called automatically by
 * `runGuideGenerate`.
 */
export const templatePromptCandidates = (
  guide: ProfileGuideV1,
  workflowId: string,
  intent: string,
  goal?: PreparedGuideGoal,
): readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate] => {
  if (goal !== undefined) return templateGuideGoalCandidates(guide, workflowId, goal)
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${workflowId}`)
  const frame = workflowPromptFrame(workflow)
  const authorizedBody = workflowAuthorizationBody(workflow, intent)
  const renderBody = (body: string): string => `${frame.beforeBody}${body}${frame.afterBody}`
  const suffixStartsWithPunctuation = /^\s*[\p{P}\p{S}]/u.test(frame.afterBody)
  const appendInlineConstraint = (body: string, constraint: string): string => {
    const trimmedBody = body.trimEnd()
    const trailingWhitespace = body.slice(trimmedBody.length)
    const startsNewSentence = /[.!?]["')\]]*$/u.test(trimmedBody)
    const clause = startsNewSentence ? `${constraint.slice(0, 1).toUpperCase()}${constraint.slice(1)}` : constraint
    const separator = trimmedBody.length === 0 ? "" : startsNewSentence ? " " : "; "
    const terminator = suffixStartsWithPunctuation ? "" : "."
    return `${trimmedBody}${separator}${clause}${terminator}${trailingWhitespace}`
  }
  const scopeSection = "\n\n## Scope\n\nLimit the change to the smallest reasonable scope."
  const completionSection =
    "\n\n## Completion\n\nAfter completing the work, verify it and report the verification evidence."
  const scopeConstraint = "keep the work within the smallest reasonable scope"
  const completionConstraint = "after completing the work, verify it and report the verification evidence"
  const enhancedBody = (body: string, section: string, constraint: string): string =>
    frame.afterBody.length > 0 && !workflowHasAuthoredCommandSuffix(workflow)
      ? appendInlineConstraint(body, constraint)
      : `${body}${section}`
  const candidates: ReadonlyArray<GuideGenerateCandidate> = [
    {
      title: "Direct",
      prompt: renderBody(authorizedBody),
      notes: "Uses the profile's authored prompt template in a focused Markdown document.",
    },
    {
      title: "Scoped",
      prompt: renderBody(enhancedBody(authorizedBody, scopeSection, scopeConstraint)),
      notes: "Adds an explicit scope constraint to the authored template.",
    },
    {
      title: "Verified",
      prompt: renderBody(enhancedBody(authorizedBody, completionSection, completionConstraint)),
      notes: "Adds an explicit verification request to the authored template.",
    },
  ]
  const prompts = candidates.map(({ prompt }) => prompt)
  if (new Set(prompts).size !== prompts.length) {
    throw new GuideServiceError("Template prompt candidates must be distinct")
  }
  return assertTriple(candidates, "template prompt candidates")
}
