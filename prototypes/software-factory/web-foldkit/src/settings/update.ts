import { Array, Match, Number, Option, Record, Result, String, pipe } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog, Slider } from "@foldkit/ui"
import {
  type Delivery,
  DeliveryAsyncData,
  EMPTY_CRON_DRAFT,
  type Settings,
  SettingsAsyncData,
  type SettingsDocument,
} from "../domain"
import { AddCron, FetchDelivery, FetchSettings, PatchSettings, SyncExtensions } from "./command"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>
type Step = Update.Step<Model, Message>

export const DIALOG_ID = "settings"
const PANEL_WIDTH_MIN = 25
const PANEL_WIDTH_MAX = 70

export const init = (): Update.Return<Model, Message> => ({
  model: {
    document: SettingsAsyncData.Loading(),
    delivery: DeliveryAsyncData.Loading(),
    dialog: Dialog.init({ id: DIALOG_ID }),
    panelWidthSlider: Slider.init({ id: "panel-width", min: PANEL_WIDTH_MIN, max: PANEL_WIDTH_MAX, step: 1 }),
    maybePatchError: Option.none(),
    cronDraft: EMPTY_CRON_DRAFT,
    maybeCronDraftError: Option.none(),
  },
  commands: [FetchSettings(), FetchDelivery()],
})

/** The loaded settings, when there are any. */
export const maybeSettings = (model: Model): Option.Option<Settings> =>
  Option.map(AsyncData.getData(model.document), ({ settings }) => settings)

const patch =
  (value: unknown): Step =>
  (model) => ({ model, commands: [PatchSettings({ patch: value })] })

const withSettings = (model: Model, f: (settings: Settings) => unknown): UpdateReturn =>
  Option.match(maybeSettings(model), { onNone: () => ({ model }), onSome: (settings) => patch(f(settings))(model) })

