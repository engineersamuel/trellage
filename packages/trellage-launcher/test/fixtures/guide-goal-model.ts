import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ModelInfo } from "@github/copilot-sdk"
import { CopilotGuideProvider, type GuideModelClient } from "../../src/copilot-guide-provider.ts"
import { defaultGuideModelRouting } from "../../src/guide-model-routing.ts"
import type { GuideGenerateResult, GuideMatchResult } from "../../src/guide-provider.ts"
import { record as readRecord } from "../../src/guide-text.ts"
import type { FixtureEvent, RecordFixtureEvent } from "./guide-integration-data.ts"

type GoalModelPhase = Extract<FixtureEvent, { readonly kind: "goal-model-input" }>["phase"]

const models: ReadonlyArray<ModelInfo> = Object.values(defaultGuideModelRouting).map(({ model, effort }) => ({
  id: model,
  name: model,
  capabilities: {
    supports: { vision: false, reasoningEffort: true },
    limits: { max_context_window_tokens: 1_050_000 },
  },
  supportedReasoningEfforts: [effort],
}))

const prompts = {
  match: "Fixture match",
  generate: "Fixture generate",
  optimize: "Fixture optimize",
  refine: "Fixture refine",
  enrich: "Fixture enrich",
}

export const createFixtureGoalModelProvider = async (root: string, record: RecordFixtureEvent) => {
  const skillDirectory = path.join(root, "goal-model", "prompt-master")
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(path.join(skillDirectory, "SKILL.md"), "# Prompt Master fixture\n\nReturn the fixture JSON.\n")

  return (phase: GoalModelPhase, response: GuideMatchResult | GuideGenerateResult): CopilotGuideProvider =>
    new CopilotGuideProvider({
      routing: defaultGuideModelRouting,
      prompts,
      baseDirectory: path.join(root, "goal-model", "state"),
      workingDirectory: path.join(root, "tmp"),
      copilotCliPath: path.join(root, "bin", "unused-copilot"),
      promptMasterSkillDirectory: skillDirectory,
      clientFactory: (): GuideModelClient => {
        let sent = false
        return {
          async start() {},
          async listModels() { return models },
          async createSession() {
            return {
              sessionId: `fixture-${phase}`,
              async sendAndWait({ prompt }) {
                assert(!sent, "The offline model response must not need repair")
                sent = true
                const content = prompt.match(/<untrusted-data>\n([\s\S]+)\n<\/untrusted-data>/u)?.[1]
                assert(content !== undefined, "The SDK request must keep model input in its data envelope")
                await record({
                  kind: "goal-model-input",
                  phase,
                  input: readRecord(JSON.parse(content), "fixture model input"),
                })
                return { data: { content: JSON.stringify(response) } }
              },
              async disconnect() {},
            }
          },
          async deleteSession() {},
          async stop() { return [] },
        }
      },
    })
}
