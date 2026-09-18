import { readFileSync } from "node:fs"
import {
  firstmateInstanceListCursor,
  firstmateInstanceListSnapshotDigest,
  firstmateWorktreeGenerationDigest,
  parseFirstmateFleetReadinessV1,
  parseFirstmateInstanceDescriptorV1,
  type FirstmateFleetReadinessV1,
  type FirstmateInstanceDescriptorV1,
  type FirstmateNamedInstanceDescriptorV1,
} from "@trellage/guide-core"
import { aggregateAdminInstanceProfiles, type AdminProfileEntry } from "../src/admin-model.ts"
import { parseGuideCatalog, type CombinedGuideCatalog } from "../src/guide-catalog.ts"

export const instanceContractFixtures: Record<string, unknown> = JSON.parse(readFileSync(
  new URL("../../trellage-guide-core/test/fixtures/firstmate-instances-v1.json", import.meta.url), "utf8",
))

const parsed = parseFirstmateInstanceDescriptorV1(instanceContractFixtures.descriptor)
if (parsed.mode !== "named") throw new Error("The shared descriptor fixture must be named.")
export const alpha = parsed
export const firstmatePin = alpha.runtime.required.sourceRevision
export const missingLegacy = parseFirstmateInstanceDescriptorV1(instanceContractFixtures.legacyMissingIdentity)
export const legacy = parseFirstmateInstanceDescriptorV1({
  ...missingLegacy,
  reference: { schemaVersion: 1, profile: "default", mode: "legacy", instanceId: "22222222-2222-4222-8222-222222222222" },
  creationState: "published",
  diagnostics: [],
})

const betaGeneration = {
  ...alpha.worktree.evidence.generation,
  worktree: { ...alpha.worktree.evidence.generation.worktree, inode: "9007199254740996" },
  privateGitDir: { ...alpha.worktree.evidence.generation.privateGitDir, inode: "9007199254740997" },
}
const parsedBeta = parseFirstmateInstanceDescriptorV1({
  ...alpha,
  name: "beta",
  reference: { ...alpha.reference, instanceId: "33333333-3333-4333-8333-333333333333" },
  root: "/state/firstmate/instances/33333333-3333-4333-8333-333333333333",
  taskIdPrefix: "fi345def",
  worktree: {
    status: "bound",
    evidence: {
      ...alpha.worktree.evidence,
      locators: { ...alpha.worktree.evidence.locators, worktree: "/work/beta", privateGitDir: "/repos/project/.git/worktrees/beta" },
      generation: betaGeneration,
      generationDigest: firstmateWorktreeGenerationDigest(betaGeneration),
    },
  },
})
if (parsedBeta.mode !== "named") throw new Error("The second descriptor must be named.")
export const beta: FirstmateNamedInstanceDescriptorV1 = parsedBeta

export const namedInstanceRegistry = (count: number): ReadonlyArray<FirstmateNamedInstanceDescriptorV1> =>
  Array.from({ length: count }, (_, index) => {
    const name = `instance-${String(index + 1).padStart(4, "0")}`
    const instanceId = `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`
    const inode = 9007199254740998n + BigInt(index) * 2n
    const generation = {
      ...alpha.worktree.evidence.generation,
      worktree: { ...alpha.worktree.evidence.generation.worktree, inode: String(inode) },
      privateGitDir: { ...alpha.worktree.evidence.generation.privateGitDir, inode: String(inode + 1n) },
    }
    const descriptor = parseFirstmateInstanceDescriptorV1({
      ...alpha,
      name,
      reference: { ...alpha.reference, instanceId },
      root: `/state/firstmate/instances/${instanceId}`,
      taskIdPrefix: `fi${(index + 1).toString(16).padStart(6, "0")}`,
      worktree: {
        status: "bound",
        evidence: {
          ...alpha.worktree.evidence,
          locators: {
            ...alpha.worktree.evidence.locators,
            worktree: `/work/${name}`,
            privateGitDir: `/repos/project/.git/worktrees/${name}`,
          },
          generation,
          generationDigest: firstmateWorktreeGenerationDigest(generation),
        },
      },
    })
    if (descriptor.mode !== "named") throw new Error("The registry descriptor must be named.")
    return descriptor
  })