const toggleMember = (list: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
  Array.contains(list, value) ? Array.filter(list, (item) => item !== value) : Array.append(list, value)

/** Store new settings and hand them to the extension host. */
const storeDocument =
  (document: SettingsDocument): Step =>
  (model) => ({
    model: modifyFields(model, { document: () => AsyncData.succeed(document), maybePatchError: () => Option.none() }),
    commands: [SyncExtensions({ settings: document.settings })],
  })

/** Tell the parent which worker the settings focus. */
const withFocus = (document: SettingsDocument) =>
  Update.withOutMessage(
    OutMessage.ReceivedFocus({ workerId: document.settings.focus, critters: document.settings.critters }),
  )

const refreshDelivery = Update.refresh<Model, Message, Delivery, string>({
  read: (model) => Option.some(model.delivery),
  revalidate: AsyncData.revalidateOrLoad,
  write: (model, delivery) => modifyFields(model, { delivery: () => delivery }),
  load: FetchDelivery(),
})

const refreshSettings = Update.refresh<Model, Message, SettingsDocument, string>({
  read: (model) => Option.some(model.document),
  revalidate: AsyncData.revalidateOrLoad,
  write: (model, document) => modifyFields(model, { document: () => document }),
  load: FetchSettings(),
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

/** Opens the drawer, or closes it when it is open. The `,` hotkey calls this. */
export const toggleDialog = Update.foldChildStep({
  update: (dialog: Dialog.Model) => (dialog.isOpen ? Dialog.close(dialog) : Dialog.open(dialog)),
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, dialog: Dialog.Model) =>
    dialog === model.dialog ? model : modifyFields(model, { dialog: () => dialog }),
  toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  foldOutMessage: Dialog.OutMessage.match<Step>({
    Opened: () => (model) => ({ model }),
    Closed: () => (model) => ({ model }),
  }),
})

const foldPanelWidthSlider = Update.foldChild({
  update: Slider.update,
  read: (model: Model) => Option.some(model.panelWidthSlider),
  write: (model: Model, slider: Slider.Model) =>
    slider === model.panelWidthSlider ? model : modifyFields(model, { panelWidthSlider: () => slider }),
  toParentMessage: (message: Slider.Message) => Message.GotPanelWidthSliderMessage({ message }),
  foldOutMessage: Slider.OutMessage.match<Step>({
    ChangedValue: ({ value }) => patch({ layout: { panelWidth: value } }),
  }),
})

/** Validate the cron draft: a name, a prompt, and a whole number of seconds above zero. */
const parseCronDraft = (
  model: Model,
): Result.Result<{ name: string; everySeconds: number; prompt: string }, string> => {
  const name = model.cronDraft.name.trim()
  const prompt = model.cronDraft.prompt.trim()
  const maybeEverySeconds = pipe(
    Number.parse(model.cronDraft.every.trim()),
    Option.filter((seconds) => globalThis.Number.isInteger(seconds) && seconds > 0),
  )
  if (String.isEmpty(name)) return Result.fail("Give the cron a name.")
  if (String.isEmpty(prompt)) return Result.fail("Give the cron a prompt.")
  return Option.match(maybeEverySeconds, {
    onNone: () => Result.fail("Interval must be a whole number of seconds above 0."),
    onSome: (everySeconds) => Result.succeed({ name, everySeconds, prompt }),
  })
}

const submitCronDraft = (model: Model): UpdateReturn =>
  Result.match(parseCronDraft(model), {
    onFailure: (error) => ({ model: modifyFields(model, { maybeCronDraftError: () => Option.some(error) }) }),
    onSuccess: (cron) => ({
      model: modifyFields(model, { maybeCronDraftError: () => Option.none() }),
      commands: [AddCron(cron)],
    }),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchSettings: ({ document }) => pipe(storeDocument(document)(model), withFocus(document)),
    FailedFetchSettings: ({ error }) => ({
      model: modifyFields(model, { document: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    SucceededFetchDelivery: ({ delivery }) => ({
      model: modifyFields(model, { delivery: () => AsyncData.succeed(delivery) }),
    }),
    FailedFetchDelivery: ({ error }) => ({
      model: modifyFields(model, { delivery: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    // The options list is not part of the live update: keep the loaded one.
    ReceivedSettingsUpdate: ({ document: { settings, css } }) =>
      Option.match(AsyncData.getData(model.document), {
        onNone: () => ({ model, commands: [FetchSettings()] }),
        onSome: ({ options }) => {
          const document = { settings, css, options }
          return pipe(Update.combine(model, [storeDocument(document), refreshDelivery]), withFocus(document))
        },
      }),
    ReceivedDeliveryChange: () => refreshDelivery(model),
    ReceivedFeedGap: () => Update.combine(model, [refreshSettings, refreshDelivery]),
    SucceededPatchSettings: () => ({ model: modifyFields(model, { maybePatchError: () => Option.none() }) }),
    FailedPatchSettings: ({ error }) => ({ model: modifyFields(model, { maybePatchError: () => Option.some(error) }) }),
    ClickedOpenSettings: () => toggleDialog(model),
    GotDialogMessage: ({ message: childMessage }) => foldDialog(model, childMessage),
    GotPanelWidthSliderMessage: ({ message: childMessage }) => foldPanelWidthSlider(model, childMessage),
    ClickedTheme: ({ theme }) => patch({ theme })(model),
    ToggledAnimations: ({ isChecked }) => patch({ animations: isChecked })(model),
    ToggledCritters: ({ isChecked }) => patch({ critters: isChecked })(model),
    ToggledCanvasCritters: ({ isChecked }) => patch({ canvasCritters: isChecked })(model),
    ToggledInboxCritters: ({ isChecked }) => patch({ inboxCritters: isChecked })(model),
    ClickedDiffStyle: ({ style }) => patch({ diffStyle: style })(model),
    ClickedTreeStyle: ({ style }) => patch({ treeStyle: style })(model),
    ClickedPanelPosition: ({ position }) => patch({ layout: { panel: position } })(model),
    ToggledNavbarItem: ({ item }) =>
      withSettings(model, (settings) => ({ navbar: toggleMember(settings.navbar, item) })),
    UpdatedBanner: ({ value }) => patch({ banner: String.isEmpty(value) ? null : value })(model),
    UpdatedRepo: ({ value }) => patch({ repo: value.trim() })(model),
    SelectedModel: ({ model: agentModel }) => patch({ agent: { model: agentModel } })(model),
    SelectedReasoningEffort: ({ effort }) => patch({ agent: { reasoningEffort: effort } })(model),
    SelectedSubModel: ({ model: subModel }) => patch({ subAgent: { model: subModel } })(model),
    SelectedSubEffort: ({ effort }) => patch({ subAgent: { reasoningEffort: effort } })(model),
    ClickedWorkerHarness: ({ harness }) => patch({ workers: { harness } })(model),
    ClickedDecisionEngine: ({ engine }) => patch({ decisions: { engine } })(model),
    ToggledDisabledTool: ({ tool }) =>
      withSettings(model, (settings) => ({
        agent: { disabledTools: toggleMember(settings.agent.disabledTools, tool) },
      })),
    UpdatedInstructions: ({ value }) => patch({ agent: { instructions: value } })(model),
    ToggledCron: ({ name, isChecked }) => patch({ crons: { [name]: { enabled: isChecked } } })(model),
    ClickedRemoveCron: ({ name }) => patch({ crons: { [name]: null } })(model),
    // One Message per field: each applies to the current draft, so fast typing in several fields never loses a key.
    UpdatedCronName: ({ value }) => ({
      model: modifyFields(model, { cronDraft: modifyFields({ name: () => value }) }),
    }),
    UpdatedCronInterval: ({ value }) => ({
      model: modifyFields(model, { cronDraft: modifyFields({ every: () => value }) }),
    }),
    UpdatedCronPrompt: ({ value }) => ({
      model: modifyFields(model, { cronDraft: modifyFields({ prompt: () => value }) }),
    }),
    SubmittedCronDraft: () => submitCronDraft(model),
    // Reset the draft only after the server saved the cron.
    SucceededAddCron: () => ({ model: modifyFields(model, { cronDraft: () => EMPTY_CRON_DRAFT }) }),
    FailedAddCron: ({ error }) => ({
      model: modifyFields(model, { maybeCronDraftError: () => Option.some(`Could not add cron: ${error}`) }),
    }),
    ToggledExtension: ({ name, isChecked }) => patch({ extensions: { [name]: { enabled: isChecked } } })(model),
    ClickedRemoveExtension: ({ name }) => patch({ extensions: { [name]: null } })(model),
    CompletedSyncExtensions: () => ({ model }),
    CompletedMountDiffPreview: () => ({ model }),
  })

const nextTheme = (settings: Settings): Option.Option<string> => {
  const themes = Record.keys(settings.themes)
  return pipe(
    Array.findFirstIndex(themes, (theme) => theme === settings.theme),
    Option.getOrElse(() => -1),
    (index) => Array.get(themes, (index + 1) % Math.max(themes.length, 1)),
  )
}

/** Ask the server to focus a worker. The settings broadcast then moves the panel. */
export const requestFocus = (workerId: string): Step => patch({ focus: workerId })

/** Run a hotkey action. Unknown actions do nothing. */
export const pressHotkey =
  (action: string): Step =>
  (model) =>
    runHotkeyAction(model, action)

const runHotkeyAction = (model: Model, action: string): Update.Return<Model, Message> =>
  Option.match(maybeSettings(model), {
    onNone: () => ({ model }),
    onSome: (settings) =>
      Match.value(action).pipe(
        Match.withReturnType<Update.Return<Model, Message>>(),
        Match.when("toggleSettings", () => toggleDialog(model)),
        Match.when("togglePanel", () =>
          patch({ layout: { panel: settings.layout.panel === "hidden" ? "right" : "hidden" } })(model),
        ),
        Match.when("cycleTheme", () =>
          Option.match(nextTheme(settings), { onNone: () => ({ model }), onSome: (theme) => patch({ theme })(model) }),
        ),
        Match.when("focusCoordinator", () => patch({ focus: "coordinator" })(model)),
        Match.orElse(() => ({ model })),
      ),
  })
