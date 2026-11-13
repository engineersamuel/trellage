import { Array, Option, Record, Result, pipe } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import { draftToSpec, emptyDraft, specToDraft } from "../../../shared/goal"
import { CopyText, FetchCatalog, FetchGoals, SaveGoal } from "./command"
import type { GoalDraft } from "./domain"
import { Message } from "./message"
import type { Model } from "./model"

type UpdateReturn = Update.Return<Model, Message>
type Step = Update.Step<Model, Message>

export const DIALOG_ID = "goals"

export const init = (): UpdateReturn => ({
  model: {
    dialog: Dialog.init({ id: DIALOG_ID }),
    goals: AsyncData.Idle(),
    catalog: AsyncData.Idle(),
    draft: emptyDraft(),
    problems: [],
    maybeSaved: Option.none(),
    isCopied: false,
    isEditing: false,
  },
})

const dialogStep = (f: (dialog: Dialog.Model) => ReturnType<typeof Dialog.open>) =>
  Update.foldChildStep({
    update: f,
    read: (model: Model) => Option.some(model.dialog),
    write: (model: Model, dialog: Dialog.Model) =>
      dialog === model.dialog ? model : modifyFields(model, { dialog: () => dialog }),
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
    foldOutMessage: Dialog.OutMessage.match<Step>({
      Opened: () => (model) => ({ model }),
      Closed: () => (model) => ({ model }),
    }),
  })

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, dialog: Dialog.Model) =>
    dialog === model.dialog ? model : modifyFields(model, { dialog: () => dialog }),
  toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Step>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
})

/** Opening the dialog loads the goal list and the catalog fresh, so new steps and folders show up. */
const open: Step = (model) =>
  Update.combine(
    modifyFields(model, {
      goals: (current) => Option.getOrElse(AsyncData.revalidateOrLoad(current), () => current),
      catalog: (current) => Option.getOrElse(AsyncData.revalidateOrLoad(current), () => current),
    }),
    [dialogStep(Dialog.open), (next) => ({ model: next, commands: [FetchGoals(), FetchCatalog()] })],
  )

/** Any edit clears the last save result and problem list: they describe an older draft. */
const edit = (model: Model, f: (draft: GoalDraft) => GoalDraft): UpdateReturn => ({
  model: modifyFields(model, { draft: f, problems: () => [], maybeSaved: () => Option.none(), isCopied: () => false }),
})

const field = <K extends keyof GoalDraft>(model: Model, key: K, value: GoalDraft[K]): UpdateReturn =>
  edit(model, (draft) => ({ ...draft, [key]: value }))

const stepRow = (
  model: Model,
  step: string,
  f: (row: GoalDraft["steps"][string]) => GoalDraft["steps"][string],
): UpdateReturn =>
  edit(model, (draft) => ({
    ...draft,
    steps: { ...draft.steps, [step]: f(draft.steps[step] ?? { on: false, min: "1", max: "" }) },
  }))

const knownSteps = (model: Model): ReadonlyArray<string> | undefined =>
  Option.getOrUndefined(Option.map(AsyncData.getData(model.catalog), ({ steps }) => Array.map(steps, ({ id }) => id)))

const submit = (model: Model): UpdateReturn => {
  const result = draftToSpec(model.draft, knownSteps(model))
  return result.ok
    ? { model: modifyFields(model, { problems: () => [] }), commands: [SaveGoal({ spec: result.spec })] }
    : { model: modifyFields(model, { problems: () => result.problems }) }
}

