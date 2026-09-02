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
  ProfileGuidePrerequisite,
  ProfileGuideV1,
  ProfileGuideWorkflow,
} from "../../trellage-guide-core/dist/index.js"
import { profileGuideIdentityKey } from "../../trellage-guide-core/dist/index.js"
import {
  compactProfileGuide,
  guideCatalogEntries,
  guideMatchCatalogEntries,
  type CombinedGuideCatalog,
  type CompactProfileGuideWorkflow,
  type GuideCatalogEntryRef,
  type GuideCatalogSurface,
  type HeadlessCapabilitiesV1,
  type HerdrCompatibilityInfo,
  type NativeGuideCatalogEntry,
  type SandboxGuideCatalogEntry,
} from "./guide-catalog.js"
import {
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
import type { GuideGenerateCandidate, GuideMatchCandidate, GuideProvider } from "./guide-provider.js"
import { loadSelectedGuide } from "./guide-selected.js"
import { exactKeys, fail, literal, record, text } from "./guide-text.js"
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

const booleanFlags = new Set([helpFlag, jsonFlag, intentStdinFlag])
const valueFlags = new Set([intentFlag, profileFlag, modelFlag, effortFlag, uiVariantFlag])
const knownFlags = new Set([...booleanFlags, ...valueFlags])

interface MutableGuideArgs {
  help: boolean
  json: boolean
  intentStdin: boolean
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
}

/** Strictly parses a noninteractive `{schemaVersion:1,intent,profile?,model?,effort?}` service request. */
export const parseGuideServiceRequestJson = (source: string): GuideServiceRequest => {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return fail("request", "must contain valid JSON")
  }
  const fields = record(payload, "request")
  exactKeys(fields, "request", ["schemaVersion", "intent"], ["profile", "model", "effort"])
  if (fields.schemaVersion !== 1) fail("request.schemaVersion", "must equal 1")
  const intent = validateGuideIntent(fields.intent, "request.intent")
  const profile = fields.profile === undefined ? undefined : validateProfileRef(fields.profile, "request.profile")
  const model = fields.model === undefined ? undefined : validateModelId(fields.model, "request.model")
  const effort = fields.effort === undefined ? undefined : parseGuideEffort(fields.effort, "request.effort")
  return {
    schemaVersion: 1,
    intent,
    ...(profile === undefined ? {} : { profile }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
}

// ---------------------------------------------------------------------------
// Model/effort configuration resolution.
// ---------------------------------------------------------------------------

export const defaultGuideMatchModelId = baseDefaultGuideModelRouting.match.model
export const defaultGuideGenerateModelId = baseDefaultGuideModelRouting.generate.model
export const defaultGuideOptimizeModelId = baseDefaultGuideModelRouting.optimize.model
export const defaultGuideRefineModelId = baseDefaultGuideModelRouting.refine.model
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

const assertRecommendationSet = <T>(items: ReadonlyArray<T>, label: string): ReadonlyArray<T> => {
  if (items.length < 3 || items.length > 5) {
    throw new GuideServiceError(`${label} must contain 3 to 5 items: got ${items.length}`)
  }
  return items
}

// ---------------------------------------------------------------------------
// Match service.
// ---------------------------------------------------------------------------

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
}

const enrichRecommendation = (catalog: CombinedGuideCatalog, candidate: GuideMatchCandidate): GuideRecommendation => {
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
  }
}

/**
 * Calls `provider.match` with the compact, path-free catalog projection and
 * returns a stable DTO of three to five enriched recommendations. Never
 * exposes `commandPath`, Sandbox `path`, prompt templates, absolute paths,
 * or the full authored guide.
 */
