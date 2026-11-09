import { expect, test, type Page } from "@playwright/test"
import "../bun-runtime.setup.ts"

// Org canvas (?proto=2, Foldkit at /): the draft node's radial menu and slide-over. Every /api/** call is stubbed.
test.use({ channel: "chrome" })

/** Page under test: FACTORY_PAGE, else the path of PLAYWRIGHT_BASE_URL, else "/". */
const PAGE = process.env.FACTORY_PAGE ?? (process.env.PLAYWRIGHT_BASE_URL ? new URL(process.env.PLAYWRIGHT_BASE_URL).pathname : "/")

const ID = "d1a2b3c4-5e6f-4000-8000-000000000001"
const v1 = { id: "v1", prompt: "Add retries to the fetch client", source: "human", at: 1 }
const v2 = { id: "v2", prompt: "Add bounded retries with backoff\nto the fetch client", source: "enhance", title: "Bounded", notes: "Adds a limit", at: 2 }
const candidates = [
  { title: "Minimal", prompt: "Retry fetch once", notes: "Smallest change" },
  { title: "Bounded", prompt: v2.prompt, notes: "Adds a limit" },
  { title: "Full", prompt: "Retry with jitter and metrics", notes: "Most work" },
]
const council = { action: "council", workerId: "w-council", path: "reports/draft-council.md", versionId: "v2" }
const draftThread = (draft: object) => ({ id: ID, title: "Add retries", createdAt: 1, folderId: "repo", worktree: "/wt/d1a2b3c4", branch: "sf/d1a2b3c4", draft })
/** The docked chat shows this General chat; with no thread at all the native chat would cover the canvas. */
const general = { id: "g1", title: "General", createdAt: 0, folderId: "general" }
const worker = (id: string, status: string) => ({
  id, name: "council", role: "worker", status, model: "m", auth: "a", pid: null, rssKb: null, task: null, lastMessage: null,
  owner: "draft-d1a2b3c4", contextTokens: null, contextLimit: null,
})

/** A minimal settings document (GET /api/settings), as the coordinator sends it. */
const SETTINGS = {"settings":{"theme":"default","themes":{"default":{"bg":"#0a0a0a","surface":"#171717","border":"#262626","text":"#e5e5e5","muted":"#a3a3a3","accent":"#6366f1"}},"layout":{"panel":"right","panelWidth":35},"navbar":["status","workers","model","context"],"animations":true,"hotkeys":{",":"toggleSettings","p":"togglePanel","t":"cycleTheme",".":"focusCoordinator"},"focus":"coordinator","banner":null,"agent":{"model":"m","reasoningEffort":"default","disabledTools":[],"instructions":""},"crons":{},"extensions":{},"repo":"","supervisor":{"enabled":true,"everySeconds":60,"stallSeconds":300,"offTrackCheck":true}},"css":"","run":null,"options":{"navbarItems":["status","workers","model","context","auth","crons","repo"],"panelPositions":["right","left","hidden"],"hotkeyActions":["toggleSettings","togglePanel","cycleTheme","focusCoordinator","abortCoordinator"],"efforts":["default","low","medium","high","xhigh"],"toolKinds":["shell","write","read","url","mcp"],"slots":["chat-background","page-background","navbar","banner","panel-top","overlay"],"models":[]}}

type Stub = {
  thread: object | null
  workers: object[]
  posts: { path: string; body: unknown }[]
  /** Answer of a POST /api/drafts... call; returns the new draft, or a status + body. */
  post: (path: string, body: any) => { draft?: object; thread?: object; status?: number; json?: object }
}

