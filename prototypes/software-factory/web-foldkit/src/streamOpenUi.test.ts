// The shared stream (shared/protos/stream.ts) shows an agent answer written in OpenUI Lang as a native Foldkit card
// (src/openUiCard.ts), keeps it across rebuilds, and sends "continue the conversation" to the agent that wrote it.
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import type { FeedEvent } from "../../shared/feed"

const PROGRAM = `root = Card([header, buttons])
header = CardHeader("Plan ready", "3 steps")
buttons = Buttons([Button("Go on", @ToAssistant("Go on"))])`

const sent = vi.hoisted((): { calls: unknown[] } => ({ calls: [] }))
vi.mock("../../shared/feed", async (original) => ({
  ...(await original<typeof import("../../shared/feed")>()),
  onFeed: (_subscriber: (event: FeedEvent) => void) => () => {},
}))
vi.mock("../../shared/approvals", async (original) => ({
  ...(await original<typeof import("../../shared/approvals")>()),
  subscribeApprovals: () => () => {},
}))
const responses = (url: string): unknown =>
  url === "/api/workers"
    ? [
        {
          id: "gen-aaaaaaaa",
          name: "chat",
          role: "coordinator",
          status: "idle",
          model: "m",
          auth: "native",
          pid: null,
          rssKb: null,
          home: "",
          task: "t",
          lastMessage: null,
          eventCount: 0,
          contextTokens: null,
          contextLimit: null,
        },
      ]
    : url === "/api/threads/get"
      ? { threads: [{ id: "aaaaaaaa", title: "chat", createdAt: 5, folderId: "general" }], folders: [] }
      : url === "/api/steps"
        ? { securityReviews: [] }
        : url.startsWith("/api/events")
          ? [
              {
                seq: 9,
                workerId: "gen-aaaaaaaa",
                type: "assistant.message",
                agentId: null,
                timestamp: "2026-01-01T00:00:00Z",
                data: { content: PROGRAM, threadId: "aaaaaaaa" },
              },
            ]
          : []
vi.mock("../../shared/http", async (original) => ({
  ...(await original<typeof import("../../shared/http")>()),
  json: (url: string) => Effect.sync(() => responses(url)),
  send: (url: string, method: string, body: unknown) => Effect.sync(() => void sent.calls.push({ url, method, body })),
}))

await import("./openUiCard")
await import("../../shared/protos/p3")
const { prototypes } = await import("../../shared/protos/core")

test("the stream draws an OpenUI answer as a native card, and its button continues the conversation", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const stop = prototypes()
    .find(({ id }) => id === 3)!
    .mount({ root, placeChat: () => {} })
  await vi.waitFor(() => expect(root.querySelector("[data-testid=stream-row]")).not.toBeNull())
  root.querySelector<HTMLElement>("[data-testid=stream-row]")!.click()
  await vi.waitFor(() => expect(root.querySelector(".p2-report .openui-card")).not.toBeNull(), { timeout: 5000 })
  const card = root.querySelector(".p2-report .openui-card")!
  expect(card.querySelector(".openui-header")?.textContent).toContain("Plan ready")
  expect(root.querySelector(".p2-report")?.textContent).not.toContain("root =")

  const button = [...card.querySelectorAll("button")].find((b) => b.textContent?.includes("Go on"))!
  button.click()
  await vi.waitFor(() =>
    expect(sent.calls).toContainEqual({
      url: "/api/workers/gen-aaaaaaaa/message",
      method: "POST",
      body: { prompt: "Go on", threadId: "aaaaaaaa" },
    }),
  )
  expect(root.querySelector(".p2-report .openui-card")).toBe(card)
  stop()
})
