import type { ProfileGuideGoalController, ProfileGuideV1 } from "@trellage/guide-core"
import { renderGuideGoalProposal, type GuideGoalDraft } from "../../src/guide-goal-augment.ts"
import {
  composeGuideGoalCandidate,
  prepareGuideGoal,
  resolveGuideGoalExecution,
} from "../../src/guide-goal-execution.ts"
import { parseSelectedProfile } from "../../src/guide-launch.ts"
import { goalDraft, goalMeSkill } from "./goal-me-skill.ts"

export const goalTransportFixture = (
  controller: ProfileGuideGoalController = "codex-goal",
  options: { readonly task?: string; readonly approach?: string; readonly frame?: string; readonly draft?: GuideGoalDraft } = {},
) => {
  const draft = options.draft ?? { ...goalDraft, ...(options.task === undefined ? {} : { task: options.task }) }
  const goal = prepareGuideGoal(renderGuideGoalProposal(goalMeSkill, draft))
  const policy = { controller, workflowIds: ["implement"] }
  const guide: ProfileGuideV1 = {
    schemaVersion: 1,
    capabilities: ["implementation"],
    bestFor: ["Approved goals", "Repository changes"],
    avoidFor: ["Unbounded requests", "Missing objectives"],
    prerequisites: [],
    goalExecution: policy,
    workflows: [{
      id: "implement",
      description: "Implement the approved objective",
      examples: ["Repair retries", "Write the design"],
      promptTemplate: options.frame ?? "Use the selected workflow:\n{{intent}}",
    }],
  }
  const execution = resolveGuideGoalExecution(goal, guide, "implement")
  const candidate = composeGuideGoalCandidate(execution, {
    title: "Focused work",
    prompt: options.approach ?? "Start with the smallest reproducible case.",
    notes: "Keep the approved criteria.",
  })
  const profile = parseSelectedProfile({
    surface: "native",
    launcher: controller === "codex-goal" ? "codex" : "claude",
    commandPath: "/opt/trellage/bin/trx",
    profile: controller === "codex-goal" ? "superpowers" : "default",
    headlessPrompt: true,
    goalExecutionPolicy: policy,
  })
  return { goal, execution, candidate, profile, guide }
}
