import type { CompositionCatalog, CompositionCatalogEntry, HeadlessCapabilitiesV1 } from "./composition-catalog.ts"
export type { HeadlessCapabilitiesV1 } from "./composition-catalog.ts"
/**
 * Validation and compact matching projections for authored profile guides.
 * The launchable rows themselves come from `loadCompositionCatalog`.
 */
import {
  isLaunchAgentIdentifier,
  parseProfileGuideInteraction,
  type ProfileGuideInteraction,
  isProfileGuideGoalController,
  profileGuideGoalExecutionProblem,
  type ProfileGuideGoalExecution,
  type ProfileGuideIdentity,
  type ProfileGuidePrerequisite,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
} from "@trellage/guide-core"
import {
  array,
  boolean,
  exactKeys,
  fail,
  literal,
  portableIdentifierPattern,
  record,
  stringArray,
  text,
  uniqueArray,
} from "./guide-text.ts"

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const identifier = (value: unknown, path: string): string => {
  const result = text(value, path, 128)
  if (!identifierPattern.test(result)) fail(path, "must be a lowercase kebab-case identifier")
  return result
}

const identifierArray = (
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximumItems?: number },
): ReadonlyArray<string> => {
  const items = array(value, path, {
    ...(options.minimum === undefined ? {} : { minimum: options.minimum }),
    maximum: options.maximumItems ?? 64,
  }).map((item, index) => identifier(item, `${path}[${index}]`))
  return uniqueArray(items, path, "entries")
}

const nullableText = (value: unknown, path: string, maximum: number): string | null => {
  if (value === null) return null
  return text(value, path, maximum)
}


// ---------------------------------------------------------------------------
// Profile guide (parsed JSON, not Markdown+frontmatter): re-validates the
// shape independently of `trellage-guide-core`'s Markdown parser, since the
// catalog carries already-projected `guide` objects, not source documents.
// ---------------------------------------------------------------------------

const validatePrerequisite = (value: unknown, path: string): ProfileGuidePrerequisite => {
  const fields = record(value, path)
  exactKeys(fields, path, ["id", "description"])
  return {
    id: identifier(fields.id, `${path}.id`),
    description: text(fields.description, `${path}.description`, 1000),
  }
}

const placeholderPattern = /\{\{([^{}]+)\}\}/gu

const validateWorkflowInvocation = (
  fields: Record<string, unknown>,
  path: string,
): Pick<ProfileGuideWorkflow, "skill" | "launchAgent" | "interaction"> => {
  const skill =
    fields.skill === undefined ? undefined : text(fields.skill, `${path}.skill`, 256).toLocaleLowerCase("en")
  if (skill !== undefined && !portableIdentifierPattern.test(skill)) {
    fail(`${path}.skill`, "must be a portable skill or command identifier")
  }
  const launchAgent =
    fields.launchAgent === undefined ? undefined : text(fields.launchAgent, `${path}.launchAgent`, 128)
  if (launchAgent !== undefined && !isLaunchAgentIdentifier(launchAgent)) {
    fail(`${path}.launchAgent`, "must be a portable agent identifier")
  }
  const interaction = fields.interaction === undefined
    ? undefined
    : parseProfileGuideInteraction(fields.interaction, `${path}.interaction`)
  if (interaction !== undefined && launchAgent === undefined) fail(`${path}.interaction`, "requires launchAgent")
  return {
    ...(skill === undefined ? {} : { skill }),
    ...(launchAgent === undefined ? {} : { launchAgent }),
    ...(interaction === undefined ? {} : { interaction }),
  }
}

const validateWorkflow = (value: unknown, path: string): ProfileGuideWorkflow => {
  const fields = record(value, path)
  exactKeys(fields, path, ["id", "description", "examples", "promptTemplate"], ["skill", "launchAgent", "interaction", "frame"])
  const invocation = validateWorkflowInvocation(fields, path)
  const promptTemplate = text(fields.promptTemplate, `${path}.promptTemplate`, 16000, { multiline: true })
  const intentPlaceholderCount = promptTemplate.split("{{intent}}").length - 1
  if (intentPlaceholderCount === 0) {
    fail(`${path}.promptTemplate`, "must contain the {{intent}} placeholder")
  }
  if (intentPlaceholderCount > 1) {
    fail(`${path}.promptTemplate`, "must contain exactly one {{intent}} placeholder")
  }
  for (const match of promptTemplate.matchAll(placeholderPattern)) {
    if (match[1] !== "intent") {
      fail(`${path}.promptTemplate`, `contains unsupported placeholder: {{${match[1]}}}`)
    }
  }
  return {
    id: identifier(fields.id, `${path}.id`),
    description: text(fields.description, `${path}.description`, 2000),
    ...invocation,
    ...(fields.frame === undefined ? {} : { frame: literal(fields.frame, `${path}.frame`, ["fixed"]) }),
    examples: stringArray(fields.examples, `${path}.examples`, { minimum: 2, maximumItems: 32, itemMaximum: 2000 }),
    promptTemplate,
  }
}

