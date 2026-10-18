import { guideIntentMaximumLength } from "../../packages/trellage-launcher/src/guide-api.ts"

export const guideStdinCases: readonly {
  id: string
  source: string
  rejected: boolean
  intent?: string
}[] = [
  ...[
    ["omitted", "Fix the parser"],
    ["unicode", "Fix parsing\n日本語"],
    ["maximum", "x".repeat(guideIntentMaximumLength)],
  ].map(([id, intent]) => ({
    id: id!,
    source: JSON.stringify({ schemaVersion: 2, intent }),
    intent: intent!,
    rejected: false,
  })),
  ...[
    ["empty-stream", ""],
    ["malformed", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["missing-version", JSON.stringify({ intent: "Fix the parser" })],
    ["wrong-version", JSON.stringify({ schemaVersion: 1, intent: "Fix the parser" })],
    ["missing-intent", JSON.stringify({ schemaVersion: 2 })],
    ["unknown-field", JSON.stringify({ schemaVersion: 2, intent: "Fix the parser", extra: true })],
    ["empty-intent", JSON.stringify({ schemaVersion: 2, intent: "" })],
    ["whitespace-intent", JSON.stringify({ schemaVersion: 2, intent: " " })],
    ["control-intent", JSON.stringify({ schemaVersion: 2, intent: "x\u0001y" })],
    ["over-maximum", JSON.stringify({ schemaVersion: 2, intent: "x".repeat(guideIntentMaximumLength + 1) })],
  ].map(([id, source]) => ({ id: id!, source: source!, rejected: true })),
]

export function guideStdinCase(id = "omitted") {
  const input = guideStdinCases.find((entry) => entry.id === id)
  if (!input) throw Error(`Undeclared guide JSON stdin case: ${id}`)
  return input
}
