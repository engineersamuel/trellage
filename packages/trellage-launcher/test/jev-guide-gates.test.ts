import { describe, expect, it } from "vitest"
import type { GuideOptimizeInput } from "../src/guide-provider.ts"
import { jevIntentNeedsRepositoryContext, jevShouldSkipPromptOptimization } from "../src/jev-guide-gates.ts"
import type { JevSystemOneClient } from "../src/jev-decisions.ts"

const optimizeInput: GuideOptimizeInput = {
  originalIntent: "Add a typed parser and tests",
  targetTool: "copilot",
  profileRef: "native:copilot/default",
  candidates: [
    { title: "Focused", prompt: "Add a typed parser with boundary tests.", notes: "Focus on contract." },
    { title: "Thorough", prompt: "Add a typed parser and test invalid inputs.", notes: "Cover edge cases." },
    { title: "Cautious", prompt: "Implement the parser. Do not alter unrelated behavior.", notes: "Preserve scope." },
  ],
}

const clientFor = (answers: Record<string, { readonly type: "noul"; readonly noul: number }>): JevSystemOneClient => ({
  systemOne: async () => ({ answers }),
})

describe("Jev Guide decisions", () => {
  it("skips Prompt Master only when Jev judges every candidate needs no material change", async () => {
    const result = await jevShouldSkipPromptOptimization(optimizeInput, "Add a typed parser and tests", {
      cwd: "/tmp",
      client: clientFor({
        candidate0: { type: "noul", noul: 0.01 },
        candidate1: { type: "noul", noul: 0.02 },
        candidate2: { type: "noul", noul: 0.03 },
      }),
    })
    expect(result).toBe(true)
  })

  it("keeps Prompt Master when one candidate may need improvement", async () => {
    const result = await jevShouldSkipPromptOptimization(optimizeInput, "Add a typed parser and tests", {
      cwd: "/tmp",
      client: clientFor({
        candidate0: { type: "noul", noul: 0.01 },
        candidate1: { type: "noul", noul: 0.08 },
        candidate2: { type: "noul", noul: 0.02 },
      }),
    })
    expect(result).toBe(false)
  })

  it("skips repository packing only when the request does not need project facts", async () => {
    const decision = await jevIntentNeedsRepositoryContext("What is TypeSafe?", {
      cwd: "/tmp",
      client: clientFor({ decision: { type: "noul", noul: 0.01 } }),
    })
    expect(decision).toBe(false)
  })
})
