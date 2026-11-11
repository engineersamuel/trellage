import { Schema } from "effect"
import { Dialog } from "@foldkit/ui"
import { ConfigAsyncData, CronDraft, DeliveryAsyncData, SettingsAsyncData } from "../domain"

export const Model = Schema.Struct({
  document: SettingsAsyncData.schema,
  delivery: DeliveryAsyncData.schema,
  /** Factory config (prompts, models, thresholds): value, source and reload rule per key. */
  config: ConfigAsyncData.schema,
  maybeConfigError: Schema.Option(Schema.String),
  dialog: Dialog.Model,
  maybePatchError: Schema.Option(Schema.String),
  cronDraft: CronDraft,
  maybeCronDraftError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
