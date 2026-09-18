import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  canonicalFirstmateInstanceJson,
  canonicalFirstmateJson,
  firstmateInstanceControlContextDigest,
  firstmateInstanceCreationPlanDigest,
  firstmateInstanceKey,
  firstmateInstanceLimits,
  firstmateInstanceListCursor,
  firstmateInstanceListSnapshotDigest,
  firstmateRuntimeVariantDigest,
  firstmateWorktreeBindingDigest,
  firstmateWorktreeGenerationDigest,
  parseFirstmateInstanceControlContextJson,
  parseFirstmateInstanceControlContextV1,
  parseFirstmateInstanceCreateResultV1,
  parseFirstmateInstanceCreationPlanJson,
  parseFirstmateInstanceCreationPlanV1,
  parseFirstmateInstanceDescriptorV1,
  parseFirstmateInstanceListCursorV1,
  parseFirstmateInstanceListResultV1,
  parseFirstmateInstanceLocatorRefreshResultV1,
  parseFirstmateInstanceName,
  parseFirstmateInstancePlanResultV1,
  parseFirstmateInstanceReferenceV1,
  parseFirstmateInstanceResolveResultV1,
  parseFirstmateInstanceTaskIdPrefix,
  parseFirstmateReceiptRequestV1,
  parseFirstmateRuntimeVariantV1,
  parseFirstmateWorktreeEvidenceV1,
  parseFirstmateWorktreeGenerationV1,
  sameFirstmateInstance,
  sameFirstmateWorktreeGeneration,
  validateFirstmateInstanceControlContextV1,
  validateFirstmateInstanceFleet,
  type FirstmateInstanceControlContextV1,
  type FirstmateInstanceCreateResultV1,
  type FirstmateInstanceListResultV1,
  type FirstmateInstancePlanResultV1,
  type FirstmateInstanceResolveResultV1,
  type FirstmateLegacyInstanceDescriptorV1,
  type FirstmateNamedInstanceDescriptorV1,
} from "../src/index.ts"

const examples: {
  descriptor: FirstmateNamedInstanceDescriptorV1
  legacyMissingIdentity: FirstmateLegacyInstanceDescriptorV1
  list: FirstmateInstanceListResultV1 & { state: "page" }
  listLastPage: FirstmateInstanceListResultV1 & { state: "page" }
  listStaleCursor: FirstmateInstanceListResultV1
  resolve: FirstmateInstanceResolveResultV1 & { state: "matched" }
  resolveBlocked: FirstmateInstanceResolveResultV1
  plan: FirstmateInstancePlanResultV1 & { state: "ready" }
  planBlocked: FirstmateInstancePlanResultV1
  create: FirstmateInstanceCreateResultV1
  createBlocked: FirstmateInstanceCreateResultV1
  createIncomplete: FirstmateInstanceCreateResultV1
  controlContext: FirstmateInstanceControlContextV1
  legacyControlContext: FirstmateInstanceControlContextV1
} = JSON.parse(readFileSync(new URL("./fixtures/firstmate-instances-v1.json", import.meta.url), "utf8"))

const { descriptor, legacyMissingIdentity, controlContext } = examples
const reference = descriptor.reference
const runtime = descriptor.runtime.required
const worktree = descriptor.worktree.evidence
const generation = worktree.generation
const plan = examples.plan.plan
const otherId = "33333333-3333-4333-8333-333333333333"
const movedWorktree = { ...worktree, locators: { ...worktree.locators, worktree: "/work/moved-alpha" } }
const movedDescriptor = { ...descriptor, worktree: { status: "bound" as const, evidence: movedWorktree } }

