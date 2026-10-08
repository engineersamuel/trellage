import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadProfileGuide } from "@trellage/guide-core"
import {
  GuideEffort,
  runGuideGenerate,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
} from "../src/guide-api.ts"
import { type CombinedGuideCatalog } from "../src/guide-catalog.ts"
import {
  createQueuedGuideJob,
  executeGuideBatch,
  queuedGuideJobEditText,
  replaceQueuedGuideJobPrompt,
} from "../src/guide-batch.ts"
import { executeGuideUiResult } from "../src/guide-interactive-execution.ts"
import {
  buildCurrentTerminalResult,
  buildCurrentHerdrWorkspaceResult,
  buildNewHerdrTabResult,
  buildNewHerdrWorktreeResult,
  buildExistingHerdrWorktreeResult,
  pinnedGuideLenses,
  selectedProfileForPinnedLens,
  runGuideGenerationStep,
  runGuideRefinementStep,
  templateGuideCandidates,
  createInitialGuideUiState,
  guideUiReducer,
  GuideUiActionType,
  GuideUiStage,
} from "../src/guide-ui.tsx"
import { buildHerdrGuideLaunch, type CommandSpec } from "../src/guide-launch.ts"
import { ProfileReadinessKind } from "../src/guide-preflight.ts"
import type { GuideProvider } from "../src/guide-provider.ts"
import {
  customerPromptProjection,
  parseApprovedCustomerContext,
  renderCustomerContext,
} from "../src/guide-customer-context.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const guideRoot = path.join(root, "profile-guides")

const catalog = async (): Promise<CombinedGuideCatalog> => ({
  schemaVersion: 1,
  sandboxCommandPath: "/opt/bin/trellage",
  sandbox: [],
  native: [
    {
      launcher: "copilot",
      harness: "copilot",
      name: "hve",
      description: "Native HVE",
      commandPath: "/opt/bin/trx",
      sandbox: false,
      herdrCompatibility: { status: "untested" },
      headless: {
        schemaVersion: 1,
        prompt: false,
        outputFormats: [],
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
      },
      guide: (await loadProfileGuide(guideRoot, { surface: "native", launcher: "copilot", profile: "hve" })).guide,
    },
  ],
})

const provider: GuideProvider = {
  match: async () => {
    throw new Error("Generation must not rematch")
  },
  generate: async ({ guide, workflowId, intent }) => ({
    candidates: templatePromptCandidates(guide, workflowId, intent),
  }),
  optimize: async ({ candidates }) => ({ candidates }),
  refine: async () => {
    throw new Error("No refinement expected")
  },
}

const customerWorkflows = [
  ["customer-discovery", "hve-core:dt-coach", ["dt-coaching-foundation", "dt-methods", "dt-rpi-integration"]],
  ["test-assumption", "hve-core:experiment-designer", ["experiment-design"]],
  ["business-requirements", "hve-core:brd-builder", ["requirements-author"]],
  ["product-requirements", "hve-core:prd-builder", ["requirements-author"]],
  ["focused-ux-coaching", "hve-core:ux-ui-designer", ["ux-coaching"]],
  ["review-architecture", "hve-core:system-architecture-reviewer", ["architecture-review"]],
  ["functional-planning", "hve-core:functional-planner", ["functional-planner"]],
] as const

const approvedContext = (evidence = "Reported: note-1") =>
  parseApprovedCustomerContext({
    schemaVersion: 1,
    approval: "guide-context-only",
    fields: {
      problem: "Support staff repeat work",
      outcome: "Unknown",
      evidence,
      decisions: "No implementation approval",
      constraints: "No publishing",
      handoff: "Partner-owned",
    },
  })

