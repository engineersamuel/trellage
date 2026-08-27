/**
 * Strict types and parsing for the combined `trx guide` catalog: the
 * enriched native `trx list --json` profiles (with a projected `guide` field
 * added by `enrichNativeProfileList` in `native-guide-list.ts`) merged with
 * the Trellage Sandbox `trellage list --json-full` profiles, as assembled by
 * `prototypes/trellage-router/bin/trx` into a single JSON document:
 *
 * ```json
 * { "schemaVersion": 1, "sandboxCommandPath": "...", "native": [...], "sandbox": [...] }
 * ```
 *
 * Every profile gets a stable reference used throughout the guide feature:
 * `native:<launcher>/<name>` or `sandbox:<name>` (the same key format as
 * `profileGuideIdentityKey` in `trellage-guide-core`). Parsing rejects
 * duplicate refs and any guide or headless-capability shape that does not
 * match exactly. `sandboxCommandPath`, every native `commandPath`, and every
 * Sandbox profile `path` must be absolute; workflow `skill` values and
 * `promptTemplate` placeholders are validated with the same rules
 * `trellage-guide-core` applies to authored Markdown guides.
 */
import {
  profileGuideIdentityKey,
  type ProfileGuidePrerequisite,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
} from "../../trellage-guide-core/dist/index.js"
import nodePath from "node:path"
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
} from "./guide-text.js"

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