/** Stub every /api/** call. The feed ends at once with `retry: 100`, so the page reconnects and reloads its state often. */
const stub = async (page: Page, s: Stub) => {
  const agui: string[] = []
  await page.route("**/api/**", async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    if (path.startsWith("/api/agui")) {
      agui.push(path)
      throw new Error("A draft must never start an agent")
    }
    if (path === "/api/feed") return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 100\n\n" })
    if (path === "/api/threads/get")
      return route.fulfill({ json: { threads: [general, ...(s.thread ? [s.thread] : [])], folders: [{ id: "general", name: "General", path: "" }, { id: "repo", name: "repo", path: "/repo" }] } })
    if (path === "/api/workers") return route.fulfill({ json: s.workers })
    if (path === "/api/approvals") return route.fulfill({ json: [] })
    if (path === "/api/steps") return route.fulfill({ json: { securityReviews: [] } })
    // The CopilotKit (React) shell renders the canvas only after settings load.
    if (path === "/api/settings") return route.fulfill({ json: SETTINGS })
    if (path.startsWith("/api/drafts") && req.method() === "POST") {
      const body = req.postData() ? JSON.parse(req.postData()!) : undefined
      s.posts.push({ path, body })
      const r = s.post(path, body)
      if (r.status) return route.fulfill({ status: r.status, json: r.json })
      if (r.thread) s.thread = r.thread
      if (r.draft) s.thread = draftThread(r.draft)
      return route.fulfill({ json: r.draft ?? r.thread })
    }
    if (path === "/api/reports")
      return route.fulfill({ json: { threadId: ID, folderId: "repo", title: "Add retries", path: url.searchParams.get("path"), file: "/wt/x", content: "# Council verdict\n\nUse bounded retries." } })
    if (path === "/api/events" || path.startsWith("/api/threads/get/")) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  return agui
}

const node = (page: Page) => page.locator(".p2-node.draft")
const openRing = async (page: Page) => {
  await node(page).click()
  await expect(page.getByRole("menu")).toBeVisible()
}

test("draft: create, enhance, pick, council, run", async ({ page }) => {
  let draft: any = { versions: [v1], current: "v1", reports: [] }
  const s: Stub = {
    thread: null,
    workers: [],
    posts: [],
    post: (path, body) => {
      if (path === "/api/drafts") return { thread: draftThread(draft) }
      if (path.endsWith("/enhance")) return { draft: (draft = { ...draft, pending: { kind: "enhance", candidates, at: 3 } }) }
      if (path.endsWith("/pick")) {
        const { pending: _, ...rest } = draft
        return { draft: (draft = { ...rest, versions: [v1, { ...v2, prompt: candidates[body.index].prompt }], current: "v2" }) }
      }
      if (path.endsWith("/council")) return { draft: (draft = { ...draft, reports: [council] }) }
      if (path.endsWith("/run")) return { draft: (draft = { ...draft, startedAt: 9 }) }
      return { status: 404, json: { error: "no route" } }
    },
  }
  const agui = await stub(page, s)
  await page.goto(`${PAGE}?proto=2`)

  await page.getByTestId("new-draft").click()
  await page.getByLabel("Draft prompt").fill(v1.prompt)
  await page.getByRole("button", { name: "Create" }).click()
  await expect(node(page)).toContainText("Draft · repo")
  await expect(node(page)).toContainText("v1")

  await openRing(page)
  await expect(page.getByRole("menuitem")).toHaveCount(6)
  await expect(page.getByRole("menuitem", { name: "Hyperresearch", exact: true })).toBeVisible()
  await page.getByRole("menuitem", { name: "Enhance" }).click()
  const cards = page.locator(".p2-cand")
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(1)).toContainText("Bounded")
  await expect(cards.nth(1)).toContainText("Adds a limit")
  await cards.nth(1).getByRole("button", { name: "Pick" }).click()
  await expect(node(page)).toContainText("v2")
  expect(s.posts.find((p) => p.path.endsWith("/pick"))?.body).toEqual({ index: 1 })
  // Version list: newest first, with a line diff to the previous version.
  const versions = page.locator(".p2-ver")
  await expect(versions).toHaveCount(2)
  await expect(versions.first()).toContainText("v2")
  await expect(versions.first().locator(".p2-diff .del")).toHaveText(["- Add retries to the fetch client"])
  await expect(versions.first().locator(".p2-diff .add")).toHaveText(["+ Add bounded retries with backoff", "+ to the fetch client"])
  await expect(cards).toHaveCount(0)

  await openRing(page)
  await page.getByRole("menuitem", { name: "Council" }).click()
  // No worker is listed as running, so the report counts as finished and opens from the card.
  await expect(node(page).getByRole("button", { name: "📄 Council · v2" })).toBeVisible()
  expect(s.posts.filter((p) => p.path === `/api/drafts/${ID}/council`)).toHaveLength(1)

  await openRing(page)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)
  await openRing(page)
  await page.getByRole("menuitem", { name: "Run" }).click()
  await expect(page.getByRole("menu")).toHaveCount(0)
  await expect(page.locator(".p2-draftover")).not.toBeVisible()
  await expect(node(page)).toHaveCount(0)
  expect(s.posts.filter((p) => p.path === `/api/drafts/${ID}/run`)).toHaveLength(1)
  expect(agui).toEqual([])
})

