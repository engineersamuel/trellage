import { describe, expect, it } from "vitest"
import {
  canonicalFirstmateJson,
  firstmateSubmissionDigest,
  parseFirstmateFleetIdentityV1,
  parseFirstmateFleetReadinessV1,
  parseFirstmateOrchestrationV1,
  parseFirstmatePreparationV1,
  parseFirstmatePrerequisiteInstallPlanV1,
  parseFirstmateReceiptRequestV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  parseGuideProjectTargetV1,
  sameFirstmateFleet,
  type FirstmateFleetIdentityV1,
  type FirstmateFleetReadinessV1,
  type FirstmatePreparationV1,
  type FirstmatePrerequisiteInstallPlanV1,
  type FirstmateSubmissionReceiptV1,
  type FirstmateSubmissionRequestV1,
  type GuideProjectTargetV1,
} from "../src/index.ts"

const fleet: FirstmateFleetIdentityV1 = {
  profile: "default",
  instanceId: "22222222-2222-4222-8222-222222222222",
  home: "/tmp/firstmate/default/home",
  sourceRevision: "527aa7c12d25aadbdf3cc56791f87ae71fca5280",
}

const request: FirstmateSubmissionRequestV1 = {
  schemaVersion: 1,
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedFleet: fleet,
  originalIntent: "  Keep \u00e9 \ud83d\ude80.\n",
  generatedSpec: "Report current fleet status.",
  workflowId: "review-fleet-status",
  projectTarget: null,
}

const project: GuideProjectTargetV1 = {
  schemaVersion: 1,
  projectName: null,
  source: { kind: "local", location: "/tmp/projects/chosen" },
  entryWorktree: "/tmp/projects/chosen",
  baseRevision: "a".repeat(40),
  dirty: true,
  dirtyChanges: "excluded",
}

const running: FirstmateFleetReadinessV1 = {
  schemaVersion: 1,
  identity: fleet,
  runtime: "ready",
  backend: "tmux",
  supervisor: { state: "running", pid: 12345 },
  activeWorkers: 2,
  prerequisites: [{ id: "tmux", ready: true, description: "tmux is available" }],
  consentRequired: false,
  actions: {
    start: { allowed: false, reason: "A supervisor is already running" },
    recover: { allowed: false, reason: "A supervisor is already running" },
    submit: { allowed: true, reason: null },
  },
}

const receipt: FirstmateSubmissionReceiptV1 = {
  schemaVersion: 1,
  requestId: request.requestId,
  digest: firstmateSubmissionDigest(request),
  fleet,
  state: "saved",
  noteId: request.requestId,
  announcement: "failed",
  supervisorState: "running",
  error: { code: "wake-failed", message: "The note is saved, but the supervisor could not be notified" },
}

const installation: FirstmatePrerequisiteInstallPlanV1 = {
  identity: "b".repeat(64),
  destination: "/tmp/firstmate/prerequisites/locked",
  tools: [{ name: "treehouse", version: "2.0.1" }],
  sources: ["The npm registry configured on this host", "Checksum-verified GitHub release assets"],
  statePaths: ["/tmp/owner/.no-mistakes"],
}

const preparation: FirstmatePreparationV1 = {
  schemaVersion: 1,
  state: "needs-consent",
  diagnostic: "Missing managed Firstmate tools: treehouse",
  repairs: ["Reused the verified installed toolchain"],
  installation,
}

