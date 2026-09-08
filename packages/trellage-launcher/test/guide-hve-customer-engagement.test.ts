import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  loadProfileGuide,
  parseProfileGuideIdentity,
  type ProfileGuideIdentity,
  type ProfileGuideWorkflow,
} from "../../trellage-guide-core/dist/index.js"

import { workflowPromptFrame } from "../src/guide-workflow-prompt.js"
import {
  GuideEffort,
  runGuideGenerate,
  selectedProfileFromCatalogRef,
  templatePromptCandidates,
} from "../src/guide-api.js"
import { parseGuideCatalog, type CombinedGuideCatalog, type HeadlessCapabilitiesV1 } from "../src/guide-catalog.js"
import { executeGuideUiResult } from "../src/guide-interactive-execution.js"
import {
  buildCurrentTerminalResult,
  buildCurrentHerdrWorkspaceResult,
  buildNewHerdrTabResult,
  buildNewHerdrWorktreeResult,
  buildExistingHerdrWorktreeResult,
  pinnedGuideLenses,
  selectedProfileForPinnedLens,
} from "../src/guide-ui.js"
import { createQueuedGuideJob, replaceQueuedGuideJobPrompt } from "../src/guide-batch.js"
import { parseSelectedProfile, type CommandSpec, type HerdrContext } from "../src/guide-launch.js"
import type { GuideProvider } from "../src/guide-provider.js"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const guideRoot = path.join(repositoryRoot, "profile-guides")

const nativeHveIdentity: ProfileGuideIdentity = parseProfileGuideIdentity("native/cpx/hve.md")
const sandboxHveIdentity: ProfileGuideIdentity = parseProfileGuideIdentity("sandbox/copilot-hve.md")

const workflow = (workflows: ReadonlyArray<ProfileGuideWorkflow>, id: string): ProfileGuideWorkflow => {
  const found = workflows.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`workflow ${id} not found`)
  return found
}

/** Collapses authored line wrapping so assertions do not depend on column width. */
const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim()

// Every hve-core agent name referenced by the customer-engagement-lifecycle
// workflow, matching each agent's verified `.agent.md` frontmatter `name`.
const expectedLifecycleAgentNames = [
  "DT Coach",
  "Meeting Analyst",
  "BRD Builder",
  "PRD Builder",
  "UX UI Designer",
  "ADR Creator",
  "Privacy Planner",
  "RAI Planner",
  "Security Planner",
  "SSSC Planner",
  "Functional Planner",
  "Backlog Manager",
]

const headless = (prompt: boolean): HeadlessCapabilitiesV1 => ({
  schemaVersion: 1,
  prompt,
  outputFormats: ["text"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "native",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "hard-deny",
  changedFiles: "none",
  usage: false,
  cost: false,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
})

const hveCatalog = async (): Promise<CombinedGuideCatalog> => {
  const native = await loadProfileGuide(guideRoot, nativeHveIdentity)
  const sandbox = await loadProfileGuide(guideRoot, sandboxHveIdentity)
  return parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      sandboxCommandPath: "/opt/trellage/bin/trellage",
      native: [
        {
          launcher: "cpx",
          harness: "copilot",
          name: "hve",
          description: "Native HVE Core",
          headless: headless(true),
          sandbox: false,
          herdrCompatibility: { status: "supported" },
          guide: native.guide,
          commandPath: "/opt/trellage/bin/cpx",
        },
      ],
      sandbox: [
        {
          name: "copilot-hve",
          description: "Sandbox HVE Core",
          guide: sandbox.guide,
          path: path.join(repositoryRoot, "profiles", "copilot-hve", "profile.toml"),
          supportedPlatforms: ["linux/amd64"],
          harness: { kind: "copilot", version: "1.0.82" },
          resolutionPolicy: "floating",
          locallyResolved: false,
          releaseLockAvailable: false,
          skillBundles: ["sandbox-common"],
          skillsMode: "floating",
          finalDigestLocked: false,
          skills: [],
          plugins: [],
          mcps: [],
          sandbox: true,
          headless: headless(false),
          locked: false,
          herdrCompatibility: { status: "supported" },
        },
      ],
    }),
  )
}

const templateProvider: GuideProvider = {
  match: async () => {
    throw new Error("Generation must not rematch the profile")
  },
  generate: async ({ guide, workflowId, intent }) => ({
    candidates: templatePromptCandidates(guide, workflowId, intent),
  }),
  optimize: async ({ candidates }) => ({ candidates }),
  refine: async () => {
    throw new Error("This test does not refine prompts")
  },
}

