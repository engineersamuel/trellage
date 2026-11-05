import { expect, test } from "bun:test"
import { HARNESS } from "../../shared/harness.ts"

test("each factory harness has a labeled SVG icon", () => {
  expect(Object.keys(HARNESS).sort()).toEqual(["claude", "copilot", "pi"])
  for (const h of Object.values(HARNESS)) {
    expect(h.svg).toStartWith("<svg viewBox=")
    expect(h.svg).toContain('aria-hidden="true"')
    expect(h.svg).toMatch(/<path [^>]*d="[Mm]/)
    expect(h.label.length).toBeGreaterThan(3)
  }
})