test("draft: Run disabled while Council runs", async ({ page }) => {
  const s: Stub = {
    thread: draftThread({ versions: [v1, v2], current: "v2", reports: [council] }),
    workers: [worker("w-council", "running")],
    posts: [],
    post: () => ({ status: 500, json: { error: "unexpected" } }),
  }
  const agui = await stub(page, s)
  await page.goto(`${PAGE}?proto=2`)
  await openRing(page)
  const run = page.getByRole("menuitem", { name: "Run" })
  await expect(run).toBeDisabled()
  await expect(run).toHaveAttribute("title", "Council is running")
  await expect(page.getByRole("menuitem", { name: "Council" })).toBeDisabled()
  await expect(page.getByRole("menuitem", { name: "Debate" })).toBeEnabled()
  // An outside click closes the ring.
  await page.locator(".p2-canvas").click({ position: { x: 5, y: 5 } })
  await expect(page.getByRole("menu")).toHaveCount(0)
  expect(s.posts).toEqual([])
  expect(agui).toEqual([])
})

test("draft: pending rewrites block Research until Keep current dismisses them", async ({ page }) => {
  let draft: any = { versions: [v1], current: "v1", reports: [], pending: { kind: "enhance", candidates, at: 3 } }
  const s: Stub = {
    thread: draftThread(draft),
    workers: [],
    posts: [],
    post: (path) => {
      if (path.endsWith("/dismiss")) {
        const { pending: _, ...rest } = draft
        return { draft: (draft = rest) }
      }
      return { status: 500, json: { error: "unexpected" } }
    },
  }
  const agui = await stub(page, s)
  await page.goto(`${PAGE}?proto=2`)
  await openRing(page)
  for (const name of ["Council", "Debate", "Research", "Hyperresearch", "Run"]) {
    const b = page.getByRole("menuitem", { name, exact: true })
    await expect(b).toBeDisabled()
    await expect(b).toHaveAttribute("title", "Pick a rewrite first")
  }
  await expect(page.getByRole("menuitem", { name: "Enhance" })).toBeEnabled()
  await page.keyboard.press("Escape")

  await expect(page.getByRole("menu")).toHaveCount(0)
  // The card says rewrites are waiting and reopens them; no ring opens.
  await node(page).getByRole("button", { name: "3 rewrites · pick one" }).click()
  await expect(page.locator(".p2-cand")).toHaveCount(3)
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.getByRole("button", { name: "Keep current" }).click()
  await expect(page.locator(".p2-cand")).toHaveCount(0)
  expect(s.posts).toEqual([{ path: `/api/drafts/${ID}/dismiss`, body: undefined }])
  await openRing(page)
  await expect(page.getByRole("menuitem", { name: "Research", exact: true })).toBeEnabled()
  expect(agui).toEqual([])
})

