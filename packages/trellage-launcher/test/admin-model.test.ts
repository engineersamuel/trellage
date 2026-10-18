import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "@trellage/guide-core"
import type { CompositionCatalog, HeadlessCapabilitiesV1 } from "../src/composition-catalog.ts"
import { ProfileReadinessKind } from "../src/guide-preflight.ts"
import {
  aggregateAdminProfiles,
  loadAdminProfileGuideBody,
  nativeLauncherCapabilities,
  toProfileGuideIdentity,
  type AdminReadinessInput,
} from "../src/admin-model.ts"

const guide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["code-review"],
  bestFor: ["Reviewing pull requests", "Writing focused regression tests"],
  avoidFor: ["Long-running background jobs", "Unrelated content work"],
  prerequisites: [],
  workflows: [
    {
      id: "review",
      description: "Review a diff.",
      examples: ["Review my last commit", "Check this pull request"],
      promptTemplate: "Review the diff for: {{intent}}.",
    },
  ],
}

const headless: HeadlessCapabilitiesV1 = {
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

const fixtureCatalog = (): CompositionCatalog => ({
  schemaVersion: 2,
  entries: [
    {
      ref: "native:copilot/hve", harness: "copilot", profiles: ["hve"], kind: "preset", canonicalHarness: true,
      description: "Copilot native launcher.", headless, herdrCompatibility: { status: "supported" }, guide,
      commandPath: "/opt/trellage/copilot/bin/trx", lifecycle: { runtime: "cpx", profile: "hve" },
    },
    {
      ref: "native:codex/pstack", harness: "codex", profiles: ["pstack"], kind: "preset", canonicalHarness: true,
      description: "Codex native launcher.", headless, herdrCompatibility: { status: "supported" }, guide,
      commandPath: "/opt/trellage/codex/bin/trx", lifecycle: null,
    },
  ],
})

describe("nativeLauncherCapabilities", () => {
  it("exposes inventory for every canonical harness and lifecycle actions only for mapped rows", () => {
    for (const harness of ["agency", "copilot", "codex", "claude", "fx", "grok", "headlong", "jcode", "omp", "pi", "prime", "uji"]) {
      expect(nativeLauncherCapabilities(harness).inventorySupported).toBe(true)
    }
    expect(nativeLauncherCapabilities("copilot", { runtime: "cpx", profile: "hve" }).doctorSupported).toBe(true)
    expect(nativeLauncherCapabilities("grok", null).doctorSupported).toBe(false)
    expect(nativeLauncherCapabilities("uji", null).harnessVersionSupported).toBe(true)
    expect(nativeLauncherCapabilities("headlong", null).harnessVersionSupported).toBe(false)
  })

  it("fails closed for an unrecognized future native launcher", () => {
    expect(nativeLauncherCapabilities("futurex")).toEqual({
      doctorSupported: false,
      inventorySupported: false,
      updateCheckSupported: false,
      harnessVersionSupported: false,
    })
  })
})

describe("aggregateAdminProfiles", () => {
  it("produces one entry per catalog entry with no duplicates or omissions", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    expect(entries.map((entry) => entry.ref)).toEqual(["native:copilot/hve", "native:codex/pstack"])
  })

  it("isolates a malformed readiness result to only the affected profile", () => {
    const readinessInputs: ReadonlyArray<AdminReadinessInput> = [
      { ref: "native:copilot/hve", result: { malformed: true, diagnostic: "unexpected inventory shape" } },
    ]
    const entries = aggregateAdminProfiles(fixtureCatalog(), readinessInputs)
    expect(entries.find((entry) => entry.ref === "native:copilot/hve")).toMatchObject({ health: "malformed-output", install: "malformed-output" })
    expect(entries.find((entry) => entry.ref === "native:codex/pstack")).toMatchObject({ health: "unknown", install: "unknown" })
  })

  it("marks externally managed Codex unknown until inventory is requested", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const codex = entries.find((entry) => entry.ref === "native:codex/pstack")
    expect(codex).toMatchObject({ health: "unknown", install: "unknown", doctorSupported: false, stale: true })
  })

  it("marks profiles with no readiness input yet as unknown and stale", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const cpx = entries.find((entry) => entry.ref === "native:copilot/hve")
    expect(cpx).toMatchObject({ health: "unknown", install: "unknown", stale: true })
  })

  it("reflects a healthy readiness result and clears staleness", () => {
    const readinessInputs: ReadonlyArray<AdminReadinessInput> = [
      {
        ref: "native:copilot/hve",
        result: { kind: ProfileReadinessKind.Ready, summary: "copilot/hve is healthy" },
        version: "1.2.3",
        checkedAt: 1000,
      },
    ]
    const entries = aggregateAdminProfiles(fixtureCatalog(), readinessInputs)
    const cpx = entries.find((entry) => entry.ref === "native:copilot/hve")
    expect(cpx).toMatchObject({ health: "healthy", install: "installed", stale: false, version: "1.2.3" })
  })

  it("marks a blocked native result as not-installed when its diagnostic mentions not-setup", () => {
    const readinessInputs: ReadonlyArray<AdminReadinessInput> = [
      {
        ref: "native:copilot/hve",
        result: {
          kind: ProfileReadinessKind.Blocked,
          summary: "copilot/hve is not-setup",
          diagnostic: "Run cpx setup hve, then retry.",
        },
      },
    ]
    const entries = aggregateAdminProfiles(fixtureCatalog(), readinessInputs)
    expect(entries.find((entry) => entry.ref === "native:copilot/hve")).toMatchObject({
      health: "unhealthy",
      install: "not-installed",
    })
  })
})

describe("loadAdminProfileGuideBody", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "admin-guide-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("returns the exact on-disk Markdown body for a native identity", async () => {
    await mkdir(path.join(root, "native", "copilot"), { recursive: true })
    await writeFile(
      path.join(root, "native", "copilot", "hve.md"),
      "---\nschemaVersion: 1\ncapabilities: [code-review]\nbestFor: [A, B]\navoidFor: [C, D]\nprerequisites: []\nworkflows:\n  - id: review\n    description: Review a diff.\n    examples: [one, two]\n    promptTemplate: 'Review: {{intent}}'\n---\nHello from the hve guide.\n",
      "utf8",
    )
    const result = await loadAdminProfileGuideBody(root, { surface: "native", harness: "copilot", profile: "hve" })
    expect(result).toMatchObject({ available: true, body: "Hello from the hve guide." })
  })

  it("returns an explicit unavailable result, not a thrown exception, for a missing guide file", async () => {
    const result = await loadAdminProfileGuideBody(root, { surface: "native", harness: "copilot", profile: "missing" })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain("guide unavailable")
  })
})

describe("toProfileGuideIdentity", () => {
  it("builds a native harness identity", () => {
    expect(
      toProfileGuideIdentity({
        ref: "native:copilot/hve",
        surface: "native",
        launcher: "copilot",
        name: "hve",
        harness: "copilot",
        profiles: ["hve"],
        lifecycle: { runtime: "cpx", profile: "hve" },
        description: "d",
        commandPath: "/bin/trx",
        doctorSupported: true,
        inventorySupported: true,
        health: "healthy",
        install: "installed",
        stale: false,
        updateCheckSupported: true,
        harnessVersionSupported: true,
        updateCheckStale: false,
      }),
    ).toEqual({ surface: "native", harness: "copilot", profile: "hve" })
  })

})
