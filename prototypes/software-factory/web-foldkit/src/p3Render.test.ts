import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import type { FeedEvent } from "../../shared/feed"

const feed = vi.hoisted(() => ({
  subs: new Set<(event: FeedEvent) => void>(),
  workerStatus: "running",
  /** Context tokens of w1; 0 = no reading yet. */
  workerContext: 0,
  posts: new Array<{ url: string; body: unknown }>(),
}))
vi.mock("../../shared/feed", async (original) => ({
  ...(await original<typeof import("../../shared/feed")>()),
  onFeed: (subscriber: (event: FeedEvent) => void) => (
    feed.subs.add(subscriber),
    () => void feed.subs.delete(subscriber)
  ),
}))
vi.mock("../../shared/approvals", async (original) => ({
  ...(await original<typeof import("../../shared/approvals")>()),
  subscribeApprovals: () => () => {},
}))

const agent = (id: string, role: string, status: string, owner?: string, harness?: string) => ({
  id,
  name: id,
  role,
  status,
  model: "m",
  auth: "native",
  pid: null,
  rssKb: null,
  home: "",
  task: "work",
  lastMessage: null,
  owner,
  eventCount: 0,
  contextTokens: null,
  contextLimit: null,
  harness,
})
const threads = [
  { id: "aaaaaaaa", title: "chat", createdAt: 5, folderId: "general" },
  {
    id: "bbbbbbbb",
    title: "repo work",
    createdAt: 6,
    folderId: "trellage",
    worktree: "/w",
    parentThreadId: "aaaaaaaa",
  },
]
const responses = (url: string): unknown =>
  url === "/api/workers"
    ? [
        agent("coordinator", "coordinator", "idle"),
        agent("gen-aaaaaaaa", "coordinator", "idle"),
        agent("sub-bbbbbbbb", "coordinator", "running", "gen-aaaaaaaa", "claude"),
        {
          ...agent("w1", "worker", feed.workerStatus, "sub-bbbbbbbb", "pi"),
          contextTokens: feed.workerContext || null,
          contextLimit: feed.workerContext ? 200_000 : null,
        },
      ]
    : url === "/api/threads/get"
      ? {
          threads,
          folders: [
            { id: "general", name: "General", path: "" },
            { id: "trellage", name: "trellage", path: "/repo" },
          ],
        }
      : url === "/api/drafts"
        ? { id: "dddddddd-new" }
        : url === "/api/steps"
          ? { securityReviews: [] }
          : url.startsWith("/api/events")
            ? [
                {
                  seq: 7,
                  workerId: "w1",
                  type: "assistant.message",
                  agentId: null,
                  timestamp: "2026-01-01T00:00:00Z",
                  data: { content: "Tests pass." },
                },
              ]
            : []
vi.mock("../../shared/http", async (original) => ({
  ...(await original<typeof import("../../shared/http")>()),
  json: (url: string, _schema: unknown, init?: RequestInit) =>
    Effect.sync(() => (init?.body && feed.posts.push({ url, body: JSON.parse(String(init.body)) }), responses(url))),
}))

await import("../../shared/protos/p3")
const { prototypes } = await import("../../shared/protos/core")

const push = (type: string, workerId = "w1") =>
  feed.subs.forEach((subscriber) =>
    subscriber({
      seq: 1,
      workerId,
      type,
      agentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      data: { id: workerId, deltaContent: "x" },
    }),
  )
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

// A tree row replaced between mousedown and mouseup gets no click: streamed events must not replace it.
test("the conversation tree keeps its rows while agents stream, and waits for a press to end", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const stop = prototypes()
    .find(({ id }) => id === 3)!
    .mount({ root, placeChat: () => {} })
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row]")).not.toBeNull())
  const row = root.querySelector("[data-testid=tree-row]")!

  push("assistant.message_delta")
  push("factory.worker_updated")
  await frames()
  expect(root.querySelector("[data-testid=tree-row]")).toBe(row)

  row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  feed.workerStatus = "idle"
  push("factory.worker_updated")
  await frames()
  expect(root.querySelector("[data-testid=tree-row]")).toBe(row)
  window.dispatchEvent(new PointerEvent("pointerup"))
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row]")?.textContent).toContain("Idle"))
  stop()
})

