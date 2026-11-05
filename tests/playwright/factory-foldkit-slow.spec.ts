import { expect, test } from "@playwright/test"

// Foldkit slow-phase warnings on a 4x slower CPU. Startup is listed for the record. After startup,
// 120 keystrokes and two window resizes must stay inside the budgets. One isolated spike (garbage
// collection, a busy test machine) is tolerated; slow code shows on every keystroke, not once.
const MAX_ISOLATED_SPIKES = 1
const URL = process.env.FOLDKIT_URL ?? "http://localhost:5174/?proto=0"

test("foldkit: no slow-phase warnings after startup, on a 4x slower CPU", async ({ page }) => {
  const warnings: string[] = []
  page.on("console", async (m) => {
    if (m.type() !== "warning" || !m.text().includes("[foldkit] Slow")) return
    // Name the child Message inside a Got* wrapper, so a failure points at the real trigger.
    const inner = await Promise.all(m.args().map((arg) => arg.evaluate((value: any) => value?.message?._tag ?? value?.message?.value?.message?._tag ?? "").catch(() => "")))
    warnings.push(`${m.text().replace(/\. (Key|Inspect|Keep).*/s, "")} (${inner.filter(Boolean).join(", ")})`)
  })
  // The OpenUI devtools widget (dev only, from a CDN) is not part of the app.
  await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort())
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.goto(URL)
  await page.getByRole("heading", { level: 1, name: "Factory · Foldkit" }).waitFor({ timeout: 60_000 })
  await page.waitForTimeout(3_000)
  const startup = [...warnings]
  warnings.length = 0

  for (const width of [1000, 1280]) {
    await page.setViewportSize({ width, height: 720 })
    await page.waitForTimeout(400)
  }
  const composer = page.getByPlaceholder(/Ask the coordinator/)
  await composer.click()
  await composer.pressSequentially("x".repeat(120), { delay: 30 })
  await composer.fill("")
  await page.waitForTimeout(800)

  console.log(`startup warnings:\n${startup.join("\n") || "(none)"}`)
  console.log(`after startup:\n${warnings.join("\n") || "(none)"}`)
  expect(warnings.length, warnings.join("\n")).toBeLessThanOrEqual(MAX_ISOLATED_SPIKES)
})
