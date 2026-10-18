import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { loadProfileGuide, type ProfileGuideV1 } from "@trellage/guide-core"
import { GuideEffort, runGuideGenerate } from "../src/guide-api.ts"
import { completeSinglePromptArtifact, prepareGuidePrompt } from "../src/guide-context.ts"
import type { GuideGenerateCandidate, GuideProvider } from "../src/guide-provider.ts"
import { renderWorkflowBodyCandidate, workflowPromptFrame } from "../src/guide-workflow-prompt.ts"
import { runtimeCatalog } from "./helpers/continuation-runtime-fixtures.ts"

const fixedGuide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["code-review"],
  bestFor: ["Review a project", "Inspect a revision"],
  avoidFor: ["Changing permissions", "Unbounded launches"],
  prerequisites: [],
  workflows: [{
    id: "review-project",
    description: "Review the project.",
    examples: ["Review project C", "Find defects in this project", "Inspect the selected revision"],
    frame: "fixed",
    promptTemplate: "Review the project.\n\nSpecification:\n{{intent}}\n\nReport evidence. Do not merge.",
  }],
}

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
  it("also reserves the unchanged original appendix for one-prompt delivery", () => {
    const context = { originalIntent: "  Keep this exact scope.\r\n\u{1f600}  " }
    const prepared = prepareGuidePrompt(fixedGuide, "review-project", "native:codex/default", context)
    const frame = workflowPromptFrame(prepared.workflow)
    const appendix = `\n\n## Original human intent (unchanged)\n\n${context.originalIntent}`
    expect(prepared.bodyBudget).toBe(8000 - frame.beforeBody.length - frame.afterBody.length - appendix.length)
    const candidate = renderWorkflowBodyCandidate(prepared.workflow, boundaryCandidates(prepared.bodyBudget)[0]!)
    const complete = completeSinglePromptArtifact(prepared.workflow, candidate, prepared.context)
    expect(complete.prompt.length).toBe(8000)
    expect(complete.prompt).toContain(context.originalIntent)
  })

  it("rejects an exhausted frame before generation or optimization", async () => {
    const oversized = { ...fixedGuide, workflows: [{
      ...fixedGuide.workflows[0]!, promptTemplate: `${"F".repeat(8000)}{{intent}}`,
    }] }
    const provider = boundaryProvider()
    const prepared = () => prepareGuidePrompt(oversized, "review-project", "native:codex/default", {
      originalIntent: "Do not lose this input.",
    })
    expect(prepared).toThrow("leave no body space")
    const loaded = await loadProfileGuide(guideRoot, { surface: "native", harness: "codex", profile: "pstack" })
    const base = runtimeCatalog()
    const catalog = {
      ...base,
      entries: base.entries.map((entry) => entry.harness === "codex" && entry.profiles[0] === "default"
        ? { ...entry, ref: "native:codex/pstack", profiles: ["pstack"], guide: loaded.guide }
        : entry),
    }
    const oversizedIntent = "x".repeat(7990)
    await expect(runGuideGenerate(provider, catalog, guideRoot, {
      intent: "Review.", originalIntent: oversizedIntent, profileRef: "native:codex/pstack",
      workflowId: loaded.guide.workflows[0]!.id, model: "synthetic-model", effort: GuideEffort.Low,
    })).rejects.toThrow(/no body space|8000 UTF-16/)
    expect(provider.generate).not.toHaveBeenCalled()
    expect(provider.optimize).not.toHaveBeenCalled()
  })
})
