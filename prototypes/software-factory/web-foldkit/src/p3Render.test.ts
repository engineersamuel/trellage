import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import type { FeedEvent } from "../../shared/feed"

const feed = vi.hoisted(() => {
  const noGuide: unknown = null
  return {
    subs: new Set<(event: FeedEvent) => void>(),
    workerStatus: "running",
    /** Context tokens of w1; 0 = no reading yet. */
    workerContext: 0,
    posts: new Array<{ url: string; body: unknown }>(),
    /** GET /api/threads/<id>/test-guide; null = none written yet. */
    guide: noGuide,
  }
})
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
const threads: { id: string; title: string; createdAt: number; folderId: string; [k: string]: unknown }[] = [
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
  url.endsWith("/test-guide")
    ? feed.guide
    : url === "/api/workers"
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
            : url === "/api/cos/ledger"
              ? [
                  {
                    seq: 1,
                    at: 0,
                    rule: "R3",
                    threadId: "bbbbbbbb",
                    action: "merge factory/x",
                    result: "refused",
                    detail: "checks are PENDING",
                  },
                ]
              : url.startsWith("/api/events?types=factory.report_up")
                ? [
                    {
                      seq: 8,
                      workerId: "sub-bbbbbbbb",
                      type: "factory.report_up",
                      agentId: null,
                      timestamp: new Date().toISOString(),
                      data: { threadId: "bbbbbbbb", report: { status: "blocked", summary: "CI is red" } },
                    },
                  ]
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
  send: (url: string, method: string) => Effect.sync(() => void feed.posts.push({ url, body: method })),
}))

await import("../../shared/protos/p3")
const { COS_FILTER_EVENT, cosMessagesUrl } = await import("../../shared/cosFilter")
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
  await vi.waitFor(() => expect(document.querySelector("[data-testid=stream-row]")).not.toBeNull())
  document.querySelector<HTMLElement>("[data-testid=stream-row]")!.click()
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

// The 📒 Rule ledger row lists every Chief of Staff rule action; a click on a row opens its conversation.
test("the Rule ledger lists rule actions and opens the conversation of a row", async () => {
  const root = document.createElement("div")
  document.body.append(root)
  const stop = prototypes()
    .find(({ id }) => id === 3)!
    .mount({ root, placeChat: () => {} })
  await vi.waitFor(() => expect(document.querySelector("[data-testid=ledger-row]")).not.toBeNull())
  document.querySelector<HTMLElement>("[data-testid=ledger-row]")!.click()
  const ledger = root.querySelector("[data-testid=rule-ledger]")!
  await vi.waitFor(() => expect(ledger.textContent).toContain("checks are PENDING"))
  expect(ledger.querySelector("tr.sf-ledger-refused")?.textContent).toContain("R3")
  ledger.querySelector<HTMLElement>("tr.sf-ledger-refused")!.click()
  await vi.waitFor(() => expect(root.querySelector("[data-testid=rule-ledger]")).toBeNull())
  stop()
})