const validateGoalExecution = (
  value: unknown,
  path: string,
  workflows: ReadonlyArray<ProfileGuideWorkflow>,
  context?: { readonly identity: ProfileGuideIdentity; readonly harness: string },
): ProfileGuideGoalExecution => {
  const fields = record(value, path)
  exactKeys(fields, path, ["controller", "workflowIds"])
  if (!isProfileGuideGoalController(fields.controller)) {
    return fail(`${path}.controller`, "must be one of: codex-goal, claude-goal")
  }
  const execution: ProfileGuideGoalExecution = {
    controller: fields.controller,
    workflowIds: identifierArray(fields.workflowIds, `${path}.workflowIds`, { minimum: 1, maximumItems: 32 }),
  }
  const problem = profileGuideGoalExecutionProblem(execution, workflows, context?.identity, context?.harness)
  if (problem !== undefined) fail(path, problem)
  return execution
}

export const validateProfileGuideV1 = (
  value: unknown,
  path: string,
  context?: { readonly identity: ProfileGuideIdentity; readonly harness: string },
): ProfileGuideV1 => {
  const fields = record(value, path)
  exactKeys(
    fields,
    path,
    ["schemaVersion", "capabilities", "bestFor", "avoidFor", "prerequisites", "workflows"],
    ["goalExecution"],
  )
  if (fields.schemaVersion !== 1) fail(`${path}.schemaVersion`, "must equal 1")
  const prerequisites = array(fields.prerequisites, `${path}.prerequisites`, { maximum: 32 }).map((item, index) =>
    validatePrerequisite(item, `${path}.prerequisites[${index}]`),
  )
  uniqueArray(
    prerequisites.map(({ id }) => id),
    `${path}.prerequisites`,
    "prerequisite IDs",
  )
  const workflows = array(fields.workflows, `${path}.workflows`, { minimum: 1, maximum: 32 }).map((item, index) =>
    validateWorkflow(item, `${path}.workflows[${index}]`),
  )
  if (context !== undefined && workflows.some(({ interaction }) => interaction !== undefined) &&
      (context.identity.harness !== "copilot" || context.identity.profile !== "hve" || context.harness !== "copilot")) {
    fail(`${path}.workflows`, "interactive workflow checks currently require native:copilot/hve")
  }
  uniqueArray(
    workflows.map(({ id }) => id),
    `${path}.workflows`,
    "workflow IDs",
  )
  const goalExecution =
    fields.goalExecution === undefined
      ? undefined
      : validateGoalExecution(fields.goalExecution, `${path}.goalExecution`, workflows, context)
  return {
    schemaVersion: 1,
    capabilities: identifierArray(fields.capabilities, `${path}.capabilities`, { minimum: 1, maximumItems: 64 }),
    bestFor: stringArray(fields.bestFor, `${path}.bestFor`, { minimum: 2, maximumItems: 32, itemMaximum: 2000 }),
    avoidFor: stringArray(fields.avoidFor, `${path}.avoidFor`, { minimum: 2, maximumItems: 32, itemMaximum: 2000 }),
    prerequisites,
    workflows,
    ...(goalExecution === undefined ? {} : { goalExecution }),
  }
}

// ---------------------------------------------------------------------------
// Headless capability contract: mirrors
// `prototypes/trellage-router/bin/trx`'s `validHeadless` jq check.
// ---------------------------------------------------------------------------


const headlessKeys = [
  "changedFiles",
  "cost",
  "effortOverride",
  "eventContract",
  "modelOverride",
  "outputFormats",
  "prompt",
  "questionToolControl",
  "resume",
  "resumeWithPrompt",
  "schemaVersion",
  "sessionId",
  "testedHarnessVersion",
  "trellageEventContract",
  "usage",
] as const

export const validateHeadlessCapabilitiesV1 = (value: unknown, path: string): HeadlessCapabilitiesV1 => {
  const fields = record(value, path)
  exactKeys(fields, path, headlessKeys)
  if (fields.schemaVersion !== 1) fail(`${path}.schemaVersion`, "must equal 1")
  const outputFormats = uniqueArray(
    array(fields.outputFormats, `${path}.outputFormats`, { maximum: 3 }).map((item, index) =>
      literal(item, `${path}.outputFormats[${index}]`, ["text", "json", "jsonl"] as const),
    ),
    `${path}.outputFormats`,
    "output formats",
  )
  return {
    schemaVersion: 1,
    prompt: boolean(fields.prompt, `${path}.prompt`),
    outputFormats,
    eventContract: nullableText(fields.eventContract, `${path}.eventContract`, 256),
    trellageEventContract:
      fields.trellageEventContract === null
        ? null
        : literal(fields.trellageEventContract, `${path}.trellageEventContract`, ["trellage-headless-v1"] as const),
    sessionId: literal(fields.sessionId, `${path}.sessionId`, ["native", "trellage", "none"] as const),
    resume: boolean(fields.resume, `${path}.resume`),
    resumeWithPrompt: boolean(fields.resumeWithPrompt, `${path}.resumeWithPrompt`),
    questionToolControl: literal(fields.questionToolControl, `${path}.questionToolControl`, [
      "hard-deny",
      "prompt-only",
      "none",
    ] as const),
    changedFiles: literal(fields.changedFiles, `${path}.changedFiles`, ["native", "git-diff", "none"] as const),
    usage: boolean(fields.usage, `${path}.usage`),
    cost: boolean(fields.cost, `${path}.cost`),
    modelOverride: boolean(fields.modelOverride, `${path}.modelOverride`),
    effortOverride: boolean(fields.effortOverride, `${path}.effortOverride`),
    testedHarnessVersion: nullableText(fields.testedHarnessVersion, `${path}.testedHarnessVersion`, 128),
  }
}