test("draft: enhance error shows its first line on the node and the full text in the slide-over", async ({ page }) => {
  const s: Stub = {
    thread: draftThread({ versions: [v1], current: "v1", reports: [] }),
    workers: [],
    posts: [],
    post: () => ({ status: 502, json: { error: "model returned prose\nraw reply: hello" } }),
  }
  const agui = await stub(page, s)
  await page.goto(`${PAGE}?proto=2`)
  await openRing(page)
  await page.getByRole("menuitem", { name: "Enhance" }).click()
  const line = node(page).getByText("model returned prose", { exact: true })
  await expect(line).toBeVisible()
  await expect(line).toHaveAttribute("title", "model returned prose\nraw reply: hello")
  await expect(node(page).getByText("raw reply: hello")).toHaveCount(0)
  await expect(page.locator(".p2-err-full")).toHaveText("model returned prose\nraw reply: hello")
  await expect(page.locator(".p2-cand")).toHaveCount(0)
  expect(agui).toEqual([])
})

test("draft: ✕ deletes the draft after confirm, shows a failure, and does not open the ring", async ({ page }) => {
  const s: Stub = {
    thread: draftThread({ versions: [v1], current: "v1", reports: [] }),
    workers: [],
    posts: [],
    post: () => ({ status: 500, json: { error: "unexpected" } }),
  }
  const agui = await stub(page, s)
  const deletes: string[] = []
  // Registered after stub(), so it runs first. The first DELETE fails, the second succeeds.
  await page.route("**/api/drafts/*", async (route) => {
    const req = route.request()
    if (req.method() !== "DELETE") return route.fallback()
    deletes.push(new URL(req.url()).pathname)
    if (deletes.length === 1) return route.fulfill({ status: 409, json: { error: "worktree is busy" } })
    s.thread = null
    return route.fulfill({ status: 204 })
  })
  page.on("dialog", (d) => void d.accept())
  await page.goto(`${PAGE}?proto=2`)
  const del = node(page).getByRole("button", { name: "Delete draft Add retries" })

  await del.click()
  await expect(node(page).getByText("Delete failed: worktree is busy")).toBeVisible()
  await expect(page.getByRole("menu")).toHaveCount(0)

  await del.click()
  await expect(node(page)).toHaveCount(0)
  expect(deletes).toEqual([`/api/drafts/${ID}`, `/api/drafts/${ID}`])
  expect(s.posts).toEqual([])
  expect(agui).toEqual([])
})

// The deleted CopilotKit picker hid unstarted drafts. The Foldkit thread list does not filter them yet.
test.fixme("draft: the thread picker hides an unstarted draft", async ({ page }) => {
  const s: Stub = { thread: draftThread({ versions: [v1], current: "v1", reports: [] }), workers: [], posts: [], post: () => ({ status: 500, json: { error: "unexpected" } }) }
  const agui = await stub(page, s)
  await page.goto(`${PAGE}?proto=0`)
  const picker = page.locator(".ck-threads select")
  await expect(picker.locator("option", { hasText: "General" })).toHaveCount(1)
  await expect(picker.locator("option", { hasText: "Add retries" })).toHaveCount(0)
  expect(agui).toEqual([])
})

test("draft: a finished report opens from the draft card; a running one says so", async ({ page }) => {
  const s: Stub = {
    thread: draftThread({ versions: [v1, v2], current: "v2", reports: [council] }),
    workers: [worker("w-council", "running")],
    posts: [],
    post: () => ({ status: 500, json: { error: "unexpected" } }),
  }
  const agui = await stub(page, s)
  await page.goto(`${PAGE}?proto=2`)
  await expect(node(page).getByText("Council · running…")).toBeVisible()
  s.workers = [worker("w-council", "idle")]
  await page.reload()
  const chip = node(page).getByRole("button", { name: "📄 Council · v2" })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByRole("dialog", { name: "Report reports/draft-council.md" })).toContainText("Use bounded retries.")
  await expect(page.getByRole("menu")).toHaveCount(0)
  expect(agui).toEqual([])
})
