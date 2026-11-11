// Payloads of /api/goals, /api/steps and /api/folders the goal form reads. The spec Schema is shared/goal.ts.
import { Array, Effect, Order, Schema } from "effect"
import { AsyncData } from "foldkit"
import { GoalSpec, Grade } from "../../../shared/goal"
import { Folder } from "../../../shared/schemas"

const Policy = Schema.Literals(["auto", "human"])
const StepRow = Schema.Struct({ on: Schema.Boolean, min: Schema.String, max: Schema.String })

/** The form's state: plain strings and flags, like shared/goal.ts GoalDraft. */
export const GoalDraft = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  repo: Schema.String,
  base: Schema.String,
  prompt: Schema.String,
  steps: Schema.Record(Schema.String, StepRow),
  skills: Schema.Array(Schema.String),
  expectPr: Schema.Boolean,
  greenChecks: Schema.Boolean,
  bodyIncludes: Schema.String,
  untouched: Schema.String,
  expectSdlc: Schema.Boolean,
  gatesRun: Schema.Array(Schema.String),
  gatesSkipped: Schema.Array(Schema.String),
  approvals: Schema.Struct({ plan: Policy, findings: Policy, ship: Policy, other: Policy }),
  runs: Schema.String,
  minutesPerRun: Schema.String,
})
export type GoalDraft = typeof GoalDraft.Type

const GoalRun = Schema.Struct({
  outcome: Schema.String,
  factoryCommit: Schema.String,
  prUrl: Schema.NullOr(Schema.String),
})
export const GoalList = Schema.Struct({
  dir: Schema.String,
  factoryCommit: Schema.String,
  goals: Schema.Array(
    Schema.Struct({
      spec: GoalSpec,
      runs: Schema.Number,
      last: Schema.NullOr(GoalRun),
      grades: Schema.Array(Grade).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    }),
  ),
})
export type GoalList = typeof GoalList.Type

/** Grades of one goal under one grading version. Different versions measure differently, so they are never merged. */
export type GradeGroup = {
  readonly goalId: string
  readonly gradingVersion: string
  readonly points: ReadonlyArray<Grade>
}

const byAt = Order.mapInput(Order.Number, (g: Grade) => g.at)

/** One group per goal id × grading version, in goal order then version order; points in time order. */
export const gradeGroups = (goals: GoalList["goals"]): ReadonlyArray<GradeGroup> =>
  goals.flatMap(({ spec, grades }) =>
    Array.sort([...new Set(grades.map((g) => g.gradingVersion))], Order.String).map((gradingVersion) => ({
      goalId: spec.id,
      gradingVersion,
      points: Array.sort(
        grades.filter((g) => g.gradingVersion === gradingVersion),
        byAt,
      ),
    })),
  )

const CatalogStep = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  skills: Schema.Array(Schema.String),
})
export const GoalCatalog = Schema.Struct({ steps: Schema.Array(CatalogStep), folders: Schema.Array(Folder) })
export type GoalCatalog = typeof GoalCatalog.Type

export const LoopPrompt = Schema.Struct({ skill: Schema.String, prompt: Schema.String })
export type LoopPrompt = typeof LoopPrompt.Type

export const StepsPayload = Schema.Struct({ steps: Schema.Array(CatalogStep) })
export const FoldersPayload = Schema.Array(Folder)
export const SavedGoal = Schema.Struct({ id: Schema.String })

export const GoalListAsyncData = AsyncData.Schema(GoalList, Schema.String)
export const GoalCatalogAsyncData = AsyncData.Schema(GoalCatalog, Schema.String)
