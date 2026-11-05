import { Option } from "effect";
import { describe, expect, test } from "vitest";
import { Message } from "./message";
import { feedEventToMessage } from "./subscription";
import { feedEventToMessage as panelFeedEventToMessage } from "./workerPanel/subscription";

const raw = (type: string, data: unknown) => ({ seq: 1, workerId: "coordinator", type, agentId: null, timestamp: "0", data });

describe("feed decoding", () => {
  test("thread updates carry the thread id", () => {
    expect(feedEventToMessage(raw("factory.thread_updated", { threadId: "t1" }))).toEqual(Option.some(Message.ReceivedThreadUpdate({ threadId: "t1" })));
  });

  test("a gap marker becomes ReceivedFeedGap", () => {
    expect(feedEventToMessage(raw("factory.feed_reconnected", null))).toEqual(Option.some(Message.ReceivedFeedGap()));
  });

  test("a worker event with a wrong payload is dropped by the panel, not a crash", () => {
    expect(panelFeedEventToMessage(raw("factory.worker_updated", { id: 7 }))).toEqual(Option.none());
  });

  test("an event that is not a stored event at all is dropped", () => {
    const notAnEvent: Parameters<typeof feedEventToMessage>[0] = JSON.parse('{"seq":"x"}');
    expect(feedEventToMessage(notAnEvent)).toEqual(Option.none());
  });
});

describe("subscriptions", () => {
  test("the aggregated subscriptions build without duplicate keys", async () => {
    const { subscriptions } = await import("./subscription");
    expect(Object.keys(subscriptions)).toEqual(expect.arrayContaining(["feed", "workerPanelFeed", "settingsFeed", "keys"]));
  });
});