describe("Firstmate preparation contracts", () => {
  it("requires an explicit supported preparation capability without changing older catalogs", () => {
    const catalog = {
      schemaVersion: 1,
      kind: "firstmate",
      sourceRevision: fleet.sourceRevision,
      taskIdPrefix: "fmd",
      workerPolicy: null,
      workerHarness: "claude",
      workerEfforts: ["high"],
      dispatchRules: "claude-single",
      submission: { schemaVersion: 1, maxRequestBytes: 524288 },
    }
    expect(parseFirstmateOrchestrationV1(catalog)).not.toHaveProperty("preparation")
    expect(parseFirstmateOrchestrationV1({
      ...catalog, preparation: { schemaVersion: 1 },
    }).preparation).toEqual({ schemaVersion: 1 })
    expect(() => parseFirstmateOrchestrationV1({
      ...catalog, preparation: { schemaVersion: 2 },
    })).toThrow(/must equal 1/)
    expect(() => parseFirstmateOrchestrationV1({
      ...catalog, preparation: { schemaVersion: 1, command: "/bin/sh" },
    })).toThrow(/unsupported/)
    expect(parseFirstmateOrchestrationV1(catalog)).toEqual(catalog)
    expect(parseFirstmateOrchestrationV1({
      ...catalog, instances: { schemaVersion: 1 },
    })).toEqual({ ...catalog, instances: { schemaVersion: 1 } })
    for (const instances of [null, { schemaVersion: 2 }, { schemaVersion: 1, namespaceSafe: true }]) {
      expect(() => parseFirstmateOrchestrationV1({ ...catalog, instances })).toThrow()
    }
  })

  it("preserves a bounded lock-bound installation plan and repair evidence", () => {
    expect(parseFirstmatePreparationV1(preparation)).toEqual(preparation)
    expect(parseFirstmateFleetReadinessV1({ ...running, preparation }).preparation).toEqual(preparation)
    expect(parseFirstmateFleetReadinessV1(running)).toEqual(running)
    expect(() => parseFirstmatePrerequisiteInstallPlanV1({
      ...installation, identity: "latest",
    })).toThrow(/hexadecimal/)
    expect(() => parseFirstmatePrerequisiteInstallPlanV1({
      ...installation, destination: "relative/cache",
    })).toThrow(/absolute/)
    expect(() => parseFirstmatePrerequisiteInstallPlanV1({
      ...installation, tools: [...installation.tools, ...installation.tools],
    })).toThrow(/unique tool names/)
    expect(() => parseFirstmatePrerequisiteInstallPlanV1({
      ...installation, sources: ["x".repeat(2001)],
    })).toThrow(/2000/)
    expect(() => parseFirstmatePrerequisiteInstallPlanV1({
      ...installation, command: ["install", "--yes"],
    })).toThrow(/unsupported/)
    const maximum = {
      ...installation,
      tools: Array.from({ length: 16 }, (_, index) => ({ name: `tool-${index}`, version: "v".repeat(128) })),
      sources: Array.from({ length: 8 }, () => "s".repeat(2000)),
      statePaths: Array.from({ length: 8 }, (_, index) => `/tmp/state-${index}`),
    }
    expect(parseFirstmatePrerequisiteInstallPlanV1(maximum)).toEqual(maximum)
    for (const [change, diagnostic] of [
      [{ tools: [] }, /1 to 16/],
      [{ tools: [...maximum.tools, { name: "extra-tool", version: "1" }] }, /1 to 16/],
      [{ tools: [{ name: "tool", version: "v".repeat(129) }] }, /128/],
      [{ sources: [] }, /1 to 8/],
      [{ sources: [...maximum.sources, "extra source"] }, /1 to 8/],
      [{ statePaths: [...maximum.statePaths, "/tmp/extra"] }, /0 to 8/],
      [{ statePaths: ["relative/state"] }, /absolute/],
    ] as const) {
      expect(() => parseFirstmatePrerequisiteInstallPlanV1({ ...installation, ...change })).toThrow(diagnostic)
    }
  })

  it("does not report preparation ready or request consent without the required evidence", () => {
    expect(() => parseFirstmatePreparationV1({
      ...preparation, diagnostic: null,
    })).toThrow(/diagnostic/)
    expect(() => parseFirstmatePreparationV1({
      ...preparation, installation: null,
    })).toThrow(/installation consent/)
    expect(() => parseFirstmatePreparationV1({
      ...preparation, state: "ready",
    })).toThrow(/must be null/)
    expect(parseFirstmatePreparationV1({
      ...preparation, state: "ready", installation: null, diagnostic: null,
    }).state).toBe("ready")
    const maximum = {
      ...preparation,
      diagnostic: "d".repeat(4000),
      repairs: Array.from({ length: 16 }, () => "r".repeat(512)),
    }
    expect(parseFirstmatePreparationV1(maximum)).toEqual(maximum)
    for (const [change, diagnostic] of [
      [{ diagnostic: "d".repeat(4001) }, /4000/],
      [{ repairs: [...maximum.repairs, "extra repair"] }, /0 to 16/],
      [{ repairs: ["r".repeat(513)] }, /512/],
    ] as const) {
      expect(() => parseFirstmatePreparationV1({ ...preparation, ...change })).toThrow(diagnostic)
    }
  })

  it("distinguishes unchecked prerequisites without accepting contradictory readiness", () => {
    const prerequisite = { id: "fleet-tools", ready: false, status: "not-checked", description: "Runtime repair is required first" }
    const result = parseFirstmateFleetReadinessV1({ ...running, prerequisites: [prerequisite] })
    expect(result.prerequisites[0]).toEqual(prerequisite)
    expect(() => parseFirstmateFleetReadinessV1({
      ...running, prerequisites: [{ ...prerequisite, ready: true }],
    })).toThrow(/must agree/)
    expect(() => parseFirstmateFleetReadinessV1({
      ...running, prerequisites: [{ ...prerequisite, status: "ready" }],
    })).toThrow(/must agree/)
  })
})

