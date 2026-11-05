import { expect, test } from "@playwright/test"
import "../bun-runtime.setup.ts"

test.use({ channel: "chrome" })

/** Page under test: FACTORY_PAGE, else the path of PLAYWRIGHT_BASE_URL, else "/". */
const PAGE = process.env.FACTORY_PAGE ?? (process.env.PLAYWRIGHT_BASE_URL ? new URL(process.env.PLAYWRIGHT_BASE_URL).pathname : "/")

for (const proto of [0, 2]) {
  test(`layout ${proto}: thread links load history, survive reload, and follow browser history`, async ({ page }) => {
    await page.route("**/api/threads/**", async (route) => {
      const path = new URL(route.request().url()).pathname
      await route.fulfill({
        json:
          path === "/api/threads/get"
            ? {
                threads: ["first", "second"].map((id) => ({ id, title: `${id} conversation`, folderId: "repo" })),
                folders: [{ id: "repo", name: "Repository", path: "/repo" }],
              }
            : [{ id: path, role: "user", content: `Saved message for ${path.split("/").pop()}` }],
      })
    })
    await page.route("**/api/approvals", (route) => route.fulfill({ json: [] }))
    await page.route("**/api/agui**", () => {
      throw new Error("Opening a link must not start an agent")
    })

    // Keep the page of the base URL (the React UI lives at /copilotkit.html, Foldkit at /).
    await page.goto(`${PAGE}?thread=first&proto=${proto}`)
    await expect(page.getByText("Saved message for first", { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText("Saved message for first", { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.cookie)).toContain("sf_folder=repo")
    await page.locator(".sff-toggle").click()
    const second = page.getByRole("link", { name: "second conversation" })
    await expect(second).toHaveAttribute("href", /thread=second/)
    await second.click()
    await expect(page).toHaveURL(/thread=second/)
    await expect(page.getByText("Saved message for second", { exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.getByText("Saved message for first", { exact: true })).toBeVisible()
    await page.goForward()
    await expect(page.getByText("Saved message for second", { exact: true })).toBeVisible()
    await page.locator(".sff-add").click()
    await expect(page).not.toHaveURL(/thread=/)
    await expect(page.getByText("Saved message for second", { exact: true })).not.toBeVisible()
  })
}
