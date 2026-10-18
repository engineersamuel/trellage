import { loadProfileGuide, profileGuideRelativePath, type ProfileGuideV1 } from "@trellage/guide-core"
import { lifecycleRuntime } from "@trellage/runtime/native-run"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadRunCatalog, type RunCatalogProfile } from "./run-catalog.ts"

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

export interface HerdrCompatibilityInfo {
  readonly status: string
  readonly [key: string]: unknown
}

export interface CompositionCatalogEntry {
  readonly ref: string
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly kind: "preset" | "config" | "shared" | "special"
  readonly canonicalHarness: boolean
  readonly description: string
  readonly headless: HeadlessCapabilitiesV1
  readonly herdrCompatibility: HerdrCompatibilityInfo
  readonly guide: ProfileGuideV1 | null
  readonly commandPath: string
  readonly lifecycle: { readonly runtime: string; readonly profile: string } | null
}

export interface CompositionCatalog {
  readonly schemaVersion: 2
  readonly entries: ReadonlyArray<CompositionCatalogEntry>
}

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))

const interactiveOnlyHeadless: HeadlessCapabilitiesV1 = {
  schemaVersion: 1,
  prompt: false,
  outputFormats: ["text"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "none",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "none",
  changedFiles: "none",
  usage: false,
  cost: false,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

const lifecycleCatalogPackages: Readonly<Record<string, string>> = {
  agency: "trellage-agency-profiles",
  claude: "trellage-claude-profiles",
  copilot: "trellage-copilot-profiles",
  jcode: "trellage-jcode-profiles",
  omp: "trellage-omp-profiles",
  prime: "trellage-prime-profiles",
}

const builtInDescriptions: Readonly<Record<string, string>> = {
  "fx/default": "Fx with shared host context through copilot-proxy-rs",
  "headlong/default": "Persistent Headlong agent with durable identity, memory, and background thinking on the host.",
  "uji/default": "Uji with generated configuration, selected skills, and keyless model routing through copilot-proxy-rs.",
}

const adapterHeadlessCapabilities: Readonly<Record<string, HeadlessCapabilitiesV1>> = {
  codex: interactiveOnlyHeadless,
  pi: {
    schemaVersion: 1,
    prompt: true,
    outputFormats: ["text"],
    eventContract: null,
    trellageEventContract: null,
    sessionId: "none",
    resume: false,
    resumeWithPrompt: false,
    questionToolControl: "prompt-only",
    changedFiles: "none",
    usage: false,
    cost: false,
    modelOverride: false,
    effortOverride: false,
    testedHarnessVersion: "0.84.2",
  },
}

interface LegacyPreset {
  readonly description: string
  readonly headless: HeadlessCapabilitiesV1
}

type LegacyPresetMap = Readonly<Record<string, LegacyPreset>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const parseHeadless = (value: unknown, field: string): HeadlessCapabilitiesV1 => {
  if (!isRecord(value)) return interactiveOnlyHeadless
  const formats = value.outputFormats
  if (
    value.schemaVersion !== 1 ||
    typeof value.prompt !== "boolean" ||
    !Array.isArray(formats) ||
    !formats.every((format) => format === "text" || format === "json" || format === "jsonl") ||
    !(value.eventContract === null || typeof value.eventContract === "string") ||
    !(value.trellageEventContract === null || value.trellageEventContract === "trellage-headless-v1") ||
    !(value.sessionId === "native" || value.sessionId === "trellage" || value.sessionId === "none") ||
    typeof value.resume !== "boolean" ||
    typeof value.resumeWithPrompt !== "boolean" ||
    !(value.questionToolControl === "hard-deny" || value.questionToolControl === "prompt-only" || value.questionToolControl === "none") ||
    !(value.changedFiles === "native" || value.changedFiles === "git-diff" || value.changedFiles === "none") ||
    typeof value.usage !== "boolean" ||
    typeof value.cost !== "boolean" ||
    typeof value.modelOverride !== "boolean" ||
    typeof value.effortOverride !== "boolean" ||
    !(value.testedHarnessVersion === null || typeof value.testedHarnessVersion === "string")
  ) throw new Error(`${field} must be a valid headless capability document`)
  return {
    schemaVersion: 1,
    prompt: value.prompt,
    outputFormats: formats,
    eventContract: value.eventContract,
    trellageEventContract: value.trellageEventContract,
    sessionId: value.sessionId,
    resume: value.resume,
    resumeWithPrompt: value.resumeWithPrompt,
    questionToolControl: value.questionToolControl,
    changedFiles: value.changedFiles,
    usage: value.usage,
    cost: value.cost,
    modelOverride: value.modelOverride,
    effortOverride: value.effortOverride,
    testedHarnessVersion: value.testedHarnessVersion,
  }
}

const loadLegacyPresets = async (harness: string): Promise<LegacyPresetMap> => {
  const packageName = lifecycleCatalogPackages[harness]
  if (packageName === undefined) return {}
  const source: unknown = JSON.parse(await readFile(path.join(repositoryRoot, "prototypes", packageName, "catalog.json"), "utf8"))
  if (!isRecord(source) || (!isRecord(source.profiles) && !Array.isArray(source.profiles))) throw new Error(`invalid legacy profile catalog for ${harness}`)
  const profileEntries: Array<[string, unknown]> = Array.isArray(source.profiles)
    ? source.profiles.map((value, index) => {
        if (!isRecord(value) || typeof value.name !== "string") throw new Error(`invalid legacy profile catalog entry: ${harness}/${index}`)
        return [value.name, value]
      })
    : Object.entries(source.profiles)
  const entries: Record<string, LegacyPreset> = {}
  for (const [legacyName, value] of profileEntries) {
    if (!isRecord(value) || typeof value.description !== "string") throw new Error(`invalid legacy profile catalog entry: ${harness}/${legacyName}`)
    const publicName = harness === "agency" && legacyName === "trellage-azure"
      ? "azure"
      : harness === "omp" && legacyName === "copilot" ? "default" : legacyName
    entries[publicName] = {
      description: value.description,
      headless: parseHeadless(value.headless, `${harness}/${publicName}.headless`),
    }
  }
  return entries
}


const loadHerdrLedger = async (guideRoot: string): Promise<ReadonlyMap<string, HerdrCompatibilityInfo>> => {
  const candidates = [path.join(repositoryRoot, "docs", "herdr-compatibility.json"), path.join(path.dirname(guideRoot), "herdr-compatibility.json")]
  let contents: string | undefined
  for (const candidate of candidates) {
    try {
      contents = await readFile(candidate, "utf8")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  if (contents === undefined) throw new Error("Herdr compatibility ledger is missing")
  const source: unknown = JSON.parse(contents)
  if (!isRecord(source) || source.schemaVersion !== 2 || !Array.isArray(source.entries)) {
    throw new Error("docs/herdr-compatibility.json must be a schemaVersion 2 ledger")
  }
  const result = new Map<string, HerdrCompatibilityInfo>()
  for (const [index, value] of source.entries.entries()) {
    if (!isRecord(value) || typeof value.harness !== "string" || typeof value.profile !== "string" || typeof value.status !== "string") {
      throw new Error(`docs/herdr-compatibility.json entry ${index} is invalid`)
    }
    const harness = value.harness
    const profile = value.profile
    const key = `${harness}/${profile}`
    if (result.has(key)) throw new Error(`duplicate Herdr compatibility entry: ${key}`)
    const { harness: _harness, profile: _profile, ...metadata } = value
    result.set(key, { ...metadata, status: value.status })
  }
  return result
}

const loadGuide = async (guideRoot: string, harness: string, profile: string): Promise<ProfileGuideV1 | null> => {
  const identity = { surface: "native", harness, profile } as const
  try {
    await lstat(path.join(guideRoot, profileGuideRelativePath(identity)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  return (await loadProfileGuide(guideRoot, identity)).guide
}

const profileApplies = (profile: RunCatalogProfile, harness: string): boolean =>
  profile.harnesses === null || profile.harnesses.includes(harness)

const profileKind = (profile: RunCatalogProfile): CompositionCatalogEntry["kind"] => profile.kind

const configDescription = (profile: RunCatalogProfile): string =>
  profile.skills.length === 0 ? profile.label : `${profile.label} (${profile.skills.join(", ")})`

export const formatCompositionRef = (harness: string, profiles: ReadonlyArray<string>): string => {
  if (!identifierPattern.test(harness) || profiles.length === 0 || profiles.some((profile) => !identifierPattern.test(profile))) {
    throw new Error("composition refs require a harness and one or more lowercase kebab-case profiles")
  }
  return `native:${harness}/${profiles.join("+")}`
}

export const parseCompositionRef = (ref: string): { harness: string; profiles: string[] } => {
  const match = /^native:([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\+[a-z0-9]+(?:-[a-z0-9]+)*)*)$/u.exec(ref)
  if (match === null) throw new Error(`invalid composition ref: ${ref}`)
  const harness = match[1]
  const profiles = match[2]?.split("+")
  if (harness === undefined || profiles === undefined || profiles.length === 0 || new Set(profiles).size !== profiles.length) {
    throw new Error(`invalid composition ref: ${ref}`)
  }
  return { harness, profiles }
}

export const loadCompositionCatalog = async (options: {
  readonly guideRoot: string
  readonly commandPath: string
}): Promise<CompositionCatalog> => {
  if (!path.isAbsolute(options.commandPath)) throw new Error("composition catalog commandPath must be absolute")
  const runCatalog = await loadRunCatalog({ includeModels: false })
  const herdrLedger = await loadHerdrLedger(options.guideRoot)
  const presetCatalogs = new Map<string, LegacyPresetMap>()
  for (const { harness } of runCatalog.harnesses) presetCatalogs.set(harness, await loadLegacyPresets(harness))

  const entries: CompositionCatalogEntry[] = []
  for (const { harness } of runCatalog.harnesses) {
    const presets = runCatalog.presetsByHarness[harness] ?? []
    const legacyPresets = presetCatalogs.get(harness) ?? {}
    const defaultCapabilities = adapterHeadlessCapabilities[harness] ?? legacyPresets.default?.headless ?? Object.values(legacyPresets)[0]?.headless ?? interactiveOnlyHeadless
    const rows: Array<{ readonly profile: string; readonly kind: CompositionCatalogEntry["kind"]; readonly description: string; readonly headless: HeadlessCapabilitiesV1 }> = [
      ...presets.map((profile) => ({
        profile,
        kind: "preset" as const,
        description: legacyPresets[profile]?.description ?? builtInDescriptions[`${harness}/${profile}`] ?? `${harness} ${profile}`,
        headless: legacyPresets[profile]?.headless ?? defaultCapabilities,
      })),
      ...runCatalog.profileEntries
        .filter((profile) => !profile.always && !presets.includes(profile.name) && profileApplies(profile, harness))
        .map((profile) => ({
          profile: profile.name,
          kind: profileKind(profile),
          description: configDescription(profile),
          // Config profiles change composed content, not the harness CLI. Reuse the harness's default preset capability contract.
          headless: profile.kind === "shared" && profile.name === "firstmate" ? interactiveOnlyHeadless : defaultCapabilities,
        })),
    ]
    for (const row of rows) {
      const guide = await loadGuide(options.guideRoot, harness, row.profile)
      const runtime = row.kind === "preset" ? lifecycleRuntime(harness) : undefined
      entries.push({
        ref: formatCompositionRef(harness, [row.profile]),
        harness,
        profiles: [row.profile],
        kind: row.kind,
        canonicalHarness: harness !== "fx" && harness !== "headlong",
        description: guide?.bestFor[0] ?? row.description,
        headless: row.headless,
        herdrCompatibility: herdrLedger.get(`${harness}/${row.profile}`) ?? { status: "untested" },
        guide,
        commandPath: options.commandPath,
        lifecycle: runtime === undefined ? null : { runtime: runtime.runtimeName, profile: runtime.profileName(row.profile) },
      })
    }
  }
  return { schemaVersion: 2, entries }
}
