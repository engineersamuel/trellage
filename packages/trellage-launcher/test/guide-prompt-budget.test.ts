import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { loadProfileGuide, parseGuideProjectTargetV1 } from "@trellage/guide-core"
import { GuideEffort, runGuideGenerate } from "../src/guide-api.ts"
import { completeSinglePromptArtifact, prepareGuidePrompt } from "../src/guide-context.ts"
import type { GuideGenerateCandidate, GuideProvider } from "../src/guide-provider.ts"
import { enrichLiteralCandidate, runGuideGenerationStep, runGuideRefinementStep } from "../src/guide-ui.tsx"
import { renderWorkflowBodyCandidate, workflowPromptFrame } from "../src/guide-workflow-prompt.ts"
import {
  firstmateGuide,
  firstmateOrchestration,
  firstmateProjectC,
  firstmateRuntimeCatalog,
} from "./helpers/continuation-firstmate-fixtures.ts"

const guideRoot = fileURLToPath(new URL("../../../profile-guides", import.meta.url))
const boundaryCandidates = (budget: number | undefined): ReadonlyArray<GuideGenerateCandidate> => {
  if (budget === undefined) throw new Error("The model request has no body budget.")
  return ["A", "B", "C"].map((letter) => ({
    title: `Boundary ${letter}`, prompt: letter.repeat(budget), notes: "Exercise the exact output length boundary.",
  }))
}
const boundaryProvider = () => ({
  match: vi.fn<GuideProvider["match"]>(async () => { throw new Error("An explicit workflow must not re-match.") }),
  generate: vi.fn<GuideProvider["generate"]>(async ({ bodyBudget }) => ({ candidates: boundaryCandidates(bodyBudget) })),
  refine: vi.fn<GuideProvider["refine"]>(async ({ bodyBudget }) => ({ candidate: boundaryCandidates(bodyBudget)[0]! })),
  optimize: vi.fn<GuideProvider["optimize"]>(async ({ candidates }) => ({ candidates })),
})