describe("immutable instance authority", () => {
  it("keeps labels and execution expectations outside the reference and grouping key", () => {
    expect(parseFirstmateInstanceReferenceV1(reference)).toEqual(reference)
    expect(canonicalFirstmateInstanceJson(reference)).toBe(
      '{"instanceId":"11111111-1111-4111-8111-111111111111","mode":"named","profile":"default","schemaVersion":1}',
    )
    const renamed = parseFirstmateInstanceDescriptorV1({ ...descriptor, name: "another-label" })
    expect(renamed.reference).toEqual(reference)
    expect(firstmateInstanceKey(reference)).toBe(`native:fmx/default:${reference.instanceId}`)
    const legacy = { ...reference, mode: "legacy" as const }
    expect(firstmateInstanceKey(legacy)).toBe(firstmateInstanceKey(reference))
    expect(sameFirstmateInstance(legacy, reference)).toBe(false)
    expect(sameFirstmateInstance(reference, { ...reference })).toBe(true)
    expect(sameFirstmateInstance(reference, { ...reference, profile: "pstack-workers" })).toBe(false)
    expect(sameFirstmateInstance(reference, { ...reference, instanceId: otherId })).toBe(false)
  })

  it("agrees with the saved fleet UUID/profile without changing its home/source authority", () => {
    const fleet = { profile: reference.profile, instanceId: reference.instanceId, home: "/state/old-home", sourceRevision: runtime.sourceRevision }
    expect(() => validateFirstmateInstanceFleet(reference, fleet)).not.toThrow()
    expect(() => validateFirstmateInstanceFleet(reference, { ...fleet, instanceId: otherId })).toThrow(/profile and UUID/)
    expect(() => validateFirstmateInstanceFleet(reference, { ...fleet, profile: "pstack-workers" })).toThrow(/profile and UUID/)
  })

  it.each([
    { schemaVersion: 2 }, { name: "alpha" }, { home: "/state/alpha" }, { mode: "automatic" },
    { instanceId: null }, { instanceId: "11111111-1111-1111-8111-111111111111" },
  ])("rejects changed or invented immutable authority %#", (change) => {
    expect(() => parseFirstmateInstanceReferenceV1({ ...reference, ...change })).toThrow()
  })

  it("bounds names and reserves legacy and all UUID-shaped aliases", () => {
    for (const name of ["alpha", "alpha-2", "7", "a".repeat(64)]) expect(parseFirstmateInstanceName(name)).toBe(name)
    for (const name of ["legacy", reference.instanceId, "deadbeef-0000-0000-0000-0123456789ab", "Upper", " alpha", "a/b", "a_b", "-a", "a--b", "a".repeat(65)]) {
      expect(() => parseFirstmateInstanceName(name)).toThrow()
    }
  })

  it("keeps the named namespace disjoint from legacy with a 55-character task suffix", () => {
    expect(parseFirstmateInstanceTaskIdPrefix("fi012abc")).toBe("fi012abc")
    expect(`fi012abc-${"x".repeat(firstmateInstanceLimits.taskSuffixChars)}`).toHaveLength(64)
    for (const prefix of ["fmd", "fmp", "fi012ab", "fi012ABc", "fi012abc0", "fi012abg", "fi012abc-"]) {
      expect(() => parseFirstmateInstanceTaskIdPrefix(prefix)).toThrow()
    }
  })
})

