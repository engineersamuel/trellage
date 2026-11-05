import { Effect, Filter, Match, Option, Queue, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { changes as approvalChanges } from "../../shared/approvals";
import { type FeedEvent, RESYNC, onFeed } from "../../shared/feed";
import { onProto } from "../../shared/protos";
import { StoredEvent } from "../../shared/schemas";
import { toGotChatMessage } from "./chat";
import { chat } from "./chatProgram";
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

/** A Stream of the values a callback-style source pushes; `subscribe` returns its unsubscribe function. */
const fromCallback = <A>(subscribe: (emit: (value: A) => void) => () => void): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((value) => Queue.offerUnsafe(queue, value))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

/** The string payload of an sf:* window event ("" when missing). */
const eventDetail = (event: Event): string => (event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : "");

const windowEvents = (type: string): Stream.Stream<Event> => Stream.fromEventListener<Event>(window, type);

const alwaysOn = <A>(toStream: () => Stream.Stream<A>) => ({ modelToDependencies: () => ({}), dependenciesToStream: toStream });

/** Plain keys outside text fields and dialogs. update looks the key up in the hotkey settings. */
const isHotkey = (event: KeyboardEvent): boolean =>
  !(event.metaKey || event.ctrlKey || event.altKey) &&
  !(event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable],dialog"));

const appSubscriptions = Subscription.make<Model, Message>()((entry) => ({
  feed: entry({}, alwaysOn(() => fromCallback<FeedEvent>(onFeed).pipe(Stream.filterMap(Filter.fromPredicateOption(feedEventToMessage))))),
  keys: entry(
    {},
    alwaysOn(() =>
      Stream.fromEventListener<KeyboardEvent>(window, "keydown").pipe(
        Stream.filter(isHotkey),
        Stream.map((event) => Message.PressedKey({ key: event.key })),
      ),
    ),
  ),
  // Deep links from the decision center and the conversation sidebar.
  openThread: entry({}, alwaysOn(() => windowEvents("sf:open-thread").pipe(Stream.map((event) => Message.RequestedOpenThread({ threadId: eventDetail(event) }))))),
  newThread: entry({}, alwaysOn(() => windowEvents("sf:new-thread").pipe(Stream.map(() => Message.RequestedNewThread())))),
  // Worker links in shared/transcript.ts.
  selectWorker: entry(
    {},
    alwaysOn(() => windowEvents("sf:select-worker").pipe(Stream.map((event) => Message.RequestedSelectWorker({ workerId: eventDetail(event) })))),
  ),
  // The prototype switcher in shared/protos.
  proto: entry({}, alwaysOn(() => fromCallback<number>(onProto).pipe(Stream.map((proto) => Message.UpdatedProto({ proto }))))),
  // The shared Effect approvals store. Its changes become Messages, so DevTools can replay them.
  approvals: entry({}, alwaysOn(() => approvalChanges.pipe(Stream.map(({ pending }) => Message.UpdatedApprovals({ pending }))))),
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
