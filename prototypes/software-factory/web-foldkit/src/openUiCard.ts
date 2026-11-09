// OpenUI Lang cards outside the chat (the factory stream in shared/protos).
// Each card is a small Foldkit element program. It embeds the agent-interface chat Submodel with one assistant
// answer and draws it with the package's own GenUI views (genUiCardView), so a stream card has the same
// components, DOM classes, query tools and popovers as a card in the chat. No React.
/* oxlint-disable foldkit/no-child-message-construction-in-root -- agent-interface exposes no update capabilities (see src/chat.ts). */
import { parseMessage } from "@openuidev/lang-core";
import { ChatBackend, FlagsSchema, NO_ARTIFACTS, ThemeSetting, genUiCardView, memoryNavigation, readFlags } from "@plana-solutions/agent-interface";
import type { AgentConfig, AppMessage, AppModel, ChatMessage } from "@plana-solutions/agent-interface";
import { Effect, Option, Schema } from "effect";
import { Command, Port, Runtime, Submodel, Subscription, Update, Url } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { setOpenUiRenderer } from "../../shared/protos";
import { BACKEND_URLS } from "./backend";
import { chat } from "./chatProgram";

/** The one answer a card shows. */
export const CARD_ANSWER_ID = "openui-card";

export const Model = Schema.Struct({ chat: chat.Model });
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotChatMessage: { message: chat.Message },
  CompletedSendFollowUp: {},
});
export type Message = typeof Message.Type;

/** A button asked to continue the conversation. The host sends `message` to the agent that wrote the card. */
const FollowUp = Schema.Struct({ message: Schema.String });

export const ports = { inbound: {}, outbound: { followUp: Port.outbound(FollowUp) } };

const SendFollowUp = Command.define("SendFollowUp", {
  args: { message: Schema.String },
  messages: [Message.CompletedSendFollowUp],
  execute: ({ message }) => Port.emit(ports.outbound.followUp, { message }).pipe(Effect.as(Message.CompletedSendFollowUp())),
});

type UpdateReturn = Update.Return<Model, Message, ChatBackend>;

const toGotChatMessage = (message: AppMessage) => Message.GotChatMessage({ message });

const foldChat = Update.foldChild({
  read: (model: Model) => Option.some(model.chat),
  toParentMessage: toGotChatMessage,
  update: chat.update,
  write: (model: Model, next: AppModel): Model => (next === model.chat ? model : modifyFields(model, { chat: () => next })),
});

/** Commands a card never runs: it has no thread to create and no composer to focus. */
const CHAT_ONLY_COMMANDS = new Set(["CreateThread", "FocusComposer", "LoadThreads", "SaveSidebarPreference"]);
const withoutChatOnlyCommands = (result: UpdateReturn): UpdateReturn => ({
  ...result,
  commands: (result.commands ?? []).filter((command) => !CHAT_ONLY_COMMANDS.has(command.name)),
});

/**
 * The chat answers "continue the conversation" by posting a user message in its own thread. A card has no thread:
 * take that message back out and send its text to the host instead.
 */
const asFollowUp =
  (before: Model) =>
  (result: UpdateReturn): UpdateReturn => {
    const added = result.model.chat.messages.slice(before.chat.messages.length);
    const maybeUser = Option.fromNullishOr(added.find((message: ChatMessage) => message.role === "user"));
    return Option.match(maybeUser, {
      onNone: () => result,
      onSome: (user) => ({
        model: modifyFields(result.model, {
          chat: (next) =>
            modifyFields(next, {
              messages: () => before.chat.messages,
              run: () => before.chat.run,
              runCount: () => before.chat.runCount,
            }),
        }),
        commands: [
          ...(result.commands ?? []),
          SendFollowUp({ message: parseMessage(typeof user.content === "string" ? user.content : "", { streaming: false }).content }),
        ],
      }),
    });
  };

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotChatMessage: ({ message: chatMessage }) => withoutChatOnlyCommands(asFollowUp(model)(foldChat(model, chatMessage))),
    CompletedSendFollowUp: () => ({ model }),
  });

/** The card shows `program` as the answer of a loaded, idle conversation. */
export const init = (program: string, flags: typeof FlagsSchema.Type, url: Url.Url): UpdateReturn => {
  const started = Update.foldChildInit(chat.init(flags, url), {
    toParentMessage: toGotChatMessage,
    toParentModel: (chatModel): Model => ({ chat: chatModel }),
  });
  const loaded = foldChat(
    started.model,
    chat.Message.SucceededLoadMessages({ threadId: CARD_ANSWER_ID, messages: [{ id: CARD_ANSWER_ID, role: "assistant", content: program }] }),
  );
  return withoutChatOnlyCommands({ model: loaded.model, commands: [...(started.commands ?? []), ...(loaded.commands ?? [])] });
};

const cardView = Submodel.defineView<AppModel, AppMessage>((chatModel, h) => genUiCardView(chatModel, h));

export const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.submodel({ model: model.chat, slotId: "openui-card", toParentMessage: toGotChatMessage, view: cardView });

export const subscriptions = Subscription.lift(chat.subscriptions)({
  read: (model: Model) => Option.some(model.chat),
  toParentMessage: toGotChatMessage,
});

/** The chat's config, minus its shell. The chat already writes the theme tokens, so a card does not write them again. */
const config: AgentConfig = {
  agentName: "",
  artifacts: NO_ARTIFACTS,
  componentLibrary: "openuiChat",
  disableThemeProvider: true,
  maybeStarterVariant: Option.none(),
  maybeWelcome: Option.none(),
  navigation: memoryNavigation,
  placeholder: "",
  starters: [],
  theme: ThemeSetting.Fixed({ mode: "dark" }),
};

/** Draw `program` into `el` and return its cleanup. A press on "continue the conversation" calls `onFollowUp`. */
export const mountCard = (el: HTMLElement, program: string, onFollowUp: (message: string) => void): (() => void) => {
  const container = document.createElement("div");
  // The host mount runs outside update and view; the runtime only needs a unique container id.
  // oxlint-disable-next-line foldkit/no-impure-call-at-decision-time
  container.id = `sf-openui-card-${crypto.randomUUID()}`;
  el.append(container);
  const url = Option.getOrThrow(Url.fromString(window.location.href));
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      Flags: FlagsSchema,
      flags: readFlags(config),
      init: (flags) => init(program, flags, url),
      update,
      view,
      subscriptions,
      container,
      ports,
      resources: ChatBackend.layer(BACKEND_URLS),
      devTools: false,
    }),
  );
  const stopFollowUps = handle.ports.followUp.subscribe(({ message }) => onFollowUp(message));
  return () => {
    stopFollowUps();
    handle.dispose();
    container.remove();
  };
};

setOpenUiRenderer((el, program, onAction) =>
  mountCard(el, program, (message) => onAction({ type: "continue_conversation", params: {}, humanFriendlyMessage: message })),
);
