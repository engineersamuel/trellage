import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import {
  decodeHeadlessCapabilitiesV1,
  sandboxHeadlessCapabilityDeclarations,
  type HeadlessCapabilitiesV1,
  type SandboxHeadlessRuntimeAdapter,
} from "../src/headless-capabilities.js"

interface EvidenceReference {
  readonly path: string
  readonly cases: ReadonlyArray<string>
}

interface LiveEvidence {
  readonly recorded: boolean
  readonly source: string
  readonly cases: ReadonlyArray<string>
}

interface SandboxPublication {
  readonly surface: "sandbox"
  readonly adapter: SandboxHeadlessRuntimeAdapter
}

interface NativePublication {
  readonly surface: "native"
  readonly catalog: string
  readonly profiles: ReadonlyArray<string>
}

interface EvidenceContract {
  readonly id: string
  readonly publication: SandboxPublication | NativePublication
  readonly capabilities: HeadlessCapabilitiesV1
  readonly deterministicEvidence: ReadonlyArray<EvidenceReference>
  readonly liveEvidence: LiveEvidence
}

interface EvidenceLedger {
  readonly schemaVersion: 1
  readonly capabilitySchemaVersion: 1
  readonly requiredDeterministicCases: ReadonlyArray<string>
  readonly contracts: ReadonlyArray<EvidenceContract>
}

