import { createHash } from "node:crypto"
import {
  profileGuideGoalExecutionProblem,
  type ProfileGuideGoalController,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
} from "@trellage/guide-core"
import {
  GuideGoalError,
  validateGuideGoalDraft,
  validateGuideGoalPrompt,
  type GuideGoalDraft,
  type GuideGoalProposal,
} from "./guide-goal-augment.ts"
import type { GuideGenerateCandidate } from "./guide-provider.ts"
import { workflowPromptFrame } from "./guide-workflow-prompt.ts"
import { text } from "./guide-text.ts"

export const guideGoalPromptMaximumLength = 96_000
export const guideGoalApproachMaximumLength = 8000
export const guideClaudeGoalConditionMaximumLength = 4000
export const guideGoalArgvMaximumBytes = 64 * 1024

export interface PreparedGuideGoal {
  readonly draft: GuideGoalDraft
  readonly prompt: string
  readonly fingerprint: string
}

export interface GuideGoalExecution {
  readonly goal: PreparedGuideGoal
  readonly controller: ProfileGuideGoalController
  readonly workflow: ProfileGuideWorkflow
}

export interface GuideGoalCandidateContext extends GuideGoalExecution {
  readonly approach: string
}

export type GuideGoalCandidate = GuideGenerateCandidate & {
  readonly goalExecution: GuideGoalCandidateContext
}

const fingerprint = (draft: GuideGoalDraft, prompt: string): string =>
  createHash("sha256").update(JSON.stringify({ draft, prompt })).digest("hex")

export const prepareGuideGoal = (proposal: GuideGoalProposal): PreparedGuideGoal => {
  const validated = validateGuideGoalDraft(proposal.draft)
  const prompt = validateGuideGoalPrompt(proposal.prompt)
  const draft = Object.freeze({ ...validated, criteria: Object.freeze([...validated.criteria]) })
  return Object.freeze({ draft, prompt, fingerprint: fingerprint(draft, prompt) })
}

export const assertPreparedGuideGoal = (goal: PreparedGuideGoal): void => {
  const validated = prepareGuideGoal(goal)
  if (validated.fingerprint !== goal.fingerprint) {
    throw new GuideGoalError("The prepared goal changed. Review and approve it again.")
  }
}

export const guideGoalControllerLabel = (controller: ProfileGuideGoalController): string => {
  if (controller === "codex-goal") return "Codex /goal"
  if (controller === "claude-goal") return "Claude /goal"
  return "Graph of Loops"
}

export const renderPreparedGuideGoal = (goal: PreparedGuideGoal): string => [
  `ARTIFACT: ${goal.draft.artifact}`,
  "",
  "TASK:",
  goal.draft.task,
  "",
  "SUCCESS CRITERIA:",
  ...goal.draft.criteria.map((criterion) => `- ${criterion}`),
  "",
  "COMPLETION:",
  "Re-score the actual artifact from 1 to 10 on every criterion and show evidence in the conversation.",
  "Finish only when every criterion scores at least 8 and the selected controller's required gates pass.",
  "Fix the weakest criterion first. Do not weaken or replace the task or success criteria.",
  "Make sensible assumptions instead of asking avoidable questions.",
  "The selected goal controller alone owns progress, continuation, and completion.",
].join("\n")

const renderExecutionPrompt = (execution: GuideGoalExecution, approach: string): string => {
  const frame = workflowPromptFrame(execution.workflow)
  const body = [
    renderPreparedGuideGoal(execution.goal),
    "",
    "EXECUTION APPROACH:",
    "Use this guidance only where it preserves the approved task, criteria, completion rule, and profile constraints.",
    approach,
  ].join("\n")
  const workflowBody = execution.controller === "graph-of-loops"
    ? body.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    : body
  const workflowPrompt = `${frame.beforeBody}${workflowBody}${frame.afterBody}`
  return execution.controller === "graph-of-loops" ? workflowPrompt : `/goal ${workflowPrompt}`
}

export const guideGoalApproachBudget = (execution: GuideGoalExecution): number => {
  const fixedPrompt = renderExecutionPrompt(execution, "")
  const remaining = guideGoalPromptMaximumLength - [...fixedPrompt].length
  const hostBudget = execution.controller === "graph-of-loops" ? Math.floor(remaining / 2) : remaining
  const controllerBudget = execution.controller === "claude-goal"
    ? guideClaudeGoalConditionMaximumLength - [...fixedPrompt.slice("/goal ".length)].length
    : guideGoalApproachMaximumLength
  return Math.min(guideGoalApproachMaximumLength, hostBudget, controllerBudget)
}

