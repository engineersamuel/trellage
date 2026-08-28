import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("default guide prompts", () => {
  it("offers Headlong and integrates workflow requirements without repetition", async () => {
    const [matchPrompt, generatePrompt, optimizePrompt] = await Promise.all([
      readFile(new URL("../prompts/match.md", import.meta.url), "utf8"),
      readFile(new URL("../prompts/generate.md", import.meta.url), "utf8"),
      readFile(new URL("../prompts/optimize.md", import.meta.url), "utf8"),
    ])

    expect(matchPrompt).toContain("Treat Headlong as a cross-cutting persistence option.")
    expect(matchPrompt).toContain("include Headlong among the five candidates")
    expect(matchPrompt).toContain("Do not force Headlong")
    expect(matchPrompt).toContain("Treat Poteto Mode as a cross-cutting structured-engineering option.")
    expect(matchPrompt).toContain("When both Headlong and Poteto Mode fit, include both")
    expect(matchPrompt).toContain("separately pins `sandbox:claude-council`,")
    expect(matchPrompt).toContain("`sandbox:claude-research`, and `native:cpx/hve`")
    expect(matchPrompt).toContain("do not\ninclude it in the ranked five")
    expect(generatePrompt).toContain("preserve those requirements naturally in every")
    expect(generatePrompt).toContain("do not repeat the same")
    expect(generatePrompt).toContain("pressure-test that idea and its implementation")
    expect(generatePrompt).toContain("subject of additional research")
    expect(optimizePrompt).toContain("Apply the loaded")
    expect(optimizePrompt).toContain("`prompt-master` skill")
    expect(optimizePrompt).toContain("same number of candidates")
  })
})
