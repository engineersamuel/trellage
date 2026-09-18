import { describe, expect, it } from "vitest"

const evaluator = await import(new URL("../../../scripts/evaluate-profile-guides.ts", import.meta.url).href)
const validate = evaluator.validateProfileGuideMatchEnvelope
const scenario = { id: "matching", intent: "Fix the retry bug" }
const response = {
  schemaVersion: 1,
  phase: "match",
  intent: scenario.intent,
  model: "configured-llm",
  effort: "medium",
  recommendations: [{}, {}, {}],
}

describe("live evaluator match envelope", () => {
  it("accepts legacy responses and actual Jev or Copilot execution metadata", () => {
    for (const metadata of [
      {},
      { execution: { backend: "jev", model: "jev-1.13.0" } },
      { execution: { backend: "copilot", model: "configured-llm", effort: "medium" } },
    ]) {
      expect(validate({ ...response, ...metadata }, scenario)).toEqual(response.recommendations)
    }
  })

  it("rejects invalid backend metadata and unexpected response fields", () => {
    for (const execution of [
      { backend: "other", model: "x" },
      { backend: "jev", model: "jev-1.13.0", effort: "medium" },
      { backend: "copilot", model: "x" },
      { backend: "copilot", model: "x", effort: "invalid" },
      { backend: "jev", model: "jev-1.13.0", secret: "no" },
    ])
      expect(() => validate({ ...response, execution }, scenario)).toThrow()
    expect(() => validate({ ...response, command: "no" }, scenario)).toThrow()
  })
})