describe("runtime and filesystem generation integrity", () => {
  it("matches independent Python canonical digests for every integrity layer", () => {
    expect(firstmateRuntimeVariantDigest(runtime)).toBe("368a94f5d57daee96e47625ee118f5a2a02c9a56f77a5b2f8eee15cbc0745d00")
    expect(firstmateWorktreeGenerationDigest(generation)).toBe("4835a964b26e80cd40be5ec6e228f58c18fede1ccbaec8c02dd403fd500c82cd")
    expect(firstmateWorktreeBindingDigest(worktree)).toBe("189c0418203778696c2e5ad22c7a70006cd5f936b770a3c69ef95ae068ae9856")
    for (const field of ["baseManifestDigest", "supplementManifestDigest", "effectiveContentDigest"] as const) {
      expect(firstmateRuntimeVariantDigest({ ...runtime, [field]: "f".repeat(64) })).not.toBe(firstmateRuntimeVariantDigest(runtime))
    }
    expect(firstmateRuntimeVariantDigest({ ...runtime, sourceRevision: "f".repeat(40) })).not.toBe(firstmateRuntimeVariantDigest(runtime))
  })

  it("requires explicit named runtime evidence, not base-only or namespaceSafe claims", () => {
    expect(parseFirstmateRuntimeVariantV1(runtime)).toEqual(runtime)
    const { supplementManifestDigest: _supplement, ...baseOnly } = runtime
    expect(() => parseFirstmateRuntimeVariantV1(baseOnly)).toThrow(/missing required/)
    for (const change of [{ variant: "legacy" }, { schemaVersion: 2 }, { namespaceSafe: true }, { sourceRevision: "HEAD" }]) {
      expect(() => parseFirstmateRuntimeVariantV1({ ...runtime, ...change })).toThrow()
    }
  })

  it("preserves large filesystem IDs and rejects unavailable or lossy generation evidence", () => {
    expect(parseFirstmateWorktreeEvidenceV1(worktree)).toEqual(worktree)
    expect(parseFirstmateWorktreeGenerationV1(generation).worktree.inode).toBe("9007199254740993")
    const maximum = { ...generation, worktree: { device: "0", inode: "9".repeat(40), birthtimeNs: "9".repeat(40) } }
    expect(parseFirstmateWorktreeGenerationV1(maximum)).toEqual(maximum)
    for (const inode of [9007199254740993, "01", "-1", "1e12", "1.5", "0", "9".repeat(41)]) {
      expect(() => parseFirstmateWorktreeGenerationV1({ ...generation, worktree: { ...generation.worktree, inode } })).toThrow()
    }
    expect(() => parseFirstmateWorktreeGenerationV1({ ...generation, worktree: { ...generation.worktree, birthtimeNs: "0" } })).toThrow(/positive/)
    expect(() => parseFirstmateWorktreeEvidenceV1({ ...worktree, generationDigest: "f".repeat(64) })).toThrow(/canonical generation/)
  })

  it("separates relocation from generation and rejects directory replacement at the same path", () => {
    expect(parseFirstmateWorktreeEvidenceV1(movedWorktree)).toEqual(movedWorktree)
    expect(sameFirstmateWorktreeGeneration(worktree, movedWorktree)).toBe(true)
    expect(firstmateWorktreeBindingDigest(movedWorktree)).not.toBe(firstmateWorktreeBindingDigest(worktree))
    for (const directory of ["worktree", "privateGitDir", "commonGitDir"] as const) {
      const changed = { ...generation, [directory]: { ...generation[directory], birthtimeNs: "1789200000000009999" } }
      const replaced = { ...worktree, generation: changed, generationDigest: firstmateWorktreeGenerationDigest(changed) }
      expect(parseFirstmateWorktreeEvidenceV1(replaced)).toEqual(replaced)
      expect(sameFirstmateWorktreeGeneration(worktree, replaced)).toBe(false)
      expect(firstmateWorktreeBindingDigest(replaced)).not.toBe(firstmateWorktreeBindingDigest(worktree))
    }
    for (const extra of [{ head: "a".repeat(40) }, { branch: "main" }, { dirty: false }]) {
      expect(() => parseFirstmateWorktreeEvidenceV1({ ...worktree, ...extra })).toThrow(/unsupported/)
    }
  })

  it("bounds canonical locators without accepting path normalization as generation proof", () => {
    const atLimit = { ...worktree, locators: { ...worktree.locators, worktree: `/${"w".repeat(4095)}` } }
    expect(parseFirstmateWorktreeEvidenceV1(atLimit)).toEqual(atLimit)
    for (const worktreePath of ["relative", "/work/../other", "/work/alpha/", `/work/${"w".repeat(4096)}`, worktree.locators.privateGitDir]) {
      expect(() => parseFirstmateWorktreeEvidenceV1({ ...worktree, locators: { ...worktree.locators, worktree: worktreePath } })).toThrow()
    }
    expect(() => parseFirstmateWorktreeEvidenceV1({
      ...worktree, locators: { ...worktree.locators, privateGitDir: worktree.locators.commonGitDir },
    })).toThrow(/two generations/)
  })
})

