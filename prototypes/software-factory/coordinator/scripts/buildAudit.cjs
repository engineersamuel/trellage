// Objective audit of one tournament build (runs under Node with the Playwright library; the coordinator calls it).
// Usage: node buildAudit.cjs <playwright module dir> <axe.min.js> <base url of the build> <pages JSON> <shots JSON>
// Writes one JSON object to stdout:
//   pages[page] = { axe: {critical, serious, moderate, minor, rules[]}, errors, overflow320, interactive: {n, hover, press, focus} }
//   shots: [{ page, size, file }] taken after the page settled (network idle, fonts, animations finished, scrolled once)
const { chromium } = require(process.argv[2])
const fs = require("node:fs")
const axeSource = fs.readFileSync(process.argv[3], "utf8")
const base = process.argv[4]
const pages = JSON.parse(process.argv[5])
const shots = JSON.parse(process.argv[6]) // [{page, size:[w,h], full, file}]

/** Wait until the page is settled: network idle, fonts, running CSS/Web animations done (capped). */
const settle = async (p) => {
  await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {})
  await p.evaluate(async () => {
    await document.fonts.ready
    // Reveal-on-scroll content: scroll through once, then back to the top.
    for (let y = 0; y < document.body.scrollHeight; y += innerHeight * 0.8) {
      scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 60))
    }
    scrollTo(0, 0)
    const deadline = Date.now() + 4000
    while (
      Date.now() < deadline &&
      document.getAnimations().some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity)
    )
      await new Promise((r) => setTimeout(r, 100))
  })
  await p.waitForTimeout(300)
}

/**
 * Does hovering, pressing or keyboard-focusing each of the first visible interactive elements visibly change it?
 * Style is read after its transitions end (up to 600 ms). An element that is hidden or off the page is skipped.
 */
const feedback = async (p) => {
  const pick = await p.$$eval("a[href], button, [role=button], input, select", (els) =>
    els
      .map((e, i) => ({ e, i, r: e.getBoundingClientRect(), s: getComputedStyle(e) }))
      .filter(
        ({ r, s }) =>
          r.width > 8 &&
          r.height > 8 &&
          r.top >= 0 &&
          r.top < 2400 &&
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          +s.opacity > 0.5,
      )
      .slice(0, 8)
      .map(({ i }) => i),
  )
  const all = await p.$$("a[href], button, [role=button], input, select")
  const style = (e) =>
    e.evaluate((x) => {
      const s = getComputedStyle(x)
      return [
        s.backgroundColor,
        s.color,
        s.boxShadow,
        s.transform,
        s.outlineStyle,
        s.outlineWidth,
        s.outlineColor,
        s.borderColor,
        s.textDecorationLine,
        s.opacity,
        s.scale,
        s.translate,
      ].join("|")
    })
  const pause = () => p.waitForTimeout(350)
  let hover = 0,
    press = 0,
    focus = 0,
    n = 0
  for (const i of pick) {
    const e = all[i]
    try {
      await e.scrollIntoViewIfNeeded({ timeout: 2000 })
      await p.mouse.move(1, 1)
      await e.evaluate((x) => x.blur())
      await pause()
      const rest = await style(e)
      const box = await e.boundingBox()
      if (!box) continue
      n++
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await pause()
      const hovered = await style(e)
      if (hovered !== rest) hover++
      await p.mouse.down()
      await p.waitForTimeout(150)
      if ((await style(e)) !== hovered) press++
      // Release away from the element, so a link is not followed.
      await p.mouse.move(1, 1)
      await p.mouse.up()
      await pause()
      // Keyboard focus: focus the element before it, then Tab, so :focus-visible applies.
      await e.evaluate((x) => {
        const f = document.createElement("span")
        f.tabIndex = 0
        f.id = "__audit_focus"
        x.before(f)
        f.focus()
      })
      await p.keyboard.press("Tab")
      await pause()
      if ((await e.evaluate((x) => document.activeElement === x)) && (await style(e)) !== rest) focus++
      await e.evaluate(() => document.getElementById("__audit_focus")?.remove())
      await e.evaluate((x) => x.blur())
    } catch {}
  }
  return { n, hover, press, focus }
}

;(async () => {
  const browser = await chromium.launch()
  const out = { pages: {}, shots: [] }
  for (const page of pages) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const p = await ctx.newPage()
    const errors = []
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 160)))
    p.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)))
    await p.goto(`${base}/${page}`)
    await settle(p)
    await p.addScriptTag({ content: axeSource })
    const axe = await p.evaluate(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      })
      const n = (impact) => r.violations.filter((v) => v.impact === impact).reduce((s, v) => s + v.nodes.length, 0)
      return {
        critical: n("critical"),
        serious: n("serious"),
        moderate: n("moderate"),
        minor: n("minor"),
        rules: r.violations.map((v) => `${v.id}:${v.nodes.length}`),
      }
    })
    const interactive = await feedback(p)
    await p.setViewportSize({ width: 320, height: 800 })
    await p.waitForTimeout(400)
    const overflow320 = await p.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))
    out.pages[page] = { axe, errors: errors.length, errorSample: errors.slice(0, 3), overflow320, interactive }
    await ctx.close()
  }
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: { width: s.size[0], height: s.size[1] } })
    const p = await ctx.newPage()
    await p.goto(`${base}/${s.page}`)
    await settle(p)
    if (!s.full) {
      await p.screenshot({ path: s.file, type: "jpeg", quality: 85 })
      out.shots.push({ page: s.page, size: s.size, file: s.file })
    } else {
      // A whole page as tiles of at most 1500 px (judges and Jev refuse images over ~1568 px a side), at most 3.
      const height = await p.evaluate(() => document.documentElement.scrollHeight)
      const tiles = Math.min(3, Math.ceil(height / 1500))
      for (let k = 0; k < tiles; k++) {
        const file = s.file.replace(/\.jpg$/, `-${k + 1}.jpg`)
        const y = k * 1500
        await p.screenshot({
          path: file,
          type: "jpeg",
          quality: 85,
          fullPage: true,
          clip: { x: 0, y, width: s.size[0], height: Math.min(1500, height - y) },
        })
        out.shots.push({ page: s.page, size: s.size, file })
      }
    }
    await ctx.close()
  }
  await browser.close()
  process.stdout.write(JSON.stringify(out))
})().catch((e) => {
  process.stderr.write(String(e?.stack ?? e))
  process.exit(1)
})