const absolutePath = (value: unknown, fieldPath: string, maximum: number): string => {
  const result = text(value, fieldPath, maximum)
  if (!nodePath.isAbsolute(result)) fail(fieldPath, "must be an absolute path")
  return result
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

const validateWorkflow = (value: unknown, path: string): ProfileGuideWorkflow => {
  const fields = record(value, path)
  exactKeys(fields, path, ["id", "description", "examples", "promptTemplate"], ["skill"])
  const skill =
    fields.skill === undefined ? undefined : text(fields.skill, `${path}.skill`, 256).toLocaleLowerCase("en")
  if (skill !== undefined && !portableIdentifierPattern.test(skill)) {
    fail(`${path}.skill`, "must be a portable skill or command identifier")
  }
  const promptTemplate = text(fields.promptTemplate, `${path}.promptTemplate`, 16000, { multiline: true })
  if (!promptTemplate.includes("{{intent}}")) {
    fail(`${path}.promptTemplate`, "must contain the {{intent}} placeholder")
  }
  for (const match of promptTemplate.matchAll(placeholderPattern)) {
    if (match[1] !== "intent") {
      fail(`${path}.promptTemplate`, `contains unsupported placeholder: {{${match[1]}}}`)
    }
  }
  return {
    id: identifier(fields.id, `${path}.id`),
    description: text(fields.description, `${path}.description`, 2000),
    ...(skill === undefined ? {} : { skill }),
    examples: stringArray(fields.examples, `${path}.examples`, { minimum: 1, maximumItems: 32, itemMaximum: 2000 }),
    promptTemplate,
  }
}

export const validateProfileGuideV1 = (value: unknown, path: string): ProfileGuideV1 => {
  const fields = record(value, path)
  exactKeys(fields, path, ["schemaVersion", "capabilities", "bestFor", "avoidFor", "prerequisites", "workflows"])
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
  uniqueArray(
    workflows.map(({ id }) => id),
    `${path}.workflows`,
    "workflow IDs",
  )
  return {
    schemaVersion: 1,
    capabilities: identifierArray(fields.capabilities, `${path}.capabilities`, { minimum: 1, maximumItems: 64 }),
    bestFor: stringArray(fields.bestFor, `${path}.bestFor`, { minimum: 1, maximumItems: 32, itemMaximum: 2000 }),
    avoidFor: stringArray(fields.avoidFor, `${path}.avoidFor`, { minimum: 1, maximumItems: 32, itemMaximum: 2000 }),
    prerequisites,
    workflows,
  }
}

// ---------------------------------------------------------------------------
// Headless capability contract: identical field set on both native and
// Sandbox surfaces (`prototypes/trellage-router/bin/trx`'s `validHeadless`
// jq check and `packages/trellage-cli/src/headless-capabilities.ts`'s
// `HeadlessCapabilitiesV1Schema`).
// ---------------------------------------------------------------------------

export interface HeadlessCapabilitiesV1 {
  readonly schemaVersion: 1
  readonly prompt: boolean
  readonly outputFormats: ReadonlyArray<"text" | "json" | "jsonl">
  readonly eventContract: string | null
  readonly trellageEventContract: "trellage-headless-v1" | null
  readonly sessionId: "native" | "trellage" | "none"
  readonly resume: boolean
  readonly resumeWithPrompt: boolean
  readonly questionToolControl: "hard-deny" | "prompt-only" | "none"
  readonly changedFiles: "native" | "git-diff" | "none"
  readonly usage: boolean
  readonly cost: boolean
  readonly modelOverride: boolean
  readonly effortOverride: boolean
  readonly testedHarnessVersion: string | null
}

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

// ---------------------------------------------------------------------------
// Herdr compatibility: curated, hand-maintained ledger data. The native and
// Sandbox surfaces project different extra fields (e.g. native keeps `kind`
// and `harness` from `docs/herdr-compatibility.json`), so this is validated
// loosely — a `status` string is required, everything else passes through.
// ---------------------------------------------------------------------------

export interface HerdrCompatibilityInfo {
  readonly status: string
  readonly [key: string]: unknown
}

const validateHerdrCompatibility = (value: unknown, path: string): HerdrCompatibilityInfo => {
  const fields = record(value, path)
  text(fields.status, `${path}.status`, 64)
  return fields as HerdrCompatibilityInfo
}

// ---------------------------------------------------------------------------
// Native and Sandbox catalog entries.
// ---------------------------------------------------------------------------

export interface NativeGuideCatalogEntry {
  readonly launcher: string
  readonly harness: string
  readonly name: string
  readonly description: string
  readonly headless: HeadlessCapabilitiesV1
  readonly sandbox: boolean
  readonly herdrCompatibility: HerdrCompatibilityInfo
  readonly guide: ProfileGuideV1
  readonly commandPath: string
}

const validateNativeEntry = (value: unknown, path: string): NativeGuideCatalogEntry => {
  const fields = record(value, path)
  exactKeys(fields, path, [
    "launcher",
    "harness",
    "name",
    "description",
    "headless",
    "sandbox",
    "herdrCompatibility",
    "guide",
    "commandPath",
  ])
  return {
    launcher: identifier(fields.launcher, `${path}.launcher`),
    harness: identifier(fields.harness, `${path}.harness`),
    name: identifier(fields.name, `${path}.name`),
    description: text(fields.description, `${path}.description`, 2000),
    headless: validateHeadlessCapabilitiesV1(fields.headless, `${path}.headless`),
    sandbox: boolean(fields.sandbox, `${path}.sandbox`),
    herdrCompatibility: validateHerdrCompatibility(fields.herdrCompatibility, `${path}.herdrCompatibility`),
    guide: validateProfileGuideV1(fields.guide, `${path}.guide`),
    commandPath: absolutePath(fields.commandPath, `${path}.commandPath`, 4096),
  }
}

export interface SandboxGuideCatalogEntry {
  readonly name: string
  readonly description: string
  readonly guide: ProfileGuideV1
  readonly path: string
  readonly supportedPlatforms: ReadonlyArray<string>
  readonly harness: {
    readonly kind: string
    readonly version: string
    readonly model?: string
  }
  readonly skillBundles: ReadonlyArray<string>
  readonly skillsMode: "floating" | "locked"
  readonly finalDigestLocked: boolean
  readonly skills: ReadonlyArray<Record<string, unknown>>
  readonly plugins: ReadonlyArray<Record<string, unknown>>
  readonly mcps: ReadonlyArray<Record<string, unknown>>
  readonly sandbox: true
  readonly headless: HeadlessCapabilitiesV1
  readonly locked: boolean
  readonly herdrCompatibility: HerdrCompatibilityInfo
}

const validateSandboxEntry = (value: unknown, path: string): SandboxGuideCatalogEntry => {
  const fields = record(value, path)
  exactKeys(fields, path, [
    "name",
    "description",
    "guide",
    "path",
    "supportedPlatforms",
    "harness",
    "skillBundles",
    "skillsMode",
    "finalDigestLocked",
    "skills",
    "plugins",
    "mcps",
    "sandbox",
    "headless",
    "locked",
    "herdrCompatibility",
  ])
  if (fields.sandbox !== true) fail(`${path}.sandbox`, "must equal true")
  const harness = record(fields.harness, `${path}.harness`)
  exactKeys(harness, `${path}.harness`, ["kind", "version"], ["model"])
  return {
    name: identifier(fields.name, `${path}.name`),
    description: text(fields.description, `${path}.description`, 2000),
    guide: validateProfileGuideV1(fields.guide, `${path}.guide`),
    path: absolutePath(fields.path, `${path}.path`, 4096),
    supportedPlatforms: stringArray(fields.supportedPlatforms, `${path}.supportedPlatforms`, {
      minimum: 1,
      maximumItems: 16,
      itemMaximum: 64,
    }),
    harness: {
      kind: identifier(harness.kind, `${path}.harness.kind`),
      version: text(harness.version, `${path}.harness.version`, 128),
      ...(harness.model === undefined ? {} : { model: text(harness.model, `${path}.harness.model`, 128) }),
    },
    skillBundles: stringArray(fields.skillBundles, `${path}.skillBundles`, { maximumItems: 64, itemMaximum: 128 }),
    skillsMode: literal(fields.skillsMode, `${path}.skillsMode`, ["floating", "locked"] as const),
    finalDigestLocked: boolean(fields.finalDigestLocked, `${path}.finalDigestLocked`),
    skills: array(fields.skills, `${path}.skills`, { maximum: 256 }).map((item, index) =>
      record(item, `${path}.skills[${index}]`),
    ),
    plugins: array(fields.plugins, `${path}.plugins`, { maximum: 64 }).map((item, index) =>
      record(item, `${path}.plugins[${index}]`),
    ),
    mcps: array(fields.mcps, `${path}.mcps`, { maximum: 64 }).map((item, index) =>
      record(item, `${path}.mcps[${index}]`),
    ),
    sandbox: true,
    headless: validateHeadlessCapabilitiesV1(fields.headless, `${path}.headless`),
    locked: boolean(fields.locked, `${path}.locked`),
    herdrCompatibility: validateHerdrCompatibility(fields.herdrCompatibility, `${path}.herdrCompatibility`),
  }
}

// ---------------------------------------------------------------------------
// Combined catalog.
// ---------------------------------------------------------------------------

export interface CombinedGuideCatalog {
  readonly schemaVersion: 1
  readonly sandboxCommandPath: string
  readonly native: ReadonlyArray<NativeGuideCatalogEntry>
  readonly sandbox: ReadonlyArray<SandboxGuideCatalogEntry>
}

export const parseGuideCatalog = (source: string): CombinedGuideCatalog => {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    fail("catalog", "must contain valid JSON")
  }
  const root = record(payload, "catalog")
  exactKeys(root, "catalog", ["schemaVersion", "sandboxCommandPath", "native", "sandbox"])
  if (root.schemaVersion !== 1) fail("catalog.schemaVersion", "must equal 1")
  const sandboxCommandPath = absolutePath(root.sandboxCommandPath, "catalog.sandboxCommandPath", 4096)
  const native = array(root.native, "catalog.native", { maximum: 512 }).map((item, index) =>
    validateNativeEntry(item, `catalog.native[${index}]`),
  )
  const sandbox = array(root.sandbox, "catalog.sandbox", { maximum: 512 }).map((item, index) =>
    validateSandboxEntry(item, `catalog.sandbox[${index}]`),
  )
  const refs = [
    ...native.map((entry) =>
      profileGuideIdentityKey({ surface: "native", launcher: entry.launcher, profile: entry.name }),
    ),
    ...sandbox.map((entry) => profileGuideIdentityKey({ surface: "sandbox", profile: entry.name })),
  ]
  uniqueArray(refs, "catalog", "profile refs")
  return { schemaVersion: 1, sandboxCommandPath, native, sandbox }
}