export const resolveGuideGoalExecution = (
  goal: PreparedGuideGoal,
  guide: ProfileGuideV1,
  workflowId: string,
): GuideGoalExecution => {
  assertPreparedGuideGoal(goal)
  const policy = guide.goalExecution
  if (policy === undefined || !policy.workflowIds.includes(workflowId)) {
    throw new GuideGoalError("This workflow has no supported goal controller. Choose a goal-compatible workflow.")
  }
  const problem = profileGuideGoalExecutionProblem(policy, guide.workflows)
  if (problem !== undefined) throw new GuideGoalError(`The goal policy is invalid: ${problem}.`)
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new GuideGoalError("The goal workflow is no longer available. Match the goal again.")
  const execution = Object.freeze({
    goal,
    controller: policy.controller,
    workflow: Object.freeze({ ...workflow, examples: Object.freeze([...workflow.examples]) }),
  })
  if (guideGoalApproachBudget(execution) < 1) {
    throw new GuideGoalError(policy.controller === "claude-goal"
      ? "The approved goal and workflow exceed Claude's 4,000-character condition limit. Choose another goal controller."
      : "The approved goal and workflow leave no approach space within the 96,000-character goal prompt limit.")
  }
  text(renderExecutionPrompt(execution, ""), "goal prompt", guideGoalPromptMaximumLength, { multiline: true })
  return execution
}

export const hasGuideGoalControllerCommand = (prompt: string): boolean =>
  /(?:^|[^\p{L}\p{N}_:/.-])[/\$](?:goal(?:-me)?|graph-of-loops)(?=$|[^\p{L}\p{N}_:/.-])/iu.test(prompt)

const assertGoalApproach = (execution: GuideGoalExecution, approach: string): string => {
  const value = text(approach, "goal execution approach", guideGoalApproachBudget(execution), { multiline: true })
  if (hasGuideGoalControllerCommand(value)) {
    throw new GuideGoalError("The approach must not start another goal controller or Goal-me interview.")
  }
  return value
}

export const composeGuideGoalCandidate = (
  execution: GuideGoalExecution,
  candidate: GuideGenerateCandidate,
): GuideGoalCandidate => {
  assertPreparedGuideGoal(execution.goal)
  const approach = assertGoalApproach(execution, candidate.prompt)
  const prompt = text(renderExecutionPrompt(execution, approach), "goal prompt", guideGoalPromptMaximumLength, { multiline: true })
  return {
    title: candidate.title,
    prompt,
    notes: candidate.notes,
    goalExecution: Object.freeze({ ...execution, approach }),
  }
}

export const guideGoalCandidateBody = (candidate: GuideGenerateCandidate): GuideGenerateCandidate => ({
  title: candidate.title,
  prompt: candidate.goalExecution?.approach ?? candidate.prompt,
  notes: candidate.notes,
})

export const editGuideGoalCandidate = (
  candidate: GuideGoalCandidate,
  approach: string,
): GuideGoalCandidate => composeGuideGoalCandidate(candidate.goalExecution, { ...guideGoalCandidateBody(candidate), prompt: approach })

export const assertGuideGoalCandidate = (candidate: GuideGoalCandidate): void => {
  const expected = composeGuideGoalCandidate(candidate.goalExecution, guideGoalCandidateBody(candidate))
  if (expected.prompt !== candidate.prompt) {
    throw new GuideGoalError("The candidate no longer matches its approved goal and controller.")
  }
}

export const guideGoalActivationInput = (
  execution: GuideGoalExecution,
  prompt: string,
): { readonly command: string; readonly body: string } => {
  const command = execution.controller === "graph-of-loops" ? "/graph-of-loops" : "/goal"
  if (!prompt.startsWith(`${command} `)) {
    throw new GuideGoalError(`The goal prompt must start with ${command}.`)
  }
  const body = prompt.slice(command.length + 1)
  if (execution.controller === "claude-goal" && [...body].length > guideClaudeGoalConditionMaximumLength) {
    throw new GuideGoalError("The Claude goal condition exceeds 4,000 characters.")
  }
  return { command, body }
}
