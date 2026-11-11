import { Schema } from "effect"
import { DIFF_STYLES } from "../../../shared/diff"
import { TREE_STYLES } from "../../../shared/treeLines"
import { defineMessageUnion } from "foldkit/message"
import { Dialog } from "@foldkit/ui"
import { Delivery, FactoryConfigView, SettingsDocument } from "../domain"

export const Message = defineMessageUnion({
  // Loading
  SucceededFetchSettings: { document: SettingsDocument },
  FailedFetchSettings: { error: Schema.String },
  SucceededFetchDelivery: { delivery: Delivery },
  FailedFetchDelivery: { error: Schema.String },
  ReceivedSettingsUpdate: {
    document: Schema.Struct({ settings: SettingsDocument.fields.settings, css: Schema.String }),
  },
  ReceivedDeliveryChange: {},
  ReceivedFeedGap: {},
  SucceededFetchConfig: { config: FactoryConfigView },
  FailedFetchConfig: { error: Schema.String },
  ReceivedConfigUpdate: { config: FactoryConfigView },
  SucceededChangeConfig: { config: FactoryConfigView },
  FailedChangeConfig: { error: Schema.String },
  SucceededPatchSettings: {},
  FailedPatchSettings: { error: Schema.String },
  // Drawer
  ClickedOpenSettings: {},
  GotDialogMessage: { message: Dialog.Message },
  // One Message per control, so DevTools shows which setting the user changed.
  ClickedTheme: { theme: Schema.String },
  ToggledAnimations: { isChecked: Schema.Boolean },
  ToggledInboxCritters: { isChecked: Schema.Boolean },
  ClickedDiffStyle: { style: Schema.Literals(DIFF_STYLES) },
  ClickedTreeStyle: { style: Schema.Literals(TREE_STYLES) },
  ToggledNavbarItem: { item: Schema.String },
  UpdatedBanner: { value: Schema.String },
  UpdatedRepo: { value: Schema.String },
  SelectedModel: { model: Schema.String },
  SelectedReasoningEffort: { effort: Schema.String },
  SelectedSubModel: { model: Schema.String },
  SelectedSubEffort: { effort: Schema.String },
  ClickedWorkerHarness: { harness: Schema.String },
  ClickedDecisionEngine: { engine: Schema.String },
  ToggledDisabledTool: { tool: Schema.String },
  UpdatedInstructions: { value: Schema.String },
  ToggledCron: { name: Schema.String, isChecked: Schema.Boolean },
  ClickedRemoveCron: { name: Schema.String },
  UpdatedCronName: { value: Schema.String },
  UpdatedCronInterval: { value: Schema.String },
  UpdatedCronPrompt: { value: Schema.String },
  SubmittedCronDraft: {},
  SucceededAddCron: { name: Schema.String },
  FailedAddCron: { error: Schema.String },
  ToggledExtension: { name: Schema.String, isChecked: Schema.Boolean },
  ClickedRemoveExtension: { name: Schema.String },
  // Factory config: one Message per action on a key.
  ChangedConfigValue: { key: Schema.String, value: Schema.String },
  ClickedPromoteConfig: { key: Schema.String },
  ClickedClearConfigOverride: { key: Schema.String },
  CompletedSyncExtensions: {},
  CompletedMountDiffPreview: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** A settings update changed `focus` (focus_agent, the worker board's Show): the Inbox shows that agent. */
  ChangedFocus: { workerId: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