describe("bounded instance discovery", () => {
  it("preserves an explicit legacy recovery row without inventing an execution reference", () => {
    expect(parseFirstmateInstanceDescriptorV1(legacyMissingIdentity)).toEqual(legacyMissingIdentity)
    expect(() => parseFirstmateInstanceReferenceV1(legacyMissingIdentity.reference)).toThrow()
    expect(() => parseFirstmateInstanceDescriptorV1({ ...legacyMissingIdentity, creationState: "published" })).toThrow(/setup identity/)
    expect(() => parseFirstmateInstanceDescriptorV1({ ...legacyMissingIdentity, diagnostics: [] })).toThrow(/missing-identity/)
    expect(() => parseFirstmateInstanceDescriptorV1({
      ...legacyMissingIdentity, reference: examples.legacyControlContext.reference,
    })).toThrow(/setup identity/)
    const legacy = { ...legacyMissingIdentity, creationState: "published", reference: examples.legacyControlContext.reference, diagnostics: [] }
    expect(parseFirstmateInstanceDescriptorV1(legacy)).toEqual(legacy)
    expect(() => parseFirstmateInstanceDescriptorV1({ ...legacy, worktree: descriptor.worktree })).toThrow()
  })

  it("requires a cross-checked named descriptor and retains lost published identity as a failure", () => {
    expect(parseFirstmateInstanceDescriptorV1(descriptor)).toEqual(descriptor)
    const missing = { ...descriptor, creationState: "missing-identity", diagnostics: legacyMissingIdentity.diagnostics }
    expect(parseFirstmateInstanceDescriptorV1(missing).reference).toEqual(reference)
    for (const change of [
      { profile: "pstack-workers" }, { name: "legacy" }, { root: "/state/firstmate/instances/alpha" },
      { reference: null }, { worktree: legacyMissingIdentity.worktree }, { runtime: { state: "verified", namespaceSafe: true } },
    ]) expect(() => parseFirstmateInstanceDescriptorV1({ ...descriptor, ...change })).toThrow()
  })

  it("walks explicit complete-snapshot pages and detects stale cursors without returning partial success", () => {
    const first = parseFirstmateInstanceListResultV1(examples.list)
    const last = parseFirstmateInstanceListResultV1(examples.listLastPage)
    expect(first).toEqual(examples.list)
    expect(last).toEqual(examples.listLastPage)
    const snapshotDigest = firstmateInstanceListSnapshotDigest("default", [legacyMissingIdentity, descriptor])
    expect(snapshotDigest).toBe("b3a5de73b8e2f821f02792a77bf54c0186eff22261511ad74c03b2532295486d")
    expect(firstmateInstanceListSnapshotDigest("default", [legacyMissingIdentity, { ...descriptor, name: "new-label" }])).not.toBe(snapshotDigest)
    expect(parseFirstmateInstanceListCursorV1(examples.list.page.nextCursor)).toEqual({ schemaVersion: 1, snapshotDigest, offset: 1 })
    expect(firstmateInstanceListCursor({ schemaVersion: 1, snapshotDigest, offset: 1 })).toBe(examples.list.page.nextCursor)
    expect(parseFirstmateInstanceListResultV1(examples.listStaleCursor)).toEqual(examples.listStaleCursor)
    expect(() => parseFirstmateInstanceListResultV1({ ...examples.listStaleCursor, instances: [descriptor] })).toThrow(/0 to 0/)
    expect(() => parseFirstmateInstanceListResultV1({ ...examples.listStaleCursor, diagnostics: [] })).toThrow()
  })

  it.each([
    { nextCursor: null }, { nextCursor: `v1.${"e".repeat(64)}.1` }, { nextCursor: `v1.${"d".repeat(64)}.0` },
    { total: 0 }, { total: 1_000_001 }, { offset: 0.5 }, { total: 2, complete: true },
  ])("rejects truncated, contradictory, or unbounded pagination %#", (change) => {
    expect(() => parseFirstmateInstanceListResultV1({ ...examples.list, page: { ...examples.list.page, ...change } })).toThrow()
  })

  it("rejects repeated identities, cross-profile pages, and pages that cannot advance", () => {
    const single = { ...examples.listLastPage, page: { ...examples.listLastPage.page, offset: 0, total: 1 } }
    expect(() => parseFirstmateInstanceListResultV1({ ...single, instances: [] })).toThrow(/progress/)
    expect(() => parseFirstmateInstanceListResultV1({ ...single, profile: "pstack-workers" })).toThrow(/requested profile/)
    expect(() => parseFirstmateInstanceListResultV1({
      ...single, instances: [descriptor, descriptor], page: { ...single.page, total: 2 },
    })).toThrow(/unique/)
    expect(() => parseFirstmateInstanceListResultV1({
      ...single, instances: Array.from({ length: 33 }, () => descriptor), page: { ...single.page, total: 33 },
    })).toThrow(/0 to 32/)
    expect(() => firstmateInstanceListSnapshotDigest("default", [descriptor, legacyMissingIdentity])).toThrow(/ordered/)
    for (const cursor of [`v1.${"d".repeat(64)}.01`, `v1.${"d".repeat(64)}.1000001`, `v2.${"d".repeat(64)}.1`, "x".repeat(81)]) {
      expect(() => parseFirstmateInstanceListCursorV1(cursor)).toThrow()
    }
  })

  it("matches only an exact owned worktree binding and exposes unavailable generation as blocked", () => {
    expect(parseFirstmateInstanceResolveResultV1(examples.resolve)).toEqual(examples.resolve)
    expect(parseFirstmateInstanceResolveResultV1(examples.resolveBlocked)).toEqual(examples.resolveBlocked)
    const notFound = { ...examples.resolve, state: "not-found", descriptor: null }
    expect(parseFirstmateInstanceResolveResultV1(notFound)).toEqual(notFound)
    expect(() => parseFirstmateInstanceResolveResultV1({ ...notFound, worktree: null })).toThrow(/reliable/)
    expect(() => parseFirstmateInstanceResolveResultV1({ ...examples.resolve, worktree: movedWorktree })).toThrow(/exact current/)
    expect(() => parseFirstmateInstanceResolveResultV1({ ...examples.resolve, descriptor: legacyMissingIdentity })).toThrow(/named/)
    expect(() => parseFirstmateInstanceResolveResultV1({ ...examples.resolveBlocked, descriptor })).toThrow(/proved match/)
  })
})