describe("Firstmate request identity", () => {
  it("preserves exact intent and matches the native sorted ASCII JSON digest", () => {
    const parsed = parseFirstmateSubmissionRequestV1(request)
    expect(parsed.originalIntent).toBe(request.originalIntent)
    expect(canonicalFirstmateJson(parsed)).toBe(
      '{"expectedFleet":{"home":"/tmp/firstmate/default/home","instanceId":"22222222-2222-4222-8222-222222222222","profile":"default","sourceRevision":"527aa7c12d25aadbdf3cc56791f87ae71fca5280"},"generatedSpec":"Report current fleet status.","originalIntent":"  Keep \\u00e9 \\ud83d\\ude80.\\n","projectTarget":null,"requestId":"11111111-1111-4111-8111-111111111111","schemaVersion":1,"workflowId":"review-fleet-status"}',
    )
    expect(canonicalFirstmateJson(parsed)).toContain("\\u00e9 \\ud83d\\ude80.\\n")
    expect(firstmateSubmissionDigest(parsed)).toBe("21ee5775cad4d6689948fb72f669918e4b023b05bac3509a128901d03c933822")
    expect(firstmateSubmissionDigest({ ...parsed, expectedFleet: { ...fleet } })).toBe(receipt.digest)
  })

  it("keeps legacy fleet, inventory, and receipt payloads unchanged and closed to instance metadata", () => {
    const lookup = { schemaVersion: 1 as const, requestId: request.requestId, expectedFleet: fleet }
    expect(parseFirstmateFleetIdentityV1(fleet)).toEqual(fleet)
    expect(parseFirstmateFleetReadinessV1(running)).toEqual(running)
    expect(parseFirstmateReceiptRequestV1(lookup)).toEqual(lookup)
    expect(canonicalFirstmateJson(lookup)).toBe(
      '{"expectedFleet":{"home":"/tmp/firstmate/default/home","instanceId":"22222222-2222-4222-8222-222222222222","profile":"default","sourceRevision":"527aa7c12d25aadbdf3cc56791f87ae71fca5280"},"requestId":"11111111-1111-4111-8111-111111111111","schemaVersion":1}',
    )
    const firstmateInstance = { schemaVersion: 1, profile: fleet.profile, instanceId: fleet.instanceId, mode: "legacy" }
    expect(() => parseFirstmateFleetIdentityV1({ ...fleet, firstmateInstance })).toThrow(/unsupported/)
    expect(() => parseFirstmateFleetReadinessV1({ ...running, firstmateInstance })).toThrow(/unsupported/)
    expect(() => parseFirstmateSubmissionRequestV1({ ...request, firstmateInstance })).toThrow(/unsupported/)
    expect(() => parseFirstmateReceiptRequestV1({ ...lookup, firstmateInstance })).toThrow(/unsupported/)
  })

  it("binds retry identity to the target, workflow, intent, specification, and owned fleet", () => {
    const variants: ReadonlyArray<FirstmateSubmissionRequestV1> = [
      { ...request, projectTarget: project },
      { ...request, workflowId: "watch-fleet-condition" },
      { ...request, originalIntent: "A new instruction" },
      { ...request, generatedSpec: "Watch the fleet instead" },
      { ...request, expectedFleet: { ...fleet, instanceId: "33333333-3333-4333-8333-333333333333" } },
    ]
    for (const variant of variants) expect(firstmateSubmissionDigest(variant)).not.toBe(receipt.digest)
    expect(sameFirstmateFleet(fleet, { ...fleet })).toBe(true)
    expect(sameFirstmateFleet(fleet, { ...fleet, profile: "pstack-workers" })).toBe(false)
    expect(sameFirstmateFleet(fleet, { ...fleet, sourceRevision: "b".repeat(40) })).toBe(false)
  })

  it("keeps the larger original intent separate from the final specification limit", () => {
    const maximum = { ...request, originalIntent: "i".repeat(60_000), generatedSpec: "s".repeat(8_000) }
    expect(parseFirstmateSubmissionRequestV1(maximum)).toEqual(maximum)
    expect(() => parseFirstmateSubmissionRequestV1({ ...maximum, generatedSpec: `${maximum.generatedSpec}s` }))
      .toThrow(/8000 characters/)
    expect(() => parseFirstmateSubmissionRequestV1({ ...maximum, originalIntent: `${maximum.originalIntent}i` }))
      .toThrow(/60000 characters/)
    expect(() => parseFirstmateSubmissionRequestV1({ ...request, originalIntent: "\ud800" }))
      .toThrow(/unpaired Unicode/)
  })
})