const mountInbox = async () => {
  // The navbar's slot for Chief of Staff and + Draft (web-foldkit/src/view.ts).
  if (!document.querySelector(".p3-actions-slot"))
    document.body.append(Object.assign(document.createElement("div"), { className: "p3-actions-slot" }))
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
  const { stop } = await mountInbox()
  document.querySelector<HTMLElement>("[data-testid=new-draft]")!.click()
  const form = document.querySelector<HTMLFormElement>(".p3-draft-form")!
  expect(form.hidden).toBe(false)
  expect([...form.querySelectorAll("option")].map((o) => o.value)).toEqual(["trellage"])
  form.querySelector("textarea")!.value = "Add retries"
  form.requestSubmit()
  await vi.waitFor(() =>
    expect(feed.posts).toContainEqual({
      url: "/api/drafts",
      body: { folderId: "trellage", prompt: "Add retries" },
    }),
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

// The sub-coordinator header keeps a How to test pin: steps from the guide, herdr and rewrite buttons, stale marker.
test("the sub-coordinator header pins How to test with Open in herdr and Rewrite", async () => {
  const { root, stop } = await mountInbox()
  root.querySelector<HTMLElement>("[data-testid=tree-sub]")!.click()
  const pin = () => root.querySelector<HTMLElement>(".p3-head [data-testid=test-guide]")
  await vi.waitFor(() => expect(pin()?.textContent).toContain("🧪 How to test · not written yet"))
  feed.guide = {
    status: "ready",
    commit: "abcdef123",
    setup: ["bun install"],
    steps: [{ do: "Open the page", expect: "it loads" }],
    cleanup: [],
    stale: true,
  }
  push("factory.test_guide", "sub-bbbbbbbb")
  await vi.waitFor(() => expect(pin()?.textContent).toContain("stale: written for abcdef1"))
  expect(pin()!.querySelector(".p3-pin-doc")?.textContent).toContain("Open the page")
  const button = (text: string) => [...pin()!.querySelectorAll("button")].find((b) => b.textContent === text)!
  button("▶ Open in herdr").click()
  button("↻ Rewrite").click()
  await vi.waitFor(() =>
    expect(feed.posts).toEqual(
      expect.arrayContaining([
        { url: "/api/threads/bbbbbbbb/test-guide/herdr", body: "POST" },
        { url: "/api/threads/bbbbbbbb/test-guide", body: "POST" },
      ]),
    ),
  )
  await vi.waitFor(() => expect(pin()?.textContent).toContain("opened in herdr"))
  feed.guide = null
  stop()
})

// The host writes ?thread= and ?worker= from these picks (web-foldkit SelectedInboxNode).
test("a pick in the tree tells the host its conversation, and the worker when it is a worker", async () => {
  const picks: unknown[] = []
  const listen = (e: Event) => picks.push(e instanceof CustomEvent ? e.detail : null)
  window.addEventListener("sf:select-node", listen)
  const { root, stop } = await mountInbox()
  root.querySelector<HTMLElement>("[data-testid=tree-row]")!.click()
  await vi.waitFor(() => expect(picks.at(-1)).toEqual({ threadId: "bbbbbbbb", workerId: "w1" }))
  root.querySelector<HTMLElement>("[data-testid=tree-sub]")!.click()
  await vi.waitFor(() => expect(picks.at(-1)).toEqual({ threadId: "bbbbbbbb", workerId: null }))
  root.querySelector<HTMLElement>("[data-testid=tree-chat]")!.click()
  await vi.waitFor(() => expect(picks.at(-1)).toEqual({ threadId: "aaaaaaaa", workerId: null }))
  window.removeEventListener("sf:select-node", listen)
  stop()
})

test("?worker= in the URL focuses that worker on load", async () => {
  history.replaceState(null, "", "/?thread=bbbbbbbb&worker=w1")
  const { root, stop } = await mountInbox()
  await vi.waitFor(() => expect(root.querySelector("[data-testid=tree-row].on")?.textContent).toContain("w1"))
  history.replaceState(null, "", "/")
  stop()
})

// A dormant branch (no live agent, nothing below running) is hidden until the human shows it.
test("dormant conversations hide under a toggle, and the Chief of Staff button leads the top-bar actions", async () => {
  threads.push({
    id: "cccccccc",
    title: "old work",
    createdAt: 7,
    folderId: "trellage",
    worktree: "/w2",
    parentThreadId: "aaaaaaaa",
  })
  const { root, stop } = await mountInbox()
  expect(document.querySelector(".p3-actions")?.firstElementChild?.getAttribute("data-testid")).toBe("ask-cos")
  const toggle = () => root.querySelector<HTMLElement>("[data-testid=dormant-toggle]")!
  await vi.waitFor(() => expect(toggle().textContent).toBe("▸ 1 dormant hidden · show"))
  expect(root.querySelector(".p3-card[data-id=sub-cccccccc]")).toBeNull()
  toggle().click()
  expect(root.querySelector(".p3-card[data-id=sub-cccccccc]")).not.toBeNull()
  expect(toggle().textContent).toBe("▾ Hide dormant")
  threads.pop()
  stop()
})

// The CoS opens on its chat with the digest pinned on top; the filter toggles add event kinds to the chat.
test("the Chief of Staff head pins the digest and the chat filter, and a digest row opens its conversation", async () => {
  const { root, stop } = await mountInbox()
  const shown: string[] = []
  const listen = () => shown.push(cosMessagesUrl("t"))
  window.addEventListener(COS_FILTER_EVENT, listen)
  threads.push({ id: "eeeeeeee", title: "Chief of Staff", createdAt: 1, folderId: "general", desk: true })
  push("factory.worker_updated", "coordinator")
  await vi.waitFor(() => expect(document.querySelector("[data-testid=ask-cos]")).not.toBeNull())
  document.querySelector<HTMLElement>("[data-testid=ask-cos]")!.click()
  const digest = () => root.querySelector<HTMLElement>(".p3-head [data-testid=cos-digest]")
  await vi.waitFor(() => expect(digest()?.textContent).toContain("CI is red"))
  expect(digest()!.querySelector("summary")?.textContent).toBe(
    "🗞 Since you last looked · so far · 1 report · 0 rule actions",
  )
  const filter = root.querySelector<HTMLElement>(".p3-head [data-testid=cos-filter]")!
  expect(filter.querySelectorAll("button.on")).toHaveLength(0)
  expect(filter.querySelector("[data-testid=cos-earlier]")).not.toBeNull()
  ;[...filter.querySelectorAll("button")].find((b) => b.textContent === "Reports")!.click()
  expect(shown.at(-1)).toBe("/api/threads/get/t?view=human&show=reports&limit=300")
  expect(root.querySelector(".p3-head [data-testid=cos-filter] button.on")?.textContent).toBe("Reports")
  root.querySelector<HTMLElement>(".p3-head [data-testid=cos-filter] button.on")!.click()
  expect(shown.at(-1)).toBe("/api/threads/get/t?view=human&show=&limit=300")
  root.querySelector<HTMLElement>(".p3-head [data-testid=cos-earlier]")!.click()
  expect(shown.at(-1)).toBe("/api/threads/get/t?view=human&show=&limit=600")
  digest()!.querySelector<HTMLElement>(".p3-digest-row")!.click()
  await vi.waitFor(() => expect(root.querySelector(".p3-card.on")?.getAttribute("data-id")).toBe("sub-bbbbbbbb"))
  window.removeEventListener(COS_FILTER_EVENT, listen)
  threads.pop()
  stop()
})

// The sidebar is a left popover (like ☰ Conversations); Chief of Staff and + Draft sit in the navbar slot.
const toggleClose = (panel: HTMLElement) => {
  document.querySelector<HTMLElement>("[data-testid=views-toggle]")!.click()
  expect(panel.hidden).toBe(true)
}

test("the views popover opens from its toggle and closes on a pick; the actions go to the navbar slot", async () => {
  const { root, stop } = await mountInbox()
  const slot = document.querySelector<HTMLElement>(".p3-actions-slot")!
  await vi.waitFor(() =>
    expect(slot.querySelector("[data-testid=ask-cos]")?.textContent).toContain("💬 Chief of Staff"),
  )
  expect(slot.querySelector("[data-testid=new-draft]")).not.toBeNull()
  expect(root.querySelector(".p3-side")).toBeNull()
  const panel = document.querySelector<HTMLElement>(".p3-views")!
  expect(panel.hidden).toBe(true)
  document.querySelector<HTMLElement>("[data-testid=views-toggle]")!.click()
  expect(panel.hidden).toBe(false)
  // A view pick filters the list in place; a conversation pick closes the popover.
  expect(panel.querySelector(".p3-inbox")).not.toBeNull()
  expect(root.querySelector(".p3-inbox")).toBeNull()
  panel.querySelector<HTMLElement>(".p3-sv")!.click()
  expect(panel.hidden).toBe(false)
  toggleClose(panel)
  // A click outside closes it; a click inside does not.
  document.querySelector<HTMLElement>("[data-testid=views-toggle]")!.click()
  panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  expect(panel.hidden).toBe(false)
  root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
  expect(panel.hidden).toBe(true)
  stop()
  expect(document.querySelector(".p3-views")).toBeNull()
  expect(slot.querySelector(".p3-actions")).toBeNull()
})