// ---------------------------------------------------------------------------
// Normalized, ref-addressed entries and the compact projection used for
// matching (guide metadata without `promptTemplate` or the Markdown body —
// the body is never present on catalog entries in the first place, since
// `enrichNativeProfileList` and `toFullList`/`toSimplifiedList` only project
// the parsed `guide`, never the source document).
// ---------------------------------------------------------------------------

export type GuideCatalogSurface = "native" | "sandbox"

export interface GuideCatalogEntryRef {
  readonly ref: string
  readonly surface: GuideCatalogSurface
  readonly name: string
  readonly launcher?: string
  readonly harness?: string
  readonly description: string
  readonly sandbox: boolean
  readonly guide: ProfileGuideV1
}

export const guideCatalogEntries = (catalog: CombinedGuideCatalog): ReadonlyArray<GuideCatalogEntryRef> => [
  ...catalog.native.map(
    (entry): GuideCatalogEntryRef => ({
      ref: profileGuideIdentityKey({ surface: "native", launcher: entry.launcher, profile: entry.name }),
      surface: "native",
      name: entry.name,
      launcher: entry.launcher,
      harness: entry.harness,
      description: entry.description,
      sandbox: entry.sandbox,
      guide: entry.guide,
    }),
  ),
  ...catalog.sandbox.map(
    (entry): GuideCatalogEntryRef => ({
      ref: profileGuideIdentityKey({ surface: "sandbox", profile: entry.name }),
      surface: "sandbox",
      name: entry.name,
      harness: entry.harness.kind,
      description: entry.description,
      sandbox: entry.sandbox,
      guide: entry.guide,
    }),
  ),
]

