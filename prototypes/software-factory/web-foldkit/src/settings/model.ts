import { Schema } from "effect";
import { Dialog, Slider } from "@foldkit/ui";
import { CronDraft, DeliveryAsyncData, SettingsAsyncData } from "../domain";

export const Model = Schema.Struct({
  document: SettingsAsyncData.schema,
  delivery: DeliveryAsyncData.schema,
  dialog: Dialog.Model,
  panelWidthSlider: Slider.Model,
  maybePatchError: Schema.Option(Schema.String),
  cronDraft: CronDraft,
  maybeCronDraftError: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;
