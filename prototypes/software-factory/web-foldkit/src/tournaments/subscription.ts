import { Filter, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { FeedEvent } from "../../../shared/feed"
import { StoredEvent } from "../../../shared/schemas"
import { feedEvents } from "../feed"
import { Message } from "./message"
import type { Model } from "./model"

const decodeEvent = Schema.decodeUnknownOption(StoredEvent)
const decodeId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))

/** `factory.tournament` feed events (the coordinator publishes one on every save) as Messages. */
export const feedEventToMessage = (raw: FeedEvent): Option.Option<Message> =>
  Option.flatMap(decodeEvent(raw), (event) =>
    event.type === "factory.tournament"
      ? Option.map(decodeId(event.data), ({ id }) => Message.ReceivedTournamentChange({ id }))
      : Option.none(),
  )

/** A busy tournament saves often: at most one refetch per second. */
export const subscriptions = Subscription.make<Model, Message>()(() => ({
  tournamentFeed: Subscription.persistentEntry(
    feedEvents.pipe(Stream.filterMap(Filter.fromPredicateOption(feedEventToMessage)), Stream.debounce("1 second")),
  ),
}))
