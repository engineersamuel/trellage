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
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [
        {
          launcher: "cpx",
          harness: "copilot",
          name: "hve",
          description: "Copilot native launcher.",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/cpx/bin/cpx",
        },
        {
          launcher: "cdx",
          harness: "codex",
          name: "pstack",
          description: "Codex native launcher.",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide,
          commandPath: "/opt/trellage/cdx/bin/cdx",
        },
      ],
      sandbox: [
        {
          name: "prime-agent",
          description: "Sandboxed prime agent profile.",
          guide,
          path: "/profiles/prime-agent",
          supportedPlatforms: ["linux/amd64"],
          harness: { kind: "copilot", version: "1.0.0" },
          resolutionPolicy: "floating",
          locallyResolved: false,
          releaseLockAvailable: true,
          resolvedVersion: "1.0.70",
          skillBundles: [],
          skillsMode: "floating",
          finalDigestLocked: false,
          skills: [],
          plugins: [],
          mcps: [],
          sandbox: true,
          headless,
          locked: false,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
  )

const fixtureCatalogWithClaudeSandbox = () =>
  parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [],
      sandbox: [
        {
          name: "claude-blog",
          description: "Sandboxed Claude profile.",
          guide,
          path: "/profiles/claude-blog",
          supportedPlatforms: ["linux/amd64"],
          harness: { kind: "claude", version: "latest" },
          resolutionPolicy: "floating",
          locallyResolved: false,
          releaseLockAvailable: true,
          resolvedVersion: null,
          skillBundles: [],
          skillsMode: "floating",
          finalDigestLocked: false,
          skills: [],
          plugins: [],
          mcps: [],
          sandbox: true,
          headless,
          locked: false,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
  )

describe("nativeLauncherCapabilities", () => {
  it("marks every native launcher, including cdx, as supporting doctor/inventory", () => {
    for (const launcher of ["agx", "cpx", "cdx", "cldx", "fmx", "grx", "jcx", "omp", "picx", "prx"]) {
      expect(nativeLauncherCapabilities(launcher)).toMatchObject({ doctorSupported: true, inventorySupported: true })
    }
  })

  it("marks every native launcher except agx and cldx as supporting update --check", () => {
    for (const launcher of ["cpx", "cdx", "fmx", "grx", "jcx", "omp", "picx", "prx"]) {
      expect(nativeLauncherCapabilities(launcher).updateCheckSupported).toBe(true)
    }
    expect(nativeLauncherCapabilities("agx").updateCheckSupported).toBe(false)
    expect(nativeLauncherCapabilities("cldx").updateCheckSupported).toBe(false)
  })

  it("supports profile-scoped Firstmate harness versions but not Agency", () => {
    expect(nativeLauncherCapabilities("fmx").harnessVersionSupported).toBe(true)
    expect(nativeLauncherCapabilities("agx").harnessVersionSupported).toBe(false)
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
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.ref)).toEqual(["native:cpx/hve", "native:cdx/pstack", "sandbox:prime-agent"])
  })

  it("marks a sandbox profile as not supporting inventory (the sandbox launcher has no `inventory` subcommand)", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const sandbox = entries.find((entry) => entry.ref === "sandbox:prime-agent")
    expect(sandbox).toMatchObject({
      doctorSupported: true,
      inventorySupported: false,
      updateCheckSupported: false,
      harnessVersionSupported: true,
    })
  })

  it("marks every sandbox profile as supporting harness-version", () => {
    const entries = aggregateAdminProfiles(fixtureCatalogWithClaudeSandbox())
    const claudeSandbox = entries.find((entry) => entry.ref === "sandbox:claude-blog")
    expect(claudeSandbox).toMatchObject({ harnessVersionSupported: true })
  })

  it("projects a ready sandbox resolution as its installed harness version", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const sandbox = entries.find((entry) => entry.ref === "sandbox:prime-agent")
    expect(sandbox).toMatchObject({ version: "1.0.70", harnessVersionSelector: "1.0.0" })
    expect(entries.find((entry) => entry.surface === "native")?.harnessVersionSelector).toBeUndefined()
  })

  it("keeps a floating harness target separate from an unavailable installed version", () => {
    const entries = aggregateAdminProfiles(fixtureCatalogWithClaudeSandbox())
    expect(entries[0]).toMatchObject({ harnessVersionSelector: "latest" })
    expect(entries[0]?.version).toBeUndefined()
  })

  it("marks cdx as unknown until checked, the same as any other native launcher (it supports doctor/inventory)", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const cdx = entries.find((entry) => entry.ref === "native:cdx/pstack")
    expect(cdx).toMatchObject({ health: "unknown", install: "unknown", doctorSupported: true, stale: true })
  })

  it("marks profiles with no readiness input yet as unknown and stale", () => {
    const entries = aggregateAdminProfiles(fixtureCatalog())
    const cpx = entries.find((entry) => entry.ref === "native:cpx/hve")
    expect(cpx).toMatchObject({ health: "unknown", install: "unknown", stale: true })
  })

  it("reflects a healthy readiness result and clears staleness", () => {
    const readinessInputs: ReadonlyArray<AdminReadinessInput> = [
      {
        ref: "native:cpx/hve",
        result: { kind: ProfileReadinessKind.Ready, summary: "cpx/hve is healthy" },
        version: "1.2.3",
        checkedAt: 1000,
      },
    ]
    const entries = aggregateAdminProfiles(fixtureCatalog(), readinessInputs)
    const cpx = entries.find((entry) => entry.ref === "native:cpx/hve")
    expect(cpx).toMatchObject({ health: "healthy", install: "installed", stale: false, version: "1.2.3" })
  })

  it("isolates a malformed readiness result to only the affected profile", () => {
    const readinessInputs: ReadonlyArray<AdminReadinessInput> = [
      { ref: "native:cpx/hve", result: { malformed: true, diagnostic: "unexpected inventory shape" } },
      {
        ref: "sandbox:prime-agent",
        result: { kind: ProfileReadinessKind.Ready, summary: "prime-agent is valid" },
      },
    ]
    const entries = aggregateAdminProfiles(fixtureCatalog(), readinessInputs)
    const cpx = entries.find((entry) => entry.ref === "native:cpx/hve")
    const sandbox = entries.find((entry) => entry.ref === "sandbox:prime-agent")
    const cdx = entries.find((entry) => entry.ref === "native:cdx/pstack")
    expect(cpx).toMatchObject({ health: "malformed-output", install: "malformed-output" })
    expect(sandbox).toMatchObject({ health: "healthy", install: "installed" })
    expect(cdx).toMatchObject({ health: "unknown", install: "unknown" })
  })

  it("marks a blocked native result as not-installed when its diagnostic mentions not-setup", () => {
    const readinessInputs: ReadonlyArray<AdminReadinessInput> = [
      {
        ref: "native:cpx/hve",
        result: {
          kind: ProfileReadinessKind.Blocked,
          summary: "cpx/hve is not-setup",
          diagnostic: "Run cpx setup hve, then retry.",
        },
      },
    ]
    const entries = aggregateAdminProfiles(fixtureCatalog(), readinessInputs)
    expect(entries.find((entry) => entry.ref === "native:cpx/hve")).toMatchObject({
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
    await mkdir(path.join(root, "native", "cpx"), { recursive: true })
    await writeFile(
      path.join(root, "native", "cpx", "hve.md"),
      "---\nschemaVersion: 1\ncapabilities: [code-review]\nbestFor: [A, B]\navoidFor: [C, D]\nprerequisites: []\nworkflows:\n  - id: review\n    description: Review a diff.\n    examples: [one, two]\n    promptTemplate: 'Review: {{intent}}'\n---\nHello from the hve guide.\n",
      "utf8",
    )
    const result = await loadAdminProfileGuideBody(root, { surface: "native", launcher: "cpx", profile: "hve" })
    expect(result).toMatchObject({ available: true, body: "Hello from the hve guide." })
  })

  it("returns an explicit unavailable result, not a thrown exception, for a missing guide file", async () => {
    const result = await loadAdminProfileGuideBody(root, { surface: "native", launcher: "cpx", profile: "missing" })
    expect(result.available).toBe(false)
    if (!result.available) expect(result.reason).toContain("guide unavailable")
  })
})

describe("toProfileGuideIdentity", () => {
  it("builds a native identity, defaulting launcher to empty string when missing", () => {
    expect(
      toProfileGuideIdentity({
        ref: "native:cpx/hve",
        surface: "native",
        launcher: "cpx",
        name: "hve",
        description: "d",
        commandPath: "/bin/cpx",
        doctorSupported: true,
        inventorySupported: true,
        health: "healthy",
        install: "installed",
        stale: false,
        updateCheckSupported: true,
        harnessVersionSupported: true,
        updateCheckStale: false,
      }),
    ).toEqual({ surface: "native", launcher: "cpx", profile: "hve" })
  })

  it("builds a sandbox identity", () => {
    expect(
      toProfileGuideIdentity({
        ref: "sandbox:prime-agent",
        surface: "sandbox",
        name: "prime-agent",
        description: "d",
        commandPath: "/bin/trellage",
        doctorSupported: true,
        inventorySupported: true,
        health: "healthy",
        install: "installed",
        stale: false,
        updateCheckSupported: false,
        harnessVersionSupported: false,
        updateCheckStale: false,
      }),
    ).toEqual({ surface: "sandbox", profile: "prime-agent" })
  })
})
