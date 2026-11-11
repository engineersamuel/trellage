import { Array, Match, Number, Option, Record, Result, String, pipe } from "effect"
import { AsyncData, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Dialog } from "@foldkit/ui"
import {
  ConfigAsyncData,
  type ConfigValue,
  type Delivery,
  DeliveryAsyncData,
  EMPTY_CRON_DRAFT,
  type FactoryConfigView,
  type Settings,
  SettingsAsyncData,
  type SettingsDocument,
} from "../domain"
import {
  AddCron,
  ChangeConfig,
  FetchConfig,
  FetchDelivery,
  FetchSettings,
  PatchSettings,
  SyncExtensions,
} from "./command"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>
type Step = Update.Step<Model, Message>

export const DIALOG_ID = "settings"

export const init = (): Update.Return<Model, Message> => ({
  model: {
    document: SettingsAsyncData.Loading(),
    delivery: DeliveryAsyncData.Loading(),
    config: ConfigAsyncData.Loading(),
    maybeConfigError: Option.none(),
    dialog: Dialog.init({ id: DIALOG_ID }),
    maybePatchError: Option.none(),
    cronDraft: EMPTY_CRON_DRAFT,
    maybeCronDraftError: Option.none(),
  },
  commands: [FetchSettings(), FetchDelivery(), FetchConfig()],
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

/** Tell the parent when an update moved the focus to another agent. The first load is no move. */
const withFocusChange =
  (previous: Settings, document: SettingsDocument) =>
  (step: Update.Return<Model, Message>): UpdateReturn =>
    previous.focus === document.settings.focus
      ? step
      : Update.withOutMessage(OutMessage.ChangedFocus({ workerId: document.settings.focus }))(step)

const refreshDelivery = Update.refresh<Model, Message, Delivery, string>({
  read: (model) => Option.some(model.delivery),
  revalidate: AsyncData.revalidateOrLoad,
  write: (model, delivery) => modifyFields(model, { delivery: () => delivery }),
  load: FetchDelivery(),
})

const refreshConfig = Update.refresh<Model, Message, FactoryConfigView, string>({
  read: (model) => Option.some(model.config),
  revalidate: AsyncData.revalidateOrLoad,
  write: (model, config) => modifyFields(model, { config: () => config }),
  load: FetchConfig(),
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

/** The text a config field holds, parsed back to the key's type. Lists are comma separated. */
export const parseConfigValue = (
  current: ConfigValue["value"],
  text: string,
): Result.Result<ConfigValue["value"], string> =>
  Match.value(current).pipe(
    Match.withReturnType<Result.Result<ConfigValue["value"], string>>(),
    Match.when(Match.number, () =>
      Option.match(Number.parse(text.trim()), {
        onNone: () => Result.fail(`"${text}" is not a number.`),
        onSome: Result.succeed,
      }),
    ),
    Match.when(Match.boolean, () =>
      text === "true" || text === "false" ? Result.succeed(text === "true") : Result.fail("Use true or false."),
    ),
    Match.when(Match.string, () => Result.succeed(text)),
    Match.orElse(() =>
      Result.succeed(pipe(String.split(text, ","), Array.map(String.trim), Array.filter(String.isNonEmpty))),
    ),
  )

const findConfigValue = (model: Model, key: string): Option.Option<ConfigValue> =>
  Option.flatMap(AsyncData.getData(model.config), ({ values }) => Array.findFirst(values, (v) => v.key === key))

const changeConfigValue = (model: Model, key: string, text: string): UpdateReturn =>
  Option.match(findConfigValue(model, key), {
    onNone: () => ({ model }),
    onSome: ({ value }) =>
      Result.match(parseConfigValue(value, text), {
        onFailure: (error) => ({
          model: modifyFields(model, { maybeConfigError: () => Option.some(`${key}: ${error}`) }),
        }),
        onSuccess: (parsed) => ({ model, commands: [ChangeConfig({ change: { key, value: parsed } })] }),
      }),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededFetchSettings: ({ document }) => storeDocument(document)(model),
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
        onSome: ({ settings: previous, options }) => {
          const document = { settings, css, options }
          return pipe(
            Update.combine(model, [storeDocument(document), refreshDelivery]),
            withFocusChange(previous, document),
          )
        },
      }),
    ReceivedDeliveryChange: () => refreshDelivery(model),
    ReceivedFeedGap: () => Update.combine(model, [refreshSettings, refreshDelivery, refreshConfig]),
    SucceededFetchConfig: ({ config }) => ({ model: modifyFields(model, { config: () => AsyncData.succeed(config) }) }),
    FailedFetchConfig: ({ error }) => ({
      model: modifyFields(model, { config: (current) => AsyncData.settle(current, Result.fail(error)) }),
    }),
    ReceivedConfigUpdate: ({ config }) => ({ model: modifyFields(model, { config: () => AsyncData.succeed(config) }) }),
    SucceededChangeConfig: ({ config }) => ({
      model: modifyFields(model, { config: () => AsyncData.succeed(config), maybeConfigError: () => Option.none() }),
    }),
    FailedChangeConfig: ({ error }) => ({ model: modifyFields(model, { maybeConfigError: () => Option.some(error) }) }),
    ChangedConfigValue: ({ key, value }) => changeConfigValue(model, key, value),
    ClickedPromoteConfig: ({ key }) => ({ model, commands: [ChangeConfig({ change: { key, promote: true } })] }),
    ClickedClearConfigOverride: ({ key }) => ({ model, commands: [ChangeConfig({ change: { key, value: null } })] }),
    SucceededPatchSettings: () => ({ model: modifyFields(model, { maybePatchError: () => Option.none() }) }),
    FailedPatchSettings: ({ error }) => ({ model: modifyFields(model, { maybePatchError: () => Option.some(error) }) }),
    ClickedOpenSettings: () => toggleDialog(model),
    GotDialogMessage: ({ message: childMessage }) => foldDialog(model, childMessage),
    ClickedTheme: ({ theme }) => patch({ theme })(model),
    ToggledAnimations: ({ isChecked }) => patch({ animations: isChecked })(model),
    ToggledInboxCritters: ({ isChecked }) => patch({ inboxCritters: isChecked })(model),
    ClickedDiffStyle: ({ style }) => patch({ diffStyle: style })(model),
    ClickedTreeStyle: ({ style }) => patch({ treeStyle: style })(model),
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
        Match.when("focusCoordinator", () => patch({ focus: "coordinator" })(model)),
        Match.when("cycleTheme", () =>
          Option.match(nextTheme(settings), { onNone: () => ({ model }), onSome: (theme) => patch({ theme })(model) }),
        ),
        Match.orElse(() => ({ model })),
      ),
  })
