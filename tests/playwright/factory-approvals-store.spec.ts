import { expect, test } from "@playwright/test"
import "../bun-runtime.setup.ts"

// Approval state lives in one Effect store (shared/approvals.ts). These checks drive the decision center,
// the conversation sidebar and the Foldkit navbar from that one store. /api/approvals is mocked, so no
// real decision is created or answered.

test.use({ channel: "chrome" })

type Row = Record<string, unknown>
const waiting: Row = {
  id: "d1",
  kind: "approval",
  threadId: "first",
  title: "Approve the demo plan",
  summary: "- **Goal:** test the store",
  options: ["Approve", "Reject"],
  optionDetails: [],
  allowText: false,
  context: "test",
  status: "pending",
  answer: null,
  note: null,
  createdAt: Date.now() - 5 * 60_000,
}
/** An older stored row without kind, context, allowText or optionDetails: the Schema must default them. */
const legacy: Row = { id: "old", title: "Old answered", summary: "", options: ["Approve"], status: "answered", answer: "Approve", note: null, createdAt: 1, threadId: null }

for (const app of [
  { name: "foldkit", url: process.env.FOLDKIT_URL ?? "http://localhost:5174/" },
]) {
  test(`${app.name}: approvals come from the shared Effect store`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    let rows: Row[] = [waiting, legacy]
    const posted: unknown[] = []
    await page.route("**/api/approvals", (route) => route.fulfill({ json: rows }))
    await page.route("**/api/approvals/d1", async (route) => {
      if (route.request().method() === "POST") {
        posted.push(route.request().postDataJSON())
        rows = [{ ...waiting, status: "answered", answer: "Approve" }, legacy]
        return route.fulfill({ json: rows[0] })
      }
      return route.fulfill({ json: { ...rows[0], threadTitle: "first conversation" } })
    })

    await page.goto(app.url)
    const pill = page.locator(".sfd-pill")
    await expect(pill).toContainText("1 decision waiting")
    await expect(page).toHaveTitle(/^\(1\) Decision needed/)
    if (app.name === "foldkit") await expect(page.locator(".fk-approvals")).toHaveText("⚑ 1 waiting")

    await pill.locator(".sfd-pill-main").click()
    const card = page.locator(".sfd-card")
    await expect(card.locator(".sfd-title")).toHaveText("Approve the demo plan")
    await card.getByRole("button", { name: /Approve/ }).first().click()
    await expect(card).toContainText("Sent. The coordinator continues.")
    expect(posted).toEqual([{ answer: "Approve", note: null }])
    // The store drops the decision at once, before any feed event.
    await expect(pill).toBeHidden()
    if (app.name === "foldkit") await expect(page.locator(".fk-approvals")).toHaveCount(0)

    // The inbox lists the legacy row, decoded with defaults.
    await page.evaluate(() => (location.hash = "decisions"))
    await expect(page.locator(".sfd-inbox")).toContainText("Old answered")
    await expect(page.locator(".sfd-inbox")).toContainText("coordinator")
    expect(errors).toEqual([])
  })
}

// A wrong payload from one endpoint must not break the Foldkit app: the Command fails as a typed error
// and the app keeps working (before the fix, decodeUnknownSync threw a defect inside the Effect).
test("foldkit: a malformed /api/workers payload does not break the app", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.route("**/api/workers", (route) => route.fulfill({ json: [{ id: 42 }] }))
  await page.route("**/api/approvals", (route) => route.fulfill({ json: [waiting] }))
  await page.goto(process.env.FOLDKIT_URL ?? "http://localhost:5174/")
  await expect(page.locator(".fk-approvals")).toHaveText("⚑ 1 waiting")
  await page.waitForTimeout(500)
  expect(errors).toEqual([])
})
