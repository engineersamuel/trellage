import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { ProfileGuideV1 } from "@trellage/guide-core"
import { parseGuideCatalog } from "../src/guide-catalog.ts"
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

const headless = {
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

const fixtureCatalog = () =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      native: [
        {
          launcher: "copilot",
          harness: "copilot",
          name: "hve",
          description: "Copilot native launcher.",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/copilot/bin/trx",
        },
        {
          launcher: "codex",
          harness: "codex",
          name: "pstack",
          description: "Codex native launcher.",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/codex/bin/trx",
        },
      ],
    }),
  )

describe("nativeLauncherCapabilities", () => {
  it("marks lifecycle-managed native launchers, including cdx, as supporting doctor/inventory", () => {
    for (const launcher of ["agency", "copilot", "codex", "claude", "firstmate", "fx", "jcode", "omp", "pi", "prime"]) {
      expect(nativeLauncherCapabilities(launcher)).toMatchObject({ doctorSupported: true, inventorySupported: true })
    }
    expect(nativeLauncherCapabilities("headlong")).toMatchObject({ doctorSupported: false, inventorySupported: false })
  })

  it("marks lifecycle-managed native launchers except agx and cldx as supporting update --check", () => {
    for (const launcher of ["copilot", "codex", "firstmate", "fx", "jcode", "omp", "pi", "prime"]) {
      expect(nativeLauncherCapabilities(launcher).updateCheckSupported).toBe(true)
    }
    expect(nativeLauncherCapabilities("agency").updateCheckSupported).toBe(false)
    expect(nativeLauncherCapabilities("claude").updateCheckSupported).toBe(false)
    expect(nativeLauncherCapabilities("headlong").updateCheckSupported).toBe(false)
  })

  it("supports Firstmate and Agency harness versions but not Headlong lifecycle checks", () => {
    expect(nativeLauncherCapabilities("firstmate").harnessVersionSupported).toBe(true)
    expect(nativeLauncherCapabilities("agency").harnessVersionSupported).toBe(true)
    expect(nativeLauncherCapabilities("headlong").harnessVersionSupported).toBe(false)
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

  it("marks cdx as unknown until checked, the same as any other native launcher (it supports doctor/inventory)", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const cdx = entries.find((entry) => entry.ref === "native:codex/pstack")
    expect(cdx).toMatchObject({ health: "unknown", install: "unknown", doctorSupported: true, stale: true })
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
    const result = await loadAdminProfileGuideBody(root, { surface: "native", launcher: "copilot", profile: "hve" })
    expect(result).toMatchObject({ available: true, body: "Hello from the hve guide." })
  })

  it("returns an explicit unavailable result, not a thrown exception, for a missing guide file", async () => {
    const result = await loadAdminProfileGuideBody(root, { surface: "native", launcher: "copilot", profile: "missing" })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain("guide unavailable")
  })
})

describe("toProfileGuideIdentity", () => {
  it("builds a native identity, defaulting launcher to empty string when missing", () => {
    expect(
      toProfileGuideIdentity({
        ref: "native:copilot/hve",
        surface: "native",
        launcher: "copilot",
        name: "hve",
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
    ).toEqual({ surface: "native", launcher: "copilot", profile: "hve" })
  })

})