describe("HVE customer workflow delivery", () => {
  it("preserves the approved brief through model rewriting, refinement, and template fallback", async () => {
    const profiles = await catalog()
    const lens = pinnedGuideLenses(profiles).find(({ kind }) => kind === "discovery")!
    const context = { originalIntent: "Understand support work", customerContext: approvedContext() }
    const intent = customerPromptProjection(context.originalIntent, context.customerContext)
    const recorded: unknown[] = []
    const rewriting: GuideProvider = {
      ...provider,
      generate: async (input) => {
        recorded.push(input.customerContext)
        expect(input.intent).toBe(context.originalIntent)
        return {
          candidates: [
            "Understand support work by examining repeated tickets.",
            "Understand support work by checking the claimed time savings.",
            "Understand support work by interviewing the affected operators.",
          ].map((prompt, index) => ({ title: `Approach ${index + 1}`, prompt, notes: "" })),
        }
      },
      refine: async (input) => {
        recorded.push(input.customerContext)
        expect(input.candidate.prompt).not.toContain("Customer context")
        expect(input.intent).toBe(context.originalIntent)
        return {
          candidate: {
            ...input.candidate,
            prompt: "Understand support work by checking each claim with its source owner.",
          },
        }
      },
      optimize: async (input) => {
        recorded.push(input.customerContext)
        return { candidates: input.candidates }
      },
    }
    const generated = await runGuideGenerationStep(
      profiles,
      guideRoot,
      rewriting,
      intent,
      lens.recommendation,
      undefined,
      undefined,
      undefined,
      context,
    )
    const refined = await runGuideRefinementStep(
      profiles,
      rewriting,
      intent,
      lens.recommendation,
      generated.guideDocument,
      generated.candidates,
      0,
      "Be brief.",
      undefined,
      context,
    )
    const fallback = templateGuideCandidates(
      generated.guideDocument.guide,
      lens.recommendation.workflowId,
      intent,
      context,
    )
    expect(refined.prompt).toContain("checking each claim with its source owner")
    for (const candidate of [...generated.candidates, refined, ...fallback]) {
      expect(candidate.prompt).toContain(renderCustomerContext(context.customerContext))
      expect(candidate.prompt.match(/## Customer context/g)).toHaveLength(1)
      expect(candidate.prompt).toContain(context.originalIntent)
    }
    expect(recorded).toEqual(Array.from({ length: 4 }, () => context.customerContext))
  })

  it("keeps a captured brief when a parked fork changes profile after main context changes", async () => {
    const profiles = await catalog()
    const lens = pinnedGuideLenses(profiles).find(({ kind }) => kind === "discovery")!
    const initial = {
      ...createInitialGuideUiState("Understand support work"),
      stage: GuideUiStage.Recommendations,
      recommendations: [lens.recommendation],
      customerContext: approvedContext(),
    }
    const confirm = {
      type: GuideUiActionType.RecommendationsConfirm as const,
      selectedProfile: selectedProfileForPinnedLens(profiles, lens),
      recommendation: lens.recommendation,
    }
    const opened = guideUiReducer(initial, confirm)
    expect(opened.selectedCustomerContext).toEqual(initial.customerContext)
    const main = guideUiReducer(opened, { type: GuideUiActionType.ForkMain })
    const changed = { ...main, customerContext: approvedContext("Observed: a newer note") }
    const reopened = guideUiReducer(changed, { type: GuideUiActionType.ForkSelect, index: 0 })
    const selecting = { ...reopened, stage: GuideUiStage.Recommendations, selectedRecommendation: undefined }
    const selected = guideUiReducer(selecting, confirm)
    expect(selected.customerContext).toEqual(changed.customerContext)
    expect(selected.selectedCustomerContext).toEqual(initial.customerContext)
  })

  it("protects the captured context when an ordinary queued prompt is edited", async () => {
    const profiles = await catalog()
    const profile = selectedProfileFromCatalogRef(profiles, "native:copilot/hve", "rpi-research")
    const workflow = profiles.native[0]!.guide.workflows.find(({ id }) => id === "rpi-research")!
    const context = {
      originalIntent: "Research support work",
      workflowId: workflow.id,
      workflow,
      projectTarget: null,
      customerContext: approvedContext(),
    }
    const job = createQueuedGuideJob(1, profile, "A bounded research approach.", { kind: "new-tab" }, context)
    expect(queuedGuideJobEditText(job)).toBe("A bounded research approach.")
    const edited = replaceQueuedGuideJobPrompt(job, "Change only the approach.")
    expect(edited.prompt).toContain("Change only the approach.")
    expect(edited.prompt).toContain(renderCustomerContext(context.customerContext))
    expect(edited.guideContext).toEqual(context)
    expect(job.prompt).not.toContain("Change only the approach.")
  })

  it.each(customerWorkflows)(
    "uses an interactive, checked agent for %s even without headless capability",
    async (workflowId, agent, skills) => {
      const profiles = await catalog()
      const response = await runGuideGenerate(provider, profiles, guideRoot, {
        profileRef: "native:copilot/hve",
        workflowId,
        intent: "Keep unverified claims unknown.",
        model: "fixture",
        effort: GuideEffort.Medium,
      })
      const selected = selectedProfileFromCatalogRef(profiles, "native:copilot/hve", workflowId)
      const baseArgs = [
        "run",
        "copilot",
        "hve",
        "--interactive",
        "--agent",
        agent,
        ...skills.flatMap((skill) => ["--require-skill", skill]),
      ]
      for (const candidate of response.candidates) {
        expect(candidate.command.args).toEqual([...baseArgs, "-i", candidate.prompt])
        expect(candidate.command.promptHandling).toBe("argv")
        const launches: CommandSpec[] = []
        let checked = 0
        await executeGuideUiResult(buildCurrentTerminalResult(selected, candidate.prompt, root), {
          runner: {
            run: async () => {
              throw new Error("No unmanaged operation expected")
            },
          },
          write: () => {},
          checkReadiness: async (_runner, profile) => {
            expect(profile).toMatchObject({ agent, interaction: { mode: "interactive", requiredSkills: skills } })
            checked++
            return { kind: ProfileReadinessKind.Ready, summary: "Fixture ready" }
          },
          runInteractive: async (command) => {
            launches.push(command)
          },
        })
        expect(checked).toBe(1)
        expect(launches).toEqual([{ executable: selected.commandPath, args: [...baseArgs, "-i", candidate.prompt] }])
      }
    },
  )

  it("retains the agent and questions across all direct Herdr destinations", async () => {
    const profiles = await catalog()
    const selected = selectedProfileFromCatalogRef(profiles, "native:copilot/hve", "test-assumption")
    const prompt = "Keep '$HOME' literal.\nAsk before the experiment."
    const context = { workspaceId: "1", paneId: "1-1", surface: "pane" as const }
    const results = [
      buildCurrentHerdrWorkspaceResult(selected, prompt, root, context),
      buildNewHerdrTabResult(selected, prompt, root, context),
      buildNewHerdrWorktreeResult(selected, prompt, root, "experiment", "HEAD"),
      buildExistingHerdrWorktreeResult(selected, prompt, root, root),
    ]
    for (const result of results) {
      expect(result.promptDelivery).toBe("command")
      expect(result.command.args).toEqual([
        "run",
        "copilot",
        "hve",
        "--interactive",
        "--agent",
        "hve-core:experiment-designer",
        "--require-skill",
        "experiment-design",
        "-i",
        prompt,
      ])
    }
  })

  it("blocks failed readiness and altered commands before any customer launch", async () => {
    const selected = selectedProfileFromCatalogRef(await catalog(), "native:copilot/hve", "customer-discovery")
    const result = buildCurrentTerminalResult(selected, "Discover the problem.", root)
    let launched = false
    const services = {
      runner: {
        run: async () => {
          throw new Error("Unexpected command")
        },
      },
      write: () => {},
      checkReadiness: async () => ({
        kind: ProfileReadinessKind.Blocked as const,
        summary: "Unavailable",
        diagnostic: "Missing dt-methods",
      }),
      runInteractive: async () => {
        launched = true
      },
    }
    await expect(executeGuideUiResult(result, services)).rejects.toThrow("Missing dt-methods")
    await expect(
      executeGuideUiResult({ ...result, command: { ...result.command, args: ["hve", "-p", result.prompt] } }, services),
    ).rejects.toThrow("no longer matches")
    expect(launched).toBe(false)
  })

  it("blocks queue construction and forged queued interactive jobs before allocation", async () => {
    const selected = selectedProfileFromCatalogRef(await catalog(), "native:copilot/hve", "customer-discovery")
    expect(() => createQueuedGuideJob(1, selected, "Discovery", { kind: "new-tab" })).toThrow("needs your answers")
    const built = buildHerdrGuideLaunch(selected, "Discovery")
    const result = await executeGuideBatch(
      {
        jobs: [{ id: 1, profile: selected, prompt: "Discovery", ...built, placement: { kind: "new-tab" } }],
        context: { cwd: root, workspaceId: "1", callerPaneId: "1-1" },
      },
      {
        runner: {
          run: async () => {
            throw new Error("No allocation or launch permitted")
          },
        },
        write: () => {},
      },
    )
    expect(result.result.entries).toEqual([
      expect.objectContaining({ status: "invalid", message: expect.stringContaining("unattended") }),
    ])
  })

  it("pins only the new entry points and keeps ordinary RPI autonomous", async () => {
    const profiles = await catalog()
    const lenses = pinnedGuideLenses(profiles)
    expect(lenses.map(({ kind }) => kind)).toEqual(["hve-rpi", "discovery", "experiment"])
    for (const lens of lenses) {
      const selected = selectedProfileForPinnedLens(profiles, lens)
      expect(selected.interaction?.mode).toBe(lens.kind === "hve-rpi" ? undefined : "interactive")
    }
    const research = selectedProfileFromCatalogRef(profiles, "native:copilot/hve", "rpi-research")
    expect(research.agent).toBeUndefined()
    expect(research.interaction).toBeUndefined()
    expect(buildHerdrGuideLaunch(research, "Research").command.args).toEqual(["run", "copilot", "hve", "-i", "Research"])
    const sandbox = await loadProfileGuide(guideRoot, { surface: "sandbox", profile: "copilot-hve" })
    expect(sandbox.guide.workflows.map(({ id }) => id)).toEqual(["rpi-agent-cycle", "adapt-hve-patterns"])
  })
})
