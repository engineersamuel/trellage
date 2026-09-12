import { describe, expect, it } from "vitest"
import { markdownDiffRows, diffDisplayLines } from "../src/context-menu-diff.ts"

describe("context menu Markdown diff", () => {
  it("aligns changed, added, and removed raw Markdown lines", () => {
    expect(markdownDiffRows("one\ntwo\nthree", "one\nTWO\nthree\nfour")).toEqual([
      { original: "one", rewritten: "one", kind: "same" },
      { original: "two", rewritten: "TWO", kind: "changed" },
      { original: "three", rewritten: "three", kind: "same" },
      { original: "", rewritten: "four", kind: "added" },
    ])
  })

  it("falls back to one bounded replacement row without losing content", () => {
    expect(markdownDiffRows("original", "rewritten", 1)).toEqual([
      { original: "original", rewritten: "rewritten", kind: "changed" },
    ])
  })
})

it("wraps long replacement lines into synchronized scrollable rows, including budget fallback", () => {
  const original = "x".repeat(140) + "\nlast old"
  const rewritten = "y".repeat(70) + "\nlast new"
  const rows = markdownDiffRows(original, rewritten, 1)
  const display = diffDisplayLines(rows, 80, true)
  expect(display.length).toBeGreaterThan(3)
  expect(display.filter(line => line.left.startsWith("- ")).map(line => line.left.slice(2).trimEnd()).join("")).toBe("x".repeat(140) + "last old")
  expect(display.filter(line => line.right?.startsWith("+ ")).map(line => line.right!.slice(2)).join("")).toBe("y".repeat(70) + "last new")
  expect(diffDisplayLines(rows, 50, false).some(line => line.left === "+ last new")).toBe(true)
})
