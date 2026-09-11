import {
  renderGuideGoalProposal,
  type GuideGoalAugmentProvider,
  type GuideGoalAnswer,
} from "../../src/guide-goal-augment.js"
import { FixtureMode, type RecordFixtureEvent } from "./guide-integration-data.js"
import { goalMeSkill } from "./goal-me-skill.js"

export const goalArtifactQuestion = "What should this task produce?"
export const goalArtifact = "A review report"
export const revisedGoalIntent = "Review the sign-out flow for regressions."
const recommendedArtifact = `${goalArtifact} (Recommended: smallest offline v1)`
export const goalCriteria = [
  "The report identifies token-expiry behavior.",
  "Each finding cites the affected code.",
  "Each finding includes a repeatable failure example.",
]

const artifactQuestion = (mode: FixtureMode): string => mode === FixtureMode.GoalLongQuestion
  ? `${goalArtifactQuestion}\n${Array.from({ length: 32 }, (_, index) =>
      `Decision context ${index + 1}: Keep the complete question available without hiding the answer controls.`,
    ).join("\n")}\nEnd of question context.`
  : goalArtifactQuestion

type AskFixtureGoal = (question: string, choices?: string[], allowFreeform?: boolean) => Promise<GuideGoalAnswer>

const fixtureTaskIntent = (mode: FixtureMode, sessionId: number, intent: string): string => {
  if (mode !== FixtureMode.GoalReapproval || sessionId !== 2) return intent
  assert(intent.endsWith(`\nReplace the task: ${revisedGoalIntent}`))
  return revisedGoalIntent
}

const collectGoalFocus = async (ask: AskFixtureGoal, artifact: string, automatic: boolean) => {
  const focus = await ask(
    `What must ${artifact} cover?`,
    automatic ? ["All authentication", "Token expiry (Recommended)"] : undefined,
  )
  const audience = automatic ? await ask("Who will read this report?") : undefined
  if (automatic) await ask("Should findings cite evidence?", ["Skip sources", "Cite source lines (Recommended)"], false)
  return { focus, audience }
}

export const createFixtureGoalProvider = (mode: FixtureMode, record: RecordFixtureEvent): GuideGoalAugmentProvider => {
  let sessions = 0
  return {
    async augment(input, context) {
      const sessionId = ++sessions
      const automatic = mode === FixtureMode.GoalRecommended
      await record({ kind: "goal-start", sessionId, intent: input.intent, previousTurns: input.history.length })
      const taskIntent = fixtureTaskIntent(mode, sessionId, input.intent)
      const ask = async (question: string, choices?: string[], allowFreeform = true): Promise<GuideGoalAnswer> => {
        const answer = await context.interactions.ask({ question, choices, allowFreeform })
        await record({ kind: "goal-answer", sessionId, question, answer })
        return answer
      }
      try {
        const previousAnswer = input.history.find(({ request, response }) =>
          request.kind === "question" && request.question.question === artifactQuestion(mode) && response.kind === "answer",
        )?.response
        const artifact = previousAnswer?.kind === "answer" ? previousAnswer.answer : await ask(
          artifactQuestion(mode), automatic ? ["A patch", recommendedArtifact] : [goalArtifact, "A patch"],
        )
        if (mode === FixtureMode.GoalFailure && sessionId === 1) throw new Error("Fixture goal connection failed.")
        const artifactName = artifact.answer === recommendedArtifact ? goalArtifact : artifact.answer
        const { focus, audience } = await collectGoalFocus(ask, artifactName, automatic)
        let revision = ""
        while (!context.signal.aborted) {
          const proposal = renderGuideGoalProposal(goalMeSkill, {
            artifact: artifactName,
            task: `${taskIntent}\nFocus: ${focus.answer}${audience === undefined ? "" : `\nAudience: ${audience.answer}`}${revision.length === 0 ? "" : `\nRevision: ${revision}`}`,
            criteria: goalCriteria,
          })
          await record({ kind: "goal-proposal", sessionId, proposal })
          const review = await context.interactions.review(proposal)
          await record({ kind: "goal-review", sessionId, review })
          if (review.decision === "use") return proposal.prompt
          revision = review.feedback
          await ask(
            `Apply this revision: ${revision}?`,
            automatic ? ["Keep discussing", "Apply this change (Recommended)"] : ["Apply this change", "Keep discussing"],
            false,
          )
        }
        throw new Error("Fixture goal interview cancelled.")
      } finally {
        await record({ kind: "goal-stop", sessionId, cancelled: context.signal.aborted })
      }
    },
  }
}
import assert from "node:assert/strict"
