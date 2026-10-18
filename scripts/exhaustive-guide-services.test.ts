import assert from "node:assert/strict"
import { test } from "bun:test"
import { GuideEffort, runGuideGenerate, runGuideMatch } from "../packages/trellage-launcher/src/guide-api.ts"
import type {
  GuideProvider,
  GuideMatchInput,
  GuideMatchCandidate,
} from "../packages/trellage-launcher/src/guide-provider.ts"
import { createGuideWorld } from "./exhaustive-guide-world.ts"
import { loadGuideCatalogDomain } from "./exhaustive-guide-catalog.ts"

const { guideRoot, domain, catalog } = await createGuideWorld()

for (const entry of catalog.native)
  for (const workflow of entry.guide.workflows)
    for (const skip of [undefined, false, true])
      test(`Guide generation ${entry.launcher}/${entry.name}/${workflow.id}, skip=${skip}`, async () => {
        const profileRef = `native:${entry.launcher}/${entry.name}`
        const calls: string[] = []
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected provider boundary")
        }
        const provider: GuideProvider = {
          match: unexpected,
          refine: unexpected,
          enrich: unexpected,
          firstmate: unexpected,
          generate: async (input) => {
            calls.push("generate")
            assert.equal(input.profileRef, profileRef)
            assert.equal(input.workflowId, workflow.id)
            assert.equal(input.intent, "Inspect this repository")
            assert(input.guideBody.length > 0)
            return {
              candidates: ["Focused", "Thorough", "Cautious"].map((title) => ({
                title,
                prompt: `${title}: inspect this repository and report findings.`,
                notes: "Offline fixture",
              })),
            }
          },
          optimize: async (input) => {
            calls.push("optimize")
            assert.equal(input.profileRef, profileRef)
            assert.equal(input.candidates.length, 3)
            return { candidates: input.candidates }
          },
        }
        const result = await runGuideGenerate(
          provider,
          catalog,
          guideRoot,
          {
            intent: "Inspect this repository",
            model: "fixture-model",
            effort: GuideEffort.High,
            profileRef,
            workflowId: workflow.id,
          },
          undefined,
          skip === undefined
            ? {}
            : {
                shouldSkipOptimize: async () => {
                  calls.push("gate")
                  return skip
                },
              },
        )
        assert.deepEqual(calls, [
          "generate",
          ...(skip === undefined ? [] : ["gate"]),
          ...(skip === true ? [] : ["optimize"]),
        ])
        assert.equal(result.model, "fixture-model")
        assert.equal(result.effort, "high")
        assert.equal(result.intent, "Inspect this repository")
        assert.equal(result.candidates.length, 3)
        assert.equal(new Set(result.candidates.map((candidate) => candidate.prompt)).size, 3)
        for (const candidate of result.candidates) {
          assert(candidate.prompt.includes(candidate.title))
          let cursor = 0
          for (const fragment of workflow.skill !== undefined || workflow.frame === "fixed"
            ? workflow.promptTemplate.split(/\{\{[^{}]+\}\}/u).filter(Boolean)
            : []) {
            const position = candidate.prompt.indexOf(fragment, cursor)
            assert(position >= cursor, "authored prompt fragments must retain their order")
            cursor = position + fragment.length
          }
          const forwarded = [
            ...(workflow.interaction === undefined ? [] : ["--interactive"]),
            ...(workflow.launchAgent === undefined ? [] : ["--agent", workflow.launchAgent]),
            ...(workflow.interaction?.requiredSkills.flatMap((skill) => ["--require-skill", skill]) ?? []),
          ]
          const automatic = ["codex", "claude"].includes(entry.launcher) || workflow.interaction !== undefined
          if (automatic)
            forwarded.push(...(["codex", "claude"].includes(entry.launcher) ? [] : ["-i"]), candidate.prompt)
          assert.equal(candidate.command.executable, "trx")
          assert.deepEqual(candidate.command.args, [
            "run",
            entry.launcher,
            entry.name,
            ...(forwarded.length ? ["--", ...forwarded] : []),
          ])
          assert.equal(candidate.command.promptHandling, automatic ? "argv" : "manual-paste")
        }
      })

test("Guide generation rejects unknown profiles and workflows before calling any provider", async () => {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected provider boundary")
  }
  const provider: GuideProvider = { match: unexpected, generate: unexpected, optimize: unexpected, refine: unexpected }
  for (const profileRef of [
    "native:unknown/unknown",
    `native:${catalog.native[0]!.launcher}/${catalog.native[0]!.name}`,
  ])
    await assert.rejects(
      runGuideGenerate(provider, catalog, guideRoot, {
        intent: "Inspect this repository",
        model: "fixture-model",
        effort: GuideEffort.High,
        profileRef,
        workflowId: "unknown-workflow",
      }),
      /Unknown profile reference|Unknown workflow|workflow.*unknown|unknown.*workflow/i,
    )
})

for (const mode of ["copilot", "matcher", "fallback"])
  test(`Guide matching uses only its explicit ${mode} fixture`, async () => {
    const calls: string[] = []
    let candidates: GuideMatchCandidate[] = []
    const respond = (input: GuideMatchInput) => {
      assert.equal(input.intent, "Inspect this repository")
      assert(input.entries.length >= 3)
      candidates = input.entries.slice(0, 3).map((entry) => ({
        profileRef: entry.ref,
        workflowId: entry.guide.workflows[0]!.id,
        confidence: 0.8,
        reason: "Deterministic fixture selection",
        tradeoff: "Fixture does not judge task fit",
      }))
      assert(!JSON.stringify(input).includes("/fixture/bin/trx"), "provider input must not expose launcher paths")
      return { candidates }
    }
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected provider boundary")
    }
    const provider: GuideProvider = {
      generate: unexpected,
      optimize: unexpected,
      refine: unexpected,
      match: async (input) => {
        calls.push("copilot")
        return respond(input)
      },
    }
    const response = await runGuideMatch(
      provider,
      catalog,
      {
        intent: "Inspect this repository",
        model: "fixture-model",
        effort: GuideEffort.High,
      },
      undefined,
      mode === "copilot"
        ? {}
        : {
            matcher: {
              execution: { backend: "jev", model: "fixture-matcher" },
              revision: "fixture-v1",
              match: async (input) => {
                calls.push("matcher")
                if (mode === "fallback") throw new Error("Explicit fixture fallback")
                return respond(input)
              },
            },
          },
    )
    assert.deepEqual(calls, mode === "fallback" ? ["matcher", "copilot"] : [mode])
    assert.equal(response.execution?.backend, mode === "matcher" ? "jev" : "copilot")
    assert.deepEqual(
      response.recommendations.map(({ profileRef, workflowId }) => ({ profileRef, workflowId })),
      candidates.map(({ profileRef, workflowId }) => ({ profileRef, workflowId })),
    )
    assert.deepEqual(response.fallback, mode === "fallback" ? { backend: "jev", reason: "request-failed" } : undefined)
  })

test("Guide service source declarations stayed unchanged", async () => {
  assert.deepEqual((await loadGuideCatalogDomain()).sourceHashes, domain.sourceHashes)
})
