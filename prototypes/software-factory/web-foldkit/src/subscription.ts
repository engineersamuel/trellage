import { Filter, Match, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { changes as approvalChanges } from "../../shared/approvals";
import { type FeedEvent, RESYNC } from "../../shared/feed";
import { onProto } from "../../shared/protos";
import { StoredEvent } from "../../shared/schemas";
import { toGotChatMessage } from "./chat";
import { chat } from "./chatProgram";
import { feedEvents, fromCallback } from "./feed";
import { Message } from "./message";
import type { Model } from "./model";
import * as Settings from "./settings";
import { toGotSettingsMessage, toGotWorkerPanelMessage } from "./update";
import * as WorkerPanel from "./workerPanel";

const decodeEvent = Schema.decodeUnknownOption(StoredEvent);
const decodeThreadId = Schema.decodeUnknownOption(Schema.Struct({ threadId: Schema.optional(Schema.String) }));

/** The feed events the root handles. The worker panel and settings subscribe to the kinds they own. */
export const feedEventToMessage = (raw: FeedEvent): Option.Option<Message> =>
  Option.flatMap(decodeEvent(raw), (event) =>
    Match.value(event.type).pipe(
      Match.withReturnType<Option.Option<Message>>(),
      Match.when(RESYNC, () => Option.some(Message.ReceivedFeedGap())),
      Match.when("factory.thread_updated", () => Option.map(decodeThreadId(event.data ?? {}), ({ threadId }) => Message.ReceivedThreadUpdate({ threadId }))),
      Match.orElse(() => Option.none()),
    ),
  );

/** Feed events that change what a chat card shows. Workers report often while busy, so changes are coalesced. */
const CARD_EVENTS = /^factory\.(worker_(started|updated|stopped)|approval_|security_review|code_review|sdlc|step_decided)/;
/** One card refresh per burst of feed events (a busy worker sends several per second). */
const CARD_REFRESH_DEBOUNCE = "150 millis";

export const isCardEvent = (type: string): boolean => CARD_EVENTS.test(type);

/** The string payload of an sf:* window event ("" when missing). */
const eventDetail = (event: Event): string => (event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : "");

const windowEvents = (type: string): Stream.Stream<Event> => Stream.fromEventListener<Event>(window, type);

/** Plain keys outside text fields and dialogs. update looks the key up in the hotkey settings. */
const isHotkey = (event: KeyboardEvent): boolean =>
  !(event.metaKey || event.ctrlKey || event.altKey) &&
  !(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable],dialog"));

const appSubscriptions = Subscription.make<Model, Message>()(() => ({
  feed: Subscription.persistentEntry(feedEvents.pipe(Stream.filterMap(Filter.fromPredicateOption(feedEventToMessage)))),
  // Live chat cards: a change in the factory refreshes them at once (no polling delay).
  cardData: Subscription.persistentEntry(
    feedEvents.pipe(
      Stream.filter((event) => isCardEvent(event.type)),
      Stream.debounce(CARD_REFRESH_DEBOUNCE),
      Stream.map(() => Message.ReceivedCardDataChange()),
    ),
  ),
  keys: Subscription.persistentEntry(
    Stream.fromEventListener<KeyboardEvent>(window, "keydown").pipe(
      Stream.filter(isHotkey),
      Stream.map((event) => Message.PressedKey({ key: event.key })),
    ),
  ),
  // Deep links from the decision center and the conversation sidebar.
  openThread: Subscription.persistentEntry(windowEvents("sf:open-thread").pipe(Stream.map((event) => Message.RequestedOpenThread({ threadId: eventDetail(event) })))),
  newThread: Subscription.persistentEntry(windowEvents("sf:new-thread").pipe(Stream.map(() => Message.RequestedNewThread()))),
  // Worker links in shared/transcript.ts.
  selectWorker: Subscription.persistentEntry(
    windowEvents("sf:select-worker").pipe(Stream.map((event) => Message.RequestedSelectWorker({ workerId: eventDetail(event) }))),
  ),
  // The prototype switcher in shared/protos.
  proto: Subscription.persistentEntry(fromCallback<number>(onProto).pipe(Stream.map((proto) => Message.UpdatedProto({ proto })))),
  // The shared Effect approvals store. Its changes become Messages, so DevTools can replay them.
  approvals: Subscription.persistentEntry(approvalChanges.pipe(Stream.map(({ pending }) => Message.UpdatedApprovals({ pending })))),
}));

const chatSubscriptions = Subscription.lift(chat.subscriptions)({
  read: (model: Model) => Option.some(model.chat),
  toParentMessage: toGotChatMessage,
});

const workerPanelSubscriptions = Subscription.lift(WorkerPanel.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.workerPanel),
  toParentMessage: toGotWorkerPanelMessage,
});

const settingsSubscriptions = Subscription.lift(Settings.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.settings),
  toParentMessage: toGotSettingsMessage,
});

export const subscriptions = Subscription.aggregate(chatSubscriptions, appSubscriptions, workerPanelSubscriptions, settingsSubscriptions);
