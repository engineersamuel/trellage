import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  loadProfileGuide,
  parseProfileGuideIdentity,
  type ProfileGuideIdentity,
} from "@trellage/guide-core"
import { describe, expect, it } from "vitest"

import { literalGuideMatch, prefilterGuideMatchCatalogEntries } from "../src/guide-api.ts"
import { guideCatalogEntries } from "../src/guide-catalog.ts"
import type { HeadlessCapabilitiesV1 } from "../src/guide-catalog.ts"
import { validateHeadlessCapabilitiesV1 } from "../src/guide-catalog.ts"
import type { CompositionCatalog, CompositionCatalogEntry } from "../src/composition-catalog.ts"
import { formatCompositionRef } from "../src/composition-catalog.ts"

interface ProfileGuideScenario {
  readonly id: string
  readonly intent: string
  readonly expectedProfiles: ReadonlyArray<string>
  /** Partial workflow assertions; expected profiles without an entry remain rank-only checks. */
  readonly expectedWorkflows?: Readonly<Record<string, string>>
  readonly maxRank: number
  readonly excludedProfiles: ReadonlyArray<string>
}

interface ProfileGuideScenarios {
  readonly schemaVersion: 1
  readonly scenarios: ReadonlyArray<ProfileGuideScenario>
}

interface LiveScenarioParserModule {
  readonly parseProfileGuideScenarios: (value: unknown) => ReadonlyArray<ProfileGuideScenario>
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const guideRoot = path.join(repositoryRoot, "profile-guides")
const scenarioPath = path.join(repositoryRoot, "tests", "fixtures", "profile-guide-scenarios.json")
const liveEvaluatorUrl = new URL("../../../scripts/evaluate-profile-guides.ts", import.meta.url)

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be text`)
  return value
}

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

const exactKeys = (value: Record<string, unknown>, name: string, allowedKeys: ReadonlyArray<string>): void => {
  const allowed = new Set(allowedKeys)
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) throw new Error(`${name} contains unsupported keys: ${unexpected.join(", ")}`)
}

const stringArray = (value: unknown, name: string): ReadonlyArray<string> => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  const items = value.map((item, index) => text(item, `${name}[${index}]`))
  if (new Set(items).size !== items.length) throw new Error(`${name} must contain unique entries`)
  return items
}

const rank = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 to 5`)
  }
  return value
}

const expectedWorkflowMap = (
  value: unknown,
  name: string,
  expectedProfiles: ReadonlyArray<string>,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined) return undefined
  const expectedProfileSet = new Set(expectedProfiles)
  const entries = Object.entries(record(value, name)).map(([profileRef, workflowId]) => {
    text(profileRef, `${name} profile key`)
    if (!expectedProfileSet.has(profileRef)) {
      throw new Error(`${name} key ${profileRef} must also appear in expectedProfiles`)
    }
    return [profileRef, text(workflowId, `${name}.${profileRef}`)] as const
  })
  return Object.fromEntries(entries)
}

const validateScenarioSet = (scenarios: ReadonlyArray<ProfileGuideScenario>): ReadonlyArray<ProfileGuideScenario> => {
  const ids = scenarios.map(({ id }) => id)
  if (new Set(ids).size !== ids.length) throw new Error("profile guide scenario IDs must be unique")
  for (const scenario of scenarios) {
    if (scenario.expectedProfiles.length === 0) {
      throw new Error(`${scenario.id}.expectedProfiles must not be empty`)
    }
    const excluded = new Set(scenario.excludedProfiles)
    const overlap = scenario.expectedProfiles.find((profileRef) => excluded.has(profileRef))
    if (overlap !== undefined) throw new Error(`${scenario.id} both expects and excludes ${overlap}`)
  }
  return scenarios
}

