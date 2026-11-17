import {
  BackendError,
  ChatBackend,
  ChatMessageSchema,
  agUiWire,
  identityMessageFormat,
} from "@plana-solutions/agent-interface"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { markdownAsOpenUi } from "./command"
import { cosMessagesUrl } from "../../shared/cosFilter"
import { getJson } from "./api"
import { fetchChatThreads } from "./threads"

/** The chat backend. The coordinator answers in OpenUI Lang for this frontend, rendered natively by agent-interface. */
export const BACKEND_URLS = {
  artifacts: "/api/artifacts",
  chat: "/api/agui?answer=openui",
  threads: "/api/threads",
  storageFormat: {
    ...identityMessageFormat,
    fromApi: (data: Schema.Json, seed: string) => markdownAsOpenUi(identityMessageFormat.fromApi(data, seed)),
  },
  wire: agUiWire,
}

/**
 * The package backend, except its thread list (the package schema drops `draft`, so it could not hide drafts) and
 * its messages (the Chief of Staff conversation loads with the event filter, shared/cosFilter.ts).
 */
export const chatBackendLayer = Layer.effect(
  ChatBackend,
  Effect.map(ChatBackend.make(BACKEND_URLS), (backend) =>
    ChatBackend.of({
      ...backend,
      listThreads: () =>
        fetchChatThreads.pipe(
          Effect.map((threads) => ({ threads })),
          Effect.mapError((message) => new BackendError({ message })),
        ),
      messages: (threadId) =>
        getJson(cosMessagesUrl(threadId), Schema.Array(ChatMessageSchema)).pipe(
          Effect.map(markdownAsOpenUi),
          Effect.mapError((message) => new BackendError({ message })),
        ),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer))