const editGoal = (model: Model, id: string): UpdateReturn =>
  pipe(
    AsyncData.getData(model.goals),
    Option.flatMap(({ goals }) => Array.findFirst(goals, ({ spec }) => spec.id === id)),
    Option.match({
      onNone: () => ({ model }),
      onSome: ({ spec }) => ({
        model: modifyFields(model, {
          draft: () => specToDraft(spec),
          problems: () => [],
          maybeSaved: () => Option.none(),
          isEditing: () => true,
        }),
      }),
    }),
  )

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchGoals: ({ goals }) => ({ model: modifyFields(model, { goals: () => AsyncData.succeed(goals) }) }),
    FailedFetchGoals: ({ error }) => ({
      model: modifyFields(model, { goals: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    SucceededFetchCatalog: ({ catalog }) => ({
      model: modifyFields(model, { catalog: () => AsyncData.succeed(catalog) }),
    }),
    FailedFetchCatalog: ({ error }) => ({
      model: modifyFields(model, { catalog: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    ClickedOpenGoals: () => (model.dialog.isOpen ? dialogStep(Dialog.close)(model) : open(model)),
    GotDialogMessage: ({ message: dialogMessage }) => foldDialog(model, dialogMessage),
    UpdatedId: ({ value }) => field(model, "id", value),
    UpdatedTitle: ({ value }) => field(model, "title", value),
    SelectedRepo: ({ value }) => field(model, "repo", value),
    UpdatedBase: ({ value }) => field(model, "base", value),
    UpdatedPrompt: ({ value }) => field(model, "prompt", value),
    ToggledStep: ({ step, isChecked }) => stepRow(model, step, (row) => ({ ...row, on: isChecked })),
    UpdatedStepMin: ({ step, value }) => stepRow(model, step, (row) => ({ ...row, on: true, min: value })),
    UpdatedStepMax: ({ step, value }) => stepRow(model, step, (row) => ({ ...row, on: true, max: value })),
    ToggledSkill: ({ skill, isChecked }) =>
      edit(model, (draft) => ({
        ...draft,
        skills: isChecked ? Array.dedupe([...draft.skills, skill]) : Array.filter(draft.skills, (s) => s !== skill),
      })),
    ToggledExpectPr: ({ isChecked }) => field(model, "expectPr", isChecked),
    ToggledGreenChecks: ({ isChecked }) => field(model, "greenChecks", isChecked),
    UpdatedBodyIncludes: ({ value }) => field(model, "bodyIncludes", value),
    UpdatedUntouched: ({ value }) => field(model, "untouched", value),
    ClickedPolicy: ({ topic, policy }) =>
      edit(model, (draft) => ({ ...draft, approvals: { ...draft.approvals, [topic]: policy } })),
    ToggledExpectSdlc: ({ isChecked }) => field(model, "expectSdlc", isChecked),
    ClickedGateExpectation: ({ gate, expectation }) =>
      edit(model, (draft) => ({
        ...draft,
        gatesRun:
          expectation === "run"
            ? Array.dedupe([...draft.gatesRun, gate])
            : Array.filter(draft.gatesRun, (g) => g !== gate),
        gatesSkipped:
          expectation === "skip"
            ? Array.dedupe([...draft.gatesSkipped, gate])
            : Array.filter(draft.gatesSkipped, (g) => g !== gate),
      })),
    UpdatedUsd: ({ value }) => field(model, "usd", value),
    ClickedEditGoal: ({ id }) => editGoal(model, id),
    SubmittedGoal: () => submit(model),
    SucceededSaveGoal: ({ saved }) => ({
      model: modifyFields(model, { maybeSaved: () => Option.some(saved), isCopied: () => false }),
      commands: [FetchGoals()],
    }),
    FailedSaveGoal: ({ error }) => ({ model: modifyFields(model, { problems: () => [`Could not save: ${error}`] }) }),
    ClickedCopy: ({ text }) => ({ model, commands: [CopyText({ text })] }),
    CompletedCopy: () => ({ model: modifyFields(model, { isCopied: () => true }) }),
  })

/** Every skill a step of the catalog loads, sorted, once each. */
export const catalogSkills = (model: Model): ReadonlyArray<string> =>
  Option.match(AsyncData.getData(model.catalog), {
    onNone: () => [],
    onSome: ({ steps }) =>
      Array.sort(Array.dedupe(Array.flatMap(steps, ({ skills }) => skills)), (a: string, b: string) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
  })

export const stepRows = (model: Model) => Record.toEntries(model.draft.steps)
