import { expect, test } from "@playwright/test"

// Foldkit slow-phase warnings on a 4x slower CPU. Startup is listed for the record. After startup,
// two window resizes and 120 keystrokes must stay inside the budgets. A resize relayouts the whole chat
// once, so each may spike once; typing may spike once (garbage collection, a busy machine). Slow code
// shows on every keystroke, not once.
const MAX_SPIKES_PER_RESIZE = 1
const MAX_TYPING_SPIKES = 1
const URL = process.env.FOLDKIT_URL ?? "http://localhost:5174/"

test("foldkit: no slow-phase warnings after startup, on a 4x slower CPU", async ({ page }) => {
  const warnings: string[] = []
  page.on("console", async (m) => {
    if (m.type() !== "warning" || !m.text().includes("[foldkit] Slow")) return
    // Name the child Message inside a Got* wrapper, so a failure points at the real trigger.
    const inner = await Promise.all(
      m.args().map((arg) =>
        arg
          .evaluate((value: unknown) => {
            type Tagged = { message?: { ["_tag"]?: string; value?: { message?: { ["_tag"]?: string } } } }
            const v = value as Tagged | null
            return v?.message?.["_tag"] ?? v?.message?.value?.message?.["_tag"] ?? ""
          })
          .catch(() => ""),
      ),
    )
    warnings.push(`${m.text().replace(/\. (Key|Inspect|Keep).*/s, "")} (${inner.filter(Boolean).join(", ")})`)
  })
  // The OpenUI devtools widget (dev only, from a CDN) is not part of the app.
  await page.route("**/cdn.jsdelivr.net/**", (route) => route.abort())
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.goto(URL)
  await page.getByRole("heading", { level: 1, name: "Factory · Foldkit" }).waitFor({ timeout: 60_000 })
  // Start an empty chat, as the old Classic layout showed: the Inbox opens a stored conversation, whose history makes
  // every keystroke cost more (a separate issue).
  await page.getByRole("button", { name: "＋ New General chat" }).click()
  await page.waitForTimeout(3_000)
  const startup = [...warnings]
  warnings.length = 0

  const widths = [1000, 1280]
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 })
    await page.waitForTimeout(400)
  }
  const resizing = [...warnings]
  warnings.length = 0
  const composer = page.getByPlaceholder("Type a new request here…")
  await composer.click()
  await composer.pressSequentially("x".repeat(120), { delay: 30 })
  await composer.fill("")
  await page.waitForTimeout(800)

  console.log(`startup warnings:\n${startup.join("\n") || "(none)"}`)
  console.log(`resizing:\n${resizing.join("\n") || "(none)"}`)
  console.log(`typing:\n${warnings.join("\n") || "(none)"}`)
  expect(resizing.length, resizing.join("\n")).toBeLessThanOrEqual(MAX_SPIKES_PER_RESIZE * widths.length)
  expect(warnings.length, warnings.join("\n")).toBeLessThanOrEqual(MAX_TYPING_SPIKES)
})
