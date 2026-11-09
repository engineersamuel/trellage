import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import type { FeedEvent } from "../../shared/feed";

const feed = vi.hoisted(() => ({ subs: new Set<(event: FeedEvent) => void>(), chatStatus: "idle" }));
vi.mock("../../shared/feed", async (original) => ({
  ...(await original<typeof import("../../shared/feed")>()),
  onFeed: (subscriber: (event: FeedEvent) => void) => (feed.subs.add(subscriber), () => void feed.subs.delete(subscriber)),
}));
vi.mock("../../shared/approvals", async (original) => ({ ...(await original<typeof import("../../shared/approvals")>()), subscribeApprovals: () => () => {} }));

const agent = (id: string, role: string, status: string, owner?: string) => ({
  id, name: id, role, status, model: "m", auth: "native", pid: null, rssKb: null, home: "", task: "work", lastMessage: null, owner, eventCount: 0, contextTokens: null, contextLimit: null,
});
const threads = [{ id: "aaaaaaaa", title: "chat", createdAt: 5, folderId: "general" }];
const responses = (url: string): unknown =>
  url === "/api/workers"
    ? [agent("coordinator", "coordinator", "idle"), agent("gen-aaaaaaaa", "coordinator", feed.chatStatus)]
    : url === "/api/threads/get"
      ? { threads, folders: [] }
      : url === "/api/steps"
        ? { securityReviews: [] }
        : [];
vi.mock("../../shared/http", async (original) => ({ ...(await original<typeof import("../../shared/http")>()), json: (url: string) => Effect.sync(() => responses(url)) }));

await import("../../shared/protos/p2");
const { prototypes } = await import("../../shared/protos/core");

const push = (type: string, workerId = "gen-aaaaaaaa") =>
  feed.subs.forEach((subscriber) => subscriber({ seq: 1, workerId, type, agentId: null, timestamp: "2026-01-01T00:00:00Z", data: { id: workerId, deltaContent: "x" } }));
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// A card button replaced between mousedown and mouseup gets no click: streamed events must not replace it.
test("the org canvas keeps card buttons while agents stream, and waits for a press to end", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const stop = prototypes().find(({ id }) => id === 2)!.mount({ root, placeChat: () => {} });
  const archive = () => root.querySelector("[aria-label='Archive chat']");
  const foot = () => archive()?.closest(".p2-node")?.querySelector(".p2-n-foot")?.textContent ?? "";
  await vi.waitFor(() => expect(archive()).not.toBeNull());
  const button = archive();

  push("assistant.message_delta");
  push("factory.worker_updated");
  await frames();
  expect(archive()).toBe(button);

  button!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  feed.chatStatus = "running";
  push("factory.worker_updated");
  await frames();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(foot()).toMatch(/^idle/);
  window.dispatchEvent(new PointerEvent("pointerup"));
  await vi.waitFor(() => expect(foot()).toMatch(/^running/));
  expect(archive()).toBe(button);
  stop();
});
