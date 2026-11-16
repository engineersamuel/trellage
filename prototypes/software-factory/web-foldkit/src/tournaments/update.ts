import { Option, Result } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import { ControlTournament, CreateTournament, FetchTournament, FetchTournaments } from "./command"
import { parseSources } from "./domain"
import { Message } from "./message"
import type { Model } from "./model"

type UpdateReturn = Update.Return<Model, Message>
type Step = Update.Step<Model, Message>

export const DIALOG_ID = "tournaments"

export const init = (): UpdateReturn => ({
  model: {
    dialog: Dialog.init({ id: DIALOG_ID }),
    tournaments: AsyncData.Idle(),
    maybeSelectedId: Option.none(),
    selected: AsyncData.Idle(),
    maybeExpandedRow: Option.none(),
    preset: "ui-skills",
    sourcesText: "",
    limitText: "",
    limitDialogText: "",
    maybeError: Option.none(),
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

/** Opening the dialog reloads the list, and the open tournament if one is selected. */
const open: Step = (model) =>
  Update.combine(
    modifyFields(model, {
      tournaments: (current) => Option.getOrElse(AsyncData.revalidateOrLoad(current), () => current),
    }),
    [
      dialogStep(Dialog.open),
      (next) => ({
        model: next,
        commands: [
          FetchTournaments(),
          ...Option.match(next.maybeSelectedId, { onNone: () => [], onSome: (id) => [FetchTournament({ id })] }),
        ],
      }),
    ],
  )

const select = (model: Model, id: string): UpdateReturn => ({
  model: modifyFields(model, {
    maybeSelectedId: () => Option.some(id),
    selected: () => AsyncData.Loading(),
    maybeExpandedRow: () => Option.none(),
    maybeError: () => Option.none(),
  }),
  commands: [FetchTournament({ id })],
})

/** A positive number from a text field, or none. */
const amount = (text: string): Option.Option<number> => {
  const n = Number(text.trim())
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? Option.some(n) : Option.none()
}

const submit = (model: Model): UpdateReturn => {
  const sources = parseSources(model.sourcesText)
  const idea = model.sourcesText.trim()
  const missing =
    model.preset === "ui-skills"
      ? sources.length
        ? null
        : "Add at least one source URL."
      : idea
        ? null
        : "Describe the idea."
  return missing
    ? { model: modifyFields(model, { maybeError: () => Option.some(missing) }) }
    : {
        model: modifyFields(model, { maybeError: () => Option.none() }),
        commands: [CreateTournament({ preset: model.preset, sources, idea, maybeLimitUsd: amount(model.limitText) })],
      }
}

/** Live updates: refetch the list while the dialog is open, and the detail when it shows that tournament. */
const changed = (model: Model, id: string): UpdateReturn =>
  model.dialog.isOpen
    ? {
        model,
        commands: [
          FetchTournaments(),
          ...(Option.contains(model.maybeSelectedId, id) ? [FetchTournament({ id })] : []),
        ],
      }
    : { model }

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchTournaments: ({ tournaments }) => ({
      model: modifyFields(model, { tournaments: () => AsyncData.succeed(tournaments) }),
    }),
    FailedFetchTournaments: ({ error }) => ({
      model: modifyFields(model, { tournaments: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    SucceededFetchTournament: ({ tournament }) =>
      Option.contains(model.maybeSelectedId, tournament.id)
        ? { model: modifyFields(model, { selected: () => AsyncData.succeed(tournament) }) }
        : { model },
    FailedFetchTournament: ({ error }) => ({
      model: modifyFields(model, { selected: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    ReceivedTournamentChange: ({ id }) => changed(model, id),
    ClickedOpenTournaments: () => (model.dialog.isOpen ? dialogStep(Dialog.close)(model) : open(model)),
    GotDialogMessage: ({ message: dialogMessage }) => foldDialog(model, dialogMessage),
    ClickedTournament: ({ id }) => select(model, id),
    ClickedBackToList: () => ({
      model: modifyFields(model, { maybeSelectedId: () => Option.none(), selected: () => AsyncData.Idle() }),
      commands: [FetchTournaments()],
    }),
    ClickedRow: ({ id }) => ({
      model: modifyFields(model, {
        maybeExpandedRow: (current) => (Option.contains(current, id) ? Option.none() : Option.some(id)),
      }),
    }),
    UpdatedSources: ({ value }) => ({
      model: modifyFields(model, { sourcesText: () => value, maybeError: () => Option.none() }),
    }),
    ClickedPreset: ({ preset }) => ({
      model: modifyFields(model, { preset: () => preset, maybeError: () => Option.none() }),
    }),
    UpdatedLimit: ({ value }) => ({ model: modifyFields(model, { limitText: () => value }) }),
    SubmittedTournament: () => submit(model),
    SucceededCreateTournament: ({ tournament }) =>
      Update.combine(modifyFields(model, { sourcesText: () => "", limitText: () => "" }), [
        (next) => select(next, tournament.id),
        (next) => ({ model: next, commands: [FetchTournaments()] }),
      ]),
    FailedCreateTournament: ({ error }) => ({
      model: modifyFields(model, { maybeError: () => Option.some(`Could not start: ${error}`) }),
    }),
    UpdatedResumeLimit: ({ value }) => ({ model: modifyFields(model, { limitDialogText: () => value }) }),
    ClickedResume: ({ id }) => ({
      model: modifyFields(model, { maybeError: () => Option.none() }),
      commands: [ControlTournament({ id, action: "resume", maybeLimitUsd: amount(model.limitDialogText) })],
    }),
    ClickedStop: ({ id }) => ({
      model: modifyFields(model, { maybeError: () => Option.none() }),
      commands: [ControlTournament({ id, action: "stop", maybeLimitUsd: Option.none() })],
    }),
    SucceededControl: ({ tournament }) => ({
      model: modifyFields(model, { selected: () => AsyncData.succeed(tournament), limitDialogText: () => "" }),
      commands: [FetchTournaments()],
    }),
    FailedControl: ({ error }) => ({ model: modifyFields(model, { maybeError: () => Option.some(error) }) }),
  })
