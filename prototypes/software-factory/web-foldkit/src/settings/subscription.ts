import { Filter, Match, Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { type FeedEvent, RESYNC } from "../../../shared/feed"
import { StoredEvent } from "../../../shared/schemas"
import { feedEvents } from "../feed"
import { Settings } from "../domain"
import { Message } from "./message"
import type { Model } from "./model"

const decodeEvent = Schema.decodeUnknownOption(StoredEvent)
const decodeSettingsUpdate = Schema.decodeUnknownOption(Schema.Struct({ settings: Settings, css: Schema.String }))

/** The feed events that change settings or delivery, as settings Messages. */
export const feedEventToMessage = (raw: FeedEvent): Option.Option<Message> =>
  Option.flatMap(decodeEvent(raw), (event) =>
    Match.value(event.type).pipe(
      Match.withReturnType<Option.Option<Message>>(),
      Match.when(RESYNC, () => Option.some(Message.ReceivedFeedGap())),
      Match.when("factory.settings_updated", () =>
        Option.map(decodeSettingsUpdate(event.data), (document) => Message.ReceivedSettingsUpdate({ document })),
      ),
      Match.when(Match.is("factory.run_started", "factory.step_decided", "factory.security_review"), () =>
        Option.some(Message.ReceivedDeliveryChange()),
      ),
      Match.orElse(() => Option.none()),
    ),
  )

const feed = Subscription.make<Model, Message>()(() => ({
  settingsFeed: Subscription.persistentEntry(
    feedEvents.pipe(Stream.filterMap(Filter.fromPredicateOption(feedEventToMessage))),
  ),
}))

export const subscriptions = feed
