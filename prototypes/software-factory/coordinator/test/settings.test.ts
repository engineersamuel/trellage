import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { css, defaultSettings, loadSettings, patched } from "../src/settings.ts"

test("patch merges and validates", () => {
  const s = defaultSettings()
  const n = patched(s, { theme: "nord", agent: { reasoningEffort: "low" } })
  expect(n.theme).toBe("nord")
  expect(n.agent.reasoningEffort).toBe("low")
  expect(n.agent.model).toBe(s.agent.model)
  expect(() => patched(s, { layout: { panel: "left" } })).toThrow()
  expect(() => patched(s, { theme: "nope" })).toThrow()
  expect(() => patched(s, { navbar: ["bogus"] })).toThrow()
  expect(() => patched(s, { colour: 1 })).toThrow()
})

test("null removes map entries but clears banner", () => {
  const s = patched(defaultSettings(), { banner: "hi", crons: { a: { everySeconds: 60, prompt: "x" } } })
  expect(s.crons.a?.enabled).toBe(true)
  const n = patched(s, { banner: null, crons: { a: null } })
  expect(n.banner).toBeNull()
  expect(n.crons).toEqual({})
  expect(() => patched(s, { crons: { b: { everySeconds: 5, prompt: "x" } } })).toThrow()
})

test("extensions validate slot", () => {
  const s = defaultSettings()
  const ok = patched(s, { extensions: { rain: { slot: "chat-background", js: "return () => {}" } } })
  expect(ok.extensions.rain?.enabled).toBe(true)
  expect(() => patched(s, { extensions: { x: { slot: "nowhere", js: "" } } })).toThrow()
  const off = patched(ok, { extensions: { rain: { enabled: false } } })
  expect(off.extensions.rain?.enabled).toBe(false)
  expect(patched(off, { extensions: { rain: null } }).extensions).toEqual({})
})

test("diffStyle defaults to terminal, takes the four styles, rejects others", () => {
  const s = defaultSettings()
  expect(s.diffStyle).toBe("terminal")
  expect(patched(s, { diffStyle: "split" }).diffStyle).toBe("split")
  expect(() => patched(s, { diffStyle: "fancy" })).toThrow()
  const { diffStyle: _, ...old } = s
  expect(patched(old as never, {}).diffStyle).toBe("terminal")
})

test("the theme recolors OpenUI cards outside the chat too", () => {
  const s = patched(defaultSettings(), {
    theme: "t",
    themes: {
      t: { bg: "#000001", surface: "#000002", border: "#000003", text: "#000004", muted: "#000005", accent: "#000006" },
    },
  })
  expect(css(s)).toMatch(
    /\.openui-genui-card[^{]*\{--openui-background:#000001!important;[^}]*--openui-text-neutral-primary:#000004!important/,
  )
  expect(css(s)).not.toContain("copilotkit")
})

test("a stored file from the retired layouts still loads, without the retired keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-settings-"))
  const file = path.join(dir, "settings.json")
  writeFileSync(
    file,
    JSON.stringify({
      theme: "nord",
      layout: { panel: "left", panelWidth: 30 },
      critters: true,
      canvasCritters: true,
      hotkeys: { p: "togglePanel", t: "cycleTheme" },
    }),
  )
  const s = loadSettings(file)
  expect(s.theme).toBe("nord")
  expect(s.hotkeys).toEqual({ ",": "toggleSettings", t: "cycleTheme", ".": "focusCoordinator" })
  expect("layout" in s).toBe(false)
  expect(patched(s, { banner: "ok" }).banner).toBe("ok")
})