interface NativeCatalog {
  readonly schemaVersion: 1
  readonly profiles: Readonly<Record<string, { readonly headless: HeadlessCapabilitiesV1 }>>
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const ledgerPath = path.join(repositoryRoot, "docs/headless-evidence.json")
const nativeCatalogs = [
  "prototypes/trellage-codex-profiles/catalog.json",
  "prototypes/trellage-copilot-profiles/catalog.json",
  "prototypes/trellage-claude-profiles/catalog.json",
  "prototypes/trellage-grok-profiles/catalog.json",
  "prototypes/trellage-jcode-profiles/catalog.json",
  "prototypes/trellage-omp-profiles/catalog.json",
  "prototypes/trellage-prime-profiles/catalog.json",
] as const

const readJson = async <Value>(file: string): Promise<Value> => JSON.parse(await readFile(file, "utf8")) as Value

const sortedKeys = (value: object): ReadonlyArray<string> => Object.keys(value).sort()

const claimsHeadlessSupport = (capabilities: HeadlessCapabilitiesV1): boolean =>
  capabilities.prompt ||
  capabilities.outputFormats.some((format) => format !== "text") ||
  capabilities.eventContract !== null ||
  capabilities.trellageEventContract !== null ||
  capabilities.sessionId !== "none" ||
  capabilities.resume ||
  capabilities.resumeWithPrompt ||
  capabilities.questionToolControl !== "none" ||
  capabilities.changedFiles !== "none" ||
  capabilities.usage ||
  capabilities.cost ||
  capabilities.modelOverride ||
  capabilities.effortOverride

const publicationKey = (publication: SandboxPublication | NativePublication, profile?: string): string =>
  publication.surface === "sandbox"
    ? `sandbox:${publication.adapter}`
    : `native:${publication.catalog}:${profile ?? ""}`

const publicationKeys = (publication: SandboxPublication | NativePublication): ReadonlyArray<string> =>
  publication.surface === "sandbox"
    ? [publicationKey(publication)]
    : publication.profiles.map((profile) => publicationKey(publication, profile))

const requiredDeterministicCases = (capabilities: HeadlessCapabilitiesV1): ReadonlyArray<string> => {
  const required = new Set<string>()
  if (capabilities.prompt) {
    required.add("nonTtyCompletion")
    required.add("nonZeroExit")
    required.add("cancellationCleanup")
  }
  if (capabilities.outputFormats.some((format) => format === "json" || format === "jsonl")) {
    required.add("machineOnlyStdout")
    required.add("malformedOutput")
  }
  if (capabilities.sessionId !== "none") required.add("authoritativeSessionId")
  if (capabilities.resumeWithPrompt) required.add("resumeWithPrompt")
  if (capabilities.questionToolControl !== "none") required.add("questionToolControl")
  if (capabilities.usage || capabilities.cost) required.add("usageAndCost")
  if (capabilities.changedFiles !== "none") required.add("changedFiles")
  return [...required].sort()
}

const requiredLiveCases = (capabilities: HeadlessCapabilitiesV1): ReadonlyArray<string> => {
  const required = new Set<string>()
  if (capabilities.prompt) required.add("nonTtyCompletion")
  if (capabilities.outputFormats.some((format) => format === "json" || format === "jsonl")) {
    required.add("machineOnlyStdout")
  }
  if (capabilities.sessionId !== "none") required.add("authoritativeSessionId")
  if (capabilities.resumeWithPrompt) required.add("resumeWithPrompt")
  if (capabilities.questionToolControl === "hard-deny") required.add("questionToolControl")
  if (capabilities.usage || capabilities.cost) required.add("usageAndCost")
  if (capabilities.modelOverride) required.add("modelOverride")
  if (capabilities.effortOverride) required.add("effortOverride")
  return [...required].sort()
}

describe("headless publication evidence", () => {
  it("matches every positive Sandbox and Native declaration to exact recorded evidence", async () => {
    const ledger = await readJson<EvidenceLedger>(ledgerPath)
    expect(sortedKeys(ledger)).toEqual([
      "capabilitySchemaVersion",
      "contracts",
      "requiredDeterministicCases",
      "schemaVersion",
    ])
    expect(ledger.schemaVersion).toBe(1)
    expect(ledger.capabilitySchemaVersion).toBe(1)
    expect(new Set(ledger.contracts.map(({ id }) => id)).size).toBe(ledger.contracts.length)

    const evidenceByPublication = new Map<string, HeadlessCapabilitiesV1>()
    const evidencePublicationKeys: Array<string> = []
    for (const contract of ledger.contracts) {
      expect(sortedKeys(contract)).toEqual([
        "capabilities",
        "deterministicEvidence",
        "id",
        "liveEvidence",
        "publication",
      ])
      const capabilities = await Effect.runPromise(decodeHeadlessCapabilitiesV1(contract.capabilities))
      expect(claimsHeadlessSupport(capabilities)).toBe(true)
      expect(capabilities.testedHarnessVersion).not.toBeNull()
      expect(contract.liveEvidence.recorded).toBe(true)
      expect(contract.liveEvidence.source.length).toBeGreaterThan(0)

      const deterministicCases = new Set(contract.deterministicEvidence.flatMap((evidence) => evidence.cases))
      for (const required of requiredDeterministicCases(capabilities)) {
        expect(deterministicCases.has(required), `${contract.id} lacks deterministic ${required}`).toBe(true)
      }
      const liveCases = new Set(contract.liveEvidence.cases)
      for (const required of requiredLiveCases(capabilities)) {
        expect(liveCases.has(required), `${contract.id} lacks live ${required}`).toBe(true)
      }

      for (const evidence of contract.deterministicEvidence) {
        expect(evidence.path.startsWith("/")).toBe(false)
        const metadata = await lstat(path.join(repositoryRoot, evidence.path))
        expect(metadata.isFile()).toBe(true)
        expect(metadata.isSymbolicLink()).toBe(false)
      }

      const keys = publicationKeys(contract.publication)
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) {
        evidencePublicationKeys.push(key)
        evidenceByPublication.set(key, capabilities)
      }
    }
    expect(new Set(evidencePublicationKeys).size).toBe(evidencePublicationKeys.length)

    const actualSandboxPublications = Object.fromEntries(
      (
        Object.entries(sandboxHeadlessCapabilityDeclarations) as ReadonlyArray<
          [SandboxHeadlessRuntimeAdapter, HeadlessCapabilitiesV1]
        >
      ).filter(([, capabilities]) => claimsHeadlessSupport(capabilities)),
    )
    const recordedSandboxPublications = Object.fromEntries(
      [...evidenceByPublication.entries()]
        .filter(([key]) => key.startsWith("sandbox:"))
        .map(([key, capabilities]) => [key.slice("sandbox:".length), capabilities]),
    )
    expect(recordedSandboxPublications).toEqual(actualSandboxPublications)

    const actualNativePublications: Record<string, HeadlessCapabilitiesV1> = {}
    for (const catalogPath of nativeCatalogs) {
      const catalog = await readJson<NativeCatalog>(path.join(repositoryRoot, catalogPath))
      expect(catalog.schemaVersion).toBe(1)
      for (const [profile, entry] of Object.entries(catalog.profiles)) {
        const capabilities = await Effect.runPromise(decodeHeadlessCapabilitiesV1(entry.headless))
        const key = `native:${catalogPath}:${profile}`
        if (claimsHeadlessSupport(capabilities)) actualNativePublications[key] = capabilities
      }
    }

    const recordedNativePublications = Object.fromEntries(
      [...evidenceByPublication.entries()].filter(([key]) => key.startsWith("native:")),
    )
    expect(recordedNativePublications).toEqual(actualNativePublications)
  })
})
