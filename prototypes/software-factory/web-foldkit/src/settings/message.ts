import { Schema } from "effect";
import { DIFF_STYLES } from "../../../shared/diff";
import { defineMessageUnion } from "foldkit/message";
import { Dialog, Slider } from "@foldkit/ui";
import { Delivery, SettingsDocument } from "../domain";

export const Message = defineMessageUnion({
  // Loading
  SucceededFetchSettings: { document: SettingsDocument },
  FailedFetchSettings: { error: Schema.String },
  SucceededFetchDelivery: { delivery: Delivery },
  FailedFetchDelivery: { error: Schema.String },
  ReceivedSettingsUpdate: { document: Schema.Struct({ settings: SettingsDocument.fields.settings, css: Schema.String }) },
  ReceivedDeliveryChange: {},
  ReceivedFeedGap: {},
  SucceededPatchSettings: {},
  FailedPatchSettings: { error: Schema.String },
  // Drawer
  ClickedOpenSettings: {},
  GotDialogMessage: { message: Dialog.Message },
  GotPanelWidthSliderMessage: { message: Slider.Message },
  // One Message per control, so DevTools shows which setting the user changed.
  ClickedTheme: { theme: Schema.String },
  ToggledAnimations: { isChecked: Schema.Boolean },
  ClickedDiffStyle: { style: Schema.Literals(DIFF_STYLES) },
  ClickedPanelPosition: { position: Schema.String },
  ToggledNavbarItem: { item: Schema.String },
  UpdatedBanner: { value: Schema.String },
  UpdatedRepo: { value: Schema.String },
  SelectedModel: { model: Schema.String },
  SelectedReasoningEffort: { effort: Schema.String },
  SelectedSubModel: { model: Schema.String },
  SelectedSubEffort: { effort: Schema.String },
  ClickedWorkerHarness: { harness: Schema.String },
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
  CompletedSyncExtensions: {},
  CompletedMountDiffPreview: {},
});
export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  /** A settings document arrived. Its `focus` names the worker the panel shows. */
  ReceivedFocus: { workerId: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;
