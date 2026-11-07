import { Effect, Option, Schema } from "effect";
import { Command, Mount } from "foldkit";
import { ChatMessageSchema, ThreadSchema } from "@plana-solutions/agent-interface";
import type { ChatMessage as ChatLine } from "@plana-solutions/agent-interface";
import { attachSlot, setExtensionWorkers } from "../../shared/extensions";
import { syncThreadUrl } from "../../shared/folders";
import { isOpenUi } from "../../shared/protos/core";
import { getJson } from "./api";
import { Worker } from "./domain";
import { Message } from "./message";

/**
 * This chat draws every answer as OpenUI Lang. Answers written for the markdown UI or sent from outside
 * (stream rail follow-ups, approval answers, reports) are markdown: wrap them in a markdown card.
 */
export const markdownAsOpenUi = (messages: ReadonlyArray<ChatLine>): Array<ChatLine> =>
  messages.map((message) =>
    message.role === "assistant" && typeof message.content === "string" && message.content.trim() && !isOpenUi(message.content)
      ? { ...message, content: `root = Card([MarkDownRenderer(${JSON.stringify(message.content)}, "clear")])` }
      : message,
  );

// Threads started elsewhere (CopilotKit, the sf CLI) appear in the chat's thread list.
export const RefreshThreads = Command.define("RefreshThreads", {
  messages: [Message.SucceededRefreshThreads, Message.FailedRefreshThreads],
  execute: getJson("/api/threads/get", Schema.Struct({ threads: Schema.Array(ThreadSchema) })).pipe(
    Effect.map(({ threads }) => Message.SucceededRefreshThreads({ threads })),
    Effect.catch((error) => Effect.succeed(Message.FailedRefreshThreads({ error }))),
  ),
});

// The open conversation changed elsewhere (sf CLI, approval answer, global coordinator): load its messages.
export const ReloadThread = Command.define("ReloadThread", {
  args: { threadId: Schema.String },
  messages: [Message.SucceededReloadThread, Message.FailedReloadThread],
  execute: ({ threadId }) =>
    getJson(`/api/threads/get/${encodeURIComponent(threadId)}`, Schema.Array(ChatMessageSchema)).pipe(
      Effect.map((messages) => Message.SucceededReloadThread({ threadId, messages: markdownAsOpenUi(messages) })),
      Effect.catch((error) => Effect.succeed(Message.FailedReloadThread({ error }))),
    ),
});

/** Write the open thread into the address bar (?thread=) and the conversation sidebar. */
export const SyncThreadUrl = Command.define("SyncThreadUrl", {
  args: { maybeThreadId: Schema.Option(Schema.String) },
  messages: [Message.CompletedSyncThreadUrl],
  execute: ({ maybeThreadId }) =>
    Effect.sync(() => syncThreadUrl(Option.getOrNull(maybeThreadId))).pipe(Effect.as(Message.CompletedSyncThreadUrl())),
});

/** Give extensions the current worker list (their api.workers and onWorkers callbacks). */
export const SyncExtensionWorkers = Command.define("SyncExtensionWorkers", {
  args: { workers: Schema.Array(Worker) },
  messages: [Message.CompletedSyncExtensionWorkers],
  execute: ({ workers }) =>
    Effect.sync(() => setExtensionWorkers([...workers])).pipe(Effect.as(Message.CompletedSyncExtensionWorkers())),
});

/**
 * An extension slot. shared/extensions.ts owns the element's children; this Mount registers the element
 * while it is on the page, so extensions mount into a slot when it appears and remount after it comes back.
 */
export const AttachSlot = Mount.define("AttachSlot", {
  args: { name: Schema.String },
  messages: [Message.CompletedAttachSlot],
  execute: ({ element, name }) =>
    Effect.acquireRelease(
      Effect.sync(() => (element instanceof HTMLElement ? attachSlot(name, element) : () => {})),
      (detach) => Effect.sync(detach),
    ).pipe(Effect.as(Message.CompletedAttachSlot())),
});
