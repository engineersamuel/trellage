import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  GuideEffort,
  defaultGuideModelRouting,
  parseGuideServiceRequestJson,
  prefilterGuideMatchCatalogEntries,
  prioritizeExplicitFirstmate,
  runGuideGenerate,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
} from "../src/guide-api.ts"
import { guideMatchCatalogEntries, type CombinedGuideCatalog } from "../src/guide-catalog.ts"
import {
  completeSinglePromptArtifact, guideModelBodyCandidate, prepareGuidePrompt, registeredGuideProjectTarget,
  validateGuideOriginalIntent, validateLegacyFirstmateArtifact,
} from "../src/guide-context.ts"
import { GuideArtifactCache } from "../src/guide-match-cache.ts"
import { enrichLiteralCandidate, runGuideGenerationStep, runGuideRefinementStep } from "../src/guide-ui.tsx"
import {
  assertGuideOptimizeInput,
  type GuideGenerateCandidate,
  type GuideMatchCandidate,
  type GuideProvider,
} from "../src/guide-provider.ts"
import {
  GuideCandidatePromptStage,
  renderWorkflowBodyCandidate,
  requireDistinctGuideCandidatePrompts,
  validateFinalGuideCandidate,
  workflowPromptFrame,
} from "../src/guide-workflow-prompt.ts"
import {
  firstmateGuide,
  firstmateOriginalIntent,
  firstmateProjectC,
  firstmateRuntimeCatalog,
  legacyFirstmateCatalog,
} from "./helpers/continuation-firstmate-fixtures.ts"

vi.mock("../src/guide-selected.ts", () => ({
  loadSelectedGuide: vi.fn(async (catalog: CombinedGuideCatalog, _root: string, ref: string) => {
    const entry = catalog.native.find((item) => `native:${item.launcher}/${item.name}` === ref)
    if (entry === undefined) throw new Error("Unknown test guide.")
    return { ref, guide: entry.guide, body: "Use the confirmed target and supported Claude worker controls." }
  }),
}))

const candidates = [
  { title: "Interfaces first", prompt: "Define shared interfaces before assigning independent implementation tasks.", notes: "Resolve dependencies before implementation." },
  { title: "Uncertainty first", prompt: "Investigate risks that change the task split, then assign independent implementation tasks.", notes: "Use evidence to remove planning uncertainty." },
  { title: "Small integration batches", prompt: "Deliver and integrate small verified increments in dependency order.", notes: "Reduce the integration risk with short batches." },
] as const satisfies ReadonlyArray<GuideGenerateCandidate>

const providerFor = () => {
  const provider = {
    match: vi.fn<GuideProvider["match"]>(async () => { throw new Error("An explicit workflow must not re-match.") }),
    generate: vi.fn<GuideProvider["generate"]>(async () => ({ candidates })),
    refine: vi.fn<GuideProvider["refine"]>(async ({ candidate }) => ({ candidate })),
    optimize: vi.fn<GuideProvider["optimize"]>(async ({ candidates: input }) => ({ candidates: input })),
  }
  return provider
}

const modelMatches = (catalog: CombinedGuideCatalog): ReadonlyArray<GuideMatchCandidate> =>
  guideMatchCatalogEntries(catalog).slice(0, 3).map((entry) => ({
    profileRef: entry.ref,
    workflowId: entry.guide.workflows[0]!.id,
    confidence: 0.5,
    reason: "A model-selected alternative.",
    tradeoff: "Review the proposed fit.",
  }))

