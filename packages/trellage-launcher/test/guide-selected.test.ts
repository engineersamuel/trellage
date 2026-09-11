import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfileGuide, type ProfileGuideV1 } from "../../trellage-guide-core/dist/index.js"

import { parseGuideCatalog, type CombinedGuideCatalog, type HeadlessCapabilitiesV1 } from "../src/guide-catalog.js"
import { loadSelectedGuide, SelectedGuideError, sandboxGuideRootFromProfilePath } from "../src/guide-selected.js"
import { enrichNativeProfileList } from "../src/native-guide-list.js"

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const guideRoot = path.join(repositoryRoot, "profile-guides")
const headless: HeadlessCapabilitiesV1 = {
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

const authoredCatalog = async (): Promise<CombinedGuideCatalog> => {
  const nativeList = await enrichNativeProfileList(
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          launcher: "cdx",
          harness: "codex",
          name: "superpowers",
          description: "Native Codex Superpowers",
          commandPath: "/opt/trellage/cdx/bin/cdx",
          headless,
          sandbox: true,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
    guideRoot,
  )
  const graph = await loadProfileGuide(guideRoot, { surface: "sandbox", profile: "claude-graph-of-loops" })
  return parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: JSON.parse(nativeList).profiles,
      sandbox: [
        {
          name: "claude-graph-of-loops",
          description: "Graph of Loops",
          guide: graph.guide,
          path: path.join(repositoryRoot, "profiles", "claude-graph-of-loops", "profile.toml"),
          supportedPlatforms: ["linux/arm64"],
          harness: { kind: "claude", version: "latest" },
          resolutionPolicy: "floating",
          locallyResolved: false,
          releaseLockAvailable: false,
          resolvedVersion: null,
          skillBundles: ["sandbox-common"],
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
}

describe("sandbox guide root derivation", () => {
  it("derives the owning worktree guide registry from a profile document", () => {
    expect(
      sandboxGuideRootFromProfilePath(
        path.join(path.sep, "repo", "profiles", "claude-social-media", "profile.toml"),
        "claude-social-media",
      ),
    ).toBe(path.join(path.sep, "repo", "profile-guides"))
  })

  it("rejects paths that do not match the selected profile identity", () => {
    expect(() =>
      sandboxGuideRootFromProfilePath(
        path.join(path.sep, "repo", "profiles", "other", "profile.toml"),
        "claude-social-media",
      ),
    ).toThrow(SelectedGuideError)
    expect(() =>
      sandboxGuideRootFromProfilePath("profiles/claude-social-media/profile.toml", "claude-social-media"),
    ).toThrow(SelectedGuideError)
  })
})

describe("selected guide goal policy", () => {
  it("retains the authored policy through native list enrichment, JSON catalog parsing, and selected guide loading", async () => {
    const catalog = await authoredCatalog()
    const selected = await loadSelectedGuide(catalog, guideRoot, "native:cdx/superpowers")

    expect(selected.guide).toEqual(catalog.native[0]?.guide)
    expect(selected.guide.goalExecution).toEqual({
      controller: "codex-goal",
      workflowIds: ["test-driven-development", "plan-then-execute-branch", "parallel-review-and-dispatch"],
    })
    expect(selected.body).toContain("Native Codex")
  })

  it("retains the Graph policy and all authored frames without making resume goal-eligible", async () => {
    const catalog = await authoredCatalog()
    const selected = await loadSelectedGuide(catalog, guideRoot, "sandbox:claude-graph-of-loops")

    expect(selected.guide).toEqual(catalog.sandbox[0]?.guide)
    expect(selected.guide.goalExecution).toEqual({
      controller: "graph-of-loops",
      workflowIds: [
        "implement-complex-change",
        "debug-cross-cutting-failure",
        "research-then-implement",
        "validate-existing-implementation",
      ],
    })
    expect(selected.guide.workflows.some(({ id }) => id === "inspect-or-resume-run")).toBe(true)
  })

  it("rejects a stale catalog when a goal policy is missing, its controller changes, or eligibility changes", async () => {
    const catalog = await authoredCatalog()
    const entry = catalog.native[0]!
    const { goalExecution, ...withoutGoal } = entry.guide
    if (goalExecution === undefined) throw new Error("Expected the authored Codex goal policy")
    const projections: ReadonlyArray<ProfileGuideV1> = [
      withoutGoal,
      { ...withoutGoal, goalExecution: { ...goalExecution, controller: "claude-goal" } },
      { ...withoutGoal, goalExecution: { ...goalExecution, workflowIds: ["test-driven-development"] } },
    ]

    for (const guide of projections) {
      await expect(
        loadSelectedGuide({ ...catalog, native: [{ ...entry, guide }] }, guideRoot, "native:cdx/superpowers"),
      ).rejects.toThrow("Profile guide changed after catalog collection")
    }
  })
})
