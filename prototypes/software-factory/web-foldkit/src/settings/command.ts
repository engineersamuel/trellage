import { Effect, Schema } from "effect";
import { syncExtensions } from "../../../shared/extensions";
import { Command } from "foldkit";
import { getJson, send } from "../api";
import { Delivery, Settings, SettingsDocument } from "../domain";
import { Message } from "./message";

export const FetchSettings = Command.define("FetchSettings", {
  messages: [Message.SucceededFetchSettings, Message.FailedFetchSettings],
  execute: getJson("/api/settings", SettingsDocument).pipe(
    Effect.map((document) => Message.SucceededFetchSettings({ document })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchSettings({ error }))),
  ),
});

export const FetchDelivery = Command.define("FetchDelivery", {
  messages: [Message.SucceededFetchDelivery, Message.FailedFetchDelivery],
  execute: getJson("/api/steps", Delivery).pipe(
    Effect.map((delivery) => Message.SucceededFetchDelivery({ delivery })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchDelivery({ error }))),
  ),
});

/** A partial settings document. The server merges it and broadcasts factory.settings_updated. */
export const PatchSettings = Command.define("PatchSettings", {
  args: { patch: Schema.Unknown },
  messages: [Message.SucceededPatchSettings, Message.FailedPatchSettings],
  execute: ({ patch }) =>
    send("PATCH", "/api/settings", patch).pipe(
      Effect.as(Message.SucceededPatchSettings()),
      Effect.catch((error) => Effect.succeed(Message.FailedPatchSettings({ error }))),
    ),
});

export const AddCron = Command.define("AddCron", {
  args: { name: Schema.String, everySeconds: Schema.Number, prompt: Schema.String },
  messages: [Message.SucceededAddCron, Message.FailedAddCron],
  execute: ({ name, everySeconds, prompt }) =>
    send("PATCH", "/api/settings", { crons: { [name]: { everySeconds, prompt, enabled: true } } }).pipe(
      Effect.as(Message.SucceededAddCron({ name })),
      Effect.catch((error) => Effect.succeed(Message.FailedAddCron({ error }))),
    ),
});

/** Hand the new settings to the extension host (shared/extensions.ts): it mounts, remounts and notifies extensions. */
export const SyncExtensions = Command.define("SyncExtensions", {
  args: { settings: Settings },
  messages: [Message.CompletedSyncExtensions],
  execute: ({ settings }) => Effect.sync(() => syncExtensions(settings, "foldkit")).pipe(Effect.as(Message.CompletedSyncExtensions())),
});