describe("creation approval and same-UUID reconciliation", () => {
  it("binds the entire read-only plan to one stable canonical approval identity", () => {
    expect(parseFirstmateInstancePlanResultV1(examples.plan)).toEqual(examples.plan)
    expect(parseFirstmateInstanceCreationPlanV1(plan)).toEqual(plan)
    expect(firstmateInstanceCreationPlanDigest(plan)).toBe("1233e985473b707cd627e86bcbf3c02b7fc18371ce20d2e559b3bde9d63ea6c5")
    const reversed = Object.fromEntries(Object.entries(plan).reverse())
    expect(parseFirstmateInstanceCreationPlanV1(reversed)).toEqual(plan)
    for (const change of [{ name: "other-name" }, { taskIdPrefix: "fi654321" }, { worktree: movedWorktree }]) {
      expect(firstmateInstanceCreationPlanDigest({ ...plan, ...change })).not.toBe(plan.approvalDigest)
      expect(() => parseFirstmateInstanceCreationPlanV1({ ...plan, ...change })).toThrow(/complete canonical/)
    }
    expect(parseFirstmateInstancePlanResultV1(examples.planBlocked)).toEqual(examples.planBlocked)
    expect(() => parseFirstmateInstancePlanResultV1({ ...examples.planBlocked, plan })).toThrow(/must be null/)
  })

  it("does not extend creation approval to packages, other instance roots, or task execution", () => {
    for (const change of [
      { installConsent: true }, { start: true }, { originalIntent: "Submit this note" },
      { sourceRevision: "f".repeat(40) }, { destination: `/state/firstmate/instances/${otherId}` },
      { permittedWrites: [{ kind: "instance-root", path: descriptor.root }, { kind: "registry-locks", path: "/state/packages" }] },
      { permittedWrites: [...plan.permittedWrites, { kind: "package-cache", path: "/state/packages" }] },
    ]) expect(() => parseFirstmateInstanceCreationPlanV1({ ...plan, ...change })).toThrow()
    expect(() => parseFirstmateInstancePlanResultV1({ ...examples.plan, profile: "pstack-workers" })).toThrow(/requested profile/)
  })

  it("reconciles successful, interrupted, and refused creation with the original UUID and plan", () => {
    expect(parseFirstmateInstanceCreateResultV1(examples.create, plan)).toEqual(examples.create)
    const retry = { ...examples.create, state: "existing" }
    expect(parseFirstmateInstanceCreateResultV1(retry, plan)).toEqual(retry)
    expect(parseFirstmateInstanceCreateResultV1(examples.createBlocked, plan)).toEqual(examples.createBlocked)
    expect(parseFirstmateInstanceCreateResultV1(examples.createIncomplete, plan)).toEqual(examples.createIncomplete)
    expect(() => parseFirstmateInstanceCreateResultV1({
      ...examples.create, reference: { ...reference, instanceId: otherId },
    }, plan)).toThrow(/same planned UUID/)
    expect(() => parseFirstmateInstanceCreateResultV1({ ...examples.create, approvalDigest: "f".repeat(64) }, plan)).toThrow(/approval digest/)
    expect(() => parseFirstmateInstanceCreateResultV1({ ...examples.create, descriptor: null }, plan)).toThrow(/published/)
  })

  it("rejects successful-looking creation with a changed namespace, runtime, binding, or creation state", () => {
    for (const change of [
      { name: "another-name" }, { taskIdPrefix: "fiabcdef" }, { worktree: movedDescriptor.worktree },
      { runtime: { ...descriptor.runtime, state: "drift" } },
      { runtime: { ...descriptor.runtime, required: { ...runtime, effectiveContentDigest: "f".repeat(64) } } },
      { creationState: "creating", diagnostics: [{ code: "creation-incomplete", message: "Interrupted creation." }] },
    ]) {
      expect(() => parseFirstmateInstanceCreateResultV1({ ...examples.create, descriptor: { ...descriptor, ...change } }, plan)).toThrow()
    }
    expect(() => parseFirstmateInstanceCreateResultV1({ ...examples.createIncomplete, diagnostics: [] }, plan)).toThrow()
  })
})