describe("Firstmate guide context", () => {
  it("round-trips a full 8000-unit legacy artifact through generation and refinement caches without trimming human text", async () => {
    const base = legacyFirstmateCatalog()
    const oldGuide = {
      ...firstmateGuide,
      workflows: [{
        id: "review-project", description: "Review the project.", examples: ["Review changes", "Inspect code"],
        promptTemplate: "Coordinate a bounded project review.\n\nTask:\n{{intent}}",
      }],
    }
    const catalog = {
      ...base,
      native: base.native.map((entry) => entry.launcher === "fmx" ? { ...entry, guide: oldGuide } : entry),
    }
    const profileRef = "native:fmx/default"
    const originalIntent = `  ${"Keep every requirement. ".repeat(150)}\r\n  `
    const context = { originalIntent, projectTarget: registeredGuideProjectTarget("MyProject") }
    const prepared = prepareGuidePrompt(oldGuide, "review-project", profileRef, "Review the project.", context)
    const provider = providerFor()
    const choice = (suffix: string) => ({
      title: suffix, prompt: `${"x".repeat(prepared.bodyBudget - 1)}${suffix}`, notes: "Use a bounded approach.",
    })
    provider.generate.mockResolvedValue({ candidates: [choice("a"), choice("b"), choice("c")] })
    provider.refine.mockResolvedValue({ candidate: choice("d") })
    const recommendation = enrichLiteralCandidate(catalog, {
      profileRef, workflowId: "review-project", confidence: 0.9,
      reason: "Review the confirmed project.", tradeoff: "Legacy manual paste.",
    })
    const cwd = await mkdtemp(path.join(tmpdir(), "firstmate-legacy-whitespace-"))
    try {
      const cache = new GuideArtifactCache({
        cwd, routing: defaultGuideModelRouting,
        prompts: { match: "match", generate: "generate", refine: "refine", optimize: "optimize", enrich: "enrich" },
      })
      const generate = () => runGuideGenerationStep(
        catalog, "/unused", provider, "Review the project.", recommendation, undefined, undefined, cache, context,
      )
      const first = await generate()
      const cached = await generate()
      expect(cached.candidates).toEqual(first.candidates)
      expect(provider.generate).toHaveBeenCalledTimes(1)
      const refine = () => runGuideRefinementStep(
        catalog, provider, "Review the project.", recommendation, first.guideDocument,
        first.candidates, 0, "Use another bounded approach.", cache, context,
      )
      const refined = await refine()
      expect(await refine()).toEqual(refined)
      expect(provider.refine).toHaveBeenCalledTimes(1)
      for (const candidate of [...cached.candidates, refined]) {
        expect(candidate.prompt.length).toBe(8000)
        expect(candidate.prompt.endsWith(originalIntent)).toBe(true)
        expect(candidate.prompt.match(/## Original human intent \(unchanged\)/gu)).toHaveLength(1)
        validateLegacyFirstmateArtifact(profileRef, candidate.prompt, {
          ...context, workflow: prepared.workflow, workflowId: "review-project", projectTargetConfirmed: true,
        })
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it.each(["default", "pstack-workers"])("keeps complete legacy %s input through generation, cache, refinement and fallback", async (name) => {
    const catalog = legacyFirstmateCatalog()
    const profileRef = `native:fmx/${name}`
    const provider = providerFor()
    const context = { originalIntent: firstmateOriginalIntent, projectTarget: firstmateProjectC() }
    const recommendation = enrichLiteralCandidate(catalog, {
      profileRef, workflowId: "review-project", confidence: 0.9,
      reason: "Review the confirmed project.", tradeoff: "Legacy interactive manual-paste delivery.",
    })
    const prepared = prepareGuidePrompt(firstmateGuide, "review-project", profileRef, "Review the change.", context)
    const confirmed = { ...context, workflowId: "review-project", workflow: prepared.workflow, projectTargetConfirmed: true as const }
    const cwd = await mkdtemp(path.join(tmpdir(), "firstmate-legacy-context-"))
    try {
      const cache = new GuideArtifactCache({
        cwd, routing: defaultGuideModelRouting,
        prompts: { match: "match", generate: "generate", refine: "refine", optimize: "optimize", enrich: "enrich" },
      })
      const generate = () => runGuideGenerationStep(
        catalog, "/unused", provider, "Review the change.", recommendation, undefined, undefined, cache, context,
      )
      const generated = await generate()
      expect((await generate()).candidates).toEqual(generated.candidates)
      expect(provider.generate).toHaveBeenCalledTimes(1)
      for (const candidate of generated.candidates) {
        validateLegacyFirstmateArtifact(profileRef, candidate.prompt, confirmed)
        expect(candidate.prompt).toContain(firstmateOriginalIntent)
        expect(candidate.prompt).toContain('"delivery": "manual-paste"')
        expect(candidate.prompt).toContain('"workflowId": "review-project"')
        expect(candidate.prompt).toContain('"entryWorktree": "/fixture/project-c"')
        expect(candidate.prompt.match(/## Original human intent \(unchanged\)/gu)).toHaveLength(1)
        expect(candidate.prompt.match(/## Firstmate request context/gu)).toHaveLength(1)
        expect(candidate.prompt.length).toBeLessThanOrEqual(8000)
      }
      provider.refine.mockResolvedValue({ candidate: {
        title: "Trace callers", prompt: "Trace each caller before reviewing the error boundaries.", notes: "Caller-first review.",
      } })
      const refined = await runGuideRefinementStep(
        catalog, provider, "Review the change.", recommendation, generated.guideDocument,
        generated.candidates, 0, "Trace the callers.", cache, context,
      )
      validateLegacyFirstmateArtifact(profileRef, refined.prompt, confirmed)
      expect(provider.refine.mock.calls[0]?.[0].candidate.prompt).not.toContain(firstmateOriginalIntent)
      expect(provider.refine.mock.calls[0]?.[0].originalIntent).toBe(firstmateOriginalIntent)
      expect(provider.refine.mock.calls[0]?.[0].bodyBudget).toBe(prepared.bodyBudget)
      for (const candidate of templatePromptCandidates(prepared.guide, "review-project", "Review the change.")) {
        validateLegacyFirstmateArtifact(profileRef,
          completeSinglePromptArtifact(prepared.workflow, candidate, prepared.context).prompt, confirmed)
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("supports old generation requests as drafts, but does not authorize an unconfirmed legacy target", async () => {
    const provider = providerFor()
    const result = await runGuideGenerate(provider, legacyFirstmateCatalog(), "/unused", {
      intent: "Review the implementation.", profileRef: "native:fmx/default",
      model: "fixture-model", effort: GuideEffort.Low,
    })
    expect(result.candidates.every(({ prompt }) => prompt.includes("Review the implementation."))).toBe(true)
    expect(result.candidates[0]?.prompt).toContain("The project target is not confirmed")
    expect(result.candidates[0]?.command.args).toEqual(["default"])
    expect(() => validateLegacyFirstmateArtifact("native:fmx/default", result.candidates[0]!.prompt, undefined))
      .toThrow("requires confirmed")
  })

  it.each([8001, 60_000])("refuses a %i-character legacy original before model I/O instead of dropping input", async (length) => {
    const provider = providerFor()
    await expect(runGuideGenerate(provider, legacyFirstmateCatalog(), "/unused", {
      intent: "Review the project.", originalIntent: "x".repeat(length), projectTarget: firstmateProjectC(),
      profileRef: "native:fmx/default", model: "fixture-model", effort: GuideEffort.Low,
    })).rejects.toThrow("cannot carry the complete original intent")
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it("preserves exact original whitespace in a legacy workflow without new frame or scope metadata", () => {
    const guide = {
      ...firstmateGuide,
      workflows: [{
        id: "old-workflow", description: "Review the project.", examples: ["Review changes", "Inspect code"],
        promptTemplate: "Review only this project.\n{{intent}}\n",
      }],
    }
    const profileRef = "native:fmx/default"
    const originalIntent = " \r\nKeep every byte.\r\n  "
    const prepared = prepareGuidePrompt(guide, "old-workflow", profileRef, "Inspect code.", {
      originalIntent, projectTarget: firstmateProjectC(),
    })
    const body = { ...candidates[0], prompt: "x".repeat(prepared.bodyBudget) }
    const complete = completeSinglePromptArtifact(
      prepared.workflow, renderWorkflowBodyCandidate(prepared.workflow, body), prepared.context,
    )
    expect(complete.prompt.length).toBe(8000)
    expect(complete.prompt).toContain(originalIntent)
    expect(complete.prompt).toContain('"scope": "project"')
    expect(prepared.workflow).not.toHaveProperty("skill")
    expect(guideModelBodyCandidate(prepared.workflow, complete, prepared.context)).toEqual(body)
    validateLegacyFirstmateArtifact(profileRef, complete.prompt, {
      originalIntent, projectTarget: firstmateProjectC(), workflow: prepared.workflow,
      workflowId: "old-workflow", projectTargetConfirmed: true,
    })
  })

  it.each(["MyProject", "my_project", "my.project"])("preserves registered project %s through JSON and model context", async (projectName) => {
    const provider = providerFor()
    const request = parseGuideServiceRequestJson(JSON.stringify({
      schemaVersion: 1, intent: "Review the registered project.", profile: "native:fmx/default",
      workflowId: "review-project", projectTarget: registeredGuideProjectTarget(projectName),
    }))
    const result = await runGuideGenerate(provider, firstmateRuntimeCatalog(), "/unused-guide-root", {
      ...request, profileRef: "native:fmx/default", model: "synthetic-model", effort: GuideEffort.Low,
    })
    expect(result.projectTarget?.projectName).toBe(projectName)
    expect(provider.generate.mock.calls[0]?.[0].projectTarget?.projectName).toBe(projectName)
    expect(provider.optimize.mock.calls[0]?.[0].projectTarget?.projectName).toBe(projectName)
    for (const candidate of result.candidates) expect(candidate.prompt).toContain(`"projectName": "${projectName}"`)
  })

  it("builds a complete bounded single-prompt artifact without changing its fixed frame", () => {
    const workflow = firstmateGuide.workflows[0]!
    const candidate = renderWorkflowBodyCandidate(workflow, candidates[0])
    const context = { originalIntent: firstmateOriginalIntent }
    const complete = completeSinglePromptArtifact(workflow, candidate, context)
    const frame = workflowPromptFrame(workflow)
    expect(complete.prompt).toContain(firstmateOriginalIntent)
    expect(complete.prompt.startsWith(frame.beforeBody)).toBe(true)
    expect(complete.prompt.endsWith(frame.afterBody)).toBe(true)
    expect(completeSinglePromptArtifact(workflow, complete, context)).toBe(complete)
    expect(complete.prompt.length).toBeLessThanOrEqual(8000)
  })

  it("carries the full original input in command-only generation when no inbox is available", async () => {
    const catalog = firstmateRuntimeCatalog()
    const provider = providerFor()
    const originalIntent = "  Preserve this exact scope.\r\nDo not remove any checks.  "
    const result = await runGuideGenerate(provider, catalog, "/unused-guide-root", {
      intent: "Prepare a focused review.", originalIntent, profileRef: "native:cdx/default",
      workflowId: "review", model: "fixture-model", effort: GuideEffort.High,
    })
    for (const candidate of result.candidates) {
      expect(candidate.prompt).toContain(originalIntent)
      expect(candidate.command.args.at(-1)).toBe(candidate.prompt)
      expect(candidate.prompt.length).toBeLessThanOrEqual(8000)
    }
    expect(result.originalIntent).toBe(originalIntent)
  })

  it("blocks an oversized legacy one-prompt artifact before generation rather than removing the original input", async () => {
    const provider = providerFor()
    await expect(runGuideGenerate(provider, firstmateRuntimeCatalog(), "/unused-guide-root", {
      intent: "Prepare a focused review.", originalIntent: "x".repeat(8001),
      profileRef: "native:cdx/default", workflowId: "review", model: "fixture-model", effort: GuideEffort.High,
    })).rejects.toThrow("cannot carry the complete original intent")
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it("keeps the complete original input after interactive generation and model refinement without an inbox", async () => {
    const catalog = firstmateRuntimeCatalog()
    const provider = providerFor()
    const originalIntent = "  Review every caller.\r\nKeep the command API unchanged.  "
    const recommendation = enrichLiteralCandidate(catalog, {
      profileRef: "native:cdx/default", workflowId: "review", confidence: 0.9,
      reason: "Review this change.", tradeoff: "Single-agent review.",
    })
    const generated = await runGuideGenerationStep(
      catalog, "/unused-guide-root", provider, "Review the change.", recommendation,
      undefined, undefined, undefined, { originalIntent },
    )
    for (const candidate of generated.candidates) expect(candidate.prompt).toContain(originalIntent)
    provider.refine.mockResolvedValue({ candidate: {
      title: "Caller review", prompt: "Trace each caller and report incompatible assumptions.", notes: "Inspect callers first.",
    } })
    const refined = await runGuideRefinementStep(
      catalog, provider, "Review the change.", recommendation, generated.guideDocument,
      generated.candidates, 0, "Focus on callers.", undefined, { originalIntent },
    )
    expect(refined.prompt).toContain(originalIntent)
    expect(refined.prompt.length).toBeLessThanOrEqual(8000)
    expect(provider.refine.mock.calls[0]?.[0].originalIntent).toBe(originalIntent)
    expect(provider.refine.mock.calls[0]?.[0].candidate.prompt).not.toContain(originalIntent)
  })

  it("refuses a confirmed Firstmate target on a one-prompt profile instead of dropping it", async () => {
    const provider = providerFor()
    await expect(runGuideGenerate(provider, firstmateRuntimeCatalog(), "/unused-guide-root", {
      intent: "Review the change.", originalIntent: firstmateOriginalIntent, projectTarget: firstmateProjectC(),
      profileRef: "native:cdx/default", workflowId: "review", model: "fixture-model", effort: GuideEffort.High,
    })).rejects.toThrow("requires an inbox-capable Firstmate profile")
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it("refuses a single-prompt artifact whose specification and unchanged original exceed the final bound", () => {
    expect(() => completeSinglePromptArtifact(firstmateGuide.workflows[0]!, {
      title: "Too large", prompt: "a".repeat(5000), notes: "No input may be removed.",
    }, { originalIntent: "b".repeat(4000) })).toThrow("8000")
  })

  it("uses the shared UTF-16 limits while preserving valid Unicode exactly", () => {
    const intent = "\u{1f600}".repeat(30_000)
    expect(validateGuideOriginalIntent(intent)).toBe(intent)
    expect(() => validateGuideOriginalIntent(`${intent}x`)).toThrow("60000 UTF-16 code units")
    const candidate = { ...candidates[0], prompt: "\u{1f600}".repeat(4000) }
    expect(validateFinalGuideCandidate(candidate)).toBe(candidate)
    expect(() => validateFinalGuideCandidate({ ...candidate, prompt: `${candidate.prompt}x` }))
      .toThrow("8000 UTF-16 code units")
  })

  it.each(["\ud800", "\udfff", "broken\ud800text"])("rejects unpaired surrogates before model or delivery I/O", (invalid) => {
    expect(() => validateGuideOriginalIntent(invalid)).toThrow("unpaired Unicode surrogates")
    expect(() => validateFinalGuideCandidate({ ...candidates[0], prompt: invalid }))
      .toThrow("unpaired Unicode surrogates")
  })

  it("validates optimization context before an adapter can send it to a model", () => {
    const legacyInput = { targetTool: "firstmate", profileRef: "native:fmx/default", candidates }
    expect(assertGuideOptimizeInput(legacyInput)).toBe(legacyInput)
    const base = {
      targetTool: "firstmate", profileRef: "native:fmx/default", candidates,
      originalIntent: firstmateOriginalIntent, projectTarget: firstmateProjectC(),
    }
    expect(assertGuideOptimizeInput(base)).toBe(base)
    expect(() => assertGuideOptimizeInput({
      ...base, projectTarget: { ...firstmateProjectC(), source: { kind: "local", location: "/relative" }, baseRevision: "HEAD" },
    })).toThrow("baseRevision")
    const entry = firstmateRuntimeCatalog().native.find(({ launcher }) => launcher === "fmx")!
    expect(() => assertGuideOptimizeInput({
      ...base, orchestration: { ...entry.orchestration!, ...{ home: "/private-runtime" } },
    })).toThrow("unsupported")
  })

  it("does not let stale caller controls enable an inbox frame on a legacy catalog entry", async () => {
    const catalog = legacyFirstmateCatalog()
    const provider = providerFor()
    const recommendation = enrichLiteralCandidate(catalog, {
      profileRef: "native:fmx/default", workflowId: "review-project", confidence: 0.9,
      reason: "Review a project.", tradeoff: "Manual-paste delivery.",
    })
    const controls = firstmateRuntimeCatalog().native.find(({ launcher }) => launcher === "fmx")!.orchestration!
    await expect(runGuideGenerationStep(
      catalog, "/unused", provider, "Review the project.", recommendation, undefined, undefined, undefined,
      { originalIntent: firstmateOriginalIntent, projectTarget: firstmateProjectC(), orchestration: controls },
    )).rejects.toThrow("requires controls from the selected profile catalog")
    expect(provider.generate).not.toHaveBeenCalled()
  })

  it.each(["default", "pstack-workers"])("preserves %s workflow, target, and original intent through generation and optimization", async (profile) => {
    const catalog = firstmateRuntimeCatalog()
    const provider = providerFor()
    const profileRef = `native:fmx/${profile}`
    const selected = selectedProfileFromCatalogRef(catalog, profileRef, "review-project")
    const originalIntent = `${firstmateOriginalIntent}\n${"Requirement. ".repeat(4000)}`
    const request = parseGuideServiceRequestJson(JSON.stringify({
      schemaVersion: 1,
      intent: "Review fleet status, but prepare the explicitly selected project review.",
      originalIntent,
      projectTarget: firstmateProjectC(),
      profile: profileRef,
      workflowId: "review-project",
    }))
    expect(request.profile).toBe(profileRef)
    const result = await runGuideGenerate(provider, catalog, "/unused-guide-root", {
      ...request, profileRef, model: "fixture-model", effort: GuideEffort.High,
    })
    expect(result.profile.workflowId).toBe("review-project")
    expect(result.originalIntent).toBe(originalIntent)
    expect(result.projectTarget).toEqual(firstmateProjectC())
    expect(provider.match).not.toHaveBeenCalled()
    expect(provider.generate.mock.calls[0]?.[0]).toMatchObject({
      originalIntent, workflowId: "review-project", projectTarget: firstmateProjectC(),
    })
    expect(provider.optimize.mock.calls[0]?.[0]).toMatchObject({
      originalIntent, projectTarget: firstmateProjectC(),
      fixedFrame: { beforeBody: expect.stringContaining("/fixture/project-c") },
    })
    expect(selected.surface).toBe("native")
    expect(result.profile.orchestration).toEqual(selected.surface === "native" ? selected.orchestration : undefined)
    for (const candidate of result.candidates) {
      expect(candidate.prompt.split("## Firstmate request context")).toHaveLength(2)
      expect(candidate.prompt).toContain("/fixture/project-c")
      expect(candidate.prompt).toContain('"dirtyChanges": "excluded"')
      expect(candidate.prompt).not.toContain(originalIntent)
      expect([...candidate.prompt].length).toBeLessThanOrEqual(8000)
      expect(candidate.command.args).toEqual([profile])
      expect(candidate.command.promptHandling).toBe("manual-paste")
    }
    expect(JSON.stringify(provider.generate.mock.calls)).not.toContain("instanceId")
    expect(JSON.stringify(provider.optimize.mock.calls)).not.toContain("private-firstmate-home")
  })

  it("retains a fleet-scope null target and avoids project-delivery fallback instructions", () => {
    const selected = firstmateRuntimeCatalog().native.find((entry) => entry.launcher === "fmx")!
    const prepared = prepareGuidePrompt(firstmateGuide, "review-fleet-status", "native:fmx/default", "Report fleet status.", {
      originalIntent: firstmateOriginalIntent, projectTarget: null, orchestration: selected.orchestration!,
    })
    const result = templatePromptCandidates(prepared.guide, prepared.workflow.id, "Report fleet status.")
    expect(result).toHaveLength(3)
    expect(new Set(result.map(({ prompt }) => prompt)).size).toBe(3)
    for (const { prompt } of result) {
      expect(prompt).toContain('"projectTarget": null')
      expect(prompt).toContain("Do not start implementation workers.")
      expect(prompt).not.toContain("Teardown")
    }
    expect(firstmateGuide.workflows[1]?.promptTemplate).not.toContain("Firstmate request context")
  })

  it.each(["plain", "heading", "bold"])("does not treat %s titles as different approaches", (style) => {
    const labelled = candidates.map((candidate) => ({
      ...candidate,
      prompt: `${style === "heading" ? "## " : style === "bold" ? "**" : ""}${candidate.title}${style === "bold" ? "**" : ""}\n\nPerform the same task.`,
    }))
    expect(() => requireDistinctGuideCandidatePrompts(
      [labelled[0]!, labelled[1]!, labelled[2]!], GuideCandidatePromptStage.FinalRendering,
    )).toThrow("no longer distinct")
  })

  it("partitions generation cache by exact original intent, target, workflow, and policy", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "firstmate-guide-context-"))
    try {
      const cache = new GuideArtifactCache({
        cwd, routing: defaultGuideModelRouting,
        prompts: { match: "match", generate: "generate", refine: "refine", optimize: "optimize", enrich: "enrich" },
      })
      const entry = firstmateRuntimeCatalog().native.find((profile) => profile.launcher === "fmx")!
      const base = {
        intent: "Review this project.", originalIntent: firstmateOriginalIntent,
        profileRef: "native:fmx/default", workflowId: "review-project",
        projectTarget: firstmateProjectC(), orchestration: entry.orchestration!,
        guide: firstmateGuide, guideBody: "Firstmate controls.", targetTool: "firstmate",
      }
      const produce = vi.fn(async () => ({ candidates }))
      await cache.generation(base, produce)
      await cache.generation(base, produce)
      expect(produce).toHaveBeenCalledTimes(1)
      await cache.generation({ ...base, originalIntent: `${firstmateOriginalIntent} ` }, produce)
      await cache.generation({ ...base, projectTarget: { ...firstmateProjectC(), baseRevision: "d".repeat(40) } }, produce)
      await cache.generation({ ...base, workflowId: "review-fleet-status" }, produce)
      await cache.generation({ ...base, orchestration: { ...entry.orchestration!, workerPolicy: { name: "pstack-workers", digest: "d".repeat(64) } } }, produce)
      expect(produce).toHaveBeenCalledTimes(5)
      await cache.generation({ ...base, bodyBudget: 3000 }, produce)
      await cache.generation({ ...base, bodyBudget: 3000 }, produce)
      expect(produce).toHaveBeenCalledTimes(6)
      await cache.generation({ ...base, bodyBudget: 4000 }, produce)
      expect(produce).toHaveBeenCalledTimes(7)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects an oversized final frame without shortening the specification", () => {
    const workflow = { ...firstmateGuide.workflows[0]!, promptTemplate: `${"F".repeat(7900)}{{intent}}` }
    const rendered = renderWorkflowBodyCandidate(workflow, { ...candidates[0], prompt: "body ".repeat(40) })
    expect(rendered.prompt).toContain("body ".repeat(40))
    expect(() => requireDistinctGuideCandidatePrompts(
      [rendered, { ...rendered, prompt: `${rendered.prompt}1` }, { ...rendered, prompt: `${rendered.prompt}2` }],
      GuideCandidatePromptStage.FinalRendering,
    )).toThrow("8000")
    expect(workflowPromptFrame(workflow).beforeBody).toHaveLength(7900)
  })
})

describe("explicit Firstmate routing", () => {
  it.each([
    ["Use fmx/default to review this repository. Do not merge.", "native:fmx/default"],
    ["Please select firstmate pstack-workers to supervise this work.", "native:fmx/pstack-workers"],
    ["I want to use fmx/pstack-worker to deliver this task.", "native:fmx/pstack-workers"],
    ["native:fmx/default: deliver the queued work.", "native:fmx/default"],
  ])("places an unambiguous choice first: %s", (intent, expected) => {
    const catalog = firstmateRuntimeCatalog()
    const result = prioritizeExplicitFirstmate(guideMatchCatalogEntries(catalog), intent, modelMatches(catalog))
    expect(result[0]?.profileRef).toBe(expected)
    expect(result[0]?.confidence).toBe(1)
  })

  it.each([
    "Do not use fmx/default. Explain the current code.",
    "Avoid firstmate pstack-workers for this task.",
    "Compare fmx/default with another approach.",
    "Should I use fmx/default?",
    "Compare fmx/default and fmx/pstack-workers.",
    "Render a static documentation page.",
  ])("does not force a Firstmate choice for: %s", (intent) => {
    const catalog = firstmateRuntimeCatalog()
    const proposed = modelMatches(catalog)
    expect(prioritizeExplicitFirstmate(guideMatchCatalogEntries(catalog), intent, proposed)).toBe(proposed)
  })

  it("retains both profiles for unnamed fleet supervision in a large prefilter", () => {
    const base = firstmateRuntimeCatalog()
    const other = base.native.find((entry) => entry.launcher !== "fmx")!
    const catalog = { ...base, native: [
      ...Array.from({ length: 18 }, (_, index) => ({ ...other, name: `alternative-${index}` })),
      ...base.native.filter(({ launcher }) => launcher === "fmx"),
    ] }
    const entries = prefilterGuideMatchCatalogEntries(catalog, "Coordinate workers across worktrees; review fleet status, project backlog, and the task graph.")
    expect(entries.length).toBeLessThanOrEqual(12)
    expect(entries.map(({ ref }) => ref)).toEqual(expect.arrayContaining(["native:fmx/default", "native:fmx/pstack-workers"]))
    expect(JSON.stringify(entries)).not.toContain("instanceId")
  })
})