describe("remaining guide prompt body budget", () => {
  it.each(["default", "pstack-workers"])("fits every authored %s workflow at its exact API and interactive body boundary", async (profile) => {
    const loaded = await loadProfileGuide(guideRoot, { surface: "native", launcher: "fmx", profile })
    const base = firstmateRuntimeCatalog()
    const catalog = {
      ...base,
      native: base.native.map((entry) => entry.launcher === "fmx" && entry.name === profile
        ? { ...entry, guide: loaded.guide, herdrCompatibility: { status: "untested" } }
        : entry),
    }
    const entry = catalog.native.find((candidate) => candidate.launcher === "fmx" && candidate.name === profile)!
    const location = "/fixture/project-\u{1f600}"
    const target = parseGuideProjectTargetV1({
      ...firstmateProjectC(), source: { kind: "local", location }, entryWorktree: location,
    })
    const originalIntent = "\u{1f600}".repeat(30_000)
    const profileRef = `native:fmx/${profile}`
    for (const workflow of loaded.guide.workflows) {
      const context = {
        originalIntent, projectTarget: workflow.scope === "fleet" ? null : target, orchestration: entry.orchestration!,
      }
      const prepared = prepareGuidePrompt(loaded.guide, workflow.id, profileRef, "Use the selected workflow.", context)
      const frame = workflowPromptFrame(prepared.workflow)
      const expectedBudget = 8000 - frame.beforeBody.length - frame.afterBody.length
      expect(prepared.bodyBudget).toBe(expectedBudget)
      expect(expectedBudget).toBeGreaterThan(0)
      const api = boundaryProvider()
      const generated = await runGuideGenerate(api, catalog, guideRoot, {
        ...context, intent: "Use the selected workflow.", profileRef, workflowId: workflow.id,
        model: "synthetic-model", effort: GuideEffort.Low,
      })
      for (const candidate of generated.candidates) {
        expect(candidate.prompt.length).toBe(8000)
        expect(candidate.command.args).toEqual([profile])
      }
      expect(generated.profile.herdrCompatibility.status).toBe("untested")
      expect(api.generate.mock.calls[0]?.[0].bodyBudget).toBe(expectedBudget)
      expect(api.optimize.mock.calls[0]?.[0].bodyBudget).toBe(expectedBudget)

      const ui = boundaryProvider()
      const recommendation = enrichLiteralCandidate(catalog, {
        profileRef, workflowId: workflow.id, confidence: 1,
        reason: "Explicit workflow selection.", tradeoff: "The new source has no live Herdr proof.",
      })
      const choices = await runGuideGenerationStep(
        catalog, guideRoot, ui, "Use the selected workflow.", recommendation,
        undefined, undefined, undefined, context,
      )
      for (const candidate of choices.candidates) expect(candidate.prompt.length).toBe(8000)
      const refined = await runGuideRefinementStep(
        catalog, ui, "Use the selected workflow.", recommendation, choices.guideDocument,
        choices.candidates, 0, "Keep the selected scope.", undefined, context,
      )
      expect(refined.prompt.length).toBe(8000)
      expect(ui.generate.mock.calls[0]?.[0].bodyBudget).toBe(expectedBudget)
      expect(ui.refine.mock.calls[0]?.[0].bodyBudget).toBe(expectedBudget)
      expect(ui.optimize.mock.calls.every(([input]) => input.bodyBudget === expectedBudget)).toBe(true)
      expect(ui.refine.mock.calls[0]?.[0].candidate.prompt.length).toBe(expectedBudget)
    }
  })

  it("also reserves the unchanged original appendix for one-prompt delivery", () => {
    const context = { originalIntent: "  Keep this exact scope.\r\n\u{1f600}  " }
    const prepared = prepareGuidePrompt(firstmateGuide, "review-project", "native:cdx/default", "Review.", context)
    const frame = workflowPromptFrame(prepared.workflow)
    const appendix = `\n\n## Original human intent (unchanged)\n\n${context.originalIntent}`
    expect(prepared.bodyBudget).toBe(8000 - frame.beforeBody.length - frame.afterBody.length - appendix.length)
    const candidate = renderWorkflowBodyCandidate(prepared.workflow, boundaryCandidates(prepared.bodyBudget)[0]!)
    const complete = completeSinglePromptArtifact(prepared.workflow, candidate, prepared.context)
    expect(complete.prompt.length).toBe(8000)
    expect(complete.prompt).toContain(context.originalIntent)
  })

  it("rejects an exhausted frame before generation or optimization", async () => {
    const base = firstmateRuntimeCatalog()
    const oversized = { ...firstmateGuide, workflows: [{
      ...firstmateGuide.workflows[0]!, promptTemplate: `${"F".repeat(8000)}{{intent}}`,
    }] }
    const provider = boundaryProvider()
    const prepared = () => prepareGuidePrompt(oversized, "review-project", "native:fmx/default", "Review.", {
      originalIntent: "Do not lose this input.", projectTarget: firstmateProjectC(), orchestration: firstmateOrchestration,
    })
    expect(prepared).toThrow("leave no body space")
    const loaded = await loadProfileGuide(guideRoot, { surface: "native", launcher: "fmx", profile: "default" })
    const catalog = {
      ...base,
      native: base.native.map((entry) => {
        if (entry.launcher !== "fmx" || entry.name !== "default") return entry
        const { orchestration: _orchestration, ...legacy } = entry
        return { ...legacy, guide: loaded.guide }
      }),
    }
    const oversizedIntent = "x".repeat(7990)
    await expect(runGuideGenerate(provider, catalog, guideRoot, {
      intent: "Review.", originalIntent: oversizedIntent, profileRef: "native:fmx/default",
      workflowId: loaded.guide.workflows[0]!.id, model: "synthetic-model", effort: GuideEffort.Low,
    })).rejects.toThrow("leave no body space")
    expect(provider.generate).not.toHaveBeenCalled()
    expect(provider.optimize).not.toHaveBeenCalled()
  })
})
