import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadProfileGuide } from "@trellage/guide-core"
import type { CombinedGuideCatalog } from "../../src/guide-catalog.ts"
import { createNodeCommandRunner } from "../../src/guide-launch.ts"
import {
  captureEngagementSnapshot,
  engagementDefaultIntent,
  inspectEngagementRepository,
} from "../../src/engagement-context.ts"
import { EngagementWorkStore } from "../../src/engagement-work.ts"
import { type EngagementAssessment, type EngagementCitation } from "../../src/engagement-assessment.ts"

export const engagementGuideRoot = fileURLToPath(new URL("../../../../profile-guides", import.meta.url))
export const engagementSourcePath = "docs/engagement/overview.md"
export const engagementSource =
  "# Engagement\nThe sponsor needs evidence about onboarding delays.\nNo interviews have been recorded.\n"
export const engagementCitation: EngagementCitation = {
  path: engagementSourcePath,
  startLine: 2,
  endLine: 3,
  quote: "The sponsor needs evidence about onboarding delays.",
}
export const engagementAssessment: EngagementAssessment = {
  schemaVersion: 1,
  outcome: "recommendation",
  understanding: [
    {
      text: "Interview evidence is not yet documented in the selected overview.",
      basis: "documented",
      citations: [engagementCitation],
    },
  ],
  uncertainties: ["Customer interview participants and availability are unknown."],
  question: null,
  actions: [
    {
      title: "Prepare a learning workshop",
      objective: "Prepare questions to understand onboarding delays, using the existing evidence.",
      whyNow: "The engagement has a stated concern but no recorded interviews.",
      expectedOutput: "A draft workshop brief with a learning objective, participant roles, and unresolved questions.",
      reviewer: "Engagement lead and customer sponsor",
      citations: [engagementCitation],
      workflow: { profileRef: "native:copilot/hve", workflowId: "customer-discovery" },
    },
  ],
}

export const createEngagementFixture = async (directory: string) => {
  const runner = createNodeCommandRunner()
  await runner.run("git", ["-c", "init.templateDir=", "init", "--quiet"], { cwd: directory })
  await mkdir(path.join(directory, "docs/engagement"), { recursive: true })
  await writeFile(path.join(directory, engagementSourcePath), engagementSource)
  const catalog: CombinedGuideCatalog = {
    schemaVersion: 1,
    sandboxCommandPath: "/fixture/trellage",
    sandbox: [],
    native: [
      {
        launcher: "copilot",
        harness: "copilot",
        name: "hve",
        description: "Native HVE",
        commandPath: "/fixture/trx",
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
        guide: (await loadProfileGuide(engagementGuideRoot, { surface: "native", launcher: "copilot", profile: "hve" }))
          .guide,
      },
    ],
  }
  const repository = await inspectEngagementRepository(runner, directory)
  const snapshot = await captureEngagementSnapshot(runner, repository.root, repository.selected, "")
  const store = new EngagementWorkStore(repository.root, catalog, runner)
  return {
    runner,
    catalog,
    repository,
    snapshot,
    store,
    prepare: (assessment = engagementAssessment, index = 0) =>
      store.prepare(engagementGuideRoot, engagementDefaultIntent, snapshot, assessment, index),
  }
}
