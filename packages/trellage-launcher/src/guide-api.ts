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
import type { GuideGenerateCandidate, GuideMatchCandidate, GuideProvider } from "./guide-provider.js"
import { loadSelectedGuide } from "./guide-selected.js"
import { exactKeys, fail, literal, record, text } from "./guide-text.js"

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

const intentMaximumLength = 4000
const profileRefMaximumLength = 256
const modelIdentifierMaximumLength = 128
const modelIdentifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u

const validateIntent = (value: unknown, path: string): string => text(value, path, intentMaximumLength)

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

// ---------------------------------------------------------------------------
// Headless argv parsing.
// ---------------------------------------------------------------------------

export interface GuideHeadlessArgs {
  readonly help: boolean
  readonly json: boolean
  readonly intent: string | undefined
  readonly profile: string | undefined
  readonly model: string | undefined
  readonly effort: GuideEffort | undefined
}

const helpFlag = "--help"
const jsonFlag = "--json"
const intentFlag = "--intent"
const profileFlag = "--profile"
const modelFlag = "--model"
const effortFlag = "--effort"

const booleanFlags = new Set([helpFlag, jsonFlag])
const valueFlags = new Set([intentFlag, profileFlag, modelFlag, effortFlag])
const knownFlags = new Set([...booleanFlags, ...valueFlags])

interface MutableGuideArgs {
  help: boolean
  json: boolean
  intentFromFlag: string | undefined
  profile: string | undefined
  model: string | undefined
  effort: GuideEffort | undefined
  readonly positionals: string[]
  readonly seenFlags: Set<string>
}

const setGuideValueFlag = (state: MutableGuideArgs, token: string, value: string): void => {
  if (token === intentFlag) state.intentFromFlag = validateIntent(value, "--intent")
  else if (token === profileFlag) state.profile = validateProfileRef(value, "--profile")
  else if (token === modelFlag) state.model = validateModelId(value, "--model")
  else state.effort = parseGuideEffort(value, "--effort")
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
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new GuideArgsError(`Missing value for flag: ${token}`)
  }
  setGuideValueFlag(state, token, value)
  return index + 1
}

const finalizeGuideArgs = (state: MutableGuideArgs): GuideHeadlessArgs => {
  if (state.positionals.length > 1) throw new GuideArgsError("Only one positional intent argument is allowed")
  if (state.intentFromFlag !== undefined && state.positionals.length === 1) {
    throw new GuideArgsError("Provide intent via --intent or a positional argument, not both")
  }
  const positionalIntent = state.positionals[0]
  const intent =
    state.intentFromFlag ?? (positionalIntent === undefined ? undefined : validateIntent(positionalIntent, "intent"))
  if (state.profile !== undefined && !state.json) throw new GuideArgsError("--profile requires --json")
  return {
    help: state.help,
    json: state.json,
    intent,
    profile: state.profile,
    model: state.model,
    effort: state.effort,
  }
}

export const guideHeadlessHelpText = [
  "Usage: trx guide [intent] [options]",
  "       trx guide --json --intent <text> [options]",
  "       trx guide --json <text> [options]",
  "",
  "Options:",
  "  <intent>             Start the interactive guide with an initial intent.",
  "  --json               Emit a machine-readable JSON response.",
  "  --intent <text>       Natural-language description of the task.",
  "                         May instead be given as a single positional argument.",
  "  --profile <ref>        Generate prompts for one specific catalog profile",
  "                         reference instead of matching. Requires --json.",
  "  --model <id>            Override the configured model.",
  "  --effort <level>       Override the configured reasoning effort:",
  "                         low, medium, high, xhigh, or max.",
  "  --help                Show this help text.",
].join("\n")

/**
 * Strictly parses headless `trx guide` argv. Rejects unknown or duplicate
 * flags, flags missing a value, more than one positional argument, and
 * empty/control-containing/oversized text. `--profile` requires `--json`.
 * An omitted intent is supplied by stdin JSON mode or the interactive editor.
 */
