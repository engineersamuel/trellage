import { expect, test } from "vitest"
import { parseSelectionMetadata, selectionMetadataStatus } from "../src/run-selection.ts"

test("missing assessments remain unknown, not an authored empty assessment", () => {
  expect(parseSelectionMetadata({ description: "Focused review", best_for: ["Review a patch"] }, "selection")).toEqual({
    description: "Focused review",
    bestFor: ["Review a patch"],
    strengths: null,
    weaknesses: null,
    avoidFor: null,
    capabilities: null,
  })
  expect(parseSelectionMetadata({ weaknesses: [] }, "selection").weaknesses).toEqual([])
})
test("minimum metadata requires description and one best-for outcome", () => {
  expect(
    selectionMetadataStatus(
      parseSelectionMetadata({ description: "Review", best_for: ["Review a patch"] }, "selection"),
    ),
  ).toBe("complete")
  for (const value of [
    {},
    { description: "Review" },
    { best_for: ["Review a patch"] },
    { description: "Review", best_for: [] },
  ])
    expect(selectionMetadataStatus(parseSelectionMetadata(value, "selection"))).toBe("incomplete")
})
test.each([
  { description: " " },
  { description: "a\nb" },
  { strengths: ["same", "same"] },
  { best_for: [""] },
  { capabilities: ["Not an identifier"] },
  { description: "x".repeat(2001) },
  { unknown: true },
  { strengths: null },
])("rejects malformed supplied metadata: %j", (value) => {
  expect(() => parseSelectionMetadata(value, "selection")).toThrow()
})