describe("control context, provenance, and locator refresh", () => {
  it("keeps confirmed entry binding outside task authority and binds fresh control expectations", () => {
    expect(parseFirstmateInstanceControlContextV1(controlContext)).toEqual(controlContext)
    expect(firstmateInstanceControlContextDigest(controlContext)).toBe("ad9af9c01ab773693d5570fa4eacaf8932b53a2d0f5af723037586474045af99")
    expect(() => validateFirstmateInstanceControlContextV1(controlContext, descriptor)).not.toThrow()
    const join = { ...controlContext, selection: "confirmed-join" as const, entryWorktree: null }
    expect(parseFirstmateInstanceControlContextV1(join)).toEqual(join)
    expect(firstmateInstanceControlContextDigest(join)).not.toBe(firstmateInstanceControlContextDigest(controlContext))
    expect(() => validateFirstmateInstanceControlContextV1(join, descriptor)).not.toThrow()
    expect(() => parseFirstmateInstanceControlContextV1({ ...controlContext, entryWorktree: movedWorktree })).toThrow(/confirmed-join/)
    expect(() => parseFirstmateInstanceControlContextV1({ ...controlContext, projectTarget: null })).toThrow(/unsupported/)
    expect(() => parseFirstmateInstanceControlContextV1({ ...controlContext, expectedRuntimeDigest: null })).toThrow(/explicit runtime/)
  })

  it("requires current binding/runtime agreement for control, but not receipt reads", () => {
    for (const current of [
      movedDescriptor,
      { ...descriptor, worktree: { ...descriptor.worktree, status: "missing" as const } },
      { ...descriptor, runtime: { ...descriptor.runtime, required: { ...runtime, supplementManifestDigest: "f".repeat(64) } } },
    ]) expect(() => validateFirstmateInstanceControlContextV1(controlContext, current)).toThrow(/current valid binding/)
    expect(() => validateFirstmateInstanceControlContextV1(examples.legacyControlContext, legacyMissingIdentity)).toThrow(/owned instance/)
    expect(() => validateFirstmateInstanceControlContextV1(controlContext, {
      ...descriptor, creationState: "missing-identity", diagnostics: legacyMissingIdentity.diagnostics,
    })).toThrow(/reconcile creation or missing identity/)
    const receipt = {
      schemaVersion: 1 as const, requestId: otherId,
      expectedFleet: { profile: reference.profile, instanceId: reference.instanceId, home: "/missing/home", sourceRevision: runtime.sourceRevision },
    }
    expect(parseFirstmateReceiptRequestV1(receipt)).toEqual(receipt)
    expect(canonicalFirstmateJson(receipt)).not.toContain("worktree")
  })

  it("uses an explicit legacy join without inventing named runtime or worktree expectations", () => {
    const legacy = examples.legacyControlContext
    expect(parseFirstmateInstanceControlContextV1(legacy)).toEqual(legacy)
    expect(() => parseFirstmateInstanceControlContextV1({ ...legacy, selection: "entry-match" })).toThrow(/confirmed join/)
    expect(() => parseFirstmateInstanceControlContextV1({ ...legacy, expectedBindingDigest: controlContext.expectedBindingDigest })).toThrow(/without named/)
    expect(() => parseFirstmateInstanceControlContextV1({ ...legacy, reference: null })).toThrow()
    expect(() => validateFirstmateInstanceControlContextV1(legacy, {
      ...legacyMissingIdentity, reference: { ...legacy.reference, mode: "legacy" }, creationState: "published", diagnostics: [],
    })).not.toThrow()
  })

  it("returns only the refreshed descriptor and invalidates the old locator approval", () => {
    expect(parseFirstmateInstanceLocatorRefreshResultV1(movedDescriptor, descriptor)).toEqual(movedDescriptor)
    expect(movedDescriptor.reference).toEqual(descriptor.reference)
    expect(() => validateFirstmateInstanceControlContextV1(controlContext, movedDescriptor)).toThrow()
    const fresh = { ...controlContext, expectedBindingDigest: firstmateWorktreeBindingDigest(movedWorktree), entryWorktree: movedWorktree }
    expect(() => validateFirstmateInstanceControlContextV1(fresh, movedDescriptor)).not.toThrow()
    const changed = { ...generation, worktree: { ...generation.worktree, inode: "9007199254749999" } }
    const replacement = { ...worktree, generation: changed, generationDigest: firstmateWorktreeGenerationDigest(changed) }
    for (const change of [
      { taskIdPrefix: "fiabcdef" }, { name: "renamed" },
      { worktree: { status: "bound", evidence: replacement } },
      { worktree: { ...descriptor.worktree, status: "unverifiable" } },
    ]) expect(() => parseFirstmateInstanceLocatorRefreshResultV1({ ...descriptor, ...change }, descriptor)).toThrow()
  })
})

