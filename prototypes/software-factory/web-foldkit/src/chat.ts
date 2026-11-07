// Adapter for the agent-interface chat Submodel. The package exports its Message union but no update
// capabilities, so this module is the one place that turns host facts into chat Messages. The rest of
// the app drives the chat through the Steps and Message mappers exported here.
/* oxlint-disable foldkit/no-child-message-construction-in-root -- agent-interface exposes no update capabilities; this adapter stands in for them. */
import { Equal, Option } from "effect";
import { Update } from "foldkit";
import type { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import type { Url } from "foldkit/url";
import type { AppMessage, AppModel, ChatBackend, ChatMessage, Thread } from "@plana-solutions/agent-interface";
import { chat } from "./chatProgram";
import { Message } from "./message";
import type { Model } from "./model";

type Step = Update.Step<Model, Message, ChatBackend>;

type GotChatMessage = typeof Message.GotChatMessage.Type;

export const toGotChatMessage = (message: AppMessage): GotChatMessage => Message.GotChatMessage({ message });

export const foldChat = Update.foldChild({
  read: (model: Model) => Option.some(model.chat),
  toParentMessage: toGotChatMessage,
  update: chat.update,
  write: (model: Model, next: AppModel): Model => (next === model.chat ? model : modifyFields(model, { chat: () => next })),
});

/** In a narrow column the chat acts as mobile and opens its thread drawer on select; close it again. */
const closeMobileThreadDrawer =
  (wasDrawerOpen: boolean): Step =>
  (model) =>
    wasDrawerOpen || !model.chat.sidebar.isOpen ? { model } : foldChat(model, chat.Message.ClickedSidebarOverlay());

export const openThread =
  (threadId: string): Step =>
  (model) =>
    Update.combine(model, [foldChat(chat.Message.ClickedThread({ threadId })), closeMobileThreadDrawer(model.chat.sidebar.isOpen)]);

export const newThread: Step = foldChat(chat.Message.ClickedNewChat());

/** Show the reloaded messages of `threadId` when it is still open and idle (the user may have switched meanwhile). */
export const showReloadedThread =
  (threadId: string, messages: ReadonlyArray<ChatMessage>): Step =>
  (model) =>
    Option.contains(model.chat.maybeSelectedThreadId, threadId) && model.chat.run._tag === "Idle"
    // The same messages keep the same Model: the chat does not render again and the composer keeps its focus.
      ? Equal.equals(model.chat.messages, messages)
        ? { model }
        : foldChat(model, chat.Message.SucceededLoadMessages({ threadId, messages }))
      : { model };

/** The tool behind every live chat card (coordinator/src/cards.ts): an OpenUI Query("factory_card", …). */
export const CARD_QUERY_TOOL = "factory_card";

/** Every live card query in the chat: one per card per answer. */
export const cardQueries = (chatModel: AppModel): ReadonlyArray<{ messageId: string; statementId: string; epoch: number }> =>
  Object.entries(chatModel.genuiQueries.answers).flatMap(([messageId, answer]) =>
    Object.entries(answer.manager.queries)
      .filter(([, query]) => query.toolName === CARD_QUERY_TOOL)
      .map(([statementId]) => ({ messageId, statementId, epoch: answer.manager.epoch })),
  );

/**
 * Refresh every live card now. The chat refreshes a query when it gets TickedGenUiQueryRefresh (normally from its
 * own timer); the root sends it when the factory feed reports a change, so cards update as soon as data changes.
 */
export const refreshCards: Step = (model) =>
  Update.combine(
    model,
    cardQueries(model.chat).map((q) => foldChat(chat.Message.TickedGenUiQueryRefresh(q))),
  );

/** Show a fresh thread list (threads started elsewhere). A list equal to the loaded one keeps the same Model. */
export const showRefreshedThreads =
  (threads: ReadonlyArray<Thread>): Step =>
  (model) =>
    model.chat.threadList._tag === "Loaded" && Option.isNone(model.chat.maybeNextCursor) && Equal.equals(model.chat.threads, threads)
      ? { model }
      : foldChat(model, chat.Message.SucceededLoadThreads({ maybeNextCursor: Option.none(), threads }));

export const changedUrl = (url: Url): GotChatMessage => toGotChatMessage(chat.Message.ChangedUrl({ url }));
export const requestedUrl = (request: UrlRequest): GotChatMessage => toGotChatMessage(chat.Message.RequestedUrl({ request }));
