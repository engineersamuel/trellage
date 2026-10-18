import path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfileGuide, type ProfileGuideV1 } from "@trellage/guide-core"

import type { CompositionCatalog } from "../src/composition-catalog.ts"
import { loadSelectedGuide } from "../src/guide-selected.ts"
import { compositionFixtureCatalog } from "./helpers/composition-catalog.ts"

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const guideRoot = path.join(repositoryRoot, "profile-guides")
const authoredCatalog = async (): Promise<CompositionCatalog> => {
  const [codex, claude] = await Promise.all([
    loadProfileGuide(guideRoot, { surface: "native", harness: "codex", profile: "superpowers" }),
    loadProfileGuide(guideRoot, { surface: "native", harness: "claude", profile: "social-media" }),
  ])
  return compositionFixtureCatalog([
    { harness: "codex", profile: "superpowers", description: "Native Codex Superpowers", guide: codex.guide },
    { harness: "claude", profile: "social-media", description: "Native Claude Social Media", guide: claude.guide },
  ])
}

describe("selected guide goal policy", () => {
  it("retains the authored policy through the composition catalog and selected guide loading", async () => {
    const catalog = await authoredCatalog()
    const selected = await loadSelectedGuide(catalog, guideRoot, "native:codex/superpowers")

    expect(selected.guide).toEqual(catalog.entries[0]?.guide)
    expect(selected.guide.goalExecution).toEqual({
      controller: "codex-goal",
      workflowIds: ["test-driven-development", "plan-then-execute-branch", "parallel-review-and-dispatch"],
    })
    expect(selected.body).toContain("Native Codex")
  })

  it("retains the migrated Claude goal policy through catalog parsing and selected guide loading", async () => {
    const catalog = await authoredCatalog()
    const selected = await loadSelectedGuide(catalog, guideRoot, "native:claude/social-media")

    expect(selected.guide).toEqual(catalog.entries[1]?.guide)
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
    const entry = catalog.entries[0]
    if (entry === undefined || entry.guide === null) throw new Error("Expected the authored Codex guide")
    const { goalExecution, ...withoutGoal } = entry.guide
    if (goalExecution === undefined) throw new Error("Expected the authored Codex goal policy")
    const projections: ReadonlyArray<ProfileGuideV1> = [
      withoutGoal,
      { ...withoutGoal, goalExecution: { ...goalExecution, controller: "claude-goal" } },
      { ...withoutGoal, goalExecution: { ...goalExecution, workflowIds: ["test-driven-development"] } },
    ]

    for (const guide of projections) {
      await expect(
        loadSelectedGuide({ ...catalog, entries: [{ ...entry, guide }] }, guideRoot, "native:codex/superpowers"),
      ).rejects.toThrow("Profile guide changed after catalog collection")
    }
  })
})
