import assert from "node:assert/strict"
import test from "node:test"

import {
  stringWidth,
  truncateToWidth,
  wrapText,
} from "../lib/terminal-text.mjs"

test("measures, truncates, and wraps wide terminal text", () => {
  assert.equal(stringWidth("a界b"), 4)
  assert.equal(truncateToWidth("a界b", 3), "a界")
  assert.deepEqual(wrapText("a界b", 3), ["a界", "b"])
})

test("preserves explicit lines and expands tabs in previews", () => {
  assert.deepEqual(wrapText("a\tb\n", 5), ["a    ", "b", ""])
})