// Compact, ref-addressed projections for matching. Catalog entries contain
// parsed guide metadata, not Markdown source bodies.
// ---------------------------------------------------------------------------

export type GuideCatalogEntryRef = CompositionCatalogEntry & { readonly guide: ProfileGuideV1 }

const hasGuide = (entry: CompositionCatalogEntry): entry is GuideCatalogEntryRef => entry.guide !== null

export const guideCatalogEntries = (catalog: CompositionCatalog): ReadonlyArray<GuideCatalogEntryRef> =>
  catalog.entries.filter(hasGuide)

export const findGuideCatalogEntry = (catalog: CompositionCatalog, ref: string): GuideCatalogEntryRef | undefined =>
  guideCatalogEntries(catalog).find((entry) => entry.ref === ref)

/** A `ref -> known workflow IDs` index, used to validate model-referenced workflow IDs. */
export const guideCatalogWorkflowIndex = (catalog: CompositionCatalog): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(guideCatalogEntries(catalog).map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]))

export interface CompactProfileGuideWorkflow {
  readonly id: string
  readonly description: string
  readonly skill?: string
  readonly examples: ReadonlyArray<string>
  readonly interaction?: ProfileGuideInteraction
}

export interface CompactProfileGuide {
  readonly schemaVersion: 1
  readonly capabilities: ReadonlyArray<string>
  readonly bestFor: ReadonlyArray<string>
  readonly avoidFor: ReadonlyArray<string>
  readonly prerequisites: ReadonlyArray<ProfileGuidePrerequisite>
  readonly workflows: ReadonlyArray<CompactProfileGuideWorkflow>
}

const crossCuttingPinnedWorkflows: Readonly<Record<string, string>> = {
  "native:claude/council": "run-council-deliberation",
  "native:claude/research": "vault-backed-research",
  "native:claude/six-hats": "run-six-hats-deliberation",
  "native:copilot/hve": "rpi-agent-cycle",
}

export const taskSpecificGuideMatchEntries = (
  entries: ReadonlyArray<GuideMatchCatalogEntry>,
  preferredProfileRefs: ReadonlyArray<string> = [],
): ReadonlyArray<GuideMatchCatalogEntry> => entries.flatMap((entry) => {
  const pinned = crossCuttingPinnedWorkflows[entry.ref]
  if (pinned === undefined || preferredProfileRefs.includes(entry.ref)) return [entry]
  const workflows = entry.guide.workflows.filter(({ id }) => id !== pinned)
  return workflows.length === 0 ? [] : [{ ...entry, guide: { ...entry.guide, workflows } }]
})

/** Strips `promptTemplate` (and, structurally, any Markdown body) from a guide for model matching input. */
export const compactProfileGuide = (guide: ProfileGuideV1): CompactProfileGuide => ({
  schemaVersion: 1,
  capabilities: guide.capabilities,
  bestFor: guide.bestFor,
  avoidFor: guide.avoidFor,
  prerequisites: guide.prerequisites,
  workflows: guide.workflows.map(({ id, description, skill, examples, interaction }) => ({
    id,
    description,
    ...(skill === undefined ? {} : { skill }),
    examples,
    ...(interaction === undefined ? {} : { interaction }),
  })),
})

export interface GuideMatchCatalogEntry {
  readonly ref: string
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly kind: CompositionCatalogEntry["kind"]
  readonly headless: HeadlessCapabilitiesV1
  readonly description: string
  readonly guide: CompactProfileGuide
  readonly goalExecution?: ProfileGuideGoalExecution
}

export const toGuideMatchCatalogEntry = (
  entry: GuideCatalogEntryRef,
  includeGoalExecution = false,
): GuideMatchCatalogEntry => ({
  ref: entry.ref,
  harness: entry.harness,
  profiles: entry.profiles,
  kind: entry.kind,
  headless: entry.headless,
  description: entry.description,
  guide: compactProfileGuide(entry.guide),
  ...(includeGoalExecution && entry.guide.goalExecution !== undefined
    ? { goalExecution: entry.guide.goalExecution }
    : {}),
})

export const guideMatchCatalogEntries = (
  catalog: CompositionCatalog,
  includeGoalExecution = false,
): ReadonlyArray<GuideMatchCatalogEntry> =>
  guideCatalogEntries(catalog).map((entry) => toGuideMatchCatalogEntry(entry, includeGoalExecution))
