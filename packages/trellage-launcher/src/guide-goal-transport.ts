import {
  assertGuideGoalCandidate,
  assertPreparedGuideGoal,
  composeGuideGoalCandidate,
  guideGoalActivationInput,
  guideGoalArgvMaximumBytes,
  prepareGuideGoal,
  type GuideGoalCandidateContext,
  type GuideGoalExecution,
} from "./guide-goal-execution.ts"
import { GuideGoalError } from "./guide-goal-augment.ts"
import type { SelectedProfile } from "./guide-launch.ts"

export interface GuideGoalTransport {
  readonly mode: "argv" | "manual"
  readonly command: string
  readonly body: string
}

export const freezeGuideGoalCandidateContext = (
  execution: GuideGoalCandidateContext,
): GuideGoalCandidateContext => {
  assertPreparedGuideGoal(execution.goal)
  return Object.freeze({
    goal: prepareGuideGoal(execution.goal),
    controller: execution.controller,
    workflow: Object.freeze({ ...execution.workflow, examples: Object.freeze([...execution.workflow.examples]) }),
    approach: execution.approach,
  })
}

const compatibleGoalSurface = (profile: SelectedProfile, controller: GuideGoalExecution["controller"]): boolean => {
  if (controller === "codex-goal") return profile.surface === "native" && profile.launcher === "cdx"
  if (controller === "graph-of-loops") return profile.surface === "sandbox" && profile.profile === "claude-graph-of-loops"
  if (controller !== "claude-goal") return false
  return profile.surface === "native"
    ? profile.launcher === "cldx" && profile.profile === "default"
    : profile.profile.startsWith("claude-") && profile.profile !== "claude-graph-of-loops"
}

export const assertGuideGoalProfile = (profile: SelectedProfile, execution: GuideGoalExecution): void => {
  const policy = profile.goalExecutionPolicy
  if (policy === undefined || policy.controller !== execution.controller || !policy.workflowIds.includes(execution.workflow.id)) {
    throw new GuideGoalError("The selected profile does not declare this goal controller and workflow. Match the goal again.")
  }
  if (!compatibleGoalSurface(profile, execution.controller) || profile.agent !== undefined || execution.workflow.launchAgent !== undefined) {
    throw new GuideGoalError("This profile and goal controller do not have a supported launch path.")
  }
}

export const guideGoalPromptFromContext = (execution: GuideGoalCandidateContext): string =>
  composeGuideGoalCandidate(execution, { title: "Goal", prompt: execution.approach, notes: "" }).prompt

export const resolveGuideGoalTransport = (
  profile: SelectedProfile,
  prompt: string,
  execution: GuideGoalCandidateContext,
  destination: "current-terminal" | "herdr",
): GuideGoalTransport => {
  assertGuideGoalProfile(profile, execution)
  assertGuideGoalCandidate({ title: "Goal", notes: "", prompt, goalExecution: execution })
  const input = guideGoalActivationInput(execution, prompt)
  if (
    execution.controller === "codex-goal" ||
    (profile.surface === "native" && (destination === "herdr" || !profile.headlessPrompt))
  ) {
    return { mode: "manual", ...input }
  }
  if (Buffer.byteLength(prompt, "utf8") > guideGoalArgvMaximumBytes) {
    if (profile.surface === "sandbox" && execution.controller === "graph-of-loops") {
      return { mode: "manual", ...input }
    }
    throw new GuideGoalError("The goal exceeds the 64 KiB argv limit and this launch path has no supported manual input.")
  }
  return { mode: "argv", ...input }
}

export const guideGoalInputInstructions = (execution: GuideGoalExecution, prompt: string): string => {
  const { command, body } = guideGoalActivationInput(execution, prompt)
  return [
    `Type '${command} ' in the native command input, then paste the body below and submit.`,
    "Do not paste the command prefix with a large body: a paste placeholder can hide the slash command.",
    "",
    "Goal body:",
    body,
  ].join("\n")
}
