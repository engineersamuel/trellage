import { expect, test, type Page } from "@playwright/test"
import "../bun-runtime.setup.ts"

// Inbox (Foldkit at /): "+ Draft" and the draft detail (actions, rewrites, versions, reports). Every /api/** call is stubbed.
test.use({ channel: "chrome" })

/** Page under test: FACTORY_PAGE, else the path of PLAYWRIGHT_BASE_URL, else "/". */
const PAGE =
  process.env.FACTORY_PAGE ??
  (process.env.PLAYWRIGHT_BASE_URL ? new URL(process.env.PLAYWRIGHT_BASE_URL).pathname : "/")

const ID = "d1a2b3c4-5e6f-4000-8000-000000000001"
const v1 = { id: "v1", prompt: "Add retries to the fetch client", source: "human", at: 1 }
const v2 = {
  id: "v2",
  prompt: "Add bounded retries with backoff\nto the fetch client",
  source: "enhance",
  title: "Bounded",
  notes: "Adds a limit",
  at: 2,
}
/** A draft as the stub returns it. */
type DraftDoc = { versions: object[]; current: string; reports: object[]; pending?: object; startedAt?: number }
const candidates = [
  { title: "Minimal", prompt: "Retry fetch once", notes: "Smallest change" },
  { title: "Bounded", prompt: v2.prompt, notes: "Adds a limit" },
  { title: "Full", prompt: "Retry with jitter and metrics", notes: "Most work" },
]
const council = { action: "council", workerId: "w-council", path: "reports/draft-council.md", versionId: "v2" }
const draftThread = (draft: object) => ({
  id: ID,
  title: "Add retries",
  createdAt: 1,
  folderId: "repo",
  worktree: "/wt/d1a2b3c4",
  branch: "sf/d1a2b3c4",
  draft,
})
/** A General chat beside the draft, as in a real factory. */
const general = { id: "g1", title: "General", createdAt: 0, folderId: "general" }
const worker = (id: string, status: string) => ({
  id,
  name: "council",
  role: "worker",
  status,
  model: "m",
  auth: "a",
  pid: null,
  rssKb: null,
  task: null,
  lastMessage: null,
  owner: "draft-d1a2b3c4",
  contextTokens: null,
  contextLimit: null,
})

/** A minimal settings document (GET /api/settings), as the coordinator sends it. */
const SETTINGS = {
  settings: {
    theme: "default",
    themes: {
      default: {
        bg: "#0a0a0a",
        surface: "#171717",
        border: "#262626",
        text: "#e5e5e5",
        muted: "#a3a3a3",
        accent: "#6366f1",
      },
    },
    navbar: ["status", "workers", "model", "context"],
    animations: true,
    hotkeys: { ",": "toggleSettings", t: "cycleTheme", ".": "focusCoordinator" },
    focus: "coordinator",
    banner: null,
    agent: { model: "m", reasoningEffort: "default", disabledTools: [], instructions: "" },
    crons: {},
    extensions: {},
    repo: "",
    supervisor: { enabled: true, everySeconds: 60, stallSeconds: 300, offTrackCheck: true },
  },
  css: "",
  run: null,
  options: {
    navbarItems: ["status", "workers", "model", "context", "auth", "crons", "repo"],
    hotkeyActions: ["toggleSettings", "cycleTheme", "focusCoordinator", "abortCoordinator"],
    efforts: ["default", "low", "medium", "high", "xhigh"],
    toolKinds: ["shell", "write", "read", "url", "mcp"],
    slots: ["chat-background", "page-background", "navbar", "banner", "panel-top", "overlay"],
    models: [],
  },
}

