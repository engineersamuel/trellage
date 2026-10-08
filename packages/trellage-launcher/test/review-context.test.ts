import { describe, expect, it } from "vitest"
import { reviewContextBudget, reviewSnapshotBytes, reviewTokenUpperBound } from "../src/review-context.ts"
import { fixtureOptimizeModelInfo } from "./fixtures/guide-optimize-model.ts"

describe("review context budgets", () => {
  it("uses a UTF-8 token upper bound and leaves model-dependent evidence capacity", () => {
    expect(reviewTokenUpperBound("a😀")).toBe(5)
    expect(reviewSnapshotBytes).toBe(32_000_000)
    const budget = reviewContextBudget(fixtureOptimizeModelInfo, "a😀")
    expect(budget).toEqual({
      inputTokens: 5,
      outputTokens: 8192,
      evidenceBytes: 900_000 - 16_384 - 5,
    })
    expect(budget.evidenceBytes).toBeGreaterThan(768_000)
  })

  it("honors both prompt and output model limits", () => {
    const model = {
      ...fixtureOptimizeModelInfo,
      capabilities: {
        ...fixtureOptimizeModelInfo.capabilities,
        limits: {
          max_context_window_tokens: 100_000,
          max_prompt_tokens: 99_000,
          max_output_tokens: 4096,
        },
      },
    }
    expect(reviewContextBudget(model, "", 32_000)).toEqual({
      inputTokens: 0,
      outputTokens: 4096,
      evidenceBytes: 100_000 - 4096 - 16_384,
    })

  })

  it("reserves advertised output capacity even when the requested output is smaller", () => {
    const model = {
      ...fixtureOptimizeModelInfo,
      capabilities: {
        ...fixtureOptimizeModelInfo.capabilities,
        limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 128_000 },
      },
    }
    expect(reviewContextBudget(model, "", 8192).outputTokens).toBe(128_000)
    expect(reviewContextBudget(model, "", 8192).evidenceBytes).toBe(1_000_000 - 128_000 - 16_384)
  })

  it.each([0, -1, NaN, Infinity, 1.5, 20_000])("rejects invalid or inadequate context %s", (context) => {
    expect(() =>
      reviewContextBudget(
        {
          ...fixtureOptimizeModelInfo,
          capabilities: {
            ...fixtureOptimizeModelInfo.capabilities,
            limits: { max_context_window_tokens: context },
          },
        },
        "",
      ),
    ).toThrow(/context/)
  })
})