export const findGuideCatalogEntry = (catalog: CombinedGuideCatalog, ref: string): GuideCatalogEntryRef | undefined =>
  guideCatalogEntries(catalog).find((entry) => entry.ref === ref)

/** A `ref -> known workflow IDs` index, used to validate model-referenced workflow IDs. */
export const guideCatalogWorkflowIndex = (catalog: CombinedGuideCatalog): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(guideCatalogEntries(catalog).map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]))

export interface CompactProfileGuideWorkflow {
  readonly id: string
  readonly description: string
  readonly skill?: string
  readonly examples: ReadonlyArray<string>
}

export interface CompactProfileGuide {
  readonly schemaVersion: 1
  readonly capabilities: ReadonlyArray<string>
  readonly bestFor: ReadonlyArray<string>
  readonly avoidFor: ReadonlyArray<string>
  readonly prerequisites: ReadonlyArray<ProfileGuidePrerequisite>
  readonly workflows: ReadonlyArray<CompactProfileGuideWorkflow>
}

/** Strips `promptTemplate` (and, structurally, any Markdown body) from a guide for model matching input. */
export const compactProfileGuide = (guide: ProfileGuideV1): CompactProfileGuide => ({
  schemaVersion: 1,
  capabilities: guide.capabilities,
  bestFor: guide.bestFor,
  avoidFor: guide.avoidFor,
  prerequisites: guide.prerequisites,
  workflows: guide.workflows.map(({ id, description, skill, examples }) => ({
    id,
    description,
    ...(skill === undefined ? {} : { skill }),
    examples,
  })),
})

export interface GuideMatchCatalogEntry {
  readonly ref: string
  readonly surface: GuideCatalogSurface
  readonly name: string
  readonly launcher?: string
  readonly harness?: string
  readonly description: string
  readonly sandbox: boolean
  readonly guide: CompactProfileGuide
}

export const toGuideMatchCatalogEntry = (entry: GuideCatalogEntryRef): GuideMatchCatalogEntry => ({
  ref: entry.ref,
  surface: entry.surface,
  name: entry.name,
  ...(entry.launcher === undefined ? {} : { launcher: entry.launcher }),
  ...(entry.harness === undefined ? {} : { harness: entry.harness }),
  description: entry.description,
  sandbox: entry.sandbox,
  guide: compactProfileGuide(entry.guide),
})

export const guideMatchCatalogEntries = (catalog: CombinedGuideCatalog): ReadonlyArray<GuideMatchCatalogEntry> =>
  guideCatalogEntries(catalog).map(toGuideMatchCatalogEntry)
