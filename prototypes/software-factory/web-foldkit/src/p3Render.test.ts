import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import type { FeedEvent } from "../../shared/feed";

const feed = vi.hoisted(() => ({ subs: new Set<(event: FeedEvent) => void>(), workerStatus: "running" }));
vi.mock("../../shared/feed", async (original) => ({
  ...(await original<typeof import("../../shared/feed")>()),
  onFeed: (subscriber: (event: FeedEvent) => void) => (feed.subs.add(subscriber), () => void feed.subs.delete(subscriber)),
}));
vi.mock("../../shared/approvals", async (original) => ({ ...(await original<typeof import("../../shared/approvals")>()), subscribeApprovals: () => () => {} }));

const agent = (id: string, role: string, status: string, owner?: string) => ({
  id, name: id, role, status, model: "m", auth: "native", pid: null, rssKb: null, home: "", task: "work", lastMessage: null, owner, eventCount: 0, contextTokens: null, contextLimit: null,
});
const threads = [
  { id: "aaaaaaaa", title: "chat", createdAt: 5, folderId: "general" },
  { id: "bbbbbbbb", title: "repo work", createdAt: 6, folderId: "trellage", worktree: "/w", parentThreadId: "aaaaaaaa" },
];
const responses = (url: string): unknown =>
  url === "/api/workers"
    ? [agent("coordinator", "coordinator", "idle"), agent("gen-aaaaaaaa", "coordinator", "idle"), agent("sub-bbbbbbbb", "coordinator", "running", "gen-aaaaaaaa"), agent("w1", "worker", feed.workerStatus, "sub-bbbbbbbb")]
    : url === "/api/threads/get"
      ? { threads, folders: [] }
      : url === "/api/steps"
        ? { securityReviews: [] }
        : url.startsWith("/api/events")
          ? [{ seq: 7, workerId: "w1", type: "assistant.message", agentId: null, timestamp: "2026-01-01T00:00:00Z", data: { content: "Tests pass." } }]
          : [];
vi.mock("../../shared/http", async (original) => ({ ...(await original<typeof import("../../shared/http")>()), json: (url: string) => Effect.sync(() => responses(url)) }));

await import("../../shared/protos/p3");
const { prototypes } = await import("../../shared/protos/core");

const push = (type: string, workerId = "w1") =>
  feed.subs.forEach((subscriber) => subscriber({ seq: 1, workerId, type, agentId: null, timestamp: "2026-01-01T00:00:00Z", data: { id: workerId, deltaContent: "x" } }));
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// A tree row replaced between mousedown and mouseup gets no click: streamed events must not replace it.
test("the conversation tree keeps its rows while agents stream, and waits for a press to end", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const stop = prototypes().find(({ id }) => id === 3)!.mount({ root, placeChat: () => {} });
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row]")).not.toBeNull());
  const row = root.querySelector("[data-testid=tree-row]")!;

  push("assistant.message_delta");
  push("factory.worker_updated");
  await frames();
  expect(root.querySelector("[data-testid=tree-row]")).toBe(row);

  row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  feed.workerStatus = "idle";
  push("factory.worker_updated");
  await frames();
  expect(root.querySelector("[data-testid=tree-row]")).toBe(row);
  window.dispatchEvent(new PointerEvent("pointerup"));
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row]")?.textContent).toContain("Idle"));
  stop();
});

// The 📡 Factory stream row shows every agent's events in the detail column; a click on an agent opens it in the tree.
test("the Factory stream view lists agent events and opens the agent it names", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const placeChat = vi.fn();
  const stop = prototypes().find(({ id }) => id === 3)!.mount({ root, placeChat });
  await vi.waitFor(() => expect(root.querySelector("[data-testid=stream-row]")).not.toBeNull());
  root.querySelector<HTMLElement>("[data-testid=stream-row]")!.click();
  const stream = root.querySelector("[data-testid=factory-stream]")!;
  expect(placeChat).toHaveBeenLastCalledWith(null);
  await vi.waitFor(() => expect(stream.textContent).toContain("Tests pass."));
  const who = [...stream.querySelectorAll<HTMLButtonElement>(".p2-who")].find((b) => b.textContent === "w1")!;
  expect(who.nextElementSibling?.textContent).toBe("worker");
  who.click();
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row].on")?.textContent).toContain("w1"));
  expect(root.querySelector("[data-testid=factory-stream]")).toBe(stream);
  stop();
});