describe("closed creation and control envelopes", () => {
  it("bounds raw JSON before parsing, including otherwise harmless whitespace", () => {
    const creationJson = canonicalFirstmateInstanceJson(plan)
    const controlJson = canonicalFirstmateInstanceJson(controlContext)
    expect(parseFirstmateInstanceCreationPlanJson(creationJson)).toEqual(plan)
    expect(parseFirstmateInstanceControlContextJson(controlJson)).toEqual(controlContext)
    expect(parseFirstmateInstanceCreationPlanJson(`${creationJson}\n`)).toEqual(plan)
    for (const [source, parse] of [
      [creationJson, parseFirstmateInstanceCreationPlanJson],
      [controlJson, parseFirstmateInstanceControlContextJson],
    ] as const) {
      expect(() => parse(`${source}${" ".repeat(65536)}`)).toThrow(/65536 input bytes/)
      expect(() => parse("{")).toThrow(/valid JSON/)
    }
  })

  it("enforces the exact 64KiB canonical byte bound rather than JavaScript string length", () => {
    const diagnostics = Array.from({ length: 6 }, (_, index) => ({
      code: "unsafe-state" as const, message: index < 5 ? "é".repeat(2000) : "x",
    }))
    const blocked = { schemaVersion: 1 as const, profile: "default", state: "blocked" as const, plan: null, diagnostics }
    const remaining = 65536 - Buffer.byteLength(canonicalFirstmateInstanceJson(blocked), "utf8")
    diagnostics[5] = { code: "unsafe-state", message: `x${"é".repeat(Math.floor(remaining / 6))}${"x".repeat(remaining % 6)}` }
    expect(Buffer.byteLength(canonicalFirstmateInstanceJson(blocked), "utf8")).toBe(65536)
    expect(parseFirstmateInstancePlanResultV1(blocked)).toEqual(blocked)
    diagnostics[5] = { ...diagnostics[5]!, message: `${diagnostics[5]!.message}x` }
    expect(() => parseFirstmateInstancePlanResultV1(blocked)).toThrow(/65536 serialized bytes/)
    expect(() => parseFirstmateInstancePlanResultV1({ ...examples.planBlocked, diagnostics: [{ code: "unsafe-state", message: "x".repeat(2001) }] })).toThrow(/2000/)
    expect(() => parseFirstmateInstancePlanResultV1({ ...examples.planBlocked, diagnostics: Array.from({ length: 17 }, () => ({ code: "unsafe-state", message: "Blocked." })) })).toThrow(/16 entries/)
  })
})
