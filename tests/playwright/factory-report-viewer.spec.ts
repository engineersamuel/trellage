import { expect, test } from "@playwright/test"
import "../bun-runtime.setup.ts"

// Runs against the CopilotKit UI (PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173). The coordinator API is stubbed.
test.use({ channel: "chrome" })

const report = {
  threadId: "84574dec-0000",
  folderId: "copilot-proxy-rs",
  title: "Look for optimizations",
  path: "reports/synthesis.md",
  file: "/wt/copilot-proxy-rs/84574dec/reports/synthesis.md",
  content: `# Optimization synthesis: top 3

Uses Arc<Vec<Value>> today.

## 1. Make SSE line framing byte-safe

Body one with \`src/http/sse.rs:76\`.

## 2. Route chat by resolved model

Body two.

## Evidence limits

| Check | Done |
| --- | --- |
| Benchmarks | no |
`,
}

test("report paths open a modal with Full, Source and HTML views, and a finding starts a conversation", async ({ page, context }) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.route("**/api/threads/get", (route) =>
    route.fulfill({ json: { threads: [{ id: "general-1", title: "General", folderId: "general" }], folders: [] } }),
  )
  await page.route("**/api/threads/get/general-1", (route) =>
    route.fulfill({ json: [{ id: "m1", role: "assistant", content: "Top 3 are in `reports/synthesis.md`." }] }),
  )
  await page.route("**/api/approvals", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/reports?*", (route) => route.fulfill({ json: report }))
  let started: any = null
  await page.route("**/api/reports/start", async (route) => {
    started = route.request().postDataJSON()
    await route.fulfill({ json: { threadId: "new-1", folder: "copilot-proxy-rs", worktree: "/wt/new", branch: "factory/copilot-proxy-rs-new1" } })
  })

  await page.goto("/?thread=general-1&proto=0")
  const link = page.locator("code.sf-report-link", { hasText: "reports/synthesis.md" }).first()
  await expect(link).toBeVisible()
  await link.click()

  const modal = page.getByRole("dialog", { name: "Report synthesis.md" })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole("heading", { name: /1\. Make SSE line framing byte-safe/ })).toBeVisible()
  await expect(modal.locator("table")).toContainText("Benchmarks")
  await expect(modal.getByText("Arc<Vec<Value>>")).toBeVisible()
  await expect(modal.getByRole("button", { name: /^Start in Factory: finding/ })).toHaveCount(2)

  // Findings are cards in every view (the React page had a separate "Open as MDX" tab for that).
  await expect(modal.locator(".rv-finding")).toHaveCount(2)
  await expect(modal.locator(".rv-finding").first()).toContainText("Body one")

  const popup = context.waitForEvent("page")
  await modal.getByRole("button", { name: "Open as HTML ↗" }).click()
  const html = await popup
  await expect(html.locator("h2").first()).toHaveText("1. Make SSE line framing byte-safe")
  await expect(html.locator("table")).toContainText("Benchmarks")
  await html.close()

  await modal.getByRole("button", { name: "Start in Factory: finding 2" }).click()
  await expect(modal.getByText("Started in Factory · factory/copilot-proxy-rs-new1")).toBeVisible()
  expect(started).toEqual({ path: "reports/synthesis.md", thread: "84574dec-0000", title: "2. Route chat by resolved model", body: "Body two." })

  await page.keyboard.press("Escape")
  await expect(modal).toHaveCount(0)
  expect(errors).toEqual([])
})

test("a synthesis with a brief opens on the Brief tab, and Start sends the full finding", async ({ page }) => {
  const brief = { ...report, path: "reports/synthesis.brief.md", content: "**TL;DR:** two fixes.\n\n## 1. Make SSE line framing byte-safe\n**TL;DR:** decode bytes once.\n- ✅ **Split UTF-8:** `sse.rs:93`\n🔴 **Risk (low):** limit rejects long lines\n\n## 2. Route chat by resolved model\n**TL;DR:** use the resolved id.\n" }
  await page.route("**/api/threads/get", (route) => route.fulfill({ json: { threads: [{ id: "general-1", title: "General", folderId: "general" }], folders: [] } }))
  await page.route("**/api/threads/get/general-1", (route) => route.fulfill({ json: [{ id: "m1", role: "assistant", content: "Top 3 are in `reports/synthesis.md`." }] }))
  await page.route("**/api/approvals", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/reports?*", (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get("path")!.endsWith(".brief.md") ? brief : report }))
  let started: any = null
  await page.route("**/api/reports/start", async (route) => {
    started = route.request().postDataJSON()
    await route.fulfill({ json: { threadId: "new-1", branch: "factory/x" } })
  })
  await page.goto("/?thread=general-1&proto=0")
  await page.locator("code.sf-report-link", { hasText: "reports/synthesis.md" }).first().click()
  const modal = page.getByRole("dialog", { name: "Report synthesis.md" })
  await expect(modal.getByRole("tab", { name: "Brief" })).toHaveAttribute("aria-selected", "true")
  await expect(modal.getByText("decode bytes once.")).toBeVisible()
  await modal.getByRole("button", { name: "Start in Factory: finding 2" }).click()
  await expect.poll(() => started).toEqual({ path: "reports/synthesis.md", thread: "84574dec-0000", title: "2. Route chat by resolved model", body: "Body two." })
  await modal.getByRole("tab", { name: "Full" }).click()
  await expect(modal.getByText("Body one with")).toBeVisible()
})