type Stub = {
  thread: object | null
  workers: object[]
  posts: { path: string; body: unknown }[]
  /** Answer of a POST /api/drafts... call; returns the new draft, or a status + body. */
  post: (
    path: string,
    body: { index: number } | undefined,
  ) => { draft?: object; thread?: object; status?: number; json?: object }
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
    if (path === "/api/feed")
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 100\n\n" })
    if (path === "/api/threads/get")
      return route.fulfill({
        json: {
          threads: [general, ...(s.thread ? [s.thread] : [])],
          folders: [
            { id: "general", name: "General", path: "" },
            { id: "repo", name: "repo", path: "/repo" },
          ],
        },
      })
    if (path === "/api/workers") return route.fulfill({ json: s.workers })
    if (path === "/api/approvals") return route.fulfill({ json: [] })
    if (path === "/api/steps") return route.fulfill({ json: { securityReviews: [] } })
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
      return route.fulfill({
        json: {
          threadId: ID,
          folderId: "repo",
          title: "Add retries",
          path: url.searchParams.get("path"),
          file: "/wt/x",
          content: "# Council verdict\n\nUse bounded retries.",
        },
      })
    if (path === "/api/events" || path.startsWith("/api/threads/get/")) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  return agui
}

/** The draft's row in the inbox list. */
const row = (page: Page) => page.getByTestId("inbox-item").filter({ hasText: "📄 Draft" })
/** Header actions of the shown draft. */
const action = (page: Page, name: string) =>
  page.locator(".p3-head .p3-acts").getByRole("button", { name, exact: true })
const openDraft = async (page: Page) => {
  await row(page).click()
  // A row with a running draft worker opens that worker; the draft is the root card of the tree.
  await page.getByTestId("tree-draft").click()
  await expect(action(page, "▶ Run")).toBeVisible()
}

test("draft: create, enhance, pick, council, run", async ({ page }) => {
  let draft: DraftDoc = { versions: [v1], current: "v1", reports: [] }
  const s: Stub = {
    thread: null,
    workers: [],
    posts: [],
    post: (path, body) => {
      if (path === "/api/drafts") return { thread: draftThread(draft) }
      if (path.endsWith("/enhance"))
        return { draft: (draft = { ...draft, pending: { kind: "enhance", candidates, at: 3 } }) }
      if (path.endsWith("/pick")) {
        const { pending: _, ...rest } = draft
        return {
          draft: (draft = {
            ...rest,
            versions: [v1, { ...v2, prompt: candidates[body!.index]!.prompt }],
            current: "v2",
          }),
        }
      }
      if (path.endsWith("/council")) return { draft: (draft = { ...draft, reports: [council] }) }
      if (path.endsWith("/run")) return { draft: (draft = { ...draft, startedAt: 9 }) }
      return { status: 404, json: { error: "no route" } }
    },
  }
  const agui = await stub(page, s)
  await page.goto(PAGE)

  await page.getByTestId("new-draft").click()
  await page.getByLabel("Draft prompt").fill(v1.prompt)
  await page.getByRole("button", { name: "Create" }).click()
  // The new draft opens at once.
  await expect(action(page, "▶ Run")).toBeVisible()
  await expect(row(page)).toContainText("repo")
  await expect(page.locator(".p3-ver")).toHaveCount(1)

  await expect(page.locator(".p3-head .p3-acts button")).toHaveText([
    "✨ Enhance",
    "🏛 Council",
    "⚖ Debate",
    "🔎 Research",
    "📚 Hyperresearch",
    "▶ Run",
    "✕ Delete",
  ])
  await action(page, "✨ Enhance").click()
  const cards = page.locator(".p3-cand")
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(1)).toContainText("Bounded")
  await expect(cards.nth(1)).toContainText("Adds a limit")
  await cards.nth(1).getByRole("button", { name: "Pick" }).click()
  expect(s.posts.find((p) => p.path.endsWith("/pick"))?.body).toEqual({ index: 1 })
  // Version list: newest first, with a line diff to the previous version.
  const versions = page.locator(".p3-ver")
  await expect(versions).toHaveCount(2)
  await expect(versions.first()).toContainText("v2")
  await expect(versions.first().locator(".p3-diff .del")).toHaveText(["- Add retries to the fetch client"])
  await expect(versions.first().locator(".p3-diff .add")).toHaveText([
    "+ Add bounded retries with backoff",
    "+ to the fetch client",
  ])
  await expect(cards).toHaveCount(0)

  await action(page, "🏛 Council").click()
  // No worker is listed as running, so the report counts as finished and opens from the detail.
  await expect(page.getByRole("button", { name: "📄 Council · v2" })).toBeVisible()
  expect(s.posts.filter((p) => p.path === `/api/drafts/${ID}/council`)).toHaveLength(1)

  await action(page, "▶ Run").click()
  await expect(row(page)).toHaveCount(0)
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
  await page.goto(PAGE)
  await openDraft(page)
  const run = action(page, "▶ Run")
  await expect(run).toBeDisabled()
  await expect(run).toHaveAttribute("title", "Council is running")
  await expect(action(page, "🏛 Council")).toBeDisabled()
  await expect(action(page, "⚖ Debate")).toBeEnabled()
  expect(s.posts).toEqual([])
  expect(agui).toEqual([])
})

