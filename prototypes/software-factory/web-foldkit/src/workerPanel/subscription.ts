import { Filter, Match, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { type FeedEvent, RESYNC } from "../../../shared/feed";
import { StoredEvent } from "../../../shared/schemas";
import { feedEvents } from "../feed";
import { Worker } from "../domain";
import { Message } from "./message";
import type { Model } from "./model";

const decodeEvent = Schema.decodeUnknownOption(StoredEvent);
const decodeWorker = Schema.decodeUnknownOption(Worker);
const decodeWorkerId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));

/** The feed events the panel shows, as panel Messages. Other kinds and wrong payloads give none. */
export const feedEventToMessage = (raw: FeedEvent): Option.Option<Message> =>
  Option.flatMap(decodeEvent(raw), (event) =>
    Match.value(event.type).pipe(
      Match.withReturnType<Option.Option<Message>>(),
      Match.when(RESYNC, () => Option.some(Message.ReceivedFeedGap())),
      Match.when(Match.is("factory.worker_started", "factory.worker_updated"), () =>
        Option.map(decodeWorker(event.data), (worker) => Message.ReceivedWorkerUpdate({ worker })),
      ),
      Match.when("factory.worker_stopped", () => Option.map(decodeWorkerId(event.data), ({ id }) => Message.ReceivedWorkerStopped({ workerId: id }))),
      Match.when((type) => type.startsWith("factory."), () => Option.none()),
      Match.orElse(() => Option.some(Message.ReceivedWorkerEvent({ event }))),
    ),
  );

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  workerPanelFeed: Subscription.persistentEntry(feedEvents.pipe(Stream.filterMap(Filter.fromPredicateOption(feedEventToMessage)))),
}));