export const firstmateCatalog = (instances = true, names: ReadonlyArray<string> = ["default"]) => parseGuideCatalog(JSON.stringify({
  schemaVersion: 1,
  sandboxCommandPath: "/fixture/trellage",
  native: names.map((name) => ({
    launcher: "fmx",
    harness: "firstmate",
    name,
    description: "Firstmate fleet template.",
    commandPath: "/fixture/fmx",
    sandbox: false,
    herdrCompatibility: { status: "supported" },
    headless: {
      schemaVersion: 1, prompt: false, outputFormats: [], eventContract: null, trellageEventContract: null,
      sessionId: "none", resume: false, resumeWithPrompt: false, questionToolControl: "none", changedFiles: "none",
      usage: false, cost: false, modelOverride: false, effortOverride: false, testedHarnessVersion: null,
    },
    guide: {
      schemaVersion: 1,
      capabilities: ["fleet-orchestration"],
      bestFor: ["Coordinating workers", "Managing a fleet"],
      avoidFor: ["One short edit", "Unattended installation"],
      prerequisites: [],
      workflows: [{
        id: "delegate", description: "Delegate tasks.", examples: ["Build a feature", "Review two changes"],
        promptTemplate: "Delegate: {{intent}}.",
      }],
    },
    orchestration: {
      schemaVersion: 1, kind: "firstmate", sourceRevision: firstmatePin,
      taskIdPrefix: name === "default" ? "fmd" : "fmp", workerPolicy: null, workerHarness: "claude",
      workerEfforts: ["low", "medium", "high"], dispatchRules: "claude-single",
      submission: { schemaVersion: 1, maxRequestBytes: 524288 },
      preparation: { schemaVersion: 1 },
      ...(instances ? { instances: { schemaVersion: 1 } } : {}),
    },
  })),
  sandbox: [],
}))

export const instanceRows = (
  descriptors: ReadonlyArray<FirstmateInstanceDescriptorV1> = [missingLegacy, alpha, beta],
): ReadonlyArray<AdminProfileEntry> => aggregateAdminInstanceProfiles(firstmateCatalog(), [{
  ref: "native:fmx/default", state: "complete", instances: descriptors,
}])

export const mixedInstanceCatalog = (instances = true): CombinedGuideCatalog => {
  const catalog = firstmateCatalog(instances)
  const { orchestration: _orchestration, ...template } = catalog.native[0]!
  return {
    ...catalog,
    native: [
      { ...template, launcher: "cpx", harness: "copilot", commandPath: "/fixture/cpx" },
      ...catalog.native,
    ],
    sandbox: [{
      name: "container",
      description: "Static container template.",
      guide: template.guide,
      path: "/profiles/container",
      supportedPlatforms: ["linux/amd64"],
      harness: { kind: "claude", version: "latest" },
      resolutionPolicy: "floating",
      locallyResolved: false,
      releaseLockAvailable: true,
      resolvedVersion: "2.1.260",
      skillBundles: [],
      skillsMode: "floating",
      finalDigestLocked: false,
      skills: [],
      plugins: [],
      mcps: [],
      sandbox: true,
      headless: template.headless,
      locked: false,
      herdrCompatibility: template.herdrCompatibility,
    }],
  }
}

export const instancePage = (
  descriptors: ReadonlyArray<FirstmateInstanceDescriptorV1>,
  offset = 0,
  count = 32,
): string => {
  const profile = descriptors[0]!.profile
  const snapshotDigest = firstmateInstanceListSnapshotDigest(profile, descriptors)
  const page = descriptors.slice(offset, offset + count)
  const end = offset + page.length
  return JSON.stringify({
    schemaVersion: 1, profile, diagnostics: [], state: "page", instances: page,
    page: {
      snapshotDigest, offset, total: descriptors.length,
      nextCursor: end === descriptors.length ? null : firstmateInstanceListCursor({ schemaVersion: 1, snapshotDigest, offset: end }),
    },
  })
}

export const instanceFleet = (
  descriptor: FirstmateInstanceDescriptorV1,
  overrides: Partial<FirstmateFleetReadinessV1> = {},
): FirstmateFleetReadinessV1 => parseFirstmateFleetReadinessV1({
  schemaVersion: 1,
  identity: descriptor.reference === null ? null : {
    profile: descriptor.profile, instanceId: descriptor.reference.instanceId,
    home: `${descriptor.root}/home`, sourceRevision: firstmatePin,
  },
  runtime: descriptor.reference === null ? "missing" : "ready",
  backend: "tmux",
  supervisor: { state: "stopped", pid: null },
  activeWorkers: 0,
  prerequisites: [],
  consentRequired: false,
  actions: {
    start: { allowed: false, reason: "Requires confirmation." },
    recover: { allowed: false, reason: "Requires confirmation." },
    submit: { allowed: false, reason: "Admin does not submit tasks." },
  },
  preparation: { schemaVersion: 1, state: "ready", diagnostic: null, repairs: [], installation: null },
  ...overrides,
})

export const instanceInventory = (
  descriptor: FirstmateInstanceDescriptorV1,
  overrides: Partial<FirstmateFleetReadinessV1> = {},
): string => JSON.stringify({
  schemaVersion: 1, launcher: "fmx", harness: "firstmate", profile: descriptor.profile,
  readiness: descriptor.reference === null ? "not-setup" : "healthy",
  plugins: [], skills: { packageCount: 1, visibleCount: 2 }, mcps: [],
  fleet: instanceFleet(descriptor, overrides),
})