test("draft: pending rewrites block Research until Keep current dismisses them", async ({ page }) => {
  let draft: DraftDoc = { versions: [v1], current: "v1", reports: [], pending: { kind: "enhance", candidates, at: 3 } }
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
  await page.goto(PAGE)
  await openDraft(page)
  for (const name of ["🏛 Council", "⚖ Debate", "🔎 Research", "📚 Hyperresearch", "▶ Run"]) {
    const b = action(page, name)
    await expect(b).toBeDisabled()
    await expect(b).toHaveAttribute("title", "Pick a rewrite first")
  }
  await expect(action(page, "✨ Enhance")).toBeEnabled()
  await expect(page.locator(".p3-cand")).toHaveCount(3)
  await page.getByRole("button", { name: "Keep current" }).click()
  await expect(page.locator(".p3-cand")).toHaveCount(0)
  expect(s.posts).toEqual([{ path: `/api/drafts/${ID}/dismiss`, body: undefined }])
  await expect(action(page, "🔎 Research")).toBeEnabled()
  expect(agui).toEqual([])
})

test("draft: an enhance error shows its full text in the detail", async ({ page }) => {
  const s: Stub = {
    thread: draftThread({ versions: [v1], current: "v1", reports: [] }),
    workers: [],
    posts: [],
    post: () => ({ status: 502, json: { error: "model returned prose\nraw reply: hello" } }),
  }
  const agui = await stub(page, s)
  await page.goto(PAGE)
  await openDraft(page)
  await action(page, "✨ Enhance").click()
  await expect(page.locator(".p3-draft-err")).toHaveText("model returned prose\nraw reply: hello")
  await expect(page.locator(".p3-cand")).toHaveCount(0)
  expect(agui).toEqual([])
})

test("draft: ✕ Delete removes the draft after confirm, and shows a failure", async ({ page }) => {
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
  await page.goto(PAGE)
  await openDraft(page)

  await action(page, "✕ Delete").click()
  await expect(page.getByText("Delete failed: worktree is busy")).toBeVisible()

  await action(page, "✕ Delete").click()
  await expect(row(page)).toHaveCount(0)
  expect(deletes).toEqual([`/api/drafts/${ID}`, `/api/drafts/${ID}`])
  expect(s.posts).toEqual([])
  expect(agui).toEqual([])
})

test("draft: a finished report opens from the detail; a running one says so", async ({ page }) => {
  const s: Stub = {
    thread: draftThread({ versions: [v1, v2], current: "v2", reports: [council] }),
    workers: [worker("w-council", "running")],
    posts: [],
    post: () => ({ status: 500, json: { error: "unexpected" } }),
  }
  const agui = await stub(page, s)
  await page.goto(PAGE)
  await openDraft(page)
  await expect(page.getByText("Council · v2 · running…")).toBeVisible()
  s.workers = [worker("w-council", "idle")]
  await page.reload()
  await openDraft(page)
  const chip = page.getByRole("button", { name: "📄 Council · v2" })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByRole("dialog", { name: "Report reports/draft-council.md" })).toContainText(
    "Use bounded retries.",
  )
  expect(agui).toEqual([])
})
