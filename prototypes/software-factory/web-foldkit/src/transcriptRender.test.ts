import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import type { FeedEvent } from "../../shared/feed";

const feed = vi.hoisted(() => ({ subs: new Set<(event: FeedEvent) => void>() }));
vi.mock("../../shared/feed", async (original) => ({
  ...(await original<typeof import("../../shared/feed")>()),
  onFeed: (subscriber: (event: FeedEvent) => void) => (feed.subs.add(subscriber), () => void feed.subs.delete(subscriber)),
}));
vi.mock("../../shared/http", async (original) => ({ ...(await original<typeof import("../../shared/http")>()), json: () => Effect.succeed([]) }));

const { mount } = await import("../../shared/transcript");

const push = (seq: number, type: string, data: unknown) =>
  feed.subs.forEach((subscriber) => subscriber({ seq, workerId: "w", type, agentId: null, timestamp: "2026-01-01T00:00:00Z", data }));

// A new spinner element restarts its CSS animation; a streamed event must not replace it or the bubbles above it.
test("streamed events keep the spinner and the message bubbles in the page", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const stop = mount(host, "w");
  await vi.waitFor(() => expect(feed.subs.size).toBe(1));
  await new Promise((resolve) => setTimeout(resolve));
  push(1, "user.message", { content: "Build it" });
  await vi.waitFor(() => expect(host.querySelector(".sft-spin")).not.toBeNull());
  const spinner = host.querySelector(".sft-spin");
  const bubble = host.querySelector(".sft-user");
  push(2, "assistant.reasoning_delta", { deltaContent: "planning" });
  push(3, "assistant.message_delta", { deltaContent: "Ok" });
  await vi.waitFor(() => expect(host.querySelector(".sft-activity b")?.textContent).toBe("Writing a reply…"));
  expect(host.querySelector(".sft-spin")).toBe(spinner);
  expect(host.querySelector(".sft-user")).toBe(bubble);
  stop();
});