const parseScenario = (item: unknown, index: number): ProfileGuideScenario => {
  const scenario = record(item, `scenario ${index}`)
  exactKeys(scenario, `scenario ${index}`, [
    "id",
    "intent",
    "expectedProfiles",
    "maxRank",
    "excludedProfiles",
    "expectedWorkflows",
  ])
  const expectedProfiles = stringArray(scenario.expectedProfiles, `scenario ${index}.expectedProfiles`)
  const expectedWorkflows = expectedWorkflowMap(
    scenario.expectedWorkflows,
    `scenario ${index}.expectedWorkflows`,
    expectedProfiles,
  )
  return {
    id: text(scenario.id, `scenario ${index}.id`),
    intent: text(scenario.intent, `scenario ${index}.intent`),
    expectedProfiles,
    ...(expectedWorkflows === undefined ? {} : { expectedWorkflows }),
    maxRank: rank(scenario.maxRank, `scenario ${index}.maxRank`),
    excludedProfiles: stringArray(scenario.excludedProfiles, `scenario ${index}.excludedProfiles`),
  }
}

const parseScenarioRoot = (value: unknown): ProfileGuideScenarios => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile guide scenarios must be an object")
  }
  const root = value as Record<string, unknown>
  exactKeys(root, "profile guide scenarios", ["schemaVersion", "scenarios"])
  if (root.schemaVersion !== 1 || !Array.isArray(root.scenarios)) {
    throw new Error("profile guide scenarios must use schemaVersion 1")
  }
  const scenarios = root.scenarios.map(parseScenario)
  return {
    schemaVersion: 1,
    scenarios: validateScenarioSet(scenarios),
  }
}

const loadScenarios = async (): Promise<ProfileGuideScenarios> =>
  parseScenarioRoot(JSON.parse(await readFile(scenarioPath, "utf8")))

const loadLiveScenarioParser = async (): Promise<LiveScenarioParserModule["parseProfileGuideScenarios"]> => {
  const liveModule = (await import(liveEvaluatorUrl.href)) as LiveScenarioParserModule
  return liveModule.parseProfileGuideScenarios
}

interface NativeCatalogMetadata {
  readonly description: string
  readonly headless: HeadlessCapabilitiesV1
}

