import { Effect, Queue, Stream } from "effect";
import { type FeedEvent, onFeed } from "../../shared/feed";

/** A Stream of the values a callback-style source pushes; `subscribe` returns its unsubscribe function. */
export const fromCallback = <A>(subscribe: (emit: (value: A) => void) => () => void): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((value) => Queue.offerUnsafe(queue, value))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

/** The factory feed. shared/feed keeps one connection per page and fans events out to every subscriber. */
export const feedEvents: Stream.Stream<FeedEvent> = fromCallback<FeedEvent>(onFeed);