describe("hve customer-engagement lifecycle workflows", () => {
  it.each(["native:cpx/hve", "sandbox:copilot-hve"])(
    "carries the selected lifecycle agent into all three actual terminal launches for %s",
    async (profileRef) => {
      const catalog = await hveCatalog()
      const response = await runGuideGenerate(templateProvider, catalog, guideRoot, {
        profileRef,
        intent:
          "We're starting discovery with a customer on a new capability and need to validate the problem before committing to a design",
        model: "test-model",
        effort: GuideEffort.Medium,
      })
      expect(response.profile.workflowId).toBe("customer-engagement-lifecycle")
      expect(response.candidates).toHaveLength(3)

      const selected = selectedProfileFromCatalogRef(catalog, profileRef, response.profile.workflowId)
      const native = selected.surface === "native"
      const baseArgs = [...(native ? ["hve"] : ["--profile", "copilot-hve"]), "--agent", "hve-core:dt-coach"]
      for (const candidate of response.candidates) {
        expect(candidate.command.args).toEqual([...baseArgs, ...(native ? ["-p", candidate.prompt] : [])])
        const launches: CommandSpec[] = []
        const writes: string[] = []
        await expect(
          executeGuideUiResult(buildCurrentTerminalResult(selected, candidate.prompt, repositoryRoot), {
            runner: {
              run: async () => {
                throw new Error("No external command expected")
              },
            },
            write: (text) => {
              writes.push(text)
            },
            runInteractive: async (command) => {
              launches.push(command)
            },
          }),
        ).resolves.toBe(0)
        expect(launches).toEqual([
          {
            executable: selected.commandPath,
            args: [...baseArgs, ...(native ? ["-i", candidate.prompt] : [candidate.prompt])],
          },
        ])
        expect(writes).toEqual([])
      }
    },
  )

  it.each(["native:cpx/hve", "sandbox:copilot-hve"])(
    "retains the lifecycle agent through Herdr handoff and queued prompt edits for %s",
    async (profileRef) => {
      const catalog = await hveCatalog()
      const selected = selectedProfileFromCatalogRef(catalog, profileRef, "customer-engagement-lifecycle")
      const prompt = "Preserve the customer's '$HOME' wording.\nKeep unknown assumptions explicit."
      const baseArgs = [
        ...(selected.surface === "native" ? ["hve"] : ["--profile", "copilot-hve"]),
        "--agent",
        "hve-core:dt-coach",
      ]
      const context: HerdrContext = {
        workspaceId: "1",
        paneId: "1-1",
        surface: "pane",
      }
      const handoffs = [
        buildCurrentHerdrWorkspaceResult(selected, prompt, repositoryRoot, context),
        buildNewHerdrTabResult(selected, prompt, repositoryRoot, context),
        buildNewHerdrWorktreeResult(selected, prompt, repositoryRoot, "customer-discovery", "HEAD"),
        buildExistingHerdrWorktreeResult(selected, prompt, repositoryRoot, repositoryRoot),
      ]
      for (const result of handoffs) {
        expect(result.promptDelivery).toBe("command")
        expect(result.command.args).toEqual([
          ...baseArgs,
          ...(selected.surface === "native" ? ["-i", prompt] : [prompt]),
        ])
      }
      const edited = replaceQueuedGuideJobPrompt(
        createQueuedGuideJob(1, selected, prompt, { kind: "new-tab" }),
        `${prompt}\nDiscovery only.`,
      )
      expect(parseSelectedProfile(edited.profile)).toMatchObject({ agent: "hve-core:dt-coach" })
      expect(edited.command.args).toEqual([
        ...baseArgs,
        ...(selected.surface === "native" ? ["-i", edited.prompt] : [edited.prompt]),
      ])
    },
  )

  it("does not apply DT Coach to existing workflows or replace the pinned RPI agent", async () => {
    const catalog = await hveCatalog()
    for (const entry of [...catalog.native, ...catalog.sandbox]) {
      const ref = "launcher" in entry ? `native:${entry.launcher}/${entry.name}` : `sandbox:${entry.name}`
      for (const candidate of entry.guide.workflows) {
        if (candidate.id === "customer-engagement-lifecycle") continue
        const selected = selectedProfileFromCatalogRef(catalog, ref, candidate.id)
        expect(
          buildCurrentTerminalResult(selected, "Keep the RPI workflow.", repositoryRoot).command.args,
        ).not.toContain("--agent")
      }
    }
    const lens = pinnedGuideLenses(catalog).find(({ kind }) => kind === "hve-rpi")
    if (lens === undefined) throw new Error("Missing pinned HVE RPI lens")
    expect(selectedProfileForPinnedLens(catalog, lens)).toMatchObject({ agent: "hve-core:rpi-agent" })
  })

  it("parses the native cpx/hve guide with the new lifecycle workflow", async () => {
    const loaded = await loadProfileGuide(guideRoot, nativeHveIdentity)
    const lifecycle = workflow(loaded.guide.workflows, "customer-engagement-lifecycle")
    const normalized = normalizeWhitespace(lifecycle.promptTemplate)
    for (const agentName of expectedLifecycleAgentNames) {
      expect(normalized, `native lifecycle prompt should reference ${agentName}`).toContain(agentName)
    }
  })

  it("parses the sandbox copilot-hve guide with the new lifecycle workflow", async () => {
    const loaded = await loadProfileGuide(guideRoot, sandboxHveIdentity)
    const lifecycle = workflow(loaded.guide.workflows, "customer-engagement-lifecycle")
    const normalized = normalizeWhitespace(lifecycle.promptTemplate)
    for (const agentName of expectedLifecycleAgentNames) {
      expect(normalized, `sandbox lifecycle prompt should reference ${agentName}`).toContain(agentName)
    }
  })

  it("preserves the DT confidence-marker vocabulary and never-skip-a-phase boundary", async () => {
    for (const identity of [nativeHveIdentity, sandboxHveIdentity]) {
      const loaded = await loadProfileGuide(guideRoot, identity)
      const lifecycle = workflow(loaded.guide.workflows, "customer-engagement-lifecycle")
      const normalized = normalizeWhitespace(lifecycle.promptTemplate)
      expect(normalized).toContain("validated/assumed/unknown/conflicting")
      expect(normalized).toContain("never skip a lifecycle phase or bypass evidence")
    }
  })

  it("gates functional planning and backlog management behind a requirements-maturity boundary", async () => {
    for (const identity of [nativeHveIdentity, sandboxHveIdentity]) {
      const loaded = await loadProfileGuide(guideRoot, identity)
      const lifecycle = workflow(loaded.guide.workflows, "customer-engagement-lifecycle")
      const normalized = normalizeWhitespace(lifecycle.promptTemplate)
      expect(normalized).toContain(
        "Use the Functional Planner and Backlog Manager agents only once requirements are sufficiently mature.",
      )
    }
  })

  it("hands off mature Design Thinking or requirements work into rpi-research", async () => {
    for (const identity of [nativeHveIdentity, sandboxHveIdentity]) {
      const loaded = await loadProfileGuide(guideRoot, identity)
      const lifecycle = workflow(loaded.guide.workflows, "customer-engagement-lifecycle")
      const normalized = normalizeWhitespace(lifecycle.promptTemplate)
      expect(normalized).toContain("formal DT-to-RPI handoff into rpi-research")
      // The existing rpi-research workflow (or, for Sandbox, /rpi) remains the
      // formal RPI entry point the lifecycle workflow hands off into.
      const rpiWorkflowId = identity.surface === "native" ? "rpi-research" : "rpi-agent-cycle"
      expect(() => workflow(loaded.guide.workflows, rpiWorkflowId)).not.toThrow()
    }
  })

  it("renders exactly one {{intent}} placeholder for the new lifecycle workflow", async () => {
    for (const identity of [nativeHveIdentity, sandboxHveIdentity]) {
      const loaded = await loadProfileGuide(guideRoot, identity)
      const lifecycle = workflow(loaded.guide.workflows, "customer-engagement-lifecycle")
      const frame = workflowPromptFrame(lifecycle)
      const rendered = `${frame.beforeBody}Do the thing${frame.afterBody}`
      expect(rendered).not.toContain("{{intent}}")
      expect(rendered).toContain("Do the thing")
    }
  })

  it("keeps the native RPI-only workflows unchanged", async () => {
    const loaded = await loadProfileGuide(guideRoot, nativeHveIdentity)
    expect(workflow(loaded.guide.workflows, "rpi-agent-cycle").promptTemplate).toBe(
      "Take this request through a complete Research, Plan, Implement, and\n" +
        "Review cycle. Keep durable evidence for each stage, challenge the plan\n" +
        "before implementation, and verify the final result: {{intent}}",
    )
    expect(workflow(loaded.guide.workflows, "rpi-research").promptTemplate).toBe(
      "Use the rpi-research skill to investigate {{intent}} and produce a\n" +
        "durable research note before any planning or implementation begins.",
    )
    expect(workflow(loaded.guide.workflows, "rpi-plan-and-critique").promptTemplate).toBe(
      "Use the rpi-plan skill to draft a plan for {{intent}}, then use\n" +
        "rpi-plan-critique to challenge it before implementation begins.",
    )
    expect(workflow(loaded.guide.workflows, "rpi-implement-and-review").promptTemplate).toBe(
      "Use the rpi-implement skill to execute the approved plan for\n" +
        "{{intent}}, then use rpi-review to record verification evidence.",
    )
    expect(loaded.guide.workflows.map(({ id }) => id)).toEqual([
      "rpi-agent-cycle",
      "rpi-research",
      "rpi-plan-and-critique",
      "rpi-implement-and-review",
      "customer-engagement-lifecycle",
    ])
  })

  it("keeps the Sandbox RPI-only workflows unchanged", async () => {
    const loaded = await loadProfileGuide(guideRoot, sandboxHveIdentity)
    const rpiAgentCycle = workflow(loaded.guide.workflows, "rpi-agent-cycle")
    expect(rpiAgentCycle.skill).toBe("rpi")
    expect(rpiAgentCycle.promptTemplate).toBe("/rpi {{intent}}")
    const adaptHvePatterns = workflow(loaded.guide.workflows, "adapt-hve-patterns")
    expect(adaptHvePatterns.skill).toBe("hve-builder")
    expect(adaptHvePatterns.promptTemplate).toBe("/hve-builder {{intent}}")
    expect(loaded.guide.workflows.map(({ id }) => id)).toEqual([
      "rpi-agent-cycle",
      "adapt-hve-patterns",
      "customer-engagement-lifecycle",
    ])
  })
})