const conservativeHeadless = {
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


const nativeCatalogFamily = async (
  prototypes: string,
  family: string,
): Promise<ReadonlyArray<readonly [string, NativeCatalogMetadata]>> => {
  const familyRoot = path.join(prototypes, family)
  const harness = family.slice("trellage-".length, -"-profiles".length)
  const root = record(
    JSON.parse(await readFile(path.join(familyRoot, "catalog.json"), "utf8")),
    `${family}/catalog.json`,
  )
  const profiles = record(root.profiles, `${family}/catalog.json profiles`)
  return Object.entries(profiles).map(([profile, rawProfile]) => {
    const entry = record(rawProfile, `${harness}/${profile} catalog entry`)
    return [
      `${harness}/${profile}`,
      {
        description: text(entry.description, `${harness}/${profile}.description`),
        headless: validateHeadlessCapabilitiesV1(
          entry.headless === null ? conservativeHeadless : entry.headless,
          `${harness}/${profile}.headless`,
        ),
      },
    ] as const
  })
}

const nativeCatalogs = async (): Promise<ReadonlyMap<string, NativeCatalogMetadata>> => {
  const prototypes = path.join(repositoryRoot, "prototypes")
  const families = (await readdir(prototypes, { withFileTypes: true }))
    .filter((directory) => directory.isDirectory() && /^trellage-.+-profiles$/u.test(directory.name))
    .map(({ name }) => name)
  const entries = await Promise.all(families.map((family) => nativeCatalogFamily(prototypes, family)))
  // Mirrors the router's interactive firstmate config profiles (trx build_profile_list).
  const firstmate = (harness: string) =>
    [
      `${harness}/firstmate`,
      {
        description: `Firstmate fleet supervisor on ${harness}, run from its own clone at the latest main`,
        headless: validateHeadlessCapabilitiesV1(
          {
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
          },
          `${harness}/firstmate.headless`,
        ),
      },
    ] as const
  return new Map([
    ...entries.flat(),
    firstmate("claude"),
    firstmate("pi"),
    [
      "headlong/default",
      {
        description: "Persistent Headlong agent with durable identity, memory, and background thinking on the host.",
        headless: validateHeadlessCapabilitiesV1(conservativeHeadless, "headlong/default.headless"),
      },
    ],
    [
      "fx/default",
      {
        description: "Fx with shared host context through copilot-proxy-rs",
        headless: validateHeadlessCapabilitiesV1(
          {
            schemaVersion: 1,
            prompt: true,
            outputFormats: ["text", "json"],
            eventContract: null,
            trellageEventContract: null,
            sessionId: "native",
            resume: true,
            resumeWithPrompt: true,
            questionToolControl: "prompt-only",
            changedFiles: "native",
            usage: true,
            cost: true,
            modelOverride: true,
            effortOverride: true,
            testedHarnessVersion: null,
          },
          "fx/default.headless",
        ),
      },
    ] as const,
  ])
}

const nativeGuideIdentities = async (): Promise<
  ReadonlyArray<Extract<ProfileGuideIdentity, { readonly surface: "native" }>>
> => {
  const identities: Array<Extract<ProfileGuideIdentity, { readonly surface: "native" }>> = []
  for (const harness of await readdir(path.join(guideRoot, "native"), { withFileTypes: true })) {
    if (!harness.isDirectory()) continue
    for (const profile of await readdir(path.join(guideRoot, "native", harness.name), { withFileTypes: true })) {
      if (profile.isFile() && profile.name.endsWith(".md")) {
        const identity = parseProfileGuideIdentity(`native/${harness.name}/${profile.name}`)
        identities.push(identity)
      }
    }
  }
  return identities
}

const nativeCatalogEntry = async (
  identity: Extract<ProfileGuideIdentity, { readonly surface: "native" }>,
  metadata: ReadonlyMap<string, NativeCatalogMetadata>,
): Promise<CompositionCatalogEntry> => {
  const loaded = await loadProfileGuide(guideRoot, identity)
  const catalogMetadata = metadata.get(`${identity.harness}/${identity.profile}`) ?? {
    description: loaded.guide.bestFor.join("; "),
    headless: validateHeadlessCapabilitiesV1(
      conservativeHeadless,
      `${identity.harness}/${identity.profile}.headless`,
    ),
  }
  return {
    ref: formatCompositionRef(identity.harness, [identity.profile]),
    harness: identity.harness,
    profiles: [identity.profile],
    kind: "preset",
    canonicalHarness: identity.harness !== "fx" && identity.harness !== "headlong",
    description: catalogMetadata.description,
    headless: catalogMetadata.headless,
    herdrCompatibility: { status: "test" },
    guide: loaded.guide,
    commandPath: `/tmp/${identity.harness}`,
    lifecycle: null,
  }
}

const loadCatalog = async (): Promise<CompositionCatalog> => {
  const [metadata, nativeIdentities] = await Promise.all([nativeCatalogs(), nativeGuideIdentities()])
  const entries = await Promise.all(nativeIdentities.map((identity) => nativeCatalogEntry(identity, metadata)))
  return {
    schemaVersion: 2,
    entries,
  }
}

describe("profile guide recommendation scenarios", () => {
  it("rejects unsupported root keys", () => {
    for (const unsupportedKey of ["expectedWorkflows", "scenario"]) {
      expect(() =>
        parseScenarioRoot({
          schemaVersion: 1,
          scenarios: [],
          [unsupportedKey]: {},
        }),
      ).toThrow(`profile guide scenarios contains unsupported keys: ${unsupportedKey}`)
    }
  })

  it("keeps live evaluator scenario root keys exact", async () => {
    const parseProfileGuideScenarios = await loadLiveScenarioParser()
    for (const unsupportedKey of ["expectedWorkflows", "scenario"]) {
      expect(() =>
        parseProfileGuideScenarios({
          schemaVersion: 1,
          scenarios: [],
          [unsupportedKey]: {},
        }),
      ).toThrow(`profile guide scenarios has unexpected keys: ${unsupportedKey}`)
    }
  })

  it("accepts omitted and partial expected workflow assertions", () => {
    const baseScenario = {
      id: "workflow-schema",
      intent: "Select a profile",
      expectedProfiles: ["native:test/one", "native:test/two"],
      maxRank: 3,
      excludedProfiles: [],
    }
    expect(parseScenario(baseScenario, 0).expectedWorkflows).toBeUndefined()
    expect(
      parseScenario(
        {
          ...baseScenario,
          expectedWorkflows: { "native:test/one": "workflow-one" },
        },
        0,
      ).expectedWorkflows,
    ).toEqual({ "native:test/one": "workflow-one" })
  })

  it("rejects misspelled scenario keys", () => {
    expect(() =>
      parseScenario(
        {
          id: "workflow-schema",
          intent: "Select a profile",
          expectedProfiles: ["native:test/one"],
          expectedWorkflow: { "native:test/one": "workflow-one" },
          maxRank: 3,
          excludedProfiles: [],
        },
        0,
      ),
    ).toThrow("scenario 0 contains unsupported keys: expectedWorkflow")
  })

  it("validates expected workflow assertion keys and values", () => {
    const baseScenario = {
      id: "workflow-schema",
      intent: "Select a profile",
      expectedProfiles: ["native:test/one"],
      maxRank: 3,
      excludedProfiles: [],
    }
    expect(() => parseScenario({ ...baseScenario, expectedWorkflows: [] }, 0)).toThrow(
      "scenario 0.expectedWorkflows must be an object",
    )
    expect(() => parseScenario({ ...baseScenario, expectedWorkflows: { "": "workflow-one" } }, 0)).toThrow(
      "scenario 0.expectedWorkflows profile key must be text",
    )
    expect(() => parseScenario({ ...baseScenario, expectedWorkflows: { "native:test/one": " " } }, 0)).toThrow(
      "scenario 0.expectedWorkflows.native:test/one must be text",
    )
    expect(() =>
      parseScenario({ ...baseScenario, expectedWorkflows: { "native:test/two": "workflow-two" } }, 0),
    ).toThrow("scenario 0.expectedWorkflows key native:test/two must also appear in expectedProfiles")
  })

  it("keeps expected profiles visible and known poor fits out of the literal top five", async () => {
    const [catalog, scenarios] = await Promise.all([loadCatalog(), loadScenarios()])
    const pinnedProfiles = new Set(["native:claude/council", "native:claude/research", "native:claude/six-hats"])
    const eligibleProfiles = guideCatalogEntries(catalog)
      .map(({ ref }) => ref)
      .filter((profileRef) => !pinnedProfiles.has(profileRef))
      .sort()
    const knownProfiles = new Set(guideCatalogEntries(catalog).map(({ ref }) => ref))
    const coveredProfiles = [...new Set(scenarios.scenarios.flatMap(({ expectedProfiles }) => expectedProfiles))].sort()
    expect(coveredProfiles).toEqual(eligibleProfiles)

    for (const scenario of scenarios.scenarios) {
      const candidates = literalGuideMatch(catalog, scenario.intent)
      const refs = candidates.map(({ harness, profiles }) => formatCompositionRef(harness, profiles))
      for (const profileRef of scenario.expectedProfiles) {
        expect(knownProfiles.has(profileRef), `${scenario.id} references unknown profile ${profileRef}`).toBe(true)
        const profileRank = refs.indexOf(profileRef) + 1
        expect(
          profileRank,
          `${scenario.id} should rank ${profileRef} at ${scenario.maxRank} or better`,
        ).toBeGreaterThan(0)
        expect(
          profileRank,
          `${scenario.id} should rank ${profileRef} at ${scenario.maxRank} or better`,
        ).toBeLessThanOrEqual(scenario.maxRank)
      }
      for (const [profileRef, expectedWorkflowId] of Object.entries(scenario.expectedWorkflows ?? {})) {
        expect(
          knownProfiles.has(profileRef),
          `${scenario.id}.expectedWorkflows references unknown profile ${profileRef}`,
        ).toBe(true)
        const profileRank = refs.indexOf(profileRef) + 1
        expect(
          candidates[profileRank - 1]?.workflowId,
          `${scenario.id} should select workflow ${expectedWorkflowId} for ${profileRef}`,
        ).toBe(expectedWorkflowId)
      }
      const expectedRank = Math.min(...scenario.expectedProfiles.map((profileRef) => refs.indexOf(profileRef) + 1))
      for (const profileRef of scenario.excludedProfiles) {
        expect(knownProfiles.has(profileRef), `${scenario.id} references unknown profile ${profileRef}`).toBe(true)
        const alternativeRank = refs.indexOf(profileRef) + 1
        if (alternativeRank > 0) {
          expect(
            alternativeRank,
            `${scenario.id} should rank ${profileRef} below the expected profile`,
          ).toBeGreaterThan(expectedRank)
        }
      }
      expect(candidates.map(({ harness, profiles, workflowId }) => `${formatCompositionRef(harness, profiles)}/${workflowId}`)).not.toEqual(
        expect.arrayContaining(["native:copilot/hve/rpi-agent-cycle"]),
      )
      expect(candidates.map(({ workflowId }) => workflowId)).not.toEqual(
        expect.arrayContaining(["run-council-deliberation"]),
      )
      expect(candidates.map(({ workflowId }) => workflowId)).not.toEqual(
        expect.arrayContaining(["vault-backed-research"]),
      )
      expect(candidates.map(({ workflowId }) => workflowId)).not.toEqual(
        expect.arrayContaining(["run-six-hats-deliberation"]),
      )
    }
  })

  it("prefilters high-signal intents without losing expected or explicit profiles", async () => {
    const [catalog, scenarios] = await Promise.all([loadCatalog(), loadScenarios()])
    const allProfileRefs = guideCatalogEntries(catalog).map(({ ref }) => ref)

    for (const scenario of scenarios.scenarios) {
      const refs = prefilterGuideMatchCatalogEntries(catalog, scenario.intent).map(({ ref }) => ref)
      expect(refs.length, `${scenario.id} should reduce the model catalog`).toBeLessThanOrEqual(12)
      for (const profileRef of scenario.expectedProfiles) {
        expect(refs, `${scenario.id} should retain ${profileRef}`).toContain(profileRef)
      }
    }

    for (const profileRef of allProfileRefs) {
      const refs = prefilterGuideMatchCatalogEntries(catalog, `Use ${profileRef} for this task.`).map(({ ref }) => ref)
      expect(refs, `explicit identity should retain ${profileRef}`).toContain(profileRef)
    }

    const rustSimdRefs = prefilterGuideMatchCatalogEntries(
      catalog,
      "Implement a stable Rust 1.85 byte-slice parenthesis matcher with scalar, AVX2, and NEON paths, documented unsafe blocks, differential tests, and release benchmarks.",
    ).map(({ ref }) => ref)
    expect(rustSimdRefs).toHaveLength(12)
    expect(rustSimdRefs).toContain("native:codex/pstack")
    expect(rustSimdRefs).toContain("native:headlong/default")
  })

  it("keeps the full catalog for low-signal anaphoric intents", async () => {
    const catalog = await loadCatalog()
    // claude/six-hats has only its pinned Decide workflow, so ranking reaches it only by name.
    const allProfileRefs = guideCatalogEntries(catalog)
      .map(({ ref }) => ref)
      .filter((ref) => ref !== "native:claude/six-hats")

    expect(prefilterGuideMatchCatalogEntries(catalog, "Add caching to step 2").map(({ ref }) => ref)).toEqual(
      allProfileRefs,
    )
  })
})
