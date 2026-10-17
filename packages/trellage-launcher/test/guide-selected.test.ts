import path from "node:path"
import { describe, expect, it } from "vitest"
import type { ProfileGuideV1 } from "@trellage/guide-core"

import { parseGuideCatalog, type CombinedGuideCatalog, type HeadlessCapabilitiesV1 } from "../src/guide-catalog.ts"
import { loadSelectedGuide, SelectedGuideError } from "../src/guide-selected.ts"
import { enrichNativeProfileList } from "../src/native-guide-list.ts"

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
          launcher: "codex",
          harness: "codex",
          name: "superpowers",
          description: "Native Codex Superpowers",
          commandPath: "/opt/trellage/codex/bin/trx",
          headless,
          sandbox: true,
          herdrCompatibility: { status: "supported" },
        },
        {
          launcher: "claude",
          harness: "claude",
          name: "social-media",
          description: "Native Claude Social Media",
          commandPath: "/opt/trellage/claude/bin/trx",
          headless,
          sandbox: false,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
    guideRoot,
  )
  return parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      native: JSON.parse(nativeList).profiles,
    }),
  )
}

describe("selected guide goal policy", () => {
  it("retains the authored policy through native list enrichment, JSON catalog parsing, and selected guide loading", async () => {
    const catalog = await authoredCatalog()
    const selected = await loadSelectedGuide(catalog, guideRoot, "native:codex/superpowers")

    expect(selected.guide).toEqual(catalog.native[0]?.guide)
    expect(selected.guide.goalExecution).toEqual({
      controller: "codex-goal",
      workflowIds: ["test-driven-development", "plan-then-execute-branch", "parallel-review-and-dispatch"],
    })
    expect(selected.body).toContain("Native Codex")
  })

  it("retains the migrated Claude goal policy through catalog parsing and selected guide loading", async () => {
    const catalog = await authoredCatalog()
    const selected = await loadSelectedGuide(catalog, guideRoot, "native:claude/social-media")

    expect(selected.guide).toEqual(catalog.native[1]?.guide)
    expect(selected.guide.goalExecution).toEqual({
      controller: "claude-goal",
      workflowIds: [
        "voice-builder",
        "post-writer",
        "post-scorer",
        "gemini-carousel",
        "niche-research",
        "content-matrix",
        "reels-scripting",
        "youtube-thumbnail",
        "pinned-comment",
      ],
    })
    expect(selected.body).toContain("Launch this profile with `trx run claude social-media`")
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
        loadSelectedGuide({ ...catalog, native: [{ ...entry, guide }] }, guideRoot, "native:codex/superpowers"),
      ).rejects.toThrow("Profile guide changed after catalog collection")
    }
  })
})
