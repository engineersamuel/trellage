import type { ProfileGuideV1 } from "@trellage/guide-core"
import type { CompositionCatalog, CompositionCatalogEntry } from "../../src/composition-catalog.ts"

const defaultHeadless: CompositionCatalogEntry["headless"] = {
  schemaVersion: 1,
  prompt: true,
  outputFormats: ["json"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "native",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "hard-deny",
  changedFiles: "native",
  usage: true,
  cost: true,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}

export interface CompositionFixtureOptions {
  readonly harness: string
  readonly profile: string
  readonly description?: string
  readonly guide?: ProfileGuideV1 | null
  readonly commandPath?: string
  readonly headless?: Partial<CompositionCatalogEntry["headless"]>
  readonly kind?: CompositionCatalogEntry["kind"]
  readonly canonicalHarness?: boolean
  readonly lifecycle?: CompositionCatalogEntry["lifecycle"]
}

export const compositionFixtureEntry = (options: CompositionFixtureOptions): CompositionCatalogEntry => ({
  ref: `native:${options.harness}/${options.profile}`,
  harness: options.harness,
  profiles: [options.profile],
  kind: options.kind ?? "preset",
  canonicalHarness: options.canonicalHarness ?? true,
  description: options.description ?? `${options.harness} ${options.profile}`,
  headless: { ...defaultHeadless, ...options.headless },
  herdrCompatibility: { status: "supported" },
  guide: options.guide ?? null,
  commandPath: options.commandPath ?? "/opt/trellage/trx",
  lifecycle: options.lifecycle ?? null,
})

export const compositionFixtureCatalog = (
  entries: ReadonlyArray<CompositionFixtureOptions | CompositionCatalogEntry>,
): CompositionCatalog => ({
  schemaVersion: 2,
  entries: entries.map((entry) => "ref" in entry ? entry : compositionFixtureEntry(entry)),
})
