import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { Message } from "./message"
import { feedEventToMessage, inboxPickToMessage } from "./subscription"
import { feedEventToMessage as workersFeedEventToMessage } from "./workers/subscription"

const raw = (type: string, data: unknown) => ({
  seq: 1,
  workerId: "coordinator",
  type,
  agentId: null,
  timestamp: "0",
  data,
})

describe("feed decoding", () => {
  test("thread updates carry the thread id", () => {
    expect(feedEventToMessage(raw("factory.thread_updated", { threadId: "t1" }))).toEqual(
      Option.some(Message.ReceivedThreadUpdate({ threadId: "t1" })),
    )
  })

  test("the agent's open_report becomes a Message; the retired set_layout does not", () => {
    expect(
      feedEventToMessage(raw("factory.ui_open_report", { path: "reports/s.md", agent: "gen-1", threadId: "t1" })),
    ).toEqual(Option.some(Message.RequestedOpenReport({ ref: "reports/s.md", maybeAgent: Option.some("gen-1") })))
    expect(feedEventToMessage(raw("factory.ui_set_layout", { layout: 2 }))).toEqual(Option.none())
  })

  test("a gap marker becomes ReceivedFeedGap", () => {
    expect(feedEventToMessage(raw("factory.feed_reconnected", null))).toEqual(Option.some(Message.ReceivedFeedGap()))
  })

  test("a worker event with a wrong payload is dropped, not a crash", () => {
    expect(workersFeedEventToMessage(raw("factory.worker_updated", { id: 7 }))).toEqual(Option.none())
  })

  test("an event that is not a stored event at all is dropped", () => {
    const notAnEvent: Parameters<typeof feedEventToMessage>[0] = JSON.parse('{"seq":"x"}')
    expect(feedEventToMessage(notAnEvent)).toEqual(Option.none())
  })
})

describe("subscriptions", () => {
  test("the aggregated subscriptions build without duplicate keys", async () => {
    const { subscriptions } = await import("./subscription")
    expect(Object.keys(subscriptions)).toEqual(expect.arrayContaining(["feed", "workersFeed", "settingsFeed", "keys"]))
  })
})

test("an Inbox pick event becomes SelectedInboxNode; a bad payload is dropped", () => {
  const pick = new CustomEvent("sf:select-node", { detail: { threadId: "t1", workerId: "w-1" } })
  expect(inboxPickToMessage(pick)).toEqual(
    Option.some(Message.SelectedInboxNode({ maybeThreadId: Option.some("t1"), maybeWorkerId: Option.some("w-1") })),
  )
  const conversation = new CustomEvent("sf:select-node", { detail: { threadId: "t1", workerId: null } })
  expect(inboxPickToMessage(conversation)).toEqual(
    Option.some(Message.SelectedInboxNode({ maybeThreadId: Option.some("t1"), maybeWorkerId: Option.none() })),
  )
  expect(inboxPickToMessage(new CustomEvent("sf:select-node", { detail: "t1" }))).toEqual(Option.none())
})
