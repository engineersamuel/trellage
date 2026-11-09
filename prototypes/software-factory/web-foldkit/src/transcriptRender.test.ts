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

// The plan a coordinator records and the decision it opens read as markdown in the tool card, not only as JSON.
test("sdlc_plan and request_approval cards show readable markdown and, in the Inbox layout, a timeline link", async () => {
  const stage = document.createElement("div");
  stage.className = "sfp-p3";
  const host = document.createElement("div");
  stage.append(host);
  document.body.append(stage);
  const stop = mount(host, "w");
  await vi.waitFor(() => expect(feed.subs.size).toBe(1));
  await new Promise((resolve) => setTimeout(resolve));
  push(10, "tool.execution_start", { toolCallId: "p1", toolName: "sdlc_plan", arguments: { request: "Fix X", plan: "- remove the line", criteria: ["`curl` returns 200"] } });
  push(11, "tool.execution_complete", { toolCallId: "p1", success: true, result: { content: JSON.stringify({ gates: [{ id: "design", chosen: false, probability: 0.4, status: "skipped" }], checks: ["cargo test"] }) } });
  push(12, "tool.execution_start", { toolCallId: "a1", toolName: "request_approval", arguments: { title: "Approve plan", summary: "- **do** X", options: ["Approve", "Revise"], optionDetails: ["Implement"] } });
  await vi.waitFor(() => expect(host.querySelectorAll(".ui-tcc .sfd-summary").length).toBe(2));
  const [plan, approval] = [...host.querySelectorAll(".ui-tcc .sfd-summary")];
  expect(plan!.innerHTML).toContain("<li>remove the line</li>");
  expect(plan!.innerHTML).toContain("<li><code>curl</code> returns 200</li>");
  expect(plan!.querySelector("table")).not.toBeNull();
  expect(approval!.innerHTML).toContain("<strong>do</strong> X");
  expect(approval!.innerHTML).toContain("<strong>Approve</strong> (recommended) — Implement");
  const opened: string[] = [];
  const on = (event: Event) => opened.push(event instanceof CustomEvent ? String(event.detail) : "");
  window.addEventListener("sf:open-timeline", on);
  host.querySelectorAll<HTMLAnchorElement>(".ui-tcc__link").forEach((link) => link.textContent === "Open in timeline" && link.click());
  expect(opened).toEqual(["p1", "a1"]);
  window.removeEventListener("sf:open-timeline", on);
  stop();
  stage.remove();
});
