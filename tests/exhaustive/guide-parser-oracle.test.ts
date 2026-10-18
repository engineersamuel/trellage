import { expect, test } from "bun:test"
import { GuideArgsError, parseGuideHeadlessArgv } from "../../packages/trellage-launcher/src/guide-api.ts"
import { GuideValidationError } from "../../packages/trellage-launcher/src/guide-text.ts"
import { guideParserRejection } from "./guide-parser-oracle.ts"
import { cartesianCases } from "./matrix.ts"
import { exhaustiveDomains } from "./domains.ts"

test("guide mode truth table agrees with real parsing for all 1024 boolean combinations", async () => {
  const { matrices } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  const booleans = matrices.guide.filter((domain) => domain.values.length === 2 && domain.name !== "--preview")
  let count = 0
  let accepted = 0
  for (const entry of cartesianCases("guide-modes", booleans)) {
    const rejection = guideParserRejection(entry.values)
    try {
      const parsed = parseGuideHeadlessArgv(entry.argv)
      if (rejection) throw new Error(`${entry.id}: accepted despite ${rejection}; ${entry.argv.join(" ")}`)
      expect(parsed.help).toBe(entry.values["--help"] === "present")
      expect(parsed.json).toBe(entry.values["--json"] === "present")
      for (const [flag, field] of Object.entries({
        "--intent-stdin": "intentStdin",
        "--next-steps": "nextSteps",
        "--engagement": "engagement",
        "--review": "review",
        "--optimize": "optimize",
        "--ritual": "ritual",
        "--print": "ritualPrint",
        "--copy": "ritualCopy",
      })) {
        expect(Boolean(parsed[field as keyof typeof parsed])).toBe(entry.values[flag] === "present")
      }
      accepted++
    } catch (error) {
      if (!(error instanceof GuideArgsError) || !rejection) throw error
    }
    count++
  }
  expect(count).toBe(1024)
  expect(accepted).toBeGreaterThan(0)
})

test("oracle predicts each open-input class in a compatible mode", async () => {
  const { matrices } = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  for (const domain of matrices.guide.filter(
    (candidate) => candidate.values.length > 2 && candidate.name !== "--forks" && !candidate.name.startsWith("json-"),
  )) {
    for (const value of domain.values) {
      const selection: Record<string, string> = { [domain.name]: value.id }
      const argv = [...value.argv]
      if (domain.name === "--profile") {
        selection["--json"] = "present"
        argv.unshift("--json")
      }
      if (domain.name === "--base") {
        selection["--review"] = "present"
        argv.unshift("--review")
      }
      const rejection = guideParserRejection(selection)
      try {
        const parsed = parseGuideHeadlessArgv(argv)
        if (rejection) throw new Error(`${domain.name}/${value.id}: unexpectedly accepted (${rejection})`)
        const field = {
          "--intent": "intent",
          "--profile": "profile",
          "--model": "model",
          "--effort": "effort",
          "--ui-variant": "uiVariant",
          "--base": "reviewBase",
          positional: "intent",
        }[domain.name] as keyof typeof parsed
        expect(parsed[field]).toBe(value.argv.length ? value.argv.at(-1) : undefined)
      } catch (error) {
        if (!(error instanceof GuideArgsError || error instanceof GuideValidationError) || !rejection) throw error
      }
    }
  }
})