export const parseGuideHeadlessArgv = (argv: ReadonlyArray<string>): GuideHeadlessArgs => {
  const state: MutableGuideArgs = {
    help: false,
    json: false,
    intentFromFlag: undefined,
    profile: undefined,
    model: undefined,
    effort: undefined,
    positionals: [],
    seenFlags: new Set(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
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
  const intent = validateIntent(fields.intent, "request.intent")
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

export const defaultGuideModelId = "mai-code-1.1-flash"
export const defaultGuideEffort = GuideEffort.Medium

export interface GuideModelOverrides {
  readonly model?: string
  readonly effort?: GuideEffort
}

export interface GuideModelConfig {
  readonly model: string
  readonly effort: GuideEffort
}

/** Resolves model/effort with precedence: explicit overrides (CLI/request) > environment > defaults. */
export const resolveGuideModelConfig = (
  overrides: GuideModelOverrides,
  env: Readonly<Record<string, string | undefined>> = process.env,
): GuideModelConfig => {
  const model =
    overrides.model ??
    (env.TRELLAGE_GUIDE_MODEL === undefined
      ? defaultGuideModelId
      : validateModelId(env.TRELLAGE_GUIDE_MODEL, "TRELLAGE_GUIDE_MODEL"))
  const effort =
    overrides.effort ??
    (env.TRELLAGE_GUIDE_EFFORT === undefined
      ? defaultGuideEffort
      : parseGuideEffort(env.TRELLAGE_GUIDE_EFFORT, "TRELLAGE_GUIDE_EFFORT"))
  return { model, effort }
}

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

const assertTriple = <T>(items: ReadonlyArray<T>, label: string): readonly [T, T, T] => {
  if (items.length !== 3) throw new GuideServiceError(`${label} must contain exactly 3 items: got ${items.length}`)
  const [first, second, third] = items
  if (first === undefined || second === undefined || third === undefined) {
    throw new GuideServiceError(`${label} must contain exactly 3 items`)
  }
  return [first, second, third]
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
  readonly recommendations: readonly [GuideRecommendation, GuideRecommendation, GuideRecommendation]
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
 * returns a stable DTO of exactly three enriched recommendations. Never
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
  const recommendations = assertTriple(
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
  const workflowTokens = tokenize([workflow.id, workflow.description, ...workflow.examples].join(" "))
  let score = 0
  for (const token of workflowTokens) if (intentTokens.has(token)) score += 1
  return score
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

const escapeRegularExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

const flexibleWhitespacePattern = (value: string): string =>
  value
    .split(/(\s+)/u)
    .map((part) => (/\s+/u.test(part) ? "\\s+" : escapeRegularExpression(part)))
    .join("")

const isCompleteWorkflowPrompt = (template: string, prompt: string): boolean => {
  const pattern = template
    .trim()
    .split("{{intent}}")
    .map(flexibleWhitespacePattern)
    .join("[\\s\\S]+")
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
 * Applies the selected workflow's authored skill command or skill-use
 * instruction to a model-generated prompt. Workflows without a declared skill
 * preserve the generated prompt.
 */
export const applyWorkflowPromptTemplate = (
  guide: ProfileGuideV1,
  workflowId: string,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${workflowId}`)
  if (workflow.skill === undefined) return candidate

  if (isCompleteWorkflowPrompt(workflow.promptTemplate, candidate.prompt)) return candidate
  const promptBody = removePartialTemplateBoundary(workflow.promptTemplate, candidate.prompt)

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

  const workflow = compactProfileGuide(entry.guide).workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) {
    throw new GuideServiceError(`Selected workflow is unknown for ${request.profileRef}: ${workflowId}`)
  }

  const native = isNativeEntry(entry)
  const profile: GuideSelectedProfileSummary = {
    profileRef: request.profileRef,
    workflowId,
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

  const candidates = assertTriple(
    generated.candidates.map((candidate): GuidePromptCandidate => {
      const invokedCandidate = applyWorkflowPromptTemplate(loaded.guide, workflowId, candidate)
      return {
        title: invokedCandidate.title,
        prompt: invokedCandidate.prompt,
        notes: invokedCandidate.notes,
        command: publicGuideLaunchCommand(catalog, request.profileRef, invokedCandidate.prompt),
      }
    }),
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

const profileTokenOverlapScore = (entry: GuideCatalogEntryRef, intentTokens: ReadonlySet<string>): number => {
  const profileTokens = tokenize([entry.description, ...entry.guide.capabilities, ...entry.guide.bestFor].join(" "))
  let score = 0
  for (const token of profileTokens) if (intentTokens.has(token)) score += 1
  return score
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

/**
 * Deterministic, model-free ranking of exactly three known catalog profiles
 * by normalized token overlap between `intent` and each profile's
 * description/capabilities/bestFor and its best-matching workflow's
 * id/description/examples. Stable source-order tie-break; distinct refs;
 * confidence bounded to `[0, 1]`.
 */
export const literalGuideMatch = (
  catalog: CombinedGuideCatalog,
  intent: string,
): readonly [LiteralGuideCandidate, LiteralGuideCandidate, LiteralGuideCandidate] => {
  const entries = guideCatalogEntries(catalog)
  if (entries.length < 3) {
    throw new GuideServiceError(`Catalog must contain at least 3 profiles to rank literally: got ${entries.length}`)
  }
  const intentTokens = tokenize(intent)
  const scored = entries.map((entry, index) => {
    const bestWorkflow = bestWorkflowForEntry(entry.guide.workflows, intentTokens)
    const score = profileTokenOverlapScore(entry, intentTokens) + bestWorkflow.score
    return { entry, workflowId: bestWorkflow.id, score, index }
  })
  const ranked = [...scored].sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
  const top = ranked.slice(0, 3)
  const maxScore = Math.max(1, ...top.map((item) => item.score))
  const candidates = top.map(
    (item): LiteralGuideCandidate => ({
      profileRef: item.entry.ref,
      workflowId: item.workflowId,
      confidence: item.score / maxScore,
      reason:
        item.score > 0
          ? `Shares ${item.score} matching term(s) with "${intent}" across its description, capabilities, best-fit notes, and the "${item.workflowId}" workflow.`
          : `No strong term overlap with "${intent}" was found; offered as a fallback candidate.`,
      tradeoff: item.entry.guide.avoidFor[0] ?? "No specific tradeoffs recorded for this profile.",
    }),
  )
  return assertTriple(candidates, "literal match candidates")
}

/**
 * Deterministic, model-free prompt candidates derived from the profile's
 * authored `promptTemplate` for `workflowId`, with every `{{intent}}`
 * placeholder replaced. Produces exactly three distinct, provider-shaped
 * candidates by adding conservative scope/verification requests to the
 * authored template — never inventing commands or profile features. This is
 * a user-triggered fallback only; it is never called automatically by
 * `runGuideGenerate`.
 */
export const templatePromptCandidates = (
  guide: ProfileGuideV1,
  workflowId: string,
  intent: string,
): readonly [GuideGenerateCandidate, GuideGenerateCandidate, GuideGenerateCandidate] => {
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new GuideServiceError(`Unknown workflow reference: ${workflowId}`)
  const base = workflow.promptTemplate.replaceAll("{{intent}}", intent)
  const candidates: ReadonlyArray<GuideGenerateCandidate> = [
    {
      title: "Direct",
      prompt: base,
      notes: "Uses the profile's authored prompt template as-is.",
    },
    {
      title: "Scoped",
      prompt: `${base}\n\nLimit the change to the smallest reasonable scope.`,
      notes: "Adds an explicit scope constraint to the authored template.",
    },
    {
      title: "Verified",
      prompt: `${base}\n\nAfter completing the work, verify it and report the verification evidence.`,
      notes: "Adds an explicit verification request to the authored template.",
    },
  ]
  const prompts = candidates.map(({ prompt }) => prompt)
  if (new Set(prompts).size !== prompts.length) {
    throw new GuideServiceError("Template prompt candidates must be distinct")
  }
  return assertTriple(candidates, "template prompt candidates")
}