describe("confirmed Firstmate targets", () => {
  it("preserves the chosen source, immutable base, and excluded dirty changes", () => {
    expect(parseGuideProjectTargetV1(project)).toEqual(project)
    expect(() => parseGuideProjectTargetV1({ ...project, baseRevision: "HEAD" })).toThrow(/hexadecimal/)
    expect(() => parseGuideProjectTargetV1({ ...project, baseRevision: null })).toThrow(/resolved/)
    expect(() => parseGuideProjectTargetV1({ ...project, dirtyChanges: "copied" })).toThrow(/excluded/)
  })

  it("accepts a named registered project without inventing Git inspection facts", () => {
    const named = {
      schemaVersion: 1, projectName: "registered-app", source: null, entryWorktree: null,
      baseRevision: null, dirty: null, dirtyChanges: "excluded",
    }
    expect(parseGuideProjectTargetV1(named)).toEqual(named)
    expect(() => parseGuideProjectTargetV1({ ...named, projectName: null })).toThrow(/registered project/)
    expect(() => parseGuideProjectTargetV1({ ...named, entryWorktree: "/tmp/caller" })).toThrow(/inspection fields/)
  })

  it("preserves registered project spelling without admitting path or option names", () => {
    const named = {
      schemaVersion: 1, source: null, entryWorktree: null,
      baseRevision: null, dirty: null, dirtyChanges: "excluded",
    }
    for (const projectName of ["MyProject", "my_project", "my.project", "_local"]) {
      expect(parseGuideProjectTargetV1({ ...named, projectName }).projectName).toBe(projectName)
    }
    for (const projectName of ["..", "a/b", "a\\b", "two names", "-option"]) {
      expect(() => parseGuideProjectTargetV1({ ...named, projectName })).toThrow(/safe project basename/)
    }
  })

  it("rejects credential-bearing and non-Git sources before they enter a durable request", () => {
    for (const location of ["https://user:secret@example.com/repo", "https://example.com/repo?token=secret", "file:///tmp/repo"]) {
      expect(() => parseGuideProjectTargetV1({ ...project, source: { kind: "git", location } })).toThrow()
    }
    expect(parseGuideProjectTargetV1({
      ...project, source: { kind: "git", location: "git@example.com:team/repo.git" },
    }).source?.location).toBe("git@example.com:team/repo.git")
  })
})

describe("Firstmate action and receipt evidence", () => {
  it("permits submission to a running fleet without admitting another supervisor", () => {
    expect(parseFirstmateFleetReadinessV1(running).actions.submit.allowed).toBe(true)
    expect(() => parseFirstmateFleetReadinessV1({
      ...running, actions: { ...running.actions, start: { allowed: true, reason: null } },
    })).toThrow(/another running supervisor/)
  })

  it("refuses start or recovery when workers, consent, or runtime evidence disagree", () => {
    const start = {
      ...running,
      supervisor: { state: "stopped", pid: null },
      actions: { ...running.actions, start: { allowed: true, reason: null } },
    }
    expect(() => parseFirstmateFleetReadinessV1(start)).toThrow(/live workers require recovery/)
    expect(() => parseFirstmateFleetReadinessV1({ ...start, activeWorkers: 0, consentRequired: true }))
      .toThrow(/prior consent/)
    expect(() => parseFirstmateFleetReadinessV1({ ...running, runtime: "drift" }))
      .toThrow(/ready owned runtime/)
    expect(() => parseFirstmateFleetReadinessV1({ ...running, identity: null }))
      .toThrow(/ready owned runtime/)
  })

  it("keeps saved-note evidence separate from failed announcement and acknowledgement", () => {
    expect(parseFirstmateSubmissionReceiptV1(receipt)).toEqual(receipt)
    const handled = { ...receipt, state: "handled", announcement: "not-needed", error: null }
    expect(parseFirstmateSubmissionReceiptV1(handled).state).toBe("handled")
    expect(() => parseFirstmateSubmissionReceiptV1({ ...receipt, digest: null })).toThrow(/evidence/)
    expect(() => parseFirstmateSubmissionReceiptV1({ ...receipt, error: null })).toThrow(/announcement failure/)
    expect(() => parseFirstmateSubmissionReceiptV1({ ...receipt, state: "not-found" })).toThrow(/noteId/)
  })
})
