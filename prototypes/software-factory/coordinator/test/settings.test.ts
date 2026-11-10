import { expect, test } from "bun:test"
import { css, defaultSettings, patched } from "../src/settings.ts"

test("patch merges and validates", () => {
  const s = defaultSettings()
  const n = patched(s, { theme: "nord", layout: { panel: "left" } })
  expect(n.theme).toBe("nord")
  expect(n.layout.panel).toBe("left")
  expect(n.layout.panelWidth).toBe(45)
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
  const s = patched(defaultSettings(), { theme: "t", themes: { t: { bg: "#000001", surface: "#000002", border: "#000003", text: "#000004", muted: "#000005", accent: "#000006" } } })
  expect(css(s)).toMatch(/\.openui-genui-card[^{]*\{--openui-background:#000001!important;[^}]*--openui-text-neutral-primary:#000004!important/)
  expect(css(s)).not.toContain("copilotkit")
})
