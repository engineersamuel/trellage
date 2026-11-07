import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Dialog } from "@foldkit/ui";
import { GoalCatalog, GoalList, LoopPrompt } from "./domain";

const Topic = Schema.Literals(["plan", "findings", "ship", "other"]);
const Policy = Schema.Literals(["auto", "human"]);

export const Message = defineMessageUnion({
  // Loading
  SucceededFetchGoals: { goals: GoalList },
  FailedFetchGoals: { error: Schema.String },
  SucceededFetchCatalog: { catalog: GoalCatalog },
  FailedFetchCatalog: { error: Schema.String },
  // Dialog
  ClickedOpenGoals: {},
  GotDialogMessage: { message: Dialog.Message },
  // One Message per field, so DevTools shows which field changed.
  UpdatedId: { value: Schema.String },
  UpdatedTitle: { value: Schema.String },
  SelectedRepo: { value: Schema.String },
  UpdatedBase: { value: Schema.String },
  UpdatedPrompt: { value: Schema.String },
  ToggledStep: { step: Schema.String, isChecked: Schema.Boolean },
  UpdatedStepMin: { step: Schema.String, value: Schema.String },
  UpdatedStepMax: { step: Schema.String, value: Schema.String },
  ToggledSkill: { skill: Schema.String, isChecked: Schema.Boolean },
  ToggledExpectPr: { isChecked: Schema.Boolean },
  ToggledGreenChecks: { isChecked: Schema.Boolean },
  UpdatedBodyIncludes: { value: Schema.String },
  UpdatedUntouched: { value: Schema.String },
  ClickedPolicy: { topic: Topic, policy: Policy },
  UpdatedRuns: { value: Schema.String },
  UpdatedMinutes: { value: Schema.String },
  ClickedEditGoal: { id: Schema.String },
  ClickedNewGoal: {},
  SubmittedGoal: {},
  SucceededSaveGoal: { saved: LoopPrompt },
  FailedSaveGoal: { error: Schema.String },
  ClickedCopy: { text: Schema.String },
  CompletedCopy: {},
});
export type Message = typeof Message.Type;
