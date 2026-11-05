import { expect, test } from "bun:test"
import { defaultSettings, patched } from "../src/settings.ts"

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