// The 📡 Factory stream row shows every agent's events in the detail column; a click on an agent opens it in the tree.
test("the Factory stream view lists agent events and opens the agent it names", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const placeChat = vi.fn<(box: unknown) => void>()
  const stop = prototypes()
    .find(({ id }) => id === 3)!
    .mount({ root, placeChat })
  await vi.waitFor(() => expect(root.querySelector("[data-testid=stream-row]")).not.toBeNull())
  root.querySelector<HTMLElement>("[data-testid=stream-row]")!.click()
  const stream = root.querySelector("[data-testid=factory-stream]")!
  expect(placeChat).toHaveBeenLastCalledWith(null)
  await vi.waitFor(() => expect(stream.textContent).toContain("Tests pass."))
  const who = [...stream.querySelectorAll<HTMLButtonElement>(".p2-who")].find((b) => b.textContent === "w1")!
  expect(who.nextElementSibling?.textContent).toBe("worker")
  who.click()
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row].on")?.textContent).toContain("w1"))
  expect(root.querySelector("[data-testid=factory-stream]")).toBe(stream)
  stop()
})

const mountInbox = async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const stop = prototypes()
    .find(({ id }) => id === 3)!
    .mount({ root, placeChat: () => {} })
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-chat]")).not.toBeNull())
  return { root, stop }
}

// Each agent shows the SDK that runs it; a General chat runs in the Copilot SDK even before its session starts.
test("the tree shows the harness icon of the chat, its sub-coordinator and its worker", async () => {
  const { root, stop } = await mountInbox()
  const label = (sel: string) => root.querySelector(`${sel} .sf-harness`)?.getAttribute("aria-label")
  expect(label("[data-testid=tree-chat]")).toBe("GitHub Copilot SDK")
  expect(label("[data-testid=tree-sub]")).toBe("Claude Agent SDK")
  expect(label("[data-testid=tree-row]")).toBe("Pi coding agent")
  stop()
})

test("+ Draft creates a draft in a repo folder", async () => {
  const { root, stop } = await mountInbox()
  root.querySelector<HTMLElement>("[data-testid=new-draft]")!.click()
  const form = root.querySelector<HTMLFormElement>(".p3-draft-form")!
  expect(form.hidden).toBe(false)
  expect([...form.querySelectorAll("option")].map((o) => o.value)).toEqual(["trellage"])
  form.querySelector("textarea")!.value = "Add retries"
  form.requestSubmit()
  await vi.waitFor(() =>
    expect(feed.posts).toContainEqual({ url: "/api/drafts", body: { folderId: "trellage", prompt: "Add retries" } }),
  )
  await vi.waitFor(() => expect(form.hidden).toBe(true))
  stop()
})

test("the Canvas switch draws the selected conversation as a chart, and a card click selects its agent", async () => {
  const { root, stop } = await mountInbox()
  root.querySelector<HTMLElement>("[data-testid=view-canvas]")!.click()
  expect(root.classList.contains("canvas")).toBe(true)
  expect([...root.querySelectorAll<HTMLElement>(".p3-cv")].map((c) => c.dataset.id)).toEqual([
    "gen-aaaaaaaa",
    "sub-bbbbbbbb",
    "w1",
  ])
  expect(root.querySelectorAll(".p3-edges path")).toHaveLength(2)
  root.querySelector<HTMLElement>(".p3-cv[data-id=w1]")!.click()
  expect(root.querySelector(".p3-cv.on")?.getAttribute("data-id")).toBe("w1")
  root.querySelector<HTMLElement>("[data-testid=view-tree]")!.click()
  expect(root.classList.contains("canvas")).toBe(false)
  expect(root.querySelector(".p3-cv")).toBeNull()
  stop()
})

// Context fill changes on each model call; the header shows it for workers and sub-coordinators without a redraw.
test("the detail header shows the selected agent's context fill and updates it", async () => {
  const { root, stop } = await mountInbox()
  root.querySelector<HTMLElement>("[data-testid=tree-row]")!.click()
  const ctx = () => [...root.querySelectorAll(".p3-head .p3-why")].find((e) => e.textContent?.startsWith("◔"))
  await vi.waitFor(() => expect(ctx()?.textContent).toBe("◔ ctx –"))
  feed.workerContext = 50_000
  push("factory.worker_updated")
  await vi.waitFor(() => expect(ctx()?.textContent).toBe("◔ ctx 50k / 200k · 25%"))
  feed.workerContext = 0
  stop()
})
