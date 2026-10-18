import assert from "node:assert/strict"
import { guideIntentMaximumLength, type GuideHeadlessArgs } from "../packages/trellage-launcher/src/guide-api.ts"
import { resolveInteractiveGuideIntent } from "../packages/trellage-launcher/src/guide-interactive-intent.ts"

export const interactiveStdinCases = [
  { name: "ordinary", value: "Fixture stdin intent", valid: true },
  { name: "multiline-unicode", value: "First line\n模型 😀", valid: true },
  { name: "maximum", value: "a".repeat(guideIntentMaximumLength), valid: true },
  { name: "unicode-maximum", value: "😀".repeat(guideIntentMaximumLength), valid: true },
  { name: "empty", value: "", valid: false },
  { name: "whitespace", value: " \t\n", valid: false },
  { name: "over-maximum", value: "a".repeat(guideIntentMaximumLength + 1), valid: false },
  { name: "control", value: "a\u0001b", valid: false },
  { name: "unpaired-surrogate", value: "a\ud800", valid: false },
] as const

export const assertGuideInteractiveIntent = async (args: GuideHeadlessArgs, id: string): Promise<void> => {
  for (const input of interactiveStdinCases) {
    let reads = 0
    const resolve = () =>
      resolveInteractiveGuideIntent({
        args,
        herdrContext: null,
        env: {},
        readStdin: async () => {
          reads++
          return input.value
        },
      })
    if (args.intentStdin && !input.valid)
      await assert.rejects(resolve(), { name: "GuideValidationError" }, `${id}: ${input.name}`)
    else
      assert.equal(await resolve(), args.intent ?? (args.intentStdin ? input.value : undefined), `${id}: ${input.name}`)
    assert.equal(reads, args.intentStdin ? 1 : 0, `${id}: stdin reads for ${input.name}`)
  }
}