export const runGuideMatch = async (
  provider: GuideProvider,
  catalog: CombinedGuideCatalog,
  request: GuideMatchRequest,
): Promise<GuideMatchResponse> => {
  const entries = guideMatchCatalogEntries(catalog)
  const result = await provider.match({ intent: request.intent, entries })
  const recommendations = assertRecommendationSet(
    result.candidates.map((candidate) => enrichRecommendation(catalog, candidate)),
    "match recommendations",
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

export interface PublicGuideCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly preview: string
  readonly promptHandling: PromptHandlingMode
}

/**
 * Builds the current-terminal command a user would run to launch the given
 * catalog profile with `prompt`, using the launcher alias (native) or
 * `trellage` (Sandbox) as the public executable — never the internal
 * absolute `commandPath`. Adds `-p <prompt>` only when the profile's
 * `headless.prompt` capability is true; otherwise returns the base
 * interactive command with `promptHandling: "manual-paste"`.
 */
export const publicGuideLaunchCommand = (
  catalog: CombinedGuideCatalog,
  ref: string,
  prompt: string,
): PublicGuideCommand => {
  const entry = findFullCatalogEntry(catalog, ref)
  if (entry === undefined) throw new GuideServiceError(`Unknown profile reference: ${ref}`)
  const native = isNativeEntry(entry)
  const executable = native ? entry.launcher : "trellage"
  const baseArgs = native ? [entry.name] : ["--profile", entry.name]
  const headlessPrompt = entry.headless.prompt
  const args = headlessPrompt ? [...baseArgs, "-p", prompt] : baseArgs
  const promptHandling: PromptHandlingMode = headlessPrompt ? "argv" : "manual-paste"
  const command: CommandSpec = { executable, args }
  return { executable, args, preview: renderCommandPreview(command), promptHandling }
}

/**
 * Converts a catalog reference into the validated internal `SelectedProfile`
 * used for later launch: the root `sandboxCommandPath` for Sandbox profiles,
 * the native entry's own `commandPath` for native profiles, and
 * `headless.prompt` from the catalog as `headlessPrompt`.
 */
export const selectedProfileFromCatalogRef = (catalog: CombinedGuideCatalog, ref: string): SelectedProfile => {
  const entry = findFullCatalogEntry(catalog, ref)
  if (entry === undefined) throw new GuideServiceError(`Unknown profile reference: ${ref}`)
  if (isNativeEntry(entry)) {
    return parseSelectedProfile({
      surface: "native",
      launcher: entry.launcher,
      commandPath: entry.commandPath,
      profile: entry.name,
      headlessPrompt: entry.headless.prompt,
    })
  }
  return parseSelectedProfile({
    surface: "sandbox",
    commandPath: catalog.sandboxCommandPath,
    profile: entry.name,
    headlessPrompt: entry.headless.prompt,
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
}

export interface GuidePromptCandidate {
  readonly title: string
  readonly prompt: string
  readonly notes: string
  readonly command: PublicGuideCommand
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
): GuideGenerateCandidate =>
  restoreWorkflowCandidateFrame(findGuideWorkflow(guide, workflowId), candidate)

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
 * Generates prompts for one exact profile reference. Deterministically
 * selects that profile's best workflow by token overlap with `intent`, using
 * source order as the tie-break. This avoids a second model-ranking call when
 * a caller already chose a profile from match mode. Loads only the selected
 * profile's full guide (Markdown body included), then calls `provider.generate`.
 */
export const runGuideGenerate = async (
  provider: GuideProvider,
  catalog: CombinedGuideCatalog,
  guideRoot: string,
  request: GuideGenerateRequest,
): Promise<GuideGenerationResponse> => {
  const entry = findFullCatalogEntry(catalog, request.profileRef)
  if (entry === undefined) throw new GuideServiceError(`Unknown profile reference: ${request.profileRef}`)

  const workflowId = selectBestWorkflowByTokenOverlap(entry.guide.workflows, request.intent)

  const loaded = await loadSelectedGuide(catalog, guideRoot, request.profileRef)
  const generated = await provider.generate({
    intent: request.intent,
    profileRef: request.profileRef,
    workflowId,
    guide: loaded.guide,
    guideBody: loaded.body,
  })

  const compactWorkflow = compactProfileGuide(entry.guide).workflows.find(({ id }) => id === workflowId)
  if (compactWorkflow === undefined) {
    throw new GuideServiceError(`Selected workflow is unknown for ${request.profileRef}: ${workflowId}`)
  }
  const authoredWorkflow = findGuideWorkflow(loaded.guide, workflowId)

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
  }

  let bodyCandidates: readonly [
    GuideGenerateCandidate,
    GuideGenerateCandidate,
    GuideGenerateCandidate,
  ]
  try {
    bodyCandidates = requireDistinctGuideCandidatePrompts(
      assertTriple(
        generated.candidates.map((candidate) =>
          resolveGeneratedWorkflowBodyCandidate(
            loaded.guide,
            authoredWorkflow,
            request.intent,
            candidate,
          ),
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
  const fixedFrame = workflowOptimizeFixedFrame(authoredWorkflow)
  const optimized = await provider.optimize({
    targetTool: isNativeEntry(entry) ? entry.harness : entry.harness.kind,
    profileRef: request.profileRef,
    candidates: bodyCandidates,
    ...(fixedFrame === undefined ? {} : { fixedFrame }),
  })
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
  let renderedCandidates: readonly [
    GuideGenerateCandidate,
    GuideGenerateCandidate,
    GuideGenerateCandidate,
  ]
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
        applyRequiredProfilePromptTemplate(
          request.profileRef,
          loaded.guide,
          workflowId,
          exactRenderedCandidates[0],
        ),
        applyRequiredProfilePromptTemplate(
          request.profileRef,
          loaded.guide,
          workflowId,
          exactRenderedCandidates[1],
        ),
        applyRequiredProfilePromptTemplate(
          request.profileRef,
          loaded.guide,
          workflowId,
          exactRenderedCandidates[2],
        ),
      ],
      GuideCandidatePromptStage.FinalRendering,
    )
  } catch (cause) {
    if (cause instanceof GuideCandidatePromptCollisionError) {
      throw new GuideServiceError(cause.message, { cause })
    }
    throw cause
  }
  const candidates = assertTriple(
    renderedCandidates.map(
      (candidate): GuidePromptCandidate => ({
        title: candidate.title,
        prompt: candidate.prompt,
        notes: candidate.notes,
        command: publicGuideLaunchCommand(catalog, request.profileRef, candidate.prompt),
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
}

const profileTokenOverlapScore = (
  entry: GuideCatalogEntryRef,
  intentTokens: ReadonlySet<string>,
  normalizedIntent: string,
): { readonly score: number; readonly explicitIdentity: boolean; readonly identitySignals: string } => {
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
  workflows: ReadonlyArray<ProfileGuideV1["workflows"][number]>,
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

const pinnedGuideProfileRefs: ReadonlySet<string> = new Set([
  "native:cpx/hve",
  "sandbox:claude-council",
  "sandbox:claude-research",
])

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
): ReadonlyArray<LiteralGuideCandidate> => {
  const entries = guideCatalogEntries(catalog).filter(({ ref }) => !pinnedGuideProfileRefs.has(ref))
  if (entries.length < 3) {
    throw new GuideServiceError(`Catalog must contain at least 3 profiles to rank literally: got ${entries.length}`)
  }
  const intentTokens = tokenize(intent)
  const normalizedIntent = normalizeIdentityPhrase(intent)
  const scored = entries.map((entry, index) => {
    const bestWorkflow = bestWorkflowForEntry(entry.guide.workflows, intentTokens)
    const workflow = entry.guide.workflows.find(({ id }) => id === bestWorkflow.id)
    if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${bestWorkflow.id}`)
    const profileScore = profileTokenOverlapScore(entry, intentTokens, normalizedIntent)
    const score = profileScore.score + bestWorkflow.score * 0.55
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
      score,
      matchedTerms,
      explicitIdentity: profileScore.explicitIdentity,
      index,
    }
  })
  const ranked = [...scored].sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
  const top = ranked.slice(0, 5)
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
          : `No strong term overlap with "${intent}" was found; offered as a fallback candidate.`,
      tradeoff: item.entry.guide.avoidFor[0] ?? "No specific tradeoffs recorded for this profile.",
    }),
  )
  return assertRecommendationSet(candidates, "literal match candidates")
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
): readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate] => {
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
    const clause = startsNewSentence
      ? `${constraint.slice(0, 1).toUpperCase()}${constraint.slice(1)}`
      : constraint
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
